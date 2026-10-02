import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const require = createRequire(new URL('../../node_modules/.pnpm/node_modules/.live-profile.cjs', import.meta.url));
const { parse } = require('@babel/parser');
const profileSha256 = createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex');
const scopes = {
  captureJournalCut: 'cut capture',
  snapshotJournalCut: 'cut capture',
  verifyJournalCut: 'cut digest verification',
  snapshotJournalValidation: 'validation evidence capture',
  readJournalCut: 'cut recheck',
  liveJournalCoverage: 'full provenance scan',
  requireRestoreSourceCoverage: 'restore and struct newness',
  subtractJournalRanges: 'range subtraction',
  deriveLiveAuthorSnapshot: 'author snapshot',
  assessLiveAuthorWindow: 'author window',
  appendValidatedLiveJournal: 'append bookkeeping',
  canonicalAcceptedMetadata: 'canonical metadata and digest',
  canonicalVersionedAcceptedMetadata: 'canonical metadata and digest',
  nextAcceptedHistoryDigest: 'canonical metadata and digest',
  nextVersionedAcceptedHistoryDigest: 'canonical metadata and digest',
  reserve: 'durable continuity sidecar',
  newCoverage: 'pre-candidate frontier overhead',
};

// Instrument only benchmark modules. Production source stays unchanged.
export function admissionProfilePlugin() {
  return {
    name: 'live-admission-profile',
    enforce: 'pre',
    transform(code, id) {
      if (/live-authorship-sync\.bench\.ts(?:\?|$)/.test(id)) {
        code = code.replace("const baselineDoc = markdownToYDoc('Hello'", `settings.sources.profileSha256 = ${JSON.stringify(profileSha256)}; const baselineDoc = markdownToYDoc('Hello'`);
        code = code.replace('const profileStack: ProfileScope[]', 'const excludedProfileSamples: Record<string, number[]> = {}; const profileStack: ProfileScope[]');
        code = code.replace('const validation = validate({', 'for (const key of Object.keys(profileTotals)) profileTotals[key] = 0; profiling = settings.profile === true; const validation = validate({');
        code = code.replace("if (validation.kind !== 'accepted')", "profiling = false; for (const [key, value] of Object.entries(profileTotals)) (excludedProfileSamples[key] ??= []).push(value); if (validation.kind !== 'accepted')");
        code = code.replace('...(settings.profile ? { profile:', '...(settings.profile ? { excludedProfile: Object.fromEntries(Object.entries(excludedProfileSamples).map(([name, values]) => [name, summary(values)])), profile:');
        const progress = "if ((index + 1) % 1000 === 0) console.log(label + ' pair ' + pair + ': ' + (index + 1) + '/' + count);";
        if (!code.includes(progress)) throw Error('Admission profile progress point changed');
        return { code: "import { writeFileSync as __writeProfileProgress } from 'node:fs';\n" + code.replace(progress,
          `if ((index + 1) % 1000 === 0) { console.log(label + ' pair ' + pair + ': ' + (index + 1) + '/' + count);
          __writeProfileProgress(settings.resultPath + '.progress.json', JSON.stringify({label, pair, completed: index + 1, total: count,
            admission: summary(admissionMs), cutRead: summary(cutReadMs), admissionAndCutRead: summary(admissionAndCutReadMs),
            profile: Object.fromEntries(Object.entries(profileSamples).map(([name, values]) => [name, summary(values)])),
            cutReadProfile: Object.fromEntries(Object.entries(cutReadProfileSamples).map(([name, values]) => [name, summary(values)])),
            excludedProfile: Object.fromEntries(Object.entries(excludedProfileSamples).map(([name, values]) => [name, summary(values)])), at: new Date().toISOString()}, null, 2)); }`), map: null };
      }
      if (!/(?:baseline\.runtime|liveUpdateJournal|liveAuthorWindow|liveAuthorSnapshot|liveAcceptedHistory|relayDeployment|orderedLiveUpdateCut)\.ts(?:\?|$)/.test(id)) return;
      const source = parse(code, { sourceType: 'module', plugins: ['typescript'] });
      const edits = [];
      function visit(node) {
        const key = node.type === 'FunctionDeclaration' ? node.id?.name : node.type === 'ClassMethod' ? node.key?.name : undefined;
        const scope = Object.hasOwn(scopes, key) ? scopes[key] : undefined;
        if (node.body && scope) {
          const name = JSON.stringify(scope);
          edits.push([node.body.start + 1, `const __profileScope = globalThis.__liveAdmissionProfile?.begin(${name}); try {`]);
          edits.push([node.body.end - 1, '} finally { globalThis.__liveAdmissionProfile?.end(__profileScope); }']);
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) for (const child of value) { if (child?.type) visit(child); }
          else if (value?.type) visit(value);
        }
      }
      visit(source);
      for (const [offset, insertion] of edits.sort((a, b) => b[0] - a[0])) code = code.slice(0, offset) + insertion + code.slice(offset);
      code = code.replace('const cut = structuredClone(result.cut);',
        'const __copyScope = globalThis.__liveAdmissionProfile?.begin("cut copy"); const cut = structuredClone(result.cut); globalThis.__liveAdmissionProfile?.end(__copyScope);');
      if (/orderedLiveUpdateCut\.ts(?:\?|$)/.test(id)) {
        code = code.replace('return {firstSeen: subtract(input.structuralRanges, this.structural),\n      firstSeenDeletes: subtract(normalizeRanges([...input.deleteRanges, ...input.tombstones], budget, stage), this.deletes)};',
          `const __structScope = globalThis.__liveAdmissionProfile?.begin('struct newness');
          const firstSeen = subtract(input.structuralRanges, this.structural); globalThis.__liveAdmissionProfile?.end(__structScope);
          const __deleteScope = globalThis.__liveAdmissionProfile?.begin('deletion newness');
          const firstSeenDeletes = subtract(normalizeRanges([...input.deleteRanges, ...input.tombstones], budget, stage), this.deletes);
          globalThis.__liveAdmissionProfile?.end(__deleteScope); return {firstSeen, firstSeenDeletes};`);
      }
      if (code.includes('const clients = [...new Set(firstSeen.map')) {
        code = code.replace('const clients = [...new Set(firstSeen.map', 'const __mixedScope = globalThis.__liveAdmissionProfile?.begin("mixed-client check"); const clients = [...new Set(firstSeen.map');
        code = code.replace('const window = assessLiveAuthorWindow', 'globalThis.__liveAdmissionProfile?.end(__mixedScope); const window = assessLiveAuthorWindow');
      }
      return { code, map: null };
    },
  };
}
