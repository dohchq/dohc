import { resolve, join, isAbsolute } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { DEFAULT_LIMITS } from './packaged-collection-automations.mjs';

export const SCENARIOS = ['full', 'startup', 'switches', 'small-switch', 'small-tab', 'go-to', 'command-palette', 'search', 'chat-history', 'collection', 'soak'];
export const SWITCHING_SCENARIOS = ['full', 'switches', 'small-switch', 'small-tab', 'soak'];
export const usage = `node tools/perf-profiling/packaged-benchmark.mjs --binary <dohc.exe> --package-commit <40-digit SHA> --output <new directory> --label <baseline|candidate> [--runs 3] [--idle-seconds 60] [--keystrokes 30] [--switches 10] [--files 2] [--scenario ${SCENARIOS.join('|')}] [--soak-minutes 10] [--chat-messages 200] [--records 500] [--find-cap 50] [--write-cap 200] [--profile-renderer true|false] [--profile-main true|false] [--engine-commit <40-digit SHA>]`;

export function parseOptions(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const names = new Set(['binary', 'package-dir', 'package-commit', 'engine-commit', 'output', 'label', 'runs', 'idle-seconds', 'keystrokes', 'switches', 'files', 'scenario', 'soak-minutes', 'chat-messages', 'records', 'find-cap', 'write-cap', 'profile-renderer', 'profile-main']);
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
  const options = {
    binary: resolve(args.get('binary') ?? join(args.get('package-dir'), 'dohc.exe')),
    output: resolve(args.get('output')), label: choice('label', ['baseline', 'candidate']),
    packageCommit: args.get('package-commit'), engineCommit: args.get('engine-commit') ?? args.get('package-commit'),
    runCount: integer('runs', 3), idleSeconds: integer('idle-seconds', 60), keystrokes: integer('keystrokes', 30),
    switches: integer('switches', 10), fixtureFiles: integer('files', 2, 2),
    scenario: choice('scenario', SCENARIOS, 'full'),
    soakMinutes: integer('soak-minutes', 10), chatMessages: integer('chat-messages', 200, 2), records: integer('records', 500),
    findCap: integer('find-cap', DEFAULT_LIMITS.findCap), writeCap: integer('write-cap', DEFAULT_LIMITS.writeCap),
    profileRenderer: choice('profile-renderer', ['true', 'false'], 'false') === 'true',
    profileMain: choice('profile-main', ['true', 'false'], 'false') === 'true',
  };
  for (const [key, scenario] of [['soak-minutes', 'soak'], ['chat-messages', 'chat-history'], ['records', 'collection'], ['find-cap', 'collection'], ['write-cap', 'collection']]) {
    if (args.has(key) && options.scenario !== scenario) throw Error(`--${key} requires --scenario ${scenario}`);
  }
  // go-to types fixture-004242 and search submits "fixture 4242."; both need that fixture file to exist.
  if (['go-to', 'search'].includes(options.scenario) && options.fixtureFiles < 4243) throw Error(`--scenario ${options.scenario} needs --files of at least 4243 so fixture-004242 exists`);
  if (options.profileMain && (options.scenario !== 'startup' || /\s/.test(options.output))) throw Error('--profile-main requires --scenario startup and an output path without whitespace');
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
