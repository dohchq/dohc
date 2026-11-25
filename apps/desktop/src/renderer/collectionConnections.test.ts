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
const signal = () => new AbortController().signal;

describe("readCollectionConnections", () => {
  it("reads only Collections whose folder the viewer reaches, and names only those", async () => {
    const reads = readsFor({
      roadmap: [
        app("rollup", ["roadmap-read"]),
        app("triage", ["roadmap-read", "roadmap-write"]),
        app("form", ["roadmap-write"]),
      ],
      bugs: [app("rollup", ["bugs-read"]), app("stale", ["gone"])],
      hidden: [app("rollup", ["hidden-read"])],
    });
    const groups = await readCollectionConnections(
      [
        dataset("roadmap", "team/roadmap/dataset.json"),
        dataset("hidden", null),
        dataset("old", "old/dataset.json", { archived: true }),
        dataset("bugs", "bugs/dataset.json"),
        dataset("broken", "broken/dataset.json"),
      ],
      ["team/tasks"],
      reads,
      signal(),
    );
    expect(groups.map((group) => group.key)).toEqual([
      "roadmap",
      "bugs",
      "broken",
      "folder:team/tasks",
    ]);
    expect(reads.apps).not.toHaveBeenCalledWith(expect.anything(), "hidden");
    expect(reads.apps).toHaveBeenCalledTimes(3);
    expect(reads.automations).toHaveBeenCalledWith("team/roadmap");
    expect(reads.automations).toHaveBeenCalledWith("team/tasks");
    const [roadmap, bugs, broken, tasks] = groups;
    expect(roadmap!.apps).toMatchObject([
      { publicationId: "rollup", access: "Reads", also: ["bugs"] },
      { publicationId: "triage", access: "Reads and writes", also: [] },
      { publicationId: "form", access: "Writes" },
    ]);
    expect(bugs!.apps).toMatchObject([
      { publicationId: "rollup", also: ["roadmap"] },
      { publicationId: "stale", access: null },
    ]);
    expect(JSON.stringify(groups)).not.toContain("hidden");
    expect(broken).toMatchObject({ failed: true, apps: null });
    expect(tasks).toMatchObject({ name: "tasks", apps: null, failed: false });
  });

  it("reads every Collection Home has loaded, and a root Collection's apps without automations", async () => {
    const many = Array.from({ length: 51 }, (_, index) =>
      dataset(`c${index}`, `c${index}/dataset.json`),
    );
    const reads = readsFor({ root: [app("rollup", ["root-read"])] });
    const groups = await readCollectionConnections(
      [dataset("root", "dataset.json"), ...many],
      [],
      reads,
      signal(),
    );
    expect(groups).toHaveLength(52);
    expect(groups[0]).toMatchObject({ failed: false, apps: [{ publicationId: "rollup" }] });
    expect(reads.automations).not.toHaveBeenCalledWith("");
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
      [],
      { automations },
      signal(),
    );
    expect(group).toMatchObject({
      apps: null,
      automations: [{ name: "Notify the team", trigger: "When a record is added", enabled: false }],
    });
  });
});
