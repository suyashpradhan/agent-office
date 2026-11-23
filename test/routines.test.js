// Routines (scheduled tasks), driven by a fake clock so nothing waits for real time.

process.env.AGENT_OFFICE_MOCK_SPEED = '200';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { parseSchedule, nextRun, describeSchedule, renderTitle } = await import('../src/schedule.js');
const { openWorkspace } = await import('../src/workspace.js');
const { openDb } = await import('../src/db.js');
const { loadAgents } = await import('../src/agents.js');
const { createBus } = await import('../src/events.js');
const { createOrchestrator } = await import('../src/orchestrator.js');
const mock = await import('../src/adapters/mock.js');

const at = (d, h, m = 0) => new Date(2026, 10, d, h, m); // November 2026, local time (Nov 23 is a Monday)

function setup(start = at(23, 8)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-routines-'));
  const ws = openWorkspace(dir); // not a git repo - fine for research-only routines
  const db = openDb(ws.dbPath);
  const clock = { now: start };
  const orch = createOrchestrator({ ws, db, agents: loadAgents(ws.agentsDir), adapter: mock, bus: createBus(), now: () => clock.now });
  return { ws, db, orch, clock };
}

test('cron parsing, next run, descriptions', () => {
  const weekdays = parseSchedule('0 9 * * 1-5');
  assert.deepEqual(nextRun(weekdays, at(27, 10)), at(30, 9)); // Fri 10:00 -> Mon 09:00
  assert.deepEqual(nextRun(parseSchedule('*/15 * * * *'), at(23, 10, 7)), at(23, 10, 15));
  assert.deepEqual(nextRun(parseSchedule('0 9 * * mon'), at(23, 9)), at(30, 9)); // strictly after
  assert.equal(describeSchedule('0 9 * * 1-5'), 'Weekdays at 09:00');
  assert.equal(describeSchedule('30 8 * * *'), 'Every day at 08:30');
  assert.equal(describeSchedule('0 9 * * mon'), 'Every Monday at 09:00');
  assert.equal(describeSchedule('*/15 * * * *'), 'Every 15 minutes');
  assert.equal(describeSchedule('* * * * *'), 'Every minute');
  assert.throws(() => parseSchedule('0 9 * *'), /5 fields/);
  assert.throws(() => parseSchedule('0 25 * * *'), /hour must be between/);
  assert.throws(() => parseSchedule('0 0 31 2 *'), /never fires/);
  assert.equal(renderTitle('News {weekday} {date}', at(23, 9)), 'News Monday 2026-11-23');
});

test('a routine creates a task when it is due, then schedules the next one', () => {
  const { db, orch, clock } = setup();
  const r = orch.createRoutine({ name: 'Competitor watch', schedule: '0 9 * * *', stages: ['research'], brief: 'What shipped?' });
  assert.equal(new Date(r.next_run_at).getTime(), at(23, 9).getTime());
  assert.equal(r.description, 'Every day at 09:00');

  clock.now = at(23, 8, 59);
  orch.tick();
  assert.equal(db.listTasks().length, 0, 'not due yet');

  clock.now = at(23, 9);
  orch.tick();
  const [task] = db.listTasks();
  assert.equal(task.title, 'Competitor watch · 2026-11-23');
  assert.equal(task.routine_id, r.id);
  assert.equal(task.brief, 'What shipped?');
  const after = db.getRoutine(r.id);
  assert.equal(after.last_task_id, task.id);
  assert.equal(new Date(after.next_run_at).getTime(), at(24, 9).getTime());
  orch.stop();
});

test('overlap: skip a firing while the previous task is still open', () => {
  const { db, orch, clock } = setup();
  const r = orch.createRoutine({ name: 'Daily', schedule: '0 9 * * *', stages: ['research'] });
  clock.now = at(23, 9);
  orch.tick();
  assert.equal(db.listTasks().length, 1);

  clock.now = at(24, 9); // yesterday's task was never reviewed
  orch.tick();
  assert.equal(db.listTasks().length, 1, 'no duplicate task');
  assert.match(db.getRoutine(r.id).last_result, /Skipped/);
  assert.equal(new Date(db.getRoutine(r.id).next_run_at).getTime(), at(25, 9).getTime());
  orch.stop();
});

test('catch-up: after downtime, fire once and move on', () => {
  const { db, orch, clock } = setup();
  const r = orch.createRoutine({ name: 'Hourly', schedule: '0 * * * *', stages: ['research'] });
  clock.now = at(25, 14, 30); // the office was off for ~2.5 days (54 missed slots)
  orch.tick();
  assert.equal(db.listTasks().length, 1);
  assert.equal(new Date(db.getRoutine(r.id).next_run_at).getTime(), at(25, 15).getTime());
  orch.stop();
});

test('pause, resume, run now, and bad schedules', () => {
  const { db, orch, clock } = setup();
  const r = orch.createRoutine({ name: 'Weekly', schedule: '0 9 * * 1', stages: ['research'] });
  orch.updateRoutine(r.id, { enabled: false });
  clock.now = at(30, 9);
  orch.tick();
  assert.equal(db.listTasks().length, 0, 'paused routines never fire');

  clock.now = at(30, 12);
  const resumed = orch.updateRoutine(r.id, { enabled: true });
  assert.equal(new Date(resumed.next_run_at).getTime(), new Date(2026, 11, 7, 9).getTime(), 'resuming skips missed slots');

  orch.runRoutineNow(r.id);
  orch.runRoutineNow(r.id); // manual runs ignore the overlap rule
  assert.equal(db.listTasks().length, 2);
  assert.equal(db.getRoutine(r.id).next_run_at, resumed.next_run_at, 'run now keeps the schedule');

  assert.throws(() => orch.createRoutine({ name: 'Bad', schedule: '99 * * * *' }), (e) => e.status === 400);
  assert.throws(() => orch.createRoutine({ name: '', schedule: '0 9 * * *' }), (e) => e.status === 400);
  const changed = orch.updateRoutine(r.id, { schedule: '0 18 * * *' });
  assert.equal(changed.description, 'Every day at 18:00');

  orch.removeRoutine(r.id);
  assert.equal(orch.listRoutines().length, 0);
  orch.stop();
});

test('migration adds routine_id to a database created by an older version', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'office-mig-')), 'office.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '',
    stages TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, assignee TEXT,
    review INTEGER NOT NULL DEFAULT 1, feedback TEXT, branch TEXT, error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO tasks (title, stages, status) VALUES ('old task', '["research"]', 'done');`);
  old.close();
  const db = openDb(file);
  assert.equal(db.getTask(1).title, 'old task');
  assert.equal(db.getTask(1).routine_id, null);
  db.createTask({ title: 'new', brief: '', stages: ['research'], review: true, routineId: 7 });
  assert.equal(db.getTask(2).routine_id, 7);
});
