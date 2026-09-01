import { describe, expect, it } from "vitest";
import {
  parseLiveObjectBinding as sharedParseLiveObjectBinding,
  type LiveObjectBinding,
} from "@dohc/live-session-contract/live-object-binding";
import {
  parseLiveObjectBinding as workspaceEngineClientParseLiveObjectBinding,
} from "../index.js";
import type { DaemonRequesterClient } from "../live/daemonLiveAdapter.js";
import type { Request } from "./generated/Request.js";
import { OwnerYDocOutbox } from "./ownerYDocOutbox.js";
import vectors from "../../../live-session-contract/src/liveObjectBinding.vectors.json";

const appendInput = (binding: LiveObjectBinding) => ({
  binding,
  baseUpdate: new Uint8Array([1]),
  appendKey: "append-1",
  update: new Uint8Array([2]),
  limits: {
    maxPendingBytes: 1_000,
    maxPendingAgeMs: 1_000,
  },
});

describe("LiveObjectBinding workspace-engine adapter", () => {
  it("directly re-exports the shared parser", () => {
    expect(workspaceEngineClientParseLiveObjectBinding).toBe(
      sharedParseLiveObjectBinding,
    );
  });

  it("refuses vector-invalid input before a request", async () => {
    const requests: Request[] = [];
    const client: DaemonRequesterClient = {
      async sendRequest(request) {
        requests.push(request);
        throw new Error("the invalid binding must not reach the daemon");
      },
    };
    const invalid = vectors.refused.find(
      (row) => row.name === "refuses-authority-shaped-grant-field",
    )!;
    const outbox = new OwnerYDocOutbox(client, "workspace-handle");

    await expect(
      outbox.append(
        appendInput(invalid.input as unknown as LiveObjectBinding),
      ),
    ).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });

  it("refuses ill-formed UTF-16 bindings before a request", async () => {
    const requests: Request[] = [];
    const client: DaemonRequesterClient = {
      async sendRequest(request) {
        requests.push(request);
        throw new Error("an ill-formed binding must not reach the daemon");
      },
    };
    const canonical = vectors.accepted.find(
      (row) => row.name === "canonical-binding",
    )!;
    const illFormedIdentifier = structuredClone(canonical.input);
    illFormedIdentifier.objectId = "object-\ud800";
    const illFormedPath = structuredClone(canonical.input);
    illFormedPath.selectorPaths = ["notes/\udc00.md"];
    const outbox = new OwnerYDocOutbox(client, "workspace-handle");

    for (const binding of [illFormedIdentifier, illFormedPath]) {
      await expect(
        outbox.append(
          appendInput(binding as unknown as LiveObjectBinding),
        ),
      ).rejects.toThrow(TypeError);
    }
    expect(requests).toHaveLength(0);
  });

  it("refuses sparse selector paths before a request", async () => {
    const requests: Request[] = [];
    const client: DaemonRequesterClient = {
      async sendRequest(request) {
        requests.push(request);
        throw new Error("a sparse binding must not reach the daemon");
      },
    };
    const canonical = vectors.accepted.find(
      (row) => row.name === "canonical-binding",
    )!;
    const sparse = structuredClone(canonical.input);
    sparse.selectorPaths = new Array<string>(1);
    const outbox = new OwnerYDocOutbox(client, "workspace-handle");

    await expect(
      outbox.append(appendInput(sparse as unknown as LiveObjectBinding)),
    ).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });

  it("sends a vector-normalized binding unchanged", async () => {
    const requests: Request[] = [];
    const client: DaemonRequesterClient = {
      async sendRequest(request) {
        requests.push(request);
        return {
          id: request.id,
          result: {
            outboxId: "outbox-1",
            sequence: 1,
            deliveryId: "delivery-1",
            updateDigest: "0".repeat(64),
            pendingBytes: 1,
            oldestEntryAtMs: 1,
            state: "active",
          },
        };
      },
    };
    const accepted = vectors.accepted.find(
      (row) =>
        row.name ===
        "normalizes-sorts-utf8-and-deduplicates-selector-paths",
    )!;
    const outbox = new OwnerYDocOutbox(client, "workspace-handle");

    await outbox.append(
      appendInput(accepted.input as unknown as LiveObjectBinding),
    );

    expect(requests).toHaveLength(1);
    expect(
      (requests[0]!.params as unknown as Record<string, unknown>).binding,
    ).toEqual(accepted.normalized);
  });
});
