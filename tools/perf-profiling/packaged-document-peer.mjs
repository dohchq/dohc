import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sha256 } from './document-size-fixtures.mjs';

// A second real IPC session shares the canonical engine Y.Doc with the GUI.
// Named/Edit-link transport is measured separately by the socket probes.
export async function connectDocumentPeer(page, workspaceId, checkout, churnEdits = 0) {
  const require = createRequire(join(checkout, 'services/sync-relay/package.json'));
  const Y = await import(pathToFileURL(require.resolve('yjs').replace(/yjs\.cjs$/, 'yjs.mjs')).href);
  const projection = await import(pathToFileURL(join(checkout, 'packages/ydoc-projection/src/import-export.ts')).href);
  const sessionId = randomUUID(),
    callback = 'documentPeer' + sessionId.replaceAll('-', '');
  const doc = new Y.Doc();
  doc.clientID = 987654;
  let updates = 0;
  await page.exposeFunction(callback, (bytes) => {
    Y.applyUpdate(doc, Uint8Array.from(bytes));
    updates++;
  });
  const initial = await page.evaluate(
    async ({ workspaceId, sessionId, callback }) => {
      window[callback + 'off'] = window.dohcDesktop.onEngineYDocRemoteUpdate((event) => {
        if (event.sessionId === sessionId) void window[callback](Array.from(event.update));
      });
      const value = await window.dohcDesktop.openEngineYDocSession({
        workspaceId,
        path: 'document-size.md',
        sessionId,
      });
      return { ...value, initialUpdate: value.initialUpdate ? Array.from(value.initialUpdate) : null };
    },
    { workspaceId, sessionId, callback },
  );
  try {
    assert.ok(initial.available && initial.initialUpdate, 'Peer admission');
    Y.applyUpdate(doc, Uint8Array.from(initial.initialUpdate));
    if (churnEdits) {
      const queue = [doc.getXmlFragment('body')];
      let target;
      while (queue.length) {
        const node = queue.shift();
        if (node instanceof Y.XmlText && node.length > 8) {
          target = node;
          break;
        }
        if (node.toArray) queue.push(...node.toArray().filter((value) => typeof value === 'object'));
      }
      assert.ok(target);
      const before = Y.encodeStateVector(doc);
      for (let n = 0; n < churnEdits; n++) {
        doc.clientID = 987654 + (n % 8);
        doc.transact(() => {
          target.delete(0, 1);
          target.insert(0, n % 2 ? 'q' : 'x');
        });
      }
      const update = Array.from(Y.encodeStateAsUpdate(doc, before));
      const applied = await page.evaluate(
        ({ sessionId, update, lineageGeneration, requestId }) =>
          window.dohcDesktop.applyEngineYDocUpdate({
            sessionId,
            update: Uint8Array.from(update),
            lineageGeneration,
            requestId,
            seq: 1,
          }),
        { sessionId, update, lineageGeneration: initial.lineageGeneration, requestId: randomUUID() },
      );
      assert.ok(applied.accepted, 'Churn must enter canonical engine state');
    }
    return {
      result: {
        connected: true,
        churnEdits,
        stateBytes: Y.encodeStateAsUpdate(doc).byteLength,
        peerKind: 'engine IPC session',
      },
      hash: () => sha256(projection.yDocToMarkdown(doc)),
      get updates() {
        return updates;
      },
      async close() {
        await page.evaluate(
          async ({ sessionId, callback }) => {
            window[callback + 'off']();
            delete window[callback + 'off'];
            await window.dohcDesktop.closeEngineYDocSession({ sessionId });
          },
          { sessionId, callback },
        );
        await page.removeExposedFunction(callback);
        doc.destroy();
      },
    };
  } catch (error) {
    await page.evaluate(
      ({ sessionId, callback }) => {
        window[callback + 'off']?.();
        return window.dohcDesktop.closeEngineYDocSession({ sessionId });
      },
      { sessionId, callback },
    );
    await page.removeExposedFunction(callback);
    doc.destroy();
    throw error;
  }
}
