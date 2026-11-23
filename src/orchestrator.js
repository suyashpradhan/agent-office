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
import { ensureWorktree, diffStat } from './workspace.js';

export function createOrchestrator({ ws, db, agents, adapter, bus }) {
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

  // ---------- public API ----------

  function snapshot() {
    return {
      project: { name: ws.name, repo: ws.repo, branch: ws.branch, isGit: ws.isGit },
      adapter: adapter.name,
      office: officeState(),
      agents: agents.map(publicAgent),
      stages: stageOrder,
      tasks: db.listTasks().map(withMeta),
    };
  }

  function createTask({ title, brief = '', stages, review }) {
    title = String(title || '').trim();
    if (!title) throw httpError(400, 'A task needs a title');
    const chosen = (Array.isArray(stages) && stages.length ? stages : stageOrder).filter((s) => byStage.has(s));
    if (!chosen.length) throw httpError(400, 'Pick at least one stage');
    // Keep stages in team order even if the UI sends them shuffled.
    chosen.sort((a, b) => stageOrder.indexOf(a) - stageOrder.indexOf(b));
    const task = db.createTask({
      title,
      brief: String(brief),
      stages: chosen,
      review: review ?? ws.config.reviewBetweenStages,
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
    for (const [runId, ctl] of controllers) if (db.getRun(runId)?.task_id === task.id) ctl.abort();
    db.updateTask(task.id, { status: 'cancelled', assignee: null });
    record({ taskId: task.id, kind: 'system', text: 'Cancelled' });
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
      diffStat: task.branch ? diffStat(ws, task.branch) : '',
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
    if (agent.workspace === 'worktree') {
      const wt = ensureWorktree(ws, task.id);
      cwd = wt.cwd;
      if (wt.branch && task.branch !== wt.branch) db.updateTask(task.id, { branch: wt.branch });
    }

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

    if (!result.ok) {
      db.finishRun(run.id, {
        status: ctl.signal.aborted ? 'stopped' : 'failed',
        error: result.error,
        cost_usd: result.costUsd ?? 0,
        session_id: result.sessionId ?? null,
      });
      return finishFailed(agent, task.id, run.id, result.error);
    }

    // Save the deliverable as a handoff document the next agent (and you) can read.
    const dir = ws.taskDir(task.id);
    const outFile = path.join(dir, `${stage}.md`);
    fs.writeFileSync(outFile, result.output);
    const mockup = result.output.match(/```html\s*\n([\s\S]*?)```/);
    if (mockup) fs.writeFileSync(path.join(dir, `${stage}-mockup.html`), mockup[1]);

    db.finishRun(run.id, { status: 'succeeded', cost_usd: result.costUsd ?? 0, output_file: outFile, session_id: result.sessionId ?? null });
    record({ taskId: task.id, runId: run.id, agentId: agent.id, kind: 'system', text: `${agent.name} finished ${stage} ($${(result.costUsd ?? 0).toFixed(3)})` });
    db.updateTask(task.id, { feedback: null });

    const fresh = db.getTask(task.id);
    if (fresh.status === 'cancelled') {
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
    bus.publish('run', { phase: 'finished', ok: true, agentId: agent.id, taskId: task.id, runId: run.id, stage });
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

  // ---------- prompt building (the "handoff") ----------

  function buildPrompt(task, stage, resuming) {
    if (resuming && task.feedback) {
      return `The manager reviewed your previous deliverable and requested changes:\n\n${task.feedback}\n\nProduce a complete, revised deliverable (not just the diff).`;
    }
    if (resuming) {
      return `You were interrupted before finishing. Continue the task "${task.title}" and produce your complete final deliverable.`;
    }
    const parts = [`# Task: ${task.title}`, '', task.brief || '(no extra details)'];
    for (const prev of task.stages.slice(0, task.stages.indexOf(stage))) {
      const file = db.latestOutput(task.id, prev);
      if (file && fs.existsSync(file)) {
        const who = byStage.get(prev);
        parts.push('', `## Handoff from ${who?.name ?? prev} (${who?.title ?? prev})`, '', fs.readFileSync(file, 'utf8'));
      }
    }
    if (task.feedback) parts.push('', '## Feedback from the manager', '', task.feedback);
    return parts.join('\n');
  }

  // ---------- helpers ----------

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
  };
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
