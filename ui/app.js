// Dashboard app: keeps a local copy of server state (from SSE), renders the side panel,
// and feeds the 2D office. All changes go through the API; the UI only reacts to events.

import { createOffice } from './office.js';
import { drawCharacter } from './sprites.js';
import { renderMarkdown, escapeHtml as h } from './markdown.js';

const state = { project: {}, adapter: '', office: {}, agents: [], stages: [], tasks: new Map(), routines: [] };
const detailCache = new Map();
const $ = (sel) => document.querySelector(sel);
const viewEl = $('#view');

const office = createOffice({
  canvas: $('#office'),
  overlay: $('#overlay'),
  onSelect: (hit) => {
    if (hit.type === 'agent') go(`agent/${hit.id}`);
    if (hit.type === 'board') go('board');
    if (hit.type === 'inbox') go('inbox');
    if (hit.type === 'new') go('new');
    if (hit.type === 'routines') go('routines');
  },
  onHint: toast,
});

// ---------- server connection ----------

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (msg) => handle(JSON.parse(msg.data));
  es.onerror = () => {
    $('#conn').hidden = false;
  };
  es.onopen = () => {
    $('#conn').hidden = true;
  };
}

function handle(evt) {
  switch (evt.type) {
    case 'snapshot': {
      const s = evt.state;
      Object.assign(state, { project: s.project, adapter: s.adapter, office: s.office, agents: s.agents, stages: s.stages });
      state.tasks = new Map(s.tasks.map((t) => [t.id, t]));
      state.routines = s.routines || [];
      office.setRoutines(state.routines);
      office.setAgents(state.agents);
      office.setTasks([...state.tasks.values()]);
      office.setPaused(s.office.paused);
      renderHeader();
      renderRoster();
      render();
      break;
    }
    case 'task': {
      const prev = state.tasks.get(evt.task.id);
      state.tasks.set(evt.task.id, evt.task);
      office.setTasks([...state.tasks.values()]);
      if (!prev) office.taskCreated();
      else if (prev.status === 'review' && evt.task.status === 'queued' && evt.task.stage_index > prev.stage_index) office.approvedHandoff();
      if (prev && prev.status !== 'done' && evt.task.status === 'done') office.celebrate();
      maybeNotify(prev, evt.task);
      invalidate(evt.task.id);
      if (evt.task.parent_id) invalidate(evt.task.parent_id); // the parent page lists its sub-tasks
      render();
      break;
    }
    case 'agent': {
      state.agents = state.agents.map((a) => (a.id === evt.agent.id ? evt.agent : a));
      office.setAgents(state.agents);
      renderRoster();
      if (route().name === 'agent' && route().id === evt.agent.id) render();
      break;
    }
    case 'run':
      office.runEvent(evt);
      break;
    case 'activity':
      if (evt.entry.task_id) invalidate(evt.entry.task_id);
      if (route().name === 'agent' && route().id === evt.entry.agent_id) scheduleRender();
      break;
    case 'routines':
      state.routines = evt.routines;
      office.setRoutines(state.routines);
      if (route().name === 'routines' && !route().id) render();
      break;
    case 'office':
      state.office = evt.office;
      office.setPaused(evt.office.paused);
      renderHeader();
      break;
  }
}

function invalidate(taskId) {
  detailCache.delete(taskId);
  const r = route();
  if (r.name === 'task' && Number(r.id) === taskId) scheduleRender();
}

let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 250);
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- routing ----------

function route() {
  const [name = 'board', id] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || 'board', id };
}
function go(path) {
  if (location.hash === `#${path}`) render();
  else location.hash = path;
}
window.addEventListener('hashchange', render);

// ---------- header + roster ----------

function renderHeader() {
  const p = state.project;
  $('#project').innerHTML = `<strong>${h(p.name)}</strong>${p.branch ? ` <span class="muted">on ${h(p.branch)}</span>` : ''}`;
  $('#plaque').textContent = p.name || '';
  const { spentUsd = 0, budgetUsd = 0, paused, pauseReason } = state.office;
  $('#budgetText').textContent = `$${spentUsd.toFixed(2)} of $${budgetUsd}`;
  $('#budgetBar').style.width = `${Math.min(100, (spentUsd / (budgetUsd || 1)) * 100)}%`;
  $('#mockBadge').hidden = state.adapter !== 'mock';
  $('#pauseBtn').textContent = paused ? 'Resume office' : 'Pause office';
  $('#pauseBtn').classList.toggle('primary', !!paused);
  const banner = $('#pausedBanner');
  banner.hidden = !paused;
  banner.textContent = paused ? `⏸ ${pauseReason || 'Office paused'}` : '';
}

