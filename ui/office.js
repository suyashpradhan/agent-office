// The 2D office: a canvas world that animates the orchestrator's state.
//
// Server events drive "intentions" here:
//   run started   -> agent walks to the whiteboard, grabs the sticky note, sits at its desk
//   activity      -> speech bubble shows what it's doing (e.g. "Searching ...")
//   run finished  -> agent walks the deliverable to your inbox tray (or hands it off)
//   idle          -> agent wanders: couch, coffee, arcade, bookshelf...
//
// Rendering is pure rectangles at 480x272 logical pixels, scaled up crisply.

import { drawCharacter, shade } from './sprites.js';

export const W = 480;
export const H = 272;
const WALL = 58;
const CELL = 8;
const COLS = W / CELL;
const ROWS = H / CELL;
const SPEED = 56; // px per second

const BOARD = { x: 178, y: 8, w: 124, h: 40 };
const DOOR = { x: 424, y: 14, w: 34, h: 44 };
const TRAY = { x: 200, y: 219, w: 22, h: 8 };
const MANAGER_DESK = { x: 192, y: 226, w: 96, h: 24 };
const COUNTER = { x: 410, y: 126, w: 62, h: 36 };
const ARCADE = { x: 432, y: 190, w: 28, h: 44 };
const COUCH = { x: 20, y: 148, w: 96, h: 30 };
const SHELF = { x: 6, y: 18, w: 30, h: 58 };
const BOARD_SPOT = { x: 236, y: 68 };

const POIS = [
  { id: 'couch-a', at: { x: 52, y: 188 }, sit: { x: 52, y: 171 }, pose: 'couch', emotes: ['💬', '😌', '📱', '💤'] },
  { id: 'couch-b', at: { x: 88, y: 188 }, sit: { x: 88, y: 171 }, pose: 'couch', emotes: ['📱', '😌', '🍪'] },
  { id: 'coffee', at: { x: 436, y: 172 }, dir: 'up', emotes: ['☕', '☕', '🫖'] },
  { id: 'arcade', at: { x: 446, y: 246 }, dir: 'up', emotes: ['🎮', '🕹️', '🏆'] },
  { id: 'shelf', at: { x: 22, y: 92 }, dir: 'up', emotes: ['📖', '🤔'] },
  { id: 'rug-a', at: { x: 188, y: 182 }, dir: 'down', emotes: ['♪', '🙆'] },
  { id: 'rug-b', at: { x: 296, y: 190 }, dir: 'left', emotes: ['💭', '♪'] },
  { id: 'rug-c', at: { x: 244, y: 196 }, dir: 'down', emotes: ['🙌', '🎵'] },
  { id: 'window', at: { x: 170, y: 132 }, dir: 'up', emotes: ['☁️', '🌤️'] },
];

