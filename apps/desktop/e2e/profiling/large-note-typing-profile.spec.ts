import { expect, test, type Page } from "@playwright/test";
import type { CDPSession, ElectronApplication } from "playwright";
import { execFile } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { launchDesktopApp } from "../helpers/desktopApp";
import { startCdpCapture } from "./cdpCapture";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "../helpers/workspace";

const exec = promisify(execFile);
const SECTIONS = 400;
const SAMPLES = Number(process.env.DOHC_LARGE_NOTE_SAMPLES ?? 60);
const WARMUPS = 5;
const KEY_INTERVAL_MS = Number(process.env.DOHC_LARGE_NOTE_KEY_INTERVAL_MS ?? 100);
const TRACE = process.env.DOHC_LARGE_NOTE_TRACE === "1";
// "timeline" records a Chromium trace of the measured keys instead: layout, style and paint times.
const TIMELINE = process.env.DOHC_LARGE_NOTE_TRACE === "timeline";
// "open" traces every process from the click that opens a note until its caret is placed.
const OPEN_TRACE = process.env.DOHC_LARGE_NOTE_TRACE === "open";
// "0" turns the spellchecker off for the run, to measure what it costs.
const SPELLCHECK = process.env.DOHC_LARGE_NOTE_SPELLCHECK !== "0";
// Extra Chromium switches for a controlled comparison, separated by spaces.
// CSS added to the page for a controlled comparison, such as hiding one kind of widget.
const EXTRA_CSS = process.env.DOHC_LARGE_NOTE_CSS ?? "";
const SWITCHES = (process.env.DOHC_LARGE_NOTE_SWITCHES ?? "").split(" ").filter(Boolean);
// Alternate order to expose host drift instead of favoring one note.
const ORDER = (process.env.DOHC_LARGE_NOTE_ORDER ?? "small,plain,rich,rich,plain,small").split(
  ",",
) as Kind[];

type Kind = "small" | "plain" | "rich";
type InputTiming = { totalMs: number; inputMs: number; frameMs: number; queuedMs: number };
type ProcessRow = { pid: number; name: string; commandLine: string | null; cpuMs: number };

const sentence = (i: number) =>
  `Section ${i} keeps a paragraph of ordinary prose with a [[note-${i % 37}]] link, some **bold** text and a value of ${i * 17}.`;

// The #2260 note: every section has a heading, a code block, a callout and a
// table, and every fifth has a diagram. `plain` has the same size in headings
// and paragraphs only, so the two separate the block plugins from note size.
function note(kind: Kind): string {
  if (kind === "small")
    return Array.from({ length: 12 }, (_, i) => `## Heading ${i}\n\n${sentence(i)}\n`).join("\n");
  const sections: string[] = [];
  for (let i = 0; i < SECTIONS; i++) {
    if (kind === "plain") {
      sections.push(
        `## Heading ${i}\n\n${[0, 1, 2, 3].map((n) => sentence(i * 4 + n)).join("\n\n")}\n`,
      );
      continue;
    }
    sections.push(
      [
        `## Heading ${i}`,
        sentence(i),
        "```ts\n" +
          `export function compute${i}(input: number): number {\n  return input * ${i} + 1;\n}\n` +
          "```",
        `> [!note] Callout ${i}\n> A callout body for section ${i}.`,
        `| Name | Value | Note |\n| --- | --- | --- |\n| row ${i} | ${i * 3} | first |\n| next ${i} | ${i * 5} | second |`,
        ...(i % 5 === 0 ? ["```mermaid\ngraph TD\n  A" + i + " --> B" + i + "\n```"] : []),
      ].join("\n\n") + "\n",
    );
  }
  return sections.join("\n");
}

type KeyWindow = Window & {
  largeNoteKeys?: {
    waiting: Array<{ downAt: number; handledAt: number }>;
    samples: InputTiming[];
    stop(): void;
  };
};