$('#pauseBtn').addEventListener('click', () => api(state.office.paused ? '/api/office/resume' : '/api/office/pause', {}).catch((e) => toast(e.message)));

const avatarCache = new Map();
function avatar(agent, scale = 3) {
  const key = `${agent.id}:${scale}`;
  if (!avatarCache.has(key)) {
    const c = document.createElement('canvas');
    c.width = 16 * scale;
    c.height = 26 * scale;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.scale(scale, scale);
    const index = state.agents.findIndex((a) => a.id === agent.id);
    drawCharacter(ctx, { ...agent, index }, { x: 8, y: 25, dir: 'down', pose: 'stand', frame: 0, t: 0 });
    avatarCache.set(key, c.toDataURL());
  }
  return `<img class="avatar" src="${avatarCache.get(key)}" alt="" width="${16 * scale}" height="${26 * scale}">`;
}

function agentStatus(a) {
  if (a.status === 'working') {
    const task = state.tasks.get(a.taskId);
    return a.activity || (task ? `Working on ${task.title}` : 'Working');
  }
  return 'On a break';
}

function renderRoster() {
  $('#roster').innerHTML = state.agents
    .map(
      (a) => `<button class="agent-chip ${a.status}" data-agent="${h(a.id)}" style="--agent:${h(a.color)}">
        ${avatar(a, 2)}
        <span><strong>${h(a.name)}</strong> <span class="muted">${h(a.title)}</span><br><small>${h(agentStatus(a))}</small></span>
      </button>`,
    )
    .join('');
}
$('#roster').addEventListener('click', (e) => {
  const b = e.target.closest('[data-agent]');
  if (b) go(`agent/${b.dataset.agent}`);
});

// ---------- views ----------

const STATUS_LABEL = {
  proposed: 'Proposed',
  queued: 'Queued',
  running: 'Working',
  review: 'Needs your review',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  dismissed: 'Dismissed',
};
const needsYou = (t) => t.status === 'review' || t.status === 'failed' || t.status === 'proposed';
const agentById = (id) => state.agents.find((a) => a.id === id);

function agentForStage(stage) {
  return state.agents.find((a) => a.stage === stage);
}

function pipeline(task) {
  return `<ol class="pipeline">${task.stages
    .map((s, i) => {
      const a = agentForStage(s);
      const cls = i < task.stage_index || task.status === 'done' ? 'done' : i === task.stage_index ? `current ${task.status}` : '';
      return `<li class="${cls}" style="--agent:${h(a?.color || '#999')}"><span class="dot"></span>${h(a?.name || s)}<small>${h(a?.title || s)}</small></li>`;
    })
    .join('')}</ol>`;
}

function card(task) {
  const a = agentForStage(task.stage);
  const parent = task.parent_id ? state.tasks.get(task.parent_id) : null;
  const proposer = agentById(task.proposed_by);
  return `<a class="card ${task.status === 'proposed' ? 'proposed' : ''}" href="#task/${task.id}" style="--agent:${h(a?.color || '#999')}">
    <span class="card-title">${task.routine_id ? '<span title="Created by a routine" aria-label="Created by a routine">🔁</span> ' : ''}${h(task.title)}</span>
    ${task.parent_id ? `<small class="lineage">↳ ${task.status === 'proposed' && proposer ? `💡 ${h(proposer.name)}'s idea, ` : ''}sub-task of ${parent ? `“${h(parent.title)}”` : `#${task.parent_id}`}</small>` : ''}
    <span class="status ${task.status}">${h(STATUS_LABEL[task.status] || task.status)}</span>
    ${pipeline(task)}
    ${task.costUsd ? `<small class="muted">$${task.costUsd.toFixed(3)}</small>` : ''}
  </a>`;
}

function viewBoard() {
  const all = [...state.tasks.values()];
  const group = (title, list, empty) =>
    `<section class="group"><h3>${title} <span class="count">${list.length}</span></h3>${list.length ? list.map(card).join('') : `<p class="empty">${empty}</p>`}</section>`;
  if (!all.length) {
    return `<div class="welcome">
      <h2>Your team is on a coffee break</h2>
      <p>Hand out the first piece of work. Scout researches it, Pixel designs it, Byte builds it on a separate git branch, and you approve each step.</p>
      <a class="btn primary" href="#new">Hand out work</a>
    </div>`;
  }
  return [
    group('Working', all.filter((t) => t.status === 'running'), 'Nobody is working right now.'),
    group('Needs you', all.filter(needsYou), 'Nothing waiting for you.'),
    group('Queued', all.filter((t) => t.status === 'queued'), 'The queue is empty.'),
    group('Finished', all.filter((t) => t.status === 'done' || t.status === 'cancelled').slice(0, 12), 'Nothing finished yet.'),
  ].join('');
}

