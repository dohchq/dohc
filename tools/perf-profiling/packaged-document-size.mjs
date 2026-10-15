import { connectDocumentPeer } from './packaged-document-peer.mjs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { sha256 } from './document-size-fixtures.mjs';
import { aggregateByKind } from './packaged-surfaces.mjs';

// Serialized into the renderer. Both milestones use the same trusted tree click.
export function observeDocumentOpen({ name, marker, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    let clickMs = null,
      firstContentMs = null,
      editReadyMs = null,
      activationMs = null,
      frame,
      finished = false;
    const onClick = (event) => {
      if (event.target.closest('[data-testid="markdown-edit-toggle"]')) activationMs = event.timeStamp;
      if (clickMs === null && event.target.closest('[role="treeitem"]')?.textContent?.includes(name)) {
        clickMs = event.timeStamp;
        if (!event.isTrusted) finish(Error('Untrusted document-open trigger'));
      }
    };
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      cancelAnimationFrame(frame);
      window.removeEventListener('mousedown', onClick, true);
      error ? reject(error) : resolve(result);
    };
    const deadline = setTimeout(() => finish(Error('Document open timed out')), timeoutMs);
    const check = () => {
      const view = document.querySelector('[data-testid="view-markdown"]');
      if (clickMs !== null && view && view.getBoundingClientRect().width > 0 && view.textContent?.includes(marker)) {
        firstContentMs ??= performance.now() - clickMs;
        const editor = view.querySelector('[contenteditable="true"]');
        if (editor && editor.getBoundingClientRect().width > 0) {
          editReadyMs = firstContentMs + (activationMs === null ? 0 : performance.now() - activationMs);
          finish(null, {
            firstContentMs,
            editReadyMs,
            totalEditableMs: performance.now() - clickMs,
            editActivationMs: activationMs === null ? 0 : performance.now() - activationMs,
            triggerTrusted: true,
          });
          return;
        }
        const refusal = document.body.innerText.match(
          /This file is too large to edit in dohc\.|dohc could not open this document for editing\.|Showing the start of a large file\./,
        )?.[0];
        if (refusal) {
          finish(null, { firstContentMs, editReadyMs: null, refusal });
          return;
        }
      }
      frame = requestAnimationFrame(check);
    };
    window.addEventListener('mousedown', onClick, true);
    check();
  });
}

// Selection is preparation. The replacement itself arrives through trusted CDP input.
export function prepareDocumentReplacement(position) {
  const editor = document.querySelector('[data-testid="view-markdown"] [contenteditable="true"]');
  if (!editor) throw Error('No editable document');
  let nodes = window.__documentReplacementNodes;
  if (!nodes?.every((node) => node.isConnected)) {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    nodes = [];
    let node;
    while ((node = walker.nextNode())) if (/[a-zA-Z]/.test(node.textContent)) nodes.push(node);
    window.__documentReplacementNodes = [nodes[0], nodes[Math.floor(nodes.length / 2)], nodes.at(-1)];
    nodes = window.__documentReplacementNodes;
  }
  const target = nodes[position === 0 ? 0 : position === 1 ? Math.floor(nodes.length / 2) : nodes.length - 1];
  if (!target) throw Error('No replaceable text');
  const at = target.textContent.search(/[a-zA-Z]/);
  const range = document.createRange();
  range.setStart(target, at);
  range.setEnd(target, at + 1);
  editor.focus();
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  target.parentElement.scrollIntoView({ block: 'center' });
}

export function observeDocumentReplacement({ timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let keyMs,
      trusted = false,
      frame;
    const finish = (error, result) => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('input', input, true);
      error ? reject(error) : resolve(result);
    };
    const keydown = (event) => {
      if (event.key === 'x' || event.key === 'q') {
        keyMs = event.timeStamp;
        trusted = event.isTrusted;
      }
    };
    const input = (event) => {
      if (keyMs === undefined) return;
      const inputMs = performance.now();
      frame = requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          channel.port2.close();
          finish(null, {
            keyToFrameMs: performance.now() - keyMs,
            inputMs,
            triggerTrusted: trusted && event.isTrusted,
          });
        };
        channel.port2.postMessage(null);
      });
    };
    const timer = setTimeout(() => finish(Error('Replacement input did not arrive')), timeoutMs);
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('input', input, true);
  });
}

async function poll(read, signal, timeoutMs = 120000, intervalMs = 50) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    signal.throwIfAborted();
    const value = await read();
    if (value) return value;
    await delay(intervalMs, undefined, { signal });
  }
  throw Error('Document did not settle within ' + timeoutMs + 'ms');
}

