import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addBoundaryCrossing,
  createChangeSet,
  type BoundaryCrossing,
} from "@dohc/workspace-core";
import { MANIFEST_PATH, writeManifest } from "@dohc/workspace-fs";
import {
  createAuthorizedFetch,
  createCloudSync,
  syncDecision,
  type FetchLike,
} from "./cloudSync";

type CapturedCall = { input: string | URL | Request; init?: RequestInit };

function captureFetch(body: unknown = { ok: true }) {
  const calls: CapturedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

function sentHeaders(call: CapturedCall) {
  return new Headers(call.init?.headers);
}

describe("createAuthorizedFetch", () => {
  it("injects the Bearer token for a bare string URL", async () => {
    const { calls, fetchImpl } = captureFetch();
    await createAuthorizedFetch("tok-1", fetchImpl)("https://cloud.example/x");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe("https://cloud.example/x");
    expect(sentHeaders(calls[0]!).get("authorization")).toBe("Bearer tok-1");
  });

  it("preserves existing init headers and options alongside the token", async () => {
    const { calls, fetchImpl } = captureFetch();
    await createAuthorizedFetch("tok-2", fetchImpl)("https://cloud.example/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const headers = sentHeaders(calls[0]!);
    expect(headers.get("authorization")).toBe("Bearer tok-2");
    expect(headers.get("content-type")).toBe("application/json");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe("{}");
  });

  it("preserves headers carried on a Request input", async () => {
    const { calls, fetchImpl } = captureFetch();
    await createAuthorizedFetch("tok-3", fetchImpl)(
      new Request("https://cloud.example/y", { headers: { "x-trace": "t1" } }),
    );

    const headers = sentHeaders(calls[0]!);
    expect(headers.get("authorization")).toBe("Bearer tok-3");
    expect(headers.get("x-trace")).toBe("t1");
  });
});

describe("createCloudSync", () => {
  let parentDir: string;

  afterEach(async () => {
    await rm(parentDir, { recursive: true, force: true });
  });

  async function makeClient(fetchImpl: FetchLike) {
    parentDir = await mkdtemp(join(tmpdir(), "dohc-cloud-sync-"));
    const rootDir = join(parentDir, "workspace");
    const client = createCloudSync({
      rootDir,
      remoteWorkspaceId: "ws-1",
      serverUrl: "https://cloud.example/api",
      token: "device-tok",
      fetch: fetchImpl,
    });
    return { client, rootDir };
  }

  it("materializes via the authorized files endpoint", async () => {
    const { calls, fetchImpl } = captureFetch({ ok: true, files: [] });
    const { client, rootDir } = await makeClient(fetchImpl);
    await client.materialize();

    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe("https://cloud.example/api/workspaces/ws-1/files");
    expect(sentHeaders(calls[0]!).get("authorization")).toBe("Bearer device-tok");

    const manifest = JSON.parse(await readFile(join(rootDir, MANIFEST_PATH), "utf8"));
    expect(manifest.workspaceId).toBe("ws-1");
  });

  it("no-ops syncLocalChanges on a clean workspace without network traffic", async () => {
    const { calls, fetchImpl } = captureFetch();
    const { client, rootDir } = await makeClient(fetchImpl);
    await writeManifest(rootDir, {
      version: 1,
      workspaceId: "ws-1",
      backend: "postgres",
      files: {},
    });

    const result = await client.syncLocalChanges();
    expect(result).toEqual({ applied: 0, conflicts: [], approvalRequests: [] });
    expect(calls).toHaveLength(0);
  });
});

describe("syncDecision", () => {
  const edit = createChangeSet({
    kind: "user-edit",
    author: { kind: "user", userId: "user-1" },
    summary: "Edited 1 file",
  });

  it("auto-syncs a plain edit", () => {
    expect(syncDecision(edit)).toBe("auto");
  });

  it.each<BoundaryCrossing>(["permission-change", "public-share"])(
    "requires confirmation for %s",
    (crossing) => {
      expect(syncDecision(addBoundaryCrossing(edit, crossing))).toBe("needs-confirmation");
    },
  );
});
