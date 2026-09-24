import { rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { createTestScratch } from "../workspaces/testTemp";
import { watchSettingsFile } from "./settingsFileWatcher";

function fakeDirectory() {
  let listener: ((fileName: string | null) => void) | null = null;
  let fail: ((error: Error) => void) | null = null;
  const close = vi.fn();
  const watchDirectory = vi.fn(
    (
      _directory: string,
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
    watchDirectory,
    emit: (fileName: string | null) => listener?.(fileName),
    fail: (error: Error) => fail?.(error),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("settings file watcher", () => {
  it("calls once after a burst of changes to the file settles, and ignores other files", () => {
    vi.useFakeTimers();
    const directory = fakeDirectory();
    const onChange = vi.fn();
    const stop = watchSettingsFile({
      directory: "/state",
      fileName: "dohc-settings.json",
      debounceMs: 150,
      onChange,
      onError: vi.fn(),
      watchDirectory: directory.watchDirectory,
    });

    // An editor's save: a temporary file, a rename onto the file, a touch.
    directory.emit("dohc-settings.json.tmp-1");
    directory.emit("dohc-settings.json");
    vi.advanceTimersByTime(100);
    directory.emit("dohc-settings.json");
    vi.advanceTimersByTime(149);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledOnce();

    directory.emit("Local State");
    vi.runAllTimers();
    expect(onChange).toHaveBeenCalledOnce();

    // A platform that omits the name may be reporting this file.
    directory.emit(null);
    vi.runAllTimers();
    expect(onChange).toHaveBeenCalledTimes(2);

    directory.emit("dohc-settings.json");
    stop();
    vi.runAllTimers();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(directory.close).toHaveBeenCalledOnce();
  });

  it("starts the watch again after it fails, and reads the file once it is back", () => {
    vi.useFakeTimers();
    const directory = fakeDirectory();
    const onChange = vi.fn();
    const onError = vi.fn();
    const stop = watchSettingsFile({
      directory: "/state",
      fileName: "dohc-settings.json",
      debounceMs: 150,
      retryMs: 2000,
      onChange,
      onError,
      watchDirectory: directory.watchDirectory,
    });

    const failure = new Error("EPERM");
    directory.fail(failure);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(directory.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2000);
    expect(directory.watchDirectory).toHaveBeenCalledTimes(2);
    // An edit may have landed while nothing watched.
    vi.advanceTimersByTime(150);
    expect(onChange).toHaveBeenCalledOnce();

    // The new watch hears the next save.
    directory.emit("dohc-settings.json");
    vi.runAllTimers();
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });

  it("keeps trying when the watch cannot start", () => {
    vi.useFakeTimers();
    const directory = fakeDirectory();
    const onChange = vi.fn();
    const onError = vi.fn();
    directory.watchDirectory
      .mockImplementationOnce(() => { throw new Error("ENOENT"); })
      .mockImplementationOnce(() => { throw new Error("ENOENT"); });
    const stop = watchSettingsFile({
      directory: "/state",
      fileName: "dohc-settings.json",
      debounceMs: 150,
      retryMs: 2000,
      onChange,
      onError,
      watchDirectory: directory.watchDirectory,
    });
    expect(onError).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2000);
    expect(onError).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2000);
    expect(directory.watchDirectory).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(150);
    expect(onChange).toHaveBeenCalledOnce();

    stop();
    directory.fail(new Error("late"));
    vi.runAllTimers();
    expect(directory.watchDirectory).toHaveBeenCalledTimes(3);
  });

  describe("on the real file system", () => {
    async function watched() {
      const root = await createTestScratch("dohc-settings-watch-");
      const path = join(root, "dohc-settings.json");
      await writeFile(path, "{}");
      let changed = deferred();
      const stop = watchSettingsFile({
        directory: root,
        fileName: "dohc-settings.json",
        debounceMs: 0,
        onChange: () => changed.resolve(),
        onError: (error) => changed.reject(error),
      });
      return {
        root,
        path,
        stop,
        // Waits for the next settled change, then arms for the one after.
        changed: async () => {
          await changed.promise;
          changed = deferred();
        },
      };
    }

    it("hears a save in place", async () => {
      const file = await watched();
      try {
        await writeFile(file.path, "{\"a\":1}");
        await file.changed();
      } finally {
        file.stop();
      }
    }, 60_000);

    it("hears a save that renames a new file over the old one", async () => {
      const file = await watched();
      try {
        await writeFile(join(file.root, "dohc-settings.json.new"), "{\"a\":2}");
        await rename(join(file.root, "dohc-settings.json.new"), file.path);
        await file.changed();
      } finally {
        file.stop();
      }
    }, 60_000);

    it("hears a save that deletes the file and renames a new one in", async () => {
      const file = await watched();
      try {
        await unlink(file.path);
        await writeFile(join(file.root, "dohc-settings.json~"), "{\"a\":3}");
        await rename(join(file.root, "dohc-settings.json~"), file.path);
        await file.changed();
        // The watch outlives the delete: the next save is heard too.
        await writeFile(file.path, "{\"a\":4}");
        await file.changed();
      } finally {
        file.stop();
      }
    }, 60_000);
  });
});
