#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { cpus, freemem, totalmem } from 'node:os';

const values = { files: 5000, grants: 10000, runs: 1000 };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const name = args[index]?.replace(/^--/, ''), value = Number(args[index + 1]);
  if (!(name in values) || !Number.isSafeInteger(value) || value < 1) throw new Error('Use positive --files, --grants and --runs values.');
  values[name] = value;
}
if (values.grants > 50000 || values.files > 100000 || values.runs > 100000) throw new Error('Fixture exceeds the harness limit.');
const root = resolve(import.meta.dirname, '../..'), artifacts = join(root, '.agent-artifacts/access-query');
await mkdir(artifacts, { recursive: true });
const scratch = await mkdtemp(join(artifacts, 'query-bundle-'));
try {
  const { build } = createRequire(join(root, 'apps/desktop/package.json'))('esbuild');
  const outfile = join(scratch, 'query.mjs');
  await build({ stdin: { contents: 'export { createAccessQuery } from "./apps/desktop/src/access/accessQuery"; export { AccessAnswer } from "./packages/workspace-contracts/src/access";',
    resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  const { createAccessQuery, AccessAnswer } = await import(pathToFileURL(outfile).href);
  const groups = Math.max(1, Math.ceil(values.grants / 100));
  const listing = { grants: Array.from({ length: values.grants }, (_, n) => ({ shareId: `share-${String(n).padStart(8, '0')}`, grantId: `grant-${String(n).padStart(8, '0')}`,
    granterUserId: 'owner', granterEmail: 'owner@example.test', recipientUserId: `recipient-${n}`, recipientEmail: null, subjectName: null, sharerName: null,
    generation: 1, status: 'active', selector: { paths: [`folder-${n % groups}`], versionId: null }, access: 'view' })), links: [], formerGrants: [], endedGrants: [] };
  const query = createAccessQuery(), samples = [], observation = { listing, checkedAtMs: 1, freshness: 'fresh' };
  const ask = file => AccessAnswer.parse(query.answer({ observation, recipientUserId: 'owner', cursorScope: 'fixture', coverage: 'granted',
    ref: { kind: 'path', path: `folder-${file % groups}/file-${file}.md`, versionId: null } }));
  const buildStart = performance.now(); ask(0); const buildMs = performance.now() - buildStart;
  for (let n = 0; n < Math.min(256, values.files); n++) ask(n);
  let rows = 0;
  for (let run = 0; run < values.runs; run++) {
    const file = (run * 7919) % values.files, started = performance.now();
    const answer = ask(file); samples.push(performance.now() - started); rows += answer.rows.length;
    if (answer.freshness !== 'fresh' || !answer.coverage.complete || answer.rows.length === 0) throw new Error('Unusable fixture answer.');
  }
  samples.sort((a, b) => a - b);
  const percentile = p => samples[Math.min(samples.length - 1, Math.ceil(p * samples.length) - 1)];
  const report = { ...values, rowsPerQuery: rows / values.runs, buildMs, cached: { p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: samples.at(-1) },
    budgetP95Ms: 20, pass: percentile(.95) <= 20, node: process.version, logicalCpus: cpus().length, freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(),
    rssBytes: process.memoryUsage().rss, includesResultSchemaParsing: true, measurement: 'Cached in-process queries; host is not claimed idle.' };
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} finally { await rm(scratch, { recursive: true, force: true }); }
