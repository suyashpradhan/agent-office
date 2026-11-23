// Claude Code adapter: runs one agent turn by spawning the Claude Code CLI in headless mode.
//
// This is exactly what Paperclip's claude-local adapter does
// (packages/adapters/claude-local/src/server/execute.ts):
//
//   claude --print --output-format stream-json --verbose --resume <session> ...
//
// The orchestrator never talks to a model directly. It hands an agent a prompt, a working
// directory and a tool allowlist, then reads a stream of JSON events back. Every adapter
// (Claude, Codex, a mock...) has the same shape:
//
//   run({ agent, prompt, cwd, resumeSessionId, onActivity, onSession, signal })
//     -> Promise<{ ok, output, sessionId, costUsd, error }>

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';

export const name = 'claude';

export function run({ agent, prompt, cwd, resumeSessionId, onActivity, onSession, signal }) {
  const args = [
    '--print', // headless: run until done, then exit
    '--output-format', 'stream-json', // one JSON event per line while it works
    '--verbose', // required for stream-json in print mode
    '--append-system-prompt', agent.prompt, // the role (researcher/designer/developer)
    '--tools', agent.tools.join(','), // the only built-in tools this role even has...
    '--allowedTools', agent.tools.join(','), // ...pre-approved so it never stops to ask...
    '--permission-mode', 'dontAsk', // ...and anything else is denied instead of prompting
    '--max-budget-usd', String(agent.maxBudgetUsd), // per-run spending cap
  ];
  // MCP servers from your Claude config add every one of their tools to each call's context
  // (slower and pricier). Agents get none unless their file says `mcp: inherit`.
  if (agent.mcp !== 'inherit') args.push('--strict-mcp-config');
  if (agent.model) args.push('--model', agent.model);
  if (resumeSessionId) args.push('--resume', resumeSessionId); // continue the same conversation

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    } catch (err) {
      resolve({ ok: false, error: `Could not start claude: ${err.message}` });
      return;
    }

    let sessionId = resumeSessionId || null;
    let final = null;
    let stderr = '';

    signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    child.on('error', (err) =>
      resolve({ ok: false, error: err.code === 'ENOENT' ? 'claude CLI not found on PATH' : err.message }),
    );
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));

    // The prompt goes over stdin so long handoff documents don't hit argv size limits.
    child.stdin.end(prompt);

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.session_id && event.session_id !== sessionId) {
        sessionId = event.session_id;
        onSession?.(sessionId); // save it right away, so a crash mid-run can still resume
      }
      if (event.type === 'assistant') {
        for (const block of event.message?.content ?? []) {
          if (block.type === 'tool_use') onActivity({ kind: 'tool', text: describeTool(block.name, block.input) });
          if (block.type === 'text' && block.text.trim()) {
            onActivity({ kind: 'say', text: firstLine(block.text) });
          }
        }
      }
      if (event.type === 'result') final = event;
    });

    child.on('close', (code) => {
      if (signal?.aborted) return resolve({ ok: false, sessionId, error: 'Stopped by you' });
      if (final && !final.is_error && final.subtype === 'success') {
        return resolve({ ok: true, output: final.result ?? '', sessionId, costUsd: final.total_cost_usd ?? 0 });
      }
      const reason =
        final?.subtype === 'error_max_budget_usd'
          ? `Hit this agent's per-run budget ($${agent.maxBudgetUsd})`
          : final?.result || final?.subtype || stderr.trim().split('\n').slice(-3).join(' ') || `claude exited with code ${code}`;
      resolve({ ok: false, sessionId, costUsd: final?.total_cost_usd ?? 0, error: reason });
    });
  });
}

// Turn raw tool calls into the short, human sentences shown in the speech bubbles.
export function describeTool(tool, input = {}) {
  const file = (p) => (p ? path.basename(String(p)) : 'a file');
  switch (tool) {
    case 'WebSearch':
      return `Searching "${input.query ?? ''}"`;
    case 'WebFetch':
      try {
        return `Reading ${new URL(input.url).hostname}`;
      } catch {
        return 'Reading a web page';
      }
    case 'Read':
      return `Reading ${file(input.file_path)}`;
    case 'Glob':
      return `Looking for ${input.pattern ?? 'files'}`;
    case 'Grep':
      return `Searching code for "${input.pattern ?? ''}"`;
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${file(input.file_path)}`;
    case 'Write':
      return `Writing ${file(input.file_path)}`;
    case 'Bash':
      return `$ ${String(input.command ?? '').split('\n')[0].slice(0, 80)}`;
    case 'TodoWrite':
      return 'Planning next steps';
    default:
      return `Using ${tool}`;
  }
}

function firstLine(text) {
  const line = text.trim().split('\n').find((l) => l.trim()) ?? '';
  return line.replace(/^#+\s*/, '').slice(0, 160);
}
