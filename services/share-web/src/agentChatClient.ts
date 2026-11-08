// An agent connection's chat on its Group link, through the relay's internal
// agent chat routes. The access token names the connection, and the relay
// derives the author and every check from it, so nothing here names one.
export interface AgentChatClient {
  post(input: {body: string; idempotencyKey: string; threadId?: string}, signal: AbortSignal): Promise<Response>;
  /** Holds at most `timeoutMs`; the relay never holds longer than its own bound. */
  wait(input: {cursor?: number; threadId?: string; timeoutMs: number}, signal: AbortSignal): Promise<Response>;
}

export function createAgentChatClient(options: {
  relayUrl: string;
  exchangeKey: string;
  accessToken: string;
  fetchRelay(request: Request): Promise<Response>;
}): AgentChatClient {
  const call = (action: "post" | "wait", body: Record<string, unknown>, signal: AbortSignal) =>
    options.fetchRelay(new Request(new URL(`/sync/link/agent-chat/${action}`, options.relayUrl), {
      method: "POST", signal, redirect: "error",
      headers: {"content-type": "application/json", "x-dohc-relay-exchange-key": options.exchangeKey},
      body: JSON.stringify({accessToken: options.accessToken, ...body}),
    }));
  return {
    post: (input, signal) => call("post", input, signal),
    wait: (input, signal) => call("wait", input, signal),
  };
}
