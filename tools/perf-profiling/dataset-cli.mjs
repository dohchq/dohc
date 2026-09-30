// Creates the automation benchmark's dataset Collection and seeds its records, or lists one case's
// records, through the checkout CLI's own executeCli in this one process. The request file names the
// CLI module, so the harness passes packages/cli/src/index.ts and runs this script with the tsx loader.
// cwd selects the workspace and DOHC_STATE_DIR names the app profile; both come from the harness, which
// runs this script through scripts/verification/process.mjs so a job object owns it and anything it starts.
// Prints one JSON progress line per 200 seeded records and a final JSON result line.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [requestPath] = process.argv.slice(2);
if (!requestPath) {
  console.error('usage: node --import tsx dataset-cli.mjs <request.json>');
  process.exit(2);
}
const request = JSON.parse(await readFile(requestPath, 'utf8'));
const { executeCli } = await import(pathToFileURL(request.cliModule).href);
const dataset = async (verb, body) => {
  const { exitCode, stdout, stderr } = await executeCli({ argv: ['--json', 'dataset', verb, JSON.stringify(body)] });
  if (exitCode !== 0) throw Error(stderr.trim() || `dohc dataset ${verb} failed`);
  const result = JSON.parse(stdout);
  if (result.kind === 'refused') throw Error(`dohc dataset ${verb} refused: ${result.code}: ${result.message}`);
  return result;
};
try {
  const { workspaceId } = request;
  if (request.mode === 'setup') {
    const started = performance.now();
    const created = await dataset('create', { workspaceId, definition: request.definition });
    if (created.kind !== 'approved') throw Error(`dohc dataset create answered ${created.kind}`);
    const { datasetId, revision, revisionSha256 } = created.revision;
    for (const [index, values] of request.records.entries()) {
      await dataset('invoke', { workspaceId, datasetPath: request.datasetPath, expectedDatasetId: datasetId, operationId: request.createOperationId, revision, revisionSha256,
        input: { values }, idempotencyKey: `seed:${values[request.idFieldId]}` });
      if ((index + 1) % 200 === 0) console.log(JSON.stringify({ phase: 'dataset-seed', records: index + 1 }));
    }
    console.log(JSON.stringify({ datasetId, revision, revisionSha256, records: request.records.length, seedingObservedMs: performance.now() - started }));
  } else if (request.mode === 'list') {
    const { datasetPath, datasetId, revision, revisionSha256, operationId, filters } = request;
    // A read's key only has to be new: a reused key would replay an earlier page.
    const key = randomUUID();
    const rows = [];
    let after = null;
    do {
      const page = await dataset('invoke', { workspaceId, datasetPath, expectedDatasetId: datasetId, operationId, revision, revisionSha256,
        input: { limit: 100, filters, ...(after === null ? {} : { after }) }, idempotencyKey: `list:${key}:${rows.length}` });
      rows.push(...page.result.rows);
      after = page.result.nextCursor;
    } while (after !== null);
    console.log(JSON.stringify({ rows }));
  } else {
    throw Error(`Unknown mode: ${request.mode}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
