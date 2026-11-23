// Workspace: everything about "which project are we working on" and where files go.
//
// Each project gets its own .office/ folder (like Paperclip's per-company data):
//   <repo>/.office/
//     config.json        budget + review settings for this project
//     agents/*.md        the team - copied from the defaults, edit them per project
//     office.db          tasks, runs, activity (SQLite)
//     tasks/<id>/        handoff documents each agent produced (research.md, design.md, ...)
//     worktrees/<id>/    isolated git checkout where the developer works on a branch
//
// .office/ is added to .git/info/exclude (a local-only ignore), so it never shows up
// in your project's git status and you don't have to touch the project's .gitignore.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_AGENTS_DIR = path.join(HERE, '..', 'agents');

const DEFAULT_CONFIG = {
  // Hard stop for the whole project. When total spend reaches this, the office pauses.
  budgetUsd: 5,
  // Pause for your approval after every stage (research, design, dev). Recommended.
  reviewBetweenStages: true,
  // How often the scheduler wakes up to look for work (Paperclip calls this a heartbeat).
  heartbeatMs: 2000,
  // Stop a run that takes longer than this (a hung process, an endless loop).
  runTimeoutMinutes: 30,
};

export function openWorkspace(repoArg) {
  const repo = path.resolve(repoArg);
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) {
    throw new Error(`Not a directory: ${repo}`);
  }
  const root = path.join(repo, '.office');
  const created = !fs.existsSync(root);
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });

  // Copy default agent definitions the first time, so they can be customised per project.
  for (const file of fs.readdirSync(DEFAULT_AGENTS_DIR)) {
    const target = path.join(root, 'agents', file);
    if (file.endsWith('.md') && !fs.existsSync(target)) {
      fs.copyFileSync(path.join(DEFAULT_AGENTS_DIR, file), target);
    }
  }

  const configPath = path.join(root, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  }
  const config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };

  const git = isGitRepo(repo);
  if (git) excludeFromGit(repo);

  return {
    repo,
    root,
    created,
    config,
    isGit: git,
    name: path.basename(repo),
    branch: git ? gitOut(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) : null,
    dbPath: path.join(root, 'office.db'),
    agentsDir: path.join(root, 'agents'),
    taskDir(taskId) {
      const dir = path.join(root, 'tasks', String(taskId));
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
}

// The developer never edits your checked-out files directly. It gets its own worktree
// on a new branch, so you can keep coding while it works, then review/merge the branch.
export function ensureWorktree(ws, taskId) {
  if (!ws.isGit) return { cwd: ws.repo, branch: null };
  const branch = `office/task-${taskId}`;
  const dir = worktreeDir(ws, taskId);
  if (!fs.existsSync(dir)) {
    const hasBranch = gitOk(ws.repo, ['rev-parse', '--verify', '--quiet', branch]);
    const args = hasBranch
      ? ['worktree', 'add', dir, branch]
      : ['worktree', 'add', '-b', branch, dir, 'HEAD'];
    execFileSync('git', args, { cwd: ws.repo, stdio: 'pipe' });
  }
  return { cwd: dir, branch };
}

export function worktreeDir(ws, taskId) {
  return path.join(ws.root, 'worktrees', `task-${taskId}`);
}

// Safety net after a developer run: if the agent left edits uncommitted, commit them so
// nothing is lost and the diff viewer shows them. Returns true if it made a commit.
export function commitLeftovers(cwd, message) {
  if (!fs.existsSync(cwd)) return false;
  const dirty = gitOut(cwd, ['status', '--porcelain']);
  if (!dirty) return false;
  execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' });
  execFileSync(
    'git',
    ['-c', 'user.name=Agent Office', '-c', 'user.email=agent-office@localhost', 'commit', '-q', '--no-verify', '-m', message],
    { cwd, stdio: 'ignore' },
  );
  return true;
}

// How far the agent's branch is ahead of your current branch.
export function commitsAhead(ws, branch) {
  try {
    return Number(gitOut(ws.repo, ['rev-list', '--count', `HEAD..${branch}`]));
  } catch {
    return 0;
  }
}

const MAX_DIFF = 200_000;

// What the developer changed, relative to where your current branch and theirs split.
export function branchDiff(ws, branch) {
  if (!ws.isGit || !branch) return { stat: '', patch: '', truncated: false };
  try {
    const base = gitOut(ws.repo, ['merge-base', 'HEAD', branch]);
    const stat = gitOut(ws.repo, ['diff', '--stat', `${base}..${branch}`]);
    let patch = execFileSync('git', ['diff', '--no-color', `${base}..${branch}`], {
      cwd: ws.repo,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 50 * 1024 * 1024,
    }).toString();
    const truncated = patch.length > MAX_DIFF;
    if (truncated) patch = patch.slice(0, MAX_DIFF);
    return { stat, patch, truncated };
  } catch {
    return { stat: '', patch: '', truncated: false };
  }
}

// When a task is finished or cancelled, remove its checkout but keep the branch,
// so you can still diff/merge it and a retry can recreate the worktree from it.
export function removeWorktree(ws, taskId) {
  const dir = worktreeDir(ws, taskId);
  if (!ws.isGit || !fs.existsSync(dir)) return false;
  try {
    commitLeftovers(dir, `office: save uncommitted work for task ${taskId}`);
  } catch {
    /* still try to remove */
  }
  try {
    execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: ws.repo, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function pruneWorktrees(ws) {
  if (ws.isGit) gitOk(ws.repo, ['worktree', 'prune']);
}

function isGitRepo(dir) {
  return gitOk(dir, ['rev-parse', '--is-inside-work-tree']);
}

function excludeFromGit(repo) {
  try {
    const gitDir = gitOut(repo, ['rev-parse', '--git-common-dir']);
    const file = path.resolve(repo, gitDir, 'info', 'exclude');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!current.split('\n').includes('.office/')) {
      fs.appendFileSync(file, `${current.endsWith('\n') || !current ? '' : '\n'}.office/\n`);
    }
  } catch {
    /* not fatal */
  }
}

function gitOut(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

function gitOk(cwd, args) {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
