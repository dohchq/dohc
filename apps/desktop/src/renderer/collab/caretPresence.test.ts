import { Awareness } from "y-protocols/awareness";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  CARET_PALETTE,
  caretColorForClientId,
  caretFallbackName,
  caretSelectionRender,
  resolveCaretUser,
} from "./caretPresence";

describe("caretColorForClientId", () => {
  it("always returns a palette member", () => {
    const clientIds = [0, 1, 2, 3, 42, 1000, 2 ** 31 - 1, 123456789, -1];
    for (const id of clientIds) {
      expect(CARET_PALETTE).toContain(caretColorForClientId(id));
    }
  });

  it("is stable: the same clientId always maps to the same color", () => {
    for (const id of [7, 99, 424242]) {
      const first = caretColorForClientId(id);
      for (let i = 0; i < 5; i += 1) {
        expect(caretColorForClientId(id)).toBe(first);
      }
    }
  });

  it("spreads a run of clientIds across more than one palette slot", () => {
    // Not a strict distribution guarantee (it's a hash), but a real Yjs
    // clientID sequence should not all collapse onto one color.
    const colors = new Set(
      Array.from({ length: 40 }, (_, i) => caretColorForClientId(i * 104729)),
    );
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe("caretFallbackName", () => {
  it("is stable and formatted as 'Editor N'", () => {
    const name = caretFallbackName(12345);
    expect(name).toBe(caretFallbackName(12345));
    expect(name).toMatch(/^Editor \d+$/);
  });

  it("differs for different clientIds (usually)", () => {
    const names = new Set([1, 2, 3, 4, 5].map((id) => caretFallbackName(id * 7919)));
    expect(names.size).toBeGreaterThan(1);
  });
});

describe("resolveCaretUser", () => {
  it("falls back to a stable 'Editor N' name when awareness has no user yet", () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    try {
      const user = resolveCaretUser(awareness);
      expect(user.name).toBe(caretFallbackName(awareness.clientID));
      expect(user.color).toBe(caretColorForClientId(awareness.clientID));
    } finally {
      awareness.destroy();
      doc.destroy();
    }
  });

  it("reuses an already-set real display name instead of the fallback", () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    try {
      awareness.setLocalStateField("user", { name: "Alice", color: "#123456" });
      const user = resolveCaretUser(awareness);
      expect(user.name).toBe("Alice");
      // Color is always the hash — never trusts whatever was already there —
      // so every peer agrees on the same color for this clientId.
      expect(user.color).toBe(caretColorForClientId(awareness.clientID));
    } finally {
      awareness.destroy();
      doc.destroy();
    }
  });

  it("ignores a blank/whitespace-only existing name and falls back", () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    try {
      awareness.setLocalStateField("user", { name: "   ", color: "#123456" });
      const user = resolveCaretUser(awareness);
      expect(user.name).toBe(caretFallbackName(awareness.clientID));
    } finally {
      awareness.destroy();
      doc.destroy();
    }
  });
});

describe("caretSelectionRender", () => {
  it("emits the collaboration-carets__selection class with only color set", () => {
    const attrs = caretSelectionRender({ color: "#446a50" });
    expect(attrs.class).toBe("collaboration-carets__selection");
    expect(attrs.style).toBe("color: #446a50");
    expect(attrs.nodeName).toBe("span");
  });

  it("degrades to a palette color instead of throwing when color is missing/malformed", () => {
    expect(() => caretSelectionRender({})).not.toThrow();
    const attrs = caretSelectionRender({ color: 42 });
    expect(CARET_PALETTE.some((c) => attrs.style === `color: ${c}`)).toBe(true);
  });
});
