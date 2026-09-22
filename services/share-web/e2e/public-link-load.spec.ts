import { test, expect, type Browser, type Frame, type TestInfo } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cpus, freemem, loadavg, platform, totalmem } from "node:os";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { actualFundraiserFixture, syntheticReceipt, viewerOrigin } from "./actualFundraiserFixture";
import { loadRequest, publicLoadBrowser, type BrokerReply } from "./publicLoadBrowser";

const enabled = process.env.DOHC_PUBLIC_LINK_LOAD === "1";
const participants = 100, durationMs = 5 * 60_000;
type Sample = {participant: number | "organizer" | "adverse"; operation: string; elapsedMs: number; status: number; code?: string};

async function open(browser: Browser) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(`${viewerOrigin}/fixture-open`);
    await page.getByRole("button", {name: "Open", exact: true}).click();
    await expect(page).toHaveURL(/^https:\/\/[a-f0-9]{48}\.example\.net\/bootstrap$/);
    await expect(page.frameLocator("iframe").locator("body")).toHaveAttribute("data-ready", "true");
    const frame = page.frames().find(frame => frame !== page.mainFrame());
    if (!frame) throw Error("App frame unavailable");
    return {context, frame};
  } catch (error) {await context.close(); throw error;}
}

async function sampled(samples: Sample[], participant: Sample["participant"], frame: Frame, operation: string, input: unknown = {}, idempotencyKey = randomUUID()) {
  const started = performance.now();
  const reply = await loadRequest(frame, {op: "backend.invoke", operation, input, idempotencyKey});
  samples.push({participant, operation, elapsedMs: performance.now() - started, status: reply.ok ? 200 : reply.status ?? 0, code: reply.error?.code});
  return reply;
}

async function journey(samples: Sample[], index: number, frame: Frame, fundraiser: boolean, seats = 1) {
  expect((await sampled(samples, index, frame, fundraiser ? "listPublicSessions" : "availability")).ok).toBe(true);
  const uploadStarted = performance.now();
  const upload = await loadRequest(frame, {op: "backend.upload", idempotencyKey: randomUUID(), name: "receipt.pdf", contentType: "application/pdf", bytesBase64: syntheticReceipt.toString("base64")});
  samples.push({participant: index, operation: "upload", elapsedMs: performance.now() - uploadStarted, status: upload.ok ? 200 : upload.status ?? 0});
  expect(upload.ok).toBe(true);
  const input = fundraiser ? {submissionId: randomUUID(), retrySecret: randomBytes(32).toString("base64url"),
    receiptSha256: createHash("sha256").update(syntheticReceipt).digest("hex"), receiptFileId: upload.value.file.fileId,
    fullName: `Load Friend${index}`, mobile: "09171234567", paymentMethod: "gcash",
    sessions: [{sessionId: "s1", players: Array.from({length:seats},(_,seat)=>`Player Person${index}seat${seat}`), spectators: []}]} : {fileId: upload.value.file.fileId};
  const submitted = await sampled(samples, index, frame, fundraiser ? "register" : "submit", input);
  if (!submitted.ok) {
    expect(fundraiser).toBe(true);
    expect(submitted).toMatchObject({status: 409, error: {code: "capacity_unavailable"}});
  }
  const token = submitted.ok ? submitted.value.result.statusToken : randomBytes(32).toString("base64url");
  const status = await sampled(samples, index, frame, fundraiser ? "lookupStatus" : "status", {token});
  if (submitted.ok) {expect(status.ok).toBe(true); expect(status.value.result.id).toBe(submitted.value.result.id);}
  else expect(status).toMatchObject({ok: false, status: 409, error: {code: "not_found"}});
  return submitted.ok;
}

async function evidence(info: TestInfo, samples: Sample[], extra: Record<string, unknown>) {
  const timings = [...new Set(samples.map(sample => sample.operation))].map(operation => {
    const rows = samples.filter(sample => sample.operation === operation), times = rows.map(row => row.elapsedMs).sort((a,b) => a-b);
    const percentile = (p: number) => times[Math.min(times.length-1, Math.ceil(times.length*p)-1)];
    return {operation, count: rows.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: times.at(-1),
      statuses: rows.reduce<Record<string,number>>((counts,row) => {counts[row.status] = (counts[row.status] ?? 0)+1; return counts;}, {})};
  });
  const path = info.outputPath("public-link-load-evidence.json");
  await writeFile(path, JSON.stringify({
    commit: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8", windowsHide: true}).trim(),
    node: process.version, platform: platform(), cpu: cpus()[0]?.model, cpuCount: cpus().length,
    totalMemory: totalmem(), freeMemory: freemem(), hostLoad: loadavg(), memory: process.memoryUsage(),
    measuredThrough: "Chromium sandbox broker over local HTTPS; real viewer, relay, SQLite and isolated runtime; fixture account identity",
    antivirusStatus: "not measured", queueWait: "not instrumented", commitTime: "not instrumented", uiStalls: "not instrumented",
    ...extra, timings, samples,
  }, null, 2));
  await info.attach("public-link-load-evidence", {contentType: "application/json", path});
}

