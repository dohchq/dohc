import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inventory, options } from './cleanup-workspace.mjs';

const tool = await import(pathToFileURL(join(homedir(), 'dev/garage/tools/worktree.mjs')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('inventory rejects deletion flags and malformed arguments', () => {
  assert.throws(() => options(['--apply']), /cannot delete/);
  assert.throws(() => options(['--repo']), /incomplete/);
  assert.throws(() => options(['--base', '--sizes']), /incomplete/);
  assert.equal(options(['--dry-run']).repo, process.cwd());
});

test('inventory preserves uncertainty, supports linked checkouts, and delegates removal to ownership tool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dohc-cleanup-test-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  try {
    git(repo, 'init');
    git(repo, 'config', 'user.name', 'Cleanup fixture');
    git(repo, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(repo, '.gitignore'), 'target/\ntarget-*/\n');
    git(repo, 'add', '.gitignore');
    git(repo, '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
    const base = git(repo, 'rev-parse', 'HEAD');
    const create = name => tool.create(repo, { root, name, branch: name, base, owner: 'cleanup-test' }).path;
    const clean = create('clean');
    const dirty = create('dirty');
    const leased = create('leased');
    const missing = create('missing');
    writeFileSync(join(dirty, 'uncommitted.txt'), 'keep');
    mkdirSync(join(clean, 'target'));
    writeFileSync(join(clean, 'target', 'fixture.bin'), '12345');
    const receipts = join(repo, '.git', 'garage-worktrees');
    const leaseFile = readdirSync(receipts).map(f => join(receipts, f)).find(f => JSON.parse(readFileSync(f)).path === leased);
    writeFileSync(leaseFile + '.lock', 'fixture lease');
    rmSync(missing, { recursive: true });
    const report = await inventory({ repo: join(clean, 'target'), base, sizes: true });
    const row = path => report.rows.find(r => resolve(r.path) === resolve(path));
    assert.ok(row(repo).reasons.includes('current or primary checkout'));
    assert.ok(row(clean).reasons.includes('current or primary checkout'));
    assert.equal(row(clean).builds[0].apparentBytes, 5);
    assert.ok(row(dirty).dirty);
    assert.ok(row(leased).reasons.includes('cleanup or run lease'));
    assert.equal(row(missing).disposition, 'preserve');
    assert.ok(row(missing).reasons.some(r => r.startsWith('inspection failed:')));
    assert.equal(readFileSync(join(dirty, 'uncommitted.txt'), 'utf8'), 'keep');
    assert.equal((await inventory({ repo, base, sizes: false })).rows.find(r => resolve(r.path) === clean).disposition, 'manual review required');
    assert.throws(() => tool.finish(repo, { path: leased, owner: 'cleanup-test', base, apply: true }), /lease/);
    assert.throws(() => tool.finish(repo, { path: dirty, owner: 'cleanup-test', base, apply: true }), /uncommitted/);
    tool.finish(repo, { path: clean, owner: 'cleanup-test', base });
    assert.ok(existsSync(clean));
    tool.finish(repo, { path: clean, owner: 'cleanup-test', base, apply: true });
    assert.ok(!existsSync(clean));
    assert.equal(git(repo, 'rev-parse', 'clean'), base);
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'dohc-cleanup-test-')));
    rmSync(root, { recursive: true, force: true });
  }
});
