// RETEST INSTRUMENTATION (never merge): diagnostic probes for the Restore shared file retest (#2761, #3090).
// Every probe records annotations and never fails the test.
import type { Page, TestInfo } from "@playwright/test";
import type { DohcDesktopBridge } from "../../src/ipc/bridgeContract";
import { withEngineDb } from "./engineDb";

const COULD_NOT_UPDATE = /could not update/;
const fail = (error: unknown) => String(error).slice(0, 2000);

/**
 * Every "could not update" notice the app lists, with its full title, body and detail, then the same row in Notices
 * with Details open, as the person sees it.
 */
export async function recordCouldNotUpdate(page: Page, info: TestInfo, who: string, when: string): Promise<void> {
  const type = `RETEST notice ${who} ${when}`;
  let rows: { title: string; body: string }[] = [];
  try {
    const listed = await page.evaluate(() =>
      (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.listNotices({}));
    const matching = listed.notices.filter(row =>
      row.kind === "sync-refusal" || COULD_NOT_UPDATE.test(row.title) || COULD_NOT_UPDATE.test(row.body));
    rows = matching;
    info.annotations.push({ type, description: matching.length === 0
      ? `none of ${listed.notices.length} notices`
      : JSON.stringify(matching.map(row => ({ kind: row.kind, title: row.title, body: row.body, detail: row.detail ?? null,
        created: new Date(row.createdAtMs).toISOString(), read: row.readAtMs !== null, store: row.store }))) });
  } catch (error) {
    info.annotations.push({ type, description: `listNotices failed: ${fail(error)}` });
    return;
  }
  if (rows.length === 0) return;
  const toggle = page.getByTestId("notice-center-toggle");
  const center = page.getByTestId("notice-center");
  try {
    if (!await center.isVisible()) await toggle.click({ timeout: 10_000 });
    const row = center.locator("[data-notice-row]").filter({ hasText: COULD_NOT_UPDATE }).first();
    await row.waitFor({ timeout: 10_000 });
    const details = row.getByRole("button", { name: "Details", exact: true });
    if (await details.count() > 0) await details.first().click({ timeout: 10_000 });
    info.annotations.push({ type: `${type} in Notices with Details`, description: await row.innerText({ timeout: 10_000 }) });
    await info.attach(`${type} in Notices`, { contentType: "image/png", body: await page.screenshot() });
  } catch (error) {
    info.annotations.push({ type: `${type} in Notices with Details`, description: `could not open it: ${fail(error)}` });
  } finally {
    if (await center.isVisible().catch(() => false)) await toggle.click({ timeout: 10_000 }).catch(() => undefined);
  }
}

/** The engine's own record of every refused change, with the logged change it refused. */
export function recordEngineRefusals(rootPath: string, info: TestInfo, who: string, when: string): void {
  try {
    const found = withEngineDb(rootPath, db => db.prepare("SELECT * FROM replication_pending_refusals").all().map(refusal => ({
      refusal,
      logged: db.prepare("SELECT origin_id, origin_seq, op_kind, apply_disposition, recorded_at_ms, length(payload_json) AS payload_bytes " +
        "FROM replication_log WHERE workspace_id=? AND origin_id=? AND origin_seq=?")
        .all(refusal.workspace_id as string, refusal.origin_id as string, refusal.origin_seq as number),
    })));
    info.annotations.push({ type: `RETEST engine refusals ${who} ${when}`, description: JSON.stringify(found) });
  } catch (error) {
    info.annotations.push({ type: `RETEST engine refusals ${who} ${when}`, description: `read failed: ${fail(error)}` });
  }
}

/**
 * Watches one window's note every 250 ms and records each change of its save state and editability, with the time.
 * The first read-only one gets its own annotation; the run's report maps that time to the step it fell in.
 */
export function watchReadOnly(page: Page, info: TestInfo, who: string): () => void {
  let last = "";
  let busy = false;
  let readOnly = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    page.evaluate(() => {
      const chip = document.querySelector('[data-testid="markdown-save-state"]');
      const editor = document.querySelector('[data-testid="markdown-editor"]');
      const editable = editor?.matches("[contenteditable]") ? editor : editor?.querySelector("[contenteditable]");
      return {
        state: chip ? chip.getAttribute("data-state") : "absent",
        text: chip ? [chip.textContent ?? "", chip.getAttribute("title") ?? "", chip.getAttribute("aria-label") ?? ""].filter(Boolean).join(" | ") : null,
        editable: editable ? editable.getAttribute("contenteditable") : editor ? "no contenteditable" : "no editor",
      };
    }).then(now => {
      const key = JSON.stringify(now);
      if (key === last) return;
      last = key;
      const at = new Date().toISOString();
      info.annotations.push({ type: `RETEST ${who} save state`, description: `${at} ${key}` });
      if (!readOnly && (now.state === "read-only" || now.editable === "false")) {
        readOnly = true;
        info.annotations.push({ type: `RETEST ${who} first read-only`, description: `${at} ${key}` });
      }
    }).catch(() => undefined).finally(() => { busy = false; });
  }, 250);
  return () => {
    clearInterval(timer);
    if (!readOnly) info.annotations.push({ type: `RETEST ${who} first read-only`, description: "never, while watched" });
  };
}
