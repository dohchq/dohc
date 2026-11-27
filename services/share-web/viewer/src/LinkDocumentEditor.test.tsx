// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import {
  namedLiveEditable,
  type NamedLiveBrowserState,
} from "@dohc/ydoc-projection/named-live-browser-transport";
import type { UnsentText } from "@dohc/ydoc-projection/removed-text";
import { LinkDocumentEditor } from "./LinkDocumentEditor";
import { openLinkDocument } from "./linkLive";
import { settle } from "./testing";
import { LINK_REFUSALS } from "@dohc/security-contract/link-refusal";

vi.mock("./linkLive", () => ({ openLinkDocument: vi.fn() }));
let container: HTMLDivElement, root: Root;
function fixture() {
  const doc = markdownToYDoc("Draft to keep"),
    listeners = new Set<(value: NamedLiveBrowserState) => void>();
  let state: NamedLiveBrowserState = {
    status: "live",
    holds: true,
    reason: null,
    binding: null,
    hostEpoch: null,
    pendingUpdates: 0,
    pendingBytes: 0,
    lastApplied: null,
    membership: null,
    typingAhead: false,
    typingStopped: false,
  };
  let unsent: UnsentText | null = { text: " typed here", deletes: false };
  const notify = () => {
    for (const listener of listeners) listener(state);
  };
  const session = {
    id: "link-session",
    doc,
    state: () => state,
    subscribe(listener: (value: NamedLiveBrowserState) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onRemovedText: () => () => {},
    unsentText: () => unsent,
    close: vi.fn(() => {
      state = { ...state, status: "closed" };
      notify();
    }),
    reconnect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    seed: vi.fn(() => false),
    edit(change: () => void) {
      if (!namedLiveEditable(state)) return false;
      change();
      return true;
    },
  };
  return {
    session,
    unsent(value: UnsentText | null) {
      unsent = value;
      notify();
    },
    update(value: Partial<NamedLiveBrowserState>) {
      state = { ...state, ...value };
      notify();
    },
  };
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true;
      },
    },
    close: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = false;
      },
    },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});
