/** Raised only around fetch, before response handling or JSON parsing. */
export class NamedDatasetOfflineError extends Error {}

export async function namedDatasetFetch(fetchResponse: (signal: AbortSignal) => Promise<Response>, signal?: AbortSignal | null,
  deadline = AbortSignal.timeout(15_000)): Promise<Response> {
  const combined = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
  try { signal?.throwIfAborted(); return await fetchResponse(combined); }
  catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted || error instanceof TypeError) throw new NamedDatasetOfflineError("The sharing server is offline. Showing saved pages.", { cause: error });
    throw error;
  }
}
