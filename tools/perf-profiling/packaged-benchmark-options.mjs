import { resolve, join, isAbsolute } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { DOCUMENT_SIZES } from './document-size-fixtures.mjs';
import { DEFAULT_LIMITS } from './packaged-collection-automations.mjs';

export const SCENARIOS = ['full', 'startup', 'switches', 'small-switch', 'small-tab', 'go-to', 'go-to-mixed', 'command-palette', 'search', 'chat-history', 'collection', 'presence', 'soak', 'document-size', 'link-rename'];
export const SWITCHING_SCENARIOS = ['full', 'switches', 'small-switch', 'small-tab', 'soak'];
export const usage = `node tools/perf-profiling/packaged-benchmark.mjs --binary <dohc.exe> --package-commit <40-digit SHA> --output <new directory> --label <baseline|candidate> [--runs <count>] [--idle-seconds 60] [--keystrokes 30] [--switches 10] [--files 2] [--scenario ${SCENARIOS.join('|')}] [--soak-minutes 10] [--heap-snapshot-minutes 10,60] [--chat-messages 200] [--presence-peers 2] [--records 500] [--find-cap 50] [--write-cap 200] [--profile-renderer true|false] [--profile-main true|false] [--typing-trace true|false] [--engine-commit <40-digit SHA>]
Link rename: [--links 2000] [--files 5000]. Runs unrelated and linking rich-document typing during separate renames and Undos.\nDocument size: [--document-mib 2,5,8,10] [--relay-sessions 1,2,4] [--updates-per-second 8] [--churn-edits 100000] [--relay-checkout <matching checkout>] [--document-mode gate|pilot|dry-run] [--baseline <completed baseline output directory>]. Gate mode uses 10/20 worst-shape pairs, 3-pair shape proofs, at most one extension per size and one adaptive 60-minute soak, within a six-hour deadline. A gated candidate needs --baseline: its 2 MiB decisions use that receipt, as the comparison does. Dry-run needs no binary on disk and launches nothing.\nRuns default to 20 for document-size, 5 for collection and presence, and 3 for other scenarios.
Heap snapshot minutes are distinct positive integers within the soak duration. Capture is opt-in and diagnostic.`;

