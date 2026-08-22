import { describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_SETTINGS } from "../settings/userSettings";
import {
  createGuestZoomApplier,
  createUserSettingsWriteQueue,
  createZoomMutation,
  nextZoomLevel,
  resolvePersistedZoomApplication,
} from "./windowZoom";

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
    enqueue: createUserSettingsWriteQueue(),
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

describe("resolvePersistedZoomApplication", () => {
  it("the first level of a launch applies everywhere, hosts and guests", () => {
    // A guest attached before the launch read resolved would otherwise stay
    // at 100% until the next zoom change.
    expect(resolvePersistedZoomApplication(2, null)).toEqual({
      applyEverywhere: 2,
    });
  });

  it("a user zoom that landed first outranks the launch read", () => {
    expect(resolvePersistedZoomApplication(2, 1)).toEqual({ applyToWindow: 1 });
  });

  it("with nothing known and nothing persisted there is nothing to apply", () => {
    expect(resolvePersistedZoomApplication(null, null)).toBeNull();
  });
});

describe("createGuestZoomApplier", () => {
  function fakeGuest() {
    const calls: number[] = [];
    let destroyed = false;
    let loadHandler: (() => void) | undefined;
    return {
      guest: {
        isDestroyed: () => destroyed,
        setZoomLevel: (level: number) => calls.push(level),
        on: (_event: "did-finish-load", handler: () => void) => {
          loadHandler = handler;
        },
      },
      calls,
      destroy: () => {
        destroyed = true;
      },
      finishLoad: () => loadHandler?.(),
    };
  }

  it("applies the current level at attach and again on every load", () => {
    let level: number | null = 2;
    const bind = createGuestZoomApplier(() => level);
    const { guest, calls, finishLoad } = fakeGuest();
    bind(guest);
    expect(calls).toEqual([2]);
    // Chromium scopes zoom per origin: the first navigation must re-apply.
    finishLoad();
    expect(calls).toEqual([2, 2]);
    // A zoom change while the guest is still loading wins at load time.
    level = 3;
    finishLoad();
    expect(calls).toEqual([2, 2, 3]);
  });

  it("a guest attached before the first level is known applies nothing yet, then takes the load-time level", () => {
    let level: number | null = null;
    const bind = createGuestZoomApplier(() => level);
    const { guest, calls, finishLoad } = fakeGuest();
    bind(guest);
    expect(calls).toEqual([]);
    level = 1;
    finishLoad();
    expect(calls).toEqual([1]);
  });

  it("never touches a destroyed guest", () => {
    const bind = createGuestZoomApplier(() => 2);
    const { guest, calls, destroy, finishLoad } = fakeGuest();
    destroy();
    bind(guest);
    finishLoad();
    expect(calls).toEqual([]);
  });
});

describe("the zoom mutation", () => {
  it("persists before it applies, and a failed write applies nothing", async () => {
    const applied: number[] = [];
    const step = createZoomMutation({
      enqueue: createUserSettingsWriteQueue(),
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

  it("refuses to replace recovered settings", async () => {
    const write = vi.fn(async () => undefined);
    const apply = vi.fn();
    const step = createZoomMutation({
      enqueue: createUserSettingsWriteQueue(),
      read: async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "recovered" as const,
        warning: "The settings file could not be read.",
      }),
      write,
      apply,
    });

    // The refusal is the read's own recovery reason, never a guess; the
    // caller's surface appends its own next step.
    await expect(step("in")).rejects.toThrow(
      "The settings file could not be read.",
    );
    expect(write).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("runs a full save enqueued between two zoom steps strictly between them", async () => {
    const enqueue = createUserSettingsWriteQueue();
    const order: string[] = [];
    let stored = DEFAULT_USER_SETTINGS;
    const step = createZoomMutation({
      enqueue,
      read: async () => {
        order.push(`read:${stored.appearance.zoomLevel}`);
        return { settings: stored, source: "stored" as const };
      },
      write: async (settings) => {
        order.push(`write:${settings.appearance.zoomLevel}`);
        stored = settings;
      },
      apply: (zoomLevel) => order.push(`apply:${zoomLevel}`),
    });

    const first = step("in");
    const fullSave = enqueue(async () => {
      order.push("full-save");
    });
    const second = step("in");

    await Promise.all([first, fullSave, second]);
    expect(order).toEqual([
      "read:0",
      "write:1",
      "apply:1",
      "full-save",
      "read:1",
      "write:2",
      "apply:2",
    ]);
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
