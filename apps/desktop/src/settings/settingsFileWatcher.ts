import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

type WatchSettings = (
  directory: string,
  fileName: string,
  listener: (fileName: string | null) => void,
  onError: (error: Error) => void,
) => { close(): void };

// macOS starts a directory's FSEvents stream asynchronously. A file watch
// covers an in-place save during startup; the folder watch survives replacement.
const watchSettings: WatchSettings = (directory, fileName, listener, onError) => {
  let fileWatcher: FSWatcher | undefined;
  const closeFile = () => {
    fileWatcher?.close();
    fileWatcher = undefined;
  };
  const openFile = () => {
    closeFile();
    try {
      fileWatcher = watch(join(directory, fileName), () => listener(fileName));
      fileWatcher.on("error", onError);
      fileWatcher.unref();
    } catch (error) {
      // A delete or a first launch can leave only the directory to watch.
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  };
  const directoryWatcher = watch(directory, (event, name) => {
    if (name !== null && name !== fileName) return;
    try {
      if (event === "rename" || !fileWatcher) openFile();
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    listener(name);
  });
  directoryWatcher.on("error", onError);
  // Neither watch keeps the process alive on its own.
  directoryWatcher.unref();
  try {
    openFile();
  } catch (error) {
    directoryWatcher.close();
    throw error;
  }
  return {
    close: () => {
      closeFile();
      directoryWatcher.close();
    },
  };
};

/**
 * Calls onChange once a burst of changes to one file settles. An editor's
 * save is often several events: a write, a rename, a timestamp touch. A watch
 * that fails, at the start or later, is started again after `retryMs`.
 * The file counts as changed after every successful open, because an edit
 * may have landed while nothing watched. Answers the function that stops the watch.
 */
export function watchSettingsFile(options: {
  directory: string;
  fileName: string;
  debounceMs: number;
  retryMs?: number;
  onChange: () => void;
  onError: (error: Error) => void;
  watchSettings?: WatchSettings;
}): () => void {
  const start = options.watchSettings ?? watchSettings;
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
        options.fileName,
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

  if (open()) changed();
  return () => {
    stopped = true;
    clearTimeout(debounce);
    clearTimeout(retry);
    watcher?.close();
  };
}