function viewInbox() {
  const list = [...state.tasks.values()].filter(needsYou);
  return `<h2>Your inbox</h2><p class="muted">Work lands here when an agent finishes a step. Approve it to hand it to the next teammate, or ask for changes.</p>
    ${list.length ? list.map(card).join('') : '<p class="empty">Inbox zero. Nice.</p>'}`;
}

function stagePicks(selected) {
  return `<div class="stage-picks">${state.stages
    .map((s) => {
      const a = agentForStage(s);
      return `<label class="pick" style="--agent:${h(a.color)}"><input type="checkbox" name="stages" value="${h(s)}" ${selected.includes(s) ? 'checked' : ''}>
        ${avatar(a, 2)}<span><strong>${h(a.name)}</strong><br><small>${h(a.title)}</small></span></label>`;
    })
    .join('')}</div>`;
}

// ---------- routines (scheduled tasks) ----------

const PRESETS = [
  ['0 9 * * 1-5', 'Weekdays 9:00'],
  ['0 9 * * *', 'Daily 9:00'],
  ['0 9 * * 1', 'Mondays 9:00'],
  ['0 17 * * 5', 'Fridays 17:00'],
  ['0 * * * *', 'Hourly'],
];

const TEMPLATES = [
  { name: 'Competitor watch', schedule: '0 9 * * 1', stages: ['research'], brief: 'What did the main competitors and similar open-source projects ship in the last week? Anything we should copy, avoid, or respond to?' },
  { name: 'Dependency check', schedule: '0 9 * * 1-5', stages: ['research'], brief: 'Check this project\'s dependencies for new major versions, deprecations, and security advisories. Recommend what to upgrade first.' },
  { name: 'Friday UI polish', schedule: '0 17 * * 5', stages: ['design', 'dev'], brief: 'Find one small, high-impact UI polish in this app (spacing, empty states, copy, accessibility) and implement it.' },
];
let pendingTemplate = null;

function rel(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return `${hrs} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.round(hrs / 24)} days`;
}
function when(iso) {
  const d = new Date(iso);
  const abs = d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const diff = d - Date.now();
  return diff <= 0 ? `due now (${abs})` : `in ${rel(diff)} · ${abs}`;
}
function ago(iso) {
  return iso ? `${rel(Date.now() - new Date(iso))} ago` : '';
}

function viewRoutines() {
  const list = state.routines;
  const cards = list
    .map(
      (r) => `<div class="routine ${r.enabled ? '' : 'off'}">
        <div class="routine-head"><strong>${h(r.name)}</strong><span class="chip">🔁 ${h(r.description)}</span></div>
        <div class="routine-meta">
          <div><span class="muted">Next</span> ${r.enabled ? h(when(r.next_run_at)) : '<em>Paused</em>'}</div>
          <div><span class="muted">Last</span> ${r.last_result ? `${h(r.last_result)} <span class="muted">${h(ago(r.last_run_at))}</span>` : 'Never run'}
            ${r.last_task_id && state.tasks.has(r.last_task_id) ? ` · <a href="#task/${r.last_task_id}">open task</a>` : ''}</div>
          <div><span class="muted">Team</span> ${r.stages.map((s) => h(agentForStage(s)?.name || s)).join(' → ')}${r.review ? '' : ' <span class="muted">(no review between steps)</span>'}</div>
        </div>
        <div class="actions">
          <button class="btn" data-action="routine-run" data-id="${r.id}">Run now</button>
          <button class="btn" data-action="routine-toggle" data-id="${r.id}" data-enabled="${r.enabled}">${r.enabled ? 'Pause' : 'Resume'}</button>
          <a class="btn" href="#routines/${r.id}">Edit</a>
          <button class="btn danger" data-action="routine-remove" data-id="${r.id}">Remove</button>
        </div>
      </div>`,
    )
    .join('');
  const templates = `<h3>Ideas to start from</h3>${TEMPLATES.map(
    (t, i) => `<button class="template" data-action="routine-template" data-index="${i}">
      <strong>${h(t.name)}</strong> <span class="muted">· ${h(PRESETS.find((p) => p[0] === t.schedule)?.[1] || t.schedule)}</span><br><small>${h(t.brief)}</small></button>`,
  ).join('')}`;
  return `<div class="view-head"><h2>Routines</h2><a class="btn primary" href="#routines/new">+ New routine</a></div>
    <p class="muted">Scheduled work. When a routine is due, it hands the team a task, as if you had. If the last task it created is still open, it skips that run instead of piling up duplicates. Times use this computer's clock, and routines only run while the office is running.</p>
    ${cards || '<p class="empty">No routines yet.</p>'}
    ${list.length < 3 ? templates : ''}`;
}

