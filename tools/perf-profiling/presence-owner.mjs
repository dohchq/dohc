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
      if (count) state.updates.push({ time: performance.timeOrigin + performance.now(), count });
    };
    awareness.on('update', receive);
    state.stop = () => awareness.off('update', receive);
  }
}

export function readPresenceOwner(element, typingWindow) {
  const state = window.__presenceOwner;
  if (!state) throw new Error('Owner presence observation was not installed');
  state.stop();
  delete window.__presenceOwner;
  return { binding: state.binding, receivedEdits: element.textContent.split('\u25c7').length - 1 - state.before,
    presenceUpdatesReceived: state.updates.filter(update => update.time >= typingWindow.start && update.time <= typingWindow.end)
      .reduce((sum, update) => sum + update.count, 0) };
}

export function validatePresenceWorkload(workload, owner) {
  const sentEdits = workload.peerCounts.reduce((sum, peer) => sum + peer.edits, 0);
  return { ...workload, sentEdits, owner,
    pass: workload.pass && workload.maxGapMs <= 100 && owner.receivedEdits === sentEdits &&
      Number.isInteger(owner.presenceUpdatesReceived) && owner.presenceUpdatesReceived >= 0 &&
      (owner.binding === 'unbound' || (owner.binding === 'caret-awareness' && owner.presenceUpdatesReceived > 0)) };
}
