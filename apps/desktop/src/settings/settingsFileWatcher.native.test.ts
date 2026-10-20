import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchSettingsFile } from "./settingsFileWatcher";

vi.mock("node:fs", { spy: true });

class NativeWatch extends EventEmitter {
  close = vi.fn();
  ref = vi.fn(() => this);
  unref = vi.fn(() => this);
}

function nativeWatches() {
  const watches = new Map<string, NativeWatch[]>();
  const absent = new Set<string>();
  const failures = new Map<string, Error>();
  vi.mocked(watch).mockImplementation((path, optionsOrListener) => {
    const name = String(path);
    const failure = failures.get(name);
    if (failure) throw failure;
    if (absent.has(name)) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    const watcher = new NativeWatch();
    if (typeof optionsOrListener === "function") {
      watcher.on("change", optionsOrListener);
    }
    const previous = watches.get(name) ?? [];
    watches.set(name, [...previous, watcher]);
    return watcher;
  });
  return { watches, absent, failures };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("native settings watches", () => {
  it("hears an in-place write when the directory delivers no event", () => {
    vi.useFakeTimers();
    const { watches } = nativeWatches();
    const onChange = vi.fn();
    const stop = watchSettingsFile({
      directory: "/state",
      fileName: "dohc-settings.json",
      debounceMs: 150,
      onChange,
      onError: vi.fn(),
    });
    try {
      const file = watches.get(join("/state", "dohc-settings.json"))?.[0];
      file?.emit("change", "change", "dohc-settings.json");
      vi.advanceTimersByTime(150);
      expect(onChange).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
    for (const watcher of [...watches.values()].flat()) {
      expect(watcher.unref).toHaveBeenCalledOnce();
      expect(watcher.close).toHaveBeenCalledOnce();
    }
  });

  it("reattaches after replacement and after the file is deleted and recreated", () => {
    vi.useFakeTimers();
    const { watches, absent } = nativeWatches();
    const path = join("/state", "dohc-settings.json");
    const onChange = vi.fn();
    const onError = vi.fn();
    const stop = watchSettingsFile({
      directory: "/state",
      fileName: "dohc-settings.json",
      debounceMs: 150,
      onChange,
      onError,
    });
    try {
      const directory = watches.get("/state")?.[0];
      const first = watches.get(path)?.[0];
      directory?.emit("change", "rename", "Local State");
      vi.advanceTimersByTime(150);
      expect(onChange).not.toHaveBeenCalled();
      expect(first?.close).not.toHaveBeenCalled();
      directory?.emit("change", "rename", "dohc-settings.json");
      expect(first?.close).toHaveBeenCalledOnce();
      expect(watches.get(path)).toHaveLength(2);

      absent.add(path);
      directory?.emit("change", "rename", "dohc-settings.json");
      absent.delete(path);
      directory?.emit("change", "rename", "dohc-settings.json");
      vi.advanceTimersByTime(150);
      onChange.mockClear();

      const recreated = watches.get(path)?.at(-1);
      recreated?.emit("change", "change", "dohc-settings.json");
      vi.advanceTimersByTime(150);
      expect(onChange).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      stop();
    }
    for (const watcher of [...watches.values()].flat()) {
      expect(watcher.close).toHaveBeenCalledOnce();
    }
  });

  it("attaches to a file created after the watch starts", () => {
    vi.useFakeTimers();
    const { watches, absent } = nativeWatches();
    const path = join("/state", "dohc-settings.json");
    absent.add(path);
    const onChange = vi.fn();
    const onError = vi.fn();
    const stop = watchSettingsFile({
      directory: "/state",
      fileName: "dohc-settings.json",
      debounceMs: 150,
      onChange,
      onError,
    });
    try {
      absent.delete(path);
      watches.get("/state")?.[0]?.emit("change", "rename", "dohc-settings.json");
      vi.advanceTimersByTime(150);
      onChange.mockClear();
      watches.get(path)?.[0]?.emit("change", "change", "dohc-settings.json");
      vi.advanceTimersByTime(150);
      expect(onChange).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("closes the directory when opening the file watch fails", () => {
    vi.useFakeTimers();
    const { watches, failures } = nativeWatches();
    const failure = Object.assign(new Error("EACCES"), { code: "EACCES" });
    failures.set(join("/state", "dohc-settings.json"), failure);
    const onError = vi.fn();
    const stop = watchSettingsFile({
      directory: "/state",
      fileName: "dohc-settings.json",
      debounceMs: 150,
      onChange: vi.fn(),
      onError,
    });
    stop();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(watches.get("/state")?.[0]?.close).toHaveBeenCalledOnce();
  });

  it("closes both watches and reopens them after a file watch error", () => {
    vi.useFakeTimers();
    const { watches } = nativeWatches();
    const path = join("/state", "dohc-settings.json");
    const onError = vi.fn();
    const stop = watchSettingsFile({
      directory: "/state",
      fileName: "dohc-settings.json",
      debounceMs: 150,
      retryMs: 2000,
      onChange: vi.fn(),
      onError,
    });
    try {
      const failure = new Error("watch failed");
      watches.get(path)?.[0]?.emit("error", failure);
      expect(onError).toHaveBeenCalledWith(failure);
      expect(watches.get("/state")?.[0]?.close).toHaveBeenCalledOnce();
      expect(watches.get(path)?.[0]?.close).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(2000);
      expect(watches.get("/state")).toHaveLength(2);
      expect(watches.get(path)).toHaveLength(2);
    } finally {
      stop();
    }
    for (const watcher of [...watches.values()].flat()) {
      expect(watcher.close).toHaveBeenCalledOnce();
    }
  });
});