function viewRoutineForm(id) {
  const existing = id && id !== 'new' ? state.routines.find((r) => String(r.id) === String(id)) : null;
  if (id && id !== 'new' && !existing) throw new Error('That routine no longer exists.');
  const r = existing || pendingTemplate || { name: '', schedule: '0 9 * * 1-5', stages: state.stages, brief: '' };
  pendingTemplate = null;
  return `<a class="back" href="#routines">← Routines</a>
  <h2>${existing ? `Edit “${h(existing.name)}”` : 'New routine'}</h2>
  <form id="routineForm" class="form" data-id="${existing ? existing.id : ''}">
    <label>Name
      <input name="name" required maxlength="80" value="${h(r.name)}" placeholder="e.g. Competitor watch" autocomplete="off">
    </label>
    <label>Task title <span class="muted">(optional; use {date}, {time} or {weekday})</span>
      <input name="title" maxlength="140" value="${h(existing?.title || '')}" placeholder="Defaults to “Name · {date}”" autocomplete="off">
    </label>
    <label>What should the team do each time?
      <textarea name="brief" rows="4" placeholder="The brief the team gets every run...">${h(r.brief || '')}</textarea>
    </label>
    <fieldset><legend>Who works on it, in order</legend>${stagePicks(r.stages || state.stages)}</fieldset>
    <label class="check"><input type="checkbox" name="review" ${existing && !existing.review ? '' : 'checked'}> Pause for my review after each step</label>
    <fieldset><legend>When</legend>
      <div class="preset-chips">${PRESETS.map(([cron, label]) => `<button type="button" class="chip-btn" data-cron="${h(cron)}">${h(label)}</button>`).join('')}</div>
      <label>Schedule <span class="muted">(cron: minute hour day month weekday)</span>
        <input name="schedule" required value="${h(r.schedule)}" autocomplete="off" spellcheck="false" class="mono">
      </label>
      <p id="schedPreview" class="sched-preview muted" aria-live="polite"></p>
    </fieldset>
    <button class="btn primary" type="submit">${existing ? 'Save routine' : 'Create routine'}</button>
  </form>`;
}

let previewTimer;
function updateSchedulePreview() {
  const input = viewEl.querySelector('#routineForm input[name=schedule]');
  const out = viewEl.querySelector('#schedPreview');
  if (!input || !out) return;
  viewEl.querySelectorAll('.chip-btn').forEach((b) => b.classList.toggle('active', b.dataset.cron === input.value.trim()));
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      const p = await api(`/api/schedule/preview?cron=${encodeURIComponent(input.value)}`);
      out.classList.toggle('bad', !p.ok);
      out.textContent = p.ok
        ? `${p.description}. Next: ${p.next.map((d) => new Date(d).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })).join(' · ')}`
        : p.error;
    } catch (e) {
      out.textContent = e.message;
    }
  }, 200);
}

viewEl.addEventListener('input', (e) => {
  if (e.target.name === 'schedule') updateSchedulePreview();
});

// Keep "in 3 h" style times fresh on the routines list.
setInterval(() => {
  if (route().name === 'routines' && !route().id) render();
}, 30_000);

function viewNew(stage) {
  const pre = stage ? [stage] : state.stages;
  return `<h2>Hand out work</h2>
  <form id="newTask" class="form">
    <label>What should the team do?
      <input name="title" required maxlength="140" placeholder="e.g. Add a dark mode toggle to the settings page" autocomplete="off">
    </label>
    <label>Details <span class="muted">(optional)</span>
      <textarea name="brief" rows="5" placeholder="Context, constraints, links, what good looks like..."></textarea>
    </label>
    <fieldset><legend>Who works on it, in order</legend>
      ${stagePicks(pre)}
    </fieldset>
    <label class="check"><input type="checkbox" name="review" checked> Pause for my review after each step</label>
    <button class="btn primary" type="submit">Hand it to the team</button>
  </form>`;
}

