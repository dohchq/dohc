// Measurement only, never merged: how the rich editor holds up as a note grows.
import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DOCUMENT_END } from "../helpers/keys";
import { launchDesktopApp } from "../helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "../helpers/workspace";

const SIZES_KIB = (process.env.SIZES_KIB ?? "32,64,128,256").split(",").map(Number);
const RUNS = Number(process.env.RUNS ?? "2");
const TYPED = "measure the editor while it holds a large note";
const RICH = '[data-testid="markdown-editor"].dohc-notion-editor';

// The parts of Tiptap's editor this measurement drives from the page.
type TiptapHost = {
  editor?: {
    commands: {
      insertContentAt(at: number, value: string): boolean;
      setTextSelection(at: number): boolean;
      scrollIntoView(): boolean;
      focus(): boolean;
    };
    state: { doc: { content: { size: number } } };
  };
};

function words(seed: number, count: number): string {
  const vocabulary = ["plan", "budget", "flight", "hotel", "notes", "review", "draft", "agenda",
    "call", "summary", "decision", "owner", "follow", "up", "later", "today", "client", "team"];
  return Array.from({ length: count }, (_, i) => vocabulary[(seed * 7 + i * 13) % vocabulary.length]).join(" ");
}

// One section is about 1.2 KB of Markdown: a heading, three paragraphs with
// inline marks, and a four-item list.
function section(i: number): { markdown: string; html: string } {
  const p1 = `${words(i, 40)} **${words(i + 1, 4)}** and [a link](https://example.com/${i}) then \`code ${i}\` ${words(i + 2, 12)}.`;
  const p2 = `${words(i + 3, 45)}.`;
  const p3 = `${words(i + 4, 35)} *${words(i + 5, 3)}*.`;
  const items = [0, 1, 2, 3].map((k) => words(i + 6 + k, 8));
  const markdown = `## Section ${i}: ${words(i, 3)}\n\n${p1}\n\n${p2}\n\n${items.map((item) => `- ${item}`).join("\n")}\n\n${p3}\n\n`;
  const inline = (text: string) => text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
    .replace(/`(.+?)`/g, "<code>$1</code>");
  const html = `<h2>Section ${i}: ${words(i, 3)}</h2><p>${inline(p1)}</p><p>${p2}</p>` +
    `<ul>${items.map((item) => `<li><p>${item}</p></li>`).join("")}</ul><p>${inline(p3)}</p>`;
  return { markdown, html };
}

function content(targetBytes: number, name: string): { html: string; sections: number } {
  let bytes = 0;
  let html = "";
  let sections = 0;
  while (bytes < targetBytes) {
    const next = section(sections);
    bytes += Buffer.byteLength(next.markdown, "utf8");
    html += next.html;
    sections += 1;
  }
  return { html: `${html}<p>END-${name}</p>`, sections };
}

type KeySamples = { frameMs: number[]; paintMs: number[]; slowEvents: number[]; longTasks: number[] };

async function installProbes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = { frameMs: [] as number[], paintMs: [] as number[], slowEvents: [] as number[], longTasks: [] as number[], keydownAt: null as number | null };
    Object.assign(window, { __probe: probe });
    document.addEventListener("keydown", (event) => { probe.keydownAt = event.timeStamp; }, true);
    document.addEventListener("input", () => {
      const start = probe.keydownAt;
      if (start === null) return;
      probe.keydownAt = null;
      requestAnimationFrame(() => {
        probe.frameMs.push(performance.now() - start);
        const channel = new MessageChannel();
        channel.port1.onmessage = () => probe.paintMs.push(performance.now() - start);
        channel.port2.postMessage(null);
      });
    }, true);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.longTasks.push(entry.duration);
    }).observe({ type: "longtask" });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "keydown" || entry.name === "keypress" || entry.name === "input") probe.slowEvents.push(entry.duration);
      }
    }).observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
  });
}

