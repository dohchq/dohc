import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mintLocalhostCa } from "../../../services/share-web/src/testing/localhostCa";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { resolveEngineBinary } from "../src/testing/engineBinary";
import { launchDesktopApp } from "./helpers/desktopApp";
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
import { caretSettles, editor as sharedEditor } from "./together/people";
import { relayStoredFile } from "./together/stack";

type Api = DohcDesktopBridge;
const WORKSPACE_ID = "body-sequence-live";
const OWNER = "e2e-body-sequence-live-owner";
const TOKEN = `test:${OWNER}`;
const formatTwo = { DOHC_ENGINE_NOTE_BODY_SEQUENCE: "1", DOHC_ENGINE_NEW_NOTE_BODY_SEQUENCE: "1" };
const NOTES = {
  joinSame: ["aa", "bb"],
  joinSplit: ["one", "twothree"],
  splitSame: ["abcd"],
  joinType: ["a", "bc"],
  joinChain: ["pp", "kk", "ll"],
};
type Note = keyof typeof NOTES;
const pathOf = (note: Note) => `${note}.md`;

type Person = { context: BrowserContext; page: Page };
const paragraphs = (root: ReturnType<Page["locator"]>) =>
  root
    .locator("p")
    .allInnerTexts()
    .then((texts) => texts.map((text) => text.replace(/\s+/gu, " ").trim()));

