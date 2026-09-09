/** Release source listeners when the host or its operation finishes. */
export function liveHostSignal(...sources: (AbortSignal | undefined)[]) {
  const signals = [...new Set(sources.filter((signal): signal is AbortSignal => signal !== undefined))];
  if (signals.length === 0) throw new Error("A live host signal is required.");
  if (signals.length === 1) return {signal: signals[0]!, dispose() {}};
  const controller = new AbortController();
  const listeners = signals.map(signal => ({signal, abort: () => controller.abort(signal.reason)}));
  const dispose = () => {
    for (const {signal, abort} of listeners) signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", dispose);
  };
  for (const {signal, abort} of listeners) {
    if (signal.aborted) {abort(); break;}
    signal.addEventListener("abort", abort, {once: true});
  }
  if (controller.signal.aborted) dispose();
  else controller.signal.addEventListener("abort", dispose, {once: true});
  return {signal: controller.signal, dispose};
}

export async function withLiveHostSignal<T>(host: AbortSignal, caller: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const scope = liveHostSignal(host, caller);
  try {return await run(scope.signal);}
  finally {scope.dispose();}
}
