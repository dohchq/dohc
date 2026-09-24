import { watch } from "node:fs";

type WatchDirectory = (
  directory: string,
  listener: (fileName: string | null) => void,
  onError: (error: Error) => void,
) => { close(): void };

// Watches the folder, not the file: an editor that saves by renaming a new
// file over the old one, or by deleting and recreating it, would end a watch
// held on the old file.
const watchDirectory: WatchDirectory = (directory, listener, onError) => {
  const watcher = watch(directory, (_event, fileName) => listener(fileName));
  watcher.on("error", onError);
  // The watch never keeps the process alive on its own.
  watcher.unref();
  return watcher;
};

/**
 * Calls onChange once a burst of changes to one file settles. An editor's
 * save is often several events: a write, a rename, a timestamp touch. A watch
 * that fails, at the start or later, is started again after `retryMs`, and
 * the file counts as changed then, because an edit may have landed while
 * nothing watched. Answers the function that stops the watch.
 */
export function watchSettingsFile(options: {
  directory: string;
  fileName: string;
  debounceMs: number;
  retryMs?: number;
  onChange: () => void;
  onError: (error: Error) => void;
  watchDirectory?: WatchDirectory;
}): () => void {
  const start = options.watchDirectory ?? watchDirectory;
  const retryMs = options.retryMs ?? 2000;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let watcher: { close(): void } | null = null;
  let stopped = false;

  const changed = () => {
    clearTimeout(debounce);
    debounce = setTimeout(options.onChange, options.debounceMs);
  };
  const restartLater = (error: Error) => {
    options.onError(error);
    watcher?.close();
    watcher = null;
    if (stopped || retry !== undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      if (open()) changed();
    }, retryMs);
    retry.unref?.();
  };
  const open = (): boolean => {
    try {
      watcher = start(
        options.directory,
        (fileName) => {
          // Some platforms omit the name, so that change may be this file.
          if (fileName === null || fileName === options.fileName) changed();
        },
        restartLater,
      );
      return true;
    } catch (error) {
      restartLater(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  };

  open();
  return () => {
    stopped = true;
    clearTimeout(debounce);
    clearTimeout(retry);
    watcher?.close();
  };
}
