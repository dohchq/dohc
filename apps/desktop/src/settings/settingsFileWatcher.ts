import { watch } from "node:fs";

type WatchDirectory = (
  directory: string,
  listener: (fileName: string | null) => void,
  onError: (error: Error) => void,
) => { close(): void };

// Watches the folder, not the file: an editor that saves by renaming a new
// file over the old one would end a watch held on the old file.
const watchDirectory: WatchDirectory = (directory, listener, onError) => {
  const watcher = watch(directory, (_event, fileName) => listener(fileName));
  watcher.on("error", onError);
  // The watch never keeps the process alive on its own.
  watcher.unref();
  return watcher;
};

/**
 * Calls onChange once a burst of changes to one file settles. An editor's
 * save is often several events: a write, a rename, a timestamp touch.
 * Answers the function that stops the watch.
 */
export function watchSettingsFile(options: {
  directory: string;
  fileName: string;
  debounceMs: number;
  onChange: () => void;
  onError: (error: Error) => void;
  watchDirectory?: WatchDirectory;
}): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = (options.watchDirectory ?? watchDirectory)(
    options.directory,
    (fileName) => {
      // Some platforms omit the name, so that change may be this file.
      if (fileName !== null && fileName !== options.fileName) return;
      clearTimeout(timer);
      timer = setTimeout(options.onChange, options.debounceMs);
    },
    options.onError,
  );
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
