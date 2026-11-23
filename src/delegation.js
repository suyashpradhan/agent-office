// Delegation: agents can propose sub-tasks for the team; you decide which ones start.
//
// The protocol is plain text, so it works with any agent runtime. An agent ends its
// deliverable with a fenced block:
//
//   ```subtasks
//   [{ "title": "Build the settings screen", "brief": "...", "team": ["design", "dev"] }]
//   ```
//
// The orchestrator strips the block from the deliverable and turns each entry into a task
// with status "proposed". Nothing runs until you accept it. That approval gate is
// Paperclip's governance idea at small scale: agents can delegate, but a human decides
// what actually gets resourced.

const FENCE = /```subtasks[ \t]*\n([\s\S]*?)```[ \t]*\n?/;

// Appended to an agent's task prompt when it is allowed to delegate.
export function delegationInstructions(agents, max) {
  const team = agents.map((a) => `"${a.stage}" (${a.name}, ${a.title})`).join(', ');
  return [
    '## Proposing sub-tasks (optional)',
    '',
    `If this work clearly splits into separate pieces, or you found important follow-ups that are out of scope for this task, you may propose up to ${max} sub-tasks for the team.`,
    'The manager decides whether to start them, so only propose work that is clearly worth doing. Most deliverables should propose none.',
    'To propose, end your final message with exactly one fenced block like this (valid JSON):',
    '',
    '```subtasks',
    '[{ "title": "Short imperative title", "brief": "What to do, why, and what done looks like", "team": ["design", "dev"] }]',
    '```',
    '',
    `"team" lists who works on it, in order. Choose from: ${team}.`,
  ].join('\n');
}

// Returns { cleaned, subtasks, error }. On malformed JSON the block stays in the deliverable
// (so you can see what the agent wrote) and `error` explains why nothing was proposed.
export function extractSubtasks(markdown, { agents, max = 3 }) {
  const text = String(markdown ?? '');
  const match = text.match(FENCE);
  if (!match) return { cleaned: text, subtasks: [], error: null };

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    return { cleaned: text, subtasks: [], error: `Could not read the proposed sub-tasks (invalid JSON: ${err.message})` };
  }
  if (!Array.isArray(parsed)) parsed = [parsed];

  const order = agents.map((a) => a.stage);
  const stageFor = (value) => {
    const v = String(value ?? '').trim().toLowerCase();
    const agent = agents.find((a) => [a.stage, a.id, a.name, a.title].some((x) => String(x).toLowerCase() === v));
    return agent?.stage ?? null;
  };

  const subtasks = parsed
    .filter((item) => item && typeof item === 'object' && String(item.title ?? '').trim())
    .slice(0, max)
    .map((item) => {
      const team = [...new Set((Array.isArray(item.team) ? item.team : []).map(stageFor).filter(Boolean))];
      team.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      return {
        title: String(item.title).trim().slice(0, 140),
        brief: String(item.brief ?? '').trim().slice(0, 4000),
        stages: team.length ? team : order,
      };
    });

  return { cleaned: text.replace(FENCE, '').trimEnd(), subtasks, error: null };
}
