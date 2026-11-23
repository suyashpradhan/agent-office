// Schedules for routines, written as standard 5-field cron, in your computer's local time:
//
//   ┌ minute (0-59)
//   │ ┌ hour (0-23)
//   │ │ ┌ day of month (1-31)
//   │ │ │ ┌ month (1-12 or jan-dec)
//   │ │ │ │ ┌ day of week (0-7 or sun-sat; 0 and 7 are Sunday)
//   0 9 * * 1-5      weekdays at 09:00
//
// Supports *, lists (1,3,5), ranges (1-5), steps (*/15, 0-30/10) and @hourly/@daily/
// @weekly/@monthly. Paperclip's routines use cron too.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ALIASES = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *' };

export function parseSchedule(input) {
  const text = String(input || '').trim().toLowerCase();
  const expr = ALIASES[text] || text;
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) throw new Error('A schedule needs 5 fields: minute hour day-of-month month day-of-week');
  const [minute, hour, dom, month, dow] = parts;
  const spec = {
    source: expr,
    minute: field(minute, 0, 59, 'minute'),
    hour: field(hour, 0, 23, 'hour'),
    dom: field(dom, 1, 31, 'day of month'),
    month: field(month, 1, 12, 'month', MONTHS, 1),
    dow: field(dow, 0, 7, 'day of week', DAYS, 0),
  };
  if (spec.dow.values.has(7)) spec.dow.values.add(0);
  nextRun(spec, new Date()); // throws if it can never fire (e.g. 30 February)
  return spec;
}

function field(text, min, max, label, names, nameOffset = 0) {
  const values = new Set();
  const any = text === '*';
  for (const piece of text.split(',')) {
    const m = piece.match(/^(\*|[\w]+)(?:-([\w]+))?(?:\/(\d+))?$/);
    if (!m) throw new Error(`Can't read the ${label} field "${text}"`);
    const num = (v) => {
      const i = names ? names.indexOf(v) : -1;
      const n = i >= 0 ? i + nameOffset : Number(v);
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be between ${min} and ${max} (got "${v}")`);
      return n;
    };
    const from = m[1] === '*' ? min : num(m[1]);
    const to = m[2] !== undefined ? num(m[2]) : m[1] === '*' || m[3] ? max : from;
    const step = m[3] ? Number(m[3]) : 1;
    if (step < 1) throw new Error(`Step in the ${label} field must be at least 1`);
    if (from > to) throw new Error(`Range in the ${label} field goes backwards ("${piece}")`);
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { any, values };
}

// The first moment strictly after `after` that matches. Jumps a month/day/hour at a
// time when a coarser field doesn't match, so even rare schedules are fast to compute.
export function nextRun(spec, after) {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 50_000; i++) {
    if (!spec.month.values.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
    } else if (!dayMatches(spec, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    } else if (!spec.hour.values.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
    } else if (!spec.minute.values.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
    } else {
      return d;
    }
  }
  throw new Error('This schedule never fires');
}

// Classic cron rule: if both day fields are restricted, either one matching is enough.
function dayMatches(spec, d) {
  const dom = spec.dom.values.has(d.getDate());
  const dow = spec.dow.values.has(d.getDay());
  if (spec.dom.any && spec.dow.any) return true;
  if (spec.dom.any) return dow;
  if (spec.dow.any) return dom;
  return dom || dow;
}

export function nextRuns(spec, from, count) {
  const out = [];
  let t = from;
  for (let i = 0; i < count; i++) {
    t = nextRun(spec, t);
    out.push(t);
  }
  return out;
}

// Plain-English version of the common shapes; anything else shows the cron itself.
export function describeSchedule(input) {
  let spec;
  try {
    spec = parseSchedule(input);
  } catch {
    return String(input);
  }
  const [m, h, dom, mon, rawDow] = spec.source.split(' ');
  const dow = rawDow.replace(/[a-z]{3}/g, (name) => String(DAYS.indexOf(name)));
  const time = /^\d+$/.test(m) && /^\d+$/.test(h) ? `${h.padStart(2, '0')}:${m.padStart(2, '0')}` : null;
  const step = m.match(/^\*\/(\d+)$/);
  if (m === '*' && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every minute';
  if (step && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${step[1]} minutes`;
  if (/^\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return m === '0' ? 'Every hour' : `Every hour at :${m.padStart(2, '0')}`;
  if (time && dom === '*' && mon === '*') {
    if (dow === '*') return `Every day at ${time}`;
    if (dow === '1-5') return `Weekdays at ${time}`;
    if (dow === '0,6' || dow === '6,0') return `Weekends at ${time}`;
    if (/^[0-7]$/.test(dow)) return `Every ${DAY_NAMES[Number(dow) % 7]} at ${time}`;
  }
  if (time && /^\d+$/.test(dom) && mon === '*' && dow === '*') return `Monthly on day ${dom} at ${time}`;
  return `Cron: ${spec.source}`;
}

// Fill {date}, {time} and {weekday} in a routine's task title.
export function renderTitle(template, when = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  return String(template)
    .replaceAll('{date}', date)
    .replaceAll('{time}', `${pad(when.getHours())}:${pad(when.getMinutes())}`)
    .replaceAll('{weekday}', DAY_NAMES[when.getDay()]);
}
