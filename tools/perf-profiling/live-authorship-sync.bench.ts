import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { markdownToYDoc } from '../../packages/ydoc-projection/src/import-export.js';
import { createLiveMarkdownJournalValidator } from '../../packages/ydoc-projection/src/liveDocumentValidation.js';
import { registered, cleanupLiveDeliveryFixtures, policy } from '../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js';
import { liveJournalCheckpointDue } from '../../services/sync-relay/src/storage/liveJournalCheckpoint.js';
import type { StorageContext } from '../../services/sync-relay/src/storage/context.js';
import type { LiveUpdateJournalCommitInput, LiveUpdateJournalCutResult, RelayLiveUpdateJournalResult } from '../../services/sync-relay/src/storage/types.js';
import type { LiveDocumentKey } from '@dohc/live-session-contract/live-update-admission';

const Y = createRequire(new URL('../../packages/ydoc-projection/package.json', import.meta.url))('yjs') as typeof import('yjs');
export interface JournalAdapter {
  commit(storage: StorageContext, input: LiveUpdateJournalCommitInput): RelayLiveUpdateJournalResult;
  read(storage: StorageContext, input: { document: LiveDocumentKey }): LiveUpdateJournalCutResult;
}
interface Settings { updates: number; warmupUpdates: number; pairs: number; resultPath: string; sources: Record<string, string>; }
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const quantile = (samples: number[], fraction: number) => [...samples].sort((a, b) => a - b)[Math.max(0, Math.ceil(samples.length * fraction) - 1)] ?? 0;
const summary = (samples: number[]) => ({ count: samples.length, medianMs: quantile(samples, 0.5), p95Ms: quantile(samples, 0.95), totalMs: samples.reduce((a, b) => a + b, 0) });

