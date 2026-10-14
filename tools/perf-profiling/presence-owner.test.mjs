import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observePresenceOwner, readPresenceOwner, validatePresenceWorkload } from './presence-owner.mjs';
const workload = { pass: true, maxGapMs: 50, peerCounts: [{ edits: 5 }, { edits: 6 }] };
const owner = { binding: 'unbound', receivedEdits: 11, presenceUpdatesReceived: 0 };

test('owner must receive exactly the edits sent, including when presence is unbound', () => {
  assert.equal(validatePresenceWorkload(workload, owner).pass, true);
  assert.equal(validatePresenceWorkload(workload, { ...owner, receivedEdits: 10 }).pass, false);
  assert.equal(validatePresenceWorkload(workload, { ...owner, receivedEdits: 12 }).pass, false);
  assert.equal(validatePresenceWorkload(workload, { receivedEdits: 11 }).pass, false);
  assert.equal(validatePresenceWorkload(workload, { ...owner, binding: 'caret-awareness' }).pass, false);
  assert.equal(validatePresenceWorkload(workload, { ...owner, binding: 'caret-awareness', presenceUpdatesReceived: 2 }).pass, true);
});

test('a peer schedule gap above 100 ms fails even with enough ticks on average', () => {
  assert.equal(validatePresenceWorkload({ ...workload, maxGapMs: 100 }, owner).pass, true);
  assert.equal(validatePresenceWorkload({ ...workload, maxGapMs: 100.001 }, owner).pass, false);
});

test('owner observer counts only remote awareness updates between the first and last key', () => {
  globalThis.window = {};
  try {
    const awareness = new EventEmitter(); awareness.clientID = 1;
    const element = { textContent: 'initial\u25c7', editor: { extensionManager: { extensions: [
      { name: 'collaborationCaret', options: { provider: { awareness } } },
    ] } } };
    observePresenceOwner(element);
    const start = performance.timeOrigin + performance.now();
    awareness.emit('update', { added: [1, 2], updated: [3] });
    const end = performance.timeOrigin + performance.now();
    awareness.emit('update', { added: [4], updated: [] });
    element.textContent += '\u25c7\u25c7';
    assert.deepEqual(readPresenceOwner(element, { start, end }), { binding: 'caret-awareness', receivedEdits: 2, presenceUpdatesReceived: 2 });
    assert.equal(awareness.listenerCount('update'), 0);
  } finally { delete globalThis.window; }
});

test('an owner without a caret binding explicitly reports zero updates', () => {
  globalThis.window = {};
  try {
    const element = { textContent: 'initial', editor: { extensionManager: { extensions: [] } } };
    observePresenceOwner(element);
    assert.deepEqual(readPresenceOwner(element, { start: 0, end: Infinity }), { binding: 'unbound', receivedEdits: 0, presenceUpdatesReceived: 0 });
  } finally { delete globalThis.window; }
});