export function parseOptions(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const names = new Set(['binary', 'package-dir', 'package-commit', 'engine-commit', 'output', 'label', 'runs', 'idle-seconds', 'keystrokes', 'switches', 'files', 'scenario', 'soak-minutes', 'heap-snapshot-minutes', 'chat-messages', 'records', 'presence-peers', 'find-cap', 'write-cap', 'profile-renderer', 'profile-main', 'typing-trace', 'document-mib', 'relay-sessions', 'updates-per-second', 'churn-edits', 'relay-checkout', 'document-mode', 'baseline', 'links']);
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].slice(2), value = argv[i + 1];
    if (!argv[i].startsWith('--') || !names.has(key)) throw Error(`Unknown option: ${argv[i]}`);
    if (args.has(key)) throw Error(`Duplicate option: --${key}`);
    if (!value || value.startsWith('--')) throw Error(`Missing value: --${key}`);
    args.set(key, value);
  }
  for (const key of ['output', 'label', 'package-commit']) if (!args.has(key)) throw Error(`Required option: --${key}`);
  if (Number(args.has('binary')) + Number(args.has('package-dir')) !== 1) throw Error('Provide exactly one of --binary or --package-dir');
  const choice = (key, choices, fallback) => {
    const value = args.get(key) ?? fallback;
    if (!choices.includes(value)) throw Error(`--${key} must be ${choices.join('|')}`);
    return value;
  };
  const integer = (key, fallback, minimum = 1) => {
    const value = args.get(key) ?? String(fallback);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) throw Error(`--${key} must be an integer of at least ${minimum}`);
    return Number(value);
  };
  for (const key of ['package-commit', 'engine-commit']) {
    if (args.has(key) && !/^[a-f\d]{40}$/i.test(args.get(key))) throw Error(`--${key} must be a full Git commit SHA`);
  }
  const scenario = choice('scenario', SCENARIOS, 'full');
  const options = {
    binary: resolve(args.get('binary') ?? join(args.get('package-dir'), process.platform === 'darwin' ? 'Contents/MacOS/dohc' : 'dohc.exe')),
    output: resolve(args.get('output')), label: choice('label', ['baseline', 'candidate']),
    packageCommit: args.get('package-commit'), engineCommit: args.get('engine-commit') ?? args.get('package-commit'),
    runCount: integer('runs', scenario === 'document-size' ? 20 : ['collection', 'presence'].includes(scenario) ? 5 : 3), idleSeconds: integer('idle-seconds', 60), keystrokes: integer('keystrokes', scenario === 'document-size' ? 60 : 30),
    switches: integer('switches', 10), fixtureFiles: integer('files', scenario === 'link-rename' ? 5000 : 2, 2), links: integer('links', 2000, 0),
    scenario, presencePeers: integer('presence-peers', 2, 2), heapSnapshotMinutes: [],
    soakMinutes: integer('soak-minutes', scenario === 'document-size' ? 60 : 10), chatMessages: integer('chat-messages', 200, 2), records: integer('records', 500),
    findCap: integer('find-cap', DEFAULT_LIMITS.findCap), writeCap: integer('write-cap', DEFAULT_LIMITS.writeCap),
    profileRenderer: choice('profile-renderer', ['true', 'false'], 'false') === 'true',
    profileMain: choice('profile-main', ['true', 'false'], 'false') === 'true',
    typingTrace: choice('typing-trace', ['true', 'false'], 'false') === 'true',
  };
  if (scenario === 'document-size') {
    const list = (key, fallback, allowed) => {
      const raw = args.get(key) ?? fallback;
      const values = raw.split(',').map(Number);
      if (!/^\d+(,\d+)*$/.test(raw) || new Set(values).size !== values.length || values.some(value => !allowed.includes(value))) throw Error('--' + key + ' has unsupported or duplicate values');
      return values.sort((a,b) => a-b);
    };
    options.documentMiB = list('document-mib', '2,5,8,10', DOCUMENT_SIZES);
    options.relaySessions = list('relay-sessions', '1,2,4', [1,2,4]);
    options.updatesPerSecond = integer('updates-per-second', 8);
    options.churnEdits = integer('churn-edits', 100000);
    options.relayCheckout = resolve(args.get('relay-checkout') ?? '.');
    options.documentMode = choice('document-mode', ['gate','pilot','dry-run'], 'gate');
    options.baseline = args.has('baseline') ? resolve(args.get('baseline')) : null;
    if (options.documentMode === 'gate' && (options.runCount !== 20 || options.keystrokes < 60 || options.churnEdits < 100000 || options.soakMinutes < 60 || options.updatesPerSecond !== 8 || options.relaySessions.join(',') !== '1,2,4' || options.documentMiB.join(',') !== '2,5,8,10')) throw Error('Document-size gating requires the complete reduced matrix, 60 keys, 100000 edits, 60-minute soaks and 1/2/4 sessions at 8 updates/s');
    if (options.label === 'baseline' ? options.baseline : options.documentMode === 'gate' && !options.baseline) throw Error('A gated document-size candidate needs --baseline, and a baseline takes none');
  } else {
    for (const key of ['document-mib','relay-sessions','updates-per-second','churn-edits','relay-checkout','document-mode','baseline']) if (args.has(key)) throw Error('--' + key + ' requires --scenario document-size');
  }
  for (const [key, requiredScenario] of [['presence-peers', 'presence'], ['soak-minutes', 'soak'], ['chat-messages', 'chat-history'], ['records', 'collection'], ['find-cap', 'collection'], ['write-cap', 'collection']]) {
    if (args.has(key) && options.scenario !== requiredScenario && !(key === 'soak-minutes' && scenario === 'document-size')) throw Error(`--${key} requires --scenario ${requiredScenario}`);
  }
  if (scenario === 'presence' && options.runCount < 5) throw Error('--scenario presence needs at least 5 runs');
  if (args.has('links') && scenario !== 'link-rename') throw Error('--links requires --scenario link-rename');
  if (scenario === 'link-rename' && (options.fixtureFiles < 5000 || options.links > options.fixtureFiles - 2)) throw Error('link-rename needs at least 5000 files and room for its target and unrelated document');
  if (scenario === 'presence' && options.presencePeers > 8) throw Error('--presence-peers must be at most 8 within the fixture connection budget');
  if (args.has('heap-snapshot-minutes')) {
    if (scenario !== 'soak') throw Error('--heap-snapshot-minutes requires --scenario soak');
    const value = args.get('heap-snapshot-minutes');
    const minutes = value.split(',').map(Number);
    if (!/^[1-9]\d*(,[1-9]\d*)*$/.test(value) || new Set(minutes).size !== minutes.length ||
        minutes.some(minute => !Number.isSafeInteger(minute) || minute > options.soakMinutes)) {
      throw Error('--heap-snapshot-minutes must be distinct positive integer minutes within --soak-minutes');
    }
    options.heapSnapshotMinutes = minutes.sort((a, b) => a - b);
  }
  // go-to types fixture-004242 and search submits "fixture 4242."; both need that fixture file to exist.
  if (['go-to', 'search'].includes(options.scenario) && options.fixtureFiles < 4243) throw Error(`--scenario ${options.scenario} needs --files of at least 4243 so fixture-004242 exists`);
  if (options.scenario === 'go-to-mixed' && options.fixtureFiles < 5000) throw Error('--scenario go-to-mixed needs --files of at least 5000 for its generated sources and fixture-004242');
  if (options.profileMain && (options.scenario !== 'startup' || /\s/.test(options.output))) throw Error('--profile-main requires --scenario startup and an output path without whitespace');
  if (options.typingTrace && options.scenario !== 'full') throw Error('--typing-trace requires --scenario full');
  if (options.profileRenderer && !SWITCHING_SCENARIOS.includes(options.scenario)) throw Error('--profile-renderer requires a scenario with workspace switches');
  return options;
}

export async function createEvidenceDirectory(output) {
  // The final mkdir is exclusive: two invocations cannot share a profile.
  await mkdir(resolve(output, '..'), { recursive: true });
  await mkdir(output);
}

export function packagedLaunchArgs(profile, diagnosticArgs = []) {
  if (!isAbsolute(profile)) throw Error('A packaged rehearsal requires an absolute profile path');
  return [`--user-data-dir=${profile}`, '--dohc-isolated-test', '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1', '--enable-logging', ...diagnosticArgs];
}

export function benchmarkEnvironment(inherited, updateUrl) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([name]) =>
    !name.toUpperCase().startsWith('DOHC_') && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(name.toUpperCase())
  ));
  return { ...env, DOHC_UPDATE_URL: updateUrl };
}
