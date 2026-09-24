import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { createTestScratch } from "../workspaces/testTemp";
import { watchSettingsFile } from "./settingsFileWatcher";

function fakeDirectory() {
  let listener: ((fileName: string | null) => void) | null = null;
  const close = vi.fn();
  return {
    close,
    emit: (fileName: string | null) => listener?.(fileName),
    watchDirectory: (_directory: string, next: (fileName: string | null) => void) => {
      listener = next;
      return { close };
    },
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

  it("hears a save to the real file", async () => {
    const root = await createTestScratch("dohc-settings-watch-");
    const changed = deferred();
    const stop = watchSettingsFile({
      directory: root,
      fileName: "dohc-settings.json",
      debounceMs: 0,
      onChange: () => changed.resolve(),
      onError: (error) => changed.reject(error),
    });
    try {
      await writeFile(join(root, "dohc-settings.json"), "{}");
      await changed.promise;
    } finally {
      stop();
    }
  }, 60_000);
});
