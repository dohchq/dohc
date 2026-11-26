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
    "dohc could not save access. This Collection didn't finish moving to sync.example.test. Its records are kept on this computer.",
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

it("shows bound app names, drift statuses, reasons, and incomplete notice", async () => {
  const pubId = "a".repeat(64);
  api.dataset.mockResolvedValue({
    kind: "permissions",
    permissions: [
      {
        kind: "app",
        principal: pubId,
        current: false,
        metadata: {
          kind: "dataset",
          datasetId: id(1),
          revision: 1,
          revisionSha256: "b".repeat(64),
          operationIds: [id(2)],
        },
      },
    ],
    nextCursor: null,
    boundApps: [
      {
        scope: "link",
        publicationId: pubId,
        authorityRevision: 2,
        appRoot: "apps/order-form",
        shareId: "s1",
        grantId: "g1",
        pinnedRevision: 1,
        pinnedRevisionSha256: "b".repeat(64),
        operationIds: [id(2)],
        status: "incompatible",
        reasons: ['Action "Read orders" changed the input format for Amount.'],
      },
    ],
    boundAppsIncomplete: true,
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
  await screen.findByText("apps/order-form");
  expect(screen.getByText("App · Share link · Needs update")).toBeTruthy();
  expect(
    screen.getByText('Action "Read orders" changed the input format for Amount.'),
  ).toBeTruthy();
  expect(screen.getByText(/Some connected apps could not be checked right now/)).toBeTruthy();
});

function permissionsWithDefaults(
  edit: string,
  revision: number,
  revisionSha256: string,
  view: string[] = [],
) {
  api.dataset.mockImplementation(async (input) =>
    input.action === "permissions"
      ? {
          kind: "permissions",
          permissions: [],
          nextCursor: null,
          defaults: {
            view,
            comment: [],
            edit: [id(2), "removed"],
            revision,
            revisionSha256,
            generation: 3,
          },
          rules: {
            revision: 2,
            revisionSha256: "a".repeat(64),
            actions: [
              { operationId: id(2), name: "read", readOnly: true },
              { operationId: edit, name: "edit", readOnly: false },
            ],
          },
        }
      : { kind: "grant-updated" },
  );
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
}
const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

it("sets what each workspace level gets by default, and only reads below Edit", async () => {
  const edit = id(5);
  permissionsWithDefaults(edit, 2, "a".repeat(64));
  const save = await screen.findByRole("button", { name: "Save for members" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(/earlier rules/)).toBeNull();
  expect(screen.getByText("No person or app has its own access.")).toBeTruthy();
  expect(box("Read orders for members with Edit").checked).toBe(true);
  expect(box("edit for members with View").disabled).toBe(true);
  expect(box("edit for members with Comment").disabled).toBe(true);
  fireEvent.click(box("Read orders for members with View"));
  for (const level of ["Comment", "Edit"]) {
    expect(box(`Read orders for members with ${level}`).checked).toBe(true);
    expect(box(`Read orders for members with ${level}`).disabled).toBe(true);
  }
  fireEvent.click(box("edit for members with Edit"));
  fireEvent.click(save);
  await waitFor(() =>
    expect(api.dataset).toHaveBeenCalledWith({
      workspaceId: "w",
      datasetPath: "data/dataset.json",
      expectedDatasetId: id(1),
      action: "setDefaults",
      defaults: {
        view: [id(2)],
        comment: [],
        edit: [id(2), edit].sort(),
        revision: 2,
        revisionSha256: "a".repeat(64),
      },
    }),
  );
});

it("lets the Owner save defaults chosen under earlier rules again, without actions that now change data below Edit", async () => {
  permissionsWithDefaults(id(5), 1, "b".repeat(64), [id(5)]);
  const save = await screen.findByRole("button", { name: "Save for members" });
  expect(screen.getByText(/earlier rules/)).toBeTruthy();
  expect(box("edit for members with View").checked).toBe(false);
  expect(box("edit for members with Edit").disabled).toBe(false);
  expect((save as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(save);
  await waitFor(() =>
    expect(api.dataset).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "setDefaults",
        defaults: {
          view: [],
          comment: [],
          edit: [id(2)],
          revision: 2,
          revisionSha256: "a".repeat(64),
        },
      }),
    ),
  );
});
