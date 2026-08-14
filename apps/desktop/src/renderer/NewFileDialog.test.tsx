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
