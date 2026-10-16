import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "@dohc/workspace-auth/smtp";
import { runSnapshotJobOnce } from "./relaySnapshotJob";

const hour = 60 * 60 * 1000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function job(options: { heartbeatUrl?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dohc-snapshot-job-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const emails: EmailMessage[] = [], pings: string[] = [];
  let clock = Date.parse("2026-10-17T00:00:00Z"), failing: string | undefined, emailDown = false;
  const statePath = join(root, "notifications.json");
  // Every pass builds fresh dependencies and reads persisted state, as after a container restart.
  const pass = async (advance = hour) => {
    clock += advance;
    return runSnapshotJobOnce({ statePath, alertEmail: "operator@team.invalid", serverName: "Team server", ...options }, {
      snapshot: async () => { if (failing) throw new Error(failing); return "namespace/snapshot.dohc-snapshot"; },
      sendEmail: async message => { if (emailDown) throw new Error("SMTP down"); emails.push(message); },
      ping: async url => { pings.push(url); },
      now: () => new Date(clock),
      log: () => {},
    });
  };
  return { emails, pings, statePath, pass, fail: (reason?: string) => { failing = reason; }, emailDown: (down: boolean) => { emailDown = down; } };
}

describe("snapshot job notifications", () => {
  it("emails one failure a day, then one recovery", async () => {
    const j = job();
    expect(await j.pass()).toBe(true);
    j.fail("Snapshot storage refused the upload (HTTP 403 AccessDenied).");
    expect(await j.pass()).toBe(false);
    expect(j.emails.map(email => email.subject)).toEqual(["Relay snapshots are failing on Team server"]);
    expect(j.emails[0]!.to).toBe("operator@team.invalid");
    expect(j.emails[0]!.text).toContain("HTTP 403 AccessDenied");
    for (let index = 0; index < 23; index++) await j.pass();
    expect(j.emails).toHaveLength(1);
    await j.pass();
    expect(j.emails).toHaveLength(2);
    j.fail(undefined);
    await j.pass();
    await j.pass();
    expect(j.emails.map(email => email.subject)).toEqual([
      "Relay snapshots are failing on Team server", "Relay snapshots are failing on Team server", "Relay snapshots work again on Team server"]);
    expect(j.emails[2]!.text).toContain("failed since 2026-10-17T02:00:00.000Z");
  });

  it("keeps the daily limit across a recovery", async () => {
    const j = job();
    j.fail("first");
    await j.pass();
    j.fail(undefined);
    await j.pass();
    j.fail("second");
    await j.pass();
    expect(j.emails.map(email => email.subject.split(" ")[3])).toEqual(["failing", "again"]);
    await j.pass(23 * hour);
    expect(j.emails).toHaveLength(3);
  });

  it("retries an unsent failure email and sends no recovery for an unsent failure", async () => {
    const j = job();
    j.fail("broken");
    j.emailDown(true);
    await j.pass();
    j.fail(undefined);
    await j.pass();
    j.emailDown(false);
    await j.pass();
    expect(j.emails).toEqual([]);
    j.fail("broken");
    j.emailDown(true);
    await j.pass();
    j.emailDown(false);
    await j.pass();
    expect(j.emails).toHaveLength(1);
  });

  it("retries an unsent recovery email at the next success", async () => {
    const j = job();
    j.fail("broken");
    await j.pass();
    j.fail(undefined);
    j.emailDown(true);
    await j.pass();
    j.emailDown(false);
    await j.pass();
    await j.pass();
    expect(j.emails.map(email => email.subject.split(" ")[3])).toEqual(["failing", "again"]);
  });

  it("pings the heartbeat only after a successful snapshot", async () => {
    const j = job({ heartbeatUrl: "https://heartbeat.invalid/ping" });
    await j.pass();
    j.fail("broken");
    await j.pass();
    expect(j.pings).toEqual(["https://heartbeat.invalid/ping"]);
  });

  it("starts again from unreadable state instead of stopping snapshots", async () => {
    const j = job();
    writeFileSync(j.statePath, "{");
    j.fail("broken");
    await j.pass();
    expect(j.emails).toHaveLength(1);
    expect(JSON.parse(readFileSync(j.statePath, "utf8")).recoveryEmailOwed).toBe(true);
  });
});
