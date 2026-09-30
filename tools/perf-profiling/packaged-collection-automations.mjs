import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { classifyProcess, recordId } from './packaged-surfaces.mjs';

// The automation phase of the packaged `collection` scenario. It seeds one document Collection and one
// generated dataset Collection with the same records, gives each Collection one Button field and one
// automation per case, and presses each case's button on a trigger record in the running package.
// Seeding creates no runs, because only a press starts one. Everything here except observeAutomationRun
// runs in the harness; observeAutomationRun is serialized into the renderer.

export const DOCUMENT_FOLDER = 'automation-bench';
export const DATASET_FOLDER = 'automation-data';
const DATASET_PATH = `${DATASET_FOLDER}/dataset.json`;
export const DATASET_NAME = 'Automation bench';
// The trigger record sorts first in both tables: documents order by file path, datasets by primary key.
export const TRIGGER = {
  document: { path: `${DOCUMENT_FOLDER}/0-trigger.md`, label: 'Trigger' },
  dataset: { id: '0-trigger', label: 'record 0-trigger' },
};
// A case that runs longer than the executor's five-minute attempt deadline has failed.
export const CASE_TIMEOUT_MS = 300_000;
// The limits the package under test enforces. They decide which cases the harness expects the package to
// refuse. Pass the candidate's limits to measure a package that raises them.
export const DEFAULT_LIMITS = { findCap: 50, writeCap: 200 };
// A refusal names the limit it hit; any other failure fails the case.
export const LIMIT_REFUSAL = /matched more than \d+ records|would change more than \d+ fields|more data than dohc can save/;

const FIELDS = [['Name', 'text'], ['Case', 'text'], ['N', 'number'], ['A', 'number'], ['B', 'number'], ['C', 'number'], ['D', 'number'],
  ['Stage', 'text'], ['Seen', 'checkbox'], ['F1', 'checkbox'], ['F2', 'checkbox'], ['F3', 'checkbox'], ['F4', 'checkbox'], ['F5', 'checkbox'],
  ['Hit', 'checkbox'], ['Last', 'number'], ['Notes', 'text']];
const FIELD_NAMES = FIELDS.map(([name]) => name);
// 50 wide records put about 200 KB of Notes in the formula scope, under its 256 KiB bound, and the
// literal they receive is under the 4,000-character bound on text in automations.yaml.
const WIDE_NOTE_CHARS = 4000;
const WIDE_SET_CHARS = 3900;
export const wideNote = n => `Record ${n}. `.padEnd(WIDE_NOTE_CHARS, 'abcdefghij');
export const WIDE_SET = 'Updated. '.padEnd(WIDE_SET_CHARS, '0123456789');

const numbered = count => Array.from({ length: count }, (_, index) => index + 1);
const find = (as, field, value) => ({ find: { field, value }, as });
const set = (records, values) => ({ set: values, records });
const changed = values => seed => ({ ...seed, ...values(seed) });
// Each fifth of the 300 five-finds records moves the window by 50, so each record is in one or two Finds.
const windows = [1, 2, 3, 4, 5].map(k => ({ k, from: (k - 1) * 50 + 1, to: (k - 1) * 50 + 100 }));

/**
 * The cases, in the order the harness presses them. `seed` lists the case's records by `N`. `expect`
 * returns every record's final values after a run that did its work, for the step visibility the run
 * showed: 'run-start' reads records as they were when the run started, 'stepwise' reads each step's
 * input after the steps before it. Only set-then-find and add-then-find tell the two apart. A case
 * the package refuses must leave every record as seeded and add none.
 */
