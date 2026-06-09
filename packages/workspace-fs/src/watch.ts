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
  const timer = setInterval(() => {
    void onChange();
  }, pollMs);
  const stop = () => clearInterval(timer);
  signal?.addEventListener("abort", stop, { once: true });
  return stop;
}
