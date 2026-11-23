// The orchestrator (control plane). Owns the rules; agents only do the work.
//
//   heartbeat()  every few seconds: for each idle agent, check out the next task for its
//                stage and start a run. (Paperclip: heartbeat service + wakeup requests.)
//   execute()    builds the prompt (brief + handoffs + your feedback), calls the adapter,
//                saves the deliverable, then decides what happens next.
//   approve() / requestChanges()
//                the human gate between stages. (Paperclip: approvals / review stages.)
//   budget       every run reports its cost; at the project limit the office pauses.
//
// State machine for a task:
//
//   queued --checkout--> running --ok--> review --approve--> queued (next stage) ... --> done
//                           |               \--request changes--> queued (same stage, resumes session)
//                           \--error--> failed --retry--> queued

import fs from 'node:fs';
import path from 'node:path';
import { delegationInstructions, extractSubtasks } from './delegation.js';
import { parseSchedule, nextRun, nextRuns, describeSchedule, renderTitle } from './schedule.js';
import { ensureWorktree, branchDiff, commitLeftovers, commitsAhead, removeWorktree, pruneWorktrees } from './workspace.js';

// `now` is injectable so tests can move time forward without waiting.
export function createOrchestrator({ ws, db, agents, adapter, bus, now = () => new Date() }) {
  const byStage = new Map(agents.map((a) => [a.stage, a]));
  const stageOrder = agents.map((a) => a.stage);
  // In-memory runtime state per agent (what the office animates).
  const live = new Map(agents.map((a) => [a.id, { status: 'idle', taskId: null, runId: null, activity: '' }]));
  const controllers = new Map(); // runId -> AbortController
  let paused = false;
  let pauseReason = '';
  let timer = null;

  const recovered = db.recoverInterrupted();
  if (recovered) db.log({ kind: 'system', text: `Recovered ${recovered} task(s) interrupted by a restart` });
  pruneWorktrees(ws);

  // ---------- public API ----------

  function snapshot() {
    return {
      project: { name: ws.name, repo: ws.repo, branch: ws.branch, isGit: ws.isGit },
      adapter: adapter.name,
      office: officeState(),
      agents: agents.map(publicAgent),
      stages: stageOrder,
      tasks: db.listTasks().map(withMeta),
      routines: listRoutines(),
    };
  }

  function pickStages(stages) {
    const chosen = (Array.isArray(stages) && stages.length ? stages : stageOrder).filter((s) => byStage.has(s));
    if (!chosen.length) throw httpError(400, 'Pick at least one stage');
    // Keep stages in team order even if the UI sends them shuffled.
    return chosen.sort((a, b) => stageOrder.indexOf(a) - stageOrder.indexOf(b));
  }

  function createTask({ title, brief = '', stages, review, routineId = null }) {
    title = String(title || '').trim();
    if (!title) throw httpError(400, 'A task needs a title');
    const chosen = pickStages(stages);
    const task = db.createTask({
      title,
      brief: String(brief),
      stages: chosen,
      review: review ?? ws.config.reviewBetweenStages,
      routineId,
    });
    record({ taskId: task.id, kind: 'system', text: `New task: ${title} (${chosen.join(' -> ')})` });
    emitTask(task.id);
    wake();
    return withMeta(task);
  }

  function approve(taskId) {
    const task = mustGet(taskId);
    if (task.status !== 'review') throw httpError(409, 'Task is not waiting for review');
    advance(task, 'You approved');
  }

  function requestChanges(taskId, feedback) {
    const task = mustGet(taskId);
    if (task.status !== 'review') throw httpError(409, 'Task is not waiting for review');
    feedback = String(feedback || '').trim();
    if (!feedback) throw httpError(400, 'Say what should change');
    db.updateTask(task.id, { status: 'queued', assignee: null, feedback });
    record({ taskId: task.id, kind: 'system', text: `You requested changes: ${feedback}` });
    emitTask(task.id);
    wake();
  }

  function retry(taskId) {
    const task = mustGet(taskId);
    if (!['failed', 'cancelled'].includes(task.status)) throw httpError(409, 'Only failed or cancelled tasks can be retried');
    db.updateTask(task.id, { status: 'queued', assignee: null, error: null });
    record({ taskId: task.id, kind: 'system', text: 'Retrying' });
    emitTask(task.id);
    wake();
  }

  function cancel(taskId) {
    const task = mustGet(taskId);
    if (['done', 'cancelled'].includes(task.status)) return;
    // Proposals under a cancelled task make no sense any more.
    const withdrawn = db.dismissProposals(task.id);
    withdrawn.forEach(emitTask);
    let running = false;
    for (const [runId, ctl] of controllers) {
      if (db.getRun(runId)?.task_id === task.id) {
        running = true;
        ctl.abort();
      }
    }
    db.updateTask(task.id, { status: 'cancelled', assignee: null });
    record({ taskId: task.id, kind: 'system', text: 'Cancelled' });
    // A running agent may still be writing; its run cleans up the worktree once it stops.
    if (!running) cleanupWorktree(task.id);
    emitTask(task.id);
  }

  function stopAgent(agentId) {
    const state = live.get(agentId);
    if (state?.runId) controllers.get(state.runId)?.abort();
  }

  function setPaused(value, reason = '') {
    paused = value;
    pauseReason = value ? reason || 'Paused by you' : '';
    bus.publish('office', { office: officeState() });
    if (!value) wake();
  }

  function taskDetail(taskId) {
    const task = mustGet(taskId);
    const outputs = {};
    for (const stage of task.stages) {
      const file = db.latestOutput(task.id, stage);
      if (file && fs.existsSync(file)) {
        outputs[stage] = {
          markdown: fs.readFileSync(file, 'utf8'),
          mockup: fs.existsSync(path.join(path.dirname(file), `${stage}-mockup.html`)) ? `${stage}-mockup.html` : null,
        };
      }
    }
    return {
      task: withMeta(task),
      runs: db.runsForTask(task.id),
      outputs,
      activity: db.activityForTask(task.id),
      diff: task.branch ? branchDiff(ws, task.branch) : null,
      parent: task.parent_id ? withMeta(db.getTask(task.parent_id)) : null,
      children: db.childrenOf(task.id).map(withMeta),
    };
  }

  function agentDetail(agentId) {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) throw httpError(404, 'No such agent');
    return { agent: publicAgent(agent), tools: agent.tools, workspace: agent.workspace, activity: db.activityForAgent(agentId) };
  }

  function taskFile(taskId, name) {
    if (!/^[\w-]+\.(html|md)$/.test(name)) throw httpError(400, 'Bad file name');
    const file = path.join(ws.root, 'tasks', String(Number(taskId)), name);
    if (!fs.existsSync(file)) throw httpError(404, 'Not found');
    return file;
  }

  function start() {
    timer = setInterval(heartbeat, ws.config.heartbeatMs);
    heartbeat();
  }

  function stop() {
    clearInterval(timer);
    for (const ctl of controllers.values()) ctl.abort();
  }

  // ---------- the loop ----------

  let wakeQueued = false;
  function wake() {
    // Don't wait for the next tick when something just changed (new task, approval).
    if (wakeQueued) return;
    wakeQueued = true;
    setTimeout(() => {
      wakeQueued = false;
      heartbeat();
    }, 50);
  }

  function heartbeat() {
    if (paused) return;
    if (db.totalSpend() >= ws.config.budgetUsd) {
      setPaused(true, `Budget reached ($${ws.config.budgetUsd}). Raise budgetUsd in .office/config.json to continue.`);
      return;
    }
    fireDueRoutines();
    for (const agent of agents) {
      if (live.get(agent.id).status !== 'idle') continue;
      const task = db.nextQueuedFor(agent.stage);
      if (!task) continue;
      if (!db.checkout(task.id, agent.id)) continue; // someone else got it first
      emitTask(task.id);
      execute(agent, db.getTask(task.id)).catch((err) => {
        console.error(err);
        finishFailed(agent, task.id, null, err.message);
      });
    }
  }

  async function execute(agent, task) {
    const stage = task.stages[task.stage_index];
    const run = db.createRun({ taskId: task.id, agentId: agent.id, stage });
    const ctl = new AbortController();
    controllers.set(run.id, ctl);
    setLive(agent.id, { status: 'working', taskId: task.id, runId: run.id, activity: 'Getting started' });
    bus.publish('run', { phase: 'started', agentId: agent.id, taskId: task.id, runId: run.id, stage });

    // Where does this agent work? Read-only roles use your repo; the developer gets a worktree.
    let cwd = ws.repo;
    let branch = null;
    if (agent.workspace === 'worktree') {
      const wt = ensureWorktree(ws, task.id);
      cwd = wt.cwd;
      branch = wt.branch;
      if (wt.branch && task.branch !== wt.branch) db.updateTask(task.id, { branch: wt.branch });
    }

    // A run that hangs forever would block this agent forever. Abort it after the limit.
    const limitMin = Number(ws.config.runTimeoutMinutes) || 0;
    let timedOut = false;
    const timeout = limitMin > 0 ? setTimeout(() => ((timedOut = true), ctl.abort()), limitMin * 60_000) : null;

    // Resume the previous session for this stage if we have one (rework or crash recovery).
    const resumeSessionId = db.lastSession(task.id, stage);
    const prompt = buildPrompt(db.getTask(task.id), stage, !!resumeSessionId);
    record({ taskId: task.id, runId: run.id, agentId: agent.id, kind: 'system', text: `${agent.name} picked up "${task.title}" (${stage})${resumeSessionId ? ', resuming previous session' : ''}` });

    const result = await adapter.run({
      agent,
      prompt,
      cwd,
      resumeSessionId,
      signal: ctl.signal,
      onSession: (sid) => db.setRunSession(run.id, sid),
      onActivity: ({ kind, text }) => {
        setLive(agent.id, { activity: text });
        record({ taskId: task.id, runId: run.id, agentId: agent.id, kind, text });
      },
    });
    controllers.delete(run.id);
    clearTimeout(timeout);

    if (!result.ok) {
      const error = timedOut ? `Timed out after ${limitMin} min (runTimeoutMinutes in .office/config.json)` : result.error;
      db.finishRun(run.id, {
        status: ctl.signal.aborted && !timedOut ? 'stopped' : 'failed',
        error,
        cost_usd: result.costUsd ?? 0,
        session_id: result.sessionId ?? null,
      });
      if (db.getTask(task.id)?.status === 'cancelled') cleanupWorktree(task.id);
      return finishFailed(agent, task.id, run.id, error);
    }

    // Developer safety net: never lose uncommitted edits, and say so if nothing changed.
    if (branch) {
      try {
        if (commitLeftovers(cwd, `office: ${agent.name}'s uncommitted changes for task ${task.id}`)) {
          record({ taskId: task.id, runId: run.id, agentId: agent.id, kind: 'system', text: `${agent.name} left changes uncommitted; saved them as a commit on ${branch}` });
        }
        if (commitsAhead(ws, branch) === 0) {
          record({ taskId: task.id, runId: run.id, agentId: agent.id, kind: 'error', text: `${agent.name} finished without changing any code on ${branch}` });
        }
      } catch (err) {
        record({ taskId: task.id, runId: run.id, agentId: agent.id, kind: 'error', text: `Could not check the branch: ${err.message}` });
      }
    }

    // Delegation: pull any proposed sub-tasks out of the deliverable.
    let output = result.output;
    let proposals = null;
    if (canDelegate(agent, task)) {
      const extracted = extractSubtasks(output, { agents, max: ws.config.maxSubtasksPerRun });
      if (extracted.error) record({ taskId: task.id, runId: run.id, agentId: agent.id, kind: 'error', text: extracted.error });
      else {
        output = extracted.cleaned;
        proposals = extracted.subtasks;
      }
    }

    // Save the deliverable as a handoff document the next agent (and you) can read.
    const dir = ws.taskDir(task.id);
    const outFile = path.join(dir, `${stage}.md`);
    fs.writeFileSync(outFile, output);
    const mockup = output.match(/```html\s*\n([\s\S]*?)```/);
    if (mockup) fs.writeFileSync(path.join(dir, `${stage}-mockup.html`), mockup[1]);

    db.finishRun(run.id, { status: 'succeeded', cost_usd: result.costUsd ?? 0, output_file: outFile, session_id: result.sessionId ?? null });
    record({ taskId: task.id, runId: run.id, agentId: agent.id, kind: 'system', text: `${agent.name} finished ${stage} ($${(result.costUsd ?? 0).toFixed(3)})` });
    db.updateTask(task.id, { feedback: null });
    if (proposals) proposeSubtasks(db.getTask(task.id), agent, proposals);

    const fresh = db.getTask(task.id);
    if (fresh.status === 'cancelled') {
      cleanupWorktree(task.id);
      setLive(agent.id, { status: 'idle', taskId: null, runId: null, activity: '' });
      return;
    }
    const isLast = fresh.stage_index >= fresh.stages.length - 1;
    if (fresh.review || isLast) {
      db.updateTask(task.id, { status: 'review', assignee: null });
      record({ taskId: task.id, kind: 'system', text: isLast ? 'Ready for your final review' : `Waiting for your review before ${fresh.stages[fresh.stage_index + 1]}` });
      emitTask(task.id);
    } else {
      advance(fresh, 'Auto-approved (review off)');
    }
    setLive(agent.id, { status: 'idle', taskId: null, runId: null, activity: '' });
    bus.publish('run', { phase: 'finished', ok: true, agentId: agent.id, taskId: task.id, runId: run.id, stage, proposed: proposals?.length ?? 0 });
    emitOffice();
    wake();
  }

  function finishFailed(agent, taskId, runId, error) {
    const task = db.getTask(taskId);
    if (task && task.status !== 'cancelled') db.updateTask(taskId, { status: 'failed', assignee: null, error });
    record({ taskId, runId, agentId: agent.id, kind: 'error', text: error || 'Run failed' });
    setLive(agent.id, { status: 'idle', taskId: null, runId: null, activity: '' });
    bus.publish('run', { phase: 'finished', ok: false, agentId: agent.id, taskId, runId, error });
    emitTask(taskId);
    emitOffice();
  }

  function advance(task, why) {
    const isLast = task.stage_index >= task.stages.length - 1;
    if (isLast) {
      db.updateTask(task.id, { status: 'done', assignee: null });
      record({ taskId: task.id, kind: 'system', text: `${why}. Task done` });
      cleanupWorktree(task.id);
    } else {
      const from = task.stages[task.stage_index];
      const to = task.stages[task.stage_index + 1];
      db.updateTask(task.id, { status: 'queued', assignee: null, stage_index: task.stage_index + 1 });
      record({ taskId: task.id, kind: 'system', text: `${why}. Handing off ${from} -> ${to}` });
      bus.publish('handoff', { taskId: task.id, from: byStage.get(from)?.id, to: byStage.get(to)?.id });
    }
    emitTask(task.id);
    wake();
  }

  // ---------- routines (scheduled tasks) ----------
  //
  // A routine is a task template + a cron schedule. The heartbeat checks for due routines
  // and turns each one into an ordinary task, so everything downstream (agents, reviews,
  // budget) works exactly the same. Paperclip: routines + scheduled triggers.
  //
  // Two policies worth noticing:
  //   overlap  - if the task from the previous firing is still open, skip this firing
  //              (otherwise a slow or unreviewed routine piles up duplicate work)
  //   catch-up - if the office was off or paused through several slots, fire once and
  //              schedule the next future slot (never a burst of missed runs)

  function listRoutines() {
    return db.listRoutines().map(publicRoutine);
  }

  function validateRoutine(input, existing = {}) {
    const name = String(input.name ?? existing.name ?? '').trim();
    if (!name) throw httpError(400, 'A routine needs a name');
    const title = String(input.title ?? existing.title ?? '').trim() || `${name} · {date}`;
    const schedule = String(input.schedule ?? existing.schedule ?? '').trim();
    try {
      parseSchedule(schedule);
    } catch (err) {
      throw httpError(400, err.message);
    }
    return {
      name,
      title,
      schedule,
      brief: String(input.brief ?? existing.brief ?? ''),
      stages: pickStages(input.stages ?? existing.stages),
      review: input.review ?? existing.review ?? ws.config.reviewBetweenStages,
    };
  }

  function createRoutine(input) {
    const r = validateRoutine(input);
    const routine = db.createRoutine({ ...r, nextRunAt: nextRun(parseSchedule(r.schedule), now()).toISOString() });
    record({ kind: 'system', text: `New routine "${routine.name}": ${describeSchedule(routine.schedule)}` });
    emitRoutines();
    return publicRoutine(routine);
  }

  function updateRoutine(id, input) {
    const existing = mustGetRoutine(id);
    const fields = {};
    if (['name', 'title', 'brief', 'stages', 'review', 'schedule'].some((k) => k in input)) {
      Object.assign(fields, validateRoutine(input, existing));
    }
    if ('enabled' in input) fields.enabled = !!input.enabled;
    // New schedule, or switched back on: next run is the next slot from *now* (no catch-up).
    if (fields.schedule !== undefined || fields.enabled === true) {
      fields.next_run_at = nextRun(parseSchedule(fields.schedule ?? existing.schedule), now()).toISOString();
    }
    const routine = db.updateRoutine(existing.id, fields);
    emitRoutines();
    return publicRoutine(routine);
  }

  function removeRoutine(id) {
    const r = mustGetRoutine(id);
    db.deleteRoutine(r.id);
    record({ kind: 'system', text: `Removed routine "${r.name}"` });
    emitRoutines();
  }

  function runRoutineNow(id) {
    return publicRoutine(fireRoutine(mustGetRoutine(id), { manual: true }));
  }

  function fireDueRoutines() {
    const t = now();
    for (const r of db.listRoutines()) {
      if (r.enabled && r.next_run_at && new Date(r.next_run_at) <= t) fireRoutine(r, { manual: false });
    }
  }

  function fireRoutine(r, { manual }) {
    const t = now();
    const fields = { last_run_at: t.toISOString() };
    const open = manual ? null : db.openTaskForRoutine(r.id);
    if (open) {
      fields.last_result = `Skipped: task #${open.id} from the last run is still open`;
      record({ taskId: open.id, kind: 'system', text: `Routine "${r.name}" skipped a run: this task is still open` });
    } else {
      const task = createTask({ title: renderTitle(r.title, t), brief: r.brief, stages: r.stages, review: r.review, routineId: r.id });
      fields.last_task_id = task.id;
      fields.last_result = `Created task #${task.id}${manual ? ' (run now)' : ''}`;
      record({ taskId: task.id, kind: 'system', text: `Routine "${r.name}" created this task${manual ? ' (you clicked Run now)' : ''}` });
    }
    // Catch-up policy: always schedule from now, so missed slots collapse into this one run.
    if (!manual) fields.next_run_at = nextRun(parseSchedule(r.schedule), t).toISOString();
    const updated = db.updateRoutine(r.id, fields);
    emitRoutines();
    return updated;
  }

  function schedulePreview(schedule) {
    try {
      const spec = parseSchedule(schedule);
      return { ok: true, description: describeSchedule(schedule), next: nextRuns(spec, now(), 3).map((d) => d.toISOString()) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function publicRoutine(r) {
    return { ...r, description: describeSchedule(r.schedule) };
  }

  function mustGetRoutine(id) {
    const r = db.getRoutine(Number(id));
    if (!r) throw httpError(404, 'No such routine');
    return r;
  }

  function emitRoutines() {
    bus.publish('routines', { routines: listRoutines() });
  }

  // ---------- delegation (sub-tasks) ----------
  //
  // Agents propose, you approve. A proposal is an ordinary task with status "proposed",
  // a parent_id and a depth. The scheduler only picks up "queued" tasks, so proposals sit
  // still until you accept them. Guardrails: a depth limit (no endless chains), a cap per
  // run, and a rerun replaces the same agent's earlier pending proposals instead of
  // piling up duplicates. Paperclip: delegation down the org chart + approvals.

  function canDelegate(agent, task) {
    return agent.delegate && (task.depth ?? 0) < Number(ws.config.maxDelegationDepth ?? 1) && Number(ws.config.maxSubtasksPerRun ?? 3) > 0;
  }

  function proposeSubtasks(parent, agent, list) {
    const replaced = db.dismissProposals(parent.id, agent.id);
    replaced.forEach(emitTask);
    if (replaced.length && list.length) {
      record({ taskId: parent.id, agentId: agent.id, kind: 'system', text: `${agent.name}'s new deliverable replaces ${replaced.length} earlier proposal(s)` });
    }
    if (!list.length) return;
    const auto = !!ws.config.autoApproveSubtasks;
    for (const s of list) {
      const child = db.createTask({
        title: s.title,
        brief: s.brief,
        stages: s.stages,
        review: parent.review,
        parentId: parent.id,
        depth: (parent.depth ?? 0) + 1,
        proposedBy: agent.id,
        status: auto ? 'queued' : 'proposed',
      });
      record({ taskId: child.id, agentId: agent.id, kind: 'system', text: `Proposed as a sub-task of #${parent.id} "${parent.title}"` });
      emitTask(child.id);
    }
    record({
      taskId: parent.id,
      agentId: agent.id,
      kind: 'system',
      text: `Proposed ${list.length} sub-task(s)${auto ? ' (auto-approved)' : ' for your approval'}`,
    });
    if (auto) wake();
  }

  function acceptSubtask(taskId) {
    const task = mustGet(taskId);
    if (!['proposed', 'dismissed'].includes(task.status)) throw httpError(409, 'Only proposed sub-tasks can be accepted');
    db.updateTask(task.id, { status: 'queued' });
    record({ taskId: task.id, kind: 'system', text: 'You accepted this sub-task' });
    emitTask(task.id);
    wake();
  }

  function dismissSubtask(taskId) {
    const task = mustGet(taskId);
    if (task.status !== 'proposed') throw httpError(409, 'Only proposed sub-tasks can be dismissed');
    db.updateTask(task.id, { status: 'dismissed' });
    record({ taskId: task.id, kind: 'system', text: 'You dismissed this sub-task' });
    emitTask(task.id);
  }

  function acceptAllSubtasks(parentId) {
    const parent = mustGet(parentId);
    const pending = db.childrenOf(parent.id).filter((c) => c.status === 'proposed');
    pending.forEach((c) => acceptSubtask(c.id));
    return { accepted: pending.length };
  }

  // ---------- prompt building (the "handoff") ----------

  function buildPrompt(task, stage, resuming) {
    const agent = byStage.get(stage);
    if (resuming && task.feedback) {
      const reminder = agent && canDelegate(agent, task)
        ? '\n\nIf you proposed sub-tasks before, include the complete, updated subtasks block again. Anything you leave out is withdrawn.'
        : '';
      return `The manager reviewed your previous deliverable and requested changes:\n\n${task.feedback}\n\nProduce a complete, revised deliverable (not just the diff).${reminder}`;
    }
    if (resuming) {
      return `You were interrupted before finishing. Continue the task "${task.title}" and produce your complete final deliverable.`;
    }
    const parts = [`# Task: ${task.title}`, '', task.brief || '(no extra details)'];
    // Context flows down: a sub-task sees where it came from.
    if (task.parent_id) {
      const parent = db.getTask(task.parent_id);
      const proposer = agents.find((a) => a.id === task.proposed_by);
      if (parent) {
        parts.push('', '## Context: this is a sub-task', '', `${proposer?.name ?? 'A teammate'} proposed it while working on "${parent.title}" (task #${parent.id}).`);
        if (parent.brief) parts.push('', 'The parent task\'s brief:', '', parent.brief);
        const file = proposer && db.latestOutput(parent.id, proposer.stage);
        if (file && fs.existsSync(file)) {
          const text = fs.readFileSync(file, 'utf8');
          parts.push('', `### ${proposer.name}'s deliverable on the parent task`, '', text.length > 8000 ? `${text.slice(0, 8000)}\n\n[...truncated]` : text);
        }
      }
    }
    for (const prev of task.stages.slice(0, task.stages.indexOf(stage))) {
      const file = db.latestOutput(task.id, prev);
      if (file && fs.existsSync(file)) {
        const who = byStage.get(prev);
        parts.push('', `## Handoff from ${who?.name ?? prev} (${who?.title ?? prev})`, '', fs.readFileSync(file, 'utf8'));
      }
    }
    if (task.feedback) parts.push('', '## Feedback from the manager', '', task.feedback);
    if (agent && canDelegate(agent, task)) parts.push('', delegationInstructions(agents, ws.config.maxSubtasksPerRun));
    return parts.join('\n');
  }

  // ---------- helpers ----------

  function cleanupWorktree(taskId) {
    const task = db.getTask(taskId);
    if (task?.branch && removeWorktree(ws, taskId)) {
      record({ taskId, kind: 'system', text: `Removed the temporary checkout; the work stays on ${task.branch}` });
    }
  }

  function record(entry) {
    const row = db.log(entry);
    bus.publish('activity', { entry: row });
  }

  function setLive(agentId, patch) {
    Object.assign(live.get(agentId), patch);
    bus.publish('agent', { agent: publicAgent(agents.find((a) => a.id === agentId)) });
  }

  function publicAgent(a) {
    const { prompt, ...rest } = a;
    return { ...rest, ...live.get(a.id) };
  }

  function withMeta(task) {
    return { ...task, stage: task.stages[task.stage_index], costUsd: db.taskSpend(task.id) };
  }

  function officeState() {
    return { paused, pauseReason, spentUsd: db.totalSpend(), budgetUsd: ws.config.budgetUsd };
  }

  function emitTask(id) {
    const t = db.getTask(id);
    if (t) bus.publish('task', { task: withMeta(t) });
  }

  function emitOffice() {
    bus.publish('office', { office: officeState() });
  }

  function mustGet(id) {
    const t = db.getTask(Number(id));
    if (!t) throw httpError(404, 'No such task');
    return t;
  }

  return {
    snapshot, createTask, approve, requestChanges, retry, cancel, stopAgent, setPaused,
    taskDetail, agentDetail, taskFile, start, stop,
    acceptSubtask, dismissSubtask, acceptAllSubtasks,
    listRoutines, createRoutine, updateRoutine, removeRoutine, runRoutineNow, schedulePreview,
    tick: heartbeat, // run one heartbeat right now (used by tests)
  };
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
