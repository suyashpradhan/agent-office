// Blocking relations: "A is blocked by B" holds A's next stage and A's completion.

process.env.AGENT_OFFICE_MOCK_SPEED = '200';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { openWorkspace } = await import('../src/workspace.js');
const { openDb } = await import('../src/db.js');
const { loadAgents } = await import('../src/agents.js');
const { createBus } = await import('../src/events.js');
const { createOrchestrator } = await import('../src/orchestrator.js');
const mock = await import('../src/adapters/mock.js');

function setup(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-block-'));
  const ws = openWorkspace(dir);
  Object.assign(ws.config, { heartbeatMs: 20 }, config);
  const db = openDb(ws.dbPath);
  const orch = createOrchestrator({ ws, db, agents: loadAgents(ws.agentsDir), adapter: mock, bus: createBus() });
  return { db, orch };
}

async function waitFor(fn, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timed out');
}

const status = (db, id) => db.getTask(id).status;

test('cycles and self-links are rejected', () => {
  const { db, orch } = setup();
  const mk = (title) => db.createTask({ title, brief: '', stages: ['research'], review: true, status: 'review' });
  const a = mk('A');
  const b = mk('B');
  const c = mk('C');
  orch.addBlocker(a.id, b.id); // A waits for B
  orch.addBlocker(b.id, c.id); // B waits for C
  assert.throws(() => orch.addBlocker(c.id, a.id), /loop/); // C waits for A: A -> B -> C -> A
  assert.throws(() => orch.addBlocker(a.id, a.id), /itself/);
  assert.deepEqual(db.openBlockerIds(a.id), [b.id]);
});

test('the scheduler does not start a blocked task until its blocker is done', async () => {
  const { db, orch } = setup();
  const blocker = orch.createTask({ title: 'Blocker', stages: ['design'], review: true });
  const blocked = db.createTask({ title: 'Blocked', brief: '', stages: ['research'], review: true, status: 'review' });
  orch.addBlocker(blocked.id, blocker.id);
  db.updateTask(blocked.id, { status: 'queued' }); // queued, but blocked
  orch.start();

  await waitFor(() => status(db, blocker.id) === 'review');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(status(db, blocked.id), 'queued', 'Scout is idle, but the task is blocked');
  assert.equal(db.runsForTask(blocked.id).length, 0);

  orch.approve(blocker.id); // blocker done -> blocked task becomes eligible
  await waitFor(() => status(db, blocked.id) === 'review');
  orch.stop();
});

test('approving a parent with open sub-tasks parks it in "waiting"; it finishes when they do', async () => {
  const { db, orch } = setup();
  orch.start();
  const parent = orch.createTask({ title: 'Epic', stages: ['research'], review: true });
  await waitFor(() => status(db, parent.id) === 'review' && db.childrenOf(parent.id).length === 2);
  const [keep, drop] = db.childrenOf(parent.id);
  orch.dismissSubtask(drop.id); // dismissed proposals never block
  orch.acceptSubtask(keep.id);
  assert.deepEqual(db.openBlockerIds(parent.id), [keep.id]);

  orch.approve(parent.id);
  assert.equal(status(db, parent.id), 'waiting');

  // Drive the sub-task through its stages (design -> dev), approving each.
  for (let i = 0; i < keep.stages.length; i++) {
    await waitFor(() => status(db, keep.id) === 'review');
    orch.approve(keep.id);
  }
  assert.equal(status(db, keep.id), 'done');
  assert.equal(status(db, parent.id), 'done', 'parent finished on its own');
  assert.ok(db.activityForTask(parent.id).some((a) => /waiting for is done/.test(a.text)));
  orch.stop();
});

test('cancelled blockers release; failed ones keep blocking; removing a link releases', async () => {
  const { db, orch } = setup();
  const mk = (title, s = 'review') => db.createTask({ title, brief: '', stages: ['research'], review: true, status: s });
  const parent = mk('Parent');
  const failing = mk('Failing', 'failed');
  const cancelling = mk('To cancel');
  orch.addBlocker(parent.id, failing.id);
  orch.addBlocker(parent.id, cancelling.id);

  orch.approve(parent.id);
  assert.equal(status(db, parent.id), 'waiting');

  orch.cancel(cancelling.id);
  assert.equal(status(db, parent.id), 'waiting', 'a failed blocker still blocks');
  assert.deepEqual(db.openBlockerIds(parent.id), [failing.id]);
  assert.ok(db.activityForTask(parent.id).some((a) => /was cancelled, so it no longer blocks/.test(a.text)));

  orch.removeBlocker(parent.id, failing.id);
  assert.equal(status(db, parent.id), 'done');
});

test('chains resolve in order: C done -> B finishes -> A finishes', () => {
  const { db, orch } = setup();
  const mk = (title) => db.createTask({ title, brief: '', stages: ['research'], review: true, status: 'review' });
  const a = mk('A');
  const b = mk('B');
  const c = mk('C');
  orch.addBlocker(a.id, b.id);
  orch.addBlocker(b.id, c.id);
  orch.approve(a.id);
  orch.approve(b.id);
  assert.deepEqual([status(db, a.id), status(db, b.id)], ['waiting', 'waiting']);
  orch.approve(c.id);
  assert.deepEqual([status(db, a.id), status(db, b.id), status(db, c.id)], ['done', 'done', 'done']);
});

test('parentWaitsForSubtasks: false keeps parents independent', async () => {
  const { db, orch } = setup({ parentWaitsForSubtasks: false });
  orch.start();
  const parent = orch.createTask({ title: 'Independent', stages: ['research'], review: true });
  await waitFor(() => status(db, parent.id) === 'review' && db.childrenOf(parent.id).length === 2);
  orch.acceptAllSubtasks(parent.id);
  orch.approve(parent.id);
  assert.equal(status(db, parent.id), 'done');
  orch.stop();
});
