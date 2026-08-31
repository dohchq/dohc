// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCollectionSchema } from "@dohc/workspace-contracts";
import { NewCollectionDialog } from "./NewCollectionDialog";

// The flow's whole contract is the IPC payload: one createWorkspaceFile call
// whose text parses back as the schema the user described in collection
// vocabulary. The dialog never shows the file or the format.

const bridgeMock = vi.hoisted(() => ({
  createWorkspaceFile: vi.fn(),
  listCollections: vi.fn(async () => ({ collections: [] })),
}));
vi.mock("../bridge", () => ({ bridge: () => bridgeMock }));

afterEach(() => {
  cleanup();
  bridgeMock.createWorkspaceFile.mockReset();
  bridgeMock.listCollections.mockClear();
});

function renderDialog(onCreated: (path: string) => void = () => undefined) {
  return render(
    <NewCollectionDialog
      workspaceId="ws-1"
      onClose={() => undefined}
      onCreated={onCreated}
    />,
  );
}

describe("NewCollectionDialog", () => {
  it("creates the schema through createWorkspaceFile from the chosen fields", async () => {
    bridgeMock.createWorkspaceFile.mockResolvedValue({
      path: "projects/tasks/collection.yaml",
    });
    const onCreated = vi.fn();
    renderDialog(onCreated);

    fireEvent.change(screen.getByLabelText("Collection name"), {
      target: { value: "projects/tasks" },
    });
    fireEvent.click(screen.getByText("Add field"));
    const names = screen.getAllByLabelText("Field name");
    fireEvent.change(names[1] as Element, { target: { value: "Status" } });
    const types = screen.getAllByLabelText("Field type");
    fireEvent.change(types[1] as Element, { target: { value: "select" } });
    fireEvent.change(screen.getByLabelText("Options"), {
      target: { value: "Todo, Doing, Done" },
    });
    fireEvent.click(screen.getByTestId("new-collection-create"));

    await waitFor(() =>
      expect(bridgeMock.createWorkspaceFile).toHaveBeenCalledOnce(),
    );
    const payload = bridgeMock.createWorkspaceFile.mock.calls[0]?.[0] as {
      workspaceId: string;
      relativePath: string;
      initialText: string;
    };
    expect(payload.workspaceId).toBe("ws-1");
    expect(payload.relativePath).toBe("projects/tasks/collection.yaml");
    const parsed = parseCollectionSchema(payload.initialText);
    expect(parsed.status).toBe("valid");
    expect(parsed.schema).toEqual({
      name: "tasks",
      description: null,
      fields: [
        { name: "Name", type: "text" },
        { name: "Status", type: "select", options: ["Todo", "Doing", "Done"] },
      ],
      views: [],
    });
    expect(onCreated).toHaveBeenCalledExactlyOnceWith("projects/tasks");
  });

  it("refuses a duplicate or reserved field name without an IPC call", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Collection name"), {
      target: { value: "tasks" },
    });
    fireEvent.click(screen.getByText("Add field"));
    const names = screen.getAllByLabelText("Field name");
    fireEvent.change(names[1] as Element, { target: { value: "Name" } });
    fireEvent.click(screen.getByTestId("new-collection-create"));
    expect(
      await screen.findByText(
        'A field named "Name" already exists. Choose another name.',
      ),
    ).toBeDefined();

    fireEvent.change(names[1] as Element, { target: { value: "id" } });
    fireEvent.click(screen.getByTestId("new-collection-create"));
    expect(
      await screen.findByText('The name "id" is reserved. Choose another name.'),
    ).toBeDefined();
    expect(bridgeMock.createWorkspaceFile).not.toHaveBeenCalled();
  });
});
