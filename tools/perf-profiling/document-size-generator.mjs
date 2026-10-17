import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { documentFixture, sha256 } from './document-size-fixtures.mjs';

export function startGenerator(options) {
  const require = createRequire(join(options.checkout, 'services/sync-relay/package.json'));
  const child = fork(fileURLToPath(import.meta.url), [], {
    execArgv: ['--import', pathToFileURL(require.resolve('tsx')).href],
    serialization: 'advanced',
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const pending = new Map();
  let id = 0,
    stderr = '';
  child.stderr.on('data', (value) => {
    stderr = (stderr + value).slice(-8000);
  });
  const rejectAll = (error) => {
    for (const value of pending.values()) value.reject(error);
    pending.clear();
  };
  const exited = new Promise((resolve) =>
    child.once('close', (code, signal) => {
      rejectAll(Error('Fixture generator exited: ' + code + '/' + signal + ' ' + stderr));
      resolve();
    }),
  );
  child.on('error', rejectAll);
  child.on('message', (row) => {
    const value = pending.get(row.id);
    if (!value) return;
    pending.delete(row.id);
    row.error ? value.reject(Error(row.error)) : value.resolve(row.value);
  });
  const call = (method, input) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      pending.set(key, { resolve, reject });
      child.send({ id: key, method, input }, (error) => {
        if (error) {
          pending.delete(key);
          reject(error);
        }
      });
    });
  const abort = () => child.kill();
  options.signal?.addEventListener('abort', abort, { once: true });
  return {
    pid: child.pid,
    call,
    async close() {
      options.signal?.removeEventListener('abort', abort);
      child.kill();
      await exited;
    },
  };
}

if (process.send) {
  let Y,
    projection,
    docs = [],
    texts = [];
  process.on('message', async ({ id, method, input }) => {
    try {
      let value;
      if (method === 'init') {
        const require = createRequire(join(input.checkout, 'services/sync-relay/package.json'));
        Y = await import(pathToFileURL(require.resolve('yjs').replace(/yjs\.cjs$/, 'yjs.mjs')).href);
        projection = await import(
          pathToFileURL(join(input.checkout, 'packages/ydoc-projection/src/import-export.ts')).href
        );
        const fixture = documentFixture(input.mib, input.shape, { structural: input.structural ?? false });
        const base = input.baselinePath ? new Y.Doc() : projection.markdownToYDoc(fixture.text, { clientID: 101 });
        if (input.baselinePath) Y.applyUpdate(base, await readFile(input.baselinePath));
        const bytes = Y.encodeStateAsUpdate(base),
          text = projection.yDocToMarkdown(base);
        let nodes = 0,
          depth = 0;
        const count = (node, level = 0) => {
          nodes++;
          depth = Math.max(depth, level);
          if (node.toArray) for (const child of node.toArray()) if (typeof child === 'object') count(child, level + 1);
          if (node instanceof Y.XmlText) nodes += node.toDelta().length;
        };
        count(base.getXmlFragment('body'));
        for (let n = 0; n < input.sessions; n++) {
          const doc = new Y.Doc();
          Y.applyUpdate(doc, bytes);
          doc.clientID = 1000 + n;
          docs.push(doc);
          const found = [];
          const walk = (node) => {
            if (node instanceof Y.XmlText && node.length) found.push(node);
            else if (node.toArray) for (const child of node.toArray()) if (typeof child === 'object') walk(child);
          };
          walk(doc.getXmlFragment('body'));
          texts.push(found);
        }
        base.destroy();
        value = { bytes, text, nodes, depth, fixtureSha256: fixture.sha256, sourceBytes: fixture.bytes };
      } else if (method === 'edit') {
        const doc = docs[input.session],
          list = texts[input.session],
          target = list[[0, Math.floor(list.length / 2), list.length - 1][input.index % 3]],
          before = Y.encodeStateVector(doc);
        const at = target.toString().search(/[a-zA-Z]/);
        if (at < 0) throw Error('No ASCII replacement');
        doc.transact(() => {
          target.delete(at, 1);
          target.insert(at, input.index % 2 ? 'q' : 'x');
        });
        value = Y.encodeStateAsUpdate(doc, before);
        if (input.shared) for (const peer of docs) if (peer !== doc) Y.applyUpdate(peer, value);
      } else if (method === 'state') value = Y.encodeStateAsUpdate(docs[input.session]);
      else if (method === 'hash') value = sha256(projection.yDocToMarkdown(docs[input.session]));
      else throw Error('Unknown generator request');
      process.send({ id, value });
    } catch (error) {
      process.send({ id, error: String(error.stack ?? error) });
    }
  });
}
