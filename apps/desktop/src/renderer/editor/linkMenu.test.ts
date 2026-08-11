// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { bridge } from "../bridge";
import {
  applyLinkMenu,
  CLOSED_LINK_MENU_STATE,
  computeLinkMenuState,
  makeLinkMenuPlugin,
  normalizeLinkUrl,
  openLinkExternally,
  removeLinkMenu,
  type LinkMenuState,
} from "./linkMenu";

vi.mock("../bridge", () => ({ bridge: vi.fn() }));

function makeEditor(content: string): Editor {
  return new Editor({
    extensions: [StarterKit.configure({ link: { openOnClick: false, linkOnPaste: false } })],
    content,
  });
}

// Plugin props are typed with `this: Plugin` — call through `.call` so a
// bare `plugin.props.handleX?.(...)` doesn't trip the `this` type check.
type LinkPlugin = ReturnType<typeof makeLinkMenuPlugin>;

function callHandlePaste(
  plugin: LinkPlugin,
  view: Parameters<NonNullable<LinkPlugin["props"]["handlePaste"]>>[0],
  event: ClipboardEvent,
): boolean | void | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return plugin.props.handlePaste?.call(plugin, view, event, undefined as any);
}

function callHandleClick(
  plugin: LinkPlugin,
  view: Parameters<NonNullable<LinkPlugin["props"]["handleClick"]>>[0],
  pos: number,
  event: MouseEvent,
): boolean | void | undefined {
  return plugin.props.handleClick?.call(plugin, view, pos, event);
}

function callHandleKeyDown(
  plugin: LinkPlugin,
  view: Parameters<NonNullable<LinkPlugin["props"]["handleClick"]>>[0],
  event: KeyboardEvent,
): boolean | void | undefined {
  return plugin.props.handleDOMEvents?.keydown?.call(plugin, view, event);
}

function callHandleDomClick(
  plugin: LinkPlugin,
  view: Parameters<NonNullable<LinkPlugin["props"]["handleClick"]>>[0],
  event: MouseEvent,
): boolean | void | undefined {
  return plugin.props.handleDOMEvents?.click?.call(
    plugin,
    view,
    event as PointerEvent,
  );
}

function callHandleAuxClick(
  plugin: LinkPlugin,
  view: Parameters<NonNullable<LinkPlugin["props"]["handleClick"]>>[0],
  event: MouseEvent,
): boolean | void | undefined {
  return plugin.props.handleDOMEvents?.auxclick?.call(
    plugin,
    view,
    event as PointerEvent,
  );
}

describe("normalizeLinkUrl", () => {
  it("prefixes a bare host with https://", () => {
    expect(normalizeLinkUrl("example.com")).toBe("https://example.com/");
    expect(normalizeLinkUrl("example.com/path?a=1")).toBe(
      "https://example.com/path?a=1",
    );
  });

  it("keeps explicit http(s) URLs, case/host-normalized", () => {
    expect(normalizeLinkUrl("http://example.com")).toBe("http://example.com/");
    expect(normalizeLinkUrl("HTTPS://Example.com/Path")).toBe(
      "https://example.com/Path",
    );
  });

  it("normalizes network-path URLs to HTTPS", () => {
    expect(normalizeLinkUrl("//example.com/path")).toBe(
      "https://example.com/path",
    );
  });

  it("allows mailto, prefixing bare email addresses", () => {
    expect(normalizeLinkUrl("mailto:hi@dohc.ai")).toBe("mailto:hi@dohc.ai");
    expect(normalizeLinkUrl("hi@dohc.ai")).toBe("mailto:hi@dohc.ai");
  });

  it("prefixes host:port dev links with https:// instead of rejecting them", () => {
    expect(normalizeLinkUrl("localhost:3000")).toBe("https://localhost:3000/");
    expect(normalizeLinkUrl("example.com:8080/path")).toBe(
      "https://example.com:8080/path",
    );
    expect(normalizeLinkUrl("127.0.0.1:5173")).toBe("https://127.0.0.1:5173/");
    // A declared scheme with a numeric tail must not be misread as host:port.
    expect(normalizeLinkUrl("tel:1234")).toBeNull();
  });

  it("refuses dangerous or unrecognized declared schemes", () => {
    expect(normalizeLinkUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeLinkUrl("data:text/html,evil")).toBeNull();
    expect(normalizeLinkUrl("ftp://example.com")).toBeNull();
    expect(normalizeLinkUrl("tel:+15555555555")).toBeNull();
  });

  it("refuses blank input and text containing whitespace", () => {
    expect(normalizeLinkUrl("")).toBeNull();
    expect(normalizeLinkUrl("   ")).toBeNull();
    expect(normalizeLinkUrl("not a url at all")).toBeNull();
  });
});

