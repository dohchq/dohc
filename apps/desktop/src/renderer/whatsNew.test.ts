import { describe, expect, it } from "vitest";
import { takeUnseenWhatsNew, WHATS_NEW } from "./whatsNew";
import { parseTab, tabPath, TAB_KINDS, WHATS_NEW_TAB_PATH } from "./workbench/workbenchState";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("takeUnseenWhatsNew", () => {
  it("stays closed on a first launch and records the newest release", () => {
    const storage = memoryStorage();
    expect(takeUnseenWhatsNew(storage)).toBe(false);
    expect(storage.getItem("dohc.whatsNew.seen")).toBe(WHATS_NEW[0]!.id);
  });

  it("opens once after an update brings a new release", () => {
    const storage = memoryStorage({ "dohc.whatsNew.seen": "an-older-release" });
    expect(takeUnseenWhatsNew(storage)).toBe(true);
    expect(takeUnseenWhatsNew(storage)).toBe(false);
  });

  it("stays closed when storage refuses", () => {
    const refusing = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    };
    expect(takeUnseenWhatsNew(refusing)).toBe(false);
  });

  it("gives every release a distinct id", () => {
    expect(new Set(WHATS_NEW.map((release) => release.id)).size).toBe(WHATS_NEW.length);
  });
});

describe("What's new tab", () => {
  it("round-trips as a virtual tab", () => {
    const tab = parseTab(WHATS_NEW_TAB_PATH);
    expect(tab.kind).toBe("whatsNew");
    expect(tabPath(tab)).toBe(WHATS_NEW_TAB_PATH);
    expect(TAB_KINDS.whatsNew.virtual).toBe(true);
    expect(TAB_KINDS.whatsNew.title(tab)).toBe("What's new");
  });
});
