// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCollectionSchema } from "@dohc/workspace-contracts";
import type { CollectionRef } from "@dohc/workspace-contracts/collection-data";
import { parseDatasetDefinition, type DatasetDefinition } from "@dohc/security-contract/dataset";
import { NewCollectionDialog } from "./NewCollectionDialog";
import { deferred } from "../../testing/deferred";

// The flow's whole contract is the IPC payload: one createWorkspaceFile call
// whose text parses back as the schema the user described in collection
// vocabulary. The dialog never shows the file or the format.

const bridgeMock = vi.hoisted(() => ({
  createWorkspaceFile: vi.fn(),
  listCollections: vi.fn(async () => ({ collections: [] })),
  dataset: vi.fn(),
}));
vi.mock("../bridge", () => ({ bridge: () => bridgeMock }));

afterEach(() => {
  cleanup();
  bridgeMock.createWorkspaceFile.mockReset();
  bridgeMock.listCollections.mockClear();
  bridgeMock.dataset.mockReset();
});

function renderDialog(onCreated: (ref: CollectionRef) => void = () => undefined, documents = true) {
  const result = render(
    <NewCollectionDialog
      workspaceId="ws-1"
      onClose={() => undefined}
      onCreated={onCreated}
      onError={() => undefined}
    />,
  );
  if (documents) fireEvent.click(screen.getByLabelText("Documents"));
  return result;
}

describe("NewCollectionDialog", () => {
  it("previews the collection name and fields without inventing records", () => {
    renderDialog(() => undefined, false);
    fireEvent.change(screen.getByLabelText("Collection name"), { target: { value: "events/registrations" } });
    fireEvent.change(screen.getByLabelText("Field name"), { target: { value: "Player" } });
    const preview = within(screen.getByRole("region", { name: "Collection preview" }));
    expect(preview.getByText("registrations")).toBeTruthy();
    expect(preview.getByRole("columnheader", { name: "Player" })).toBeTruthy();
    expect(preview.getByText("0 records")).toBeTruthy();
    expect(preview.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByLabelText("Documents"));
    expect(preview.queryByRole("columnheader", { name: "Player" })).toBeNull();
    expect(preview.getByRole("columnheader", { name: "Name" })).toBeTruthy();
  });

  it("defaults to data and creates a typed backend without an app or SQL input", async () => {
    bridgeMock.dataset.mockImplementation(async (request: { definition: DatasetDefinition }) => ({ kind: "approved", revision: { datasetId: request.definition.datasetId } }));
    const onCreated = vi.fn();
    renderDialog(onCreated, false);
    expect((screen.getByLabelText("Data") as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText("Collection name"), { target: { value: "events/registrations" } });
    fireEvent.click(screen.getByLabelText("Require Name"));
    fireEvent.click(screen.getByLabelText("Unique Name"));
    fireEvent.click(screen.getByText("Add field"));
    fireEvent.change(screen.getAllByLabelText("Field name")[1]!, { target: { value: "Status" } });
    fireEvent.change(screen.getAllByLabelText("Field type")[1]!, { target: { value: "select" } });
    fireEvent.change(screen.getByLabelText("Options"), { target: { value: "New, Reviewed" } });
    fireEvent.click(screen.getByLabelText("Default for Status"));
    fireEvent.change(screen.getByLabelText("Default Status"), { target: { value: "New" } });
    fireEvent.click(screen.getByTestId("new-collection-create"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    const request = bridgeMock.dataset.mock.calls[0]![0];
    const definition = parseDatasetDefinition(request.definition);
    expect(request.action).toBe("create"); expect(request.workspaceId).toBe("ws-1");
    expect(definition.schemaPath).toBe("events/registrations/schema.sql");
    expect(definition.tables[0]!.fields[1]).toMatchObject({ name: "Name", required: true, unique: true });
    expect(definition.tables[0]!.fields[2]).toMatchObject({ name: "Status", default: "New" });
    expect(onCreated).toHaveBeenCalledWith({ kind: "transactional", datasetId: definition.datasetId, tableId: definition.tables[0]!.tableId });
    expect(bridgeMock.createWorkspaceFile).not.toHaveBeenCalled();
  });

  it("offers file fields and rejects an invalid default before creating sources", async () => {
    renderDialog(() => undefined, false);
    fireEvent.change(screen.getByLabelText("Collection name"), { target: { value: "registrations" } });
    fireEvent.change(screen.getByLabelText("Field type"), { target: { value: "attachment" } });
    expect(screen.queryByLabelText("Default for Name")).toBeNull();
    fireEvent.change(screen.getByLabelText("Field type"), { target: { value: "number" } });
    fireEvent.click(screen.getByLabelText("Default for Name"));
    fireEvent.click(screen.getByTestId("new-collection-create"));
    expect((await screen.findByRole("alert")).textContent).toContain("Enter a number");
    expect(bridgeMock.dataset).not.toHaveBeenCalled();
  });

  it("sends creation failures to Notices and ignores completion in another workspace", async () => {
    const pending = deferred<unknown>();
    bridgeMock.dataset.mockReturnValue(pending.promise);
    const onCreated = vi.fn(), onError = vi.fn();
    const props = { workspaceId: "ws-1", onCreated, onError, onClose: () => undefined };
    const { rerender } = render(<NewCollectionDialog {...props} />);
    fireEvent.change(screen.getByLabelText("Collection name"), { target: { value: "registrations" } });
    fireEvent.click(screen.getByTestId("new-collection-create"));
    rerender(<NewCollectionDialog {...props} workspaceId="ws-2" />);
    await act(async () => { pending.resolve({ kind: "approved", revision: { datasetId: bridgeMock.dataset.mock.calls[0]![0].definition.datasetId } }); });
    expect(onCreated).not.toHaveBeenCalled();
    bridgeMock.dataset.mockRejectedValue(new Error("Storage unavailable"));
    fireEvent.change(screen.getByLabelText("Collection name"), { target: { value: "new-data" } });
    fireEvent.click(screen.getByTestId("new-collection-create"));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]![2]).toBeTypeOf("function");
    expect(screen.queryByText("Storage unavailable")).toBeNull();
  });

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
    expect(onCreated).toHaveBeenCalledExactlyOnceWith({ kind: "document", path: "projects/tasks" });
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

  it("refuses a relation without a target and a select without options", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Collection name"), {
      target: { value: "tasks" },
    });
    fireEvent.click(screen.getByText("Add field"));
    const names = screen.getAllByLabelText("Field name");
    fireEvent.change(names[1] as Element, { target: { value: "Owner" } });
    const types = screen.getAllByLabelText("Field type");
    fireEvent.change(types[1] as Element, { target: { value: "relation" } });
    fireEvent.click(screen.getByTestId("new-collection-create"));
    expect(
      await screen.findByText("Choose a collection to relate to."),
    ).toBeDefined();

    fireEvent.change(types[1] as Element, { target: { value: "select" } });
    fireEvent.click(screen.getByTestId("new-collection-create"));
    expect(
      await screen.findByText("Give the field at least one option."),
    ).toBeDefined();
    expect(bridgeMock.createWorkspaceFile).not.toHaveBeenCalled();
  });
});
