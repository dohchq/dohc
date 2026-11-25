// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressedDatasetDescription } from "@dohc/cli/dataset";
import { CollectionConnectionsDialog } from "./CollectionConnectionsDialog";
import { WorkspaceSessionProvider } from "./workspace/workspaceSession";

const roadmap = {
  datasetId: "roadmap",
  name: "Roadmap",
  datasetPath: "team/roadmap/dataset.json",
  operations: [{ operationId: "add", readOnly: false }],
} as unknown as AddressedDatasetDescription;

function mount(owner: boolean) {
  const dataset = vi.fn(async () => ({
    kind: "permissions",
    permissions: [],
    nextCursor: null,
    boundApps: [
      {
        scope: "local",
        publicationId: "p",
        appRoot: "team/roadmap-pm",
        operationIds: ["add"],
        status: "needs-refresh",
        reasons: ["Its rules changed."],
      },
    ],
  }));
  const listCollectionAutomations = vi.fn(async () => ({ status: "missing" }));
  window.dohcDesktop = { dataset, listCollectionAutomations } as unknown as NonNullable<
    typeof window.dohcDesktop
  >;
  render(
    <WorkspaceSessionProvider workspaceId="w">
      <CollectionConnectionsDialog
        workspaceId="w"
        datasets={[roadmap]}
        owner={owner}
        more={false}
        onClose={() => {}}
      />
    </WorkspaceSessionProvider>,
  );
  return { dataset, listCollectionAutomations };
}

afterEach(() => {
  cleanup();
  delete window.dohcDesktop;
});

describe("CollectionConnectionsDialog", () => {
  it("shows the owner each app with what it does and whether it needs review", async () => {
    const { dataset } = mount(true);
    expect(await screen.findByText("roadmap-pm")).toBeTruthy();
    expect(screen.getByText("Reads and writes")).toBeTruthy();
    expect(screen.getByText("Needs approval again")).toBeTruthy();
    expect(dataset).toHaveBeenCalledWith(
      expect.objectContaining({ action: "permissions", expectedDatasetId: "roadmap" }),
    );
  });

  it("never asks which apps use a Collection for someone it was shared with", async () => {
    const { dataset, listCollectionAutomations } = mount(false);
    expect(await screen.findByText("No automations.")).toBeTruthy();
    expect(listCollectionAutomations).toHaveBeenCalledWith({
      workspaceId: "w",
      collectionPath: "team/roadmap",
    });
    expect(dataset).not.toHaveBeenCalled();
    expect(screen.queryByText("roadmap-pm")).toBeNull();
  });
});