export async function runAdmissionBenchmark(settings: Settings, adapters: Record<'before' | 'after', JournalAdapter>) {
  const baselineDoc = markdownToYDoc('Hello', { clientID: 101 });
  const baselineBytes = Y.encodeStateAsUpdate(baselineDoc); baselineDoc.destroy();
  const validate = createLiveMarkdownJournalValidator(policy);
  const runs: Awaited<ReturnType<typeof run>>[] = [];
  let fixtureDigest: string | undefined;
  async function run(label: 'before' | 'after', count: number, warmup: boolean, pair: number) {
    const f = registered({ deployment: true, baselineBytes });
    const context = f.storage as StorageContext;
    const adapter = adapters[label];
    const admissionMs: number[] = [], transactionMs: number[] = [], checkpointAdmissionMs: number[] = [];
    const fixtureHash = createHash('sha256').update(baselineBytes);
    let transactionDuration = 0, transactionCalls = 0, checkpointCount = 0;
    const originalTx = context.tx.bind(context);
    try {
      f.write(db => {
        const insert = db.prepare("INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id) VALUES (?,'share','user',?,NULL,'edit',4,'active',0,NULL,NULL)");
        for (let account = 0; account < 8; account++) insert.run('bench-grant-' + account, 'bench-account-' + account);
      });
      const sqlite = Object.fromEntries(['journal_mode', 'synchronous', 'foreign_keys', 'page_size', 'cache_size', 'busy_timeout'].map(name => [name, context.db.prepare('PRAGMA ' + name).get()]));
      const schemaDigest = sha(JSON.stringify(context.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all()));
      context.tx = ((work: () => unknown) => {
        const start = performance.now();
        try { return originalTx(work); }
        finally { transactionDuration += performance.now() - start; transactionCalls++; }
      }) as StorageContext['tx'];
      for (let index = 0; index < count; index++) {
        const account = index % 8, accountId = 'bench-account-' + account;
        f.doc.clientID = 1000 + account;
        const updateBytes = f.update('bench-field-' + account, 'value-' + String(index).padStart(5, '0'));
        const actor = { kind: 'named' as const, grantId: 'bench-grant-' + account, userId: accountId };
        const current = f.storage.resolveCurrentLiveDocumentBinding({ document: f.input.evidence.document, actor });
        if (current.kind !== 'current') throw Error('Current binding refused: ' + JSON.stringify(current));
        const cut = adapter.read(context, { document: f.input.evidence.document });
        if (cut.kind !== 'cut') throw Error('Cut refused: ' + JSON.stringify(cut));
        const validation = validate({ document: cut.cut.document, currentPath: cut.cut.currentPath, checkpoint: cut.cut.checkpoint.bytes, suffix: cut.cut.suffix.map(row => row.bytes), candidate: updateBytes });
        if (validation.kind !== 'accepted') throw Error('Fixture validation refused: ' + JSON.stringify(validation));
        const authorContext = { kind: 'account' as const, accountId, agent: { agentId: 'bench-agent-' + account, agentName: 'Agent ' + account, onBehalfOf: accountId, depth: 1 } };
        const common = { host: current.host, actor, expectedAuthority: current.authority, cutToken: cut.cut, updateBytes, receivedAtMs: 1000 + index };
        const evidence = validation.evidence, candidate = evidence.candidate;
        const due = liveJournalCheckpointDue(cut.cut.suffixCount + 1, cut.cut.suffixBytes + updateBytes.byteLength);
        const ownedEvidence = { version: evidence.version, document: evidence.document, currentPath: evidence.currentPath,
          checkpointDigest: evidence.checkpointDigest, checkpointRanges: evidence.checkpointRanges, suffixDigests: evidence.suffixDigests,
          stateUpdateSha256: evidence.stateUpdateSha256, stateUpdateByteLength: evidence.stateUpdateByteLength,
          ...(due ? { stateUpdate: evidence.stateUpdate } : {}) };
        const v2Candidate = { updateDigest: candidate.updateDigest, ranges: candidate.ranges, firstSeen: candidate.firstSeen, firstSeenDeletes: candidate.firstSeenDeletes };
        const input = label === 'after'
          ? { ...common, metadata: { deliveryId: 'bench-' + index, updateDigest: sha(updateBytes), binding: current.binding, authorContext }, trustedAccount: { accountId, name: 'Account ' + account }, validation: { kind: 'accepted' as const, evidence: { ...ownedEvidence, candidate: v2Candidate } } }
          : { ...common, metadata: { deliveryId: 'bench-' + index, updateDigest: sha(updateBytes), binding: current.binding }, validation: { kind: 'accepted' as const, evidence: { ...ownedEvidence, candidate: { updateDigest: candidate.updateDigest, ranges: candidate.ranges } } } };
        fixtureHash.update(JSON.stringify({ index, actor, authorContext })).update(updateBytes);
        transactionDuration = 0; transactionCalls = 0;
        const start = performance.now();
        const result = adapter.commit(context, input as LiveUpdateJournalCommitInput);
        const elapsed = performance.now() - start;
        if (result.result.kind !== 'accepted' || result.result.replayed || transactionCalls !== 1) throw Error('Admission refused: ' + JSON.stringify(result.result));
        if (label === 'after' && JSON.stringify(result.admitted?.metadata.authorSnapshot) !== JSON.stringify([
          { kind: 'human', humanId: accountId, humanName: 'Account ' + account }, { kind: 'agent', ...authorContext.agent },
        ])) throw Error('Authored fixture did not record its matching human and agent snapshot');
        admissionMs.push(elapsed); transactionMs.push(transactionDuration);
        if (result.admitted?.metadata.checkpointCoverage !== undefined || liveJournalCheckpointDue(cut.cut.suffixCount + 1, cut.cut.suffixBytes + updateBytes.byteLength)) { checkpointCount++; checkpointAdmissionMs.push(elapsed); }
        if ((index + 1) % 1000 === 0) console.log(label + ' pair ' + pair + ': ' + (index + 1) + '/' + count);
      }
      const digest = fixtureHash.digest('hex');
      if (!warmup) {
        if (fixtureDigest !== undefined && fixtureDigest !== digest) throw Error('Fixture digest changed between paired runs');
        fixtureDigest = digest;
      }
      return { label, pair, warmup, updates: count, fixtureDigest: digest, sqlite, schemaDigest, checkpointCount,
        admission: summary(admissionMs), transaction: summary(transactionMs), checkpointAdmission: summary(checkpointAdmissionMs), admissionMs, transactionMs };
    } finally { context.tx = originalTx; f.close(); cleanupLiveDeliveryFixtures(); }
  }
  if (settings.warmupUpdates > 0) for (const label of ['before', 'after'] as const) await run(label, settings.warmupUpdates, true, 0);
  for (let pair = 0; pair < settings.pairs; pair++) {
    const order = pair % 2 === 0 ? ['before', 'after'] as const : ['after', 'before'] as const;
    for (const label of order) runs.push(await run(label, settings.updates, false, pair + 1));
  }
  const result = { status: 'passed', finishedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, node: process.version, statistics: { quantiles: 'nearest rank' },
    scope: 'Relay commitLiveUpdateJournal admission call and its single SQLite transaction. Registration, update construction, cut reads, ordered Yjs validation, fixture hashing, receipt assertions and host application are excluded from timing.',
    fixture: { version: 1, baselineClientId: 101, accounts: 8, agents: 8, clientIds: [1000,1001,1002,1003,1004,1005,1006,1007], sha256: fixtureDigest,
      edit: 'Rotate eight named accounts and fixed account client IDs; replace each account frontmatter field with value- plus the zero-padded update index.', baselineSha256: sha(baselineBytes) },
    settings: { ...settings, resultPath: undefined, validatorPolicy: policy, freshSqlitePerRun: true, baselineSchema: 'Current schema, preserved v1 admission implementation' },
    comparisons: Array.from({ length: settings.pairs }, (_, index) => {
      const before = runs.find(run => run.pair === index + 1 && run.label === 'before')!;
      const after = runs.find(run => run.pair === index + 1 && run.label === 'after')!;
      const delta = (prior: number, next: number) => ({ deltaMs: next - prior, deltaPercent: prior === 0 ? null : (next / prior - 1) * 100 });
      return { pair: index + 1, admissionMedian: delta(before.admission.medianMs, after.admission.medianMs), admissionP95: delta(before.admission.p95Ms, after.admission.p95Ms),
        transactionMedian: delta(before.transaction.medianMs, after.transaction.medianMs), transactionP95: delta(before.transaction.p95Ms, after.transaction.p95Ms) };
    }), runs };
  await writeFile(settings.resultPath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ fixtureDigest, runs: runs.map(({ label, pair, admission, transaction }) => ({ label, pair, admission, transaction })) }, null, 2));
}
