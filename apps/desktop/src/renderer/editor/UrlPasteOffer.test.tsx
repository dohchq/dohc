// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { EditorView } from "@tiptap/pm/view";
import { UrlPasteOffer } from "./UrlPasteOffer";
import type { UrlPasteOfferState } from "./urlPaste";

afterEach(cleanup);

const OFFER: UrlPasteOfferState = {
  from: 1, to: 25, url: "https://example.com/trip", text: "https://example.com/trip",
  form: "link", chosen: false, anchors: null,
};

function renderOffer(offer: UrlPasteOfferState | null = OFFER) {
  const view = { coordsAtPos: () => ({ left: 40, top: 100, bottom: 118 }), focus: vi.fn() } as unknown as EditorView;
  const props = { view, rowRef: createRef<HTMLDivElement>(), onChoose: vi.fn(), onUndo: vi.fn(), onDismiss: vi.fn() };
  const result = render(
    <>
      <button type="button">elsewhere</button>
      <UrlPasteOffer offer={offer} {...props} />
    </>,
  );
  return { ...props, rerender: (next: UrlPasteOfferState | null) => result.rerender(
    <>
      <button type="button">elsewhere</button>
      <UrlPasteOffer offer={next} {...props} />
    </>,
  ) };
}

describe("URL paste offer row", () => {
  it("shows nothing without an offer", () => {
    renderOffer(null);
    expect(screen.queryByTestId("url-paste-offer")).toBeNull();
  });

  it("offers both forms with the current one pressed, and never takes focus", () => {
    renderOffer();
    expect(screen.getByTestId("url-paste-link").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("url-paste-plain").getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(document.body);
  });

  it("is dismissed by a click elsewhere, not by a click on itself", () => {
    const { onDismiss } = renderOffer();
    fireEvent.mouseDown(screen.getByTestId("url-paste-plain"));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByText("elsewhere"));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("is dismissed by Escape, which returns focus to the editor", () => {
    const { onDismiss, view } = renderOffer();
    screen.getByTestId("url-paste-link").focus();
    fireEvent.keyDown(screen.getByTestId("url-paste-link"), { key: "Escape" });
    expect(onDismiss).toHaveBeenCalled();
    expect(view.focus).toHaveBeenCalledOnce();
  });

  it("is dismissed when focus leaves it", () => {
    const { onDismiss } = renderOffer();
    screen.getByTestId("url-paste-link").focus();
    screen.getByTestId("url-paste-plain").focus();
    expect(onDismiss).not.toHaveBeenCalled();
    screen.getByText("elsewhere").focus();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("moves between its buttons with the arrows", () => {
    renderOffer();
    screen.getByTestId("url-paste-link").focus();
    fireEvent.keyDown(screen.getByTestId("url-paste-link"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByTestId("url-paste-plain"));
    fireEvent.keyDown(screen.getByTestId("url-paste-plain"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByTestId("url-paste-link"));
  });

  it("returns focus to the editor when a choice of the current form closes the row", () => {
    const { onChoose, view, rerender } = renderOffer();
    screen.getByTestId("url-paste-link").focus();
    fireEvent.click(screen.getByTestId("url-paste-link"));
    expect(onChoose).toHaveBeenCalledWith("link");
    expect(view.focus).toHaveBeenCalledOnce();
    rerender(null);
    expect(screen.queryByTestId("url-paste-offer")).toBeNull();
  });

  it("leaves the editor's focus alone when the pointer chooses", () => {
    const { view } = renderOffer();
    fireEvent.click(screen.getByTestId("url-paste-link"));
    expect(view.focus).not.toHaveBeenCalled();
  });

  it("returns focus to the editor after Undo from the keyboard", () => {
    const { onUndo, view } = renderOffer({ ...OFFER, form: "plain", chosen: true });
    screen.getByTestId("url-paste-undo").focus();
    fireEvent.click(screen.getByTestId("url-paste-undo"));
    expect(onUndo).toHaveBeenCalledOnce();
    expect(view.focus).toHaveBeenCalledOnce();
  });

  it("shows Undo after a choice made from the keyboard, with focus on it", () => {
    const { onChoose, onUndo, onDismiss, rerender } = renderOffer();
    screen.getByTestId("url-paste-plain").focus();
    fireEvent.click(screen.getByTestId("url-paste-plain"));
    expect(onChoose).toHaveBeenCalledWith("plain");
    rerender({ ...OFFER, form: "plain", chosen: true });
    expect(screen.queryByTestId("url-paste-plain")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("url-paste-undo"));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("url-paste-undo"));
    expect(onUndo).toHaveBeenCalledOnce();
  });
});
