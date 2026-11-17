// A page edited live: the provider runs here, and the app owns its socket and passes each frame (src/pages/liveBridge.ts).
// The page shows the text the app read until the provider is live, then the live document replaces it in one paint.
// It takes edits only while live, and takes none ahead: it never seeds the provider with what the app read.
import { yDocToMarkdown } from "@dohc/ydoc-projection";
import { mountLiveBodyEditor } from "@dohc/ydoc-projection/browser-editor";
import { createNamedLiveProvider } from "@dohc/ydoc-projection/named-live-provider";
import type { NamedLiveProviderLimits } from "@dohc/ydoc-projection/named-live-provider";
import {
  frameWindow,
  fromBase64,
  incoming,
  outgoing,
  readToPage,
  toBase64,
  type Body,
  type FromPage,
  type ToPage,
} from "../src/pages/liveBridge";
import { post } from "./bridge";

type Provider = ReturnType<typeof createNamedLiveProvider>;

export function followLive(input: {
  /** The read text's body, which the live one replaces. */
  readonly body: HTMLElement;
  readonly readOnly: { destroy(): void };
  readonly label: string;
  endEditing(): void;
}) {
  let gen = 0;
  let check = incoming(0);
  let toApp: ((body: Body<FromPage>) => void) | undefined;
  let provider: Provider | undefined;
  let route: ReturnType<Provider["connect"]> | undefined;
  // Frames sent to the app that it hasn't sent on, each with its provider's wait.
  type Sends = {
    readonly window: ReturnType<typeof frameWindow>;
    readonly waiting: { resolve(): void; reject(error: Error): void }[];
  };
  let sends: Sends | undefined;
  let shown = false;
  let wasLive = false;

  function endSends() {
    const ended = sends;
    sends = undefined;
    for (const wait of ended?.waiting.splice(0) ?? []) wait.reject(new Error("Connection ended."));
  }

  function report(made: Provider) {
    const state = made.state();
    const ended = state.status === "quarantined" || state.status === "closed";
    toApp?.({
      type: "state",
      facts: {
        status: state.status,
        reason: state.reason,
        pendingUpdates: state.pendingUpdates,
        unsent: state.pendingUpdates > 0 || (ended && made.unsentText() !== null),
      },
    });
  }

  function show(made: Provider) {
    shown = true;
    const next = document.createElement("div");
    next.className = input.body.className;
    next.hidden = true;
    input.body.after(next);
    const editor = mountLiveBodyEditor(next, {
      body: made.body,
      label: input.label,
      canEdit: () => made.state().status === "live",
      edit(change) {
        if (made.state().status !== "live") return false;
        change();
        return true;
      },
    });
    made.subscribe(() => editor.refresh());
    (window as Window & { __dohcCopyMarkdown?: () => void }).__dohcCopyMarkdown = () =>
      post("markdown", { markdown: yDocToMarkdown(made.doc) });
    // Swapped once the live editor has drawn, so the read text never leaves an empty frame.
    requestAnimationFrame(() =>
      setTimeout(() => {
        input.body.remove();
        input.readOnly.destroy();
        next.hidden = false;
      }, 0),
    );
  }

  function make(limits: NamedLiveProviderLimits, workspaceId: string, objectId: string) {
    const made = createNamedLiveProvider(limits, { workspaceId, objectId });
    made.subscribe((state) => {
      const live = state.status === "live";
      if (live && !shown) show(made);
      // Editing stops at once when the page isn't live: the caret goes, and the keyboard with it.
      if (wasLive && !live) input.endEditing();
      wasLive = live;
      report(made);
    });
    return made;
  }

  function connect(message: Extract<ToPage, { type: "connect" }>) {
    endSends();
    try {
      provider ??= make(
        message.limits.provider as unknown as NamedLiveProviderLimits,
        message.workspaceId,
        message.objectId,
      );
      const held: Sends = {
        window: frameWindow(
          message.limits.provider.frames.maxQueuedFrames,
          message.limits.maxSocketBufferedBytes,
        ),
        waiting: [],
      };
      sends = held;
      const reply = toApp;
      route = provider.connect({
        send: (bytes) =>
          new Promise<void>((resolve, reject) => {
            // A frame past the window ends the connection; the provider keeps the update to send again.
            if (sends !== held || !held.window.add(bytes.length)) {
              reject(new Error("Connection full."));
              return;
            }
            held.waiting.push({ resolve, reject });
            reply?.({ type: "frame", data: toBase64(bytes) });
          }),
        close() {
          if (sends !== held) return;
          endSends();
          reply?.({ type: "close" });
        },
      });
    } catch {
      // A quarantined provider never reconnects, and limits it can't use end the open.
      if (provider) report(provider);
      toApp?.({ type: "close" });
    }
  }

  (window as Window & { __dohcLive?: (message: unknown) => void }).__dohcLive = (raw) => {
    const message = readToPage(raw);
    if (!message || message.gen < gen) return;
    if (message.gen > gen) {
      // Only a new open's first message starts its stream.
      if (message.type !== "connect" || message.seq !== 1) return;
      gen = message.gen;
      check = incoming(gen);
      toApp = outgoing<FromPage>(gen, (stamped) => post(stamped.kind, stamped));
    }
    const reply = toApp;
    const order = check(message);
    if (order === "stale") return;
    if (order === "broken") {
      endSends();
      route?.disconnect();
      reply?.({ type: "close" });
      return;
    }
    switch (message.type) {
      case "connect":
        connect(message);
        return;
      case "frame":
        void (route?.receive(fromBase64(message.data)) ?? Promise.resolve()).finally(() =>
          reply?.({ type: "took" }),
        );
        return;
      case "sent": {
        const wait = sends?.waiting.shift();
        if (!wait || !sends?.window.release()) {
          endSends();
          route?.disconnect();
          reply?.({ type: "close" });
          return;
        }
        wait.resolve();
        return;
      }
      case "lost":
        endSends();
        route?.disconnect();
        route = undefined;
    }
  };
}