// Keys arrive every KEY_INTERVAL_MS whether or not the last one has painted, as
// from a typist. Each key is timed from its event timestamp, so a key that
// waits behind earlier work counts that wait. The second frame starts after the
// first one painted, so `totalMs` is an upper bound on key-to-paint, within one frame.
async function typeKeys(session: CDPSession, page: Page, count: number): Promise<InputTiming[]> {
  await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>('[data-testid="markdown-editor"]');
    if (!editor) throw new Error("The editor is unavailable.");
    const waiting: Array<{ downAt: number; handledAt: number }> = [];
    const samples: InputTiming[] = [];
    const down = (event: KeyboardEvent) => {
      if (event.key === "x")
        waiting.push({ downAt: event.timeStamp, handledAt: performance.now() });
    };
    const input = () => {
      const key = waiting.shift();
      if (!key) return;
      const inputAt = performance.now();
      requestAnimationFrame(() => {
        const frameAt = performance.now();
        requestAnimationFrame(() =>
          samples.push({
            totalMs: performance.now() - key.downAt,
            inputMs: inputAt - key.downAt,
            frameMs: frameAt - key.downAt,
            queuedMs: key.handledAt - key.downAt,
          }),
        );
      });
    };
    editor.addEventListener("keydown", down, true);
    editor.addEventListener("input", input);
    (window as KeyWindow).largeNoteKeys = {
      waiting,
      samples,
      stop() {
        editor.removeEventListener("keydown", down, true);
        editor.removeEventListener("input", input);
      },
    };
  });
  const key = { key: "x", code: "KeyX", windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88 };
  const sent: Array<Promise<unknown>> = [];
  const startedAt = performance.now();
  for (let i = 0; i < count; i++) {
    const wait = startedAt + i * KEY_INTERVAL_MS - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    sent.push(
      session.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        ...key,
        text: "x",
        unmodifiedText: "x",
      }),
      session.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }),
    );
  }
  await Promise.all(sent);
  await page.waitForFunction(
    (expected) => (window as KeyWindow).largeNoteKeys!.samples.length >= expected,
    count,
    { timeout: 600_000, polling: 100 },
  );
  return page.evaluate(() => {
    const keys = (window as KeyWindow).largeNoteKeys!;
    keys.stop();
    return keys.samples;
  });
}

async function processes(appPid: number): Promise<ProcessRow[]> {
  if (process.platform !== "win32") return [];
  const script = resolve(
    fileURLToPath(import.meta.url),
    "../../../../../tools/perf-profiling/packaged-process-snapshot.ps1",
  );
  const { stdout } = await exec(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-File", script, "-AppProcessId", String(appPid)],
    { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  );
  return (JSON.parse(stdout) as { processes: ProcessRow[] }).processes;
}

function kindOf(row: ProcessRow, appPid: number): string {
  if (row.pid === appPid) return "main";
  if (/dohc-workspace-engine/i.test(row.name)) return "engine";
  return /--type=([\w-]+)/.exec(row.commandLine ?? "")?.[1] ?? "other";
}

/** CPU milliseconds each process kind used between two snapshots. */
function cpuDelta(before: ProcessRow[], after: ProcessRow[], appPid: number) {
  const earlier = new Map(before.map((row) => [row.pid, row.cpuMs]));
  const delta: Record<string, number> = {};
  for (const row of after) {
    const kind = kindOf(row, appPid);
    delta[kind] = (delta[kind] ?? 0) + row.cpuMs - (earlier.get(row.pid) ?? 0);
  }
  return Object.fromEntries(Object.entries(delta).map(([kind, ms]) => [kind, Math.round(ms)]));
}

type MainProfileGlobal = typeof globalThis & {
  dohcMainProfile?: import("node:inspector").Session;
};

/** Profiles the main process until the returned function is called. */
async function startMainProfile(app: ElectronApplication): Promise<() => Promise<unknown>> {
  await app.evaluate(async () => {
    const inspector = process.getBuiltinModule("node:inspector");
    const session = new inspector.Session();
    session.connect();
    (globalThis as MainProfileGlobal).dohcMainProfile = session;
    for (const method of ["Profiler.enable", "Profiler.start"] as const)
      await new Promise<void>((resolve, reject) =>
        session.post(method, (error) => (error ? reject(error) : resolve())),
      );
  });
  return () =>
    app.evaluate(async () => {
      const session = (globalThis as MainProfileGlobal).dohcMainProfile!;
      const profile = await new Promise((resolve, reject) =>
        session.post("Profiler.stop", (error, result) =>
          error ? reject(error) : resolve(result.profile),
        ),
      );
      session.disconnect();
      return profile;
    });
}

/** Waits until the page has gone `quietMs` without a long task. */
async function settle(page: Page, quietMs = 3_000): Promise<number> {
  return page.evaluate(
    (quiet) =>
      new Promise<number>((resolve) => {
        const started = performance.now();
        let last = started;
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            last = Math.max(last, entry.startTime + entry.duration);
        });
        observer.observe({ type: "longtask" });
        const timer = setInterval(() => {
          const now = performance.now();
          if (now - last < quiet && now - started < 120_000) return;
          clearInterval(timer);
          observer.disconnect();
          resolve(now - started);
        }, 100);
      }),
    quietMs,
  );
}

const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1];
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) };
};

