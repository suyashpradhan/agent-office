#!/usr/bin/env node
// Entry point. Usage:
//   agent-office                 run the office for the repo in the current directory
//   agent-office --repo ../app   run it for another repo
//   agent-office --mock          fake agents (no Claude calls, no cost) - great for learning the flow
//   agent-office init            only create .office/ (config + editable agent files)

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`agent-office needs Node 22.13+ (for the built-in node:sqlite). You have ${process.version}.`);
  process.exit(1);
}

// node:sqlite prints an "experimental" warning on first use. It works fine; hide the noise.
const emit = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning?.message ?? warning).includes('SQLite')) return;
  return emit.call(process, warning, ...rest);
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

if (flag('--help') || flag('-h')) {
  console.log(`agent-office - a 3-agent team with a 2D office dashboard

  agent-office [init] [--repo <path>] [--port <n>] [--mock]

  --repo   project to work on (default: current directory)
  --port   dashboard port (default: 4747, or next free one)
  --mock   simulated agents: no Claude CLI calls, no cost
  init     create .office/ in the repo and exit`);
  process.exit(0);
}

const { start, initOnly } = await import('../src/main.js');
const options = {
  repo: opt('--repo', process.cwd()),
  port: Number(opt('--port', process.env.PORT || 4747)),
  mock: flag('--mock'),
};

if (args[0] === 'init') await initOnly(options);
else await start(options);
