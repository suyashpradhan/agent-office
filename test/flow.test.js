// End-to-end flow with the mock adapter: research -> design -> dev, approvals,
// request-changes (session resume), worktree branch, atomic checkout, crash recovery.
// Run: npm test

process.env.AGENT_OFFICE_MOCK_SPEED = '200';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const { openWorkspace } = await import('../src/workspace.js');
const { openDb } = await import('../src/db.js');
const { loadAgents } = await import('../src/agents.js');
const { createBus } = await import('../src/events.js');
const { createOrchestrator } = await import('../src/orchestrator.js');
const mock = await import('../src/adapters/mock.js');

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

function setup(repo = tempRepo()) {
  const ws = openWorkspace(repo);
  ws.config.heartbeatMs = 30;
  const db = openDb(ws.dbPath);
  const agents = loadAgents(ws.agentsDir);
  const bus = createBus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const orch = createOrchestrator({ ws, db, agents, adapter: mock, bus });
  return { repo, ws, db, orch, events };
}

async function waitFor(fn, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
}

test('full pipeline with reviews, rework, and a dev worktree', async () => {
  const { repo, db, orch, events } = setup();
  orch.start();
  const task = orch.createTask({ title: 'Add dark mode', brief: 'toggle', review: true });
  assert.deepEqual(task.stages, ['research', 'design', 'dev']);

  await waitFor(() => db.getTask(task.id).status === 'review');
  assert.ok(fs.existsSync(path.join(repo, '.office/tasks', String(task.id), 'research.md')));

  // Ask for changes: same stage runs again and resumes the same session.
  const firstSession = db.lastSession(task.id, 'research');
  orch.requestChanges(task.id, 'Add more links');
  await waitFor(() => db.runsForTask(task.id).length === 2 && db.getTask(task.id).status === 'review');
  assert.equal(db.runsForTask(task.id)[1].session_id, firstSession);
  assert.match(orch.taskDetail(task.id).outputs.research.markdown, /Revised after your feedback/);

  orch.approve(task.id);
  await waitFor(() => db.getTask(task.id).status === 'review' && db.getTask(task.id).stage_index === 1);
  assert.ok(orch.taskDetail(task.id).outputs.design.mockup, 'designer mockup extracted');

  orch.approve(task.id);
  await waitFor(() => db.getTask(task.id).status === 'review' && db.getTask(task.id).stage_index === 2);
  assert.equal(db.getTask(task.id).branch, `office/task-${task.id}`);
  assert.ok(fs.existsSync(path.join(repo, '.office/worktrees', `task-${task.id}`)));

  // Safety net: the mock developer leaves its edit uncommitted; the orchestrator commits it.
  const detail = orch.taskDetail(task.id);
  assert.match(detail.diff.patch, /AGENT_OFFICE_MOCK\.md/);
  assert.match(detail.diff.stat, /1 file changed/);
  assert.ok(detail.activity.some((a) => /saved them as a commit/.test(a.text)));

  orch.approve(task.id);
  assert.equal(db.getTask(task.id).status, 'done');
  assert.ok(events.some((e) => e.type === 'handoff'));
  // Done: the temporary checkout is gone, the branch (and the diff) stay.
  assert.ok(!fs.existsSync(path.join(repo, '.office/worktrees', `task-${task.id}`)));
  assert.match(orch.taskDetail(task.id).diff.patch, /mock change for: Add dark mode/);

  // .office/ never shows up in the user's git status
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString().trim(), '');
  orch.stop();
});

test('review off: stages hand off automatically', async () => {
  const { db, orch } = setup();
  orch.start();
  const task = orch.createTask({ title: 'Quick', stages: ['research', 'design'], review: false });
  await waitFor(() => db.getTask(task.id).status === 'review'); // last stage always waits for you
  assert.equal(db.getTask(task.id).stage_index, 1);
  orch.stop();
});

test('atomic checkout: only one worker wins', () => {
  const { db } = setup();
  const t = db.createTask({ title: 'x', brief: '', stages: ['research'], review: true });
  assert.equal(db.checkout(t.id, 'a'), true);
  assert.equal(db.checkout(t.id, 'b'), false);
});

test('crash recovery puts running tasks back in the queue', () => {
  const { repo, db } = setup();
  const t = db.createTask({ title: 'x', brief: '', stages: ['research'], review: true });
  db.checkout(t.id, 'researcher');
  db.createRun({ taskId: t.id, agentId: 'researcher', stage: 'research' });
  const again = setup(repo); // "restart" on the same project
  assert.equal(again.db.getTask(t.id).status, 'queued');
  assert.equal(again.db.runsForTask(t.id)[0].status, 'interrupted');
});

test('budget pauses the office', async () => {
  const { ws, db, orch, events } = setup();
  ws.config.budgetUsd = 0;
  orch.start();
  db.createTask({ title: 'x', brief: '', stages: ['research'], review: true });
  await waitFor(() => events.some((e) => e.type === 'office' && e.office.paused));
  assert.equal(db.runsForTask(1).length, 0);
  orch.stop();
});

test('a run that takes too long times out', async () => {
  const { ws, db, orch } = setup();
  ws.config.runTimeoutMinutes = 0.0002; // ~12ms; the mock takes longer
  orch.start();
  const t = orch.createTask({ title: 'Slow', stages: ['research'], review: true });
  await waitFor(() => db.getTask(t.id).status === 'failed');
  assert.match(db.getTask(t.id).error, /Timed out/);
  orch.stop();
});

test('cancelling a dev task removes its worktree but keeps the branch', async () => {
  const { repo, db, orch } = setup();
  orch.start();
  const t = orch.createTask({ title: 'Cancel me', stages: ['dev'], review: true });
  await waitFor(() => db.getTask(t.id).status === 'running' && fs.existsSync(path.join(repo, '.office/worktrees', `task-${t.id}`)));
  orch.cancel(t.id);
  await waitFor(() => !fs.existsSync(path.join(repo, '.office/worktrees', `task-${t.id}`)));
  assert.equal(db.getTask(t.id).status, 'cancelled');
  execFileSync('git', ['rev-parse', '--verify', `office/task-${t.id}`], { cwd: repo, stdio: 'ignore' });
  // Retry recreates the worktree from the kept branch.
  orch.retry(t.id);
  await waitFor(() => db.getTask(t.id).status === 'review');
  orch.stop();
});