describe("openLinkExternally", () => {
  it("logs and contains an OS open failure", async () => {
    const error = new Error("No handler");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const openExternalUrl = vi.fn().mockRejectedValue(error);
    vi.mocked(bridge).mockReturnValue({
      openExternalUrl,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    try {
      await expect(openLinkExternally("https://example.com")).resolves.toBeUndefined();
      expect(openExternalUrl).toHaveBeenCalledWith({ url: "https://example.com/" });
      expect(warn).toHaveBeenCalledWith(
        "[dohc] could not open external link:",
        error,
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("applyLinkMenu / removeLinkMenu (real Editor instance)", () => {
  it("wraps a plain text selection in a new link", () => {
    const editor = makeEditor("<p>hello world</p>");
    const state: LinkMenuState = {
      open: true,
      from: 1,
      to: 6, // "hello"
      url: "",
      hasLink: false,
      x: 0,
      y: 0,
      maxHeight: 0,
      placement: "below",
    };

    expect(applyLinkMenu(editor, state, "example.com")).toBe(true);
    expect(editor.isActive("link")).toBe(true);
    expect(editor.getHTML()).toContain('href="https://example.com/"');
    editor.destroy();
  });

  it("inserts the URL as new linked text at a collapsed cursor", () => {
    const editor = makeEditor("<p>hello world</p>");
    const state: LinkMenuState = {
      open: true,
      from: 1,
      to: 1, // collapsed — not inside any existing link
      url: "",
      hasLink: false,
      x: 0,
      y: 0,
      maxHeight: 0,
      placement: "below",
    };

    expect(applyLinkMenu(editor, state, "example.com")).toBe(true);
    expect(editor.getHTML()).toContain('href="https://example.com/"');
    expect(editor.getText()).toContain("https://example.com/hello world");
    editor.destroy();
  });

  it("rejects invalid input without mutating the document", () => {
    const editor = makeEditor("<p>hello world</p>");
    const before = editor.getHTML();
    const state: LinkMenuState = {
      open: true,
      from: 1,
      to: 6,
      url: "",
      hasLink: false,
      x: 0,
      y: 0,
      maxHeight: 0,
      placement: "below",
    };

    expect(applyLinkMenu(editor, state, "javascript:alert(1)")).toBe(false);
    expect(editor.getHTML()).toBe(before);
    editor.destroy();
  });

  it("edits an existing link's href via a collapsed cursor inside it", () => {
    const editor = makeEditor(
      '<p><a href="https://old.example.com/">hello</a> world</p>',
    );
    editor.commands.setTextSelection(3); // inside "hello"
    const state = computeLinkMenuState(editor.view);
    expect(state.open).toBe(true);
    if (!state.open) throw new Error("expected open state");
    expect(state.url).toBe("https://old.example.com/");
    expect(state.hasLink).toBe(true);

    expect(applyLinkMenu(editor, state, "new.example.com")).toBe(true);
    expect(editor.getHTML()).toContain('href="https://new.example.com/"');
    expect(editor.getHTML()).not.toContain("old.example.com");
    editor.destroy();
  });

  it("removes a link, leaving the plain text behind", () => {
    const editor = makeEditor(
      '<p><a href="https://example.com/">hello</a> world</p>',
    );
    editor.commands.setTextSelection(3);
    const state = computeLinkMenuState(editor.view);
    expect(state.open).toBe(true);
    if (!state.open) throw new Error("expected open state");

    removeLinkMenu(editor, state);
    expect(editor.isActive("link")).toBe(false);
    expect(editor.getHTML()).not.toContain("<a");
    expect(editor.getText()).toContain("hello world");
    editor.destroy();
  });
});

describe("makeLinkMenuPlugin: paste-URL-over-selection", () => {
  function fakePasteEvent(text: string) {
    return {
      clipboardData: { getData: () => text },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent;
  }

  it("links a non-empty selection when the clipboard is a single valid URL", () => {
    const editor = makeEditor("<p>hello world</p>");
    const stateRef = { current: CLOSED_LINK_MENU_STATE };
    const setState = vi.fn();
    const plugin = makeLinkMenuPlugin({ stateRef, setState });
    editor.commands.setTextSelection({ from: 1, to: 6 }); // "hello"

    const event = fakePasteEvent("example.com");
    const handled = callHandlePaste(plugin, editor.view, event);

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(editor.isActive("link")).toBe(true);
    expect(editor.getHTML()).toContain('href="https://example.com/"');
    editor.destroy();
  });

  it("ignores paste when the selection is empty", () => {
    const editor = makeEditor("<p>hello world</p>");
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState: vi.fn(),
    });
    editor.commands.setTextSelection(1);

    const event = fakePasteEvent("example.com");
    const handled = callHandlePaste(plugin, editor.view, event);

    expect(handled).toBeFalsy();
    expect(editor.isActive("link")).toBe(false);
    editor.destroy();
  });

  it("ignores paste when the clipboard isn't a single URL", () => {
    const editor = makeEditor("<p>hello world</p>");
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState: vi.fn(),
    });
    editor.commands.setTextSelection({ from: 1, to: 6 });

    const event = fakePasteEvent("just some plain text");
    const handled = callHandlePaste(plugin, editor.view, event);

    expect(handled).toBeFalsy();
    expect(editor.isActive("link")).toBe(false);
    editor.destroy();
  });
});

describe("makeLinkMenuPlugin: click", () => {
  it("opens the popover in edit mode when clicking a link", () => {
    const editor = makeEditor(
      '<p><a href="https://example.com/">hello</a> world</p>',
    );
    const setState = vi.fn();
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState,
    });
    const anchor = editor.view.dom.querySelector("a")!;
    const pos = editor.view.posAtDOM(anchor, 0);
    const event = {
      target: anchor,
      metaKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    const handled = callHandleClick(plugin, editor.view, pos, event);

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(setState).toHaveBeenCalledTimes(1);
    const next = setState.mock.calls[0]![0] as LinkMenuState;
    expect(next.open).toBe(true);
    if (next.open) {
      expect(next.url).toBe("https://example.com/");
      expect(next.hasLink).toBe(true);
    }
    editor.destroy();
  });

  it("opens externally via the safe bridge on Cmd/Ctrl+click, without opening the popover", () => {
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    vi.mocked(bridge).mockReturnValue({
      openExternalUrl,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const editor = makeEditor(
      '<p><a href="https://example.com/">hello</a> world</p>',
    );
    const setState = vi.fn();
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState,
    });
    const anchor = editor.view.dom.querySelector("a")!;
    const pos = editor.view.posAtDOM(anchor, 0);
    const event = {
      target: anchor,
      metaKey: true,
      ctrlKey: false,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    const handled = callHandleClick(plugin, editor.view, pos, event);

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternalUrl).toHaveBeenCalledWith({ url: "https://example.com/" });
    expect(setState).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("keeps percent encoding when opening an external read-only link", () => {
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    vi.mocked(bridge).mockReturnValue({
      openExternalUrl,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const editor = makeEditor(
      '<p><a href="https://example.com/a%20path">hello</a> world</p>',
    );
    editor.setEditable(false);
    const setState = vi.fn();
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState,
    });
    const anchor = editor.view.dom.querySelector("a")!;
    const event = {
      target: anchor,
      metaKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    expect(callHandleDomClick(plugin, editor.view, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternalUrl).toHaveBeenCalledWith({
      url: "https://example.com/a%20path",
    });
    expect(setState).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("opens a read-only mail link through the safe bridge", () => {
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    vi.mocked(bridge).mockReturnValue({
      openExternalUrl,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const editor = makeEditor('<p><a href="mailto:hi@dohc.ai">email</a></p>');
    editor.setEditable(false);
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState: vi.fn(),
    });
    const anchor = editor.view.dom.querySelector("a")!;
    const event = {
      target: anchor,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    expect(callHandleDomClick(plugin, editor.view, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternalUrl).toHaveBeenCalledWith({ url: "mailto:hi@dohc.ai" });
    editor.destroy();
  });

  it("routes a read-only workspace-relative link through workspace navigation", () => {
    const openWorkspaceLink = vi.fn();
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    vi.mocked(bridge).mockReturnValue({
      openExternalUrl,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const editor = makeEditor(
      '<p><a href="../plans/launch.md#risks">launch plan</a></p>',
    );
    editor.setEditable(false);
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState: vi.fn(),
      openWorkspaceLink,
    });
    const anchor = editor.view.dom.querySelector("a")!;
    const event = {
      target: anchor,
      metaKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    expect(callHandleDomClick(plugin, editor.view, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openWorkspaceLink).toHaveBeenCalledWith({
      path: "../plans/launch.md",
      rawFragment: "risks",
    });
    expect(openExternalUrl).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("marks a bare read-only Markdown path as document-relative", () => {
    const openWorkspaceLink = vi.fn();
    const editor = makeEditor('<p><a href="plan.md">plan</a></p>');
    editor.setEditable(false);
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState: vi.fn(),
      openWorkspaceLink,
    });
    const anchor = editor.view.dom.querySelector("a")!;
    const event = {
      target: anchor,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    expect(callHandleDomClick(plugin, editor.view, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openWorkspaceLink).toHaveBeenCalledWith({ path: "./plan.md" });
    editor.destroy();
  });

  it.each([
    [
      "relative query",
      "plan.md?mode=preview#risks",
      { path: "./plan.md", rawFragment: "risks" },
    ],
    [
      "root-relative query",
      "/plan.md?mode=preview#risks",
      { path: "/plan.md", rawFragment: "risks" },
    ],
    [
      "question mark in a filename",
      "faq%3F.md?mode=preview#answers",
      { path: "./faq?.md", rawFragment: "answers" },
    ],
    [
      "hash in a filename",
      "%23notes.md?mode=preview#risks",
      { path: "./#notes.md", rawFragment: "risks" },
    ],
    [
      "multiple hashes in a filename",
      "new%23release%231.md",
      { path: "./new#release#1.md" },
    ],
    [
      "root-relative encoded delimiter",
      "/%23notes.md?mode=preview#risks",
      { path: "/#notes.md", rawFragment: "risks" },
    ],
    [
      "encoded root slash",
      "%2Fplan.md?mode=preview#risks",
      { path: "/plan.md", rawFragment: "risks" },
    ],
    [
      "document-relative encoded delimiter",
      "../faq%3F.md?mode=preview#answers",
      { path: "../faq?.md", rawFragment: "answers" },
    ],
    [
      "same-document encoded fragment",
      "#next%20steps",
      { path: "", rawFragment: "next%20steps" },
    ],
    [
      "same-document double-encoded fragment",
      "#a%2520b",
      { path: "", rawFragment: "a%2520b" },
    ],
    [
      "empty same-document fragment",
      "#",
      { path: "", rawFragment: "" },
    ],
    [
      "malformed path and fragment escapes",
      "%E0%A4%A.md?mode=preview#bad%E0%A4%A",
      { path: "./%E0%A4%A.md", rawFragment: "bad%E0%A4%A" },
    ],
  ])("parses a %s workspace link", (_label, href, expected) => {
    const openWorkspaceLink = vi.fn();
    const editor = makeEditor(`<p><a href="${href}">plan</a></p>`);
    editor.setEditable(false);
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState: vi.fn(),
      openWorkspaceLink,
    });
    const anchor = editor.view.dom.querySelector("a")!;
    const event = {
      target: anchor,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    expect(callHandleDomClick(plugin, editor.view, event)).toBe(true);
    expect(openWorkspaceLink).toHaveBeenCalledWith(expected);
    editor.destroy();
  });

  it("keeps an external link query outside workspace navigation", () => {
    const openWorkspaceLink = vi.fn();
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    vi.mocked(bridge).mockReturnValue({
      openExternalUrl,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const editor = makeEditor(
      '<p><a href="https://example.com/plan?mode=preview#risks">plan</a></p>',
    );
    editor.setEditable(false);
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState: vi.fn(),
      openWorkspaceLink,
    });
    const anchor = editor.view.dom.querySelector("a")!;
    const event = {
      target: anchor,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    expect(callHandleDomClick(plugin, editor.view, event)).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledWith({
      url: "https://example.com/plan?mode=preview#risks",
    });
    expect(openWorkspaceLink).not.toHaveBeenCalled();
    editor.destroy();
  });

  it.each([
    [
      "spaces",
      "../plans/launch%20plan.md#next%20steps",
      { path: "../plans/launch plan.md", rawFragment: "next%20steps" },
    ],
    ["non-ASCII text", "../notes/caf%C3%A9.md", { path: "../notes/café.md" }],
    [
      "mixed valid escapes and a literal percent",
      "Q2%20at%20100%.md",
      { path: "./Q2 at 100%.md" },
    ],
    [
      "valid escapes before malformed UTF-8",
      "Q2%20bad%E0%A4%A.md",
      { path: "./Q2 bad%E0%A4%A.md" },
    ],
    [
      "an incomplete multibyte escape",
      "../notes/%E0%A4.md",
      { path: "../notes/%E0%A4.md" },
    ],
    ["an encoded percent", "../notes/100%25.md", { path: "../notes/100%.md" }],
    ["a literal percent", "../notes/100%.md", { path: "../notes/100%.md" }],
    [
      "malformed percent input",
      "../plans/%E0%A4%A.md",
      { path: "../plans/%E0%A4%A.md" },
    ],
  ])("decodes %s in a read-only workspace link", (_label, href, expected) => {
    const openWorkspaceLink = vi.fn();
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    vi.mocked(bridge).mockReturnValue({
      openExternalUrl,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const editor = makeEditor(`<p><a href="${href}">target</a></p>`);
    editor.setEditable(false);
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState: vi.fn(),
      openWorkspaceLink,
    });
    const anchor = editor.view.dom.querySelector("a")!;
    const event = {
      target: anchor,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    expect(callHandleDomClick(plugin, editor.view, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openWorkspaceLink).toHaveBeenCalledWith(expected);
    expect(openExternalUrl).not.toHaveBeenCalled();
    editor.destroy();
  });

  it.each([
    ["raw", "//example.com/path", "https://example.com/path"],
    ["encoded prefix", "%2F%2Fexample.com/path", "https://example.com/path"],
    [
      "encoded path with raw query and fragment",
      "%2F%2Fexample.com%2Fpath?mode=preview#risks",
      "https://example.com/path?mode=preview#risks",
    ],
    [
      "encoded path with an encoded raw query value",
      "%2F%2Fexample.com%2Fpath?next=a%26admin%3Dtrue#risks",
      "https://example.com/path?next=a%26admin%3Dtrue#risks",
    ],
    [
      "encoded path, query, and fragment",
      "%2F%2Fexample.com%2Fpath%3Fmode%3Dpreview%23risks",
      "https://example.com/path?mode=preview#risks",
    ],
    [
      "encoded path, query, fragment, and escaped query value",
      "%2F%2Fexample.com%2Fpath%3Fnext%3Da%2526admin%253Dtrue%23risks",
      "https://example.com/path?next=a%26admin%3Dtrue#risks",
    ],
  ])("opens a %s network-path read-only URL externally", (_label, href, expected) => {
    const openWorkspaceLink = vi.fn();
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    vi.mocked(bridge).mockReturnValue({
      openExternalUrl,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const editor = makeEditor("<p>network path</p>");
    editor.setEditable(false);
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState: vi.fn(),
      openWorkspaceLink,
    });
    const anchor = document.createElement("a");
    anchor.setAttribute("href", href);
    editor.view.dom.append(anchor);
    const event = {
      target: anchor,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    expect(callHandleDomClick(plugin, editor.view, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternalUrl).toHaveBeenCalledWith({
      url: expected,
    });
    expect(openWorkspaceLink).not.toHaveBeenCalled();
    editor.destroy();
  });

  it.each([
    ["an encoded unsafe scheme", "javascript%3Aalert(1)"],
    ["an encoded external scheme", "https%3A%2F%2Fexample.com"],
    ["a control-mangled encoded scheme", "java%0Ascript%3Aalert(1)"],
  ])("consumes %s without routing it", (_label, href) => {
    const openWorkspaceLink = vi.fn();
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    vi.mocked(bridge).mockReturnValue({
      openExternalUrl,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const editor = makeEditor("<p>bad</p>");
    editor.setEditable(false);
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState: vi.fn(),
      openWorkspaceLink,
    });
    const anchor = document.createElement("a");
    anchor.setAttribute("href", href);
    editor.view.dom.append(anchor);
    const event = {
      target: anchor,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    expect(callHandleDomClick(plugin, editor.view, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openWorkspaceLink).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("consumes repeat read-only clicks without activating the link again", () => {
    const openWorkspaceLink = vi.fn();
    const editor = makeEditor('<p><a href="../plans/launch.md">launch</a></p>');
    editor.setEditable(false);
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState: vi.fn(),
      openWorkspaceLink,
    });
    const anchor = editor.view.dom.querySelector("a")!;
    const events = [1, 2, 3].map(
      (detail) =>
        ({
          detail,
          target: anchor,
          preventDefault: vi.fn(),
        }) as unknown as MouseEvent,
    );

    for (const event of events) {
      expect(callHandleDomClick(plugin, editor.view, event)).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();
    }
    expect(openWorkspaceLink).toHaveBeenCalledOnce();
    editor.destroy();
  });

  it("leaves editable-link DOM clicks for the editable click handler", () => {
    const openWorkspaceLink = vi.fn();
    const editor = makeEditor('<p><a href="../plans/launch.md">launch</a></p>');
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState: vi.fn(),
      openWorkspaceLink,
    });
    const anchor = editor.view.dom.querySelector("a")!;
    const event = {
      target: anchor,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    expect(callHandleDomClick(plugin, editor.view, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(openWorkspaceLink).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("routes a read-only heading fragment through workspace navigation", () => {
    const openWorkspaceLink = vi.fn();
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    vi.mocked(bridge).mockReturnValue({
      openExternalUrl,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const editor = makeEditor('<p><a href="#risks">risks</a></p>');
    editor.setEditable(false);
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState: vi.fn(),
      openWorkspaceLink,
    });
    const anchor = editor.view.dom.querySelector("a")!;
    const event = {
      target: anchor,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    expect(callHandleDomClick(plugin, editor.view, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openWorkspaceLink).toHaveBeenCalledWith({
      path: "",
      rawFragment: "risks",
    });
    expect(openExternalUrl).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("routes a middle-button read-only link through auxclick", () => {
    const openWorkspaceLink = vi.fn();
    const editor = makeEditor('<p><a href="../plans/launch.md">launch</a></p>');
    editor.setEditable(false);
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState: vi.fn(),
      openWorkspaceLink,
    });
    const anchor = editor.view.dom.querySelector("a")!;
    const event = {
      button: 1,
      detail: 1,
      target: anchor,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    expect(callHandleAuxClick(plugin, editor.view, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openWorkspaceLink).toHaveBeenCalledWith({
      path: "../plans/launch.md",
    });
    editor.destroy();
  });

  it("opens a focused read-only link once and consumes repeated Enter events", () => {
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    vi.mocked(bridge).mockReturnValue({
      openExternalUrl,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const editor = makeEditor(
      '<p><a href="https://example.com/keyboard">keyboard link</a></p>',
    );
    editor.setEditable(false);
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState: vi.fn(),
    });
    const anchor = editor.view.dom.querySelector("a")!;
    const events = [false, true].map(
      (repeat) =>
        ({
          key: "Enter",
          repeat,
          target: anchor,
          preventDefault: vi.fn(),
        }) as unknown as KeyboardEvent,
    );

    for (const event of events) {
      expect(callHandleKeyDown(plugin, editor.view, event)).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();
    }
    expect(openExternalUrl).toHaveBeenCalledWith({
      url: "https://example.com/keyboard",
    });
    expect(openExternalUrl).toHaveBeenCalledOnce();
    editor.destroy();
  });

  it("blocks unsafe read-only link schemes without calling either navigation path", () => {
    const openWorkspaceLink = vi.fn();
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    vi.mocked(bridge).mockReturnValue({
      openExternalUrl,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // Tiptap strips this scheme while parsing normal document input. Use a
    // crafted DOM target to pin the event-boundary defense too: no malformed
    // or injected anchor may fall through to Electron's default navigation.
    const editor = makeEditor("<p>bad</p>");
    editor.setEditable(false);
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: CLOSED_LINK_MENU_STATE },
      setState: vi.fn(),
      openWorkspaceLink,
    });
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "javascript:alert(1)?mode=preview#risks");
    anchor.textContent = "bad";
    editor.view.dom.append(anchor);
    const event = {
      target: anchor,
      metaKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    expect(callHandleDomClick(plugin, editor.view, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openWorkspaceLink).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("closes an open popover when clicking elsewhere in the editor", () => {
    const editor = makeEditor("<p>hello world</p>");
    const setState = vi.fn();
    const openState: LinkMenuState = {
      open: true,
      from: 1,
      to: 6,
      url: "https://example.com/",
      hasLink: true,
      x: 0,
      y: 0,
      maxHeight: 0,
      placement: "below",
    };
    const plugin = makeLinkMenuPlugin({
      stateRef: { current: openState },
      setState,
    });
    const paragraph = editor.view.dom.querySelector("p")!;
    const event = {
      target: paragraph,
      metaKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    const handled = callHandleClick(plugin, editor.view, 8, event);

    expect(handled).toBe(false);
    expect(setState).toHaveBeenCalledWith(CLOSED_LINK_MENU_STATE);
    editor.destroy();
  });
});
