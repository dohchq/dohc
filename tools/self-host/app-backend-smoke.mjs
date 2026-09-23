import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../services/sync-relay/package.json', import.meta.url));
const { initializeAppDatabase, evaluateAppOperation, validateAppDatabase } = await import(pathToFileURL(require.resolve('@dohc/app-backend-runtime')).href);
const tables = ['orders'];
const schemaSql = `
  CREATE TABLE orders (id TEXT PRIMARY KEY NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0));
  CREATE INDEX orders_quantity ON orders(quantity);
  CREATE TRIGGER orders_limit BEFORE INSERT ON orders WHEN NEW.quantity > 3
    BEGIN SELECT RAISE(ABORT, 'quantity limit'); END;
`;
const database = await initializeAppDatabase({ tables, schemaSql });
const source = `globalThis.operations = {
  place(ctx, input) { ctx.db.execute('INSERT INTO orders(id, quantity) VALUES (?, ?)', [ctx.requestId, input.quantity]); return { accepted: true }; },
  list(ctx) { return ctx.db.query('SELECT id, quantity FROM orders ORDER BY id'); }
};`;
const context = { source, tables, caller: { kind: 'owner' }, nowMs: 1, requestId: 'release-smoke' };
const accepted = await evaluateAppOperation({ ...context, database, operation: 'place', input: { quantity: 2 } });
assert.equal(accepted.changed, true);
assert.ok(accepted.changeset.byteLength > 0);
assert.deepEqual(accepted.result, { accepted: true });
await validateAppDatabase({ database: accepted.database, tables, schemaSql });
const read = await evaluateAppOperation({ ...context, database: accepted.database, operation: 'list', input: {}, readOnly: true });
assert.deepEqual(read.result, [{ id: 'release-smoke', quantity: 2 }]);
assert.equal(read.changed, false);
await assert.rejects(evaluateAppOperation({ ...context, database: accepted.database, requestId: 'refused', operation: 'place', input: { quantity: 4 } }));
console.log(`App backend release smoke passed (${process.version}, ${process.platform}/${process.arch}).`);
