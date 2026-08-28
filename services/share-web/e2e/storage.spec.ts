import { type Page, type Request } from "@playwright/test";
import {
  expect,
  seedShare,
  test,
} from "./harness";

const OBSERVER_CONTROL = "__dohcIso10StorageObserverControl_b7e15162";
const CONTENT_WINDOW_MARKER = "__dohcIso10StorageContentMarker_b7e15162";
const ORDINARY_HOSTILE_TEXT = "Hostile storage fixture ordinary text remains readable.";
const ORDINARY_OBSERVER_TEXT = "Benign observer share remains readable.";
const ATTACK_VECTORS = [
  {
    cacheName: "dohc-iso10-storage-cache-raw-b7e15162",
    channelMessage: "dohc-iso10-storage-broadcast-raw-b7e15162",
    databaseName: "dohc-iso10-storage-database-raw-b7e15162",
    localStorageKey: "dohc-iso10-storage-local-raw-b7e15162",
    marker: "dohc-iso10-storage-marker-raw-b7e15162",
    name: "raw",
    serviceWorkerPath: "/dohc-iso10-storage-worker-raw-b7e15162.js",
    serviceWorkerScope: "/dohc-iso10-storage-worker-scope-raw-b7e15162/",
    sessionStorageKey: "dohc-iso10-storage-session-raw-b7e15162",
  },
  {
    cacheName: "dohc-iso10-storage-cache-event-b7e15162",
    channelMessage: "dohc-iso10-storage-broadcast-event-b7e15162",
    databaseName: "dohc-iso10-storage-database-event-b7e15162",
    localStorageKey: "dohc-iso10-storage-local-event-b7e15162",
    marker: "dohc-iso10-storage-marker-event-b7e15162",
    name: "event",
    serviceWorkerPath: "/dohc-iso10-storage-worker-event-b7e15162.js",
    serviceWorkerScope: "/dohc-iso10-storage-worker-scope-event-b7e15162/",
    sessionStorageKey: "dohc-iso10-storage-session-event-b7e15162",
  },
] as const;
const BROADCAST_CHANNEL_NAME = "dohc-iso10-storage-channel-b7e15162";

interface ObserverSnapshot {
  broadcastMessages: unknown[];
  serviceWorkerMessages: unknown[];
  storageEvents: Array<{ key: string | null; newValue: string | null }>;
}

interface StorageSnapshot {
  cacheNames: string[];
  databaseNames: string[];
  localStorageEntries: Array<[string, string]>;
  serviceWorkerRegistrations: Array<{
    activeScriptUrl: string | null;
    installingScriptUrl: string | null;
    scope: string;
    waitingScriptUrl: string | null;
  }>;
  sessionStorageEntries: Array<[string, string]>;
}

function attackProgram(vector: typeof ATTACK_VECTORS[number]): string {
  return [
    `window[${JSON.stringify(CONTENT_WINDOW_MARKER)}]=${JSON.stringify(vector.marker)}`,
    `localStorage.setItem(${JSON.stringify(vector.localStorageKey)},${JSON.stringify(vector.marker)})`,
    `sessionStorage.setItem(${JSON.stringify(vector.sessionStorageKey)},${JSON.stringify(vector.marker)})`,
    `indexedDB.open(${JSON.stringify(vector.databaseName)})`,
    `void caches.open(${JSON.stringify(vector.cacheName)})`,
    `void navigator.serviceWorker.register(${JSON.stringify(vector.serviceWorkerPath)},{scope:${JSON.stringify(vector.serviceWorkerScope)}}).catch(()=>undefined)`,
    `(()=>{const channel=new BroadcastChannel(${JSON.stringify(BROADCAST_CHANNEL_NAME)});channel.postMessage(${JSON.stringify(vector.channelMessage)});channel.close()})()`,
  ].join(";");
}

function hostileStorageFixture(): string {
  return [
    "# Viewer storage browser conformance",
    "",
    ORDINARY_HOSTILE_TEXT,
    "",
    `<script>${attackProgram(ATTACK_VECTORS[0])}</script>`,
    `<img src="/dohc-iso10-storage-missing-b7e15162.png" alt="Hostile storage event probe" onerror='${attackProgram(ATTACK_VECTORS[1])}'>`,
  ].join("\n");
}

