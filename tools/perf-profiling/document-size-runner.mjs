import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runRelayCase, measureChurn } from './document-size-relay.mjs';
import { documentMatrix, runtimeEstimate } from './document-size-fixtures.mjs';

// Run in an owned Node child, so relay CPU/RSS and its two worker heaps exclude the GUI.
export async function relayEntry(input) {
  const rows = [], churn = [], churnedCases = [];
  const signal = AbortSignal.timeout(input.timeoutMs ?? 12 * 60 * 60 * 1000);
  for (const topology of ['separate', 'shared']) for (const sessions of input.relaySessions) {
    const row = await runRelayCase({ ...input, topology, sessions, signal,
      updates: input.checkpointProbe && topology === 'separate' && sessions === 1 ? 4096 : input.updates,
      directory: join(input.directory, topology + '-' + sessions) });
    rows.push(row);
  }
  if (input.churn) for (const structural of [false, true]) {
    const row = await measureChurn({ ...input, structural, signal });
    churn.push(row);
    await writeFile(join(input.directory, 'churn-' + structural + '.json'), JSON.stringify(row, null, 2) + '\n');
  }
  if (input.churn && churn.find(row => !row.structural)?.pass) {
    for (const topology of ['separate', 'shared']) for (const sessions of input.relaySessions) {
      churnedCases.push(await runRelayCase({ ...input, topology, sessions, signal, baselinePath: join(input.directory, 'churn-state-false.bin'),
        directory: join(input.directory, 'churned-' + topology + '-' + sessions) }));
    }
  }
  const result = { cases: rows, churn, churnedCases };
  await writeFile(join(input.directory, 'relay.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [operation, inputPath] = process.argv.slice(2);
  if (!['run', 'smoke', 'dry-run'].includes(operation) || !inputPath) throw Error('Usage: document-size-runner.mjs <run|smoke|dry-run> <settings.json>');
  const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
  if (operation === 'dry-run') {
    console.log(JSON.stringify({ diagnostic: true, matrix: documentMatrix(input), estimate: runtimeEstimate() }, null, 2));
  } else {
    if (operation === 'smoke') Object.assign(input, { mib: 2, shape: 'plain', relaySessions: [2], updates: 3, churn: false });
    await mkdir(input.directory, { recursive: true });
    const result = await relayEntry(input);
    console.log(JSON.stringify({ operation, status: result.cases.every(row => row.status === 'complete') ? 'complete' : 'failed',
      cases: result.cases.map(row => ({ topology: row.topology, sessions: row.sessions, status: row.status, updates: row.updates.length, error: row.error, refusal: row.refusal })) }));
    if (result.cases.some(row => row.status !== 'complete')) process.exitCode = 1;
  }
}
