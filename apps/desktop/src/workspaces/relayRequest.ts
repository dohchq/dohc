import {
  RelayUnauthorizedError,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";

// ONE authenticated call to the relay, for the surfaces that make them
// directly rather than through the engine.
//
// Three things every caller repeated: joining a path onto a base url whose
// trailing slashes are nobody's business, setting the bearer header, and
// reading 401 as "this session cannot be used". Those are shared here.
//
// What a 404 or a 409 MEANS is deliberately NOT shared. A share that ended, a
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
  const response = await (input.relay.fetch ?? fetch)(url, {
    ...input.init,
    headers,
  });
  if (response.status === 401) throw new RelayUnauthorizedError();
  const mapped = input.errors?.[response.status];
  if (mapped) throw mapped();
  if (!response.ok) throw new Error(`${input.label} failed (${response.status})`);
  return response;
}
