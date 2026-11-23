import { expect, type Locator, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { mintLocalhostCa } from "../../../../services/share-web/src/testing/localhostCa";
import type { DohcDesktopBridge } from "../../src/ipc/bridgeContract";
import { resolveEngineBinary } from "../../src/testing/engineBinary";
import { launchDesktopApp } from "./desktopApp";
import { relayJson } from "./relayPeer";
import { startServerProxy } from "./selfHostOnboarding";
import { sharedDatasetViewerOrigin, startSharedDatasetBrowser } from "./sharedDatasetBrowser";
import { relayAdoptedIdentity, spawnSyncRelay, type SyncRelayHandle } from "./syncRelay";
import {
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./workspace";

type Api = DohcDesktopBridge;

/** A self-hosted server with its owner's desktop and one link holder, both with the same note open to edit. */
export interface EditLinkServer {
  /** The running relay. A restart replaces it. */
  relay(): SyncRelayHandle;
  /** The owner's workspace folder on their computer. */
  workspaceRoot: string;
  /** The owner's desktop window, with the note open. */
  ownerPage: Page;
  /** The link holder's page. */
  linkPage: Page;
  /** The link holder's editor, ready to type in. */
  editor: Locator;
  /** The paths of the workspace's files that the server holds. */
  filesOnServer(): Promise<Set<string>>;
  /** A new share service behind the same address, as after its restart. */
  restartShareService(): void;
  /** The share service gone for `ms`, then a new one behind the same address. */
  restartShareServiceAfter(ms: number): Promise<void>;
  /** Stops the relay and starts it again on the same port. `whileDown` runs between the two. */
  restartRelay(whileDown?: () => Promise<void>): Promise<void>;
  quitDesktop(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Starts a relay with live editing and a share service, syncs a workspace from the owner's desktop, and opens
 * `path` for editing on the desktop and through an Edit link in a browser.
 */
export async function openEditLinkOnServer(input: {
  workspaceId: string;
  owner: string;
  /** The note both people open. */
  path: string;
  /**
   * More notes the Edit link covers. The owner opens each one first, since the server hosts a linked note only
   * once its owner's desktop has taken it live.
   */
  alsoLinked?: string[];
  files: Array<{ path: string; contents: string }>;
  /** Added to the desktop's and the relay engine's environment. */
  env?: Record<string, string>;
  /** The relay's built entry file. Without it the relay runs from source. */
  compiledRelayMain?: string;
}): Promise<EditLinkServer> {
  const { workspaceId, path } = input;
  const token = `test:${input.owner}`;
  const temp = await createTempWorkspace();
  const exchangeKey = randomBytes(32).toString("base64url");
  let relay: SyncRelayHandle | undefined;
  let proxy: Awaited<ReturnType<typeof startServerProxy>> | undefined;
  let owner: Awaited<ReturnType<typeof launchDesktopApp>> | undefined;
  let shared: Awaited<ReturnType<typeof startSharedDatasetBrowser>> | undefined;
  const close = async () => {
    await Promise.allSettled([shared?.close(), owner?.close()]);
    await Promise.allSettled([relay?.stop(), proxy?.close()]);
    await Promise.allSettled([temp.cleanup()]);
  };
  try {
    const ca = await mintLocalhostCa(temp.baseDir);
    const env = {
      NODE_EXTRA_CA_CERTS: ca.caPath,
      DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
      DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath,
      DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0",
      ...input.env,
    };
    proxy = await startServerProxy(ca);
    const relayOptions = {
      dbPath: join(temp.baseDir, "relay", "relay.sqlite"),
      ...(input.compiledRelayMain ? { compiledMain: input.compiledRelayMain } : {}),
      editLinks: {
        engineExecutable: resolveEngineBinary(),
        publicOrigin: proxy.origin,
        trustEnv: env,
      },
      linkBoundary: {
        linkKey: randomBytes(32).toString("base64url"),
        relayExchangeKey: exchangeKey,
        publicViewerOrigin: sharedDatasetViewerOrigin,
      },
    };
    relay = await spawnSyncRelay(relayOptions);
    proxy.routeRelayTo(relay.baseUrl);

    await seedWorkspaceManifest(temp, workspaceId);
    await writeWorkspaceFiles(temp, input.files);
    await seedWorkspaceRegistry(temp, [{ workspaceId, rootPath: temp.rootPath }]);
    await seedCloudCredentials(temp, {
      serverUrl: proxy.origin,
      relayUrl: proxy.origin,
      userId: input.owner,
      email: `${input.owner}@dohc.test`,
      token,
    });
    owner = await launchDesktopApp({ workspace: temp, env });
    const ownerPage = owner.page;
    await openWorkspaceFromFirstRun(ownerPage, temp);
    await waitForWorkspaceFile(ownerPage, workspaceId, path);
    await ownerPage.evaluate(async (id) => {
      await (window as unknown as { dohcDesktop: Api }).dohcDesktop.cloudEnableSync({
        workspaceId: id,
      });
    }, workspaceId);
    const pathsOnServer = async () => {
      const identity = relayAdoptedIdentity(relay!.dbPath, workspaceId);
      if (!identity) return new Set<string>();
      const query = new URLSearchParams({ since: "0", limit: "1000", ...identity });
      const result = await relayJson(relay!.baseUrl, token, `/sync/${workspaceId}/log?${query}`);
      const ops = (JSON.parse(result.body) as { ops: Array<{ payload: { path?: string } }> }).ops;
      return new Set(ops.flatMap((op) => op.payload.path ?? []));
    };
    await expect
      .poll(async () => (await pathsOnServer()).has(path), { timeout: 120_000, intervals: [1000] })
      .toBe(true);
    await explorerRow(ownerPage, path).click({ timeout: 15_000 });
    await expect(ownerPage.getByTestId("markdown-editor")).toHaveAttribute(
      "contenteditable",
      "true",
      { timeout: 30_000 },
    );
    const editable = () =>
      expect(ownerPage.getByTestId("markdown-editor")).toHaveAttribute("contenteditable", "true", {
        timeout: 30_000,
      });
    for (const other of input.alsoLinked ?? []) {
      await expect
        .poll(async () => (await pathsOnServer()).has(other), { timeout: 120_000 })
        .toBe(true);
      await explorerRow(ownerPage, other).click({ timeout: 15_000 });
      await editable();
    }
    if (input.alsoLinked?.length) {
      await explorerRow(ownerPage, path).click({ timeout: 15_000 });
      await editable();
    }
    const created = await relayJson(relay.baseUrl, token, `/sync/${workspaceId}/shares/links`, {
      method: "POST",
      body: JSON.stringify({ paths: [path, ...(input.alsoLinked ?? [])], access: "edit" }),
    });
    expect(created.status, created.body).toBe(200);
    const link = JSON.parse(created.body) as { url: string };
    await expect
      .poll(
        async () => {
          const listed = await ownerPage.evaluate(
            (id) =>
              (window as unknown as { dohcDesktop: Api }).dohcDesktop.listOwnerLiveDocuments({
                workspaceId: id,
              }),
            workspaceId,
          );
          return [path, ...(input.alsoLinked ?? [])].every((linked) =>
            listed.documents.some(
              (document) => document.path === linked && document.status === "ready",
            ),
          );
        },
        { timeout: 180_000, intervals: [1000] },
      )
      .toBe(true);

    shared = await startSharedDatasetBrowser({
      relayUrl: relay.baseUrl,
      exchangeKey,
      editLinks: true,
    });
    const linkPage = await shared.browser.newPage();
    await linkPage.goto(`${sharedDatasetViewerOrigin}/s${new URL(link.url).hash}`);
    await linkPage.getByRole("button", { name: path, exact: true }).click({ timeout: 15_000 });
    await linkPage.getByRole("button", { name: "Edit file", exact: true }).click({
      timeout: 15_000,
    });
    const editor = linkPage.getByRole("textbox", { name: "Shared file editor", exact: true });
    await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 120_000 });

    return {
      relay: () => relay!,
      workspaceRoot: temp.rootPath,
      ownerPage,
      linkPage,
      editor,
      filesOnServer: pathsOnServer,
      restartShareService: () => shared!.restart(),
      restartShareServiceAfter: (ms) => shared!.restartAfter(ms),
      async restartRelay(whileDown) {
        const port = relay!.port;
        await relay!.stop();
        await whileDown?.();
        relay = await spawnSyncRelay({ ...relayOptions, port });
        proxy!.routeRelayTo(relay.baseUrl);
      },
      async quitDesktop() {
        await owner?.close();
        owner = undefined;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
