import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observePresenceOwner, recordPresenceOwnerLastKey, waitForPresenceOwner, readPresenceOwner, validatePresenceWorkload, samplePresenceClock, rebasePresenceWindow } from './presence-owner.mjs';
const workload = { pass: true, peers: 2, maxGapMs: 50, peerCounts: [{ edits: 5, windowEdits: 5 }, { edits: 6, windowEdits: 6 }] };
const owner = { binding: 'unbound', receivedEdits: 11, receivedEditsAtLastKey: 9, presenceUpdatesReceived: 0 };

test('owner must receive exactly the edits sent, including when presence is unbound', () => {
  assert.equal(validatePresenceWorkload(workload, owner).pass, true);
  assert.equal(validatePresenceWorkload(workload, { ...owner, receivedEdits: 10 }).pass, false);
  assert.equal(validatePresenceWorkload(workload, { ...owner, receivedEdits: 12 }).pass, false);
  assert.equal(validatePresenceWorkload(workload, { receivedEdits: 11 }).pass, false);
  assert.equal(validatePresenceWorkload(workload, { ...owner, binding: 'caret-awareness' }).pass, false);
  assert.equal(validatePresenceWorkload(workload, { ...owner, binding: 'caret-awareness', presenceUpdatesReceived: 2 }).pass, true);
});

test('late owner catch-up cannot hide a stall through the last key', () => {
  const result = validatePresenceWorkload(workload, { ...owner, receivedEditsAtLastKey: 0 });
  assert.equal(result.sentEdits, 11);
  assert.equal(result.minimumEditsAtLastKey, 9);
  assert.equal(result.pass, false);
  assert.equal(validatePresenceWorkload(workload, owner).pass, true);
  assert.equal(validatePresenceWorkload(workload, { ...owner, receivedEditsAtLastKey: 8 }).pass, false);
  assert.equal(validatePresenceWorkload({ ...workload, pass: false }, owner).pass, false);
});

test('owner observer counts only remote awareness updates between the first and last key', () => {
  globalThis.window = {};
  try {
    const awareness = new EventEmitter(); awareness.clientID = 1;
    const element = { textContent: 'initial\u25c7', editor: { extensionManager: { extensions: [
      { name: 'collaborationCaret', options: { provider: { awareness } } },
    ] } } };
    observePresenceOwner(element);
    const start = performance.now();
    awareness.emit('update', { added: [1, 2], updated: [3] });
    const end = performance.now();
    awareness.emit('update', { added: [4], updated: [] });
    element.textContent += '\u25c7\u25c7';
    recordPresenceOwnerLastKey(element);
    assert.deepEqual(readPresenceOwner(element, { start, end }), { binding: 'caret-awareness', receivedEdits: 2, receivedEditsAtLastKey: 2, presenceUpdatesReceived: 2 });
    assert.equal(awareness.listenerCount('update'), 0);
  } finally { delete globalThis.window; }
});

test('an owner without a caret binding explicitly reports zero updates', () => {
  globalThis.window = {};
  try {
    const element = { textContent: 'initial', editor: { extensionManager: { extensions: [] } } };
    observePresenceOwner(element);
    recordPresenceOwnerLastKey(element);
    assert.deepEqual(readPresenceOwner(element, { start: 0, end: Infinity }), { binding: 'unbound', receivedEdits: 0, receivedEditsAtLastKey: 0, presenceUpdatesReceived: 0 });
  } finally { delete globalThis.window; }
});


test('last-key observation stays fixed when the owner catches up after typing', () => {
  globalThis.window = {};
  try {
    const element = { textContent: 'initial', editor: { extensionManager: { extensions: [] } } };
    observePresenceOwner(element);
    recordPresenceOwnerLastKey(element);
    element.textContent += '\u25c7'.repeat(11);
    const observation = readPresenceOwner(element, { start: 0, end: Infinity });
    assert.equal(observation.receivedEditsAtLastKey, 0);
    assert.equal(observation.receivedEdits, 11);
    assert.equal(validatePresenceWorkload(workload, observation).pass, false);
  } finally { delete globalThis.window; }
});

test('owner delivery waits for the exact final count', async () => {
  globalThis.window = { __presenceOwner: { before: 1 } };
  const element = { textContent: 'initial\u25c7' };
  globalThis.document = { querySelector: () => element };
  try {
    await waitForPresenceOwner({ waitForFunction: async (predicate, expected, options) => {
      assert.equal(options.timeout, 120_000);
      assert.equal(predicate(expected), false);
      element.textContent += '\u25c7'.repeat(11);
      assert.equal(predicate(expected), true);
    } }, 11);
  } finally { delete globalThis.window; delete globalThis.document; }
});

test('owner delivery deadline reports the last observed count', async () => {
  const deadline = new Error('timeout');
  await assert.rejects(waitForPresenceOwner({
    waitForFunction: async () => { throw deadline; }, evaluate: async () => 7,
  }, 11), error => /received 7 of 11/.test(error.message) && error.cause === deadline);
});

test('one midpoint clock sample rebases renderer key times to the Node tick clock', async () => {
  const times = [1000, 1004];
  const clock = await samplePresenceClock({ evaluate: async () => 500_000 }, () => times.shift());
  assert.deepEqual(clock, { rendererToNodeOffsetMs: -498_998, roundTripMs: 4 });
  const window = rebasePresenceWindow({ start: 500_010, end: 500_110 }, clock);
  assert.deepEqual(window, { start: 1012, end: 1112 });
  assert.equal(window.end - window.start, 100);
});
