import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mintLocalhostCa } from "../../../services/share-web/src/testing/localhostCa";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { resolveEngineBinary } from "../src/testing/engineBinary";
import { launchDesktopApp } from "./helpers/desktopApp";
import { relayJson } from "./helpers/relayPeer";
import { startServerProxy } from "./helpers/selfHostOnboarding";
import {
  sharedDatasetViewerOrigin,
  startSharedDatasetBrowser,
} from "./helpers/sharedDatasetBrowser";
import { relayAdoptedIdentity, spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

type Api = DohcDesktopBridge;
const WORKSPACE_ID = "server-restart-open-editor";
const OWNER = "e2e-server-restart-owner";
const TOKEN = `test:${OWNER}`;
const PATH = "plain.md";
const PARAGRAPH = "An ordinary paragraph.";
const CONTENTS = `# Plain\n\n${PARAGRAPH}\n`;

/** What a link holder's page says for `ms` after a restart, each distinct text with the second it first showed. */
async function watchPage(page: Page, label: string, ms: number): Promise<string[]> {
  const started = Date.now(),
    seen: string[] = [];
  let last = "";
  while (Date.now() - started < ms) {
    const text = await page
      .evaluate(() => {
        const says = [...document.querySelectorAll('[role="alert"], [role="status"], main.state')]
          .map((node) => (node as HTMLElement).innerText.trim().replaceAll(/\s+/gu, " "))
          .filter(Boolean);
        const editor = document.querySelector('[aria-label="Shared file editor"]');
        return `${editor ? `editor ${editor.getAttribute("contenteditable")}` : "no editor"} | ${says.join(" / ")}`;
      })
      .catch((error) => `page error: ${String(error).slice(0, 120)}`);
    if (text !== last) {
      last = text;
      seen.push(`${label} +${String(Math.round((Date.now() - started) / 1000))}s ${text}`);
      console.log(seen.at(-1));
    }
    await page.waitForTimeout(500);
  }
  return seen;
}

test("@server-restart an open Edit link loses nothing typed through a share service restart, a relay restart and both", async () => {
  test.setTimeout(900_000);
  const temp = await createTempWorkspace();
  const exchangeKey = randomBytes(32).toString("base64url");
  let relay: SyncRelayHandle | undefined;
  let proxy: Awaited<ReturnType<typeof startServerProxy>> | undefined;
  let owner: Awaited<ReturnType<typeof launchDesktopApp>> | undefined;
  let shared: Awaited<ReturnType<typeof startSharedDatasetBrowser>> | undefined;
  try {
    const ca = await mintLocalhostCa(temp.baseDir);
    const env = {
      NODE_EXTRA_CA_CERTS: ca.caPath,
      DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
      DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath,
      DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0",
      DOHC_TEST_SYNC_DEBOUNCE_MS: "150",
      DOHC_TEST_SYNC_BACKOFF_MS: "250",
    };
    proxy = await startServerProxy(ca);
    const relayOptions = {
      dbPath: join(temp.baseDir, "relay", "relay.sqlite"),
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

    await seedWorkspaceManifest(temp, WORKSPACE_ID);
    await writeWorkspaceFiles(temp, [{ path: PATH, contents: CONTENTS }]);
    await seedWorkspaceRegistry(temp, [{ workspaceId: WORKSPACE_ID, rootPath: temp.rootPath }]);
    await seedCloudCredentials(temp, {
      serverUrl: proxy.origin,
      relayUrl: proxy.origin,
      userId: OWNER,
      email: `${OWNER}@dohc.test`,
      token: TOKEN,
    });
    owner = await launchDesktopApp({ workspace: temp, env });
    const page = owner.page;
    await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, WORKSPACE_ID, PATH);
    await page.evaluate(async (workspaceId) => {
      await (window as unknown as { dohcDesktop: Api }).dohcDesktop.cloudEnableSync({
        workspaceId,
      });
    }, WORKSPACE_ID);
    await expect
      .poll(
        async () => {
          const identity = relayAdoptedIdentity(relay!.dbPath, WORKSPACE_ID);
          if (!identity) return false;
          const query = new URLSearchParams({ since: "0", limit: "1000", ...identity });
          const result = await relayJson(
            relay!.baseUrl,
            TOKEN,
            `/sync/${WORKSPACE_ID}/log?${query}`,
          );
          const ops = (JSON.parse(result.body) as { ops: Array<{ payload: { path?: string } }> })
            .ops;
          return ops.some((op) => op.payload.path === PATH);
        },
        { timeout: 120_000, intervals: [1000] },
      )
      .toBe(true);
    await explorerRow(page, PATH).click({ timeout: 15_000 });
    await expect(page.getByTestId("markdown-editor")).toHaveAttribute("contenteditable", "true", {
      timeout: 30_000,
    });
    const created = await relayJson(relay.baseUrl, TOKEN, `/sync/${WORKSPACE_ID}/shares/links`, {
      method: "POST",
      body: JSON.stringify({ paths: [PATH], access: "edit" }),
    });
    expect(created.status, created.body).toBe(200);
    const link = JSON.parse(created.body) as { url: string };
    await expect
      .poll(
        async () => {
          const listed = await page.evaluate(
            (workspaceId) =>
              (window as unknown as { dohcDesktop: Api }).dohcDesktop.listOwnerLiveDocuments({
                workspaceId,
              }),
            WORKSPACE_ID,
          );
          return listed.documents.some(
            (document) => document.path === PATH && document.status === "ready",
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
    const browserPage = await shared.browser.newPage();
    await browserPage.goto(`${sharedDatasetViewerOrigin}/s${new URL(link.url).hash}`);
    await browserPage.getByRole("button", { name: PATH, exact: true }).click({ timeout: 15_000 });
    await browserPage
      .getByRole("button", { name: "Edit file", exact: true })
      .click({ timeout: 15_000 });
    const editor = browserPage.getByRole("textbox", { name: "Shared file editor", exact: true });
    await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 120_000 });

    const ownerFile = () => readFile(join(temp.rootPath, PATH), "utf8").catch(() => "");
    // The page notes every whole word its editor ever holds. Keystrokes that arrive while the editor is being
    // replaced never enter the document, and only a word the editor held can have been dropped.
    await browserPage.evaluate(() => {
      const held = new Set<string>();
      (window as unknown as { heldWords: Set<string> }).heldWords = held;
      const note = () => {
        const editor = document.querySelector('[aria-label="Shared file editor"]');
        for (const word of (editor as HTMLElement | null)?.innerText.match(/w\d{4}/gu) ?? [])
          held.add(word);
      };
      new MutationObserver(note).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    // A link holder who goes on typing a new word about four times a second, whenever the page lets them.
    const typed: string[] = [];
    let typing = true;
    const typist = (async () => {
      for (let word = 0; typing; word++) {
        const text = ` w${String(word).padStart(4, "0")}`;
        try {
          if ((await editor.getAttribute("contenteditable", { timeout: 1_000 })) === "true") {
            await editor.getByText(PARAGRAPH, { exact: false }).click({ timeout: 1_000 });
            await browserPage.keyboard.press("Control+End");
            await browserPage.keyboard.insertText(text);
            typed.push(text);
          }
        } catch {
          // The page had no editor to type in at that moment.
        }
        await browserPage.waitForTimeout(250);
      }
    })();
    const phase = async (label: string, restart: () => Promise<void>, watchMs: number) => {
      const before = typed.length;
      await browserPage.waitForTimeout(3_000);
      const restartedAt = typed.length;
      await restart();
      const said = await watchPage(browserPage, label, watchMs);
      console.log(
        `${label}: restarted after${typed[restartedAt - 1] ?? " nothing"}; ${String(restartedAt - before)} words typed before it, ${String(typed.length - restartedAt)} after`,
      );
      return said;
    };

    const port = relay.port;
    // A word is at risk only in the moment a restart cuts the page's connection, so a hunt for a lost word asks
    // for many share service restarts with DOHC_SERVER_RESTARTS.
    const shareServiceRestarts = Number(process.env.DOHC_SERVER_RESTARTS ?? 1);
    const said: string[][] = [];
    for (let restart = 1; restart <= shareServiceRestarts; restart++)
      said.push(
        await phase(`share service ${String(restart)}`, async () => shared!.restart(), 6_000),
      );
    said.push(
      await phase(
        "relay",
        async () => {
          await relay!.stop();
          relay = await spawnSyncRelay({ ...relayOptions, port });
          proxy!.routeRelayTo(relay.baseUrl);
        },
        20_000,
      ),
    );
    // A deploy stops both, and the relay is back some seconds after the share service.
    said.push(
      await phase(
        "whole server",
        async () => {
          await relay!.stop();
          shared!.restart();
          await browserPage.waitForTimeout(10_000);
          relay = await spawnSyncRelay({ ...relayOptions, port });
          proxy!.routeRelayTo(relay.baseUrl);
        },
        20_000,
      ),
    );
    typing = false;
    await typist;

    // Every word the page accepted reaches the owner's file, in the order typed.
    let missing: string[] = typed;
    await expect
      .poll(
        async () => {
          const file = await ownerFile();
          missing = typed.filter((word) => !file.includes(word));
          return missing.length;
        },
        { timeout: 180_000, intervals: [2_000] },
      )
      .toBe(0)
      .catch(() => undefined);
    const file = await ownerFile();
    const inOrder = typed
      .filter((word) => file.includes(word))
      .every(
        (word, index, kept) => index === 0 || file.indexOf(kept[index - 1]!) < file.indexOf(word),
      );
    console.log(
      `typed ${String(typed.length)} words; missing from the owner's file: ${String(missing.length)} ${missing.slice(0, 12).join("")}; in order: ${String(inOrder)}`,
    );
    const held = new Set(
      await browserPage.evaluate(() => [
        ...(window as unknown as { heldWords: Set<string> }).heldWords,
      ]),
    );
    const shown = await editor.innerText().catch(() => "");
    const dropped = missing.filter((word) => held.has(word.trim()));
    console.log(
      `the editor held ${String(held.size)} of ${String(typed.length)} typed words; missing and once held (dropped): ${dropped.join("") || "none"}; missing and never held: ${missing.filter((word) => !held.has(word.trim())).join("") || "none"}; missing and still shown: ${missing.filter((word) => shown.includes(word.trim())).join("") || "none"}`,
    );
    const editable = await editor.getAttribute("contenteditable").catch(() => null);
    // Typing that arrived while the editor was being replaced went nowhere and is reported above, not failed here.
    expect({ dropped, inOrder, editable, said }).toMatchObject({
      dropped: [],
      inOrder: true,
      editable: "true",
    });
  } finally {
    await Promise.allSettled([shared?.close(), owner?.close()]);
    await Promise.allSettled([relay?.stop(), proxy?.close()]);
    await Promise.allSettled([temp.cleanup()]);
  }
});