export function automationCases({ findCap, writeCap }) {
  const baseline = (name, contention = false) => ({ name, contention, matches: 50, assignments: 200,
    seed: numbered(50).map(n => ({ N: n })),
    steps: [find('found', 'Case', name), set('found', { A: 1, B: 2, C: '=record.N * 2', D: '=record.N + 1' })],
    expect: records => ({ records: records.map(changed(r => ({ A: 1, B: 2, C: r.N * 2, D: r.N + 1 }))), added: [] }) });
  const fiveHundred = (name, contention = false) => ({ name, contention, matches: 500, assignments: 1000,
    seed: numbered(500).map(n => ({ N: n })),
    steps: [find('found', 'Case', name), set('found', { A: 1, C: '=record.N * 2' })],
    expect: records => ({ records: records.map(changed(r => ({ A: 1, C: r.N * 2 }))), added: [] }) });
  const cap = (name, count) => ({ name, matches: count, assignments: count,
    seed: numbered(count).map(n => ({ N: n })),
    steps: [find('found', 'Case', name), set('found', { A: 1 })],
    expect: records => ({ records: records.map(changed(() => ({ A: 1 }))), added: [] }) });
  const cases = [
    baseline('baseline'),
    fiveHundred('find-500'),
    { name: 'five-finds', matches: 100, assignments: 1000,
      seed: numbered(300).map(n => ({ N: n, ...Object.fromEntries(windows.filter(w => n >= w.from && n <= w.to).map(w => [`F${w.k}`, true])) })),
      steps: windows.flatMap(({ k }) => [find(`f${k}`, `F${k}`, true), set(`f${k}`, { Hit: true, Last: k })]),
      expect: records => ({ records: records.map(changed(r => ({ Hit: true, Last: Math.max(...windows.filter(w => r[`F${w.k}`]).map(w => w.k)) }))), added: [] }) },
    // The first Find's records move into the second Find's condition. Read at run start, the second
    // Find sees only the 20 records that began there.
    { name: 'set-then-find', matches: 40, assignments: 60, visibility: true,
      seed: numbered(40).map(n => ({ N: n, Stage: n <= 20 ? 'stf-a' : 'stf-b' })),
      steps: [find('moved', 'Stage', 'stf-a'), set('moved', { Stage: 'stf-b' }), find('staged', 'Stage', 'stf-b'), set('staged', { Seen: true })],
      expect: (records, visibility) => ({ records: records.map(changed(r => ({ Stage: 'stf-b', ...(visibility === 'stepwise' || r.Stage === 'stf-b' ? { Seen: true } : {}) }))), added: [] }) },
    // The Find after Add includes the added record only when steps read each other's changes.
    { name: 'add-then-find', matches: 11, assignments: 15, visibility: true,
      seed: numbered(10).map(n => ({ N: n, Stage: 'atf' })),
      steps: [{ add: { Name: 'Added', Case: 'add-then-find', Stage: 'atf', N: 11 }, as: 'added' }, find('matched', 'Stage', 'atf'), set('matched', { Seen: true })],
      expect: (records, visibility) => ({ records: records.map(changed(() => ({ Seen: true }))),
        added: [{ Name: 'Added', Case: 'add-then-find', Stage: 'atf', N: 11, ...(visibility === 'stepwise' ? { Seen: true } : {}) }] }) },
    cap('find-at-cap', findCap),
    cap('find-over-cap', findCap + 1),
    { name: 'wide', matches: 50, assignments: 100,
      seed: numbered(50).map(n => ({ N: n, Notes: wideNote(n) })),
      steps: [find('found', 'Case', 'wide'), set('found', { Notes: WIDE_SET, C: '=record.N * 2' })],
      expect: records => ({ records: records.map(changed(r => ({ Notes: WIDE_SET, C: r.N * 2 }))), added: [] }) },
    // The typing workload runs while these two run.
    baseline('baseline-typing', true),
    fiveHundred('find-500-typing', true),
  ];
  return cases.map(spec => {
    const seed = spec.seed.map(values => ({ Name: `${spec.name} ${values.N}`, Case: spec.name, ...values }));
    const expected = spec.matches > findCap || spec.assignments > writeCap ? 'refused' : 'done';
    // Two receipts measured the same case only when its records, steps, and expected outcome match.
    const fixtureSha256 = createHash('sha256').update(JSON.stringify([spec.name, seed, spec.steps, expected])).digest('hex');
    return { contention: false, visibility: false, ...spec, seed, expected, fixtureSha256 };
  });
}

