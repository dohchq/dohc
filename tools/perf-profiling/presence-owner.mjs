// These functions run in the owner renderer through the existing CDP connection.
export function observePresenceOwner(element) {
  const editor = element.editor;
  if (!editor?.extensionManager) throw new Error('Owner Tiptap editor is unavailable');
  const caret = editor.extensionManager.extensions.find(extension => ['collaborationCaret', 'collaborationCursor'].includes(extension.name));
  const awareness = caret?.options.provider?.awareness;
  if (caret && !awareness) throw new Error('Caret binding does not expose its owner awareness');
  const marker = '\u25c7';
  const state = window.__presenceOwner = { before: element.textContent.split(marker).length - 1, updates: [],
    binding: awareness ? 'caret-awareness' : 'unbound', stop: () => {} };
  if (awareness) {
    const receive = ({ added, updated }) => {
      const count = [...added, ...updated].filter(id => id !== awareness.clientID).length;
      if (count) state.updates.push({ time: performance.now(), count });
    };
    awareness.on('update', receive);
    state.stop = () => awareness.off('update', receive);
  }
}

export function recordPresenceOwnerLastKey(element) {
  const state = window.__presenceOwner;
  if (!state) throw new Error('Owner presence observation was not installed');
  state.receivedEditsAtLastKey = element.textContent.split('\u25c7').length - 1 - state.before;
}

export async function waitForPresenceOwner(page, sentEdits, { timeout = 120_000 } = {}) {
  try {
    await page.waitForFunction(expected => {
      const state = window.__presenceOwner;
      const element = document.querySelector('[contenteditable="true"].tiptap');
      if (!state || !element) return false;
      state.observedEdits = element.textContent.split('\u25c7').length - 1 - state.before;
      return state.observedEdits === expected;
    }, sentEdits, { timeout });
  } catch (error) {
    const observed = await page.evaluate(() => window.__presenceOwner?.observedEdits ?? null).catch(() => null);
    throw new Error(`Owner delivery deadline: received ${observed ?? 'unknown'} of ${sentEdits} peer edits`, { cause: error });
  }
}

export function readPresenceOwner(element, typingWindow) {
  const state = window.__presenceOwner;
  if (!state) throw new Error('Owner presence observation was not installed');
  state.stop();
  delete window.__presenceOwner;
  return { binding: state.binding, receivedEditsAtLastKey: state.receivedEditsAtLastKey, receivedEdits: element.textContent.split('\u25c7').length - 1 - state.before,
    presenceUpdatesReceived: state.updates.filter(update => update.time >= typingWindow.start && update.time <= typingWindow.end)
      .reduce((sum, update) => sum + update.count, 0) };
}

export function validatePresenceWorkload(workload, owner) {
  const sentEdits = workload.peerCounts.reduce((sum, peer) => sum + peer.edits, 0);
  const windowEdits = workload.peerCounts.reduce((sum, peer) => sum + peer.windowEdits, 0);
  const minimumEditsAtLastKey = Math.max(0, windowEdits - workload.peers);
  return { ...workload, sentEdits, minimumEditsAtLastKey, owner,
    pass: workload.pass && owner.receivedEdits === sentEdits &&
      Number.isInteger(owner.receivedEditsAtLastKey) && owner.receivedEditsAtLastKey >= minimumEditsAtLastKey &&
      Number.isInteger(owner.presenceUpdatesReceived) && owner.presenceUpdatesReceived >= 0 &&
      (owner.binding === 'unbound' || (owner.binding === 'caret-awareness' && owner.presenceUpdatesReceived > 0)) };
}

// Sample once before each typing arm. Both peer ticks and the rebased window use
// Node's monotonic clock; renderer awareness keeps its own, unre-based window.
export async function samplePresenceClock(page, now = () => performance.now()) {
  const before = now();
  const rendererNow = await page.evaluate(() => performance.now());
  const after = now();
  return { rendererToNodeOffsetMs: (before + after) / 2 - rendererNow, roundTripMs: after - before };
}

export function rebasePresenceWindow(window, clock) {
  return { start: window.start + clock.rendererToNodeOffsetMs, end: window.end + clock.rendererToNodeOffsetMs };
}
