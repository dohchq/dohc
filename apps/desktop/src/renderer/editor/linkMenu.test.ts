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

  it("allows mailto, prefixing bare email addresses", () => {
    expect(normalizeLinkUrl("mailto:hi@dohc.ai")).toBe("mailto:hi@dohc.ai");
    expect(normalizeLinkUrl("hi@dohc.ai")).toBe("mailto:hi@dohc.ai");
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