export function createOffice({ canvas, overlay, onSelect, onHint }) {
  const ctx = canvas.getContext('2d');
  const agents = new Map(); // id -> entity
  let desks = [];
  let tasks = [];
  let paused = false;
  let selected = null;
  let hovered = null;
  let papers = [];
  let confetti = [];
  let blocked = null;
  let t = 0;
  let last = performance.now();
  let agentOrder = [];
  const reserved = new Map(); // poi id -> agent id

  const hint = el('div', 'hint-label');
  overlay.append(hint);
  const CLOCK = { x: 64, y: 18 };
  const clockBadge = el('div', 'clock-badge');
  clockBadge.style.left = pct(CLOCK.x + 9, W);
  clockBadge.style.top = pct(CLOCK.y - 7, H);
  overlay.append(clockBadge);
  const trayBadge = el('div', 'tray-badge');
  trayBadge.style.left = pct(TRAY.x + TRAY.w / 2, W);
  trayBadge.style.top = pct(TRAY.y - 4, H);
  overlay.append(trayBadge);

  // ---------- public API ----------

  function setAgents(list) {
    if (!desks.length || list.length !== agentOrder.length) buildDesks(list);
    list.forEach((a, index) => {
      let e = agents.get(a.id);
      if (!e) {
        const poi = POIS[(index * 3) % POIS.length];
        e = {
          id: a.id,
          look: { color: a.color, hair: a.hair, skin: a.skin, accessory: a.accessory, index },
          x: poi.at.x,
          y: poi.at.y,
          dir: 'down',
          pose: 'stand',
          moving: false,
          frame: 0,
          frameT: 0,
          path: [],
          plan: [],
          cur: null,
          blinkUntil: 0,
          nextBlink: 1000 + Math.random() * 3000,
          desk: desks[index],
          server: {},
          bubble: makeBubble(a),
          sayUntil: 0,
          emote: null,
          emoteUntil: 0,
          poi: null,
        };
        agents.set(a.id, e);
        if (a.status === 'working') {
          // page loaded mid-run: put them straight at their desk
          e.x = e.desk.seat.x;
          e.y = e.desk.seat.y;
          e.plan = [{ type: 'work' }];
        }
      }
      e.name = a.name;
      e.title = a.title;
      const prevActivity = e.server.activity;
      e.server = { ...a };
      if (a.activity && a.activity !== prevActivity && a.status === 'working') {
        e.sayUntil = t + 7000;
      }
    });
  }

  function setTasks(list) {
    tasks = list;
    const n = tasks.filter((x) => x.status === 'review').length;
    trayBadge.textContent = n ? String(n) : '';
    trayBadge.classList.toggle('show', n > 0);
  }

  // A small badge on the wall clock shows how many routines are active.
  function setRoutines(list) {
    const n = list.filter((r) => r.enabled).length;
    clockBadge.textContent = n ? `🔁${n}` : '';
    clockBadge.classList.toggle('show', n > 0);
  }

  function setPaused(value) {
    paused = value;
  }

  function select(id) {
    selected = id;
  }

  function runEvent(evt) {
    const e = agents.get(evt.agentId);
    if (!e) return;
    releasePoi(e);
    if (evt.phase === 'started') {
      e.plan = [
        { type: 'go', to: BOARD_SPOT },
        { type: 'wait', ms: 700, dir: 'up', emote: '📋' },
        { type: 'go', to: e.desk.seat },
        { type: 'work' },
      ];
      e.cur = null;
      return;
    }
    const task = tasks.find((x) => x.id === evt.taskId);
    if (!evt.ok) {
      e.plan = [{ type: 'wait', ms: 2200, emote: '💥', say: evt.error || 'Something went wrong', dir: 'down' }];
    } else if (task && task.status === 'review') {
      const i = agentOrder.indexOf(e.id);
      const spot = { x: 236 + (i % 3) * 22, y: 212 };
      e.plan = [
        { type: 'go', to: spot },
        { type: 'wait', ms: 500, dir: 'down' },
        { type: 'call', fn: () => flyPaper({ x: e.x, y: e.y - 12 }, { x: TRAY.x + 11, y: TRAY.y + 2 }, e.look.color) },
        { type: 'wait', ms: 1100, emote: '✅', dir: 'down' },
      ];
    } else {
      flyPaper({ x: e.desk.cx, y: 70 }, { x: BOARD.x + BOARD.w / 2, y: BOARD.y + 20 }, e.look.color);
      e.plan = [{ type: 'wait', ms: 1200, emote: '✅', dir: 'up', pose: 'desk' }];
    }
    e.cur = null;
  }

  function taskCreated() {
    flyPaper({ x: DOOR.x + 17, y: DOOR.y + 30 }, { x: BOARD.x + 20, y: BOARD.y + 20 }, '#ffd65a');
  }

  function approvedHandoff() {
    flyPaper({ x: TRAY.x + 11, y: TRAY.y }, { x: BOARD.x + BOARD.w / 2, y: BOARD.y + 20 }, '#ffd65a');
  }

  function celebrate() {
    for (let i = 0; i < 40; i++) {
      confetti.push({
        x: MANAGER_DESK.x + MANAGER_DESK.w / 2,
        y: MANAGER_DESK.y,
        vx: (Math.random() - 0.5) * 120,
        vy: -60 - Math.random() * 90,
        color: ['#ff6b6b', '#ffd65a', '#4c8bf5', '#2fae6e', '#e0569b'][i % 5],
        life: 1600 + Math.random() * 800,
      });
    }
  }

  // ---------- layout ----------

  function buildDesks(list) {
    agentOrder = list.map((a) => a.id);
    const n = list.length;
    desks = list.map((a, i) => {
      const cx = Math.round((W * (i + 1)) / (n + 1));
      return {
        cx,
        agentId: a.id,
        stage: a.stage,
        index: i,
        color: a.color,
        rect: { x: cx - 38, y: 78, w: 76, h: 28 },
        seat: { x: cx, y: 124 },
      };
    });
    for (const e of agents.values()) e.desk = desks[agentOrder.indexOf(e.id)] ?? desks[0];
    overlay.querySelectorAll('.nameplate').forEach((n) => n.remove());
    const you = el('div', 'nameplate you');
    you.textContent = 'You';
    you.style.left = pct(MANAGER_DESK.x + MANAGER_DESK.w / 2, W);
    you.style.top = pct(MANAGER_DESK.y + 17, H);
    you.style.setProperty('--agent', '#5b4636');
    overlay.append(you);
    for (const d of desks) {
      const a = list[d.index];
      const plate = el('div', 'nameplate');
      plate.textContent = a.name;
      plate.style.left = pct(d.cx, W);
      plate.style.top = pct(99, H);
      plate.style.setProperty('--agent', a.color);
      overlay.append(plate);
    }
    blocked = buildGrid();
  }

  function collisionRects() {
    return [
      ...desks.map((d) => d.rect),
      { x: SHELF.x, y: 56, w: SHELF.w, h: 22 },
      COUCH,
      COUNTER,
      { x: ARCADE.x, y: 212, w: ARCADE.w, h: 22 },
      MANAGER_DESK,
      { x: 230, y: 254, w: 20, h: 14 },
      { x: 4, y: 238, w: 18, h: 16 },
      { x: 458, y: 98, w: 18, h: 14 },
    ];
  }

  function buildGrid() {
    const grid = new Uint8Array(COLS * ROWS);
    const rects = collisionRects();
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const x = c * CELL + CELL / 2;
        const y = r * CELL + CELL / 2;
        let b = y < WALL + 2 || x < 4 || x > W - 4 || y > H - 6;
        for (const rc of rects) if (x >= rc.x && x <= rc.x + rc.w && y >= rc.y && y <= rc.y + rc.h) b = true;
        grid[r * COLS + c] = b ? 1 : 0;
      }
    }
    return grid;
  }

  // ---------- pathfinding (A* on an 8px grid) ----------

  function findPath(from, to) {
    const cellOf = (p) => [Math.max(0, Math.min(COLS - 1, Math.floor(p.x / CELL))), Math.max(0, Math.min(ROWS - 1, Math.floor(p.y / CELL)))];
    const free = (c, r) => c >= 0 && r >= 0 && c < COLS && r < ROWS && !blocked[r * COLS + c];
    let [sc, sr] = cellOf(from);
    let [gc, gr] = cellOf(to);
    const nearestFree = (c0, r0) => {
      for (let rad = 0; rad < 10; rad++)
        for (let dc = -rad; dc <= rad; dc++)
          for (let dr = -rad; dr <= rad; dr++) if (free(c0 + dc, r0 + dr)) return [c0 + dc, r0 + dr];
      return [c0, r0];
    };
    if (!free(sc, sr)) [sc, sr] = nearestFree(sc, sr);
    if (!free(gc, gr)) [gc, gr] = nearestFree(gc, gr);
    const key = (c, r) => r * COLS + c;
    const open = [[sc, sr]];
    const g = new Map([[key(sc, sr), 0]]);
    const came = new Map();
    const h = (c, r) => Math.hypot(c - gc, r - gr);
    const fScore = new Map([[key(sc, sr), h(sc, sr)]]);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    let guard = 0;
    while (open.length && guard++ < 4000) {
      open.sort((a, b) => fScore.get(key(...a)) - fScore.get(key(...b)));
      const [c, r] = open.shift();
      if (c === gc && r === gr) {
        const out = [];
        let k = key(c, r);
        while (came.has(k)) {
          out.unshift({ x: (k % COLS) * CELL + CELL / 2, y: Math.floor(k / COLS) * CELL + CELL / 2 });
          k = came.get(k);
        }
        out.push({ x: to.x, y: to.y });
        return out;
      }
      for (const [dc, dr] of dirs) {
        const nc = c + dc;
        const nr = r + dr;
        if (!free(nc, nr)) continue;
        if (dc && dr && (!free(c + dc, r) || !free(c, r + dr))) continue; // no corner cutting
        const tentative = g.get(key(c, r)) + (dc && dr ? 1.414 : 1);
        const nk = key(nc, nr);
        if (tentative < (g.get(nk) ?? Infinity)) {
          came.set(nk, key(c, r));
          g.set(nk, tentative);
          fScore.set(nk, tentative + h(nc, nr));
          if (!open.some(([oc, or]) => oc === nc && or === nr)) open.push([nc, nr]);
        }
      }
    }
    return [{ x: to.x, y: to.y }];
  }

  // ---------- behaviour ----------

  function planWander(e) {
    releasePoi(e);
    const options = POIS.filter((p) => !reserved.has(p.id));
    const poi = options[Math.floor(Math.random() * options.length)] ?? POIS[0];
    reserved.set(poi.id, e.id);
    e.poi = poi.id;
    const stay = 4000 + Math.random() * 6000;
    const emote = poi.emotes[Math.floor(Math.random() * poi.emotes.length)];
    e.plan = [{ type: 'go', to: poi.at }];
    if (poi.sit) {
      e.plan.push({ type: 'call', fn: () => Object.assign(e, { x: poi.sit.x, y: poi.sit.y, pose: 'couch', dir: 'down' }) });
      e.plan.push({ type: 'wait', ms: stay, pose: 'couch', dir: 'down', emote, emoteDelay: stay * 0.3 });
      e.plan.push({ type: 'call', fn: () => Object.assign(e, { x: poi.at.x, y: poi.at.y, pose: 'stand' }) });
    } else {
      e.plan.push({ type: 'wait', ms: stay, dir: poi.dir, emote, emoteDelay: stay * 0.3 });
    }
  }

  function releasePoi(e) {
    if (e.poi && reserved.get(e.poi) === e.id) reserved.delete(e.poi);
    e.poi = null;
    if (e.pose === 'couch') {
      const poi = POIS.find((p) => p.sit && Math.abs(p.sit.x - e.x) < 2 && Math.abs(p.sit.y - e.y) < 2);
      if (poi) Object.assign(e, { x: poi.at.x, y: poi.at.y });
      e.pose = 'stand';
    }
  }

  function sendTo(poiId) {
    const poi = POIS.find((p) => p.id === poiId);
    const idle = [...agents.values()].filter((e) => e.server.status !== 'working' && e.cur?.type !== 'go');
    if (!poi || !idle.length) return false;
    idle.sort((a, b) => Math.hypot(a.x - poi.at.x, a.y - poi.at.y) - Math.hypot(b.x - poi.at.x, b.y - poi.at.y));
    const e = idle[0];
    releasePoi(e);
    const holder = reserved.get(poi.id);
    if (holder && holder !== e.id) {
      const other = agents.get(holder);
      if (other) {
        releasePoi(other);
        other.plan = [];
        other.cur = null;
      }
    }
    reserved.set(poi.id, e.id);
    e.poi = poi.id;
    e.plan = [{ type: 'go', to: poi.at }, { type: 'wait', ms: 4000, dir: poi.dir || 'down', emote: poi.emotes[0], emoteDelay: 300 }];
    e.cur = null;
    return true;
  }

  function update(dt) {
    for (const e of agents.values()) {
      // blinking
      if (t > e.nextBlink) {
        e.blinkUntil = t + 130;
        e.nextBlink = t + 2000 + Math.random() * 3500;
      }
      if (!e.cur) {
        if (!e.plan.length) {
          if (e.server.status === 'working') e.plan = [{ type: 'go', to: e.desk.seat }, { type: 'work' }];
          else planWander(e);
        }
        e.cur = { ...e.plan.shift(), elapsed: 0 };
        if (e.cur.type === 'go') {
          if (e.pose === 'couch') releasePoi(e);
          e.pose = 'stand';
          e.path = findPath(e, e.cur.to);
        }
        if (e.cur.type === 'call') {
          e.cur.fn();
          e.cur = null;
          continue;
        }
      }
      const c = e.cur;
      c.elapsed += dt;
      e.moving = false;
      if (c.type === 'go') {
        const target = e.path[0];
        if (!target) {
          e.cur = null;
          continue;
        }
        const dx = target.x - e.x;
        const dy = target.y - e.y;
        const dist = Math.hypot(dx, dy);
        const step = (SPEED * dt) / 1000;
        if (dist <= step) {
          e.x = target.x;
          e.y = target.y;
          e.path.shift();
        } else {
          e.x += (dx / dist) * step;
          e.y += (dy / dist) * step;
        }
        e.moving = true;
        if (Math.abs(dx) > Math.abs(dy)) e.dir = dx < 0 ? 'left' : 'right';
        else if (dist > 0.01) e.dir = dy < 0 ? 'up' : 'down';
      } else if (c.type === 'wait') {
        if (c.pose) e.pose = c.pose;
        if (c.dir) e.dir = c.dir;
        if (c.emote && !c.emoted && c.elapsed >= (c.emoteDelay || 0)) {
          c.emoted = true;
          e.emote = c.emote;
          e.emoteUntil = t + Math.min(2600, c.ms);
        }
        if (c.say && !c.said) {
          c.said = true;
          e.alert = c.say;
          e.alertUntil = t + c.ms;
        }
        if (c.elapsed >= c.ms) e.cur = null;
      } else if (c.type === 'work') {
        e.x = e.desk.seat.x;
        e.y = e.desk.seat.y;
        e.pose = 'desk';
        e.dir = 'up';
        if (e.server.status !== 'working') {
          e.pose = 'stand';
          e.cur = null;
        }
      }
      if (e.moving) {
        e.frameT += dt;
        if (e.frameT > 130) {
          e.frameT = 0;
          e.frame = (e.frame + 1) % 4;
        }
      } else e.frame = 0;
    }

    papers = papers.filter((p) => {
      p.t += dt / p.dur;
      return p.t < 1;
    });
    confetti = confetti.filter((p) => {
      p.vy += (220 * dt) / 1000;
      p.x += (p.vx * dt) / 1000;
      p.y += (p.vy * dt) / 1000;
      p.life -= dt;
      return p.life > 0;
    });
  }

  function flyPaper(from, to, color) {
    papers.push({ from, to, color, t: 0, dur: 900 });
  }

  // ---------- drawing ----------

  function draw() {
    ctx.clearRect(0, 0, W, H);
    drawRoom();
    const items = [];
    items.push({ z: 76, draw: drawShelf });
    for (const d of desks) {
      items.push({ z: 106, draw: () => drawDesk(d) });
      items.push({ z: 128, draw: () => drawChair(d) });
    }
    items.push({ z: 160, draw: drawCouchBack });
    items.push({ z: 178, draw: drawCouchFront });
    items.push({ z: 162, draw: drawCounter });
    items.push({ z: 234, draw: drawArcade });
    items.push({ z: 250, draw: drawManagerDesk });
    items.push({ z: 268, draw: drawManagerChair });
    items.push({ z: 252, draw: () => drawPlant(12, 252) });
    items.push({ z: 112, draw: () => drawPlant(467, 112) });
    for (const e of agents.values()) {
      items.push({
        z: e.pose === 'couch' ? 172 : e.y,
        draw: () => {
          if (selected === e.id) {
            ctx.fillStyle = shade(e.look.color, 0.35);
            const yy = Math.round(e.y) + (e.pose === 'desk' ? 2 : 0);
            ctx.fillRect(Math.round(e.x) - 9, yy - 1, 18, 3);
            ctx.fillRect(Math.round(e.x) - 7, yy - 2, 14, 5);
          }
          drawCharacter(ctx, e.look, { ...e, blink: t < e.blinkUntil, t });
        },
      });
    }
    items.sort((a, b) => a.z - b.z).forEach((i) => i.draw());

    for (const p of papers) {
      const k = easeInOut(p.t);
      const x = p.from.x + (p.to.x - p.from.x) * k;
      const y = p.from.y + (p.to.y - p.from.y) * k - Math.sin(Math.PI * k) * 26;
      px(x - 3, y - 4, 7, 8, '#ffffff');
      px(x - 2, y - 2, 5, 1, p.color);
      px(x - 2, y, 4, 1, '#b8bcc6');
      px(x - 2, y + 2, 5, 1, '#b8bcc6');
    }
    for (const p of confetti) px(p.x, p.y, 2, 2, p.color);

    if (paused) {
      ctx.fillStyle = 'rgba(16, 18, 40, 0.45)';
      ctx.fillRect(0, 0, W, H);
    }
    updateOverlay();
  }

  function px(x, y, w, h, c) {
    ctx.fillStyle = c;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  }

  function drawRoom() {
    // wall
    px(0, 0, W, WALL, '#eadfca');
    for (let x = 0; x < W; x += 20) px(x, 0, 1, WALL - 4, '#e2d5bd');
    px(0, WALL - 5, W, 5, '#b48e66');
    px(0, WALL - 5, W, 1, '#c9a47b');
    // floor planks
    px(0, WALL, W, H - WALL, '#d2ab7c');
    for (let row = 0, y = WALL; y < H; row++, y += 10) {
      px(0, y, W, 1, '#c29a6b');
      for (let x = (row % 2) * 30; x < W; x += 60) px(x, y, 1, 10, '#c29a6b');
    }
    // rug
    px(146, 150, 188, 64, '#5e9585');
    px(150, 154, 180, 56, '#86bcae');
    for (let x = 156; x < 326; x += 12) px(x, 158, 6, 2, '#a5d4c7');
    for (let x = 156; x < 326; x += 12) px(x, 204, 6, 2, '#a5d4c7');

    drawWindow(86, 10);
    drawWindow(346, 10);
    drawClock(CLOCK.x, CLOCK.y);
    drawBoard();
    drawDoor();
  }

  function sky() {
    const h = new Date().getHours();
    if (h >= 7 && h < 17) return { top: '#8fd3ff', bottom: '#c6ecff', night: false };
    if (h >= 17 && h < 20) return { top: '#ff9e6d', bottom: '#ffd29a', night: false };
    if (h >= 5 && h < 7) return { top: '#b9a6e8', bottom: '#ffd7b5', night: false };
    return { top: '#1d2552', bottom: '#33407a', night: true };
  }

  function drawWindow(x, y) {
    const s = sky();
    px(x - 2, y - 2, 52, 34, '#8a6a4a');
    px(x, y, 48, 15, s.top);
    px(x, y + 15, 48, 15, s.bottom);
    if (s.night) {
      for (let i = 0; i < 6; i++) {
        const sx = x + ((i * 17 + 5) % 46);
        const sy = y + ((i * 11 + 3) % 26);
        if ((Math.floor(t / 400) + i) % 4) px(sx, sy, 1, 1, '#fff7c2');
      }
      px(x + 36, y + 5, 5, 5, '#f4f1d0');
    } else {
      const cx = x + ((t / 220 + x) % 70) - 14;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, 48, 30);
      ctx.clip();
      px(cx, y + 7, 14, 4, '#ffffff');
      px(cx + 3, y + 4, 8, 3, '#ffffff');
      px(cx + 26, y + 18, 10, 3, '#ffffff');
      ctx.restore();
    }
    px(x + 23, y, 2, 30, '#8a6a4a');
    px(x, y + 14, 48, 2, '#8a6a4a');
    px(x - 3, y + 30, 54, 3, '#a7825c');
  }

  function drawClock(x, y) {
    if (hovered === 'clock') {
      px(x - 8, y - 10, 16, 20, '#ffd65a');
      px(x - 10, y - 8, 20, 16, '#ffd65a');
    }
    px(x - 6, y - 8, 12, 16, '#5b4636');
    px(x - 8, y - 6, 16, 12, '#5b4636');
    px(x - 5, y - 6, 10, 12, '#fffaf0');
    px(x - 6, y - 5, 12, 10, '#fffaf0');
    const now = new Date();
    const hand = (angle, len, color) => {
      for (let i = 0; i <= len; i++) px(x + Math.sin(angle) * i, y - Math.cos(angle) * i, 1, 1, color);
    };
    hand(((now.getHours() % 12) + now.getMinutes() / 60) * (Math.PI / 6), 3, '#333');
    hand(now.getMinutes() * (Math.PI / 30), 5, '#333');
    hand(now.getSeconds() * (Math.PI / 30), 5, '#d64545');
  }

  function drawBoard() {
    const { x, y, w, h } = BOARD;
    px(x - 2, y - 2, w + 4, h + 4, hovered === 'board' ? '#ffd65a' : '#8d959e');
    px(x, y, w, h, '#fbfbf7');
    px(x + 2, y + h, w - 4, 3, '#b5bcc4');
    const cols = [
      { color: '#f2c94c', filter: (k) => k.status === 'queued' },
      { color: '#56a0f5', filter: (k) => k.status === 'running' },
      { color: '#f2994a', filter: (k) => k.status === 'review' || k.status === 'failed' },
    ];
    const colW = Math.floor(w / 3);
    cols.forEach((col, i) => {
      const cx = x + i * colW;
      px(cx + 4, y + 3, colW - 8, 2, col.color);
      if (i > 0) px(cx, y + 2, 1, h - 4, '#e3e6ea');
      const list = tasks.filter(col.filter).slice(0, 8);
      list.forEach((task, j) => {
        const nx = cx + 5 + (j % 4) * 9;
        const ny = y + 9 + Math.floor(j / 4) * 14;
        const owner = desks.find((d) => d.stage === task.stage);
        const color = task.status === 'failed' ? '#ff8a80' : owner ? shade(owner.color, 0.55) : '#fff3a0';
        px(nx, ny, 7, 7, color);
        px(nx, ny, 7, 1, shade(color, -0.15));
        px(nx + 1, ny + 3, 4, 1, 'rgba(0,0,0,0.25)');
      });
    });
  }

  function drawDoor() {
    const { x, y, w, h } = DOOR;
    px(x - 2, y - 2, w + 4, h + 2, hovered === 'door' ? '#ffd65a' : '#6e4a33');
    px(x, y, w, h, '#9a6844');
    px(x + 4, y + 4, w - 8, 14, '#a8754f');
    px(x + 4, y + 22, w - 8, 16, '#a8754f');
    px(x + w - 7, y + 22, 3, 3, '#f2c94c');
    px(x + 8, y + 9, w - 16, 3, '#3d2a1e'); // mail slot
  }

  function drawShelf() {
    const { x, y, w, h } = SHELF;
    px(x, y, w, h, '#7a5236');
    const colors = ['#e15b5b', '#4c8bf5', '#f2c94c', '#2fae6e', '#9b59b6', '#ef8e3b'];
    for (let s = 0; s < 3; s++) {
      const sy = y + 4 + s * 18;
      px(x + 2, sy, w - 4, 14, '#5c3d28');
      for (let b = 0; b < 6; b++) px(x + 3 + b * 4, sy + 2 + (b % 3), 3, 12 - (b % 3), colors[(b + s * 2) % colors.length]);
    }
  }

  function drawDesk(d) {
    const { x, y, w } = d.rect;
    const working = agents.get(d.agentId)?.server.status === 'working';
    // monitor
    px(d.cx - 14, 55, 28, 21, '#2d3142');
    drawScreen(d, d.cx - 12, 57, 24, 17, working);
    px(d.cx - 2, 76, 4, 4, '#4a4e5e');
    px(d.cx - 7, 79, 14, 2, '#4a4e5e');
    // desk
    px(x, y, w, 14, '#b4835a');
    px(x, y, w, 1, '#cf9d70');
    px(x, y + 14, w, 14, '#946541');
    px(x + 3, y + 17, w - 6, 1, '#7d5434');
    px(d.cx - 4, y + 19, 8, 2, '#c9a14a');
    // keyboard + mouse
    px(d.cx - 10, y + 5, 20, 4, '#e6e9ef');
    px(d.cx - 9, y + 6, 18, 1, '#c3c8d2');
    px(d.cx + 13, y + 6, 3, 4, '#e6e9ef');
    // personal item
    const k = d.index % 3;
    if (k === 0) {
      px(x + 56, y + 2, 14, 3, '#e15b5b');
      px(x + 57, y - 1, 12, 3, '#4c8bf5');
      px(x + 55, y - 4, 13, 3, '#f2c94c');
    } else if (k === 1) {
      px(x + 58, y - 6, 8, 7, '#c46b48');
      px(x + 56, y - 12, 4, 6, '#4f9d5c');
      px(x + 61, y - 14, 4, 8, '#3e8a4c');
      px(x + 64, y - 10, 4, 5, '#4f9d5c');
      px(x + 6, y + 4, 10, 6, '#f5efe0');
      px(x + 8, y + 5, 2, 2, '#e15b5b');
      px(x + 11, y + 5, 2, 2, '#4c8bf5');
      px(x + 9, y + 8, 2, 2, '#f2c94c');
    } else {
      px(x + 58, y - 2, 7, 8, '#ffffff');
      px(x + 65, y, 2, 4, '#ffffff');
      px(x + 59, y - 1, 5, 2, '#6b3e26');
      if (working && Math.floor(t / 400) % 2) px(x + 60, y - 6, 1, 3, 'rgba(255,255,255,0.7)');
      px(x + 8, y + 1, 6, 5, '#ffd34d');
      px(x + 11, y - 2, 4, 4, '#ffd34d');
      px(x + 15, y - 1, 2, 1, '#ef8e3b');
      px(x + 13, y - 1, 1, 1, '#222');
    }
  }

  function drawScreen(d, x, y, w, h, working) {
    if (!working) {
      px(x, y, w, h, '#1d2230');
      const bx = x + 2 + Math.floor((Math.sin(t / 900 + d.index) + 1) * 0.5 * (w - 8));
      const by = y + 2 + Math.floor((Math.cos(t / 1100 + d.index) + 1) * 0.5 * (h - 7));
      px(bx, by, 4, 3, shade(d.color, -0.3));
      return;
    }
    const k = d.stage;
    if (k === 'research') {
      px(x, y, w, h, '#f7f9fc');
      px(x, y, w, 3, '#d7dde8');
      px(x + 2, y + 4, w - 4, 3, '#ffffff');
      px(x + 2, y + 4, w - 4, 1, '#c5cbd6');
      for (let i = 0; i < 3; i++) {
        const len = 6 + ((i * 7 + Math.floor(t / 300)) % 12);
        px(x + 2, y + 9 + i * 3, 3, 1, d.color);
        px(x + 6, y + 9 + i * 3, len, 1, '#8892a6');
      }
    } else if (k === 'design') {
      px(x, y, w, h, '#fff7fb');
      px(x + 2, y + 2, 9, 6, shade(d.color, 0.4));
      px(x + 13, y + 2, 9, 3, '#ffd65a');
      px(x + 13, y + 6, 6, 2, '#86bcae');
      px(x + 2, y + 10, 20, 5, shade(d.color, 0.15));
      const cx = x + 4 + ((t / 40) % 16);
      px(cx, y + 6 + Math.sin(t / 300) * 3, 1, 2, '#222');
    } else {
      px(x, y, w, h, '#171b26');
      const colors = ['#7ee787', '#79c0ff', '#ffa657', '#d2a8ff'];
      const scroll = Math.floor(t / 260);
      for (let i = 0; i < 5; i++) {
        const n = scroll + i;
        const indent = (n % 3) * 2;
        const len = 4 + ((n * 5) % 13);
        px(x + 2 + indent, y + 2 + i * 3, len, 1, colors[n % colors.length]);
      }
      if (Math.floor(t / 500) % 2) px(x + 2, y + 14, 2, 1, '#ffffff');
    }
  }

  function drawChair(d) {
    const c = shade(d.color, -0.5);
    px(d.cx - 7, 114, 14, 10, c);
    px(d.cx - 6, 113, 12, 1, c);
    px(d.cx - 5, 115, 10, 1, shade(d.color, -0.3));
    px(d.cx - 1, 124, 2, 2, '#2b2f3d');
    px(d.cx - 6, 126, 12, 1, '#2b2f3d');
    px(d.cx - 7, 127, 2, 1, '#111');
    px(d.cx + 5, 127, 2, 1, '#111');
  }

  function drawCouchBack() {
    px(COUCH.x + 4, COUCH.y, COUCH.w - 8, 14, '#c95f49');
    px(COUCH.x + 4, COUCH.y, COUCH.w - 8, 2, '#de7a63');
    px(COUCH.x + 8, COUCH.y + 12, COUCH.w - 16, 10, '#e0806a');
  }

  function drawCouchFront() {
    px(COUCH.x + 4, COUCH.y + 21, COUCH.w - 8, 8, '#b5513d');
    px(COUCH.x, COUCH.y + 4, 8, 26, '#d06b54');
    px(COUCH.x + COUCH.w - 8, COUCH.y + 4, 8, 26, '#d06b54');
    px(COUCH.x, COUCH.y + 4, 8, 2, '#e0806a');
    px(COUCH.x + COUCH.w - 8, COUCH.y + 4, 8, 2, '#e0806a');
    px(COUCH.x + 38, COUCH.y + 14, 10, 7, '#ffd65a'); // cushion
  }

  function drawCounter() {
    const { x, y, w, h } = COUNTER;
    px(x, y + 8, w, h - 8, '#8d6a4b');
    px(x, y + 4, w, 5, '#e8dcc8');
    px(x + 4, y + 14, w - 8, 1, '#76573c');
    px(x + 28, y + 18, 2, 6, '#c9a14a');
    // coffee machine
    px(x + 6, y - 20, 18, 25, hovered === 'coffee' ? '#555963' : '#3d3f46');
    px(x + 8, y - 17, 14, 5, '#22242a');
    px(x + 9, y - 16, 2, 2, Math.floor(t / 700) % 2 ? '#ff5252' : '#7a2a2a');
    px(x + 12, y - 8, 6, 6, '#22242a');
    px(x + 13, y - 4, 4, 4, '#ffffff');
    // fruit bowl + mugs
    px(x + 34, y, 16, 4, '#5b8fd6');
    px(x + 36, y - 3, 4, 4, '#ef8e3b');
    px(x + 41, y - 4, 4, 4, '#e15b5b');
    px(x + 45, y - 3, 4, 4, '#f2c94c');
  }

  function drawArcade() {
    const { x, y, w, h } = ARCADE;
    px(x, y, w, h, hovered === 'arcade' ? '#7353c4' : '#5b3fa0');
    px(x, y, w, 5, '#ff5fa2');
    px(x + 3, y + 7, w - 6, 15, '#14121f');
    const hue = Math.floor(t / 200) % 4;
    const cols = ['#7ee787', '#79c0ff', '#ffd65a', '#ff5fa2'];
    px(x + 6 + (Math.floor(t / 150) % 12), y + 12, 3, 3, cols[hue]);
    px(x + 14, y + 17, 8, 2, cols[(hue + 1) % 4]);
    px(x + 2, y + 24, w - 4, 6, '#40307a');
    px(x + 6, y + 25, 3, 3, '#ff5252');
    px(x + 13, y + 25, 3, 3, '#ffd65a');
    px(x + 4, y + h - 3, w - 8, 3, '#2e2156');
  }

  function drawManagerDesk() {
    const { x, y, w, h } = MANAGER_DESK;
    const glow = hovered === 'inbox';
    px(x, y, w, 10, glow ? '#d39a68' : '#b4835a');
    px(x, y, w, 1, '#cf9d70');
    px(x, y + 10, w, h - 10, '#946541');
    // tray
    px(TRAY.x, TRAY.y + 4, TRAY.w, 4, '#6d6d78');
    const n = tasks.filter((k) => k.status === 'review').length;
    for (let i = 0; i < Math.min(n, 5); i++) px(TRAY.x + 3, TRAY.y + 3 - i * 2, TRAY.w - 6, 2, i % 2 ? '#f1f1f1' : '#ffffff');
    // laptop
    px(x + 50, y + 1, 20, 3, '#c3c8d2');
    px(x + 52, y - 10, 16, 11, '#9aa1ad');
    px(x + 58, y - 6, 4, 3, '#e6e9ef');
    // mug
    px(x + 80, y + 1, 5, 5, '#e15b5b');
  }

  function drawManagerChair() {
    px(232, 252, 16, 12, '#4b5168');
    px(233, 251, 14, 1, '#4b5168');
    px(239, 264, 2, 3, '#2b2f3d');
    px(234, 267, 12, 1, '#2b2f3d');
  }

  function drawPlant(x, y) {
    const sway = Math.round(Math.sin(t / 900 + x) * 1);
    px(x - 6, y - 8, 12, 9, '#c46b48');
    px(x - 6, y - 8, 12, 2, '#d98260');
    px(x - 7 + sway, y - 18, 6, 10, '#4f9d5c');
    px(x - 1 + sway, y - 22, 5, 14, '#3e8a4c');
    px(x + 3 + sway, y - 16, 5, 8, '#57ad66');
  }

  // ---------- DOM overlay: speech bubbles, labels ----------

  function makeBubble(a) {
    const b = el('div', 'bubble');
    b.style.setProperty('--agent', a.color);
    overlay.append(b);
    return b;
  }

  function updateOverlay() {
    for (const e of agents.values()) {
      const atDesk = e.pose === 'desk';
      const anchorX = atDesk ? e.desk.cx : e.x;
      const anchorY = atDesk ? 52 : e.y - (e.pose === 'couch' ? 25 : 28);
      e.bubble.style.left = pct(anchorX, W);
      e.bubble.style.top = pct(anchorY, H);
      let text = '';
      let mode = '';
      if (e.alert && t < e.alertUntil) {
        text = e.alert;
        mode = 'alert';
      } else if (atDesk && e.server.status === 'working') {
        if (t < e.sayUntil && e.server.activity) {
          text = e.server.activity;
          mode = 'say';
        } else {
          mode = 'typing';
        }
      } else if (e.emote && t < e.emoteUntil) {
        text = e.emote;
        mode = 'emote';
      }
      if (e.bubble.dataset.mode !== mode || e.bubble.dataset.text !== text) {
        e.bubble.dataset.mode = mode;
        e.bubble.dataset.text = text;
        e.bubble.className = `bubble ${mode}${mode ? ' show' : ''}`;
        e.bubble.innerHTML = mode === 'typing' ? '<i></i><i></i><i></i>' : '';
        if (mode !== 'typing') e.bubble.textContent = text;
      }
    }
  }

  // ---------- input ----------

  function hitTest(lx, ly) {
    for (const e of [...agents.values()].sort((a, b) => b.y - a.y)) {
      const top = e.pose === 'desk' ? e.y - 22 : e.y - 26;
      if (lx >= e.x - 8 && lx <= e.x + 8 && ly >= top && ly <= e.y + 2) return { type: 'agent', id: e.id, label: `${e.name} · ${e.title}` };
    }
    const inside = (r, pad = 0) => lx >= r.x - pad && lx <= r.x + r.w + pad && ly >= r.y - pad && ly <= r.y + r.h + pad;
    if (inside(BOARD, 2)) return { type: 'board', id: 'board', label: 'Task board' };
    if (inside(DOOR)) return { type: 'new', id: 'door', label: 'Hand out new work' };
    if (inside({ x: CLOCK.x - 9, y: CLOCK.y - 9, w: 18, h: 18 }, 2)) return { type: 'routines', id: 'clock', label: 'Routines: scheduled work' };
    if (inside({ x: MANAGER_DESK.x, y: MANAGER_DESK.y - 12, w: MANAGER_DESK.w, h: MANAGER_DESK.h + 12 })) return { type: 'inbox', id: 'inbox', label: 'Your inbox: work to review' };
    if (inside({ x: COUNTER.x, y: COUNTER.y - 20, w: COUNTER.w, h: COUNTER.h + 20 })) return { type: 'poi', id: 'coffee', poi: 'coffee', label: 'Coffee break!' };
    if (inside(ARCADE)) return { type: 'poi', id: 'arcade', poi: 'arcade', label: 'Arcade' };
    for (const d of desks) {
      if (inside({ x: d.rect.x, y: 54, w: d.rect.w, h: 54 })) {
        const a = agents.get(d.agentId);
        return { type: 'agent', id: d.agentId, label: `${a?.name ?? ''}'s desk` };
      }
    }
    return null;
  }

  function toLogical(ev) {
    const rect = canvas.getBoundingClientRect();
    return [((ev.clientX - rect.left) / rect.width) * W, ((ev.clientY - rect.top) / rect.height) * H];
  }

  canvas.addEventListener('mousemove', (ev) => {
    const [lx, ly] = toLogical(ev);
    const hit = hitTest(lx, ly);
    hovered = hit?.id ?? null;
    canvas.style.cursor = hit ? 'pointer' : 'default';
    if (hit) {
      hint.textContent = hit.label;
      hint.style.left = pct(lx, W);
      hint.style.top = pct(ly, H);
      hint.classList.add('show');
    } else hint.classList.remove('show');
  });
  canvas.addEventListener('mouseleave', () => {
    hovered = null;
    hint.classList.remove('show');
  });
  canvas.addEventListener('click', (ev) => {
    const hit = hitTest(...toLogical(ev));
    if (!hit) return;
    if (hit.type === 'poi') {
      if (!sendTo(hit.poi)) onHint?.('Everyone is busy working right now.');
      return;
    }
    onSelect(hit);
  });

  // ---------- loop + sizing ----------

  function resize() {
    const cssW = canvas.parentElement.clientWidth;
    const k = Math.max(1, Math.min(6, Math.round((cssW * (window.devicePixelRatio || 1)) / W)));
    canvas.width = W * k;
    canvas.height = H * k;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }
  new ResizeObserver(resize).observe(canvas.parentElement);
  resize();

  function frame(now) {
    const dt = Math.min(50, now - last);
    last = now;
    t += dt;
    if (blocked) update(dt);
    draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return { setAgents, setTasks, setRoutines, setPaused, select, runEvent, taskCreated, approvedHandoff, celebrate, sendTo };
}

function el(tag, cls) {
  const n = document.createElement(tag);
  n.className = cls;
  return n;
}

function pct(v, total) {
  return `${(v / total) * 100}%`;
}

function easeInOut(k) {
  return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
}