async function viewTask(id) {
  let d = detailCache.get(Number(id));
  if (!d) {
    d = await api(`/api/tasks/${id}`);
    detailCache.set(Number(id), d);
  }
  const { task, outputs, activity, diff, parent, children } = d;
  const next = agentForStage(task.stages[task.stage_index + 1]);
  const actions = [];
  if (task.status === 'proposed') {
    actions.push(`<button class="btn primary" data-action="subtask-accept" data-id="${task.id}">Accept and start</button>`);
    actions.push(`<button class="btn" data-action="subtask-dismiss" data-id="${task.id}">Dismiss</button>`);
  }
  if (task.status === 'dismissed') actions.push(`<button class="btn" data-action="subtask-accept" data-id="${task.id}">Accept after all</button>`);
  if (task.status === 'review') {
    actions.push(`<button class="btn primary" data-action="approve">${next ? `Approve and hand to ${h(next.name)}` : 'Approve and finish'}</button>`);
    actions.push(`<details class="changes" data-key="changes"><summary class="btn">Request changes</summary>
      <textarea id="feedback" rows="3" placeholder="What should ${h(agentForStage(task.stage)?.name)} change?"></textarea>
      <button class="btn" data-action="changes">Send back</button></details>`);
  }
  if (task.status === 'failed' || task.status === 'cancelled') actions.push(`<button class="btn primary" data-action="retry">Retry</button>`);
  if (['queued', 'running', 'review', 'failed'].includes(task.status)) actions.push(`<button class="btn danger" data-action="cancel">Cancel task</button>`);

  const deliverables = task.stages
    .filter((s) => outputs[s])
    .reverse()
    .map((s, i) => {
      const a = agentForStage(s);
      const o = outputs[s];
      const mock = o.mockup ? `/api/tasks/${task.id}/files/${o.mockup}` : null;
      return `<details class="deliverable" data-key="out-${h(s)}" ${i === 0 ? 'open' : ''} style="--agent:${h(a?.color)}">
        <summary>${avatar(a, 1)} ${h(a?.name)}'s ${h(a?.title.toLowerCase())} handoff</summary>
        ${mock ? `<div class="mockup"><iframe src="${mock}" sandbox title="Design mockup"></iframe><a href="${mock}" target="_blank" rel="noopener">Open mockup in a new tab</a></div>` : ''}
        <div class="md">${renderMarkdown(o.markdown)}</div>
      </details>`;
    })
    .join('');

  return `<a class="back" href="#board">← Board</a>
  ${parent ? `<p class="lineage">↳ Sub-task of <a href="#task/${parent.id}">“${h(parent.title)}”</a>${agentById(task.proposed_by) ? `, proposed by ${h(agentById(task.proposed_by).name)}` : ''}</p>` : ''}
  <h2>${h(task.title)}</h2>
  <p><span class="status ${task.status}">${h(STATUS_LABEL[task.status])}</span> ${task.routine_id ? '<a class="muted" href="#routines">🔁 from a routine</a> · ' : ''}<span class="muted">Task #${task.id} · spent $${task.costUsd.toFixed(3)}</span></p>
  ${pipeline(task)}
  ${task.brief ? `<div class="brief">${renderMarkdown(task.brief)}</div>` : ''}
  ${task.error ? `<p class="error">${h(task.error)}</p>` : ''}
  ${actions.length ? `<div class="actions">${actions.join('')}</div>` : ''}
  ${children.length ? subtaskList(children) : ''}
  ${task.branch ? codeChanges(task, diff) : ''}
  ${deliverables || `<p class="empty">${task.status === 'proposed' ? 'Nothing runs until you accept it.' : 'No deliverables yet.'}</p>`}
  <h3>Activity</h3>
  <ul class="log">${activity
    .slice(-60)
    .reverse()
    .map((e) => logLine(e))
    .join('')}</ul>`;
}

function logLine(e) {
  const a = state.agents.find((x) => x.id === e.agent_id);
  const who = a && e.kind !== 'system' ? `<strong>${h(a.name)}</strong> ` : '';
  return `<li class="${h(e.kind)}" style="--agent:${h(a?.color || '#9aa0a6')}"><span class="dot"></span><span>${who}${h(e.text)}</span><time>${h(e.at.slice(11, 16))}</time></li>`;
}