async function render(available: boolean, onClose = vi.fn()) {
  await act(async () =>
    root.render(
      <LinkDocumentEditor
        discriminator="abcdefghijkl"
        path="docs/a.md"
        available={available}
        onClose={onClose}
      />,
    ),
  );
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (value) => value.textContent === text,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
const panel = () => container.querySelector('aside[aria-label="Draft recovery"]');
const status = () =>
  container.querySelector('section[aria-label="Shared file"] [role="status"]')?.textContent;
function unloadWarns() {
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  return unload.defaultPrevented;
}
async function opened() {
  const f = fixture(),
    onClose = vi.fn();
  vi.mocked(openLinkDocument).mockResolvedValue(f.session);
  await render(true, onClose);
  await settle(() => container.querySelector('[role="textbox"]') !== null);
  return { ...f, onClose };
}
it("keeps the same editor when the page renders again after the session reopens on a new document", async () => {
  const f = await opened();
  const shell = container.querySelector('section[aria-label="Shared file"]');
  expect(shell).not.toBeNull();
  f.session.doc = markdownToYDoc("Reopened text");
  await render(true);
  expect(container.querySelector('section[aria-label="Shared file"]')).toBe(shell);
});
it("shows no draft panel while an ordinary change saves", async () => {
  const f = await opened();
  await act(async () => f.update({ pendingUpdates: 1 }));
  expect(status()).toBe("Saving changes…");
  expect(panel()).toBeNull();
});
it("still warns before leaving while an ordinary change saves", async () => {
  const f = await opened();
  await act(async () => f.update({ pendingUpdates: 1 }));
  expect(unloadWarns()).toBe(true);
  await click("Done");
  expect(f.onClose).not.toHaveBeenCalled();
  expect(container.querySelector("dialog")?.open).toBe(true);
  await click("Keep reviewing");
  await act(async () => f.update({ pendingUpdates: 0 }));
  expect(unloadWarns()).toBe(false);
  await click("Done");
  expect(f.onClose).toHaveBeenCalledOnce();
});
const resending: Pick<NamedLiveBrowserState, "status" | "reason">[] = [
  { status: "disconnected", reason: "transport-closed" },
  { status: "authorizing", reason: null },
  { status: "connecting", reason: null },
  { status: "syncing", reason: null },
];
it.each(resending)(
  "shows no draft panel while the page reconnects ($status) to send an unsent change again",
  async (state) => {
    const f = await opened();
    await act(async () => f.update({ ...state, pendingUpdates: 1 }));
    expect(panel()).toBeNull();
    expect(unloadWarns()).toBe(true);
  },
);
const stopped: Pick<NamedLiveBrowserState, "status" | "reason" | "pendingUpdates">[] = [
  { status: "quarantined", reason: "pending-update-limit", pendingUpdates: 0 },
  { status: "quarantined", reason: "provenance-refused", pendingUpdates: 1 },
  { status: "disconnected", reason: "authority-unavailable", pendingUpdates: 1 },
  { status: "disconnected", reason: "paused", pendingUpdates: 1 },
  { status: "disconnected", reason: "live-stopped", pendingUpdates: 1 },
  { status: "closed", reason: null, pendingUpdates: 1 },
];
it.each(stopped)(
  "shows the draft panel when editing stopped ($status, $reason) with a change the page will not send",
  async (state) => {
    const f = await opened();
    await act(async () => f.update(state));
    expect(panel()?.textContent).toContain("Review your draft");
    expect(panel()?.textContent).toContain("Open current file");
  },
);
it("quotes the words a stopped draft typed and copies them (#3982)", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const f = await opened();
  await act(async () => f.update({ status: "quarantined", reason: "provenance-refused" }));
  expect(panel()?.querySelector("blockquote")?.textContent).toBe(" typed here");
  await click("Copy text");
  expect(writeText).toHaveBeenCalledWith(" typed here");
  expect(panel()?.textContent).toContain("Copied");
  // A later read shows the newer words and lets them be copied again.
  await act(async () => f.unsent({ text: " typed here and more", deletes: false }));
  expect(panel()?.querySelector("blockquote")?.textContent).toBe(" typed here and more");
  expect(panel()?.textContent).toContain("Copy text");
});
it("says when a stopped draft deletes text, and when it has no words to copy", async () => {
  const f = await opened();
  await act(async () => f.update({ status: "quarantined", reason: "provenance-refused" }));
  await act(async () => f.unsent({ text: "", deletes: true }));
  expect(panel()?.textContent).toContain("They also delete text.");
  expect(panel()?.querySelector("blockquote")).toBeNull();
  expect(panel()?.textContent).not.toContain("Copy text");
  await act(async () => f.unsent({ text: "", deletes: false }));
  expect(panel()?.textContent).toContain("They add no text you can copy.");
  await act(async () => f.unsent(null));
  expect(panel()?.textContent).toContain("Nothing you typed is waiting to be saved.");
  expect(panel()?.textContent).toContain("Open current file");
});
it("shows the draft panel when access ends while a change is still saving", async () => {
  const f = await opened();
  await act(async () => f.update({ pendingUpdates: 1 }));
  await render(false, f.onClose);
  expect(f.session.close).toHaveBeenCalled();
  expect(panel()?.textContent).toContain("exist only in this tab");
  expect(container.textContent).not.toContain("Open current file");
  expect(unloadWarns()).toBe(true);
});
it("shows the grant-scoped refusal with its next step", async () => {
  vi.mocked(openLinkDocument).mockRejectedValue(
    new Error(LINK_REFUSALS.link_comment_access.error, { cause: "link_comment_access" }),
  );
  await render(true);
  await settle(
    () => container.textContent?.includes(LINK_REFUSALS.link_comment_access.error) === true,
  );
  expect(container.textContent).toContain("Try again");
});
it("says live editing is off by the refusal's code, and that the page can still be read", async () => {
  vi.mocked(openLinkDocument).mockRejectedValue(
    new Error(LINK_REFUSALS.link_live_stopped.error, { cause: "link_live_stopped" }),
  );
  await render(true);
  await settle(() => container.querySelector(".edit-notice p") !== null);
  expect(container.querySelector(".edit-notice p")!.textContent).toBe(
    "Live editing of this file is off. Only its owner can start it again.",
  );
  expect(container.textContent).toContain("You can still read and comment here.");
});
it.each([
  ["live-starting", "Live editing is starting."],
  [
    "live-stopped",
    "Live editing of this file is off. Only its owner can start it again. You can still read and comment here.",
  ],
])(
  "tells an open page why editing is not live, with no retry button; %s",
  async (reason, words) => {
    const f = await opened();
    await act(async () => f.update({ status: "disconnected", reason }));
    expect(status()).toBe(words);
    expect(container.textContent).not.toMatch(/Try again|Retry connection/);
  },
);
it("asks a link holder to retry, not to ask for access, when the file could not open for another reason", async () => {
  const onClose = vi.fn();
  vi.mocked(openLinkDocument).mockRejectedValue(new TypeError("Failed to fetch"));
  await render(true, onClose);
  await settle(() => container.querySelector(".edit-notice p") !== null);
  expect(container.querySelector(".edit-notice p")!.textContent).toBe(
    "dohc could not open this file for editing. Retry in a moment. If it keeps happening, ask the owner.",
  );
  expect(container.textContent).toContain("Try again");
  await click("Dismiss");
  expect(onClose).toHaveBeenCalledOnce();
});
it("retains a quarantined draft after access loss, including updates rejected before they entered the queue", async () => {
  const f = fixture(),
    onClose = vi.fn();
  vi.mocked(openLinkDocument).mockResolvedValue(f.session);
  await render(true, onClose);
  await settle(() => container.querySelector('[role="textbox"]') !== null);
  await act(async () =>
    f.update({ status: "quarantined", pendingUpdates: 0, reason: "pending-update-limit" }),
  );
  await render(false, onClose);
  expect(f.session.close).toHaveBeenCalled();
  expect(container.textContent).toContain("Draft to keep");
  expect(container.textContent).toContain("exist only in this tab");
  expect(container.querySelector('[role="textbox"]')?.getAttribute("contenteditable")).toBe(
    "false",
  );
  expect(container.textContent).not.toContain("Open current file");
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  await click("Done");
  expect(onClose).not.toHaveBeenCalled();
  expect(container.querySelector("dialog")?.open).toBe(true);
  await click("Keep reviewing");
  expect(onClose).not.toHaveBeenCalled();
  await click("Done");
  await click("Discard draft and continue");
  expect(onClose).toHaveBeenCalledOnce();
});
it("retires a late open response when access changes during authorization", async () => {
  const f = fixture();
  let release!: (value: typeof f.session) => void;
  vi.mocked(openLinkDocument).mockImplementation(
    () =>
      new Promise((done) => {
        release = done;
      }),
  );
  await render(true);
  await render(false);
  await act(async () => release(f.session));
  expect(f.session.close).toHaveBeenCalledOnce();
  expect(f.session.reconnect).not.toHaveBeenCalled();
  expect(container.querySelector('[role="textbox"]')).toBeNull();
});
it("requires explicit discard before opening a fresh session and never replays the held draft", async () => {
  const first = fixture(),
    next = fixture();
  vi.mocked(openLinkDocument)
    .mockResolvedValueOnce(first.session)
    .mockResolvedValueOnce(next.session);
  await render(true);
  await settle(() => container.querySelector('[role="textbox"]') !== null);
  await act(async () => first.update({ status: "quarantined", pendingUpdates: 1 }));
  await click("Open current file");
  expect(openLinkDocument).toHaveBeenCalledTimes(1);
  await click("Discard draft and continue");
  await settle(() => next.session.reconnect.mock.calls.length === 1);
  expect(first.session.close).toHaveBeenCalled();
  expect(next.session.doc).not.toBe(first.session.doc);
  expect(openLinkDocument).toHaveBeenLastCalledWith(
    "abcdefghijkl",
    "docs/a.md",
    expect.any(AbortSignal),
  );
});
it("reports the file open only once its session is first live, and keeps it open after that", async () => {
  const f = fixture(),
    onOpenChange = vi.fn();
  f.update({ status: "connecting" });
  vi.mocked(openLinkDocument).mockResolvedValue(f.session);
  await act(async () =>
    root.render(
      <LinkDocumentEditor
        discriminator="abcdefghijkl"
        path="docs/a.md"
        available
        onClose={vi.fn()}
        onOpenChange={onOpenChange}
      />,
    ),
  );
  await settle(() => container.querySelector('[role="textbox"]') !== null);
  const body = container.querySelector<HTMLElement>(".named-body-editor")!;
  expect(onOpenChange).not.toHaveBeenCalledWith(true);
  expect(body.hidden).toBe(true);
  await act(async () => f.update({ status: "disconnected", reason: "authority-unavailable" }));
  expect(onOpenChange).not.toHaveBeenCalledWith(true);
  expect(body.hidden).toBe(true);
  expect(container.textContent).toContain("dohc could not open the file for editing.");
  await act(async () => f.update({ status: "live", reason: null }));
  expect(onOpenChange).toHaveBeenLastCalledWith(true);
  expect(body.hidden).toBe(false);
  await act(async () => f.update({ status: "disconnected", reason: null }));
  expect(onOpenChange).toHaveBeenLastCalledWith(true);
  expect(body.hidden).toBe(false);
});
it("shows the text on the host's early state, says typed words are not sent, and offers the draft once opening stops", async () => {
  const f = fixture(),
    onOpenChange = vi.fn();
  f.update({ status: "authorizing" });
  vi.mocked(openLinkDocument).mockResolvedValue(f.session);
  await act(async () =>
    root.render(
      <LinkDocumentEditor
        discriminator="abcdefghijkl"
        path="docs/a.md"
        available
        onClose={vi.fn()}
        onOpenChange={onOpenChange}
      />,
    ),
  );
  await settle(() => container.querySelector('[role="textbox"]') !== null);
  const body = container.querySelector<HTMLElement>(".named-body-editor")!,
    textbox = () => container.querySelector('[role="textbox"]')!.getAttribute("contenteditable");
  expect(body.hidden).toBe(true);
  expect(textbox()).toBe("false");
  await act(async () => f.update({ typingAhead: true }));
  expect(onOpenChange).toHaveBeenLastCalledWith(true);
  expect(body.hidden).toBe(false);
  expect(textbox()).toBe("true");
  await act(async () => f.update({ pendingUpdates: 1 }));
  expect(status()).toBe("Not sent yet. Your changes are only in this tab.");
  expect(panel()).toBeNull();
  expect(unloadWarns()).toBe(true);
  await act(async () =>
    f.update({ status: "disconnected", reason: "host-unavailable", typingStopped: true }),
  );
  expect(textbox()).toBe("false");
  expect(panel()?.textContent).toContain("Review your draft");
  // The page's own retry keeps the editor shut and the draft offered until it is live.
  await act(async () => f.update({ status: "authorizing", reason: null }));
  expect(textbox()).toBe("false");
  expect(panel()?.textContent).toContain("Review your draft");
  expect(container.textContent).not.toContain("Changes saved");
  await act(async () => f.update({ status: "live", reason: null, typingAhead: false }));
  expect(status()).toBe("Saving changes…");
  expect(panel()).toBeNull();
});
it("says the file moved or was removed when the shared files lose it, and keeps the draft for review", async () => {
  const f = await opened();
  await act(async () =>
    f.update({
      status: "disconnected",
      reason: "live-stopped",
      pendingUpdates: 1,
      typingStopped: true,
    }),
  );
  await act(async () =>
    root.render(
      <LinkDocumentEditor
        discriminator="abcdefghijkl"
        path="docs/a.md"
        available={false}
        gone
        onClose={f.onClose}
      />,
    ),
  );
  expect(f.session.close).toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "This file moved or was removed. Ask its owner for a new link.",
  );
  expect(panel()).not.toBeNull();
});
