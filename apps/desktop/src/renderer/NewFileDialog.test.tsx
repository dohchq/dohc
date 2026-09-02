// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewFileDialog } from "./NewFileDialog";

const bridgeMock = {
  createWorkspaceFile: vi.fn(),
};

vi.mock("./bridge", () => ({
  bridge: () => bridgeMock,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NewFileDialog", () => {
  it("exposes a labelled modal with visible create and cancel actions", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <NewFileDialog
        workspaceId="ws-1"
        onClose={onClose}
        onCreated={() => undefined}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "New file" }).getAttribute("aria-modal"),
    ).toBe("true");
    expect(
      (screen.getByRole("button", { name: "Create file" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("creates from the visible action", async () => {
    bridgeMock.createWorkspaceFile.mockResolvedValueOnce({ path: "notes/today.md" });
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(
      <NewFileDialog
        workspaceId="ws-1"
        onClose={() => undefined}
        onCreated={onCreated}
      />,
    );

    await user.type(screen.getByLabelText("File name"), "notes/today");
    await user.click(screen.getByRole("button", { name: "Create file" }));

    expect(bridgeMock.createWorkspaceFile).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "notes/today.md",
      initialText: "",
    });
    expect(onCreated).toHaveBeenCalledWith("notes/today.md");
  });

  it("announces a create failure", async () => {
    bridgeMock.createWorkspaceFile.mockRejectedValueOnce(
      new Error("dohc could not create this file."),
    );
    const user = userEvent.setup();
    render(
      <NewFileDialog
        workspaceId="ws-1"
        onClose={() => undefined}
        onCreated={() => undefined}
      />,
    );

    await user.type(screen.getByLabelText("File name"), "notes/today{Enter}");

    expect((await screen.findByRole("alert")).textContent).toBe(
      "dohc could not create this file.",
    );
  });

  it("ignores duplicate create submits while a create is pending", async () => {
    const create = deferred<{ path: string }>();
    bridgeMock.createWorkspaceFile.mockImplementationOnce(() => create.promise);
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(
      <NewFileDialog
        workspaceId="ws-1"
        onClose={() => undefined}
        onCreated={onCreated}
      />,
    );

    await user.type(screen.getByLabelText("File name"), "notes/new.md{Enter}{Enter}");
    await act(async () => {
      create.resolve({ path: "notes/new.md" });
    });

    expect(bridgeMock.createWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(bridgeMock.createWorkspaceFile).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "notes/new.md",
      initialText: "",
    });
  });

  it.each(["Cancel", "Escape", "backdrop"] as const)(
    "stays open during a pending create after %s dismissal",
    async (dismissal) => {
      const create = deferred<{ path: string }>();
      bridgeMock.createWorkspaceFile.mockImplementationOnce(() => create.promise);
      const onClose = vi.fn();
      const onCreated = vi.fn();
      const user = userEvent.setup();
      render(
        <NewFileDialog
          workspaceId="ws-1"
          onClose={onClose}
          onCreated={onCreated}
        />,
      );

      await user.type(screen.getByLabelText("File name"), "notes/new.md");
      await user.click(screen.getByRole("button", { name: "Create file" }));

      const cancel = screen.getByRole("button", { name: "Cancel" });
      if (dismissal === "Cancel") {
        await user.click(cancel);
      } else if (dismissal === "Escape") {
        await user.keyboard("{Escape}");
      } else {
        const backdrop = screen.getByRole("dialog", { name: "New file" })
          .parentElement;
        expect(backdrop).not.toBeNull();
        await user.click(backdrop!);
      }

      expect(onClose).not.toHaveBeenCalled();
      expect((cancel as HTMLButtonElement).disabled).toBe(true);

      await act(async () => {
        create.resolve({ path: "notes/new.md" });
      });
      expect(onCreated).toHaveBeenCalledWith("notes/new.md");
    },
  );

  it("defaults a name typed without an extension to markdown", async () => {
    bridgeMock.createWorkspaceFile.mockResolvedValueOnce({
      path: "plans/roadmap.md",
    });
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(
      <NewFileDialog
        workspaceId="ws-1"
        onClose={() => undefined}
        onCreated={onCreated}
      />,
    );

    await user.type(screen.getByLabelText("File name"), "plans/roadmap{Enter}");
    await act(async () => {});

    expect(bridgeMock.createWorkspaceFile).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "plans/roadmap.md",
      initialText: "",
    });
    expect(onCreated).toHaveBeenCalledWith("plans/roadmap.md");
  });

  it("respects an explicit non-markdown extension", async () => {
    bridgeMock.createWorkspaceFile.mockResolvedValueOnce({ path: "data.csv" });
    const user = userEvent.setup();
    render(
      <NewFileDialog
        workspaceId="ws-1"
        onClose={() => undefined}
        onCreated={() => undefined}
      />,
    );

    await user.type(screen.getByLabelText("File name"), "data.csv{Enter}");
    await act(async () => {});

    expect(bridgeMock.createWorkspaceFile).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "data.csv",
      initialText: "",
    });
  });
});
