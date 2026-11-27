import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GUIDE_TEXT } from "./guides";
import { createDohcMcpServer } from "./server";
import { DECLARED_TOOLS, DECLARED_WRITE_TOOLS, type ToolContext } from "./tools";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function workspace(registered: boolean) {
  const folder = await mkdtemp(join(tmpdir(), "dohc-mcp-onboarding-"));
  folders.push(folder);
  const root = join(folder, "Trip planner");
  const workspaces = registered ? [{ workspaceId: "ws-trip", rootPath: root, kind: "local" }] : [];
  await writeFile(join(folder, "dohc-workspaces.json"), JSON.stringify({ version: 1, workspaces }));
  return { root, home: folder };
}

async function connect(ctx: ToolContext) {
  const server = createDohcMcpServer(ctx);
  const client = new Client({ name: "onboarding-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP onboarding", () => {
  it("names the guides in its instructions and serves each one", async () => {
    const client = await connect(await workspace(true));
    const instructions = client.getInstructions() ?? "";
    const { resources } = await client.listResources();
    const uris = resources.map((resource) => resource.uri);
    expect(uris).toEqual(expect.arrayContaining(["dohc://workspace/info"]));
    for (const [name, text] of Object.entries(GUIDE_TEXT)) {
      const uri = `dohc://guides/${name}`;
      expect(instructions).toContain(uri);
      expect(uris).toContain(uri);
      const { contents } = await client.readResource({ uri });
      expect(contents).toEqual([{ uri, mimeType: "text/markdown", text }]);
      expect(text.length).toBeGreaterThan(1000);
    }
  });

  it("describes the served workspace from the registry", async () => {
    const ctx = { ...(await workspace(true)), shareAccess: "edit" as const };
    const client = await connect(ctx);
    const { contents } = await client.readResource({ uri: "dohc://workspace/info" });
    expect(JSON.parse(String((contents[0] as { text?: string }).text))).toEqual({
      workspaceId: "ws-trip",
      name: "Trip planner",
      rootPath: ctx.root,
      shareAccess: "edit",
    });
  });
});

describe("tool annotations", () => {
  it.each([undefined, "view", "comment", "edit"] as const)(
    "gives every tool all four hints at %s",
    async (shareAccess) => {
      const client = await connect({ root: "/a", home: "/b", shareAccess });
      const { tools } = await client.listTools();
      const declaredReads = new Set<string>(Object.keys(DECLARED_TOOLS));
      const declaredWrites = new Set<string>(Object.keys(DECLARED_WRITE_TOOLS));
      for (const { name, annotations } of tools) {
        for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"])
          expect(typeof annotations?.[hint as keyof typeof annotations], `${name} ${hint}`).toBe(
            "boolean",
          );
        if (declaredReads.has(name)) expect(annotations?.readOnlyHint, name).toBe(true);
        if (declaredWrites.has(name)) expect(annotations?.readOnlyHint, name).toBe(false);
        if (annotations?.readOnlyHint) expect(annotations.destructiveHint, name).toBe(false);
      }
      const mixed = tools.filter(({ name }) =>
        [
          "dohc_dataset",
          "dohc_collection_access",
          "dohc_publish_app",
          "dohc_members",
          "dohc_held_note_change",
        ].includes(name),
      );
      expect(mixed.length).toBeGreaterThan(0);
      for (const { name, annotations } of mixed)
        expect(annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    },
  );
});

describe("served workspace id", () => {
  const datasetPath = "trip/dataset.json";

  it("fills in workspaceId for dohc_dataset and dohc_publish_app and keeps one the agent gives", async () => {
    const send = vi.fn(async (_request: unknown) => ({ ok: false }));
    const client = await connect({ ...(await workspace(true)), request: send });
    await client.callTool({
      name: "dohc_dataset",
      arguments: { request: { action: "describe", datasetPath } },
    });
    await client.callTool({
      name: "dohc_dataset",
      arguments: { request: { action: "describe", workspaceId: "ws-other", datasetPath } },
    });
    await client.callTool({
      name: "dohc_publish_app",
      arguments: { request: { action: "personalFolder" } },
    });
    expect(
      send.mock.calls.map(([request]) => (request as { args: { request: unknown } }).args.request),
    ).toEqual([
      { action: "describe", workspaceId: "ws-trip", datasetPath },
      { action: "describe", workspaceId: "ws-other", datasetPath },
      { action: "personalFolder", workspaceId: "ws-trip" },
    ]);
  });

  it("refuses before the desktop when the folder is not a registered workspace", async () => {
    const send = vi.fn();
    const client = await connect({ ...(await workspace(false)), request: send });
    const result = await client.callTool({
      name: "dohc_dataset",
      arguments: { request: { action: "describe", datasetPath } },
    });
    expect(result.isError).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("still states datasetPath once in the tool description", async () => {
    const client = await connect({ root: "/a", home: "/b" });
    const { tools } = await client.listTools();
    const dataset = tools.find(({ name }) => name === "dohc_dataset")!;
    expect(dataset.description).toContain("datasetPath");
    expect(JSON.stringify(dataset.inputSchema)).not.toContain("Caller-relative");
  });
});