function sessionFromPage(page: Page): string {
  const pathname = new URL(page.url()).pathname;
  const match = /^\/s\/([A-Za-z0-9_-]{12})$/u.exec(pathname);
  if (!match) throw new Error(`viewer did not settle at a session path: ${page.url()}`);
  return match[1]!;
}

function storageSnapshot(page: Page): Promise<StorageSnapshot> {
  return page.evaluate(async () => {
    const entries = (storage: Storage): Array<[string, string]> => {
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
        .filter((key): key is string => key !== null)
        .sort();
      return keys.map((key) => [key, storage.getItem(key) ?? ""]);
    };
    const [databases, cacheNames, registrations] = await Promise.all([
      indexedDB.databases(),
      caches.keys(),
      navigator.serviceWorker.getRegistrations(),
    ]);
    return {
      cacheNames: [...cacheNames].sort(),
      databaseNames: databases
        .map((database) => database.name)
        .filter((name): name is string => typeof name === "string")
        .sort(),
      localStorageEntries: entries(localStorage),
      serviceWorkerRegistrations: registrations.map((registration) => ({
        activeScriptUrl: registration.active?.scriptURL ?? null,
        installingScriptUrl: registration.installing?.scriptURL ?? null,
        scope: registration.scope,
        waitingScriptUrl: registration.waiting?.scriptURL ?? null,
      })),
      sessionStorageEntries: entries(sessionStorage),
    };
  });
}

async function installObserver(page: Page): Promise<void> {
  await page.evaluate(
    ({ channelName, controlName }) => {
      const broadcastMessages: unknown[] = [];
      const serviceWorkerMessages: unknown[] = [];
      const storageEvents: Array<{ key: string | null; newValue: string | null }> = [];
      const channel = new BroadcastChannel(channelName);
      const onBroadcast = (event: MessageEvent<unknown>) => {
        broadcastMessages.push(event.data);
      };
      const onServiceWorkerMessage = (event: MessageEvent<unknown>) => {
        serviceWorkerMessages.push(event.data);
      };
      const onStorage = (event: StorageEvent) => {
        storageEvents.push({ key: event.key, newValue: event.newValue });
      };
      channel.addEventListener("message", onBroadcast);
      navigator.serviceWorker.addEventListener("message", onServiceWorkerMessage);
      window.addEventListener("storage", onStorage);
      Reflect.set(window, controlName, {
        broadcastMessages,
        channel,
        onBroadcast,
        onServiceWorkerMessage,
        onStorage,
        serviceWorkerMessages,
        storageEvents,
      });
    },
    { channelName: BROADCAST_CHANNEL_NAME, controlName: OBSERVER_CONTROL },
  );
}

function observerSnapshot(page: Page): Promise<ObserverSnapshot> {
  return page.evaluate((controlName) => {
    const control = Reflect.get(window, controlName) as ObserverSnapshot | undefined;
    if (!control) throw new Error("storage observer is not installed");
    return {
      broadcastMessages: [...control.broadcastMessages],
      serviceWorkerMessages: [...control.serviceWorkerMessages],
      storageEvents: [...control.storageEvents],
    };
  }, OBSERVER_CONTROL);
}

function apiRequestsUseSession(requests: readonly Request[], session: string): boolean {
  const viewRequests = requests.filter((request) =>
    new URL(request.url()).pathname.startsWith("/api/view/")
  );
  return viewRequests.length > 0 && viewRequests.every((request) =>
    request.headers()["x-dohc-link-session"] === session
  );
}