test("@body-sequence-live an owner's desktop and two share pages join and split lines of one format-2 note through a relay deployed the self-hosted way", async () => {
  test.setTimeout(900_000);
  const temp = await createTempWorkspace();
  const exchangeKey = randomBytes(32).toString("base64url");
  const closers: Array<() => Promise<unknown>> = [];
  try {
    const ca = await mintLocalhostCa(temp.baseDir);
    const env = {
      NODE_EXTRA_CA_CERTS: ca.caPath,
      DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
      DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath,
      DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0",
      DOHC_TEST_SYNC_DEBOUNCE_MS: "150",
      DOHC_TEST_SYNC_BACKOFF_MS: "250",
      ...formatTwo,
    };
    const proxy = await startServerProxy(ca);
    closers.push(() => proxy.close());
    const relay: SyncRelayHandle = await spawnSyncRelay({
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
      env: { DOHC_RELAY_BODY_SEQUENCE_NOTES: "1", ...formatTwo },
    });
    closers.push(() => relay.stop());
    proxy.routeRelayTo(relay.baseUrl);

    await seedWorkspaceManifest(temp, WORKSPACE_ID);
    await writeWorkspaceFiles(
      temp,
      Object.entries(NOTES).map(([note, lines]) => ({
        path: pathOf(note as Note),
        contents: `${lines.join("\n\n")}\n`,
      })),
    );
    await seedWorkspaceRegistry(temp, [{ workspaceId: WORKSPACE_ID, rootPath: temp.rootPath }]);
    await seedCloudCredentials(temp, {
      serverUrl: proxy.origin,
      relayUrl: proxy.origin,
      userId: OWNER,
      email: `${OWNER}@dohc.test`,
      token: TOKEN,
    });
    const owner = await launchDesktopApp({ workspace: temp, env });
    closers.push(() => owner.close());
    const desk = owner.page;
    const ownerEditor = desk.getByTestId("markdown-editor").filter({ visible: true });
    await openWorkspaceFromFirstRun(desk, temp);
    const notes = Object.keys(NOTES) as Note[];
    for (const note of notes) await waitForWorkspaceFile(desk, WORKSPACE_ID, pathOf(note));
    await desk.evaluate(
      (workspaceId) =>
        (window as unknown as { dohcDesktop: Api }).dohcDesktop.cloudEnableSync({ workspaceId }),
      WORKSPACE_ID,
    );
    await expect
      .poll(() => relayAdoptedIdentity(relay.dbPath, WORKSPACE_ID) !== null, { timeout: 120_000 })
      .toBe(true);
    for (const note of notes) {
      await expect
        .poll(() => relayStoredFile(relay, WORKSPACE_ID, pathOf(note), TOKEN).catch(() => ""), {
          timeout: 120_000,
          intervals: [1000],
        })
        .not.toBe("");
      await explorerRow(desk, pathOf(note)).click({ timeout: 15_000 });
      await expect(ownerEditor).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
      await expect(ownerEditor).toHaveAttribute("data-note-format", "2");
    }

    const links = new Map<Note, string>();
    for (const note of notes) {
      const created = await fetch(`${relay.baseUrl}/sync/${WORKSPACE_ID}/shares/links`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ paths: [pathOf(note)], access: "edit" }),
      });
      expect(created.status).toBe(200);
      const { url } = (await created.json()) as { url: string };
      links.set(note, `${sharedDatasetViewerOrigin}/s${new URL(url).hash}`);
    }
    await expect
      .poll(
        async () => {
          const listed = await desk.evaluate(
            (workspaceId) =>
              (window as unknown as { dohcDesktop: Api }).dohcDesktop.listOwnerLiveDocuments({
                workspaceId,
              }),
            WORKSPACE_ID,
          );
          return notes.every((note) =>
            listed.documents.some(
              (document) => document.path === pathOf(note) && document.status === "ready",
            ),
          );
        },
        { timeout: 180_000, intervals: [1000] },
      )
      .toBe(true);

    const shared = await startSharedDatasetBrowser({
      relayUrl: relay.baseUrl,
      exchangeKey,
      editLinks: true,
    });
    closers.push(() => shared.close());
    const people: Person[] = await Promise.all(
      [1, 2].map(async () => {
        const context = await shared.browser.newContext();
        return { context, page: await context.newPage() };
      }),
    );
    const [one, two] = people as [Person, Person];

    const open = async (note: Note) => {
      await explorerRow(desk, pathOf(note)).click({ timeout: 30_000 });
      await expect(ownerEditor).toHaveAttribute("data-note-format", "2");
      for (const person of people) {
        await person.page.close();
        person.page = await person.context.newPage();
        const { page } = person;
        page.on("pageerror", (error) => shared.failures.push(error.message));
        await page.goto(links.get(note)!);
        for (const name of [pathOf(note), "Edit file"])
          await page.getByRole("button", { name, exact: true }).click({ timeout: 30_000 });
        await expect(sharedEditor(page)).toHaveAttribute("contenteditable", "true", {
          timeout: 120_000,
        });
        await expect(page.getByText("Ready to edit", { exact: true })).toBeVisible({
          timeout: 120_000,
        });
      }
      for (const page of [desk, one.page, two.page])
        await expect
          .poll(() => paragraphs(page === desk ? ownerEditor : sharedEditor(page)))
          .toEqual(NOTES[note]);
    };
    const press = async (person: Person, text: string, ...keys: string[]) => {
      await sharedEditor(person.page).getByText(text, { exact: true }).click({ timeout: 30_000 });
      for (const key of ["Home", ...keys]) {
        await caretSettles(person.page);
        await person.page.keyboard.press(key);
      }
    };
    const offline = (person: Person, off: boolean) => person.context.setOffline(off);
    const saved = (...persons: Person[]) =>
      Promise.all(
        persons.map(({ page }) =>
          expect(page.getByText("Changes saved", { exact: true })).toBeVisible({ timeout: 60_000 }),
        ),
      );
    const everyoneReads = async (note: Note, expected: string[], markdown: string) => {
      await expect
        .poll(
          async () => [
            await paragraphs(ownerEditor),
            await paragraphs(sharedEditor(one.page)),
            await paragraphs(sharedEditor(two.page)),
          ],
          { timeout: 60_000, intervals: [250] },
        )
        .toEqual([expected, expected, expected]);
      for (const stored of [
        () => readFile(join(temp.rootPath, pathOf(note)), "utf8").catch(() => ""),
        () => relayStoredFile(relay, WORKSPACE_ID, pathOf(note), TOKEN),
      ])
        await expect
          .poll(async () => (await stored()).replace(/\r\n/gu, "\n"), {
            timeout: 60_000,
            intervals: [500],
          })
          .toBe(markdown);
    };
    const shoot = async (name: string) => {
      for (const page of [desk, two.page]) {
        const [body, who] = [await page.screenshot(), page === desk ? "owner" : "share page"];
        await test.info().attach(`${name}, ${who}`, { body, contentType: "image/png" });
      }
    };

    await test.step("1. two people join the same line, and the third has seen neither join", async () => {
      await open("joinSame");
      await Promise.all([offline(one, true), offline(two, true)]);
      for (const person of [one, two]) await press(person, "bb", "Backspace");
      expect(await paragraphs(ownerEditor)).toEqual(NOTES.joinSame);
      await Promise.all([offline(one, false), offline(two, false)]);
      await saved(one, two);
      await everyoneReads("joinSame", ["aabb"], "aabb\n");
    });

    await test.step("2. one person joins a line while another splits it", async () => {
      await open("joinSplit");
      await offline(one, true);
      await press(one, "twothree", "Backspace");
      await press(two, "twothree", "ArrowRight", "ArrowRight", "ArrowRight", "Enter");
      await expect.poll(() => paragraphs(ownerEditor)).toEqual(["one", "two", "three"]);
      await offline(one, false);
      await saved(one, two);
      await everyoneReads("joinSplit", ["onetwo", "three"], "onetwo\n\nthree\n");
    });

    await test.step("3. two people split one line at the same place", async () => {
      await open("splitSame");
      await offline(one, true);
      for (const person of [one, two])
        await press(person, "abcd", "ArrowRight", "ArrowRight", "Enter");
      await expect.poll(() => paragraphs(ownerEditor)).toEqual(["ab", "cd"]);
      await offline(one, false);
      await saved(one, two);
      await everyoneReads("splitSame", ["ab", "", "cd"], "ab\n\n\n\ncd\n");
    });

    await test.step("4. two people join a / bc, and one types X between b and c before receiving the other's join", async () => {
      await open("joinType");
      await offline(two, true);
      await press(two, "bc", "Backspace");
      await press(one, "bc", "Backspace");
      await everyoneReads("joinType", ["abc"], "abc\n");
      await two.page.keyboard.press("ArrowRight");
      await caretSettles(two.page);
      await two.page.keyboard.type("X");
      await offline(two, false);
      await saved(one, two);
      await everyoneReads("joinType", ["abXc"], "abXc\n");
      await shoot("case 4");
    });

    await test.step("6. the person who typed X undoes it", async () => {
      await two.page.keyboard.press("ControlOrMeta+z");
      await everyoneReads("joinType", ["abc"], "abc\n");
    });

    await test.step("5. pp / kk / ll: one joins ll into kk offline, the other joins kk and then ll into pp", async () => {
      await open("joinChain");
      await offline(one, true);
      await press(one, "ll", "Backspace");
      await press(two, "kk", "Backspace");
      await press(two, "ll", "Backspace");
      await expect.poll(() => paragraphs(ownerEditor)).toEqual(["ppkkll"]);
      await offline(one, false);
      await saved(one, two);
      await everyoneReads("joinChain", ["ppkkll"], "ppkkll\n");
      await shoot("case 5");
    });

    expect(shared.failures).toEqual([]);
    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    for (const close of closers.reverse()) await close().catch(() => undefined);
    await temp.cleanup();
  }
});
