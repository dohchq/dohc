// RETEST INSTRUMENTATION (never merge): diagnostic probes for the Restore shared file retest (#2761, #3090).
// Every probe records annotations or attachments, has its own deadline, and never fails the test.
import type { Page, TestInfo } from "@playwright/test";
import type { DohcDesktopBridge, NoticeRow } from "../../src/ipc/bridgeContract";
import { withEngineDb } from "./engineDb";
import { readHistoryMoments } from "./history";

const COULD_NOT_UPDATE = /could not update/;
const PROBE_MS = 10_000;
// How long the closing probes wait before reading History again, to see whether a credited row arrives late.
const LATE_READ_MS = 120_000;
// What the closing probes add to the test's timeout: the late read, two rounds of probes, and room for teardown.
const CLOSING_BUDGET_MS = 300_000;
const fail = (error: unknown) => String(error).slice(0, 2000);

function withDeadline<T>(promise: Promise<T>, what: string, ms = PROBE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} gave no answer in ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** The owner's whole History for the note: a summary of each row as an annotation, every record as an attachment. */
export async function recordHistory(page: Page, info: TestInfo, workspaceId: string, path: string, when: string): Promise<void> {
  const name = `RETEST owner History ${when}`;
  try {
    const moments = await withDeadline(readHistoryMoments(page, workspaceId, path), "History", 30_000);
    if (moments === null) {
      info.annotations.push({ type: name, description: "History gave no list" });
      return;
    }
    info.annotations.push({ type: name, description: JSON.stringify(moments.map(row => ({
      id: row.id, origin: row.origin, authors: row.authors ?? [], momentOrder: row.momentOrder,
      recordedAt: new Date(row.recordedAtMs).toISOString(), operation: row.operation,
      names: [row.liveAuthorName, row.personAuthorName, row.agentAuthorName].filter(Boolean),
    }))) });
    await info.attach(name, { contentType: "application/json", body: JSON.stringify(moments, null, 2) });
  } catch (error) {
    info.annotations.push({ type: name, description: `read failed: ${fail(error)}` });
  }
}

/** A screenshot attachment, or an annotation saying why there is none. */
export async function attachShot(page: Page, info: TestInfo, name: string): Promise<void> {
  try {
    await info.attach(name, { contentType: "image/png", body: await page.screenshot({ timeout: PROBE_MS }) });
  } catch (error) {
    info.annotations.push({ type: `RETEST no screenshot ${name}`, description: fail(error) });
  }
}

/**
 * Every "could not update" notice the app lists, with its full title, body and detail, then each of those rows in
 * Notices with Details open, as the person sees it.
 */