async function viewAgent(id) {
  const d = await api(`/api/agents/${id}`);
  const a = state.agents.find((x) => x.id === id) || d.agent;
  const task = a.taskId ? state.tasks.get(a.taskId) : null;
  office.select(id);
  return `<a class="back" href="#board">← Board</a>
  <div class="agent-head" style="--agent:${h(a.color)}">
    ${avatar(a, 4)}
    <div><h2>${h(a.name)}</h2><p class="muted">${h(a.title)}</p>
      <p class="status-line ${a.status}">${a.status === 'working' ? '● Working' : '○ On a break'}</p></div>
  </div>
  ${task ? `<p>Now: <a href="#task/${task.id}">${h(task.title)}</a><br><span class="muted">${h(a.activity || '')}</span></p>` : ''}
  <div class="actions">
    <a class="btn primary" href="#new/${h(a.stage)}">Give ${h(a.name)} a task</a>
    ${a.status === 'working' ? `<button class="btn danger" data-action="stop" data-agent="${h(a.id)}">Stop this run</button>` : ''}
  </div>
  <h3>Allowed tools</h3>
  <p class="chips">${d.tools.map((t) => `<span class="chip">${h(t)}</span>`).join('')}</p>
  <p class="muted">${d.workspace === 'worktree' ? 'Works on its own git branch in a separate worktree, so your files are never touched.' : 'Reads your repo, never edits it. Its final message is the deliverable.'}
  Edit <code>.office/agents/${h(a.id)}.md</code> to change this agent's role, tools, or budget ($${h(a.maxBudgetUsd)} per run).</p>
  <h3>Recent activity</h3>
  <ul class="log">${d.activity.slice().reverse().map(logLine).join('') || '<li class="empty">Nothing yet.</li>'}</ul>`;
}

let renderSeq = 0;
async function render() {
  const r = route();
  const seq = ++renderSeq;
  if (r.name !== 'agent') office.select(null);
  document.querySelectorAll('.tabs a').forEach((t) => t.classList.toggle('active', t.getAttribute('href') === `#${r.name}`));
  const reviewCount = [...state.tasks.values()].filter((t) => t.status === 'review' || t.status === 'proposed').length;
  $('#inboxCount').textContent = reviewCount || '';
  if (r.name === 'new' && viewEl.querySelector('#newTask') && viewEl.dataset.route === location.hash) return; // don't wipe a half-typed form
  if (r.name === 'routines' && r.id && viewEl.querySelector('#routineForm') && viewEl.dataset.route === location.hash) return;
  // keep a half-typed feedback note across live refreshes
  const draft = viewEl.querySelector('#feedback')?.value;
  const draftOpen = viewEl.querySelector('details.changes')?.open;
  let html;
  try {
    if (r.name === 'task') html = await viewTask(r.id);
    else if (r.name === 'agent') html = await viewAgent(r.id);
    else if (r.name === 'inbox') html = viewInbox();
    else if (r.name === 'new') html = viewNew(r.id);
    else if (r.name === 'routines') html = r.id ? viewRoutineForm(r.id) : viewRoutines();
    else html = viewBoard();
  } catch (e) {
    html = `<a class="back" href="#board">← Board</a><p class="error">${h(e.message)}</p>`;
  }
  if (seq !== renderSeq) return;
  const openStates = new Map([...viewEl.querySelectorAll('details[data-key]')].map((d) => [d.dataset.key, d.open]));
  const sameView = viewEl.dataset.route === location.hash;
  viewEl.innerHTML = html;
  viewEl.dataset.route = location.hash;
  if (viewEl.querySelector('#routineForm')) updateSchedulePreview();
  if (draft !== undefined && viewEl.querySelector('#feedback')) {
    viewEl.querySelector('#feedback').value = draft;
    if (draftOpen) viewEl.querySelector('details.changes').open = true;
  }
  if (sameView) {
    viewEl.querySelectorAll('details[data-key]').forEach((d) => {
      if (openStates.has(d.dataset.key)) d.open = openStates.get(d.dataset.key);
    });
  }
  const reviews = [...state.tasks.values()].filter((t) => t.status === 'review' || t.status === 'proposed').length;
  document.title = `${reviews ? `(${reviews}) ` : ''}Agent Office${state.project.name ? ` · ${state.project.name}` : ''}`;
}

// ---------- delegation ----------