// The engine folds a document's log once 64 updates are pending past its snapshot
// (DEFAULT_COMPACTION_THRESHOLD in crates/dohc-engine-collab/src/limits.rs).
const COMPACTION_UPDATES = 64;
const pendingUpdates = (head) => head.head_update_seq - head.head_snapshot_seq;

export function engineHeads(workspace) {
  const require = createRequire(import.meta.url),
    { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(join(workspace.rootPath, '.dohc/engine/engine.db'), { readOnly: true });
  try {
    return db.prepare('SELECT object_id,head_update_seq,head_snapshot_seq FROM ydoc_docs').all();
  } finally {
    db.close();
  }
}

// Detached from typing: a compaction still missing after 30 s is recorded at 30 s, which fails its budget.
async function timeCompaction(workspace, target, snapshotSeq, dispatch, index, signal) {
  while (
    engineHeads(workspace).find((h) => h.object_id === target).head_snapshot_seq === snapshotSeq &&
    performance.now() - dispatch < 30000
  )
    await delay(5, undefined, { signal });
  return { index, observedUpperBoundMs: performance.now() - dispatch };
}

export async function engineHistoryBytes(workspace) {
  const require = createRequire(import.meta.url),
    { DatabaseSync } = require('node:sqlite');
  const path = join(workspace.rootPath, '.dohc/engine/engine.db');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const blobs = db
      .prepare(
        'SELECT COALESCE(SUM(byte_length),0) AS bytes FROM binary_blobs WHERE sha256 IN (SELECT update_blob_sha256 FROM ydoc_updates UNION SELECT snapshot_blob_sha256 FROM ydoc_snapshots UNION SELECT state_vector_blob_sha256 FROM ydoc_snapshots)',
      )
      .get().bytes;
    const heads = db
      .prepare('SELECT object_id,head_update_seq,head_snapshot_seq FROM ydoc_docs ORDER BY object_id')
      .all();
    const snapshots = db.prepare('SELECT COUNT(*) AS count FROM ydoc_snapshots').get().count;
    const files = await Promise.all(
      [path, path + '-wal'].map((path) =>
        stat(path).then(
          (value) => value.size,
          (error) => {
            if (error.code === 'ENOENT') return 0;
            throw error;
          },
        ),
      ),
    );
    const currentStateBytes = db
      .prepare(
        'SELECT COALESCE(SUM(byte_length),0) AS bytes FROM binary_blobs WHERE sha256 IN (SELECT s.snapshot_blob_sha256 FROM ydoc_snapshots s JOIN ydoc_docs d USING (workspace_id,version_id,object_id) WHERE s.up_to_seq=d.head_snapshot_seq UNION SELECT s.state_vector_blob_sha256 FROM ydoc_snapshots s JOIN ydoc_docs d USING (workspace_id,version_id,object_id) WHERE s.up_to_seq=d.head_snapshot_seq)',
      )
      .get().bytes;
    return {
      retainedBytes: Math.max(0, blobs - currentStateBytes),
      currentStateBytes,
      logicalBytes: blobs,
      physicalBytes: files.reduce((n, value) => n + value, 0),
      snapshots,
      heads,
    };
  } finally {
    db.close();
  }
}