export async function recordCouldNotUpdate(page: Page, info: TestInfo, who: string, when: string): Promise<void> {
  const type = `RETEST notice ${who} ${when}`;
  let rows: NoticeRow[];
  try {
    const listed = await withDeadline(page.evaluate(() =>
      (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.listNotices({})), "listNotices");
    rows = listed.notices.filter(row =>
      row.kind === "sync-refusal" || COULD_NOT_UPDATE.test(row.title) || COULD_NOT_UPDATE.test(row.body));
    info.annotations.push({ type, description: rows.length === 0
      ? `none of ${listed.notices.length} notices`
      : JSON.stringify(rows.map(row => ({ noticeId: row.noticeId, kind: row.kind, title: row.title, body: row.body, detail: row.detail ?? null,
        created: new Date(row.createdAtMs).toISOString(), read: row.readAtMs !== null, store: row.store }))) });
  } catch (error) {
    info.annotations.push({ type, description: `listNotices failed: ${fail(error)}` });
    return;
  }
  if (rows.length === 0) return;
  const toggle = page.getByTestId("notice-center-toggle");
  const center = page.getByTestId("notice-center");
  try {
    if (!await center.isVisible()) await toggle.click({ timeout: PROBE_MS });
    await center.waitFor({ timeout: PROBE_MS });
    for (const [index, listed] of rows.entries()) {
      const rowType = `${type} in Notices with Details ${listed.noticeId}`;
      try {
        // The row by its notice's identity, or else the same position among rows with the same text.
        const byId = center.getByTestId(`notice-${listed.noticeId}`);
        const row = await byId.count() > 0 ? byId.first() : center.locator("[data-notice-row]").filter({ hasText: COULD_NOT_UPDATE }).nth(index);
        await row.waitFor({ timeout: PROBE_MS });
        const details = row.getByRole("button", { name: "Details", exact: true });
        if (await details.count() > 0) await details.first().click({ timeout: PROBE_MS });
        info.annotations.push({ type: rowType, description: `${await byId.count() > 0 ? "by id" : `by text, position ${index}`}: ${await row.innerText({ timeout: PROBE_MS })}` });
      } catch (error) {
        info.annotations.push({ type: rowType, description: `could not open it: ${fail(error)}` });
      }
    }
    await attachShot(page, info, `${type} in Notices`);
  } catch (error) {
    info.annotations.push({ type: `${type} in Notices`, description: `could not open Notices: ${fail(error)}` });
  } finally {
    if (await center.isVisible().catch(() => false)) await toggle.click({ timeout: PROBE_MS }).catch(() => undefined);
  }
}

/** The engine's own record of every refused change, with the whole logged change it refused, as an attachment. */
export async function recordEngineRefusals(rootPath: string, info: TestInfo, who: string, when: string): Promise<void> {
  const name = `RETEST engine refusals ${who} ${when}`;
  try {
    const found = withEngineDb(rootPath, db => db.prepare("SELECT * FROM replication_pending_refusals").all().map(refusal => ({
      refusal,
      logged: db.prepare("SELECT * FROM replication_log WHERE workspace_id=? AND origin_id=? AND origin_seq=?")
        .all(refusal.workspace_id as string, refusal.origin_id as string, refusal.origin_seq as number),
    })));
    info.annotations.push({ type: name, description: found === null ? "no engine database" : `${found.length} refusals; rows attached` });
    if (found !== null) await info.attach(name, { contentType: "application/json", body: JSON.stringify(found, null, 2) });
  } catch (error) {
    info.annotations.push({ type: name, description: `read failed: ${fail(error)}` });
  }
}

/**
 * Watches one window's note every 250 ms and records each change of its save state and editability, with the time.
 * The first read-only one gets its own annotation; the run's report maps that time to the step it fell in.
 * The returned stop waits for a check in flight, and nothing is recorded after it.
 */
export function watchReadOnly(page: Page, info: TestInfo, who: string): () => Promise<void> {
  let last = "";
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  let readOnly = false;
  const timer = setInterval(() => {
    if (inFlight || stopped) return;
    inFlight = withDeadline(page.evaluate(() => {
      const chip = document.querySelector('[data-testid="markdown-save-state"]');
      const editor = document.querySelector('[data-testid="markdown-editor"]');
      const editable = editor?.matches("[contenteditable]") ? editor : editor?.querySelector("[contenteditable]");
      return {
        state: chip ? chip.getAttribute("data-state") : "absent",
        text: chip ? [chip.textContent ?? "", chip.getAttribute("title") ?? "", chip.getAttribute("aria-label") ?? ""].filter(Boolean).join(" | ") : null,
        editable: editable ? editable.getAttribute("contenteditable") : editor ? "no contenteditable" : "no editor",
      };
    }), "save-state check").then(now => {
      const key = JSON.stringify(now);
      if (stopped || key === last) return;
      last = key;
      const at = new Date().toISOString();
      info.annotations.push({ type: `RETEST ${who} save state`, description: `${at} ${key}` });
      if (!readOnly && (now.state === "read-only" || now.editable === "false")) {
        readOnly = true;
        info.annotations.push({ type: `RETEST ${who} first read-only`, description: `${at} ${key}` });
      }
    }).catch(() => undefined).finally(() => { inFlight = undefined; });
  }, 250);
  return async () => {
    if (stopped) return;
    clearInterval(timer);
    await inFlight;
    stopped = true;
    if (!readOnly) info.annotations.push({ type: `RETEST ${who} first read-only`, description: "never, while watched" });
  };
}

/**
 * The closing probes: stop the watch, then the owner's History, both apps' notices and engine refusals, and History
 * and the owner's refusals again two minutes later. Runs once, at the fixme or, when
 * the test fails before it, before teardown closes the apps.
 */
export function closingProbes(info: TestInfo): {
  set: (probe: { stopWatching: () => Promise<void>; owner: Page; recipient: Page; ownerRoot: string; recipientRoot: string; workspaceId: string; path: string }) => void;
  run: (when: string) => Promise<void>;
} {
  let pending: Parameters<ReturnType<typeof closingProbes>["set"]>[0] | undefined;
  return {
    set: probe => { pending = probe; },
    run: async when => {
      const probe = pending;
      pending = undefined;
      if (!probe) return;
      // Its own time on top of the test's: the late read alone takes two minutes, and a failure can come late.
      info.setTimeout(info.timeout + CLOSING_BUDGET_MS);
      await probe.stopWatching();
      await recordHistory(probe.owner, info, probe.workspaceId, probe.path, when);
      await recordCouldNotUpdate(probe.owner, info, "owner", when);
      await recordCouldNotUpdate(probe.recipient, info, "recipient", when);
      await recordEngineRefusals(probe.ownerRoot, info, "owner", when);
      await recordEngineRefusals(probe.recipientRoot, info, "recipient", when);
      // Does a credited row ever arrive? Read History and the refusals again after a longer wait.
      await new Promise(resolve => setTimeout(resolve, LATE_READ_MS));
      const later = `${when}, ${LATE_READ_MS / 1000} s later`;
      await recordHistory(probe.owner, info, probe.workspaceId, probe.path, later);
      await recordEngineRefusals(probe.ownerRoot, info, "owner", later);
    },
  };
}
