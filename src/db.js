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
      status      TEXT NOT NULL,              -- queued | running | review | done | failed | cancelled
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

  const q = (sql) => db.prepare(sql);
  const parseTask = (row) => row && { ...row, stages: JSON.parse(row.stages), review: !!row.review };

  return {
    raw: db,

    // ---- tasks ----
    createTask({ title, brief, stages, review }) {
      const { lastInsertRowid } = q(
        `INSERT INTO tasks (title, brief, stages, status, review) VALUES (?, ?, ?, 'queued', ?)`,
      ).run(title, brief, JSON.stringify(stages), review ? 1 : 0);
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
