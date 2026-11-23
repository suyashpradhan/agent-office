// Wires the pieces together:
//
//   workspace (which repo) -> db (memory) -> agents (the team) -> adapter (how they run)
//        -> orchestrator (the rules + heartbeat) -> server (API + live events + office UI)

import { execFileSync } from 'node:child_process';
import { openWorkspace } from './workspace.js';
import { openDb } from './db.js';
import { loadAgents } from './agents.js';
import { createBus } from './events.js';
import { createOrchestrator } from './orchestrator.js';
import { createServer } from './server.js';
import * as claude from './adapters/claude.js';
import * as mock from './adapters/mock.js';

export async function initOnly({ repo }) {
  const ws = openWorkspace(repo);
  console.log(`Ready: ${ws.root}\n  edit agents in ${ws.agentsDir}\n  settings in ${ws.root}/config.json`);
}

export async function start({ repo, port, mock: useMock }) {
  const ws = openWorkspace(repo);
  const db = openDb(ws.dbPath);
  const agents = loadAgents(ws.agentsDir);

  let adapter = useMock ? mock : claude;
  if (!useMock && !hasClaude()) {
    console.warn('! claude CLI not found on PATH - falling back to --mock. Install Claude Code to run real agents.');
    adapter = mock;
  }

  const bus = createBus();
  const orch = createOrchestrator({ ws, db, agents, adapter, bus });
  const server = createServer({ orch, bus });
  const actualPort = await listen(server, port);
  orch.start();

  const url = `http://localhost:${actualPort}`;
  console.log(`
  Agent Office  ${url}
  project       ${ws.repo}${ws.branch ? ` (${ws.branch})` : ''}
  team          ${agents.map((a) => `${a.name} (${a.title})`).join(', ')}
  adapter       ${adapter.name}${adapter.name === 'mock' ? ' (simulated, no cost)' : ''}
  budget        $${ws.config.budgetUsd} total, data in .office/
`);

  const shutdown = () => {
    orch.stop();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function hasClaude() {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Bind to localhost only: this server can make agents run code on your machine.
function listen(server, port, attempts = 10) {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempts > 1) resolve(listen(server, port + 1, attempts - 1));
      else reject(err);
    });
    server.listen(port, '127.0.0.1', () => resolve(port));
  });
}
