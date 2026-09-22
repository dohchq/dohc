/** Raised only around fetch, before response handling or JSON parsing. */
export class NamedDatasetOfflineError extends Error {}

export async function namedDatasetFetch(fetchResponse: () => Promise<Response>): Promise<Response> {
  try { return await fetchResponse(); }
  catch (error) {
    if (error instanceof TypeError) throw new NamedDatasetOfflineError("The sharing server is offline. Showing saved pages.", { cause: error });
    throw error;
  }
}
