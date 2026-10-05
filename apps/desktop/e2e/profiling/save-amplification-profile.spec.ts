import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EngineYDocSaveStateEvent, WorkspaceActivityEvent } from "../../src/ipc/bridgeContract";
import { countersPerSaveConfirmation as countersPerSavedNotification } from "../../src/performance/profileCounters";
import { nativeWorkStatsDelta } from "../../src/performance/nativeWorkStats";
import { explorerRow, revealExplorerPath, waitForWorkspaceFile } from "../helpers/workspace";
import { startCdpCapture } from "./cdpCapture";
import { counterPairDelta, launchFixture, profileError, readProfileCounters, recordProfilePhase, writeProfileArtifact, type ProfileCounterPair } from "./harness";

interface PhaseWindow extends Window {
  richEditPhase?: {
    inputs: Array<{ atMs: number; trusted: boolean }>;
    activities: Array<{ atMs: number; event: WorkspaceActivityEvent }>;
    saves: Array<{ atMs: number; event: EngineYDocSaveStateEvent }>;
    writerStartedMs: number | null;
    writerFinishedMs: number | null;
    stop(): void;
  };
}
type PhaseEvents = Omit<NonNullable<PhaseWindow["richEditPhase"]>, "stop">;

async function beginPhase(page: Page, workspaceId: string) {
  await page.evaluate(workspaceId => {
    const target = window as PhaseWindow;
    target.richEditPhase?.stop();
    const state: NonNullable<PhaseWindow["richEditPhase"]> = {
      inputs: [], activities: [], saves: [], writerStartedMs: null, writerFinishedMs: null,
      stop() { document.removeEventListener("input", input, true); activityOff(); saveOff(); },
    };
    function input(event: Event) {
      if ((event.target as Element | null)?.closest(".tiptap")) {
        state.inputs.push({ atMs: performance.now(), trusted: event.isTrusted });
      }
    }
    const activityOff = window.dohcDesktop!.onWorkspaceActivity(event => {
      if (event.workspaceId === workspaceId) state.activities.push({ atMs: performance.now(), event });
    });
    const saveOff = window.dohcDesktop!.onEngineYDocSaveState(event => {
      state.saves.push({ atMs: performance.now(), event });
    });
    document.addEventListener("input", input, true);
    target.richEditPhase = state;
  }, workspaceId);
}

