import {
  RelayUnauthorizedError,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import { relayApiFetch } from "./sharedChannels";

// One authenticated call to the relay, for the surfaces that make them
// directly rather than through the engine.
//
// Three things every caller repeated: joining a path onto a base url whose
// trailing slashes are nobody's business, setting the bearer header, and
// reading 401 as "this session cannot be used". Those are shared here.
//
// What a 404 or a 409 means is deliberately not shared. A share that ended, a
// workspace this account does not own, and a claim that lost a race are
// different sentences on different surfaces, and a helper that picked one for
// everybody would make some caller say the wrong thing.
export async function relayRequest(input: {
  relay: SyncRelayConnection;
  path: string;
  init?: RequestInit;
  // Status to the error it means here. Read after 401, which is answered
  // first and the same way everywhere.
  errors?: Record<number, () => Error>;
  // Names the request in the fallback: `${label} failed (503)`.
  label: string;
}): Promise<Response> {
  const headers = new Headers(input.init?.headers);
  headers.set("authorization", `Bearer ${input.relay.token}`);
  const url = `${input.relay.baseUrl.replace(/\/+$/u, "")}${input.path}`;
  const response = await (input.relay.fetch ?? relayApiFetch())(url, {
    ...input.init,
    headers,
  });
  const mapped = input.errors?.[response.status];
  const error = response.status === 401 ? new RelayUnauthorizedError()
    : mapped ? mapped()
    : response.ok ? undefined
    : new Error(`${input.label} failed (${response.status})`);
  if (!error) return response;
  // Nobody reads a refused response, so its connection is released here. The
  // refusal is still what the caller hears if releasing fails.
  await response.body?.cancel().catch(() => undefined);
  throw error;
}
