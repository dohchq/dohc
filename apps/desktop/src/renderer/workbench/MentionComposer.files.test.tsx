// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { MentionComposer, type AddMessageFiles } from "./MentionComposer";

function Harness(props: {
  onAddFiles?: AddMessageFiles;
  composerId?: string;
  initial?: string;
  composerKey?: string;
  surface?: "post";
  onSend?: () => void;
}) {
  const [value, setValue] = useState(props.initial ?? "");
  return (
    <MentionComposer
      key={props.composerKey}
      surface={props.surface}
      testIdPrefix="chats"
      composerId={props.composerId ?? "chats-composer"}
      value={value}
      sending={false}
      placeholder="Write a message…"
      sendLabel="Send message"
      candidates={[]}
      onAddFiles={props.onAddFiles}
      onChange={setValue}
      onSend={props.onSend ?? (() => {})}
    />
  );
}

function transfer(files: File[], text = ""): DataTransfer {
  return {
    files,
    types: ["Files"],
    getData: (type: string) => (type === "text/plain" ? text : ""),
    dropEffect: "none",
  } as unknown as DataTransfer;
}

const picture = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MentionComposer files", () => {
  it("links pasted files where the caret is, and holds Send while they save", async () => {
    const onSend = vi.fn();
    const saving = deferred();
    const onAddFiles = vi.fn<AddMessageFiles>(async (link) => {
      await saving.promise;
      link(["team/image-1.png", "team/My notes.pdf"]);
    });
    render(<Harness onAddFiles={onAddFiles} onSend={onSend} />);
    const composer = screen.getByTestId<HTMLTextAreaElement>("chats-composer");
    await userEvent.type(composer, "look at this");

    fireEvent.paste(composer, { clipboardData: transfer([picture]) });

    expect(onAddFiles).toHaveBeenCalledWith(expect.any(Function), [picture]);
    expect(screen.getByTestId("chats-adding-files")).toBeTruthy();
    expect(screen.getByTestId<HTMLButtonElement>("chats-send").disabled).toBe(true);
    fireEvent.keyDown(composer, { key: "Enter" });
    fireEvent.submit(composer.closest("form")!);
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => {
      saving.resolve();
      await saving.promise;
    });
    expect(composer.value).toBe("look at this @[team/image-1.png] @[team/My notes.pdf] ");
    expect(screen.queryByTestId("chats-adding-files")).toBeNull();
    expect(screen.getByTestId<HTMLButtonElement>("chats-send").disabled).toBe(false);
  });

  it("leaves a paste that carries text to the text box", async () => {
    const onAddFiles = vi.fn<AddMessageFiles>(async () => {});
    render(<Harness onAddFiles={onAddFiles} />);
    const composer = screen.getByTestId("chats-composer");
    const event = fireEvent.paste(composer, { clipboardData: transfer([picture], "A1\tB1") });
    expect(event).toBe(true);
    expect(onAddFiles).not.toHaveBeenCalled();
  });

  it("links dropped files", async () => {
    const onAddFiles = vi.fn<AddMessageFiles>(async (link) => {
      link(["clip.mp4"]);
    });
    render(<Harness onAddFiles={onAddFiles} />);
    const composer = screen.getByTestId<HTMLTextAreaElement>("chats-composer");
    const form = composer.closest("form")!;
    const video = new File([new Uint8Array([1])], "clip.mp4", { type: "video/mp4" });

    fireEvent.dragOver(form, { dataTransfer: transfer([video]) });
    expect(form.dataset.dropping).toBe("true");
    await act(async () => {
      fireEvent.drop(form, { dataTransfer: transfer([video]) });
    });

    expect(onAddFiles).toHaveBeenCalledWith(expect.any(Function), [video]);
    expect(form.dataset.dropping).toBeUndefined();
    expect(composer.value).toBe("@[clip.mp4] ");
  });

  it("offers Add files in + only where files can be added, and opens the picker", async () => {
    const { unmount } = render(<Harness />);
    expect(screen.queryByTestId("chats-add")).toBeNull();
    unmount();

    const onAddFiles = vi.fn<AddMessageFiles>(async (link) => {
      link(["notes.txt"]);
    });
    render(<Harness onAddFiles={onAddFiles} />);
    await userEvent.click(screen.getByTestId("chats-add"));
    await userEvent.click(await screen.findByTestId("chats-add-files"));

    expect(onAddFiles).toHaveBeenCalledWith(expect.any(Function), undefined);
    expect(screen.getByTestId<HTMLTextAreaElement>("chats-composer").value).toBe("@[notes.txt] ");
  });

  it("opens the picker from a new post's paperclip with the keyboard", async () => {
    const onAddFiles = vi.fn<AddMessageFiles>(async () => {});
    render(<Harness surface="post" onAddFiles={onAddFiles} />);
    await userEvent.click(screen.getByTestId("chats-composer"));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByTestId("chats-add-files"));
    await userEvent.keyboard("{Enter}");
    expect(onAddFiles).toHaveBeenCalledWith(expect.any(Function), undefined);
  });

  it("links nothing from a retry that ends after the message was sent", async () => {
    const onSend = vi.fn();
    let retryLink: Parameters<AddMessageFiles>[0] | null = null;
    const onAddFiles = vi.fn<AddMessageFiles>(async (link) => {
      retryLink = link;
    });
    render(<Harness onAddFiles={onAddFiles} onSend={onSend} />);
    const composer = screen.getByTestId<HTMLTextAreaElement>("chats-composer");
    await userEvent.type(composer, "hi");
    await act(async () => {
      fireEvent.paste(composer, { clipboardData: transfer([picture]) });
    });

    fireEvent.keyDown(composer, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    act(() => {
      retryLink!(["team/late.png"]);
    });

    expect(composer.value).toBe("hi");
  });

  it("links nothing into another chat's box", async () => {
    const saving = deferred();
    const onAddFiles = vi.fn<AddMessageFiles>(async (link) => {
      await saving.promise;
      link(["team/image-1.png"]);
    });
    const { rerender } = render(<Harness onAddFiles={onAddFiles} />);
    fireEvent.paste(screen.getByTestId("chats-composer"), {
      clipboardData: transfer([picture]),
    });

    rerender(<Harness onAddFiles={onAddFiles} composerId="chats-other" />);
    await act(async () => {
      saving.resolve();
      await saving.promise;
    });

    expect(screen.getByTestId<HTMLTextAreaElement>("chats-composer").value).toBe("");
    expect(screen.queryByTestId("chats-adding-files")).toBeNull();
  });

  it("links nothing after its box is replaced by another thread's", async () => {
    const saving = deferred();
    const onAddFiles = vi.fn<AddMessageFiles>(async (link) => {
      await saving.promise;
      link(["team/image-1.png"]);
    });
    const { rerender } = render(<Harness composerKey="thread-a" onAddFiles={onAddFiles} />);
    fireEvent.paste(screen.getByTestId("chats-composer"), {
      clipboardData: transfer([picture]),
    });

    rerender(<Harness composerKey="thread-b" onAddFiles={onAddFiles} />);
    await act(async () => {
      saving.resolve();
      await saving.promise;
    });

    expect(screen.getByTestId<HTMLTextAreaElement>("chats-composer").value).toBe("");
  });

  it("links at most 20 files in a message and says how many it left out", async () => {
    let unlinked = -1;
    const onAddFiles = vi.fn<AddMessageFiles>(async (link) => {
      unlinked = link(["c.png", "d.png", "e.png"]);
    });
    const initial = Array.from({ length: 18 }, (_, index) => `@[f${index}.md]`).join(" ");
    render(<Harness onAddFiles={onAddFiles} initial={`${initial} `} />);
    await act(async () => {
      fireEvent.paste(screen.getByTestId("chats-composer"), {
        clipboardData: transfer([picture]),
      });
    });

    const value = screen.getByTestId<HTMLTextAreaElement>("chats-composer").value;
    expect(value).toContain("@[c.png] @[d.png] ");
    expect(value).not.toContain("e.png");
    expect(unlinked).toBe(1);
  });
});
