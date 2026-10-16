import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observePresenceOwner, recordPresenceOwnerLastKey, waitForPresenceOwner, readPresenceOwner, validatePresenceWorkload, samplePresenceClock, validatePresenceClocks, rebasePresenceWindow, withPresencePeers } from './presence-owner.mjs';
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

function clockFixture(roundTrips, offsets = roundTrips.map(() => 42)) {
  const times = roundTrips.flatMap((roundTrip, index) => [index * 100, index * 100 + roundTrip]);
  const renderer = roundTrips.map((roundTrip, index) => index * 100 + roundTrip / 2 - offsets[index]);
  return { page: { evaluate: async () => renderer.shift() }, now: () => times.shift() };
}

test('clock calibration selects the shortest of ten round trips and rebases its offset', async () => {
  const fixture = clockFixture([8, 6, 7, 5, 4, 3, 2, 1, .5, 4], [1, 2, 3, 4, 5, 6, 7, 8, 42, 10]);
  const clock = await samplePresenceClock(fixture.page, { now: fixture.now });
  assert.equal(clock.samples.length, 10);
  assert.equal(clock.roundTripMs, .5);
  assert.equal(clock.rendererToNodeOffsetMs, 42);
  assert.deepEqual(rebasePresenceWindow({ start: 10, end: 110 }, clock), { start: 52, end: 152 });
});

test('clock calibration accepts five milliseconds and refuses a shortest trip above it', async () => {
  const boundary = clockFixture(Array(10).fill(5));
  assert.equal((await samplePresenceClock(boundary.page, { now: boundary.now })).roundTripMs, 5);
  const slow = clockFixture(Array(10).fill(5.001));
  await assert.rejects(samplePresenceClock(slow.page, { now: slow.now }), /clock refused.*5 ms/);
});

test('clock calibration can retry one batch after a paint, then still refuses a slow batch', async () => {
  const fixture = clockFixture([...Array(10).fill(8), ...Array(10).fill(1)]);
  let paints = 0;
  assert.equal((await samplePresenceClock(fixture.page, { now: fixture.now, retryAfterPaint: async () => { paints++; } })).roundTripMs, 1);
  assert.equal(paints, 1);
  const slow = clockFixture(Array(20).fill(6));
  await assert.rejects(samplePresenceClock(slow.page, { now: slow.now, retryAfterPaint: async () => { paints++; } }), /clock refused/);
  assert.equal(paints, 2);
});

test('post-typing clock check accepts three milliseconds and refuses greater drift', () => {
  const before = { rendererToNodeOffsetMs: 42, roundTripMs: 1 };
  assert.equal(validatePresenceClocks(before, { ...before, rendererToNodeOffsetMs: 45 }).offsetDeltaMs, 3);
  assert.throws(() => validatePresenceClocks(before, { ...before, rendererToNodeOffsetMs: 45.001 }), /clock refused.*offset changed/);
});

test('peer cleanup failure keeps the original typing refusal and logs the cleanup error', async t => {
  const cause = new Error('original clock details');
  const original = new Error('Presence clock refused', { cause });
  const finishError = new Error('Peer stopped during acknowledgement drain');
  const log = t.mock.method(console, 'error', () => {});
  let finishes = 0;
  await assert.rejects(withPresencePeers({ finish: async () => { finishes++; throw finishError; } },
    async () => { throw original; }), error => error === original);
  assert.equal(finishes, 1);
  assert.equal(log.mock.callCount(), 1);
  assert.equal(log.mock.calls[0].arguments[1], finishError);
});

test('successful peer cleanup preserves the workload error without logging', async t => {
  const original = new Error('Presence clock refused');
  const log = t.mock.method(console, 'error', () => {});
  let finishes = 0;
  await assert.rejects(withPresencePeers({ finish: async () => { finishes++; } },
    async () => { throw original; }), error => error === original);
  assert.equal(finishes, 1);
  assert.equal(log.mock.callCount(), 0);
});

test('a cached finish rejection is not logged again as a cleanup failure', async t => {
  const original = new Error('Peer stopped during acknowledgement drain');
  const log = t.mock.method(console, 'error', () => {});
  let result, finishes = 0;
  const peers = { finish: () => { finishes++; return result ??= Promise.reject(original); } };
  await assert.rejects(withPresencePeers(peers, async () => { await peers.finish({ start: 0, end: 100 }); }),
    error => error === original);
  assert.equal(finishes, 2);
  assert.equal(log.mock.callCount(), 0);
});

test('peer cleanup failures still reject an otherwise successful workload', async () => {
  const finishError = new Error('peer loop failed');
  await assert.rejects(withPresencePeers({ finish: async () => { throw finishError; } },
    async () => 'typed'), error => error === finishError);
});

test('successful peer cleanup preserves the workload result', async () => {
  let finished = false;
  assert.equal(await withPresencePeers({ finish: async () => { finished = true; } }, async () => 'typed'), 'typed');
  assert.equal(finished, true);
});
