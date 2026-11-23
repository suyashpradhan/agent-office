// Mock adapter: same interface as the Claude adapter, but it only pretends to work.
// No CLI, no network, no cost. Use it (agent-office --mock) to watch the whole
// research -> design -> dev flow, approvals, and handoffs before spending tokens.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Tests set AGENT_OFFICE_MOCK_SPEED=50 to make the fake work 50x faster.
const SPEED = Number(process.env.AGENT_OFFICE_MOCK_SPEED || 1);

export const name = 'mock';

const SCRIPTS = {
  research: [
    ['tool', (t) => `Searching "${t} best practices"`],
    ['tool', () => 'Reading developer.mozilla.org'],
    ['tool', () => 'Looking for **/*.{js,ts,tsx}'],
    ['tool', () => 'Reading package.json'],
    ['say', () => 'Found three comparable products worth borrowing from'],
    ['tool', (t) => `Searching "${t} accessibility"`],
    ['say', () => 'Writing up the research brief'],
  ],
  design: [
    ['tool', () => 'Reading the research handoff'],
    ['tool', () => 'Looking for **/*.css'],
    ['tool', () => 'Reading styles.css'],
    ['say', () => 'Sketching the user flow'],
    ['say', () => 'Picking colors that match the existing UI'],
    ['say', () => 'Building the HTML mockup'],
  ],
  dev: [
    ['tool', () => 'Reading the design spec'],
    ['tool', () => 'Searching code for "export function"'],
    ['tool', () => 'Editing index.html'],
    ['tool', () => 'Writing feature.js'],
    ['tool', () => '$ npm test'],
    ['say', () => 'Tests pass. Committing to the branch'],
  ],
};

export function run({ agent, prompt, cwd, resumeSessionId, onActivity, onSession, signal }) {
  const title = (prompt.match(/^# Task: (.*)$/m)?.[1] ?? 'the task').slice(0, 40);
  const script = SCRIPTS[agent.stage] ?? SCRIPTS.research;
  const sessionId = resumeSessionId || randomUUID();
  onSession?.(sessionId);

  return new Promise((resolve) => {
    let i = 0;
    let timer;
    const step = () => {
      if (signal?.aborted) return resolve({ ok: false, sessionId, error: 'Stopped by you' });
      if (i < script.length) {
        const [kind, text] = script[i++];
        onActivity({ kind, text: text(title) });
        timer = setTimeout(step, (1800 + Math.random() * 2200) / SPEED);
        return;
      }
      // In a developer worktree, leave a small (uncommitted) change so the diff viewer
      // and the orchestrator's safety-net commit have something to show.
      if (agent.workspace === 'worktree' && cwd && cwd.includes(`${path.sep}.office${path.sep}worktrees${path.sep}`)) {
        fs.appendFileSync(path.join(cwd, 'AGENT_OFFICE_MOCK.md'), `- mock change for: ${title}\n`);
      }
      resolve({ ok: true, sessionId, costUsd: 0, output: fakeOutput(agent.stage, title, !!resumeSessionId) });
    };
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve({ ok: false, sessionId, error: 'Stopped by you' });
    });
    timer = setTimeout(step, 800 / SPEED);
  });
}

function fakeOutput(stage, title, revised) {
  const note = revised ? '\n\n> Revised after your feedback.\n' : '';
  if (stage === 'research') {
    return `## Summary
(Mock run) A short research brief for **${title}**.${note}

## Users and problem
- People who want this done quickly, on mobile and desktop.

## What already exists (with links)
- Example A - https://example.com/a
- Example B - https://example.com/b

## Constraints from this codebase
- Plain HTML/CSS/JS; no framework detected.

## Recommendations
1. Start with the smallest useful version.
2. Reuse existing styles.

## Open questions
- Do we need accounts?`;
  }
  if (stage === 'design') {
    return `## Goal
(Mock run) Design for **${title}**.${note}

## User flow
1. User opens the page
2. User completes the main action
3. User sees confirmation

## Mockup
\`\`\`html
<!doctype html><html><body style="font-family:system-ui;margin:0;background:#f6f4ef">
<div style="max-width:360px;margin:40px auto;background:#fff;border-radius:14px;padding:24px;box-shadow:0 6px 24px #0001">
<h2 style="margin:0 0 8px">${title.replace(/</g, '')}</h2>
<p style="color:#666;margin:0 0 16px">A mock screen from Pixel.</p>
<button style="background:#e0569b;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:15px">Do the thing</button>
</div></body></html>
\`\`\``;
  }
  return `## What changed
(Mock run) Added a line to AGENT_OFFICE_MOCK.md on this task's branch - this is the mock adapter.${note}

## Files touched
- AGENT_OFFICE_MOCK.md

## How to try it
Run without --mock to let the real developer agent work on a branch.

## Follow-ups
- None`;
}
