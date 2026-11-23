// Delegation: agents propose sub-tasks, you approve, context flows down, guardrails hold.

process.env.AGENT_OFFICE_MOCK_SPEED = '200';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { extractSubtasks, delegationInstructions } = await import('../src/delegation.js');
const { openWorkspace } = await import('../src/workspace.js');
const { openDb } = await import('../src/db.js');
const { loadAgents } = await import('../src/agents.js');
const { createBus } = await import('../src/events.js');
const { createOrchestrator } = await import('../src/orchestrator.js');
const mock = await import('../src/adapters/mock.js');

const TEAM = [
  { stage: 'research', id: 'researcher', name: 'Scout', title: 'Researcher' },
  { stage: 'design', id: 'designer', name: 'Pixel', title: 'Designer' },
  { stage: 'dev', id: 'developer', name: 'Byte', title: 'Developer' },
];

// Wraps the mock adapter and remembers every prompt, so tests can inspect handoffs.
function spyAdapter() {
  const prompts = [];
  return { prompts, adapter: { name: 'spy', run: (args) => (prompts.push({ stage: args.agent.stage, prompt: args.prompt }), mock.run(args)) } };
}

function setup(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-deleg-'));
  const ws = openWorkspace(dir);
  Object.assign(ws.config, { heartbeatMs: 20 }, config);
  const db = openDb(ws.dbPath);
  const spy = spyAdapter();
  const events = [];
  const bus = createBus();
  bus.subscribe((e) => events.push(e));
  const orch = createOrchestrator({ ws, db, agents: loadAgents(ws.agentsDir), adapter: spy.adapter, bus });
  return { ws, db, orch, prompts: spy.prompts, events };
}

async function waitFor(fn, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timed out');
}

test('extractSubtasks: parses, maps names to stages, caps, strips the block', () => {
  const md = 'Report\n\n```subtasks\n[{"title":"A","team":["Byte","design"]},{"title":"B"},{"brief":"no title"},{"title":"C"},{"title":"D"}]\n```\n';
  const { cleaned, subtasks, error } = extractSubtasks(md, { agents: TEAM, max: 3 });
  assert.equal(error, null);
  assert.equal(cleaned, 'Report');
  assert.deepEqual(subtasks.map((s) => s.title), ['A', 'B', 'C']);
  assert.deepEqual(subtasks[0].stages, ['design', 'dev'], 'team order is enforced');
  assert.deepEqual(subtasks[1].stages, ['research', 'design', 'dev'], 'no team = whole pipeline');

  const bad = extractSubtasks('x\n```subtasks\n[not json]\n```', { agents: TEAM });
  assert.match(bad.error, /invalid JSON/);
  assert.match(bad.cleaned, /not json/, 'keeps the block so you can see what went wrong');

  assert.deepEqual(extractSubtasks('no proposals here', { agents: TEAM }).subtasks, []);
  assert.match(delegationInstructions(TEAM, 3), /up to 3 sub-tasks/);
});

test('agents propose; nothing runs until you accept; context flows down', async () => {
  const { db, orch, prompts, events } = setup();
  orch.start();
  const parent = orch.createTask({ title: 'Plan a habit tracker', brief: 'Mobile-first', stages: ['research'], review: true });

  await waitFor(() => db.childrenOf(parent.id).length === 2);
  assert.match(prompts[0].prompt, /Proposing sub-tasks/, 'top-level tasks are invited to delegate');
  const kids = db.childrenOf(parent.id);
  assert.ok(kids.every((k) => k.status === 'proposed' && k.depth === 1 && k.proposed_by === 'researcher'));
  assert.deepEqual(kids[0].stages, ['design', 'dev']);
  assert.doesNotMatch(orch.taskDetail(parent.id).outputs.research.markdown, /```subtasks/, 'block stripped from the deliverable');
  await waitFor(() => events.some((e) => e.type === 'run' && e.phase === 'finished' && e.proposed === 2));

  // Proposed tasks are never picked up on their own.
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(db.getTask(kids[0].id).status, 'proposed');

  orch.dismissSubtask(kids[1].id);
  orch.acceptSubtask(kids[0].id);
  await waitFor(() => db.getTask(kids[0].id).status === 'review');
  const childPrompt = prompts.find((p) => p.prompt.includes(`# Task: ${kids[0].title}`)).prompt;
  assert.match(childPrompt, /this is a sub-task/);
  assert.match(childPrompt, /Plan a habit tracker/);
  assert.match(childPrompt, /Scout's deliverable on the parent task/);
  assert.doesNotMatch(childPrompt, /Proposing sub-tasks/, 'depth limit: sub-tasks cannot delegate further');
  assert.equal(db.getTask(kids[1].id).status, 'dismissed');
  orch.stop();
});

test('a rerun replaces earlier proposals instead of duplicating them', async () => {
  const { db, orch } = setup();
  orch.start();
  const parent = orch.createTask({ title: 'Research onboarding', stages: ['research'], review: true });
  await waitFor(() => db.getTask(parent.id).status === 'review' && db.childrenOf(parent.id).length === 2);
  orch.requestChanges(parent.id, 'Go deeper');
  await waitFor(() => db.childrenOf(parent.id).length === 4 && db.getTask(parent.id).status === 'review');
  const statuses = db.childrenOf(parent.id).map((k) => k.status);
  assert.deepEqual(statuses, ['dismissed', 'dismissed', 'proposed', 'proposed']);
  orch.stop();
});

test('cancelling the parent withdraws its pending proposals; accept-all works', async () => {
  const { db, orch } = setup();
  orch.start();
  const a = orch.createTask({ title: 'Parent A', stages: ['research'], review: true });
  await waitFor(() => db.childrenOf(a.id).length === 2);
  orch.cancel(a.id);
  assert.ok(db.childrenOf(a.id).every((k) => k.status === 'dismissed'));

  const b = orch.createTask({ title: 'Parent B', stages: ['research'], review: true });
  await waitFor(() => db.childrenOf(b.id).length === 2);
  assert.equal(orch.acceptAllSubtasks(b.id).accepted, 2);
  assert.ok(db.childrenOf(b.id).every((k) => k.status !== 'proposed'));
  assert.throws(() => orch.dismissSubtask(b.id), (e) => e.status === 409);
  orch.stop();
});

test('autoApproveSubtasks queues proposals straight away; delegate:false opts an agent out', async () => {
  const auto = setup({ autoApproveSubtasks: true });
  auto.orch.start();
  const p = auto.orch.createTask({ title: 'Auto', stages: ['research'], review: true });
  await waitFor(() => auto.db.childrenOf(p.id).length === 2);
  assert.ok(auto.db.childrenOf(p.id).every((k) => k.status !== 'proposed'));
  auto.orch.stop();

  const off = setup();
  const file = path.join(off.ws.agentsDir, 'researcher.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('workspace: repo', 'workspace: repo\ndelegate: false'));
  const orch = createOrchestrator({ ws: off.ws, db: off.db, agents: loadAgents(off.ws.agentsDir), adapter: mock, bus: createBus() });
  orch.start();
  const t = orch.createTask({ title: 'No delegation', stages: ['research'], review: true });
  await waitFor(() => off.db.getTask(t.id).status === 'review');
  assert.equal(off.db.childrenOf(t.id).length, 0);
  orch.stop();
});
