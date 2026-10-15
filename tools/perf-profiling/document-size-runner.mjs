import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { run as runOwnedCommand } from '../../scripts/verification/process.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runRelayCase, measureChurn } from './document-size-relay.mjs';
import { documentMatrix, runtimeEstimate } from './document-size-fixtures.mjs';

// Each relay arm has its own process: prior proof clients and offline churn
// cannot leave committed heap pages in a later arm's private-byte measurement.
async function isolatedCase(input) {
  await mkdir(input.directory, { recursive: true });
  const settingsPath = join(input.directory, 'case-settings.json');
  const { signal, ...serializable } = input;
  await writeFile(settingsPath, JSON.stringify(serializable));
  const require = createRequire(join(input.checkout, 'services/sync-relay/package.json'));
  await runOwnedCommand(
    process.execPath,
    ['--import', pathToFileURL(require.resolve('tsx')).href, fileURLToPath(import.meta.url), 'case', settingsPath],
    {
      cwd: input.checkout,
      signal,
      timeoutMs: input.timeoutMs ?? 60 * 60 * 1000,
      log: join(input.directory, 'case.log'),
    },
  );
  return JSON.parse(await readFile(join(input.directory, 'relay-result.json'), 'utf8'));
}

// Run in an owned Node child, so relay CPU/RSS and its two worker heaps exclude the GUI.
export async function relayEntry(input) {
  const rows = [],
    churn = [],
    churnedCases = [];
  const signal = AbortSignal.timeout(input.timeoutMs ?? 12 * 60 * 60 * 1000);
  const arms =
    input.fullRelay === false
      ? [
          ['separate', 1],
          ['separate', 4],
        ]
      : [
          ['separate', 1],
          ['separate', 2],
          ['separate', 4],
          ['shared', 4],
        ];
  for (const [topology, sessions] of input.smoke
    ? [
        ['separate', 2],
        ['shared', 2],
      ]
    : arms) {
    const row = await isolatedCase({
      ...input,
      topology,
      sessions,
      signal,
      engineBinary: topology === 'separate' && sessions === 1 ? input.engineBinary : undefined,
      joinRepeats: input.fullRelay === false ? 3 : 10,
      socketRepeats: input.fullRelay === false ? 3 : 5,
      seedUpdates:
        input.smoke || input.fullRelay === false ? 0 : Math.floor(3840 / (topology === 'shared' ? sessions : 1)),
      checkpointProbe: !input.smoke && input.fullRelay !== false && topology === 'separate' && sessions === 1,
      directory: join(input.directory, topology + '-' + sessions),
    });
    rows.push(row);
  }
  if (input.churn)
    for (const structural of [false, true]) {
      const row = await measureChurn({ ...input, structural, signal });
      churn.push(row);
      await writeFile(join(input.directory, 'churn-' + structural + '.json'), JSON.stringify(row, null, 2) + '\n');
      if (structural)
        row.admission = await isolatedCase({
          ...input,
          structural: true,
          signal,
          topology: 'separate',
          sessions: 1,
          updates: 1,
          seedUpdates: 0,
          checkpointProbe: false,
          directory: join(input.directory, 'structural-admission'),
        });
    }
  if (input.churn && churn.find((row) => !row.structural)?.pass) {
    for (const [topology, sessions] of input.fullRelay === false
      ? [
          ['separate', 1],
          ['separate', 4],
        ]
      : [
          ['separate', 1],
          ['separate', 4],
          ['shared', 4],
        ]) {
      churnedCases.push(
        await isolatedCase({
          ...input,
          topology,
          sessions,
          signal,
          seedUpdates: 0,
          checkpointProbe: false,
          engineBinary: topology === 'separate' && sessions === 1 ? input.engineBinary : undefined,
          joinRepeats: input.fullRelay === false ? 3 : 10,
          socketRepeats: input.fullRelay === false ? 3 : 5,
          baselinePath: join(input.directory, 'churn-state-false.bin'),
          directory: join(input.directory, 'churned-' + topology + '-' + sessions),
        }),
      );
    }
  }
  const result = { cases: rows, churn, churnedCases };
  await writeFile(join(input.directory, 'relay.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [operation, inputPath] = process.argv.slice(2);
  if (!['run', 'smoke', 'dry-run', 'case'].includes(operation) || !inputPath)
    throw Error('Usage: document-size-runner.mjs <run|smoke|dry-run> <settings.json>');
  const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
  if (operation === 'dry-run') {
    console.log(
      JSON.stringify({ diagnostic: true, matrix: documentMatrix(input), estimate: runtimeEstimate() }, null, 2),
    );
  } else if (operation === 'case') {
    await runRelayCase({ ...input, signal: AbortSignal.timeout(input.timeoutMs ?? 60 * 60 * 1000) });
  } else {
    if (operation === 'smoke')
      Object.assign(input, { mib: 2, shape: 'plain', relaySessions: [2], updates: 3, churn: false, smoke: true });
    await mkdir(input.directory, { recursive: true });
    const result = await relayEntry(input);
    console.log(
      JSON.stringify({
        operation,
        status: result.cases.every((row) => row.status === 'complete') ? 'complete' : 'failed',
        cases: result.cases.map((row) => ({
          topology: row.topology,
          sessions: row.sessions,
          status: row.status,
          updates: row.updates.length,
          error: row.error,
          refusal: row.refusal,
        })),
      }),
    );
    if (operation === 'smoke' && result.cases.some((row) => row.status !== 'complete')) process.exitCode = 1;
  }
}
