# Agent Office

A three-agent team for any repo, with a 2D pixel-office dashboard where you watch them work.

- **Scout** (Researcher) searches the web and reads your code, then writes a research brief.
- **Pixel** (Designer) turns that into a design spec plus an HTML mockup.
- **Byte** (Developer) builds it on its own git branch, runs your tests and commits.

You hand out work at the office door, watch the agents walk to their desks and type, and get
each deliverable in your inbox tray. You approve it to pass it to the next teammate, or send it back with notes.

It's a small, readable take on the architecture behind
[Paperclip](https://github.com/paperclipai/paperclip): a control plane that runs Claude Code
agents with tasks, handoffs, approvals, budgets and live events. About 1,200 lines of
backend, zero dependencies. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

## Prerequisites

- **Node.js 22.13+** (uses the built-in `node:sqlite`)
- **git**
- **Claude Code CLI**, installed and logged in (`claude --version` works). Without it, use `--mock`.

## Install once

```bash
git clone <this repo> ~/agent-office
cd ~/agent-office
npm link            # puts `agent-office` on your PATH
```

## Use it in any project

```bash
cd ~/code/my-hackathon-app
agent-office        # opens http://localhost:4747
```

The first run creates `my-hackathon-app/.office/`, which holds this project's team, settings,
database and handoff docs. It's added to `.git/info/exclude`, so your repo stays clean. Each
project keeps its own history. Run several projects at once and each gets the next free port.

Try it with no cost first:

```bash
agent-office --mock
```

## Per-project settings

`.office/config.json`

```json
{ "budgetUsd": 5, "reviewBetweenStages": true, "heartbeatMs": 2000, "runTimeoutMinutes": 30 }
```

`.office/agents/*.md` sets each agent's role prompt, tools, workspace, model and budget per run:

```markdown
---
name: Scout
title: Researcher
stage: research
order: 1
color: #4c8bf5
tools: WebSearch, WebFetch, Read, Glob, Grep
workspace: repo          # repo = read your checkout, worktree = own git branch
maxBudgetUsd: 1.00
model:                   # optional, e.g. claude-sonnet-5-5 for a cheaper agent
mcp:                     # leave empty for none, or "inherit" to use your Claude MCP servers
---
You are Scout, the Researcher...
```

To add a fourth teammate, drop in `qa.md` with `stage: qa` and `order: 4`. It becomes a new
pipeline stage and gets a desk in the office.

## Reviewing the developer's work

Byte works in `.office/worktrees/task-<id>` on branch `office/task-<id>`. Your working copy
is never touched. The task panel shows the branch's changes as a diff. If Byte forgets to commit,
the orchestrator commits the leftovers for it. If Byte changes nothing, the task says so. When
the task is done or cancelled, the temporary checkout is removed and the branch is kept.
When you're happy with it:

```bash
git diff main...office/task-3
git merge office/task-3
```

## Commands

| | |
|---|---|
| `agent-office` | run for the current directory |
| `agent-office --repo ../app` | run for another repo |
| `agent-office --port 5000` | pick a port |
| `agent-office --mock` | simulated agents, no Claude calls |
| `agent-office init` | just create `.office/` so you can edit agents first |
| `npm test` | end-to-end tests (mock adapter) |

## Routines (scheduled work)

Click the **clock** on the office wall (or the Routines tab) to give the team recurring work,
for example "every Monday at 9:00, research what competitors shipped". A routine is a task
template plus a cron schedule (`0 9 * * 1`), and the form explains any schedule in plain English
and shows the next runs. When it's due, it creates an ordinary task, marked 🔁, that flows
through the same agents, reviews and budget.

- **No pile-ups:** if the task from the previous run is still open, that run is skipped.
- **No bursts after downtime:** if the office was off through several slots, the routine fires
  once when it's back, then waits for the next slot.
- Times use your computer's clock. Routines only run while `agent-office` is running.

## Working in the background

Click **Notify me** in the header to get a desktop notification when an agent needs your
review, a run fails, or a task is done. The browser tab title also shows how many items are
waiting, e.g. `(2) Agent Office · my-app`. A run that hangs is stopped after
`runTimeoutMinutes`.

## Costs

Every run reports its cost, and the header shows total spend for the project. Each agent has a
per-run cap (`maxBudgetUsd`, passed to `claude --max-budget-usd`). The whole office pauses
when the project reaches `budgetUsd`.
