import { describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_SETTINGS } from "../settings/userSettings";
import { createZoomMutation, nextZoomLevel } from "./windowZoom";

function storeAt(zoomLevel: number) {
  let stored = {
    ...DEFAULT_USER_SETTINGS,
    appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel },
  };
  const applied: number[] = [];
  const gates: Array<() => void> = [];
  const read = vi.fn(async () => ({
    settings: stored,
    source: "stored" as const,
  }));
  const write = vi.fn(async (settings: typeof stored) => {
    // Hold every write until the test releases it, so concurrency is real.
    await new Promise<void>((release) => gates.push(release));
    stored = settings;
  });
  const step = createZoomMutation({
    read,
    write,
    apply: (level) => applied.push(level),
  });
  return {
    step,
    applied,
    read,
    write,
    stored: () => stored,
    releaseWrites: () => {
      while (gates.length > 0) gates.shift()?.();
    },
  };
}

describe("nextZoomLevel", () => {
  it("steps by one level, clamps at the bounds, and resets to 100%", () => {
    expect(nextZoomLevel(0, "in")).toBe(1);
    expect(nextZoomLevel(0, "out")).toBe(-1);
    expect(nextZoomLevel(5, "in")).toBe(5);
    expect(nextZoomLevel(-5, "out")).toBe(-5);
    expect(nextZoomLevel(3, "reset")).toBe(0);
  });
});

describe("the zoom mutation", () => {
  it("persists before it applies, and a failed write applies nothing", async () => {
    const applied: number[] = [];
    const step = createZoomMutation({
      read: async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "stored" as const,
      }),
      write: async () => {
        throw new Error("Disk full");
      },
      apply: (level) => applied.push(level),
    });
    await expect(step("in")).rejects.toThrow("Disk full");
    expect(applied).toEqual([]);
  });

  it("two quick steps land on two levels, not one (#concurrent read race)", async () => {
    const store = storeAt(0);
    const first = step2(store, "in");
    const second = step2(store, "in");
    // Both are queued; releasing writes as they occur must still serialize
    // read-modify-write so the second step reads the first step's result.
    const settle = Promise.all([first, second]);
    await drainUntilSettled(store, settle);
    expect(store.stored().appearance.zoomLevel).toBe(2);
    expect(store.applied).toEqual([1, 2]);
  });

  it("a step at the bound is a no-op that writes nothing", async () => {
    const store = storeAt(5);
    const result = step2(store, "in");
    store.releaseWrites();
    expect((await result).settings.appearance.zoomLevel).toBe(5);
    expect(store.write).not.toHaveBeenCalled();
  });
});

function step2(
  store: ReturnType<typeof storeAt>,
  direction: "in" | "out" | "reset",
) {
  return store.step(direction);
}

async function drainUntilSettled(
  store: ReturnType<typeof storeAt>,
  settle: Promise<unknown>,
): Promise<void> {
  let settled = false;
  void settle.then(() => {
    settled = true;
  });
  // Release write gates as the serialized chain creates them.
  for (let i = 0; i < 50 && !settled; i += 1) {
    store.releaseWrites();
    await Promise.resolve();
    await Promise.resolve();
  }
  await settle;
}
