import { expect, test } from "@playwright/test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import { momentTextsForPath, textFileTrackedByEngine } from "./helpers/engineDb";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  seedWorkspaceSettings,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// AUDIT-SILENTSAVE. Three dogfood computer-use journeys, driving the real app,
// each watched a document read "Saved" in the editor while its .md on disk sat
// at ZERO BYTES — silent, total loss of what the user wrote. The trigger was
// size: past the engine's 48 KiB in-band response cap the settle refused
// pre-commit on EVERY debounced attempt (journey 1's load-test.md held 131,442
// typed/pasted bytes and the file never received one), and the refusal reached
// nothing at all — no log, no UI, while a renderer-side timer kept flipping the
// indicator to "Saved".
//
// This spec owns the user-visible contract at the only layer that can prove it:
// the real app, a real engine, a real file on disk.

const CHUNK = "The quick brown fox jumps over the lazy dog, repeatedly. ";
// ~140 KiB: past BOTH the 48 KiB in-band response cap and the 128 KiB capture
// text cap, matching the 131,442 bytes journey 1 actually pasted. Under 128 KiB
// this spec would miss the capture layer retiring the engine record entirely.
const CHUNKS = 2_500;
const INBAND_CAP_BYTES = 48 * 1024;
const CAPTURE_TEXT_CAP_BYTES = 128 * 1024;
const TAIL_SENTINEL = "TAIL-SENTINEL-THE-LAST-BYTE-MUST-LAND";

async function openEngineDoc(
  page: import("@playwright/test").Page,
  path: string,
): Promise<void> {
  const segments = path.split("/");
  for (let i = 0; i < segments.length - 1; i += 1) {
    await explorerRow(page, segments.slice(0, i + 1).join("/")).click();
  }
  await explorerRow(page, path).click();
  await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("markdown-editor")).toBeVisible();
}

test("a document past the in-band cap reaches disk, and the editor never claims Saved before it does", async () => {
  // This spec does more than any other here: launch, type ~140 KiB, wait out
  // the settle, then RESTART the app and wait for the reconcile. Measured on a
  // saturated machine (14 busy threads, the state this repo's parallel agents
  // actually leave it in), healthy passes ran 25.4s–58.7s — up against the
  // config's 60s default, which then timed out 2 runs in 8 with nothing wrong.
  // The phases keep their own bounds: the honesty loop below has a 60s deadline
  // and every expect keeps the 30s expect timeout, so a real hang still fails
  // as itself rather than as an opaque test timeout.
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await writeWorkspaceFiles(temp, [
      { path: "load/big.md", contents: "# Load\n\nStart small.\n" },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "load/big.md");
    await openEngineDoc(page, "load/big.md");

    const absolute = join(temp.rootPath, "load/big.md");
    const saveState = page.getByTestId("markdown-save-state");
    const editor = page.getByTestId("markdown-editor");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");

    // Paste-sized input, the way the journeys produced it. insertText goes in
    // as one input event per chunk rather than 50,000 keystrokes.
    const paste = CHUNK.repeat(CHUNKS);
    expect(Buffer.byteLength(paste, "utf8")).toBeGreaterThan(INBAND_CAP_BYTES);
    const sliceSize = 5_000;
    for (let at = 0; at < paste.length; at += sliceSize) {
      await page.keyboard.insertText(paste.slice(at, at + sliceSize));
    }
    await page.keyboard.insertText(TAIL_SENTINEL);

    await expect(editor).toContainText(TAIL_SENTINEL, { timeout: 15_000 });
    // The edit registered: the indicator left "Saved" for the typing. From
    // here on, the next "Saved" is a claim about THIS content.
    await expect(saveState).toHaveAttribute("data-state", "saving", {
      timeout: 15_000,
    });

    // THE HONESTY INVARIANT, checked continuously: the indicator may read
    // "Saved" only when the file on disk really holds what the editor shows.
    // Before the fix this failed within a second — "Saved" over 0 bytes.
    const dishonest: string[] = [];
    const deadline = Date.now() + 60_000;
    let landed = false;
    while (Date.now() < deadline) {
      const state = await saveState.getAttribute("data-state");
      const onDisk = await readFile(absolute, "utf8").catch(() => "");
      if (state === "saved") {
        if (onDisk.includes(TAIL_SENTINEL)) {
          landed = true;
          break;
        }
        dishonest.push(
          `read "Saved" while the file held ${Buffer.byteLength(onDisk, "utf8")} bytes ` +
            `and did not contain the last thing typed`,
        );
        break;
      }
      await page.waitForTimeout(250);
    }

    expect(dishonest, dishonest.join("; ")).toEqual([]);
    expect(
      landed,
      "the over-cap document never reached disk (the settle is still refusing)",
    ).toBe(true);

    // The whole document is there — not a truncated prefix, not a cap-sized
    // slice. Both the size and the last byte typed.
    const finalText = await readFile(absolute, "utf8");
    const finalSize = (await stat(absolute)).size;
    expect(finalSize).toBeGreaterThan(INBAND_CAP_BYTES);
    // The point of a ~140 KiB fixture: it is past the desktop capture layer's
    // text cap too, which is where the record-retiring trap lives. Asserting
    // only the 48 KiB in-band cap would let the fixture shrink back under it.
    expect(finalSize).toBeGreaterThan(CAPTURE_TEXT_CAP_BYTES);
    expect(finalText).toContain(TAIL_SENTINEL);
    expect(finalText).toContain("Start small.");

    // And the editor's own claim is now backed by that file.
    await expect(saveState).toHaveAttribute("data-state", "saved");
    await expect(saveState).toHaveText("Saved");

    // The engine recorded it as history too — the settle committed a moment
    // carrying the full body, not just a materialized file.
    expect(
      momentTextsForPath(temp.rootPath, "load/big.md").some((text) =>
        text.includes(TAIL_SENTINEL),
      ),
    ).toBe(true);

    // Sanity: the record IS tracked before the restart. Without this the
    // post-restart assertion could be failing on a broken query rather than
    // on a retired record.
    expect(
      textFileTrackedByEngine(temp.rootPath, "load/big.md"),
      "precondition: the engine tracks the doc before the restart",
    ).toBe(true);

    // RESTART. The startup reconcile re-reads every file and retires anything
    // it cannot own as text — and a >128 KiB file is exactly that. Without
    // the lineage guard it journals a "Stopped tracking non-text content"
    // delete and the document silently stops being engine-backed on every
    // launch. Bytes survive; the engine record and history continuity do not.
    await desktop.close();
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await waitForWorkspaceFile(
      desktop.page,
      workspace.workspaceId,
      "load/big.md",
    );
    // Give the reconcile pass room to run and converge.
    await desktop.page.waitForTimeout(3_000);

    expect(
      textFileTrackedByEngine(temp.rootPath, "load/big.md"),
      "the startup reconcile retired the engine record for the over-cap doc",
    ).toBe(true);
    // And the file itself is untouched.
    expect(await readFile(absolute, "utf8")).toContain(TAIL_SENTINEL);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
