// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LegendListProps } from "@legendapp/list/react";
import type { ChatMessageRecord } from "../../ipc/bridgeContract";
import { ChatMessageList } from "./chatMessages";
import { extractChatFileReferenceTokens } from "./chatFileMentions";

vi.mock("./chatFileMentions", { spy: true });
vi.mock("@legendapp/list/react", () => ({
  LegendList: function LegendList(props: LegendListProps<ChatMessageRecord>) {
    // Reuse unchanged row renders so this test isolates focus-neighbor work.
    // Browser tests cover the real list's mounting and native Tab behavior.
    const rows = useMemo(() => props.data?.map((item, index) =>
      props.renderItem?.({ item, index, data: props.data!, extraData: props.extraData, type: undefined })),
    [props.data, props.renderItem, props.extraData]);
    return <div role="list" data-pinned={props.alwaysRender?.indices?.join(",")}
      onFocusCapture={props.onFocusCapture} onBlurCapture={props.onBlurCapture}>{rows}</div>;
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const messages: ChatMessageRecord[] = Array.from({ length: 301 }, (_, index) => ({
  id: `m-${index}`,
  threadId: "thread",
  authorKind: "human",
  authorDisplayName: "Reader",
  createdAtMs: 1_700_000_000_000 + index * 60_000,
  body: index % 150 === 0 ? `See @[notes/${index}.md].` : `Plain message ${index}.`,
}));
const onOpenPath = () => {};
const readOnly = { reactions: [], viewerAuthorId: "viewer", readOnly: true, onToggle: () => {} };

function focus(button: HTMLElement) {
  act(() => button.focus());
}

describe("chat focus neighbors", () => {
  it("reuses sparse file-link indices while focus moves and refreshes them when a body changes", () => {
    const { rerender } = render(<ChatMessageList testIdPrefix="focus" messages={messages}
      loading={false} emptyLabel="Empty" onOpenPath={onOpenPath} reactionControls={readOnly} />);
    const links = screen.getAllByTestId("focus-message-body-file-mention");
    vi.mocked(extractChatFileReferenceTokens).mockClear();

    focus(links[0]!);
    expect(screen.getByRole("list").getAttribute("data-pinned")).toBe("0,150");
    focus(links[1]!);
    expect(screen.getByRole("list").getAttribute("data-pinned")).toBe("150,0,300");
    focus(links[2]!);
    expect(screen.getByRole("list").getAttribute("data-pinned")).toBe("300,150");
    expect(extractChatFileReferenceTokens).not.toHaveBeenCalled();

    const changed = messages.map((message, index) => index === 75
      ? { ...message, body: "See @[notes/new.md]." } : message);
    rerender(<ChatMessageList testIdPrefix="focus" messages={changed}
      loading={false} emptyLabel="Empty" onOpenPath={onOpenPath} reactionControls={readOnly} />);
    vi.mocked(extractChatFileReferenceTokens).mockClear();
    focus(screen.getAllByTestId("focus-message-body-file-mention")[1]!);
    expect(screen.getByRole("list").getAttribute("data-pinned")).toBe("75,0,150");
    expect(extractChatFileReferenceTokens).not.toHaveBeenCalled();
  });

  it("pins adjacent messages when every row has a reaction button", () => {
    render(<ChatMessageList testIdPrefix="focus" messages={messages}
      loading={false} emptyLabel="Empty" onOpenPath={onOpenPath}
      reactionControls={{ ...readOnly, readOnly: false }} />);
    vi.mocked(extractChatFileReferenceTokens).mockClear();
    focus(screen.getAllByRole("button", { name: "Add reaction" })[150]!);
    expect(screen.getByRole("list").getAttribute("data-pinned")).toBe("150,149,151");
    expect(extractChatFileReferenceTokens).not.toHaveBeenCalled();
  });
});