test("keeps shared content from creating viewer-origin browser storage", async ({
  browser,
  stack,
}) => {
  const hostileShare = await seedShare({
    relayUrl: stack.relayUrl,
    paths: ["docs"],
    files: [{ path: "docs/storage.md", content: hostileStorageFixture() }],
  });
  const observerShare = await seedShare({
    relayUrl: stack.relayUrl,
    paths: ["docs"],
    files: [{
      path: "docs/observer.md",
      content: `# Viewer storage observer\n\n${ORDINARY_OBSERVER_TEXT}\n`,
    }],
  });

  const context = await browser.newContext();
  const observerRequests: Request[] = [];
  const hostileRequests: Request[] = [];
  try {
    const observerPage = await context.newPage();
    observerPage.on("request", (request) => observerRequests.push(request));
    await observerPage.goto(`${stack.shareWebUrl}/s/#${observerShare.secret}`);
    await expect(observerPage.locator("article.markdown")).toContainText(
      ORDINARY_OBSERVER_TEXT,
    );
    const observerSession = sessionFromPage(observerPage);
    const observerUrl = observerPage.url();

    await installObserver(observerPage);
    expect(await storageSnapshot(observerPage)).toEqual({
      cacheNames: [],
      databaseNames: [],
      localStorageEntries: [],
      serviceWorkerRegistrations: [],
      sessionStorageEntries: [],
    });
    expect(await observerSnapshot(observerPage)).toEqual({
      broadcastMessages: [],
      serviceWorkerMessages: [],
      storageEvents: [],
    });

    const hostilePage = await context.newPage();
    hostilePage.on("request", (request) => hostileRequests.push(request));
    await hostilePage.goto(`${stack.shareWebUrl}/s/#${hostileShare.secret}`);
    const hostileArticle = hostilePage.locator("article.markdown");
    await expect(hostileArticle).toContainText(ORDINARY_HOSTILE_TEXT);
    await expect(hostileArticle.locator("script, [onerror], [onload]")).toHaveCount(0);
    await hostilePage.waitForLoadState("networkidle");

    const hostileSession = sessionFromPage(hostilePage);
    const hostileUrl = hostilePage.url();
    expect(hostileSession).not.toBe(observerSession);
    expect(hostileUrl).not.toBe(observerUrl);
    expect(await hostilePage.evaluate((name) => Reflect.has(window, name), CONTENT_WINDOW_MARKER))
      .toBe(false);

    const hostileStorage = await storageSnapshot(hostilePage);
    expect(hostileStorage.localStorageEntries).toEqual([]);
    expect(hostileStorage.sessionStorageEntries).toEqual([]);
    expect(hostileStorage.databaseNames).toEqual([]);
    expect(hostileStorage.cacheNames).toEqual([]);
    expect(hostileStorage.serviceWorkerRegistrations).toEqual([]);
    expect(await observerSnapshot(observerPage)).toEqual({
      broadcastMessages: [],
      serviceWorkerMessages: [],
      storageEvents: [],
    });

    const observerStorage = await storageSnapshot(observerPage);
    expect(observerStorage.localStorageEntries).toEqual([]);
    expect(observerStorage.sessionStorageEntries).toEqual([]);
    expect(observerStorage.databaseNames).toEqual([]);
    expect(observerStorage.cacheNames).toEqual([]);
    expect(observerStorage.serviceWorkerRegistrations).toEqual([]);

    const sessionCookies = (await context.cookies())
      .filter((cookie) => cookie.name.startsWith("dohc_share_"));
    expect(sessionCookies.map((cookie) => cookie.name).sort()).toEqual(
      [`dohc_share_${hostileSession}`, `dohc_share_${observerSession}`].sort(),
    );
    expect(new Set(sessionCookies.map((cookie) => cookie.value)).size).toBe(2);
    expect(apiRequestsUseSession(observerRequests, observerSession)).toBe(true);
    expect(apiRequestsUseSession(hostileRequests, hostileSession)).toBe(true);

    await observerPage
      .getByRole("navigation", { name: "Shared files" })
      .getByRole("button", { name: "observer.md", exact: true })
      .click();
    await expect(observerPage.locator("article.markdown")).toContainText(
      ORDINARY_OBSERVER_TEXT,
    );
    expect(observerPage.url()).toBe(observerUrl);
    await hostilePage
      .getByRole("navigation", { name: "Shared files" })
      .getByRole("button", { name: "storage.md", exact: true })
      .click();
    await expect(hostilePage.locator("article.markdown")).toContainText(
      ORDINARY_HOSTILE_TEXT,
    );
    expect(hostilePage.url()).toBe(hostileUrl);
  } finally {
    await context.close();
  }
});
