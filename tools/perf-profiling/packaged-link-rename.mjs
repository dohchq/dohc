import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const LINK_TARGET = 'link-target.md';
export const LINK_RENAMED = 'link-renamed.md';
export function linkFixtureFile(n, links) {
  return {name: n === 2 ? LINK_TARGET : `fixture-${String(n).padStart(6, '0')}.md`,
    content: n >= 3 && n < links + 2 ? `[[link-target#part|label]]\n` : `Fixture ${n}.\n`};
}
export function linkingPaths(links) {
  return links ? ['large.md', ...Array.from({length: links - 1}, (_, n) => linkFixtureFile(n + 3, links).name)] : [];
}
const recordPath = (root, id) => join(root, '.dohc', 'local', 'trash', `move-${createHash('sha256').update(id).digest('hex')}.json`);
export const readLinkRecord = async (root, id) => JSON.parse(await readFile(recordPath(root, id), 'utf8'));
// Reproduce a quit after the engine receipt but before main saved done. The app is stopped.
export async function rearmLinkReceipt(root, id) {
  const record = await readLinkRecord(root, id);
  if (record.links.state !== 'done' || record.engine || !record.linkRewrite) throw Error('Resume fixture is not a forward move');
  record.links = {state: 'updating'};
  await writeFile(recordPath(root, id), JSON.stringify(record));
}

export async function linkIndexReady(page, workspaceId) {
  try {
    const result = await page.evaluate(({workspaceId, path}) => window.dohcDesktop.linksIn({workspaceId, subject: {path}}),
      {workspaceId, path: LINK_TARGET});
    return !!result && !result.indexBuilding;
  } catch (error) {
    if (error.message?.includes('DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.')) return false;
    throw error;
  }
}

// The collection scenario's typing collector supplies trusted input and long tasks.
// beforeInput starts the move with both observers armed, before the first key.
export async function measureLinkRename({instance, links, typing, waitUntil, signal}) {
  const {page, fixture} = instance, workspace = fixture.workspaces[0];
  const root = workspace.rootPath;
  const database = new DatabaseSync(join(root, '.dohc', 'engine', 'engine.db'), {readOnly: true});
  database.exec('PRAGMA busy_timeout=3000');
  const pending = () => Number(database.prepare('SELECT COUNT(*) AS n FROM link_pending').get().n);
  const cases = [];
  try {
    await waitUntil(async () => {
      return await linkIndexReady(page, workspace.workspaceId) && pending() === 0 &&
        Number(database.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n) >= 5000;
    }, 300_000);
    for (const document of ['small.md', 'large.md']) {
      signal.throwIfAborted();
      let move, resultMs, started, observed, passEnded, moveStarted;
      const sources = linkingPaths(links);
      const typed = await typing(page, document, {rich: true, beforeInput: async () => {
        moveStarted = await page.evaluate(() => performance.now());
        started = performance.now();
        move = await page.evaluate(async ({workspaceId, fromPath, toPath}) => window.dohcDesktop.moveWorkspacePath({workspaceId, fromPath, toPath}),
          {workspaceId: workspace.workspaceId, fromPath: LINK_TARGET, toPath: LINK_RENAMED});
        resultMs = performance.now() - started;
        if (!move.operationId || !move.undo?.available) throw Error('The link rename did not return an Undo operation');
        const name = `move-${createHash('sha256').update(move.operationId).digest('hex')}.json`;
        const pass = waitUntil(async () => {
          const record = JSON.parse(await readFile(join(root, '.dohc', 'local', 'trash', name), 'utf8').catch(error => {
            if (error.code === 'ENOENT') return '{}'; throw error;
          }));
          if (record.links?.state !== 'done') return false;
          if (record.links.documents !== links || record.links.uncheckedCount) throw Error(`Unexpected rewrite receipt: ${JSON.stringify(record.links)}`);
          passEnded = await page.evaluate(() => performance.now());
          return {receipt: record.links, passReceiptObservedMs: performance.now() - started};
        }, 300_000);
        observed = pass.then(async result => {
          await waitUntil(async () => (await Promise.all(sources.map(path => readFile(join(root, path), 'utf8')))).every(text => text.includes('[[link-renamed#part|label]]')), 300_000);
          const allOnDiskObservedMs = performance.now() - started;
          await waitUntil(() => pending() === 0, 300_000);
          return {...result, allOnDiskObservedMs, drainObservedMs: performance.now() - started};
        });
        void observed.catch(() => undefined);
      }});
      const timings = await observed;
      const undoStarted = performance.now();
      const undo = await page.evaluate(({workspaceId, operationId}) => window.dohcDesktop.undoHistoryOperation({workspaceId, operationId}),
        {workspaceId: workspace.workspaceId, operationId: move.operationId});
      const undoResultMs = performance.now() - undoStarted;
      if (!undo.ok || undo.remaining.length) throw Error(`Link Undo failed: ${JSON.stringify(undo)}`);
      await waitUntil(async () => (await Promise.all(sources.map(path => readFile(join(root, path), 'utf8')))).every(text => text.includes('[[link-target#part|label]]')), 300_000);
      cases.push({document, linking: document === 'large.md' && links > 0, links, operationId: move.operationId,
        renameResultMs: resultMs, ...timings, undoResultMs,
        undoOnDiskObservedMs: performance.now() - undoStarted,
        samplesDuringPass: typed.inputs.filter(input => input.timestamp >= moveStarted && input.timestamp <= passEnded).length,
        typing: typed, actorTurns: null, floorWalkMs: null, longestRecordUpdateWaitMs: null,
        unavailable: 'Production exposes no per-turn, floor-walk, fsync or ydoc.recordUpdate timing. Receipt and disk times are observation upper bounds.'});
    }
    const resumeMove = await page.evaluate(({workspaceId, fromPath, toPath}) => window.dohcDesktop.moveWorkspacePath({workspaceId, fromPath, toPath}),
      {workspaceId: workspace.workspaceId, fromPath: LINK_TARGET, toPath: LINK_RENAMED});
    if (!resumeMove.operationId || !resumeMove.undo?.available) throw Error('Resume fixture move failed');
    await waitUntil(async () => (await readLinkRecord(root, resumeMove.operationId).catch(() => null))?.links?.state === 'done', 300_000);
    return {links, cases, resumeOperationId: resumeMove.operationId};
  } finally {database.close();}
}
