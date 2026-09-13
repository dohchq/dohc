#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const key = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
async function git(repo, args) {
  const { stdout } = await exec('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 32e6, windowsHide: true });
  return stdout.trim();
}

export function options(args) {
  const result = { repo: process.cwd(), base: 'origin/main', sizes: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') continue;
    if (arg === '--sizes') result.sizes = true;
    else if (['--repo', '--base'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) result[arg.slice(2)] = args[++i];
    else throw new Error(`Unsupported or incomplete argument: ${arg}. This inventory cannot delete files.`);
  }
  return result;
}

async function bytes(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`Linked build path requires inspection: ${path}`);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of await readdir(path)) total += await bytes(join(path, name));
  return total;
}

export async function inventory({ repo, base, sizes }) {
  repo = resolve(await git(resolve(repo), ['rev-parse', '--show-toplevel']));
  const common = resolve(repo, await git(repo, ['rev-parse', '--git-common-dir']));
  const baseCommit = await git(repo, ['rev-parse', '--verify', `${base}^{commit}`]);
  // Reuse the machine's registered-worktree parser; it performs no cleanup.
  const { worktrees } = await import(pathToFileURL(join(homedir(), 'dev/garage/tools/worktree.mjs')));
  const trees = worktrees(repo);
  let cursor = 0;
  const rows = new Array(trees.length);
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < trees.length) {
      const index = cursor++;
      const tree = trees[index];
      const row = { ...tree, reasons: [], builds: [] };
      rows[index] = row;
      try {
        if (index === 0 || key(tree.path) === key(repo)) row.reasons.push('current or primary checkout');
        if (tree.locked) row.reasons.push('locked worktree');
        const receiptPath = join(common, 'garage-worktrees', createHash('sha256').update(key(tree.path)).digest('hex') + '.json');
        try {
          const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
          row.owner = receipt.owner;
          if (key(receipt.path) !== key(tree.path) || !receipt.owner || receipt.finishedAt) row.reasons.push('invalid or finished receipt');
          if (receipt.run) row.reasons.push('recorded run requires inspection');
          try { await lstat(receiptPath + '.lock'); row.reasons.push('cleanup or run lease'); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          row.reasons.push('unknown ownership');
        }
        row.dirty = (await git(tree.path, ['status', '--porcelain', '--untracked-files=all'])) !== '';
        if (row.dirty) row.reasons.push('uncommitted or untracked work');
        try { await git(repo, ['merge-base', '--is-ancestor', tree.head, baseCommit]); row.merged = true; }
        catch (error) { if (error.code !== 1) throw error; row.merged = false; row.reasons.push('commits not ancestors of base'); }
        for (const name of await readdir(tree.path)) {
          if (name !== 'target' && !name.startsWith('target-')) continue;
          const path = join(tree.path, name);
          row.builds.push({ path, ...(sizes ? { apparentBytes: await bytes(path) } : {}) });
        }
      } catch (error) { row.reasons.push(`inspection failed: ${error.message}`); }
      row.disposition = row.reasons.length ? 'preserve' : 'manual review required';
    }
  }));
  return { repo, base, baseCommit, generatedAt: new Date().toISOString(),
    limits: 'Read-only. Activity, open PRs, ignored evidence, and standalone build targets require manual inspection. Apparent bytes may share hard-linked storage.', rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) console.log('Read-only cleanup inventory (always dry-run): --repo <checkout> --base <fetched-ref> [--dry-run] [--sizes]\nWrite JSON evidence by redirecting stdout. Deletion uses ~/dev/garage/tools/worktree.mjs finish after manual review.');
  else inventory(options(process.argv.slice(2))).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