const yamlText = value => JSON.stringify(value);
const findCondition = ({ field, value }) => `record.${field} == ${JSON.stringify(value)}`;
const OPERATIONS = { find: 'records.list', set: 'records.edit', add: 'records.create' };

/** automations.yaml for either kind: a dataset step also names the approved operation it invokes. */
export function automationsYaml(cases, kind) {
  const operation = step => kind === 'dataset' ? [`        operation: ${yamlText(OPERATIONS[step])}`] : [];
  const values = entries => Object.entries(entries).map(([field, value]) => `          ${yamlText(field)}: ${yamlText(value)}`);
  const lines = ['version: 1', 'automations:'];
  for (const spec of cases) {
    lines.push(`  - id: ${yamlText(`bench-${spec.name}`)}`, `    name: ${yamlText(spec.name)}`, '    when:', `      button: ${yamlText(spec.name)}`, '    do:');
    for (const step of spec.steps) {
      if (step.find) lines.push(`      - find: ${yamlText(findCondition(step.find))}`, `        as: ${step.as}`, ...operation('find'));
      else if (step.set) lines.push('      - set:', ...values(step.set), `        records: ${step.records}`, ...operation('set'));
      else lines.push('      - add-record:', ...values(step.add), `        as: ${step.as}`, ...operation('add'));
    }
  }
  return `${lines.join('\n')}\n`;
}

/** A case's automation: its Collection folder and its name in automations.yaml. */
export function automationOf(kind, name) {
  return { collectionPath: kind === 'document' ? DOCUMENT_FOLDER : DATASET_FOLDER, name: `bench-${name}` };
}

const frontmatter = values => Object.entries(values).map(([key, value]) => `${key}: ${yamlText(value)}`).join('\n');
const documentPath = (name, n) => `${DOCUMENT_FOLDER}/${name}-${String(n).padStart(4, '0')}.md`;

/**
 * The document Collection: its schema and automations first, then the trigger record, then every
 * case's records with pre-minted ids. The table shows only the name and the buttons.
 */
export function documentAutomationFiles(cases) {
  const schema = ['name: Automation bench', 'fields:', ...FIELDS.flatMap(([name, type]) => [`  ${yamlText(name)}:`, `    type: ${type}`]),
    ...cases.flatMap(({ name }) => [`  ${yamlText(name)}:`, '    type: button']),
    'views:', '  - name: Table', '    kind: table', `    visibleFields: ${yamlText(['Name', ...cases.map(({ name }) => name)])}`, ''].join('\n');
  const record = (path, values) => ({ path, content: `---\nid: ${recordId(path)}\n${frontmatter(values)}\n---\n# ${values.Name}\n` });
  return [
    { path: `${DOCUMENT_FOLDER}/collection.yaml`, content: schema },
    { path: `${DOCUMENT_FOLDER}/automations.yaml`, content: automationsYaml(cases, 'document') },
    record(TRIGGER.document.path, { Name: TRIGGER.document.label, Case: 'trigger' }),
    ...cases.flatMap(spec => spec.seed.map(values => record(documentPath(spec.name, values.N), values))),
  ];
}

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DATASET_ID = uuid(1), TABLE_ID = uuid(2), ID_FIELD = uuid(10);
const fieldIdOf = new Map(FIELDS.map(([name], index) => [name, uuid(11 + index)]));
const OPERATION_IDS = { list: uuid(200), create: uuid(201), edit: uuid(202) };

