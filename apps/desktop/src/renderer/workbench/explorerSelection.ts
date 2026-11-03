// A list's selection over its keys in display order: the selected keys, the
// anchor a range runs from, and the focused key. Pure, so Files and Home can
// share it and a table of cases can test it.

export type ExplorerSelection = {
  selected: ReadonlySet<string>;
  anchor: string | null;
  focus: string | null;
};

// A plain click: the key alone, and the anchor for the next range.
export function selectOne(key: string): ExplorerSelection {
  return { selected: new Set([key]), anchor: key, focus: key };
}

// Ctrl-click or Cmd-click: add or remove the key. The key becomes the anchor
// either way, so a Shift-click after it runs from there.
export function toggle(state: ExplorerSelection, key: string): ExplorerSelection {
  const selected = new Set(state.selected);
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  return { selected, anchor: key, focus: key };
}

// Shift-click: every key from the anchor to `key`, in either direction. The
// anchor stays. Null when the list no longer has the anchor or the key, so
// the caller can treat the click as a plain one.
export function selectRange(state: ExplorerSelection, keys: readonly string[], key: string): ExplorerSelection | null {
  const from = state.anchor === null ? -1 : keys.indexOf(state.anchor);
  const to = keys.indexOf(key);
  if (from === -1 || to === -1) return null;
  const [lo, hi] = from < to ? [from, to] : [to, from];
  return { selected: new Set(keys.slice(lo, hi + 1)), anchor: state.anchor, focus: key };
}

// Shift+Up or Shift+Down: move the focus one key and select from the anchor
// to it. With no anchor in the list, the range starts at the focus. Null at
// either end of the list, or when the list has no focus to move from.
export function extendBy(state: ExplorerSelection, keys: readonly string[], step: -1 | 1): ExplorerSelection | null {
  const at = state.focus === null ? -1 : keys.indexOf(state.focus);
  if (at === -1) return null;
  const next = keys[at + step];
  if (next === undefined) return null;
  const anchor = state.anchor !== null && keys.includes(state.anchor) ? state.anchor : keys[at]!;
  return selectRange({ ...state, anchor }, keys, next);
}

// Ctrl+A or Cmd+A: every key. The anchor stays if the list still has it.
export function selectAll(state: ExplorerSelection, keys: readonly string[]): ExplorerSelection {
  const anchor = state.anchor !== null && keys.includes(state.anchor) ? state.anchor : (keys[0] ?? null);
  return { selected: new Set(keys), anchor, focus: state.focus };
}

// Escape: nothing selected. The focus stays where it is.
export function clear(state: ExplorerSelection): ExplorerSelection {
  return { selected: new Set(), anchor: null, focus: state.focus };
}