test("@large-note-typing times keystrokes in small, plain and block-heavy notes", async ({}, testInfo) => {
  test.setTimeout(30 * 60_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let sampling = true;
  try {
    const kinds = (["small", "plain", "rich"] as const).filter((kind) => ORDER.includes(kind));
    const bytes = Object.fromEntries(kinds.map((kind) => [kind, Buffer.byteLength(note(kind))]));
    await writeWorkspaceFiles(
      workspace,
      kinds.map((kind) => ({ path: `${kind}.md`, contents: note(kind) })),
    );
    desktop = await launchDesktopApp({
      workspace,
      // Windows stops drawing a window that another one covers, and gates on this
      // host open their own windows. A covered window would read as a freeze.
      switches: [
        "--disable-features=CalculateNativeWinOcclusion",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        ...SWITCHES,
      ],
    });
    const page = desktop.page;
    // Which parts of Chromium's accessibility tree something on this computer has asked for.
    const accessibilityFeatures = async () =>
      (await desktop!.app.evaluate(({ app }) => app.getAccessibilitySupportFeatures())).join(",");
    const accessibilityAtLaunch = await accessibilityFeatures();
    const keyboard = await desktop.app.context().newCDPSession(page);
    const appPid = await desktop.app.evaluate(() => process.pid);
    if (!SPELLCHECK)
      await desktop.app.evaluate(({ session }) =>
        session.defaultSession.setSpellCheckerEnabled(false),
      );
    const opened = await openWorkspaceFromFirstRun(page, workspace);
    await page.emulateMedia({ reducedMotion: "reduce" });
    if (EXTRA_CSS) await page.addStyleTag({ content: EXTRA_CSS });
    const rounds: Array<Record<string, unknown> & { kind: Kind; samples: InputTiming[] }> = [];
    const testStartedAt = performance.now();
    // A passing test's attachments are not kept on disk, so results also go to the output folder.
    const output = process.env.DOHC_PROFILE_OUTPUT?.trim();
    if (output) await mkdir(output, { recursive: true });
    const keep = async (name: string, value: unknown) => {
      const body = JSON.stringify(value);
      await testInfo.attach(name, { body, contentType: "application/json" });
      if (output) await writeFile(join(output, name), body);
    };
    const step = (text: string) =>
      console.log(
        `[large-note] ${((performance.now() - testStartedAt) / 1000).toFixed(1)}s ${text}`,
      );
    // CPU per process kind every few seconds, to say which process a freeze belongs to.
    const cpuTimeline: Array<{ atS: number; round: number; cpuMs: Record<string, number> }> = [];
    let lastSnapshot = await processes(appPid);
    const sampler = (async () => {
      while (sampling) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const next = await processes(appPid).catch(() => null);
        if (!next) continue;
        cpuTimeline.push({
          atS: Math.round((performance.now() - testStartedAt) / 1000),
          round: rounds.length,
          cpuMs: cpuDelta(lastSnapshot, next, appPid),
        });
        lastSnapshot = next;
      }
    })();
    step(
      `accessibility at launch [${accessibilityAtLaunch}], workspace open [${await accessibilityFeatures()}]`,
    );
    for (const kind of ORDER) {
      step(`round ${rounds.length + 1}: open ${kind}.md`);
      await waitForWorkspaceFile(page, opened.workspaceId, `${kind}.md`);
      const headings = kind === "small" ? 12 : SECTIONS;
      // From before the open: main keeps working long after the note is editable.
      const stopMainProfile = TRACE ? await startMainProfile(desktop.app) : null;
      if (OPEN_TRACE)
        await desktop.app.evaluate(({ contentTracing }) =>
          contentTracing.startRecording({
            included_categories: ["toplevel", "accessibility", "ipc", "mojom", "devtools.timeline"],
          }),
        );
      const openStartedAt = performance.now();
      // A frozen window holds the click; the wait is part of what this run measures.
      await explorerRow(page, `${kind}.md`).click({ timeout: 600_000 });
      await page.waitForFunction(
        (count) => {
          const editor = document.querySelector('[data-testid="markdown-editor"]');
          return (
            editor?.getAttribute("contenteditable") === "true" &&
            editor.querySelectorAll("h2").length === count
          );
        },
        headings,
        { polling: "raf", timeout: 240_000 },
      );
      const openToEditableMs = performance.now() - openStartedAt;
      step(
        `editable after ${Math.round(openToEditableMs)} ms, accessibility [${await accessibilityFeatures()}]`,
      );
      const settledAfterMs = await settle(page);
      step(`quiet after ${Math.round(settledAfterMs)} ms`);
      const clickStartedAt = performance.now();
      const editor = page.getByTestId("markdown-editor");
      // The paragraph under the middle heading: an edit there has as much note after it as before.
      await editor
        .locator("h2")
        .nth(Math.floor(headings / 2))
        .locator("xpath=following-sibling::p[1]")
        .click({ timeout: 600_000 });
      await page.keyboard.press("End");
      const clickToCaretMs = performance.now() - clickStartedAt;
      step(
        `caret placed after ${Math.round(clickToCaretMs)} ms, accessibility [${await accessibilityFeatures()}]`,
      );
      if (OPEN_TRACE && output) {
        const recorded = await desktop.app.evaluate(({ contentTracing }) =>
          contentTracing.stopRecording(),
        );
        await copyFile(recorded, join(output, `${kind}-${rounds.length + 1}-open-trace.json`));
      }
      // The profile covers the warm-ups too: the first keys after an open are the slowest.
      const capture = TRACE ? await startCdpCapture(desktop.app, page) : null;
      const warmups = await typeKeys(keyboard, page, WARMUPS);
      step(`warm-ups ${warmups.map((sample) => Math.round(sample.totalMs)).join(", ")} ms`);
      const before = await processes(appPid);
      if (TIMELINE)
        await desktop.app.evaluate(({ contentTracing }) =>
          contentTracing.startRecording({
            included_categories: [
              "devtools.timeline",
              "disabled-by-default-devtools.timeline",
              "blink.user_timing",
              "input",
            ],
          }),
        );
      const typingStartedAt = performance.now();
      const samples = await typeKeys(keyboard, page, SAMPLES);
      const typingMs = performance.now() - typingStartedAt;
      step(`typed ${SAMPLES} keys in ${Math.round(typingMs)} ms`);
      if (TIMELINE && output) {
        const recorded = await desktop.app.evaluate(({ contentTracing }) =>
          contentTracing.stopRecording(),
        );
        await copyFile(recorded, join(output, `${kind}-${rounds.length + 1}-timeline.json`));
      }
      const captured = capture ? await capture.stop() : null;
      const afterTyping = await processes(appPid);
      const saveStartedAt = performance.now();
      await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved", {
        timeout: 600_000,
      });
      const lastKeyToSavedMs = performance.now() - saveStartedAt;
      step(`saved ${Math.round(lastKeyToSavedMs)} ms after the last key`);
      // #3219 saw main stay busy long after typing stopped; a fixed idle window shows it.
      await page.waitForTimeout(15_000);
      const afterIdle = await processes(appPid);
      // The main profile runs through the save and the idle window, where its work continues.
      if (stopMainProfile)
        await keep(`${kind}-${rounds.length + 1}-main-cpu.json`, await stopMainProfile());
      rounds.push({
        kind,
        openToEditableMs,
        settledAfterMs,
        clickToCaretMs,
        typingMs,
        lastKeyToSavedMs,
        cpuMsWhileTyping: cpuDelta(before, afterTyping, appPid),
        cpuMsIn15sAfterSave: cpuDelta(afterTyping, afterIdle, appPid),
        // True once something on the computer asked Chromium for its accessibility tree.
        accessibility: await accessibilityFeatures(),
        warmups,
        samples,
      });
      if (captured) await keep(`${kind}-${rounds.length}-renderer-cpu.json`, captured);
    }
    sampling = false;
    await sampler;
    expect(
      desktop.logs.filter(
        (entry) => entry.level === "pageerror" || entry.text.includes("ydoc-seed-too-large"),
      ),
    ).toEqual([]);
    const result = {
      sections: SECTIONS,
      bytes,
      warmupsPerRound: WARMUPS,
      samplesPerRound: SAMPLES,
      method: "key event timestamp to changed input, to the first frame, and to the second frame",
      keyIntervalMs: KEY_INTERVAL_MS,
      profiling: TRACE,
      spellcheck: SPELLCHECK,
      switches: SWITCHES,
      extraCss: EXTRA_CSS,
      host: {
        platform: process.platform,
        cpu: cpus()[0]?.model,
        logicalProcessors: cpus().length,
        totalMemoryBytes: totalmem(),
        freeMemoryBytes: freemem(),
        node: process.version,
      },
      ...Object.fromEntries(
        kinds.map((kind) => {
          const mine = rounds.filter((round) => round.kind === kind);
          const samples = mine.flatMap((round) => round.samples);
          return [
            kind,
            {
              toSecondFrame: stats(samples.map((sample) => sample.totalMs)),
              toFirstFrame: stats(samples.map((sample) => sample.frameMs)),
              toInput: stats(samples.map((sample) => sample.inputMs)),
              queued: stats(samples.map((sample) => sample.queuedMs)),
              openToEditableMs: mine.map((round) => round.openToEditableMs),
              lastKeyToSavedMs: mine.map((round) => round.lastKeyToSavedMs),
            },
          ];
        }),
      ),
      rounds,
      cpuTimeline,
    };
    console.log(JSON.stringify({ ...result, rounds: undefined, cpuTimeline: undefined }));
    await keep("large-note-typing.json", result);
  } finally {
    sampling = false;
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});
