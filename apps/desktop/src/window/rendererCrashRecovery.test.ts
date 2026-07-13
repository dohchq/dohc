import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CRASH_LOOP_MAX_RELOADS,
  CRASH_LOOP_WINDOW_MS,
  crashLoopPolicy,
  installRendererCrashRecovery,
  isCleanRendererExit,
} from "./rendererCrashRecovery";

type GoneListener = (
  event: unknown,
  details: { reason: string; exitCode: number },
) => void;

function fakeWebContents() {
  let listener: GoneListener | null = null;
  const reloads: number[] = [];
  let destroyed = false;
  return {
    contents: {
      on(_event: "render-process-gone", next: GoneListener) {
        listener = next;
        return this;
      },
      reload() {
        reloads.push(Date.now());
      },
      isDestroyed: () => destroyed,
    },
    crash(reason = "crashed", exitCode = 139) {
      listener?.(undefined, { reason, exitCode });
    },
    reloads,
    destroy() {
      destroyed = true;
    },
  };
}

describe("crashLoopPolicy", () => {
  it("reloads for the first crashes and stops at the loop cap", () => {
    let recent: number[] = [];
    for (let i = 0; i < CRASH_LOOP_MAX_RELOADS; i += 1) {
      const decision = crashLoopPolicy(recent, 1_000 + i);
      expect(decision.reload).toBe(true);
      recent = decision.recentCrashesMs;
    }
    const over = crashLoopPolicy(recent, 1_000 + CRASH_LOOP_MAX_RELOADS);
    expect(over.reload).toBe(false);
  });

  it("forgets crashes older than the loop window", () => {
    let recent: number[] = [];
    for (let i = 0; i < CRASH_LOOP_MAX_RELOADS + 2; i += 1) {
      recent = crashLoopPolicy(recent, i).recentCrashesMs;
    }
    const later = crashLoopPolicy(recent, CRASH_LOOP_WINDOW_MS + 100);
    expect(later.reload).toBe(true);
    expect(later.recentCrashesMs).toHaveLength(1);
  });
});

describe("isCleanRendererExit", () => {
  it("treats only clean-exit as clean — a killed renderer blanks the window like a crash", () => {
    expect(isCleanRendererExit("clean-exit")).toBe(true);
    expect(isCleanRendererExit("killed")).toBe(false);
    expect(isCleanRendererExit("crashed")).toBe(false);
    expect(isCleanRendererExit("oom")).toBe(false);
    expect(isCleanRendererExit("launch-failed")).toBe(false);
  });
});

describe("installRendererCrashRecovery", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reloads the window when the renderer crashes", () => {
    const fake = fakeWebContents();
    installRendererCrashRecovery(fake.contents, () => 1_000);
    fake.crash("crashed");
    expect(fake.reloads).toHaveLength(1);
  });

  it("awaits main-owned resource cleanup before reloading", async () => {
    const fake = fakeWebContents();
    let finishCleanup: (() => void) | undefined;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    installRendererCrashRecovery(fake.contents, () => 1_000, cleanup);

    fake.crash("crashed");
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(fake.reloads).toHaveLength(0);

    finishCleanup?.();
    await vi.waitFor(() => expect(fake.reloads).toHaveLength(1));
  });

  it("still reloads when main-owned resource cleanup fails", async () => {
    const fake = fakeWebContents();
    installRendererCrashRecovery(
      fake.contents,
      () => 1_000,
      async () => {
        throw new Error("cleanup failed");
      },
    );

    fake.crash("crashed");
    await vi.waitFor(() => expect(fake.reloads).toHaveLength(1));
  });

  it("ignores intentional clean exits", () => {
    const fake = fakeWebContents();
    installRendererCrashRecovery(fake.contents, () => 1_000);
    fake.crash("clean-exit", 0);
    expect(fake.reloads).toHaveLength(0);
  });

  it("reloads for an externally killed renderer — it blanks the window like a crash", () => {
    const fake = fakeWebContents();
    installRendererCrashRecovery(fake.contents, () => 1_000);
    fake.crash("killed", 0);
    expect(fake.reloads).toHaveLength(1);
  });

  it("stops reloading after a crash loop inside the window", () => {
    let now = 0;
    const fake = fakeWebContents();
    installRendererCrashRecovery(fake.contents, () => {
      now += 1_000;
      return now;
    });
    for (let i = 0; i < CRASH_LOOP_MAX_RELOADS + 2; i += 1) fake.crash("oom");
    expect(fake.reloads).toHaveLength(CRASH_LOOP_MAX_RELOADS);
  });

  it("never reloads a destroyed webContents", () => {
    const fake = fakeWebContents();
    installRendererCrashRecovery(fake.contents, () => 1_000);
    fake.destroy();
    fake.crash("crashed");
    expect(fake.reloads).toHaveLength(0);
  });
});
