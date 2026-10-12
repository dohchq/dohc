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
  await build({ stdin: { contents: 'export { createAccessQuery } from "./apps/desktop/src/access/accessQuery"; export { createAccessOwner } from "./apps/desktop/src/access/accessOwner"; export { hasAccessChat, locateAccessVersionPath, resolveAccessObject } from "./apps/desktop/src/access/accessObjectResolution"; export { AccessAnswer } from "./packages/workspace-contracts/src/access";',
    resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  const { createAccessQuery, createAccessOwner, hasAccessChat, locateAccessVersionPath, resolveAccessObject, AccessAnswer } = await import(pathToFileURL(outfile).href);
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
  const statistics = samples => {
    samples.sort((a, b) => a - b);
    const percentile = p => samples[Math.min(samples.length - 1, Math.ceil(p * samples.length) - 1)];
    return { p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: samples.at(-1) };
  };
  const workspace = { workspaceId: 'fixture', rootPath: '/fixture' };
  const binaryFiles = Array.from({ length: values.files }, (_, file) => ({ path: `folder-${file % groups}/file-${file}.png`, contentKind: 'binary' }));
  const binaryListing = { ...listing, grants: listing.grants.map(row => ({ ...row, selector: { ...row.selector, versionId: 'draft' } })) };
  const channelCount = Math.max(100, values.files), pageChannels = Array.from({ length: 100 }, (_, n) => ({ id: `local-${n}` }));
  let wireLookups = 0;
  const chatStore = { listChannelsPage: async ({ limit }) => {
    if (limit !== 100) throw Error('Unbounded channel page.');
    return { channels: pageChannels, nextCursor: channelCount > 100 ? 'more' : null };
  }, getChannelWireId: async ({ channelId }) => { wireLookups++; return channelId === 'local-99' ? 'origin-wire' : `wire-${channelId}`; } };
  const chatListing = { ...listing, grants: listing.grants.map((row, n) => ({ ...row,
    selector: { kind: 'chat', channelWireId: n % groups === 0 ? 'origin-wire' : `grant-wire-${n % groups}` }, access: 'read-only' })) };
  const owner = listing => createAccessOwner({
    resolve: (_workspace, ref) => resolveAccessObject(workspace, ref, {
      filePathForObjectId: async () => null,
      locatePath: (path, versionId) => locateAccessVersionPath('fixture', path, versionId, { listTextFileMetadata: async () => binaryFiles }),
      hasChat: wire => hasAccessChat('fixture', wire, chatStore),
    }), roster: () => ({ listing, checkedAtMs: 1, freshness: 'fresh' }), received: () => ({ inventory: null, checkedAtMs: null, freshness: 'unknown' }),
    account: () => ({ userId: 'owner', email: 'owner@example.test', relayUrl: 'relay', generation: 1 }), scope: () => 'fixture', assertCurrent() {},
    permissions: async () => { throw Error('Unused Collection fixture.'); }, refresh: async () => { throw Error('Benchmark reads must not refresh.'); },
  });
  const binaryOwner = owner(binaryListing), chatOwner = owner(chatListing);
  const binaryAsk = file => binaryOwner.object(workspace, { ref: { kind: 'path', path: binaryFiles[file].path, versionId: 'draft' } });
  const chatAsk = () => chatOwner.object(workspace, { ref: { kind: 'chat', channelWireId: 'origin-wire' } });
  await binaryAsk(0); await chatAsk(); wireLookups = 0;
  const binarySamples = [], chatSamples = [];
  for (let run = 0; run < values.runs; run++) {
    for (const [ask, timings] of [[() => binaryAsk((run * 7919) % values.files), binarySamples], [chatAsk, chatSamples]]) {
      const started = performance.now(), answer = AccessAnswer.parse(await ask());
      timings.push(performance.now() - started);
      if (answer.freshness !== 'fresh' || answer.visibility !== 'visible' || !answer.coverage.complete || answer.rows.length === 0) throw Error('Unusable resolved fixture answer.');
    }
  }
  const cached = statistics(samples), binaryResolution = statistics(binarySamples), chatResolution = statistics(chatSamples);
  const report = { ...values, rowsPerQuery: rows / values.runs, buildMs, cached, binaryResolution, chatResolution,
    binaryMetadataRows: binaryFiles.length, chatFixtureChannels: channelCount, chatInventoryGrants: chatListing.grants.length,
    maxChatRowsPerQuery: 100, wireLookupsPerChatQuery: wireLookups / values.runs,
    budgetP95Ms: 20, pass: [cached, binaryResolution, chatResolution].every(result => result.p95Ms <= 20),
    node: process.version, logicalCpus: cpus().length, freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(),
    rssBytes: process.memoryUsage().rss, includesResultSchemaParsing: true,
    measurement: 'In-process query and production resolution paths with fixture metadata/chat ports; excludes daemon IPC. Host is not claimed idle.' };
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} finally { await rm(scratch, { recursive: true, force: true }); }