export async function measurePackagedDocument({
  instance,
  fixture,
  options,
  signal,
  snapshot,
  phase,
  soak = false,
  proof = true,
  peerMode = null,
}) {
  const page = instance.page,
    workspace = instance.fixture.workspaces[0],
    name = 'document-size.md';
  const peer = peerMode
    ? await connectDocumentPeer(
        page,
        workspace.workspaceId,
        options.relayCheckout,
        peerMode === 'churn' ? options.churnEdits : 0,
      )
    : null;
  try {
    await page.evaluate(() => {
      delete window.__documentReplacementNodes;
    });
    const observe = page.evaluate(observeDocumentOpen, { name, marker: 'Measured text' });
    void observe.catch(() => {});
    await page.getByTestId('file-tree').getByRole('treeitem', { name, exact: true }).click();
    // Match the ordinary editor's explicit read -> edit transition.
    await page.waitForFunction(
      () => document.querySelector('[data-testid="view-markdown"]')?.textContent?.includes('Measured text'),
      null,
      { timeout: 120000 },
    );
    const edit = page.getByTestId('markdown-edit-toggle');
    if ((await edit.isEnabled()) && (await edit.textContent()) === 'Edit') await edit.click();
    const opening = await observe;
    const row = {
      phase,
      peerMode,
      peer: peer?.result,
      ...opening,
      mib: fixture.mib,
      shape: fixture.shape,
      fixtureSha256: fixture.sha256,
      samples: [],
      status: 'running',
    };
    if (opening.refusal) {
      row.status = 'refused';
      return row;
    }
    const before = await snapshot(instance.child.pid);
    const beforeHistory = await engineHistoryBytes(workspace);
    const started = performance.now();
    const until = soak ? started + options.soakMinutes * 60000 : null;
    const memory = [],
      history = [],
      compactions = [];
    let previousSnapshot = beforeHistory.heads.map((h) => h.head_snapshot_seq).join(',');
    // The measured document is the one whose update sequence moves once typing starts.
    const startSeq = new Map(beforeHistory.heads.map((h) => [h.object_id, h.head_update_seq]));
    const compactionPolls = [];
    let target = null;
    let memorySampling, historySampling, probeError;
    const sampleMemory = () =>
      (memorySampling ??= snapshot(instance.child.pid)
        .then((snap) =>
          memory.push({ elapsedMs: performance.now() - started, ...aggregateByKind(snap, instance.child.pid) }),
        )
        .catch((error) => {
          probeError = error;
        })
        .finally(() => {
          memorySampling = null;
        }));
    const probeHistory = () =>
      (historySampling ??= engineHistoryBytes(workspace)
        .then((current) => {
          const elapsedMs = performance.now() - started;
          history.push({ elapsedMs, ...current });
          const head = current.heads.map((h) => h.head_snapshot_seq).join(',');
          if (head !== previousSnapshot) {
            compactions.push({ elapsedMs, ...current });
            previousSnapshot = head;
          }
        })
        .catch((error) => {
          probeError = error;
        })
        .finally(() => {
          historySampling = null;
        }));
    const memoryTimer = setInterval(() => {
      void sampleMemory();
    }, 5000);
    memoryTimer.unref();
    const historyTimer = setInterval(() => {
      void probeHistory();
    }, 100);
    historyTimer.unref();
    let editCount = 0,
      editingElapsedMs;
    try {
      for (let index = 0; until ? performance.now() < until : index < options.keystrokes; index++) {
        signal.throwIfAborted();
        await page.evaluate(prepareDocumentReplacement, index % 3);
        const observation = page.evaluate(observeDocumentReplacement, {});
        void observation.catch(() => {});
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        // Only the soak times compaction, and it gates no typing. Each soak key reads the edited
        // document's head first. The last four keys before 64 pending wait for their own append, so
        // the crossing key is known; its compaction is timed from its dispatch while typing continues.
        let prior = null;
        if (soak) {
          const heads = engineHeads(workspace);
          target ??= heads.find((h) => h.head_update_seq !== startSeq.get(h.object_id))?.object_id ?? null;
          const head = heads.find((h) => h.object_id === target);
          if (head && pendingUpdates(head) >= COMPACTION_UPDATES - 4 && pendingUpdates(head) < COMPACTION_UPDATES)
            prior = head;
        }
        const dispatch = performance.now();
        await page.keyboard.press(index % 2 ? 'q' : 'x');
        const sample = await observation;
        if (!sample.triggerTrusted) throw Error('Untrusted document replacement');
        const waitStarted = performance.now();
        if (prior) {
          const landed = await poll(
            () => {
              const head = engineHeads(workspace).find((h) => h.object_id === target);
              return head.head_update_seq > prior.head_update_seq ? head : null;
            },
            signal,
            30000,
            5,
          );
          if (landed.head_snapshot_seq !== prior.head_snapshot_seq || pendingUpdates(landed) >= COMPACTION_UPDATES) {
            const timing = timeCompaction(workspace, target, prior.head_snapshot_seq, dispatch, index, signal);
            void timing.catch(() => {});
            compactionPolls.push(timing);
          }
        }
        const boundaryWaitMs = performance.now() - waitStarted;
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        row.samples.push({
          ...sample,
          index,
          boundaryWaitMs,
          dispatchToTwoRafMs: performance.now() - dispatch - boundaryWaitMs,
        });
        editCount++;
        if (probeError) throw probeError;
        // Workload pacing, never an assertion delay.
        const due = started + ((index + 1) * 1000) / options.updatesPerSecond;
        if (due > performance.now()) await delay(due - performance.now(), undefined, { signal });
      }
      editingElapsedMs = performance.now() - started;
    } finally {
      clearInterval(memoryTimer);
      clearInterval(historyTimer);
      await Promise.all([memorySampling, historySampling, Promise.allSettled(compactionPolls)]);
    }
    if (probeError) throw probeError;
    row.editsPerMinute = (editCount * 60000) / editingElapsedMs;
    row.editCount = editCount;
    row.editingElapsedMs = editingElapsedMs;
    const settleStart = performance.now();
    const text = await poll(async () => {
      const state = await page.getByTestId('markdown-save-state').getAttribute('data-state');
      const text = await readFile(join(workspace.rootPath, name), 'utf8');
      const response = await page.evaluate(
        async ({ workspaceId, relativePath }) => window.dohcDesktop.readWorkspaceText({ workspaceId, relativePath }),
        { workspaceId: workspace.workspaceId, relativePath: name },
      );
      return response.truncated === false && response.text === text && state === 'saved' ? text : null;
    }, signal);
    row.settleMs = performance.now() - settleStart;
    const after = await snapshot(instance.child.pid);
    memory.push({ elapsedMs: performance.now() - started, ...aggregateByKind(after, instance.child.pid) });
    row.durableSha256 = sha256(text);
    row.durableBytes = Buffer.byteLength(text);
    row.beforeHistory = beforeHistory;
    row.afterHistory = await engineHistoryBytes(workspace);
    row.elapsedMs = performance.now() - started;
    row.before = before;
    row.after = after;
    row.memory = memory;
    row.history = history;
    row.compactions = compactions;
    row.compactionTimings = await Promise.all(compactionPolls);
    row.status = row.durableBytes < fixture.bytes - 1 || row.durableBytes > fixture.bytes ? 'failed' : 'complete';
    if (row.status === 'failed') row.error = 'Constant-size replacements changed the complete document byte length';
    if (peer) {
      await poll(() => peer.hash() === row.durableSha256, signal);
      row.peer = { ...peer.result, updates: peer.updates, verified: true };
    }
    if (!proof) return row;
    // Copy invokes the renderer's actual serializer, including frontmatter.
    const previousClipboard = await page.evaluate(() => navigator.clipboard.readText());
    try {
      await page.getByTestId('document-menu-trigger').click();
      await page.getByTestId('document-menu-item-copy-markdown').click();
      const exported = await poll(async () => {
        const value = await page.evaluate(() => navigator.clipboard.readText());
        return sha256(value) === row.durableSha256 ? value : null;
      }, signal);
      row.export = { complete: true, bytes: Buffer.byteLength(exported), sha256: sha256(exported) };
    } finally {
      await page.evaluate((text) => navigator.clipboard.writeText(text), previousClipboard);
    }
    // Close the live editor through its ordinary tab control before a local restore.
    await page.getByRole('button', { name: 'Close ' + name, exact: true }).click();
    await page.getByRole('button', { name: 'Close ' + name, exact: true }).waitFor({ state: 'detached' });
    // History reads hydrate full before/after bodies through the production bridge.
    const listed = await poll(async () => {
      const result = await page.evaluate(
        (workspaceId) => window.dohcDesktop.listEngineMoments({ workspaceId, limit: 50 }),
        workspace.workspaceId,
      );
      return 'moments' in result && result.moments.find((moment) => moment.path === name) ? result : null;
    }, signal);
    const moment = listed.moments.find((moment) => moment.path === name);
    const readStart = performance.now();
    const detail = await page.evaluate(
      async ({ workspaceId, momentId }) => window.dohcDesktop.readEngineMoment({ workspaceId, momentId }),
      { workspaceId: workspace.workspaceId, momentId: moment.id },
    );
    if (!detail.moment || detail.moment.afterText === null) throw Error('History did not hydrate the full document');
    row.historyRead = {
      ms: performance.now() - readStart,
      beforeBytes: Buffer.byteLength(detail.moment.beforeText ?? ''),
      afterBytes: Buffer.byteLength(detail.moment.afterText),
      afterSha256: sha256(detail.moment.afterText),
    };
    if (row.historyRead.afterSha256 !== row.durableSha256)
      throw Error('History differs from the complete durable document');
    row.historyCompare = {
      changed: detail.moment.beforeText !== detail.moment.afterText,
      beforeSha256: sha256(detail.moment.beforeText ?? ''),
      afterSha256: row.historyRead.afterSha256,
    };
    if (detail.moment.beforeText !== null) {
      const restoreStart = performance.now();
      const restored = await page.evaluate((input) => window.dohcDesktop.restoreEngineMomentFile(input), {
        workspaceId: workspace.workspaceId,
        momentId: moment.id,
      });
      await poll(
        async () => sha256(await readFile(join(workspace.rootPath, name))) === row.historyCompare.beforeSha256,
        signal,
      );
      row.historyRestore = {
        ms: performance.now() - restoreStart,
        restoredMomentId: restored.restoredMomentId,
        verified: true,
      };
      await page.evaluate((input) => window.dohcDesktop.restoreEngineMomentFile(input), {
        workspaceId: workspace.workspaceId,
        momentId: restored.restoredMomentId,
      });
      await poll(async () => sha256(await readFile(join(workspace.rootPath, name))) === row.durableSha256, signal);
    } else row.historyRestore = { verified: false, reason: 'No before-text to restore' };
    return row;
  } finally {
    await peer?.close();
  }
}
