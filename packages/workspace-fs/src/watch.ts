export type WatchWorkspaceOptions = {
  rootDir: string;
  pollMs?: number;
  signal?: AbortSignal;
  onChange(): void | Promise<void>;
};

export function watchWorkspace({
  pollMs = 1000,
  signal,
  onChange,
}: WatchWorkspaceOptions): () => void {
  if (signal?.aborted) return () => undefined;
  let isRunning = false;
  const timer = setInterval(() => {
    if (isRunning) return;
    isRunning = true;
    void Promise.resolve(onChange())
      .catch((error) => {
        console.error("[workspace-fs] watch onChange failed", error);
      })
      .finally(() => {
        isRunning = false;
      });
  }, pollMs);
  const stop = () => clearInterval(timer);
  signal?.addEventListener("abort", stop, { once: true });
  return stop;
}
