// The team roster. Each agent is a markdown file: frontmatter = config, body = role prompt.
// Defaults live in /agents; each project gets its own editable copy in .office/agents/.
//
// Add a 4th agent (say, a QA tester) by dropping a qa.md file with `stage: qa` and
// `order: 4` into .office/agents/ - it becomes a new pipeline stage with its own desk.

import fs from 'node:fs';
import path from 'node:path';

export function loadAgents(dir) {
  const agents = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => parseAgentFile(path.join(dir, f)))
    .filter((a) => a.enabled !== false)
    .sort((a, b) => a.order - b.order);
  if (agents.length === 0) throw new Error(`No agent files found in ${dir}`);
  return agents;
}

export function parseAgentFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`${file}: missing --- frontmatter ---`);
  const meta = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  const id = meta.id || path.basename(file, '.md');
  return {
    id,
    name: meta.name || id,
    title: meta.title || id,
    stage: meta.stage || id,
    order: Number(meta.order || 99),
    color: meta.color || '#888888',
    hair: meta.hair || '#3b2a20',
    skin: meta.skin || '#f1c27d',
    accessory: meta.accessory || 'none',
    // Least privilege: each role only gets the tools it needs. Anything not listed is denied.
    tools: (meta.tools || 'Read, Glob, Grep').split(',').map((t) => t.trim()).filter(Boolean),
    // "repo" = read your checkout directly; "worktree" = isolated branch (for agents that edit).
    workspace: meta.workspace === 'worktree' ? 'worktree' : 'repo',
    maxBudgetUsd: Number(meta.maxBudgetUsd || 1),
    model: meta.model || '',
    // "none" (default) = no MCP servers; "inherit" = use the MCP servers from your Claude config.
    mcp: meta.mcp === 'inherit' ? 'inherit' : 'none',
    enabled: meta.enabled !== 'false',
    prompt: match[2].trim(),
  };
}
