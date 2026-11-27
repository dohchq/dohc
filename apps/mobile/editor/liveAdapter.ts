import { createNamedLiveProvider } from "@dohc/ydoc-projection/named-live-provider";
import {
  fromBase64,
  incoming,
  outgoing,
  readToPage,
  toBase64,
  type Body,
  type FromPage,
  type ToPage,
} from "../src/pages/liveBridge";

export type LiveProvider = ReturnType<typeof createNamedLiveProvider>;

function unsent(made: LiveProvider) {
  const state = made.state();
  const ended = state.status === "quarantined" || state.status === "closed";
  return state.pendingUpdates > 0 || (ended && made.unsentText() !== null);
}

const successorOf = (made: LiveProvider) => (unsent(made) ? null : made.replacement());

export function createLiveAdapter(options: {
  /** Posts a message to the app. */
  readonly post: (message: FromPage) => void;
  /** The provider changed. */
  readonly changed: (provider: LiveProvider) => void;
}) {
  let gen = 0;
  let check = incoming(0);
  let toApp: (body: Body<FromPage>) => void = () => undefined;
  let provider: LiveProvider | undefined;
  let unsubscribe = () => {};
  let route: ReturnType<LiveProvider["connect"]> | undefined;
  // The connection, with the one frame the app hasn't sent yet: the provider waits for each send.
  type Connection = { waiting?: { resolve(): void; reject(error: Error): void } };
  let connection: Connection | undefined;

  function report(made: LiveProvider) {
    const state = made.state();
    toApp({
      type: "state",
      facts: {
        status: state.status,
        reason: state.reason,
        pendingUpdates: state.pendingUpdates,
        unsent: unsent(made),
      },
    });
  }

  /** Ends the connection. Its waiting send fails, so the provider keeps the update to send again. */
  function drop() {
    const ended = connection;
    connection = undefined;
    ended?.waiting?.reject(new Error("Connection ended."));
    route?.disconnect();
    route = undefined;
  }

  function connect(message: Extract<ToPage, { type: "connect" }>) {
    drop();
    const reply = toApp;
    try {
      const successor = provider && successorOf(provider);
      if (!provider || successor) {
        unsubscribe();
        provider?.close();
        const made = createNamedLiveProvider(
          message.limits.provider,
          { workspaceId: message.workspaceId, objectId: message.objectId },
          undefined,
          successor ?? undefined,
        );
        unsubscribe = made.subscribe(() => {
          options.changed(made);
          report(made);
        });
        provider = made;
      }
      const held: Connection = {};
      connection = held;
      route = provider.connect({
        send: (bytes) =>
          new Promise<void>((resolve, reject) => {
            if (connection !== held || held.waiting) {
              reject(new Error("Connection full."));
              return;
            }
            held.waiting = { resolve, reject };
            reply({ type: "frame", data: toBase64(bytes) });
          }),
        close() {
          if (connection !== held) return;
          connection = undefined;
          held.waiting?.reject(new Error("Connection ended."));
          route = undefined;
          reply({ type: "close" });
        },
      });
    } catch {
      // A quarantined provider never reconnects.
      if (provider) report(provider);
      reply({ type: "close" });
    }
  }

  function receive(raw: unknown) {
    const message = readToPage(raw);
    if (!message || message.gen < gen) return;
    if (message.gen > gen) {
      // Only a new open's first message starts its stream.
      if (message.type !== "connect" || message.seq !== 1) return;
      gen = message.gen;
      check = incoming(gen);
      toApp = outgoing<FromPage>(gen, options.post);
    }
    const reply = toApp;
    if (check(message) !== "next") {
      drop();
      reply({ type: "close" });
      return;
    }
    switch (message.type) {
      case "connect":
        connect(message);
        return;
      case "frame":
        void (route?.receive(fromBase64(message.data)) ?? Promise.resolve()).finally(() =>
          reply({ type: "took" }),
        );
        return;
      case "sent": {
        const waiting = connection?.waiting;
        if (!waiting) {
          drop();
          reply({ type: "close" });
          return;
        }
        connection!.waiting = undefined;
        waiting.resolve();
        return;
      }
      case "lost":
        drop();
    }
  }

  return { receive, provider: () => provider };
}
