import { describe, expect, it } from "vitest";
import { createServerClient } from "./client";
import { createSketch, readSketch, saveSketch } from "./phoneSketches";
import { testServer } from "./testServer";

const signal = new AbortController().signal;

function setup() {
  const server = testServer();
  const client = createServerClient({
    origin: server.origin,
    token: "tok",
    fetch: server.fetch,
    signal,
    onSignedOut: () => undefined,
  });
  return { server, client };
}

const sampleElement = {
  id: "el-1",
  type: "rectangle",
  version: 2,
  versionNonce: 42,
  isDeleted: false,
};

const sampleFile = {
  id: "file-1",
  mimeType: "image/png",
  dataURL: "data:image/png;base64,AAAA",
  created: 1_700_000_000_000,
};

describe("phone sketch server operations", () => {
  it("reads a sketch with hydrated assets and refusals", async () => {
    const { server, client } = setup();
    server.on("POST", "/sync/ws-1/ops/readSketch", {
      status: 200,
      body: {
        ok: true,
        result: {
          ok: true,
          path: "notes/flow.excalidraw",
          objectId: "obj-1",
          elements: [sampleElement],
          appState: { viewBackgroundColor: "#fff" },
          files: { "file-1": sampleFile },
          missingAssets: 0,
        },
      },
    });
    expect(await readSketch(client, "ws-1", "notes/flow.excalidraw", signal)).toEqual({
      kind: "sketch",
      path: "notes/flow.excalidraw",
      objectId: "obj-1",
      elements: [sampleElement],
      appState: { viewBackgroundColor: "#fff" },
      files: { "file-1": sampleFile },
      missingAssets: 0,
    });

    for (const refusal of ["missing", "too-large", "invalid"] as const) {
      server.on("POST", "/sync/ws-1/ops/readSketch", {
        status: 200,
        body: { ok: true, result: { ok: false, refusal, reason: "nope" } },
      });
      expect(await readSketch(client, "ws-1", "a.excalidraw", signal)).toEqual({ kind: refusal });
    }
  });

  it("creates and saves a sketch, reporting lostElementIds and refusals", async () => {
    const { server, client } = setup();
    server.on("POST", "/sync/ws-1/ops/createSketch", {
      status: 200,
      body: { ok: true, result: { ok: true, path: "Untitled.excalidraw", objectId: "obj-2" } },
    });
    expect(
      await createSketch(
        client,
        "ws-1",
        { path: "Untitled.excalidraw", requestId: "req-1" },
        signal,
      ),
    ).toEqual({ kind: "created", path: "Untitled.excalidraw", objectId: "obj-2" });

    server.on("POST", "/sync/ws-1/ops/createSketch", {
      status: 200,
      body: { ok: true, result: { ok: false, refusal: "exists", reason: "exists" } },
    });
    expect(
      await createSketch(
        client,
        "ws-1",
        { path: "Untitled.excalidraw", requestId: "req-2" },
        signal,
      ),
    ).toEqual({ kind: "exists" });

    server.on("POST", "/sync/ws-1/ops/saveSketch", {
      status: 200,
      body: {
        ok: true,
        result: {
          ok: true,
          path: "Untitled.excalidraw",
          objectId: "obj-2",
          elements: [sampleElement],
          appState: {},
          files: {},
          missingAssets: 1,
          lostElementIds: ["el-2"],
        },
      },
    });
    expect(
      await saveSketch(
        client,
        "ws-1",
        {
          path: "Untitled.excalidraw",
          objectId: "obj-2",
          requestId: "req-s",
          elements: [sampleElement],
        },
        signal,
      ),
    ).toEqual({
      kind: "saved",
      path: "Untitled.excalidraw",
      objectId: "obj-2",
      elements: [sampleElement],
      appState: {},
      files: {},
      missingAssets: 1,
      lostElementIds: ["el-2"],
    });

    server.on("POST", "/sync/ws-1/ops/saveSketch", {
      status: 200,
      body: { ok: true, result: { ok: false, refusal: "object-changed", reason: "changed" } },
    });
    expect(
      await saveSketch(
        client,
        "ws-1",
        { path: "Untitled.excalidraw", objectId: "obj-2", requestId: "req-s", elements: [] },
        signal,
      ),
    ).toEqual({ kind: "object-changed" });
  });

  it("rejects malformed sketch payloads as invalid", async () => {
    const { server, client } = setup();
    const brokenPayloads = [
      {
        ok: true,
        path: "a.excalidraw",
        objectId: "obj-1",
        elements: [sampleElement],
        appState: {},
        files: { f: { ...sampleFile, dataURL: "https://evil.test/x.png" } },
        missingAssets: 0,
      },
      {
        ok: true,
        path: "a.excalidraw",
        objectId: "obj-1",
        elements: [{ id: "x", type: "rect", version: -1 }],
        appState: {},
        files: {},
        missingAssets: 0,
      },
      {
        ok: true,
        path: "a.excalidraw",
        objectId: "obj-1",
        elements: [],
        appState: {},
        files: {},
        missingAssets: -1,
      },
      { ok: false, refusal: "unknown" },
    ];
    for (const result of brokenPayloads) {
      server.on("POST", "/sync/ws-1/ops/readSketch", { status: 200, body: { ok: true, result } });
      await expect(readSketch(client, "ws-1", "a.excalidraw", signal)).rejects.toMatchObject({
        problem: "invalid",
      });
    }
  });
});
