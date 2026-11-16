import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openEditLinkOnServer } from "./helpers/editLinkServer";
import { processCost } from "./helpers/processCost";

const PATH = "plain.md";
const PARAGRAPH = "An ordinary paragraph.";
// A workspace with some folders in it, so a walk of it has something to open.
const FILES = [
  { path: PATH, contents: `# Plain\n\n${PARAGRAPH}\n` },
  ...Array.from({ length: 200 }, (_, index) => ({
    path: `notes/${String(index % 10)}/note-${String(index)}.md`,
    contents: `# Note ${String(index)}\n\nA line of text.\n`,
  })),
];
// The built relay, as a server runs it. Run from source, the relay also keeps a compiler beside it.
const BUILT_RELAY = fileURLToPath(
  new URL("../../../services/sync-relay/dist/main.js", import.meta.url),
);
/**
 * A run that sets `DOHC_IDLE_WINDOW_S` is a measurement: each reading lasts that long, and the server is also
 * read while the desktop and the link page are still open. `DOHC_IDLE_REST_MIN` adds a reading that many
 * minutes after everyone left. The server unloads a note nobody has open after ten minutes.
 */
const MEASURING = process.env.DOHC_IDLE_WINDOW_S !== undefined;
const WINDOW_S = Number(process.env.DOHC_IDLE_WINDOW_S ?? 20);
const REST_MIN = Number(process.env.DOHC_IDLE_REST_MIN ?? 0);

test("@server-idle with nobody connected, a server's workspace watchers wake under five times a second and their observers under once in two", async () => {
  test.skip(process.platform !== "linux", "Reads each thread's counters from /proc.");
  test.setTimeout(900_000 + REST_MIN * 60_000);
  const server = await openEditLinkOnServer({
    workspaceId: "server-idle-cost",
    owner: "e2e-server-idle-owner",
    path: PATH,
    files: FILES,
    ...(existsSync(BUILT_RELAY) ? { compiledRelayMain: BUILT_RELAY } : {}),
  });
  try {
    const { ownerPage, linkPage, editor } = server;
    const relay = server.relay().pid;
    const rest = () => new Promise((resolve) => setTimeout(resolve, WINDOW_S * 1_000));
    // One edit through the server, so every part of it has done its work once before it rests.
    await editor.getByText(PARAGRAPH, { exact: false }).click({ timeout: 5_000 });
    await linkPage.keyboard.press("Control+End");
    await linkPage.keyboard.insertText(" saved");
    await expect(ownerPage.getByTestId("markdown-editor")).toContainText("saved", {
      timeout: 60_000,
    });
    // The whole workspace is on the server, so its engines have every folder to walk.
    await expect
      .poll(
        async () => {
          const held = await server.filesOnServer();
          return FILES.filter((file) => !held.has(file.path)).length;
        },
        { timeout: 120_000, intervals: [1000] },
      )
      .toBe(0);
    if (MEASURING) {
      await rest();
      await processCost("desktop and link page open, nobody typing", relay, WINDOW_S);
      await linkPage.close();
      await rest();
      await processCost("link page closed, desktop open", relay, WINDOW_S);
    }

    if (!linkPage.isClosed()) await linkPage.close();
    await server.quitDesktop();
    await rest();
    const idle = await processCost("nobody connected", relay, WINDOW_S);
    if (REST_MIN > 0) {
      await new Promise((resolve) => setTimeout(resolve, REST_MIN * 60_000));
      await processCost(`nobody connected for ${String(REST_MIN)} minutes`, relay, WINDOW_S);
    }
    // The relay's own count of what it asked its engines for, minute by minute.
    for (const line of server.relay().diagnostics().stderr.split("\n"))
      if (line.startsWith("Relay main thread, last minute.")) {
        const minute = JSON.parse(line.slice(line.indexOf("{"))) as {
          loop: { samples: number } | null;
          writes: Record<string, { count: number }>;
          engine: Record<string, { count: number }>;
        };
        const counts = (of: Record<string, { count: number }>) =>
          Object.entries(of)
            .map(([name, figures]) => `${name} ${String(figures.count)}`)
            .join(", ");
        console.log(
          `IDLE relay minute: ${String(minute.loop?.samples ?? 0)} loop samples; writes: ${counts(minute.writes) || "none"}; engine requests: ${counts(minute.engine) || "none"}`,
        );
      }

    // The limits come last, so a run that breaks them still prints every reading.
    const wakes = (thread: RegExp) =>
      idle.filter((cost) => thread.test(cost.thread)).map((cost) => cost.wakesPerSecond);
    // A watcher wakes for each file event. A walk of this workspace opens over ten folders, and when each open
    // counted as a change, every walk started the next one and the watchers woke over twenty times a second.
    expect(wakes(/^notify-rs/u).length).toBeGreaterThan(0);
    expect(wakes(/^dohc-native-wat/u).length).toBeGreaterThan(0);
    for (const perSecond of wakes(/^(notify-rs|dohc-native-wat)/u))
      expect(perSecond).toBeLessThan(5);
    // The observer waits for its watcher. When it polled, it woke twice a second.
    expect(wakes(/^dohc-file-obser/u).length).toBeGreaterThan(0);
    for (const perSecond of wakes(/^dohc-file-obser/u)) expect(perSecond).toBeLessThan(0.5);
    // The relay's automations ask the live host's engine for its claim ledger, and expire its history when the
    // workspace opens. A call that engine does not admit is refused and logged each time the relay makes it.
    const refused = server
      .relay()
      .diagnostics()
      .stderr.split("\n")
      .filter((line) => line.includes("(code FORBIDDEN"));
    expect(refused).toEqual([]);
  } finally {
    await server.close();
  }
});