for (const scenario of ["generic", "fundraiser"] as const) {
  test(`public link load: ${scenario}, 100 profiles over five minutes`, async ({}, info) => {
    test.skip(!enabled, "Opt-in five-minute acceptance load: DOHC_PUBLIC_LINK_LOAD=1");
    test.setTimeout(durationMs + 120_000);
    const fixture = await actualFundraiserFixture({loadScenario: scenario});
    const samples: Sample[] = [], started = performance.now();
    let host: Awaited<ReturnType<typeof publicLoadBrowser>> | undefined;
    let active = 0, peakActive = 0, accepted = 0;
    const errors: string[] = [];
    try {
      host = await publicLoadBrowser(fixture);
      const browser = host.browser, scheduleStart = performance.now();
      // This timer defines the offered traffic, rather than waiting for a test assertion to pass.
      await Promise.all(Array.from({length: participants}, (_, index) => new Promise<void>(resolve => setTimeout(resolve,
        Math.max(0, scheduleStart + index * durationMs / (participants - 1) - performance.now()))).then(async () => {
        if (active >= 8) {errors.push(`Participant ${index}: eight-journey concurrency bound exceeded`); return;}
        active++; peakActive = Math.max(peakActive, active);
        let client: Awaited<ReturnType<typeof open>> | undefined;
        try {client = await open(browser); if (await journey(samples, index, client.frame, scenario === "fundraiser")) accepted++;}
        catch (error) {errors.push(`Participant ${index}: ${String(error)}`);}
        finally {await client?.context.close(); active--;}
      })));
      expect(errors).toEqual([]); expect(host.failures).toEqual([]);
      expect(samples).toHaveLength(participants * 4);
      expect(samples.filter(sample => ![200,409].includes(sample.status))).toEqual([]);
      expect(accepted).toBe(scenario === "generic" ? 100 : 36);
      expect(fixture.counts()).toMatchObject({profiles: 100, participants: 100, receipts: accepted});
      if (scenario === "generic") expect((await fixture.ownerRead("list")).result).toHaveLength(100);
      else {
        expect((await fixture.ownerRead("listRegistrations", {limit:100})).result.records).toHaveLength(36);
        expect((await fixture.ownerRead("listPublicSessions")).result[0]).toMatchObject({available:0,reserved:36,capacity:36});
      }
    } finally {
      await evidence(info, samples, {scenario, participants, offeredDurationMs: durationMs, elapsedMs: performance.now()-started,
        peakActive, accepted, errors, counts: fixture.counts(), compiler: fixture.compiler});
      await host?.close(); await fixture.close();
    }
  });
}

test("public link abuse: one repeated client does not consume organizer or another participant's allowance", async ({}, info) => {
  test.skip(!enabled, "Opt-in acceptance abuse run: DOHC_PUBLIC_LINK_LOAD=1");
  test.setTimeout(90_000);
  const fixture = await actualFundraiserFixture({loadScenario:"generic"}), samples: Sample[] = [];
  let host: Awaited<ReturnType<typeof publicLoadBrowser>> | undefined;
  try {
    host = await publicLoadBrowser(fixture);
    const adverse = await open(host.browser), normal = await open(host.browser);
    try {
      const attack = async () => {const replies: BrokerReply[] = []; for (let index=0;index<45;index++) replies.push(await sampled(samples,"adverse",adverse.frame,"availability")); return replies;};
      const organizer = async () => {for(let index=0;index<10;index++) {const start=performance.now();await fixture.ownerRead("list");samples.push({participant:"organizer",operation:"list",status:200,elapsedMs:performance.now()-start});}};
      const [replies, accepted] = await Promise.all([attack(), journey(samples,0,normal.frame,false), organizer()]);
      expect(accepted).toBe(true); expect(replies.some(reply => reply.status === 429)).toBe(true);
      expect(replies.every(reply => reply.ok || reply.status === 429)).toBe(true);
      expect(samples.filter(sample => sample.participant !== "adverse").every(sample => sample.status === 200)).toBe(true);
      expect(host.failures).toEqual([]);
    } finally {await adverse.context.close(); await normal.context.close();}
  } finally {await evidence(info,samples,{scenario:"separate-abuse",counts:fixture.counts()});await host?.close();await fixture.close();}
});

test("public link load harness: fundraiser business refusals preserve capacity", async ({}, info) => {
  test.skip(!enabled, "Opt-in load harness check: DOHC_PUBLIC_LINK_LOAD=1");
  test.setTimeout(90_000);
  const fixture = await actualFundraiserFixture({loadScenario:"fundraiser"}), samples: Sample[] = [];
  let host: Awaited<ReturnType<typeof publicLoadBrowser>> | undefined;
  try {
    host = await publicLoadBrowser(fixture);
    for (let index=0;index<2;index++) {
      const client = await open(host.browser);
      try {expect(await journey(samples,index,client.frame,true,index===0?36:1)).toBe(index===0);}
      finally {await client.context.close();}
    }
    expect((await fixture.ownerRead("listPublicSessions")).result[0]).toMatchObject({available:0,reserved:36});
    expect(fixture.counts()).toEqual({profiles:2,participants:2,receipts:1});
    expect(host.failures).toEqual([]);
  } finally {await evidence(info,samples,{scenario:"harness-check-not-load-evidence",counts:fixture.counts()});await host?.close();await fixture.close();}
});