test("profiles rich typing above a table and concurrent external writes", async () => {
  const cases: Array<Record<string, unknown>> = [];
  for (const fixtureName of ["rich-edit-ordinary", "rich-edit-stress"] as const) {
    const context = await launchFixture(fixtureName, `profile-${fixtureName}`);
    try {
      const { page, desktop, manifest, workspace, fixtureRoot } = context;
      const fixture = manifest.fixtures[fixtureName];
      await waitForWorkspaceFile(page, workspace.workspaceId, fixture.path);
      await revealExplorerPath(page, fixture.path);
      const openBefore = await readProfileCounters(page, workspace.workspaceId);
      const openStarted = performance.now();
      await explorerRow(page, fixture.path).click();
      const editor = page.locator('.tiptap[contenteditable="true"]');
      let sourceViewWasShown = false;
      if (fixtureName === "rich-edit-stress") {
        // Engine documents use Source/Editor to show a read-only projection.
        // The transient Edit control belongs to the opening surface.
        const sourceToggle = page.getByTestId("markdown-source-toggle");
        await expect(sourceToggle).toBeVisible();
        sourceViewWasShown = await sourceToggle.getAttribute("aria-pressed") === "true";
        if (sourceViewWasShown) await sourceToggle.click();
      }
      await expect(editor).toBeVisible({ timeout: 120_000 });
      const table = editor.locator("table");
      await expect(table.locator("tr")).toHaveCount(4);
      const tableText = await table.innerText();
      const tableShape = () => table.evaluate(element => ({
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        cellWidths: [...element.querySelectorAll("tr:first-child > th, tr:first-child > td")].map(cell => cell.getBoundingClientRect().width),
      }));
      const tableBefore = await tableShape();
      await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
      const openAfter = await readProfileCounters(page, workspace.workspaceId);
      const opening = {
        elapsedMs: performance.now() - openStarted,
        surface: "engine-rich", sourceViewWasShown,
        before: openBefore, after: openAfter, native: nativeWorkStatsDelta(openBefore.native, openAfter.native),
      };
      const phases: Array<Record<string, unknown>> = [];
      cases.push({ fixture: { name: fixtureName, seed: manifest.seed, ...fixture }, opening, phases });
      await writeProfileArtifact("save-amplification-profile", { schemaVersion: 4, diagnostic: true, complete: false, measurements: { cases } });
      expect(opening.native.status, JSON.stringify(opening.native)).toBe("available");
      for (const concurrent of [false, true]) {
        const name = concurrent ? "typing-with-external-writes" : "typing";
        const marker = concurrent ? "agentx-0123456789-abcdefghijkl" : "localx-0123456789-abcdefghijkl";
        expect(marker).toHaveLength(30);
        const externalPaths = concurrent ? fixture.externalWritePaths : [];
        const phase: Record<string, unknown> = {
          name, measurementStage: "setup", keystrokeDelayMs: 40, plannedCharacters: marker.length,
          typedCharacters: null, externalWritesCompleted: 0, persistedContentVerified: false,
          before: null, after: null, delta: null, raw: null,
          savedNotificationCountDefinition: "Received saved IPC notifications deduplicated by sessionId and seq; not scoped to the active session or a count of engine settlements.",
          native: null, react: { commitCount: null, source: "unavailable" },
          endCondition: "saved UI, persisted marker, saved notification, document and external path activity received; does not prove empty queues",
          overlapDefinition: "Trusted input during the external writer lifecycle, including gaps between writes; not proof of overlap with an individual filesystem call.",
        };
        let before: ProfileCounterPair | null = null, after: ProfileCounterPair | null = null;
        let delta: ReturnType<typeof counterPairDelta> | null = null, raw: PhaseEvents | null = null;
        let capture: Awaited<ReturnType<typeof startCdpCapture>> | null = null;
        let started: number | null = null, eventsStarted = false;
        await recordProfilePhase(phases, phase, {
          persist: () => writeProfileArtifact("save-amplification-profile", { schemaVersion: 4, diagnostic: true, complete: false, measurements: { cases } }),
          run: async () => {
            await editor.locator("p").first().click();
            await page.keyboard.press("End");
            await beginPhase(page, workspace.workspaceId); eventsStarted = true;
            capture = await startCdpCapture(desktop.app, page);
            phase.measurementStage = "before-counters";
            before = await readProfileCounters(page, workspace.workspaceId, read => { phase.beforeRead = read; });
            phase.before = before;
            started = performance.now(); phase.startedAtMs = started;
            phase.measurementStage = "typing";
            const writes = concurrent ? (async () => {
              await page.evaluate(() => { (window as PhaseWindow).richEditPhase!.writerStartedMs = performance.now(); });
              for (const [index, path] of externalPaths.entries()) {
                // Interleave ten writes with the real input stream. No timer
                // controls correctness or claims an engine observation occurred.
                if (index > 0) await page.waitForFunction(count => (window as PhaseWindow).richEditPhase!.inputs.length >= count, index * 3);
                await writeFile(join(fixtureRoot, path), `external write ${index}\n`);
                phase.externalWritesCompleted = index + 1;
              }
              await page.evaluate(() => { (window as PhaseWindow).richEditPhase!.writerFinishedMs = performance.now(); });
            })() : Promise.resolve();
            // Fixed pacing is part of the workload, not a persistence wait.
            const work = await Promise.allSettled([page.keyboard.type(marker, { delay: 40 }), writes]);
            for (const result of work) if (result.status === "rejected") throw result.reason;
            phase.workloadObservedMs = performance.now() - started;
            phase.measurementStage = "persistence";
            await expect(editor.locator("p").first()).toContainText(marker);
            await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
            await expect.poll(() => readFile(join(fixtureRoot, fixture.path), "utf8")).toContain(marker);
            phase.persistedContentVerified = true;
            phase.measurementStage = "activity";
            await page.waitForFunction(({ documentPath, paths }) => {
              const state = (window as PhaseWindow).richEditPhase!;
              const observed = new Set(state.activities.flatMap(entry => entry.event.paths ?? []));
              return state.saves.some(entry => entry.event.state === "saved")
                && observed.has(documentPath) && paths.every(path => observed.has(path));
            }, { documentPath: fixture.path, paths: externalPaths });
            for (const [index, path] of externalPaths.entries()) {
              expect(await readFile(join(fixtureRoot, path), "utf8")).toBe(`external write ${index}\n`);
            }
            phase.measurementStage = "table-and-focus";
            expect(await table.innerText()).toBe(tableText);
            await expect(table.locator("tr")).toHaveCount(4);
            const tableAfter = await tableShape();
            phase.tableBefore = tableBefore; phase.tableAfter = tableAfter;
            expect(Math.abs(tableAfter.width - tableBefore.width)).toBeLessThanOrEqual(0.5);
            expect(Math.abs(tableAfter.height - tableBefore.height)).toBeLessThanOrEqual(0.5);
            expect(tableAfter.cellWidths).toHaveLength(tableBefore.cellWidths.length);
            tableAfter.cellWidths.forEach((width, index) => expect(Math.abs(width - tableBefore.cellWidths[index]!)).toBeLessThanOrEqual(0.5));
            expect(await editor.evaluate(element => element.contains(document.activeElement))).toBe(true);
          },
          collect: async () => {
            const errors: Record<string, ReturnType<typeof profileError>> = {};
            let failed = false, failure: unknown;
            const collect = async (part: string, read: () => Promise<void>) => {
              try { await read(); } catch (error) {
                errors[part] = profileError(error);
                if (!failed) { failed = true; failure = error; }
              }
            };
            if (eventsStarted) await collect("after-counters", async () => {
              after = await readProfileCounters(page, workspace.workspaceId, read => { phase.afterRead = read; });
              phase.after = after;
            });
            if (eventsStarted) await collect("events", async () => {
              raw = await page.evaluate(() => {
                const { inputs, activities, saves, writerStartedMs, writerFinishedMs } = (window as PhaseWindow).richEditPhase!;
                return { inputs, activities, saves, writerStartedMs, writerFinishedMs };
              });
              phase.raw = raw; phase.typedCharacters = raw.inputs.length;
            });
            if (before && after) await collect("counter-delta", async () => {
              delta = counterPairDelta(before!, after!);
              phase.delta = delta; phase.native = delta.native;
            });
            if (started !== null) phase.elapsedMs = performance.now() - started;
            if (capture) await collect("cdp-capture", async () => { Object.assign(phase, await capture!.stop()); });
            await collect("event-cleanup", async () => { await page.evaluate(() => { (window as PhaseWindow).richEditPhase?.stop(); }); });
            if (failed) { phase.evidenceErrors = errors; throw failure; }
          },
          verify: async () => {
            phase.measurementStage = "input-and-native-validation";
            if (!raw || !delta) throw new Error("Phase input or counter evidence unavailable.");
            const events = raw;
            const inputsDuringWrites = events.writerStartedMs !== null && events.writerFinishedMs !== null
              ? events.inputs.filter(input => input.trusted && input.atMs >= events.writerStartedMs! && input.atMs <= events.writerFinishedMs!).length : 0;
            phase.inputsDuringWrites = inputsDuringWrites;
            if (concurrent) expect(inputsDuringWrites).toBeGreaterThan(0);
            expect(events.inputs).toHaveLength(marker.length);
            expect(events.inputs.every(input => input.trusted)).toBe(true);
            const uniqueSavedNotifications = new Set(events.saves.filter(entry => entry.event.state === "saved")
              .map(entry => `${entry.event.sessionId}:${entry.event.seq}`)).size;
            phase.uniqueSavedNotifications = uniqueSavedNotifications;
            phase.countersPerSavedNotification = {
              main: countersPerSavedNotification(delta.main, uniqueSavedNotifications),
              renderer: countersPerSavedNotification(delta.renderer, uniqueSavedNotifications),
            };
            expect(delta.native.status, JSON.stringify(delta.native)).toBe("available");
            phase.measurementStage = "complete";
          },
        });
      }
      await writeProfileArtifact("save-amplification-profile", { schemaVersion: 4, diagnostic: true, complete: cases.length === 2, measurements: { cases } });
    } finally { await context.close(); }
  }
});
