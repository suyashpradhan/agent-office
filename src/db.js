// Persistence. Three tables are the whole "company memory":
//
//   tasks     - the unit of work. Moves through stages (research -> design -> dev).
//               Paperclip calls these "issues".
//   runs      - one execution of one agent on one task stage. Stores the Claude
//               session id so a later run can --resume the same conversation.
//               Paperclip: heartbeat_runs + agent_task_sessions.
//   activity  - an append-only log of what happened (tool calls, approvals, errors).
//               Paperclip: activity_log + heartbeat_run_events.
//
// Uses Node's built-in SQLite, so there's nothing to install.

import { DatabaseSync } from 'node:sqlite';

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      brief       TEXT NOT NULL DEFAULT '',
      stages      TEXT NOT NULL,              -- JSON array, e.g. ["research","design","dev"]
      stage_index INTEGER NOT NULL DEFAULT 0, -- which stage we're on
      status      TEXT NOT NULL,              -- proposed | queued | running | review | done | failed | cancelled | dismissed
      assignee    TEXT,                       -- agent id currently holding the task
      review      INTEGER NOT NULL DEFAULT 1, -- pause for approval between stages?
      feedback    TEXT,                       -- your "request changes" note, consumed by the next run
      branch      TEXT,                       -- git branch the developer worked on
      error       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL REFERENCES tasks(id),
      agent_id    TEXT NOT NULL,
      stage       TEXT NOT NULL,
      status      TEXT NOT NULL,              -- running | succeeded | failed | stopped | interrupted
      session_id  TEXT,
      cost_usd    REAL NOT NULL DEFAULT 0,
      output_file TEXT,
      error       TEXT,
      started_at  TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at    TEXT
    );
    CREATE TABLE IF NOT EXISTS routines (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      title        TEXT NOT NULL,              -- task title template: {date} {time} {weekday}
      brief        TEXT NOT NULL DEFAULT '',
      stages       TEXT NOT NULL,              -- JSON array, like tasks.stages
      review       INTEGER NOT NULL DEFAULT 1,
      schedule     TEXT NOT NULL,              -- cron, local time
      enabled      INTEGER NOT NULL DEFAULT 1,
      next_run_at  TEXT,                       -- ISO timestamp
      last_run_at  TEXT,
      last_task_id INTEGER,
      last_result  TEXT,                       -- "Created task #4" / "Skipped: ..."
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS activity (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id  INTEGER,
      run_id   INTEGER,
      agent_id TEXT,
      kind     TEXT NOT NULL,                 -- tool | say | system | error
      text     TEXT NOT NULL,
      at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrations: columns added after a project's database was first created.
  // Each one is safe to run every time (it checks before altering).
  const hasColumn = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!hasColumn('tasks', 'routine_id')) db.exec(`ALTER TABLE tasks ADD COLUMN routine_id INTEGER`);
  // Delegation: a sub-task points at its parent; depth limits how deep delegation can go.
  if (!hasColumn('tasks', 'parent_id')) db.exec(`ALTER TABLE tasks ADD COLUMN parent_id INTEGER`);
  if (!hasColumn('tasks', 'depth')) db.exec(`ALTER TABLE tasks ADD COLUMN depth INTEGER NOT NULL DEFAULT 0`);
  if (!hasColumn('tasks', 'proposed_by')) db.exec(`ALTER TABLE tasks ADD COLUMN proposed_by TEXT`);

  const q = (sql) => db.prepare(sql);
  const parseRoutine = (row) => row && { ...row, stages: JSON.parse(row.stages), review: !!row.review, enabled: !!row.enabled };
  const parseTask = (row) => row && { ...row, stages: JSON.parse(row.stages), review: !!row.review };

  return {
    raw: db,

    // ---- tasks ----
    createTask({ title, brief, stages, review, routineId = null, parentId = null, depth = 0, proposedBy = null, status = 'queued' }) {
      const { lastInsertRowid } = q(
        `INSERT INTO tasks (title, brief, stages, status, review, routine_id, parent_id, depth, proposed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(title, brief, JSON.stringify(stages), status, review ? 1 : 0, routineId, parentId, depth, proposedBy);
      return this.getTask(Number(lastInsertRowid));
    },
    getTask(id) {
      return parseTask(q(`SELECT * FROM tasks WHERE id = ?`).get(id));
    },
    listTasks() {
      return q(`SELECT * FROM tasks ORDER BY id DESC LIMIT 200`).all().map(parseTask);
    },
    updateTask(id, fields) {
      const keys = Object.keys(fields);
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      q(`UPDATE tasks SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(
        ...keys.map((k) => fields[k]),
        id,
      );
      return this.getTask(id);
    },

    // Oldest queued task whose *current* stage is the given one.
    nextQueuedFor(stage) {
      const rows = q(`SELECT * FROM tasks WHERE status = 'queued' ORDER BY id`).all().map(parseTask);
      return rows.find((t) => t.stages[t.stage_index] === stage) ?? null;
    },

    // ATOMIC CHECKOUT - the most important line in the scheduler.
    // The WHERE status='queued' makes it a compare-and-swap: if two workers race for the
    // same task, only one UPDATE changes a row. The loser sees changes === 0 and moves on.
    // Paperclip does the same thing so two agents never work the same issue.
    checkout(taskId, agentId) {
      const res = q(
        `UPDATE tasks SET status = 'running', assignee = ?, updated_at = datetime('now')
         WHERE id = ? AND status = 'queued'`,
      ).run(agentId, taskId);
      return res.changes === 1;
    },

    // ---- runs ----
    createRun({ taskId, agentId, stage }) {
      const { lastInsertRowid } = q(
        `INSERT INTO runs (task_id, agent_id, stage, status) VALUES (?, ?, ?, 'running')`,
      ).run(taskId, agentId, stage);
      return this.getRun(Number(lastInsertRowid));
    },
    getRun(id) {
      return q(`SELECT * FROM runs WHERE id = ?`).get(id);
    },
    finishRun(id, fields) {
      const keys = Object.keys(fields);
      q(`UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(', ')}, ended_at = datetime('now') WHERE id = ?`).run(
        ...keys.map((k) => fields[k]),
        id,
      );
    },
    setRunSession(id, sessionId) {
      q(`UPDATE runs SET session_id = ? WHERE id = ?`).run(sessionId, id);
    },
    runsForTask(taskId) {
      return q(`SELECT * FROM runs WHERE task_id = ? ORDER BY id`).all(taskId);
    },
    // Most recent Claude session for this task + stage - lets a rework run resume the
    // same conversation instead of starting from scratch (Paperclip: agent_task_sessions).
    lastSession(taskId, stage) {
      return (
        q(
          `SELECT session_id FROM runs WHERE task_id = ? AND stage = ? AND session_id IS NOT NULL
           ORDER BY id DESC LIMIT 1`,
        ).get(taskId, stage)?.session_id ?? null
      );
    },
    latestOutput(taskId, stage) {
      return (
        q(
          `SELECT output_file FROM runs WHERE task_id = ? AND stage = ? AND status = 'succeeded'
           ORDER BY id DESC LIMIT 1`,
        ).get(taskId, stage)?.output_file ?? null
      );
    },
    totalSpend() {
      return q(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM runs`).get().s;
    },
    taskSpend(taskId) {
      return q(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM runs WHERE task_id = ?`).get(taskId).s;
    },

    // Crash recovery: if the server died mid-run, those runs will never report back.
    recoverInterrupted() {
      q(`UPDATE runs SET status = 'interrupted', ended_at = datetime('now') WHERE status = 'running'`).run();
      return q(
        `UPDATE tasks SET status = 'queued', assignee = NULL, updated_at = datetime('now') WHERE status = 'running'`,
      ).run().changes;
    },

    childrenOf(parentId) {
      return q(`SELECT * FROM tasks WHERE parent_id = ? ORDER BY id`).all(parentId).map(parseTask);
    },
    // Withdraw pending proposals under a parent (optionally only one agent's). Returns their ids.
    dismissProposals(parentId, proposedBy = null) {
      const where = `parent_id = ? AND status = 'proposed'${proposedBy ? ' AND proposed_by = ?' : ''}`;
      const args = proposedBy ? [parentId, proposedBy] : [parentId];
      const ids = q(`SELECT id FROM tasks WHERE ${where}`).all(...args).map((r) => r.id);
      q(`UPDATE tasks SET status = 'dismissed', updated_at = datetime('now') WHERE ${where}`).run(...args);
      return ids;
    },

    // ---- routines ----
    createRoutine({ name, title, brief, stages, review, schedule, nextRunAt }) {
      const { lastInsertRowid } = q(
        `INSERT INTO routines (name, title, brief, stages, review, schedule, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(name, title, brief, JSON.stringify(stages), review ? 1 : 0, schedule, nextRunAt);
      return this.getRoutine(Number(lastInsertRowid));
    },
    getRoutine(id) {
      return parseRoutine(q(`SELECT * FROM routines WHERE id = ?`).get(id));
    },
    listRoutines() {
      return q(`SELECT * FROM routines ORDER BY id`).all().map(parseRoutine);
    },
    updateRoutine(id, fields) {
      const keys = Object.keys(fields);
      if (!keys.length) return this.getRoutine(id);
      const value = (k) => (k === 'stages' ? JSON.stringify(fields[k]) : typeof fields[k] === 'boolean' ? Number(fields[k]) : fields[k]);
      q(`UPDATE routines SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(value), id);
      return this.getRoutine(id);
    },
    deleteRoutine(id) {
      q(`DELETE FROM routines WHERE id = ?`).run(id);
    },
    // Overlap check: is a task from this routine's previous firing still unfinished?
    openTaskForRoutine(routineId) {
      return parseTask(
        q(`SELECT * FROM tasks WHERE routine_id = ? AND status IN ('queued', 'running', 'review') ORDER BY id DESC LIMIT 1`).get(routineId),
      );
    },

    // ---- activity ----
    log({ taskId = null, runId = null, agentId = null, kind, text }) {
      const { lastInsertRowid } = q(
        `INSERT INTO activity (task_id, run_id, agent_id, kind, text) VALUES (?, ?, ?, ?, ?)`,
      ).run(taskId, runId, agentId, kind, text);
      return q(`SELECT * FROM activity WHERE id = ?`).get(Number(lastInsertRowid));
    },
    activityForTask(taskId) {
      return q(`SELECT * FROM activity WHERE task_id = ? ORDER BY id DESC LIMIT 300`).all(taskId).reverse();
    },
    activityForAgent(agentId) {
      return q(`SELECT * FROM activity WHERE agent_id = ? ORDER BY id DESC LIMIT 100`).all(agentId).reverse();
    },
  };
}
