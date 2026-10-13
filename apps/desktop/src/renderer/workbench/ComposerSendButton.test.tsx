// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "./chatMessages";
import { MentionComposer } from "./MentionComposer";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const noop = () => {};

// Every chat composer sends through the shared control: the lane, DM and
// comment composers (stream), a group's new post (post), and a file's chats
// in About (ChatComposer).
const composers: { name: string; render: (sending: boolean) => ReactElement }[] = [
  {
    name: "a group, DM or comment composer",
    render: (sending) => (
      <MentionComposer testIdPrefix="chats" composerId="chats-composer" value="Hello" sending={sending}
        placeholder="Message" sendLabel="Send message" candidates={[]} onChange={noop} onSend={noop} />
    ),
  },
  {
    name: "a group's new post",
    render: (sending) => (
      <MentionComposer testIdPrefix="chats" composerId="chats-composer" value="Hello" sending={sending}
        surface="post" authorName="Ada" placeholder="What's happening?" sendLabel="Send message"
        candidates={[]} onChange={noop} onSend={noop} />
    ),
  },
  {
    name: "a file's chat in About",
    render: (sending) => (
      <ChatComposer testIdPrefix="chats" composerId="chats-composer" value="Hello" sending={sending}
        placeholder="Message" sendLabel="Send message" onChange={noop} onSend={noop} />
    ),
  },
];

const send = () => screen.getByRole("button", { name: "Send message" });
const status = () => screen.getByRole("status");
const showsPending = () => {
  const ring = screen.queryByTestId("chats-send-pending");
  const busy = send().getAttribute("aria-busy") === "true";
  expect(busy).toBe(ring !== null);
  expect(status().textContent).toBe(busy ? "Sending…" : "");
  return busy;
};

describe.each(composers)("the send control in $name", ({ render: composer }) => {
  it("shows nothing for a send under a second, then the ring and a status", () => {
    const view = render(composer(false));
    view.rerender(composer(true));
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    act(() => vi.advanceTimersByTime(999));
    expect(showsPending()).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(showsPending()).toBe(true);
    // The control keeps its name; the ring is not a second one.
    expect(send().getAttribute("title")).toBe("Send message");
    expect(screen.getByTestId("chats-send-pending").getAttribute("aria-hidden")).toBe("true");
  });

  it("clears when the send ends and times the next send from its start", () => {
    const view = render(composer(true));
    act(() => vi.advanceTimersByTime(1000));
    expect(showsPending()).toBe(true);
    view.rerender(composer(false));
    expect(showsPending()).toBe(false);
    expect((send() as HTMLButtonElement).disabled).toBe(false);
    view.rerender(composer(true));
    act(() => vi.advanceTimersByTime(999));
    expect(showsPending()).toBe(false);
  });

  it("never shows for a send that ends under a second", () => {
    const view = render(composer(true));
    act(() => vi.advanceTimersByTime(500));
    view.rerender(composer(false));
    act(() => vi.advanceTimersByTime(2000));
    expect(showsPending()).toBe(false);
  });
});

it("spins the ring only when motion is allowed", () => {
  render(composers[0]!.render(true));
  act(() => vi.advanceTimersByTime(1000));
  const ring = screen.getByTestId("chats-send-pending").getAttribute("class") ?? "";
  expect(ring.split(" ")).toContain("motion-safe:animate-spin");
  expect(ring.split(" ")).not.toContain("animate-spin");
});

it("does not show a composer that cannot send yet as sending", () => {
  render(
    <MentionComposer testIdPrefix="chats" composerId="chats-composer" value="Hello" sending={false} disabled
      placeholder="Message" sendLabel="Send message" candidates={[]} onChange={noop} onSend={noop} />,
  );
  act(() => vi.advanceTimersByTime(2000));
  expect((send() as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).disabled).toBe(true);
  expect(showsPending()).toBe(false);
});
