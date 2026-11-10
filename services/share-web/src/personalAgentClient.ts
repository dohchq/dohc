// A personal agent's calls to the relay's personal agent routes. The access
// token names the connection and the MCP address must be the one it signed
// in at; the relay derives the account, the agent, its reach and every check
// from them, so nothing here names one. No cookie or link profile goes with
// a call: the relay refuses either.
export type PersonalAgentAction = "workspaces" | "groups" | "files" | "blob" | "chat" | "discussion" | "post" | "wait";

export interface PersonalAgentClient {
  call(action: PersonalAgentAction, body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
}

export function createPersonalAgentClient(options: {
  relayUrl: string;
  exchangeKey: string;
  accessToken: string;
  /** The MCP address the agent called, `<origin>/mcp/agent/w/<workspace>`. */
  resource: string;
  fetchRelay(request: Request): Promise<Response>;
}): PersonalAgentClient {
  return {
    call: (action, body, signal) => options.fetchRelay(new Request(new URL(`/sync/link/personal-agent/${action}`, options.relayUrl), {
      method: "POST", signal, redirect: "error",
      headers: {
        authorization: `DohcAgent ${options.accessToken}`,
        "x-dohc-agent-resource": options.resource,
        "x-dohc-relay-exchange-key": options.exchangeKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })),
  };
}
