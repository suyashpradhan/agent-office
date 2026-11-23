# Roadmap

## Phase 1: core (done)
- Orchestrator: tasks, atomic checkout, heartbeat, handoffs, review gates, session resume
- Claude Code adapter (headless `stream-json`) + mock adapter
- Per-project `.office/` (config, editable agent files, SQLite, handoff docs)
- Developer works in a git worktree on `office/task-<id>`
- Budgets: per-run cap, project cap that pauses the office
- 2D pixel office dashboard driven by live events

## Phase 2: good enough to leave running in the background (in progress)
- [x] Review the developer's code in the dashboard (diff viewer)
- [x] Safety net: commit leftover changes after a dev run; flag runs that changed nothing
- [x] Clean up worktrees when a task is done or cancelled (branch is kept)
- [x] Run timeout (`runTimeoutMinutes` in `.office/config.json`)
- [x] Desktop notifications + tab title count when something needs your review
- [x] Tests for the above, GitHub Actions CI, LICENSE

## Phase 3: next steps for learning Paperclip's architecture
- [x] **Routines**: scheduled tasks ("every Monday, research what competitors shipped").
  A `routines` table, a cron parser, and a check in `heartbeat()` that creates tasks when due,
  with overlap (skip while the last task is open) and catch-up (fire once after downtime)
  policies. Paperclip: `routines`, scheduled triggers.
- **Delegation**: an agent's deliverable can propose sub-tasks (`NEW_TASK:` lines). The
  orchestrator turns them into child tasks after you approve. Paperclip: org chart, delegation.
- **A second runtime**: a Codex or Gemini CLI adapter selected per agent (`runtime: codex`).
  Paperclip: `packages/adapters/*`.
- **Skills**: shared instruction files injected into an agent's prompt at runtime.
  Paperclip: Skill Studio, runtime skill injection.
- **Cost history**: a per-agent and per-task spend chart over time.

## Phase 4: if it ever becomes a product
- Multiple projects in one dashboard, auth, remote access from your phone
- Hosted agents (for example Claude Managed Agents) instead of local CLI processes
