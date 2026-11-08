import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import { shareWebRequest, signInLinkAgent } from "./helpers/linkAgent";
import { claimRelayWorkspace } from "./helpers/relayPeer";
import { sharedDatasetViewerOrigin, startSharedDatasetBrowser } from "./helpers/sharedDatasetBrowser";
import { holdSystemClipboard } from "./helpers/systemClipboard";
import { relayAdoptedIdentity, spawnSyncRelay, type RelayWorkspaceIdentity, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// The standard MCP sign-in with the address Copy for an agent gives: an agent
// registers, a person allows it, and it calls tools with its token. The token
// survives a share-web restart, refreshes, works only at its own link, writes
// as the agent, and stops at Disconnect or a reused refresh token.
// The run holds a live link and tokens; no trace or failure screenshot keeps them.
test.use({ screenshot: "off", trace: "off" });

const OWNER = "e2e-link-owner";
const TOKEN = `test:${OWNER}`;
const WORKSPACE_ID = "share-link-agent-sign-in";
const PATH = "docs/plan.md";
const PLAN = "# Trip plan\n\nPack light.\n";
// Shared by a second link, so the agent has another link's address to try.
const OTHER_PATH = "docs/budget.md";
const COMMENT = "Booked the cabin for Friday.";

async function openLinkPane(page: Page, path: string): Promise<Locator> {
  await revealExplorerPath(page, path);
  await explorerRow(page, path).click({ button: "right" });
  const dialog = page.getByTestId("share-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: "Anyone with the link" }).click();
  return dialog;
}

async function closeDialog(dialog: Locator): Promise<void> {
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

// What share-web answers a token the relay refuses for this address:
// mcpChallenge(origin, secret, true), a 401 with no body.
async function expectInvalidToken(response: Response, address: string): Promise<void> {
  const { origin, pathname } = new URL(address);
  expect({ status: response.status, challenge: response.headers.get("www-authenticate"), body: await response.text() }).toEqual({
    status: 401,
    challenge: `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${pathname}", error="invalid_token"`,
    body: "",
  });
}

// The token endpoint's refusal of a refresh the relay will not grant, with
// share-web's own no-store on every answer.
async function expectInvalidGrant(response: Response): Promise<void> {
  expect({ status: response.status, cache: response.headers.get("cache-control"), body: await response.json() })
    .toEqual({ status: 400, cache: "private, no-store", body: { error: "invalid_grant" } });
}

test("@share-link-agent-sign-in an agent signs in to a share link, keeps working across a restart and a refresh, and stops at Disconnect", async () => {
  test.setTimeout(300_000);
  const temp = await createTempWorkspace();
  const relayExchangeKey = randomBytes(32).toString("base64url");
  let relay: SyncRelayHandle | null = null;
  let shared: Awaited<ReturnType<typeof startSharedDatasetBrowser>> | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, WORKSPACE_ID);
    await writeWorkspaceFiles(temp, [{ path: PATH, contents: PLAN }, { path: OTHER_PATH, contents: "# Budget\n\nCabin, 400.\n" }]);
    relay = await spawnSyncRelay({
      dbPath: join(temp.baseDir, "relay", "relay.sqlite"),
      linkBoundary: { linkKey: randomBytes(32).toString("base64url"), relayExchangeKey, publicViewerOrigin: sharedDatasetViewerOrigin },
    });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: TOKEN, workspaceId: WORKSPACE_ID });
    await seedWorkspaceRegistry(temp, [{ workspaceId: WORKSPACE_ID, rootPath: temp.rootPath, remote: { serverUrl: relay.baseUrl, ownerUserId: OWNER } }]);
    await seedCloudCredentials(temp, { serverUrl: relay.baseUrl, relayUrl: relay.baseUrl, email: `${OWNER}@dohc.test`, userId: OWNER, token: TOKEN });
    shared = await startSharedDatasetBrowser({ relayUrl: relay.baseUrl, exchangeKey: relayExchangeKey });
    const { handle } = shared;
    desktop = await launchDesktopApp({
      workspace: temp,
      env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250", DOHC_TEST_EXPLORER_MENU_CHOICE: "share" },
    });
    const { page } = desktop;
    await openWorkspaceFromFirstRun(page, temp);

    // A link shares what the relay holds, so both files reach it first.
    let identity: RelayWorkspaceIdentity | null = null;
    await expect.poll(async () => {
      identity ??= relayAdoptedIdentity(relay!.dbPath, WORKSPACE_ID);
      if (identity === null) return false;
      const query = new URLSearchParams({ since: "0", limit: "500", replicationEpoch: identity.replicationEpoch, streamIdentity: identity.streamIdentity });
      const response = await fetch(`${relay!.baseUrl}/sync/${encodeURIComponent(WORKSPACE_ID)}/log?${query.toString()}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      if (response.status === 409) identity = null;
      if (!response.ok) return false;
      const body = (await response.json()) as { ops: Array<{ payload?: { path?: string } }> };
      return [PATH, OTHER_PATH].every((path) => body.ops.some((op) => op.payload?.path === path));
    }, { timeout: 90_000, intervals: [1_000] }).toBe(true);

    // Another link, whose address this agent's token must not open.
    let dialog = await openLinkPane(page, OTHER_PATH);
    await dialog.getByRole("button", { name: "Create link", exact: true }).click();
    const otherUrl = new URL((await dialog.getByTestId("share-link-url").textContent()) ?? "");
    const otherAddress = `${otherUrl.origin}/mcp/s/${otherUrl.hash.slice(1)}`;
    await closeDialog(dialog);

    // The Comment link the agents use, and the address Copy for an agent gives.
    dialog = await openLinkPane(page, PATH);
    await dialog.getByRole("radiogroup", { name: "Link access" }).getByRole("radio", { name: "Comment", exact: true }).click();
    await dialog.getByRole("button", { name: "Create link", exact: true }).click();
    const linkUrl = new URL((await dialog.getByTestId("share-link-url").textContent()) ?? "");
    expect(linkUrl.origin).toBe(sharedDatasetViewerOrigin);
    const secret = linkUrl.hash.slice(1);
    const address = await holdSystemClipboard(test.info(), async (remainingMs) => {
      const copy = dialog.getByTestId("share-link-agent-copy");
      await copy.click({ timeout: remainingMs() });
      await expect(copy).toHaveText("Copied", { timeout: remainingMs() });
      return desktop!.app.evaluate(({ clipboard }) => clipboard.readText());
    });
    expect(address).toBe(`${sharedDatasetViewerOrigin}/mcp/s/${secret}`);
    await closeDialog(dialog);

    // 1. Register, consent, token, and a tool call: the agent reads the
    // linked file, and only it.
    const claude = await signInLinkAgent({ handle, browser: shared.browser, address, clientName: "Claude Code" });
    const codex = await signInLinkAgent({ handle, browser: shared.browser, address, clientName: "Codex" });
    const listed = await claude.tool("dohc_list_files");
    expect(listed.status).toBe(200);
    const files = (listed.result?.files ?? []) as Array<{ path: string; blobSha256: string }>;
    expect(files.map((file) => file.path)).toEqual([expect.stringMatching(/(^|\/)plan\.md$/u)]);
    expect(await claude.tool("dohc_read_file", { blobSha256: files[0]!.blobSha256 }))
      .toMatchObject({ status: 200, result: { ok: true, encoding: "utf8", content: expect.stringContaining("Pack light.") } });
    expect((await codex.tool("dohc_share_status")).status).toBe(200);

    // 3. A share-web restart keeps no state an agent needs: the relay holds it.
    shared.restart();
    expect(await claude.tool("dohc_list_files")).toMatchObject({ status: 200, result: { ok: true } });

    // 4. A wrong resource: the token is refused at another link's address,
    // and so is a refresh naming it. Neither ends the agent's connection.
    await expectInvalidToken(await shareWebRequest(handle, otherAddress, {
      method: "POST",
      headers: { authorization: `Bearer ${claude.accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }), otherAddress);
    await expectInvalidGrant(await claude.refresh(claude.refreshToken!, otherAddress));
    expect((await claude.tool("dohc_share_status")).status).toBe(200);

    // 6. Agent authorship: the post is the agent's, under the name its client
    // reported, as a link author the owner can block.
    expect(await claude.tool("dohc_post_discussion", { body: COMMENT, idempotencyKey: "agent-sign-in-e2e" }))
      .toMatchObject({ status: 200, result: { ok: true } });
    dialog = await openLinkPane(page, PATH);
    await dialog.getByRole("button", { name: "Comments", exact: true }).click();
    const comment = dialog.locator("[data-comment-message-id]").filter({ hasText: COMMENT });
    await expect(comment).toContainText("Claude Code");
    await expect(comment).toContainText("Unverified");
    await expect(comment.getByRole("button", { name: "Block", exact: true })).toBeVisible();

    // The link's Agents list names both, and the post is Claude Code's last action.
    const agents = dialog.getByRole("region", { name: "Agents" });
    await expect(agents.getByRole("listitem")).toHaveCount(2);
    await expect(agents.getByRole("listitem").filter({ hasText: "Claude Code" })).toContainText("Last action");

    // 5. Disconnect from the list: that agent's next call gets the challenge,
    // and the other agent keeps working.
    await agents.getByRole("button", { name: "Disconnect Codex" }).click();
    await expect(agents.getByRole("listitem")).toHaveCount(1);
    await expect(agents).not.toContainText("Codex");
    await expectInvalidToken(await codex.rpc("tools/list"), address);
    expect((await claude.rpc("tools/list")).status).toBe(200);
    await closeDialog(dialog);

    // 2. Refresh: a new token pair that works. Reusing the spent refresh
    // token is refused and ends the connection, new tokens included.
    const refreshed = await claude.refresh(claude.refreshToken!);
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; token_type: string; refresh_token: string };
    expect(next.token_type).toBe("Bearer");
    expect(next.access_token).not.toBe(claude.accessToken);
    expect(next.refresh_token).not.toBe(claude.refreshToken);
    expect((await claude.tool("dohc_share_status", {}, next.access_token)).status).toBe(200);
    await expectInvalidGrant(await claude.refresh(claude.refreshToken!));
    await expectInvalidToken(await claude.rpc("tools/list", undefined, next.access_token), address);
    await expectInvalidGrant(await claude.refresh(next.refresh_token));

    // The address carries the link's secret, so no log holds it.
    expect(desktop.logs.filter((entry) => entry.text.includes(secret))).toEqual([]);
    expect(shared.failures).toEqual([]);
  } finally {
    try { await shared?.close(); } finally {
      try { await relay?.stop(); } finally { await cleanupDesktopWorkspace(desktop, temp); }
    }
  }
});
