# Architecture

Agent Office is a small **control plane** for AI agents. It shares Paperclip's core idea:
the orchestrator decides *who works on what, when, with which permissions and budget*,
and the agents (Claude Code processes) only do the work.

```
                 you (browser)
                     │  REST commands          ▲ live events (SSE)
                     ▼                         │
┌──────────────────────────────────────────────┴───────────────────┐
│ server.js        JSON API + event stream + static office UI      │
├──────────────────────────────────────────────────────────────────┤
│ orchestrator.js  the rules                                       │
│   heartbeat ─▶ find idle agent ─▶ atomic checkout ─▶ execute     │
│   execute   ─▶ build prompt (brief + handoffs + feedback)        │
│             ─▶ adapter.run() ─▶ save deliverable ─▶ review/next  │
│   approvals, request-changes, budget pause, crash recovery       │
├────────────────────────┬─────────────────────────────────────────┤
│ db.js (SQLite)         │ workspace.js                            │
│  tasks / runs /        │  <repo>/.office/, git worktrees,        │
│  activity              │  per-project config + agent files       │
├────────────────────────┴─────────────────────────────────────────┤
│ adapters/claude.js  spawns `claude -p --output-format stream-json`│
│ adapters/mock.js    same interface, fake work, no cost           │
└──────────────────────────────────────────────────────────────────┘
                     │ one process per run
                     ▼
         Claude Code (in your repo, or in a worktree)
```

## The life of a task

```
proposed ──accept──▶ queued ──checkout──▶ running ──ok──▶ review ──approve──▶ queued (next stage) ─ … ─▶ done
    │                                        │                └──request changes──▶ queued (same stage, resumes session)
    └──dismiss──▶ dismissed                  └──error──▶ failed ──retry──▶ queued
```

`proposed` only exists for sub-tasks an agent suggested (see Delegation below).

1. **You create a task** (`POST /api/tasks`) with stages, e.g. `research → design → dev`.
2. **Heartbeat** (every 2s, plus right away after any change) looks for an idle agent whose
   stage matches a queued task.
3. **Atomic checkout**: `UPDATE tasks SET status='running' WHERE id=? AND status='queued'`.
   Only one caller can win that compare-and-swap, so two runs never grab the same task.
4. **Execute**: the orchestrator builds the prompt from the brief, every earlier stage's
   deliverable (the *handoff*), and your feedback if there is any. It then calls the adapter.
5. **The adapter** spawns Claude Code headless. It gets the role prompt
   (`--append-system-prompt`), a tool list (`--tools` and `--allowedTools`), `--permission-mode dontAsk`,
   `--max-budget-usd`, and `--resume <session>` when continuing. Each line of `stream-json` becomes
   a normalized activity event ("Searching …", "Editing app.tsx").
6. **Deliverable**: the agent's final message is saved to `.office/tasks/<id>/<stage>.md`.
   The designer's ```html block is also saved as a mockup, which the UI serves sandboxed.
7. **Gate**: the task waits in `review` until you approve. Approving moves it to the next stage.
   Requesting changes re-queues the same stage, and the next run **resumes the same Claude session**,
   so the agent keeps its context.
8. **Developer safety net**: after a developer run, the orchestrator commits anything left
   uncommitted in the worktree and flags runs that changed nothing. The dashboard shows the
   branch diff. When the task is done or cancelled, the worktree is removed and the branch kept.
9. **Timeouts**: a run that takes longer than `runTimeoutMinutes` is aborted and marked failed.
10. **Routines**: every heartbeat also checks `routines` (a task template plus a cron schedule).
    A due routine creates an ordinary task, so everything above applies to it unchanged. Two
    policies keep it sane. *Overlap*: skip the run if the routine's previous task is still open.
    *Catch-up*: after downtime, fire once and schedule the next future slot.
11. **Delegation**: if the agent may delegate (`delegate` in its file, and the task's `depth` is
    under `maxDelegationDepth`), the prompt invites it to end its deliverable with a fenced
    `subtasks` JSON block. The orchestrator strips that block out and creates each entry as a
    task with `status='proposed'`, `parent_id`, `depth+1` and `proposed_by`. The heartbeat only
    takes `queued` tasks, so proposals wait for you. When you accept one, its prompt includes
    the parent's brief and the deliverable it came from. That's how context flows down.
12. **Budget**: every run reports its cost. When the project total reaches `budgetUsd`, the
   office pauses.

## Why each piece exists (and its Paperclip equivalent)

| Concept here | Why it exists | Paperclip |
|---|---|---|
| `tasks` table | The unit of work and its state machine | `issues` |
| `runs` table + `session_id` | One execution; resume a conversation later | `heartbeat_runs`, `agent_task_sessions` |
| `activity` table | Audit trail, live log | `activity_log`, `heartbeat_run_events` |
| `heartbeat()` + `wake()` | Agents don't poll; the control plane wakes them | heartbeat service, `agent_wakeup_requests` |
| `db.checkout()` | No double work under concurrency | atomic task checkout / execution locks |
| Review stage + approve | A human gate between autonomous steps | approvals, review stages |
| `budgetUsd`, `--max-budget-usd` | Runaway loops cost real money | `budget_policies`, budget enforcement |
| Agent `.md` files (tools, workspace) | Least privilege per role | org chart, permissions, governance |
| Adapter interface | Swap Claude for Codex, Gemini, a mock… | `packages/adapters/*` |
| `routines` + `schedule.js` | Recurring work without you remembering to start it | routines, scheduled triggers |
| `delegation.js`, `parent_id`, `proposed` status | Work flows down the team, with a human gate | delegation down the org chart, approvals |
| `hasColumn` migrations in `db.js` | Old projects' databases keep working after upgrades | `packages/db` migrations |
| Worktree per dev task | Agents never touch your working copy | execution workspaces |
| `recoverInterrupted()` | Server restarts don't lose work | startup recovery |
| SSE event bus | The UI is a view of server state | `server/src/realtime` |

## What we deliberately left out

Paperclip is built for many companies, many humans and agents running unattended around the
clock. To keep this project readable, we skipped multi-tenancy and auth, agents delegating to
other agents (an org hierarchy), goals and projects above tasks, skills management,
secrets/connectors, and plugins. (Routines and delegation started on this list and are now
built; see above.) Each of the rest would be a reasonable next exercise:

- **Blocking relations**: let a parent wait until its sub-tasks are done (Paperclip has
  "blocked by" links between issues).
- **Another runtime**: copy `adapters/claude.js` into `adapters/codex.js` and pick it per agent.

## Security notes

- The server binds to `127.0.0.1` only. Anyone who can reach it can make agents run code.
- Researcher and designer can't edit files. They get read and web tools only.
- The developer can run `Bash` and edit files, but only inside its own git worktree on an
  `office/task-<id>` branch. It commits locally and never pushes. You review and merge.
  Bash isn't a sandbox, though, so treat it like letting a junior developer use your machine.
- Agents get no MCP servers by default (`--strict-mcp-config`). Set `mcp: inherit` in an agent
  file to give it the MCP servers from your Claude config.
- The designer's HTML mockups are served with `Content-Security-Policy: sandbox` and shown in a
  sandboxed iframe.
