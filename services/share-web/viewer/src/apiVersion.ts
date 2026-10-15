import {SHARE_WEB_API_VERSION, SHARE_WEB_API_VERSION_HEADER} from "@dohc/workspace-contracts/relay-values";

// The viewer names the contract it was compiled against, never the server's
// advertised maximum. Only share-web requests use this wrapper.
export function fetchShareWeb(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set(SHARE_WEB_API_VERSION_HEADER, String(SHARE_WEB_API_VERSION));
  return fetch(input, {...init, headers: Object.fromEntries(headers)});
}
