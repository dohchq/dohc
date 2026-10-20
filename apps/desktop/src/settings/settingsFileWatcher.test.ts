import { watch } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { createTestScratch } from "../workspaces/testTemp";
import { watchSettingsFile } from "./settingsFileWatcher";

vi.mock("node:fs", { spy: true });

function fakeSettingsWatch() {
  let listener: ((fileName: string | null) => void) | null = null;
  let fail: ((error: Error) => void) | null = null;
  const close = vi.fn();
  const watchSettings = vi.fn(
    (
      _directory: string,
      _fileName: string,
      next: (fileName: string | null) => void,
      onError: (error: Error) => void,
    ) => {
      listener = next;
      fail = onError;
      return { close };
    },
  );
  return {
    close,
    watchSettings,
    emit: (fileName: string | null) => listener?.(fileName),
    fail: (error: Error) => fail?.(error),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("settings file watcher", () => {
  it("reads settings after opening the watch even when no event arrives", () => {
    vi.useFakeTimers();
    const settingsWatch = fakeSettingsWatch();
    const onChange = vi.fn();
    const stop = watchSettingsFile({
      directory: "/state",
      fileName: "dohc-settings.json",
      debounceMs: 150,
      onChange,
      onError: vi.fn(),
      watchSettings: settingsWatch.watchSettings,
    });
    try {
      expect(settingsWatch.watchSettings).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(149);
      expect(onChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onChange).toHaveBeenCalledOnce();
      vi.runAllTimers();
      expect(onChange).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });

  it("calls once after a burst of changes to the file settles, and ignores other files", () => {
    vi.useFakeTimers();
    const settingsWatch = fakeSettingsWatch();
    const onChange = vi.fn();
    const stop = watchSettingsFile({
      directory: "/state",
      fileName: "dohc-settings.json",
      debounceMs: 150,
      onChange,
      onError: vi.fn(),
      watchSettings: settingsWatch.watchSettings,
    });

    vi.advanceTimersByTime(150);
    onChange.mockClear();

    // An editor's save: a temporary file, a rename onto the file, a touch.
    settingsWatch.emit("dohc-settings.json.tmp-1");
    settingsWatch.emit("dohc-settings.json");
    vi.advanceTimersByTime(100);
    settingsWatch.emit("dohc-settings.json");
    vi.advanceTimersByTime(149);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledOnce();

    settingsWatch.emit("Local State");
    vi.runAllTimers();
    expect(onChange).toHaveBeenCalledOnce();

    // A platform that omits the name may be reporting this file.
    settingsWatch.emit(null);
    vi.runAllTimers();
    expect(onChange).toHaveBeenCalledTimes(2);

    settingsWatch.emit("dohc-settings.json");
    stop();
    vi.runAllTimers();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(settingsWatch.close).toHaveBeenCalledOnce();
  });

  it("starts the watch again after it fails, and reads the file once it is back", () => {
    vi.useFakeTimers();
    const settingsWatch = fakeSettingsWatch();
    const onChange = vi.fn();
    const onError = vi.fn();
    const stop = watchSettingsFile({
      directory: "/state",
      fileName: "dohc-settings.json",
      debounceMs: 150,
      retryMs: 2000,
      onChange,
      onError,
      watchSettings: settingsWatch.watchSettings,
    });

    vi.advanceTimersByTime(150);
    onChange.mockClear();

    const failure = new Error("EPERM");
    settingsWatch.fail(failure);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(settingsWatch.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2000);
    expect(settingsWatch.watchSettings).toHaveBeenCalledTimes(2);
    // An edit may have landed while nothing watched.
    vi.advanceTimersByTime(150);
    expect(onChange).toHaveBeenCalledOnce();

    // The new watch hears the next save.
    settingsWatch.emit("dohc-settings.json");
    vi.runAllTimers();
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });

  it("keeps trying when the watch cannot start", () => {
    vi.useFakeTimers();
    const settingsWatch = fakeSettingsWatch();
    const onChange = vi.fn();
    const onError = vi.fn();
    settingsWatch.watchSettings
      .mockImplementationOnce(() => { throw new Error("ENOENT"); })
      .mockImplementationOnce(() => { throw new Error("ENOENT"); });
    const stop = watchSettingsFile({
      directory: "/state",
      fileName: "dohc-settings.json",
      debounceMs: 150,
      retryMs: 2000,
      onChange,
      onError,
      watchSettings: settingsWatch.watchSettings,
    });
    expect(onError).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2000);
    expect(onError).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2000);
    expect(settingsWatch.watchSettings).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(150);
    expect(onChange).toHaveBeenCalledOnce();

    stop();
    settingsWatch.fail(new Error("late"));
    vi.runAllTimers();
    expect(settingsWatch.watchSettings).toHaveBeenCalledTimes(3);
  });

  describe("on the real file system", () => {
    async function watched({ ignoreDirectoryEvents = false } = {}) {
      const root = await createTestScratch("dohc-settings-watch-");
      const path = join(root, "dohc-settings.json");
      await writeFile(path, "{}");
      const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
      const probeName = "watch-ready";
      let directoryReady = false;
      vi.mocked(watch).mockImplementationOnce((directory, listener) =>
        fs.watch(directory, (event, fileName) => {
          // Keep the in-place test dependent on the real file watch alone.
          if (ignoreDirectoryEvents) return;
          if (fileName === probeName) directoryReady = true;
          if (typeof listener === "function") listener(event, fileName);
        }),
      );
      let next = { content: "{}", changed: deferred() };
      const stop = watchSettingsFile({
        directory: root,
        fileName: "dohc-settings.json",
        debounceMs: 0,
        onChange: () => {
          // A read started for an earlier wait cannot satisfy a later save.
          const pending = next;
          void readFile(path, "utf8").then(
            (content) => {
              if (content === pending.content) pending.changed.resolve();
            },
            (error: unknown) => {
              // Deleting and recreating the file can briefly leave no file to read.
              if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
              pending.changed.reject(error);
            },
          );
        },
        onError: (error) => next.changed.reject(error),
      });
      // Consume the startup reload so only later saves can satisfy these waits.
      try {
        await next.changed.promise;
        if (!ignoreDirectoryEvents) {
          // The first probe write may precede FSEvents startup. Keep probing
          // until the real directory listener hears this unrelated file.
          while (!directoryReady) await writeFile(join(root, probeName), "ready");
        }
      } catch (error) {
        stop();
        throw error;
      }
      return {
        root,
        path,
        stop,
        changedTo: (content: string) => {
          next = { content, changed: deferred() };
          return next.changed.promise;
        },
      };
    }

    it("hears a save in place", async () => {
      const file = await watched({ ignoreDirectoryEvents: true });
      try {
        const saved = file.changedTo("{\"a\":1}");
        await writeFile(file.path, "{\"a\":1}");
        await saved;
      } finally {
        file.stop();
      }
    }, 60_000);

    it("hears a save that renames a new file over the old one", async () => {
      const file = await watched();
      try {
        const saved = file.changedTo("{\"a\":2}");
        await writeFile(join(file.root, "dohc-settings.json.new"), "{\"a\":2}");
        await rename(join(file.root, "dohc-settings.json.new"), file.path);
        await saved;
      } finally {
        file.stop();
      }
    }, 60_000);

    it("hears a save that deletes the file and renames a new one in", async () => {
      const file = await watched();
      try {
        const recreated = file.changedTo("{\"a\":3}");
        await unlink(file.path);
        await writeFile(join(file.root, "dohc-settings.json~"), "{\"a\":3}");
        await rename(join(file.root, "dohc-settings.json~"), file.path);
        await recreated;
        // The folder watch survives deletion and hears the next save too.
        const saved = file.changedTo("{\"a\":4}");
        await writeFile(file.path, "{\"a\":4}");
        await saved;
      } finally {
        file.stop();
      }
    }, 60_000);
  });
});