function subtaskList(children) {
  const pending = children.filter((c) => c.status === 'proposed');
  const visible = children.filter((c) => c.status !== 'dismissed');
  const dismissed = children.length - visible.length;
  return `<section class="subtasks">
    <div class="view-head"><h3>Sub-tasks</h3>${pending.length > 1 ? `<button class="btn" data-action="subtask-accept-all">Accept all ${pending.length}</button>` : ''}</div>
    ${pending.length ? `<p class="muted">Your team proposed these. Nothing starts until you accept it.</p>` : ''}
    <ul class="subtask-list">${visible
      .map((c) => {
        const who = agentById(c.proposed_by);
        return `<li class="${c.status}" style="--agent:${h(who?.color || '#9aa0a6')}">
          <div><a href="#task/${c.id}">${h(c.title)}</a> <span class="status ${c.status}">${h(STATUS_LABEL[c.status] || c.status)}</span>
            <br><small class="muted">${c.stages.map((s) => h(agentForStage(s)?.name || s)).join(' → ')}${c.brief ? ` · ${h(c.brief.slice(0, 140))}${c.brief.length > 140 ? '…' : ''}` : ''}</small></div>
          ${c.status === 'proposed' ? `<div class="subtask-actions"><button class="btn primary" data-action="subtask-accept" data-id="${c.id}">Accept</button><button class="btn" data-action="subtask-dismiss" data-id="${c.id}">Dismiss</button></div>` : ''}
        </li>`;
      })
      .join('')}</ul>
    ${dismissed ? `<p class="muted small">${dismissed} dismissed or replaced proposal(s) hidden.</p>` : ''}
  </section>`;
}

// ---------- code review ----------

function codeChanges(task, diff) {
  const summary = diff?.stat ? diff.stat.trim().split('\n').pop() : '';
  const base = state.project.branch || 'main';
  return `<section class="code-review">
    <h3>Code changes</h3>
    <p>Branch <code>${h(task.branch)}</code>${summary ? ` <span class="muted">· ${h(summary.trim())}</span>` : ''}</p>
    ${diff?.patch ? renderDiff(diff.patch) : '<p class="empty">No code changes on this branch yet.</p>'}
    ${diff?.truncated ? '<p class="muted">The diff is large, so only the beginning is shown here. Use git to see the rest.</p>' : ''}
    <p class="muted">Happy with it? Merge it from your repo (the agent never merges or pushes):</p>
    <pre>git diff ${h(base)}...${h(task.branch)}\ngit merge ${h(task.branch)}</pre>
  </section>`;
}

function renderDiff(patch) {
  return patch
    .split(/^(?=diff --git )/m)
    .filter((chunk) => chunk.startsWith('diff --git'))
    .map((chunk) => {
      const lines = chunk.replace(/\n$/, '').split('\n');
      const file = (lines[0].match(/ b\/(.+)$/) || [])[1] || lines[0];
      let adds = 0;
      let dels = 0;
      const body = lines
        .filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to))/.test(l))
        .map((l) => {
          let cls = '';
          if (l.startsWith('@@')) cls = 'hunk';
          else if (l.startsWith('+')) (cls = 'add'), adds++;
          else if (l.startsWith('-')) (cls = 'del'), dels++;
          return `<span class="${cls}">${h(l) || ' '}</span>`;
        })
        .join(''); // spans are display:block, so no newline between them
      return `<details class="file" data-key="file-${h(file)}">
        <summary><code>${h(file)}</code> <span class="adds">+${adds}</span> <span class="dels">−${dels}</span></summary>
        <pre class="diff">${body}</pre>
      </details>`;
    })
    .join('');
}

// ---------- notifications ----------

const NOTIFY_KEY = 'agent-office:notify';
function notifyEnabled() {
  try {
    return localStorage.getItem(NOTIFY_KEY) === 'on' && 'Notification' in window && Notification.permission === 'granted';
  } catch {
    return false;
  }
}

function renderNotifyButton() {
  const b = $('#notifyBtn');
  if (!('Notification' in window)) {
    b.hidden = true;
    return;
  }
  const on = notifyEnabled();
  b.textContent = on ? '🔔 On' : '🔕 Notify me';
  b.title = on ? 'You get a desktop notification when work needs you' : 'Get a desktop notification when work needs your review';
  b.setAttribute('aria-pressed', String(on));
}

$('#notifyBtn').addEventListener('click', async () => {
  try {
    if (notifyEnabled()) localStorage.setItem(NOTIFY_KEY, 'off');
    else if ((await Notification.requestPermission()) === 'granted') localStorage.setItem(NOTIFY_KEY, 'on');
    else toast('Notifications are blocked in your browser settings.');
  } catch {
    toast('Notifications are not available here.');
  }
  renderNotifyButton();
});