async function takeSamples(page: Page): Promise<KeySamples> {
  return await page.evaluate(() => {
    const probe = (window as unknown as { __probe: KeySamples }).__probe;
    const taken = { frameMs: probe.frameMs.splice(0), paintMs: probe.paintMs.splice(0), slowEvents: probe.slowEvents.splice(0), longTasks: probe.longTasks.splice(0) };
    return taken;
  });
}

function summary(values: number[]): { n: number; median: number; p95: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN;
  const round = (value: number) => Math.round(value * 10) / 10;
  return { n: sorted.length, median: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1) ?? NaN) };
}

async function typeAndMeasure(page: Page) {
  await takeSamples(page);
  await page.keyboard.type(TYPED, { delay: 60 });
  await page.waitForTimeout(500);
  const samples = await takeSamples(page);
  return {
    frameMs: summary(samples.frameMs),
    paintMs: summary(samples.paintMs),
    eventsOver16ms: samples.slowEvents.length,
    slowestEventMs: Math.max(0, ...samples.slowEvents),
    longTasks: samples.longTasks.length,
    longTaskMs: Math.round(samples.longTasks.reduce((sum, value) => sum + value, 0)),
  };
}

async function scrollThrough(page: Page) {
  const box = await page.locator(RICH).boundingBox();
  if (!box) throw new Error("no rich editor to scroll");
  await page.mouse.move(box.x + box.width / 2, Math.min(box.y + 200, box.y + box.height / 2));
  await page.evaluate(() => {
    const gaps: number[] = [];
    let last = performance.now();
    let running = true;
    const frame = (now: number) => { gaps.push(now - last); last = now; if (running) requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    Object.assign(window, { __scroll: { gaps, stop: () => { running = false; } } });
  });
  for (let step = 0; step < 40; step += 1) {
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(300);
  const gaps = await page.evaluate(() => {
    const scroll = (window as unknown as { __scroll: { gaps: number[]; stop(): void } }).__scroll;
    scroll.stop();
    return scroll.gaps.slice(1);
  });
  return { frames: gaps.length, framesOver50ms: gaps.filter((gap) => gap > 50).length, worstFrameMs: Math.round(Math.max(0, ...gaps)) };
}

async function timeOpen(page: Page, path: string, first: string, last: string) {
  await page.evaluate(({ rich, first, last }) => {
    const open = { down: null as number | null, firstMs: null as number | null, fullMs: null as number | null };
    Object.assign(window, { __open: open });
    document.addEventListener("mousedown", (event) => { open.down = event.timeStamp; }, { capture: true, once: true });
    const check = () => {
      if (open.down === null || open.fullMs !== null) return;
      const editor = document.querySelector(rich);
      if (!editor) return;
      const start = open.down;
      if (open.firstMs === null && editor.querySelector("h1")?.textContent?.includes(first)) {
        requestAnimationFrame(() => { open.firstMs ??= performance.now() - start; });
      }
      if (editor.lastElementChild?.textContent?.includes(last)) {
        requestAnimationFrame(() => { open.fullMs ??= performance.now() - start; });
      }
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
    const frame = () => { check(); if (open.fullMs === null) requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  }, { rich: RICH, first, last });
  await explorerRow(page, path).click();
  await expect.poll(async () => await page.evaluate(() =>
    (window as unknown as { __open: { fullMs: number | null } }).__open.fullMs), { timeout: 120_000 }).not.toBeNull();
  return await page.evaluate(() => {
    const open = (window as unknown as { __open: { firstMs: number | null; fullMs: number | null } }).__open;
    return { firstContentMs: Math.round(open.firstMs ?? NaN), fullyMountedMs: Math.round(open.fullMs ?? NaN) };
  });
}

test("measures the rich editor at growing note sizes", async () => {
  test.setTimeout(60 * 60_000);
  const temp = await createTempWorkspace();
  const order = Array.from({ length: RUNS }, (_, run) => (run % 2 === 0 ? SIZES_KIB : [...SIZES_KIB].reverse())
    .map((kib) => ({ kib, run: run + 1, name: `s${String(kib).padStart(3, "0")}-r${run + 1}` }))).flat();
  await writeWorkspaceFiles(temp, [
    { path: "other.md", contents: "# Other\n\nA small note to switch to.\n" },
    ...order.map(({ name }) => ({ path: `${name}.md`, contents: `# Size ${name}\n\nStart.\n` })),
  ]);
  const desktop = await launchDesktopApp({
    workspace: temp,
    switches: ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"],
  });
  const results: unknown[] = [];
  try {
    const { page } = desktop;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    for (const { name } of order) await waitForWorkspaceFile(page, workspace.workspaceId, `${name}.md`);
    await installProbes(page);

    for (const { kib, run, name } of order) {
      const path = `${name}.md`;
      await explorerRow(page, path).click();
      const editor = page.locator(RICH);
      await expect(editor).toContainText(`Size ${name}`, { timeout: 30_000 });
      const { html, sections } = content(kib * 1024, name);

      const fillStarted = Date.now();
      await page.evaluate(({ rich, html }) => {
        const tiptap = (document.querySelector(rich) as unknown as TiptapHost | null)?.editor;
        if (!tiptap) throw new Error("no Tiptap editor on the rich editor element");
        tiptap.commands.insertContentAt(tiptap.state.doc.content.size, html);
      }, { rich: RICH, html });
      await expect(editor).toContainText(`END-${name}`, { timeout: 60_000 });
      const fillMs = Date.now() - fillStarted;

      const saveState = page.getByTestId("markdown-save-state");
      const settleStarted = Date.now();
      await expect.poll(async () => (await readFile(join(temp.rootPath, path), "utf8").catch(() => "")).includes(`END-${name}`),
        { timeout: 180_000, intervals: [100] }).toBe(true);
      await expect(saveState).toHaveAttribute("data-state", "saved", { timeout: 60_000 });
      const settleMs = Date.now() - settleStarted;
      const fileBytes = Buffer.byteLength(await readFile(join(temp.rootPath, path), "utf8"), "utf8");

      await editor.click();
      await page.keyboard.press(DOCUMENT_END);
      const typingAtEnd = await typeAndMeasure(page);

      await page.evaluate((rich) => {
        const tiptap = (document.querySelector(rich) as unknown as TiptapHost | null)?.editor;
        if (!tiptap) throw new Error("no Tiptap editor on the rich editor element");
        const middle = Math.floor(tiptap.state.doc.content.size / 2);
        tiptap.commands.focus();
        tiptap.commands.setTextSelection(middle);
        tiptap.commands.scrollIntoView();
      }, RICH);
      const typingInMiddle = await typeAndMeasure(page);
      await expect(saveState).toHaveAttribute("data-state", "saved", { timeout: 120_000 });

      await explorerRow(page, "other.md").click();
      await expect(page.locator(RICH)).toContainText("A small note to switch to.", { timeout: 30_000 });
      const reopen = await timeOpen(page, path, `Size ${name}`, `END-${name}`);
      const stillRich = await page.locator(RICH).count();
      const scroll = await scrollThrough(page);

      const memory = await page.evaluate(() => ({
        jsHeapMb: Math.round(((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize) / 1048576),
        domNodes: document.getElementsByTagName("*").length,
      }));
      const metrics = await desktop.app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ type: m.type, workingSetMb: Math.round(m.memory.workingSetSize / 1024) })));
      const rendererMb = Math.max(0, ...metrics.filter((m) => m.type === "Tab").map((m) => m.workingSetMb));

      const result = { kib, run, name, sections, fileBytes, fillMs, settleMs, typingAtEnd, typingInMiddle, reopen, stillRich, scroll, memory, rendererMb };
      results.push(result);
      console.log(JSON.stringify(result));
    }
  } finally {
    await writeFile(process.env.RESULT_PATH ?? join(temp.rootPath, "..", "editor-size-results.json"), JSON.stringify(results, null, 2));
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
