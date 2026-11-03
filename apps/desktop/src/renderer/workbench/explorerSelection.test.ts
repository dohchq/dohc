import { describe, expect, it } from "vitest";
import { clear, extendBy, selectAll, selectOne, selectRange, toggle, type ExplorerSelection } from "./explorerSelection";

const KEYS = ["a", "b", "c", "d", "e"];

function state(selected: string[], anchor: string | null, focus: string | null = anchor): ExplorerSelection {
  return { selected: new Set(selected), anchor, focus };
}

function plain(result: ExplorerSelection | null) {
  return result === null ? null : { selected: [...result.selected].sort(), anchor: result.anchor, focus: result.focus };
}

describe("explorerSelection", () => {
  it.each([
    ["select one replaces the selection", () => selectOne("c"), { selected: ["c"], anchor: "c", focus: "c" }],
    ["toggle adds a key and anchors there", () => toggle(state(["a"], "a"), "c"), { selected: ["a", "c"], anchor: "c", focus: "c" }],
    ["toggle removes a key and still anchors there", () => toggle(state(["a", "c"], "a"), "c"), { selected: ["a"], anchor: "c", focus: "c" }],
    ["toggle on the anchor itself removes it and keeps it as the anchor", () => toggle(state(["b", "c"], "b"), "b"), { selected: ["c"], anchor: "b", focus: "b" }],
    ["range runs down from the anchor", () => selectRange(state(["b"], "b"), KEYS, "d"), { selected: ["b", "c", "d"], anchor: "b", focus: "d" }],
    ["range runs up from the anchor", () => selectRange(state(["d"], "d"), KEYS, "b"), { selected: ["b", "c", "d"], anchor: "d", focus: "b" }],
    ["range to the anchor itself is the anchor", () => selectRange(state(["a", "c"], "c"), KEYS, "c"), { selected: ["c"], anchor: "c", focus: "c" }],
    ["range replaces keys outside it", () => selectRange(state(["a", "e"], "c"), KEYS, "d"), { selected: ["c", "d"], anchor: "c", focus: "d" }],
    ["range with a missing anchor is refused", () => selectRange(state(["gone"], "gone"), KEYS, "c"), null],
    ["range with no anchor is refused", () => selectRange(state([], null), KEYS, "c"), null],
    ["range to a missing key is refused", () => selectRange(state(["a"], "a"), KEYS, "gone"), null],
    ["extend down grows from the anchor", () => extendBy(state(["b", "c"], "b", "c"), KEYS, 1), { selected: ["b", "c", "d"], anchor: "b", focus: "d" }],
    ["extend up past the anchor flips the range", () => extendBy(state(["b"], "b"), KEYS, -1), { selected: ["a", "b"], anchor: "b", focus: "a" }],
    ["extend back toward the anchor shrinks the range", () => extendBy(state(["b", "c", "d"], "b", "d"), KEYS, -1), { selected: ["b", "c"], anchor: "b", focus: "c" }],
    ["extend with a missing anchor starts at the focus", () => extendBy(state(["gone"], "gone", "c"), KEYS, 1), { selected: ["c", "d"], anchor: "c", focus: "d" }],
    ["extend with no anchor starts at the focus", () => extendBy(state([], null, "c"), KEYS, -1), { selected: ["b", "c"], anchor: "c", focus: "b" }],
    ["extend past the last key does nothing", () => extendBy(state(["e"], "e"), KEYS, 1), null],
    ["extend past the first key does nothing", () => extendBy(state(["a"], "a"), KEYS, -1), null],
    ["extend with no focus does nothing", () => extendBy(state([], null, null), KEYS, 1), null],
    ["extend with a missing focus does nothing", () => extendBy(state([], null, "gone"), KEYS, 1), null],
    ["select all keeps a live anchor and the focus", () => selectAll(state(["c"], "c", "d"), KEYS), { selected: KEYS, anchor: "c", focus: "d" }],
    ["select all with a missing anchor anchors at the first key", () => selectAll(state(["gone"], "gone", "b"), KEYS), { selected: KEYS, anchor: "a", focus: "b" }],
    ["select all of an empty list selects nothing", () => selectAll(state([], null, null), []), { selected: [], anchor: null, focus: null }],
    ["clear keeps the focus", () => clear(state(["a", "b"], "a", "b")), { selected: [], anchor: null, focus: "b" }],
  ] as const)("%s", (_name, run, expected) => {
    expect(plain(run())).toEqual(expected === null ? null : { ...expected, selected: [...expected.selected].sort() });
  });

  it("never changes the state it is given", () => {
    const before = state(["a", "b"], "a", "b");
    toggle(before, "c");
    selectRange(before, KEYS, "e");
    extendBy(before, KEYS, 1);
    selectAll(before, KEYS);
    clear(before);
    expect(plain(before)).toEqual({ selected: ["a", "b"], anchor: "a", focus: "b" });
  });
});