/** The generated dataset: one table with the same fields, an id key, the case buttons, and generated list, create, and edit operations. */
export function datasetAutomationDefinition(cases) {
  const columns = FIELDS.map(([name, type]) => ({ fieldId: fieldIdOf.get(name), name, sqlColumn: name === 'Case' ? 'bench_case' : name.toLowerCase(), type, required: false, unique: false }));
  const all = columns.map(field => field.fieldId);
  return {
    formatVersion: 1, datasetId: DATASET_ID, name: DATASET_NAME, schemaPath: `${DATASET_FOLDER}/schema.sql`, operationsPath: `${DATASET_FOLDER}/operations.js`,
    // The Explorer lists a dataset by its table's name.
    tables: [{ tableId: TABLE_ID, name: DATASET_NAME, sqlName: 'records', primaryKey: 'id', fields: [
      { fieldId: ID_FIELD, name: 'ID', sqlColumn: 'id', type: 'text', required: true, unique: true }, ...columns,
      ...cases.map(({ name }, index) => ({ fieldId: uuid(100 + index), name, type: 'button' })),
    ] }],
    operations: [
      { operationId: OPERATION_IDS.list, name: OPERATIONS.find, label: 'View', tableId: TABLE_ID, kind: 'read', access: 'owner', readOnly: true, fieldIds: [ID_FIELD, ...all] },
      { operationId: OPERATION_IDS.create, name: OPERATIONS.add, label: 'Create', tableId: TABLE_ID, kind: 'create', access: 'owner', readOnly: false, fieldIds: [ID_FIELD, ...all] },
      { operationId: OPERATION_IDS.edit, name: OPERATIONS.set, label: 'Edit', tableId: TABLE_ID, kind: 'edit', access: 'owner', readOnly: false, fieldIds: all },
    ],
  };
}

const byFieldId = values => Object.fromEntries(Object.entries(values).map(([name, value]) => [fieldIdOf.get(name), value]));

/** What the harness asks dataset-cli.mjs to create: the definition, then the trigger and every case's records through the create operation. */
export function datasetSetupRequest(cases, workspaceId) {
  const row = (id, values) => ({ [ID_FIELD]: id, ...byFieldId(values) });
  return { mode: 'setup', workspaceId, datasetPath: DATASET_PATH, definition: datasetAutomationDefinition(cases), createOperationId: OPERATION_IDS.create, idFieldId: ID_FIELD,
    records: [row(TRIGGER.dataset.id, { Name: 'Trigger', Case: 'trigger' }), ...cases.flatMap(spec => spec.seed.map(values => row(`${spec.name}-${String(values.N).padStart(4, '0')}`, values)))] };
}

/** What the harness asks dataset-cli.mjs to list: one case's records, read through the approved list operation. */
export function datasetListRequest(setup, workspaceId, name) {
  return { mode: 'list', workspaceId, datasetPath: DATASET_PATH, datasetId: setup.datasetId, revision: setup.revision, revisionSha256: setup.revisionSha256,
    operationId: OPERATION_IDS.list, filters: [{ fieldId: fieldIdOf.get('Case'), value: name }] };
}

/** A listed dataset row's values by field name. */
export function datasetRowValues(row) {
  return Object.fromEntries(FIELD_NAMES.map(name => [name, row.values[fieldIdOf.get(name)] ?? null]));
}

/** One digest over both Collections' fixtures and the cases' expectations, for the receipt. */
export function automationFixtureDigest(cases) {
  const hash = createHash('sha256');
  for (const file of documentAutomationFiles(cases)) hash.update(`${file.path}\0${file.content}\0`);
  hash.update(JSON.stringify(datasetSetupRequest(cases, '')));
  hash.update(automationsYaml(cases, 'dataset'));
  hash.update(JSON.stringify(cases.map(({ name, expected, matches, assignments }) => [name, expected, matches, assignments])));
  return hash.digest('hex');
}

/** A document record's frontmatter values, parsed with js-yaml's `load`, or null for a file without frontmatter. */
export function documentValues(text, load) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  const parsed = load(match[1]);
  return parsed && typeof parsed === 'object' ? Object.fromEntries(FIELD_NAMES.map(name => [name, parsed[name] ?? null])) : null;
}

/**
 * A case's document records, read from disk: the files the harness seeded for it, and the workspace
 * paths its runs saved for records an Add step created. A seeded file that is gone reads as missing.
 */
