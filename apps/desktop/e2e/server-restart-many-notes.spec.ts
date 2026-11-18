import { expect, test } from "@playwright/test";
import { openEditLinkOnServer } from "./helpers/editLinkServer";

// The open note sorts after every other, so a host that brings notes back in path order reaches it last.
const PATH = "zz-open.md";
const PARAGRAPH = "An ordinary paragraph.";
/**
 * A measurement, run by setting `DOHC_RESTART_NOTES` to how many other notes the link covers. It prints how
 * long the open note took to be editable again. The order itself is tested in `servicePassOrder.test.ts` and
 * `serviceLiveHost.test.ts`.
 */
const OTHER_NOTES = Number(process.env.DOHC_RESTART_NOTES ?? 0);
const OTHERS = Array.from({ length: OTHER_NOTES }, (_, index) => ({
  path: `note-${String(index).padStart(3, "0")}.md`,
  contents: `# Note ${String(index)}\n\nA line of text.\n`,
}));

test("@server-restart-many after a relay restart, the note someone has open is editable again before the server has brought back every other linked note", async () => {
  test.skip(OTHER_NOTES === 0, "A measurement. Set DOHC_RESTART_NOTES to run it.");
  test.setTimeout(1_200_000);
  const server = await openEditLinkOnServer({
    workspaceId: "server-restart-many-notes",
    owner: "e2e-server-restart-many-owner",
    path: PATH,
    files: [{ path: PATH, contents: `# Open\n\n${PARAGRAPH}\n` }, ...OTHERS],
    // One Edit link over every note, so the server hosts them all and brings them all back at a start.
    alsoLinked: OTHERS.map((note) => note.path),
    env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" },
  });
  try {
    const { editor, linkPage } = server;
    await editor.getByText(PARAGRAPH, { exact: false }).click({ timeout: 5_000 });
    await linkPage.keyboard.press("Control+End");
    await linkPage.keyboard.insertText(" before");
    // What the relay asked its engines for, from its own line each minute.
    const engineCounts = () => {
      const counts = new Map<string, number>();
      for (const line of server.relay().diagnostics().stderr.split("\n"))
        if (line.startsWith("Relay main thread, last minute.")) {
          const minute = JSON.parse(line.slice(line.indexOf("{"))) as {
            engine: Record<string, { count: number }>;
          };
          for (const [name, { count }] of Object.entries(minute.engine))
            counts.set(name, (counts.get(name) ?? 0) + count);
        }
      return counts;
    };
    // Every note is hosted before the restart, or the restart has nothing to bring back.
    const registered = () => engineCounts().get("liveApplication.register") ?? 0;
    await expect
      .poll(registered, { timeout: 300_000, intervals: [5_000] })
      .toBeGreaterThanOrEqual(OTHER_NOTES + 1)
      .catch(() => undefined);
    console.log(`RESTART before it: the relay registered ${String(registered())} notes`);
    expect(registered()).toBeGreaterThanOrEqual(OTHER_NOTES + 1);

    let returnedAt = 0;
    await server.restartRelay();
    returnedAt = Date.now();
    await expect(editor).not.toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
    await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 180_000 });
    const editableAfterMs = Date.now() - returnedAt;
    await editor.getByText(PARAGRAPH, { exact: false }).click({ timeout: 5_000 });
    await linkPage.keyboard.press("Control+End");
    await linkPage.keyboard.insertText(" after");

    // The new relay's first minute line says how many notes it had brought back by then.
    await expect
      .poll(() => engineCounts().get("liveApplication.register") ?? 0, {
        timeout: 180_000,
        intervals: [5_000],
      })
      .toBeGreaterThanOrEqual(OTHER_NOTES + 1);
    const slow = server
      .relay()
      .diagnostics()
      .stderr.split("\n")
      .filter((line) => line.includes("Live host pass was slow")).length;
    console.log(
      `RESTART with ${String(OTHER_NOTES + 1)} linked notes: the open note was editable ${String(editableAfterMs)} ms after the relay returned; the new relay registered ${String(engineCounts().get("liveApplication.register"))} notes; slow passes logged ${String(slow)}`,
    );
    await expect(editor).toContainText("after");
  } finally {
    await server.close();
  }
});
