// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { CollectionPermissionsDialog } from "./CollectionPermissionsDialog";
import { ShellErrorReporter } from "./shell/useShellError";
const api = vi.hoisted(() => ({ dataset: vi.fn(), listRelayShares: vi.fn() }));
vi.mock("./bridge", () => ({ bridge: () => api }));
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const dataset: DatasetDescription = {
  datasetId: id(1),
  name: "Orders",
  revision: 2,
  revisionSha256: "a".repeat(64),
  tables: [],
  operations: [
    {
      operationId: id(2),
      name: "read",
      label: "Read orders",
      kind: "read",
      access: "helper",
      readOnly: true,
      tableId: id(4),
      fieldIds: [],
    },
    {
      operationId: id(3),
      name: "admin",
      label: "Owner action",
      kind: "action",
      access: "owner",
      readOnly: false,
      tableId: id(4),
      fieldIds: [],
    },
  ],
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("grants only selected shareable actions from the displayed revision to a workspace recipient", async () => {
  api.dataset.mockImplementation(async (input) =>
    input.action === "permissions"
      ? { kind: "permissions", permissions: [], nextCursor: null }
      : { kind: "grant-updated" },
  );
  api.listRelayShares.mockResolvedValue({
    granted: [
      {
        workspaceId: "w",
        grantId: "grant",
        recipientUserId: "person",
        recipientEmail: "friend@example.test",
        revokedAtMs: null,
      },
      {
        workspaceId: "elsewhere",
        grantId: "other",
        recipientUserId: "other",
        recipientEmail: "other@example.test",
        revokedAtMs: null,
      },
    ],
  });
  render(
    <CollectionPermissionsDialog
      datasetPath="data/dataset.json"
      workspaceId="w"
      dataset={dataset}
      onClose={vi.fn()}
      onError={vi.fn()}
    />,
  );
  await screen.findByRole("option", { name: /friend@example.test/ });
  expect(screen.queryByText("Owner action")).toBeNull();
  expect(screen.queryByRole("option", { name: /other@example.test/ })).toBeNull();
  fireEvent.change(screen.getByLabelText("Collection access person"), {
    target: { value: "grant" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /Read orders/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save access" }));
  await waitFor(() =>
    expect(api.dataset).toHaveBeenCalledWith({
      workspaceId: "w",
      datasetPath: "data/dataset.json",
      expectedDatasetId: id(1),
      action: "setGrant",
      grantId: "grant",
      grant: { revision: 2, revisionSha256: "a".repeat(64), operationIds: [id(2)], discover: true },
    }),
  );
});
it("says which server a Collection is on", async () => {
  api.dataset.mockResolvedValue({
    kind: "permissions",
    permissions: [],
    nextCursor: null,
    place: { kind: "server", host: "sync.example.test" },
  });
  api.listRelayShares.mockResolvedValue({ granted: [] });
  render(
    <CollectionPermissionsDialog
      datasetPath="data/dataset.json"
      workspaceId="w"
      dataset={dataset}
      onClose={vi.fn()}
      onError={vi.fn()}
    />,
  );
  await screen.findByText("This Collection is on sync.example.test.");
  expect(screen.getByText(/Saving replaces this person's allowed actions/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save access" })).toBeTruthy();
});
const stopped = Error(
  "CollectionMoveUnfinishedError: This Collection didn't finish moving to sync.example.test. Its records are kept on this computer.",
);
const friend = {
  workspaceId: "w",
  grantId: "grant",
  recipientUserId: "person",
  recipientEmail: "friend@example.test",
  revokedAtMs: null,
};
const accessRow = `collection-access:${id(1)}`;
const choose = async () => {
  await screen.findByRole("option", { name: /friend@example.test/ });
  fireEvent.change(screen.getByLabelText("Collection access person"), {
    target: { value: "grant" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /Read orders/ }));
};
it("says in place that the access wasn't saved, keeps the choices and focus, files nothing while open, and saves again from its button", async () => {
  let fail = true;
  api.dataset.mockImplementation(async (input) => {
    if (input.action === "permissions")
      return { kind: "permissions", permissions: [], nextCursor: null };
    if (fail) throw stopped;
    return { kind: "grant-updated" };
  });
  api.listRelayShares.mockResolvedValue({ granted: [friend] });
  const onError = vi.fn(),
    onSettled = vi.fn(),
    report = vi.fn();
  render(
    <ShellErrorReporter.Provider value={report}>
      <CollectionPermissionsDialog
        datasetPath="data/dataset.json"
        workspaceId="w"
        dataset={dataset}
        onClose={vi.fn()}
        onError={onError}
        onSettled={onSettled}
      />
    </ShellErrorReporter.Provider>,
  );
  await choose();
  const save = screen.getByRole("button", { name: "Save access" });
  save.focus();
  fireEvent.click(save);
  const line = await screen.findByText(
    "Access wasn't saved. This Collection didn't finish moving to sync.example.test. Its records are kept on this computer.",
  );
  expect(line.getAttribute("role")).toBe("status");
  expect(document.activeElement).toBe(save);
  expect((screen.getByLabelText("Collection access person") as HTMLSelectElement).value).toBe(
    "grant",
  );
  expect((screen.getByRole("checkbox", { name: /Read orders/ }) as HTMLInputElement).checked).toBe(
    true,
  );
  expect(onError).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
  fail = false;
  fireEvent.click(save);
  await waitFor(() => expect(onSettled).toHaveBeenCalledWith(accessRow));
  expect(screen.queryByText(/Access wasn't saved/)).toBeNull();
  await waitFor(() =>
    expect((screen.getByLabelText("Collection access person") as HTMLSelectElement).value).toBe(""),
  );
  expect(onError).not.toHaveBeenCalled();
});
