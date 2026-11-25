import { describe, expect, it, vi } from "vitest";
import type { AddressedDatasetDescription, DatasetBoundApp } from "@dohc/cli/dataset";
import { readCollectionConnections, type ConnectionReads } from "./collectionConnections";

const op = (operationId: string, readOnly: boolean) => ({ operationId, readOnly });
const dataset = (
  datasetId: string,
  datasetPath: string | null,
  extra: Partial<AddressedDatasetDescription> = {},
) =>
  ({
    datasetId,
    name: datasetId,
    datasetPath,
    operations: [op(`${datasetId}-read`, true), op(`${datasetId}-write`, false)],
    ...extra,
  }) as unknown as AddressedDatasetDescription;
const app = (publicationId: string, operationIds: string[]): DatasetBoundApp =>
  ({
    scope: "local",
    publicationId,
    appRoot: `apps/${publicationId}`,
    operationIds,
    status: "compatible",
  }) as unknown as DatasetBoundApp;

const readsFor = (bound: Record<string, DatasetBoundApp[]>): Required<ConnectionReads> => ({
  apps: vi.fn(async (_path: string, datasetId: string) => {
    if (datasetId === "broken") throw Error("offline");
    return { boundApps: bound[datasetId] ?? [] };
  }),
  automations: vi.fn(async () => ({ status: "missing" as const })),
});

describe("readCollectionConnections", () => {
  it("reads only Collections whose folder the viewer reaches, and names only those", async () => {
    const reads = readsFor({
      roadmap: [app("rollup", ["roadmap-read"]), app("triage", ["roadmap-read", "roadmap-write"])],
      bugs: [app("rollup", ["bugs-read"]), app("stale", ["gone"])],
      hidden: [app("rollup", ["hidden-read"])],
    });
    const groups = await readCollectionConnections(
      [
        dataset("roadmap", "team/roadmap/dataset.json"),
        dataset("hidden", null),
        dataset("old", "old/dataset.json", { archived: true }),
        dataset("bugs", "dataset.json"),
        dataset("broken", "broken/dataset.json"),
      ],
      reads,
      new AbortController().signal,
    );
    expect(groups.map((group) => group.datasetId)).toEqual(["roadmap", "bugs", "broken"]);
    expect(reads.apps).not.toHaveBeenCalledWith(expect.anything(), "hidden");
    expect(reads.automations).toHaveBeenCalledWith("team/roadmap");
    expect(reads.automations).toHaveBeenCalledWith("");
    const [roadmap, bugs, broken] = groups;
    expect(roadmap!.apps).toMatchObject([
      { publicationId: "rollup", writes: false, also: ["bugs"] },
      { publicationId: "triage", writes: true, also: [] },
    ]);
    expect(bugs!.apps).toMatchObject([
      { publicationId: "rollup", also: ["roadmap"] },
      { publicationId: "stale", writes: null },
    ]);
    expect(JSON.stringify(groups)).not.toContain("hidden");
    expect(broken).toMatchObject({ failed: true, apps: null });
  });

  it("never asks which apps use a Collection when the viewer is not its owner", async () => {
    const automations = vi.fn(async () => ({
      status: "shared" as const,
      definitions: {
        file: {
          status: "read" as const,
          entries: [
            {
              status: "valid" as const,
              automation: {
                id: "notify",
                name: "Notify the team",
                enabled: true,
                when: { kind: "record-added" as const, table: null },
                if: null,
                do: [],
              },
              enabledInFile: false,
              canSwitch: false,
            },
          ],
        },
        contentHash: null,
        canSwitch: false,
        sync: "accepted" as const,
      },
    }));
    const [group] = await readCollectionConnections(
      [dataset("roadmap", "roadmap/dataset.json")],
      { automations },
      new AbortController().signal,
    );
    expect(group).toMatchObject({
      apps: null,
      automations: [{ name: "Notify the team", trigger: "When a record is added", enabled: false }],
    });
  });
});
