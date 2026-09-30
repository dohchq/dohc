import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { resolveEngineBinary } from "../src/testing/engineBinary";
import { launchDesktopApp } from "./helpers/desktopApp";
import { relayJson } from "./helpers/relayPeer";
import { sharedDatasetViewerOrigin, startSharedDatasetBrowser } from "./helpers/sharedDatasetBrowser";
import { relayAdoptedIdentity, spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// The direct lane through an Edit share link (ADR 0013), with a real owner
// desktop, relay, share-web, and browser. A person opens the link in a
// browser and edits the Collection's schema in the viewer; an agent given the
// same link replaces its automations over MCP. Neither has an account. The
// owner's disk gets both, and History names the link. Stop and restore ends
// the link and puts both files back, Undo returns the content without the
// access, and both the browser and the agent are refused after that.

const OWNER_TOKEN = "test:e2e-link-owner";
const OWNER_USER = "e2e-link-owner";
const OWNER_EMAIL = "e2e-link-owner@dohc.test";
const WORKSPACE_ID = "link-lane-owner";
const SCHEMA_PATH = "trip/packing/collection.yaml";
const AUTOMATIONS_PATH = "trip/packing/automations.yaml";
const SCHEMA = "name: Packing\nfields:\n  Title:\n    type: text\n";
const SCHEMA_BROWSER = "name: Packing\nfields:\n  Title:\n    type: text\n  Count:\n    type: number\n";
const automations = (title: string) =>
  `version: 1\nautomations:\n  - id: stamp\n    name: Stamp\n    when: record-added\n    do:\n      - set:\n          Title: ${title}\n`;
const AUTOMATIONS = automations("Packed");
const AUTOMATIONS_AGENT = automations("Packed by the agent");

type Api = DohcDesktopBridge;
type LogOp = { originId: string; opKind: string; payload: Record<string, unknown> };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function ownerLog(relay: SyncRelayHandle): Promise<LogOp[]> {
  const identity = relayAdoptedIdentity(relay.dbPath, WORKSPACE_ID);
  const query = new URLSearchParams({ since: "0", limit: "1000", ...(identity ?? {}) });
  const read = await relayJson(relay.baseUrl, OWNER_TOKEN, `/sync/${WORKSPACE_ID}/log?${query.toString()}`);
  expect(read.status, read.body).toBe(200);
  return (JSON.parse(read.body) as { ops: LogOp[] }).ops;
}

/** One MCP tool call, as an agent sends it with only the link's bearer. */
async function callTool(handle: (request: Request) => Promise<Response>, bearer: string, name: string, args: Record<string, unknown>) {
  const response = await handle(new Request(`${sharedDatasetViewerOrigin}/mcp`, {
    method: "POST",
    headers: { host: new URL(sharedDatasetViewerOrigin).host, authorization: `Bearer ${bearer}`,
      "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }));
  if (!response.ok) return { status: response.status, result: null };
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  const message = JSON.parse(data!.slice("data: ".length)) as { result: { structuredContent?: Record<string, unknown> } };
  return { status: response.status, result: message.result.structuredContent ?? null };
}

test("@link-lane a browser and an agent change a Collection through an Edit link, and Stop and restore ends the link", async () => {
  test.setTimeout(420_000);
  const ownerTemp = await createTempWorkspace();
  const exchangeKey = randomBytes(32).toString("base64url");
  let relay: SyncRelayHandle | null = null;
  let owner: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let shared: Awaited<ReturnType<typeof startSharedDatasetBrowser>> | null = null;
  let nudge = 0;
  // An idle owner pulls on its own sync cadence; a throwaway write wakes it.
  const wakeOwner = async () => {
    nudge += 1;
    await writeFile(join(ownerTemp.rootPath, `sync-nudge-${nudge}.md`), `nudge ${nudge}\n`);
  };

  try {
    // Edit links are released on a relay deployed the self-hosted way.
    relay = await spawnSyncRelay({ dbPath: join(ownerTemp.baseDir, "relay", "relay.sqlite"), editLinks: { engineExecutable: resolveEngineBinary() },
      linkBoundary: { linkKey: randomBytes(32).toString("base64url"), relayExchangeKey: exchangeKey, publicViewerOrigin: sharedDatasetViewerOrigin } });

    // --- The owner's synced workspace holds a Collection -------------------
    await seedWorkspaceManifest(ownerTemp, WORKSPACE_ID);
    await writeWorkspaceFiles(ownerTemp, [
      { path: SCHEMA_PATH, contents: SCHEMA },
      { path: AUTOMATIONS_PATH, contents: AUTOMATIONS },
      { path: "private/ledger.md", contents: "The kraken ledger stays private.\n" },
    ]);
    await seedWorkspaceRegistry(ownerTemp, [{ workspaceId: WORKSPACE_ID, rootPath: ownerTemp.rootPath }]);
    await seedCloudCredentials(ownerTemp, {
      serverUrl: relay.baseUrl, relayUrl: relay.baseUrl, email: OWNER_EMAIL, userId: OWNER_USER, token: OWNER_TOKEN,
    });
    owner = await launchDesktopApp({ workspace: ownerTemp, env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" } });
    await openWorkspaceFromFirstRun(owner.page, ownerTemp);
    expect(await owner.page.evaluate(async (workspaceId) => {
      const api = (window as unknown as { dohcDesktop: Api }).dohcDesktop;
      try { await api.cloudEnableSync({ workspaceId }); return "enabled"; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    }, WORKSPACE_ID)).toBe("enabled");
    await expect.poll(async () => (await ownerLog(relay!)).some((op) => op.payload.path === AUTOMATIONS_PATH),
      { timeout: 60_000, intervals: [1_000] }).toBe(true);

    // --- The owner makes an Edit link to the trip folder --------------------
    const created = await relayJson(relay.baseUrl, OWNER_TOKEN, `/sync/${WORKSPACE_ID}/shares/links`, {
      method: "POST", body: JSON.stringify({ paths: ["trip"], access: "edit" }),
    });
    expect(created.status, created.body).toBe(200);
    const link = JSON.parse(created.body) as { url: string; grantId: string };
    const secret = new URL(link.url).hash.slice(1);
    shared = await startSharedDatasetBrowser({ relayUrl: relay.baseUrl, exchangeKey, editLinks: true });

    // --- A person edits the schema in the viewer, with no account ------------
    const page = await shared.browser.newPage();
    await page.goto(`${sharedDatasetViewerOrigin}/s#${secret}`);
    await page.getByRole("button", { name: "collection.yaml", exact: true }).click();
    await page.getByRole("button", { name: "Edit file" }).click();
    const editor = page.getByRole("textbox", { name: SCHEMA_PATH });
    await expect(editor).toHaveValue(SCHEMA);
    await editor.fill(SCHEMA_BROWSER);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved to the owner's workspace.")).toBeVisible();

    // --- An agent given the same link replaces the automations --------------
    const exchanged = await shared.handle(new Request(`${sharedDatasetViewerOrigin}/api/mcp/exchange`, {
      method: "POST", headers: { host: new URL(sharedDatasetViewerOrigin).host, "content-type": "application/json" }, body: JSON.stringify({ secret }),
    }));
    const { bearer } = await exchanged.json() as { bearer: string };
    expect(await callTool(shared.handle, bearer, "dohc_write_collection_files", {
      submitId: "agent-automations", files: [{ path: AUTOMATIONS_PATH, basedOnBlobSha256: sha256(AUTOMATIONS), text: AUTOMATIONS_AGENT }],
    })).toEqual({ status: 200, result: { ok: true, outcome: "accepted", submitId: "agent-automations" } });

    // --- Both are written as the link, never as a person --------------------
    const direct = (await ownerLog(relay)).filter((op) => op.originId === `relay:collection-file:${link.grantId}`);
    expect(direct.map((op) => op.payload.path)).toEqual([SCHEMA_PATH, AUTOMATIONS_PATH]);
    for (const op of direct) {
      expect((op.payload.authors as unknown[])[0]).toEqual({ kind: "link", grantId: link.grantId, grantGeneration: 1, principalId: expect.any(String) });
    }

    // --- The owner's disk has both, and History names the link --------------
    await expect.poll(async () => {
      await wakeOwner();
      return [await readFile(join(ownerTemp.rootPath, SCHEMA_PATH), "utf8"), await readFile(join(ownerTemp.rootPath, AUTOMATIONS_PATH), "utf8")];
    }, { timeout: 120_000, intervals: [2_000] }).toEqual([SCHEMA_BROWSER, AUTOMATIONS_AGENT]);
    await expect.poll(async () => await owner!.page.evaluate(async (workspaceId) => {
      const api = (window as unknown as { dohcDesktop: Api }).dohcDesktop;
      const listed = await api.listEngineMoments({ workspaceId, limit: 100 });
      if (!("moments" in listed)) return [];
      return listed.moments.filter((moment) => moment.linkAuthor).map((moment) => [moment.path, moment.linkAuthor!.grantId]);
    }, WORKSPACE_ID), { timeout: 60_000, intervals: [2_000] })
      .toEqual(expect.arrayContaining([[SCHEMA_PATH, link.grantId], [AUTOMATIONS_PATH, link.grantId]]));

    // --- Stop and restore ends the link and puts both files back -------------
    let outcome: Awaited<ReturnType<Api["stopAndRestore"]>> | null = null;
    await expect.poll(async () => {
      await wakeOwner();
      outcome = await owner!.page.evaluate(async ({ workspaceId, grantId }) => {
        const api = (window as unknown as { dohcDesktop: Api }).dohcDesktop;
        return await api.stopAndRestore({ workspaceId, target: { kind: "link", grantId } });
      }, { workspaceId: WORKSPACE_ID, grantId: link.grantId });
      return outcome.status;
    }, { timeout: 120_000, intervals: [2_000] }).toBe("restored");
    expect(outcome).toMatchObject({ review: [], errorMessage: null });
    // Automations go back first.
    const restored = (outcome as unknown as { restored: Array<{ path: string; restoredMomentId: string }> }).restored;
    expect(restored.map((file) => file.path)).toEqual([AUTOMATIONS_PATH, SCHEMA_PATH]);
    expect(await readFile(join(ownerTemp.rootPath, SCHEMA_PATH), "utf8")).toBe(SCHEMA);
    expect(await readFile(join(ownerTemp.rootPath, AUTOMATIONS_PATH), "utf8")).toBe(AUTOMATIONS);
    const links = await relayJson(relay.baseUrl, OWNER_TOKEN, `/sync/${WORKSPACE_ID}/shares/links`);
    expect((JSON.parse(links.body) as { links: Array<{ grantId: string; status: string }> }).links
      .find((row) => row.grantId === link.grantId)?.status).toBe("revoked");

    // --- Undo returns the content, never the access -------------------------
    await owner.page.evaluate(async (input) => {
      const api = (window as unknown as { dohcDesktop: Api }).dohcDesktop;
      await api.undoStopAndRestore(input);
    }, { workspaceId: WORKSPACE_ID, restoredMomentIds: restored.map((file) => file.restoredMomentId) });
    await expect.poll(async () => [await readFile(join(ownerTemp.rootPath, SCHEMA_PATH), "utf8"), await readFile(join(ownerTemp.rootPath, AUTOMATIONS_PATH), "utf8")],
      { timeout: 30_000, intervals: [500] }).toEqual([SCHEMA_BROWSER, AUTOMATIONS_AGENT]);
    const linksAfterUndo = await relayJson(relay.baseUrl, OWNER_TOKEN, `/sync/${WORKSPACE_ID}/shares/links`);
    expect((JSON.parse(linksAfterUndo.body) as { links: Array<{ grantId: string; status: string }> }).links
      .find((row) => row.grantId === link.grantId)?.status).toBe("revoked");

    // --- The browser and the agent are both refused now -----------------------
    // The open viewer finds the link ended and stops offering Save.
    await expect(page.getByText("Editing is no longer available.")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    // A write sent from the page anyway is refused.
    expect(await page.evaluate(async ({ path, base, text }) => {
      const session = location.pathname.split("/")[2]!;
      const response = await fetch("/api/view/collection-writes", { method: "POST", credentials: "same-origin",
        headers: { "x-dohc-link-session": session, "content-type": "application/json" },
        body: JSON.stringify({ submitId: "browser-after-stop", changes: [{ basedOnPath: path, basedOnBlobSha256: base, operation: "write",
          afterPath: path, afterContentKind: "text", afterContentBase64: btoa(text), recordedAtMs: Date.now() }] }) });
      return response.status;
    }, { path: SCHEMA_PATH, base: sha256(SCHEMA_BROWSER), text: SCHEMA })).toBe(404);
    expect(await callTool(shared.handle, bearer, "dohc_write_collection_files", {
      submitId: "agent-after-stop", files: [{ path: AUTOMATIONS_PATH, basedOnBlobSha256: sha256(AUTOMATIONS_AGENT), text: AUTOMATIONS }],
    })).toEqual({ status: 404, result: null });
    const ledger = await relayJson(relay.baseUrl, OWNER_TOKEN, `/sync/${WORKSPACE_ID}/collection-writes/${link.grantId}`);
    expect((JSON.parse(ledger.body) as { writes: unknown[] }).writes).toHaveLength(2);
  } finally {
    try { await shared?.close(); } catch (error) { console.error("Browser cleanup failed:", error); }
    try { await owner?.close(); } catch (error) { console.error("Owner cleanup failed:", error); }
    try { await relay?.stop(); } catch (error) { console.error("Relay cleanup failed:", error); }
    try { await ownerTemp.cleanup(); } catch (error) { console.error("Owner workspace cleanup failed:", error); }
  }
});
