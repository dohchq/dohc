import { resolve, join } from 'node:path';
import { mkdir } from 'node:fs/promises';

export const usage = 'node tools/perf-profiling/packaged-benchmark.mjs --binary <dohc.exe> --package-commit <40-digit SHA> --output <new directory> --label <baseline|candidate> [--runs 3] [--idle-seconds 60] [--keystrokes 30] [--switches 10] [--files 2] [--scenario full|startup|switches|small-switch|small-tab] [--profile-renderer true|false] [--profile-main true|false] [--engine-commit <40-digit SHA>]';

export function parseOptions(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const names = new Set(['binary', 'package-dir', 'package-commit', 'engine-commit', 'output', 'label', 'runs', 'idle-seconds', 'keystrokes', 'switches', 'files', 'scenario', 'profile-renderer', 'profile-main']);
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
    scenario: choice('scenario', ['full', 'startup', 'switches', 'small-switch', 'small-tab'], 'full'),
    profileRenderer: choice('profile-renderer', ['true', 'false'], 'false') === 'true',
    profileMain: choice('profile-main', ['true', 'false'], 'false') === 'true',
  };
  if (options.profileMain && (options.scenario !== 'startup' || /\s/.test(options.output))) throw Error('--profile-main requires --scenario startup and an output path without whitespace');
  if (options.profileRenderer && options.scenario === 'startup') throw Error('--profile-renderer requires a scenario with workspace switches');
  return options;
}

export async function createEvidenceDirectory(output) {
  // The final mkdir is exclusive: two invocations cannot share a profile.
  await mkdir(resolve(output, '..'), { recursive: true });
  await mkdir(output);
}
