// Dashboard app: keeps a local copy of server state (from SSE), renders the side panel,
// and feeds the 2D office. All changes go through the API; the UI only reacts to events.

import { createOffice } from './office.js';
import { drawCharacter } from './sprites.js';
import { renderMarkdown, escapeHtml as h } from './markdown.js';

const state = { project: {}, adapter: '', office: {}, agents: [], stages: [], tasks: new Map() };
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
      invalidate(evt.task.id);
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

const STATUS_LABEL = { queued: 'Queued', running: 'Working', review: 'Needs your review', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };

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
  return `<a class="card" href="#task/${task.id}" style="--agent:${h(a?.color || '#999')}">
    <span class="card-title">${h(task.title)}</span>
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
    group('Needs you', all.filter((t) => t.status === 'review' || t.status === 'failed'), 'Nothing waiting for you.'),
    group('Queued', all.filter((t) => t.status === 'queued'), 'The queue is empty.'),
    group('Finished', all.filter((t) => t.status === 'done' || t.status === 'cancelled').slice(0, 12), 'Nothing finished yet.'),
  ].join('');
}

function viewInbox() {
  const list = [...state.tasks.values()].filter((t) => t.status === 'review' || t.status === 'failed');
  return `<h2>Your inbox</h2><p class="muted">Work lands here when an agent finishes a step. Approve it to hand it to the next teammate, or ask for changes.</p>
    ${list.length ? list.map(card).join('') : '<p class="empty">Inbox zero. Nice.</p>'}`;
}

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
      <div class="stage-picks">${state.stages
        .map((s) => {
          const a = agentForStage(s);
          return `<label class="pick" style="--agent:${h(a.color)}"><input type="checkbox" name="stages" value="${h(s)}" ${pre.includes(s) ? 'checked' : ''}>
            ${avatar(a, 2)}<span><strong>${h(a.name)}</strong><br><small>${h(a.title)}</small></span></label>`;
        })
        .join('')}</div>
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
  const { task, outputs, activity, diffStat } = d;
  const next = agentForStage(task.stages[task.stage_index + 1]);
  const actions = [];
  if (task.status === 'review') {
    actions.push(`<button class="btn primary" data-action="approve">${next ? `Approve and hand to ${h(next.name)}` : 'Approve and finish'}</button>`);
    actions.push(`<details class="changes"><summary class="btn">Request changes</summary>
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
      return `<details class="deliverable" ${i === 0 ? 'open' : ''} style="--agent:${h(a?.color)}">
        <summary>${avatar(a, 1)} ${h(a?.name)}'s ${h(a?.title.toLowerCase())} handoff</summary>
        ${mock ? `<div class="mockup"><iframe src="${mock}" sandbox title="Design mockup"></iframe><a href="${mock}" target="_blank" rel="noopener">Open mockup in a new tab</a></div>` : ''}
        <div class="md">${renderMarkdown(o.markdown)}</div>
      </details>`;
    })
    .join('');

  return `<a class="back" href="#board">← Board</a>
  <h2>${h(task.title)}</h2>
  <p><span class="status ${task.status}">${h(STATUS_LABEL[task.status])}</span> <span class="muted">Task #${task.id} · spent $${task.costUsd.toFixed(3)}</span></p>
  ${pipeline(task)}
  ${task.brief ? `<div class="brief">${renderMarkdown(task.brief)}</div>` : ''}
  ${task.error ? `<p class="error">${h(task.error)}</p>` : ''}
  ${actions.length ? `<div class="actions">${actions.join('')}</div>` : ''}
  ${task.branch ? `<div class="branch"><strong>Code is on branch <code>${h(task.branch)}</code></strong>
     ${diffStat ? `<pre>${h(diffStat)}</pre>` : ''}
     <p class="muted">Review and merge it yourself, from your repo:</p>
     <pre>git diff ${h(state.project.branch || 'main')}...${h(task.branch)}\ngit merge ${h(task.branch)}</pre></div>` : ''}
  ${deliverables || '<p class="empty">No deliverables yet.</p>'}
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
  const reviewCount = [...state.tasks.values()].filter((t) => t.status === 'review').length;
  $('#inboxCount').textContent = reviewCount || '';
  if (r.name === 'new' && viewEl.querySelector('#newTask') && viewEl.dataset.route === location.hash) return; // don't wipe a half-typed form
  // keep a half-typed feedback note across live refreshes
  const draft = viewEl.querySelector('#feedback')?.value;
  const draftOpen = viewEl.querySelector('details.changes')?.open;
  let html;
  try {
    if (r.name === 'task') html = await viewTask(r.id);
    else if (r.name === 'agent') html = await viewAgent(r.id);
    else if (r.name === 'inbox') html = viewInbox();
    else if (r.name === 'new') html = viewNew(r.id);
    else html = viewBoard();
  } catch (e) {
    html = `<a class="back" href="#board">← Board</a><p class="error">${h(e.message)}</p>`;
  }
  if (seq !== renderSeq) return;
  const openStates = [...viewEl.querySelectorAll('details.deliverable')].map((d) => d.open);
  viewEl.innerHTML = html;
  viewEl.dataset.route = location.hash;
  if (draft !== undefined && viewEl.querySelector('#feedback')) {
    viewEl.querySelector('#feedback').value = draft;
    if (draftOpen) viewEl.querySelector('details.changes').open = true;
  }
  const newDetails = viewEl.querySelectorAll('details.deliverable');
  if (openStates.length === newDetails.length) newDetails.forEach((d, i) => (d.open = openStates[i]));
}

// ---------- actions ----------

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
  const b = e.target.closest('[data-action]');
  if (!b) return;
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