export async function readDocumentCase(workspaceRoot, spec, load, createdPaths = []) {
  const records = [];
  for (const path of [...spec.seed.map(values => documentPath(spec.name, values.N)), ...createdPaths]) {
    const text = await readFile(join(workspaceRoot, path), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const values = text === null ? null : documentValues(text, load);
    if (values?.Case === spec.name) records.push(values);
  }
  return records;
}

const shown = value => { const text = JSON.stringify(value) ?? 'undefined'; return text.length > 40 ? `${text.slice(0, 37)}...` : text; };
function compareRecords(expected, actual) {
  const problems = [];
  const found = new Map();
  for (const record of actual) {
    if (found.has(record.N)) problems.push(`N ${record.N} appears twice`);
    found.set(record.N, record);
  }
  for (const record of expected) {
    const current = found.get(record.N);
    found.delete(record.N);
    if (!current) { problems.push(`N ${record.N} is missing`); continue; }
    for (const field of FIELD_NAMES) {
      if ((current[field] ?? null) !== (record[field] ?? null)) problems.push(`N ${record.N} ${field} is ${shown(current[field] ?? null)}, expected ${shown(record[field] ?? null)}`);
    }
  }
  for (const n of found.keys()) problems.push(`N ${n} was not expected`);
  return problems;
}

/**
 * Checks a case's final records against the outcome the run showed. A refused run must leave every
 * record as seeded. A finished run must match `expect` for one step visibility; a case that cannot
 * tell the visibilities apart reports null.
 */
export function verifyCase(spec, outcome, actual) {
  if (outcome !== 'done') {
    const problems = compareRecords(spec.seed, actual);
    return { ok: problems.length === 0, visibility: null, problems: problems.slice(0, 10), problemCount: problems.length };
  }
  const attempts = (spec.visibility ? ['run-start', 'stepwise'] : [null]).map(visibility => {
    const { records, added } = spec.expect(spec.seed, visibility);
    return { visibility, problems: compareRecords([...records, ...added], actual) };
  });
  const best = attempts.find(attempt => attempt.problems.length === 0) ?? attempts.at(-1);
  return { ok: best.problems.length === 0, visibility: best.visibility, problems: best.problems.slice(0, 10), problemCount: best.problems.length };
}

/** The outcome a press's settle text shows: done, skipped, ended, refused by a limit, or failed. */
export function classifyOutcome(observed) {
  if (observed.outcome !== 'failed') return observed.outcome;
  return LIMIT_REFUSAL.test(observed.text ?? '') ? 'refused' : 'failed';
}

/** The words the renderer shows when a press's run settles, as useAutomationButtons writes them. */
export function outcomeTexts(field, label) {
  return { done: [`Ran ${field} on ${label}`], skipped: [`${field} made no changes to ${label}`], ended: [`${field} finished on ${label}`],
    failed: [`${field} did not finish.`, `${field} did not start.`] };
}

/**
 * The folder and engine id of an automation's saved runs, or null before its first run saves. The engine names
 * a Collection by an object id the harness cannot know in advance, so this matches a saved header by the
 * Collection's path and the automation's name.
 */
async function runFolder(workspaceRoot, automation) {
  const root = join(workspaceRoot, '.dohc', 'automations', 'runs');
  let folders;
  try { folders = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const folder of folders) {
    const headers = (await readdir(join(root, folder)).catch(() => [])).filter(file => file.endsWith('.json'));
    for (const file of headers) {
      // A header being rewritten reads as unparseable for a moment; the next sample sees it.
      const header = await readFile(join(root, folder, file), 'utf8').then(text => JSON.parse(text)).catch(() => null);
      const collection = header?.collections?.find(entry => entry.path === automation.collectionPath);
      if (collection && header.automationId === `collection:${collection.collectionId}#${automation.name}`) return { folder: join(root, folder), automationId: header.automationId };
    }
  }
  return null;
}

/** The byte sizes of a case's saved runs now: headers and progress files. Cheap enough to sample while a run works. */
export async function journalBytes(workspaceRoot, automation) {
  const found = await runFolder(workspaceRoot, automation);
  const sizes = { headerBytes: 0, progressBytes: 0 };
  if (!found) return sizes;
  const { folder } = found;
  let files;
  try { files = await readdir(folder); } catch (error) { if (error.code === 'ENOENT') return sizes; throw error; }
  for (const file of files) {
    const size = await stat(join(folder, file)).then(entry => entry.size, error => { if (error.code === 'ENOENT') return 0; throw error; });
    if (file.endsWith('.progress.jsonl')) sizes.progressBytes += size;
    else if (file.endsWith('.json')) sizes.headerBytes += size;
  }
  return sizes;
}

/**
 * A case's saved runs, as the executor left them in <workspace>/.dohc/automations. The header's
 * startedAtMs is when the executor created the run, before any Find; finishedAtMs is when it settled.
 * A run refused before it saves a header leaves nothing.
 */
export async function readRunJournal(workspaceRoot, automation) {
  const found = await runFolder(workspaceRoot, automation);
  if (!found) return [];
  const { folder, automationId } = found;
  let files;
  try { files = await readdir(folder); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const runs = [];
  for (const file of files.filter(name => name.endsWith('.json'))) {
    const headerText = await readFile(join(folder, file), 'utf8');
    const header = JSON.parse(headerText);
    if (header.automationId !== automationId) continue;
    const progressText = await readFile(join(folder, `${file.slice(0, -'.json'.length)}.progress.jsonl`), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    const lines = progressText.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const writes = lines.filter(line => line.kind === 'effect').flatMap(line => line.writes);
    runs.push({ claimId: header.claimId, startedAtMs: header.startedAtMs, finishedAtMs: header.finishedAtMs, outcome: header.outcome,
      headerBytes: Buffer.byteLength(headerText), progressBytes: Buffer.byteLength(progressText), progressLines: lines.length,
      fieldWrites: writes.reduce((sum, write) => sum + (write.kind === 'field' ? 1 : write.kind === 'dataset-edit' ? write.fields.length : 0), 0),
      created: lines.filter(line => line.kind === 'created').length + writes.filter(write => write.kind === 'dataset-created').length,
      createdPaths: lines.filter(line => line.kind === 'created').map(line => line.path) });
  }
  return runs.sort((a, b) => a.startedAtMs - b.startedAtMs);
}

/** CPU milliseconds each process kind spent between two snapshots. A process born between them counts from zero. */
export function cpuByKind(before, after, appPid) {
  const earlier = new Map(before.processes.map(process => [`${process.pid}:${process.createdAt}`, process.cpuMs]));
  const kinds = {};
  for (const process of after.processes) {
    const kind = classifyProcess(process, appPid);
    kinds[kind] = (kinds[kind] ?? 0) + process.cpuMs - (earlier.get(`${process.pid}:${process.createdAt}`) ?? 0);
  }
  return kinds;
}

/** The largest working set and private bytes each process kind held in any one snapshot. */
export function peakByKind(snapshots, appPid) {
  const peaks = {};
  for (const snapshot of snapshots) {
    const totals = {};
    for (const process of snapshot.processes) {
      const bucket = totals[classifyProcess(process, appPid)] ??= { workingSetBytes: 0, privateBytes: 0 };
      bucket.workingSetBytes += process.workingSetBytes; bucket.privateBytes += process.privateBytes;
    }
    for (const [kind, bucket] of Object.entries(totals)) {
      const peak = peaks[kind] ??= { workingSetBytes: 0, privateBytes: 0 };
      peak.workingSetBytes = Math.max(peak.workingSetBytes, bucket.workingSetBytes);
      peak.privateBytes = Math.max(peak.privateBytes, bucket.privateBytes);
    }
  }
  return peaks;
}

/** The share of one logical core that main and the engine used between two snapshots. */
export function busyShare(before, after, appPid) {
  const elapsed = after.completedAtMs - before.completedAtMs;
  const cpu = cpuByKind(before, after, appPid);
  return elapsed > 0 ? ((cpu.main ?? 0) + (cpu.engine ?? 0)) / elapsed : Infinity;
}

/**
 * Waits until main and the engine stay under `share` of one core for `intervals` consecutive
 * intervals of at least `intervalMs`, so a case starts after earlier indexing and settlement. Returns
 * the last snapshot, which the case then measures from.
 */
export async function waitForQuiet({ sample, appPid, share = 0.05, intervals = 3, intervalMs = 1000, timeoutMs = 120_000, signal }) {
  const started = performance.now();
  let previous = await sample(), quiet = 0, last = null;
  while (quiet < intervals) {
    if (performance.now() - started > timeoutMs) throw Error(`The app did not settle within ${timeoutMs}ms: main and engine used ${Math.round((last ?? 1) * 100)}% of a core`);
    signal?.throwIfAborted();
    const next = await sample();
    const elapsed = next.completedAtMs - previous.completedAtMs;
    if (elapsed < intervalMs) { await delay(intervalMs - elapsed, undefined, { signal }); continue; }
    last = busyShare(previous, next, appPid);
    quiet = last < share ? quiet + 1 : 0;
    previous = next;
  }
  return { snapshot: previous, waitedMs: performance.now() - started, busyShare: last };
}

// Serialized into the renderer: keep it self-contained, with no module-scope references.
// Installed before the press. It records the first mousedown on the button named `button`, then waits
// for text that says how the run settled: a node added after the press, or text that changed, inside the
// toast stack or the Notices panel, that contains one of `texts`. Text elsewhere on the page, such as
// a record whose value names the case, does not count. The completion time is the first animation-frame callback after that match.
// Long tasks between installation and completion are returned with the result.
export function observeAutomationRun({ button, texts, timeoutMs }) {
  const SETTLE_SCOPE = '[data-testid="notice-toasts"], [data-testid="notice-center"]';
  const installedMs = performance.now(), installedEpochMs = Date.now();
  return new Promise((resolve, reject) => {
    let finished = false, triggerMs = null, triggerTrusted = null, matched = null, frame = null;
    const longTasks = [];
    const task = entry => ({ startTime: entry.startTime, duration: entry.duration });
    const longObserver = typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('longtask')
      ? new PerformanceObserver(list => longTasks.push(...list.getEntries().map(task))) : null;
    const onDown = event => {
      if (triggerMs !== null) return;
      const pressed = event.target instanceof Element ? event.target.closest('button') : null;
      if (pressed?.getAttribute('aria-label') !== button) return;
      triggerMs = performance.now(); triggerTrusted = event.isTrusted;
    };
    const outcomeOf = text => Object.keys(texts).find(outcome => texts[outcome].some(phrase => text.includes(phrase))) ?? null;
    const finish = (error, paintedMs = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline); observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener('mousedown', onDown, true);
      if (longObserver) { longTasks.push(...longObserver.takeRecords().map(task)); longObserver.disconnect(); }
      if (error) reject(error);
      else resolve({ timeOrigin: performance.timeOrigin, installedMs, installedEpochMs, triggerMs, triggerTrusted, ...matched, paintedMs, longTasks });
    };
    const check = node => {
      if (finished || matched || triggerMs === null) return;
      const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      if (!element?.closest?.(SETTLE_SCOPE)) return;
      const text = element.textContent ?? '';
      const outcome = outcomeOf(text);
      if (!outcome) return;
      matched = { outcome, matchedMs: performance.now(), text: text.trim().slice(0, 500) };
      frame = requestAnimationFrame(() => { frame = null; finish(null, performance.now()); });
    };
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'characterData') check(record.target);
        else for (const node of record.addedNodes) check(node);
      }
    });
    const deadline = setTimeout(() => finish(Error(`${button} did not settle within ${timeoutMs}ms`)), timeoutMs);
    longObserver?.observe({ type: 'longtask' });
    window.addEventListener('mousedown', onDown, true);
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  });
}