const NOTIFY_TEXT = {
  review: (t) => `${agentForStage(t.stage)?.name ?? 'An agent'} finished “${t.title}”. Your review is needed.`,
  failed: (t) => `“${t.title}” failed: ${t.error || 'see the task for details'}`,
  done: (t) => `“${t.title}” is done.`,
  proposed: (t) => `${agentById(t.proposed_by)?.name ?? 'An agent'} proposed a sub-task: “${t.title}”`,
};

function maybeNotify(prev, task) {
  if (prev?.status === task.status || !NOTIFY_TEXT[task.status]) return;
  if (!prev && task.status !== 'proposed') return; // brand-new tasks are only news if an agent proposed them
  if (!notifyEnabled() || !document.hidden) return;
  const n = new Notification(`Agent Office · ${state.project.name || ''}`, { body: NOTIFY_TEXT[task.status](task), tag: `task-${task.id}` });
  n.onclick = () => {
    window.focus();
    go(`task/${task.id}`);
    n.close();
  };
}
renderNotifyButton();

// ---------- actions ----------

viewEl.addEventListener('submit', async (e) => {
  if (e.target.id !== 'routineForm') return;
  e.preventDefault();
  const f = new FormData(e.target);
  const stages = f.getAll('stages');
  if (!stages.length) return toast('Pick at least one teammate.');
  const body = { name: f.get('name'), title: f.get('title'), brief: f.get('brief'), stages, review: f.get('review') === 'on', schedule: f.get('schedule') };
  const id = e.target.dataset.id;
  try {
    await api(id ? `/api/routines/${id}` : '/api/routines', body);
    go('routines');
  } catch (err) {
    toast(err.message);
  }
});

viewEl.addEventListener('submit', async (e) => {
  if (e.target.id !== 'newTask') return;
  e.preventDefault();
  const f = new FormData(e.target);
  const stages = f.getAll('stages');
  if (!stages.length) return toast('Pick at least one teammate.');
  try {
    const task = await api('/api/tasks', { title: f.get('title'), brief: f.get('brief'), stages, review: f.get('review') === 'on' });
    go(`task/${task.id}`);
  } catch (err) {
    toast(err.message);
  }
});

viewEl.addEventListener('click', async (e) => {
  const chip = e.target.closest('.chip-btn');
  if (chip) {
    viewEl.querySelector('#routineForm input[name=schedule]').value = chip.dataset.cron;
    updateSchedulePreview();
    return;
  }
  const b = e.target.closest('[data-action]');
  if (!b) return;
  if (b.dataset.action.startsWith('subtask-')) {
    try {
      if (b.dataset.action === 'subtask-accept') await api(`/api/tasks/${b.dataset.id}/accept`, {});
      if (b.dataset.action === 'subtask-dismiss') await api(`/api/tasks/${b.dataset.id}/dismiss`, {});
      if (b.dataset.action === 'subtask-accept-all') {
        const r = await api(`/api/tasks/${route().id}/accept-subtasks`, {});
        toast(`Started ${r.accepted} sub-task(s)`);
      }
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (b.dataset.action.startsWith('routine-')) {
    const rid = b.dataset.id;
    try {
      if (b.dataset.action === 'routine-run') {
        const r = await api(`/api/routines/${rid}/run`, {});
        toast(`Created task #${r.last_task_id}`);
      }
      if (b.dataset.action === 'routine-toggle') await api(`/api/routines/${rid}`, { enabled: b.dataset.enabled !== 'true' });
      if (b.dataset.action === 'routine-remove' && confirm('Remove this routine? Tasks it already created stay.')) await api(`/api/routines/${rid}/remove`, {});
      if (b.dataset.action === 'routine-template') {
        pendingTemplate = TEMPLATES[Number(b.dataset.index)];
        go('routines/new');
      }
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  const id = route().id;
  try {
    if (b.dataset.action === 'approve') await api(`/api/tasks/${id}/approve`, {});
    if (b.dataset.action === 'retry') await api(`/api/tasks/${id}/retry`, {});
    if (b.dataset.action === 'cancel' && confirm('Cancel this task?')) await api(`/api/tasks/${id}/cancel`, {});
    if (b.dataset.action === 'changes') {
      const feedback = viewEl.querySelector('#feedback').value;
      await api(`/api/tasks/${id}/changes`, { feedback });
      viewEl.querySelector('#feedback').value = '';
    }
    if (b.dataset.action === 'stop') await api(`/api/agents/${b.dataset.agent}/stop`, {});
  } catch (err) {
    toast(err.message);
  }
});

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

connect();
