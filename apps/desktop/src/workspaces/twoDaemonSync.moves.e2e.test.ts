
import { randomUUID } from "node:crypto";

import { existsSync } from "node:fs";

import { readdir, stat } from "node:fs/promises";

import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { liveFolderBody, LiveFolderError, LivePageOwnedError, liveFolderTitle } from "./workspaceEngineCapture";

import { MOVE_ACCEPTED_EDITS_WAIT_MS } from "./moveAcceptedEditsGuard";
import { openLiveFolderMoveFixture } from "../testing/liveFolderMoveFixture";
import { livePageBody, livePageTitle } from "../ipc/errorWords";
import { openLiveMoveFixture, recordGuardTimings, type GuardPull, type GuardTiming, type LiveMoveFixture, type MoveDevice } from "../testing/liveMoveFixture";

import { engine, compiledRelayMain, runRenameRepros } from "./twoDaemonSync.fixture";

describe.skipIf(engine.missing)("a folder move over a page the owner has live", () => {
  const page = "box/inner/page";
  const refused = async (fixture: Awaited<ReturnType<typeof openLiveFolderMoveFixture>>) => {
    const before = fixture.outbound(page);
    const moving = fixture.moveByHand("notes/box", "notes/moved");
    await expect(moving).rejects.toBeInstanceOf(LiveFolderError);
    await expect(moving).rejects.toThrow(liveFolderBody("move"));
    expect(await fixture.read(`notes/${page}.md`)).toContain(`Page ${page} body.`);
    await expect(stat(join(fixture.rootPath, "notes", "moved"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.outbound(page)).toBe(before);
  };

  it("refuses the move while the page has no edit", async () => {
    const fixture = await openLiveFolderMoveFixture({ workspaceId: `folder-owned-${randomUUID()}`, compiledRelayMain,
      engineExecutable: engine.require(), pages: [page] });
    try { await refused(fixture); } finally { await fixture.close(); }
  }, 240_000);

  it("refuses the move while an accepted edit has not reached the owner", async () => {
    const fixture = await openLiveFolderMoveFixture({ workspaceId: `folder-in-flight-${randomUUID()}`, compiledRelayMain,
      engineExecutable: engine.require(), pages: [page] });
    try {
      const owned = fixture.ownerAccepted(page);
      fixture.refuseLogPulls(true);
      await fixture.edit(page, " in flight");
      expect(fixture.ownerAccepted(page)).toBe(owned);
      await refused(fixture);
    } finally { await fixture.close(); }
  }, 240_000);
});

// #3089: before a live page moves, the guard tries to catch this device up
// with the server, so the move carries the edit the live host already accepted.
describe("the move guard over a real relay and live host", () => {
  const PROXY_DELAY_MS = 50;
  const timings: GuardTiming[] = [];
  const marker = (name: string) => ` ${name}-${randomUUID().slice(0, 8)}`;
  const RETRY_LATER = { wireCode: "OVERLOADED", message: "markdown-witness-check-pending", retry: "afterBackoff" };
  const describePull = (pull: GuardPull) => pull.result === "succeeded" ? "succeeded"
    : `refused ${pull.wireCode ?? "without a wire code"} ${pull.message} (retry ${pull.retry ?? "unknown"})`;
  const answeredRetryLater = (pull: GuardPull | undefined) => pull?.result === "failed"
    && pull.wireCode === RETRY_LATER.wireCode && pull.message === RETRY_LATER.message && pull.retry === RETRY_LATER.retry;

  // Pulls outside the relay engine until one finds nothing new, so the next
  // pull has no backlog. A pull that answers retry later is pulled again.
  async function drain(device: MoveDevice) {
    await expect.poll(async () => (await device.pull()).fetched, { timeout: 120_000 }).toBe(0);
    expect(device.syncFailed()).toBe(false);
    expect(device.backgroundPulls(), "the relay engine pulled outside a guard's catch-up").toEqual([]);
  }

  // The link holder's edit is accepted, saved and published; nothing on the
  // device has pulled it. Times only the move, and checks the guard's own wait
  // apart from the move's other work. This computer owns no page it
  // moves here: a bound move is refused (editThenRefusedMove).
  // `unbound` decides what a guarded move must show:
  // - backlog: its pull either carries the edit, or answers retry later and
  //   the move goes ahead without it, as the guard allows.
  // - drained: the device had nothing else to pull, so the pull must succeed
  //   inside the wait and carry the edit.
  async function editThenMove(fixture: LiveMoveFixture, device: MoveDevice, input: { name: string;
    guarded: boolean; proxyDelayMs: number; unbound?: "backlog" | "drained"; beforeEdit?: () => Promise<void> }) {
    const { path } = fixture.page(input.name);
    const text = marker(input.name);
    await input.beforeEdit?.();
    const cursor = await fixture.edit(input.name, text);
    await fixture.waitPublished(input.name, cursor);
    const unchanged = await fixture.read(device, path);
    expect(unchanged).not.toContain(text);
    const destination = `notes/${input.name}-moved.md`;
    const requested = device.targetedPasses();
    fixture.proxy.setDelayMs(input.proxyDelayMs);
    let elapsedMs: number;
    try { elapsedMs = await device.move(path, destination, { guarded: input.guarded }); }
    finally { fixture.proxy.setDelayMs(0); }
    // A move past the wait goes ahead while its catch-up still runs, so read once the catch-up ends.
    const guardPulls = input.guarded ? await device.guardPulls() : undefined;
    const moved = await fixture.read(device, destination).catch(() => undefined);
    const pull: GuardPull | undefined = guardPulls?.pulls[0];
    const outcome: GuardTiming["outcome"] = !input.unbound ? "moved" : moved?.includes(text) ? "carried"
      : answeredRetryLater(pull) && moved === unchanged ? "stale-retry-later" : "moved";
    // Recorded before any check, so a failed check still leaves the timing.
    timings.push({ name: input.name, route: "unbound", guard: input.guarded ? "on" : "off", proxyDelayMs: input.proxyDelayMs, elapsedMs,
      outcome, ...(guardPulls ? { guardPulls } : {}) });
    expect(existsSync(join(device.rootPath, path))).toBe(false);
    if (!guardPulls) {
      expect(device.targetedPasses()).toBe(requested);
      expect(moved).toBe(unchanged);
      return false;
    }
    expect(device.targetedPasses()).toBe(requested + 1);
    // The guard's wait, not the whole move: the rename and its capture come after it.
    const carriedInTime = guardPulls.endedInWait && moved !== undefined && moved.includes(text);
    if (!input.unbound) throw new Error("A guarded move here says what its pull must show.");
    if (input.unbound === "drained" && !guardPulls.endedInWait) {
      throw new Error(`The guard's wait ran out before its catch-up ended, ${Math.round(elapsedMs)} ms into the move. The guard's pulls: ${guardPulls.pulls.map(describePull).join(", ") || "none"}.`);
    }
    expect(guardPulls.shared, "another pass was running when the guard's catch-up began").toBe(false);
    if (pull === undefined) throw new Error(`The guard's catch-up ran no pull, ${Math.round(elapsedMs)} ms into the move.`);
    expect(guardPulls.pulls.map(describePull), "the guard's catch-up ran one pull").toHaveLength(1);
    expect(fixture.ownerBound(device, input.name)).toBe(false);
    if (input.unbound === "drained") {
      if (pull.result === "failed") throw new Error(`The guard's pull was refused: ${describePull(pull)}.`);
      expect(moved).toContain(text);
      return carriedInTime;
    }
    // The guard doesn't promise the edit. A pull that answers retry later lets
    // the move go ahead without it, and the edit stays published under the page's binding.
    if (pull.result === "succeeded") expect(moved, "the guard's pull succeeded").toContain(text);
    else {
      expect({ wireCode: pull.wireCode, message: pull.message, retry: pull.retry }, "the guard's pull failed").toEqual(RETRY_LATER);
      expect(moved).toBe(unchanged);
      await fixture.waitPublished(input.name, cursor);
    }
    return carriedInTime;
  }

  // This computer owns the page live, so its move is refused with the move
  // words. A guarded move is refused before the guard catches anything up,
  // inside the wait. The page stays where it was, and the refusal leaves the
  // owner's accepted state as it was. Once an owner pass installs the edit, a
  // later pull saves it into the page there. `pullsRefused` fails the pulls
  // that would save the edit until the move is refused.
  async function editThenRefusedMove(fixture: LiveMoveFixture, device: MoveDevice, input: { name: string; guarded: boolean;
    proxyDelayMs: number; pullsRefused?: boolean; before?: () => Promise<void> }) {
    const { path } = fixture.page(input.name);
    const text = marker(input.name);
    const destination = `notes/${input.name}-moved.md`;
    if (input.pullsRefused) fixture.refuseLogPulls(true);
    let cursor: number;
    try {
      cursor = await fixture.edit(input.name, text);
      await fixture.waitPublished(input.name, cursor);
      await input.before?.();
      // The pending case's pull can record #2789's refusal, so compare from here.
      const notices = await device.refusalNotices();
      const accepted = fixture.ownerAccepted(input.name);
      const requested = device.targetedPasses();
      fixture.proxy.setDelayMs(input.proxyDelayMs);
      const started = performance.now();
      let failure: unknown;
      try { failure = await device.move(path, destination, { guarded: input.guarded }).then(() => undefined, (error: unknown) => error); }
      finally { fixture.proxy.setDelayMs(0); }
      const elapsedMs = performance.now() - started;
      // Recorded before any check, so a failed check still leaves the timing.
      timings.push({ name: input.name, route: "bound", guard: input.guarded ? "on" : "off", proxyDelayMs: input.proxyDelayMs, elapsedMs,
        outcome: "refused", ...(input.guarded ? { guardPulls: await device.guardPulls() } : {}) });
      expect(failure).toBeInstanceOf(LivePageOwnedError);
      expect((failure as Error).message).toBe(`${livePageTitle(path, "move")}\n${livePageBody("move")}`);
      expect(device.targetedPasses(), "the refusal came before any catch-up").toBe(requested);
      if (input.guarded) expect(elapsedMs, "the refusal didn't wait for the guard").toBeLessThan(MOVE_ACCEPTED_EDITS_WAIT_MS);
      expect(existsSync(join(device.rootPath, path)), "the page stays where it was").toBe(true);
      expect(existsSync(join(device.rootPath, destination))).toBe(false);
      expect(fixture.ownerBound(device, input.name)).toBe(true);
      expect(fixture.ownerAccepted(input.name), "the refusal leaves the owner's accepted state as it was").toEqual(accepted);
      expect(await device.refusalNotices()).toEqual(notices);
    } finally { if (input.pullsRefused) fixture.refuseLogPulls(false); }
    await fixture.waitPublished(input.name, cursor);
    // Only the guard syncs the owner here, and the refusal came before it, so
    // an owner pass installs the accepted edit. A pull then saves it into the page at its old path.
    await fixture.ownerSync(input.name);
    expect(fixture.ownerAccepted(input.name).cursor, "the owner installed the accepted edit").toBeGreaterThanOrEqual(cursor);
    await expect.poll(async () => { await device.pull(); return fixture.read(device, path); }, { timeout: 120_000 }).toContain(text);
  }

  afterAll(async () => {
    if (timings.length) await recordGuardTimings("two-daemon-sync", timings);
  });

  // This computer owns each bound page live, so each bound move is refused
  // with the move words before the guard catches anything up, and keeps the
  // accepted edit. The unbound peer's guarded move can still carry it.
  it.skipIf(engine.missing)("refuses a bound move before catching up and keeps the accepted edit, and carries it on an unbound device", async () => {
    const fixture = await openLiveMoveFixture({ workspaceId: "guard-carries-accepted", compiledRelayMain, engineExecutable: engine.require(),
      pages: ["pending", "unpulled", "slow", "refused", "peer"], peer: true });
    try {
      const { owner, peer } = fixture;
      const recorded = timings.length;
      // Bound, S already pending: an earlier pull parked the save, and the file holds the page as it was.
      await editThenRefusedMove(fixture, owner, { name: "pending", guarded: true, proxyDelayMs: 0, before: async () => {
        await owner.pull();
        expect(fixture.ownerPendingSettlements("pending")).toBeGreaterThan(0);
      } });
      // Bound, S not yet pulled.
      await editThenRefusedMove(fixture, owner, { name: "unpulled", guarded: true, proxyDelayMs: 0 });
      await editThenRefusedMove(fixture, owner, { name: "slow", guarded: true, proxyDelayMs: PROXY_DELAY_MS });
      // The owner feed installs a newer edit, and the pull that would save it
      // into the page fails. The move is refused the same way.
      await editThenRefusedMove(fixture, owner, { name: "refused", guarded: true, proxyDelayMs: 0, pullsRefused: true,
        before: async () => { await fixture.ownerSync("refused"); } });

      // Unbound, behind the owner's cases: the peer never enrolls, so the pull
      // alone can carry the save, and its first pull meets everything those
      // cases published. That pull may answer retry later, so the drained
      // test below holds the carried-in-time check.
      await editThenMove(fixture, peer, { name: "peer", guarded: true, proxyDelayMs: 0, unbound: "backlog" });
      const peerOutcome = timings.at(-1)?.outcome;
      expect(["carried", "stale-retry-later"]).toContain(peerOutcome);
      // Every guarded move here reaches the timing record, the refusals included.
      expect(timings.slice(recorded).map(({ name, guard, outcome }) => `${name} ${guard} ${outcome}`)).toEqual([
        "pending on refused", "unpulled on refused", "slow on refused", "refused on refused", `peer on ${peerOutcome}`,
      ]);
      // The peer's guard ran owner syncs, and none of them made the peer an owner.
      expect(fixture.ownerBound(owner, "slow")).toBe(true);
      expect(fixture.ownerBound(peer, "peer")).toBe(false);
    } finally {
      await fixture.close();
    }
  }, 600_000);

  // Unbound, with nothing else to pull: the peer pulls until no backlog is
  // left before each edit, and pulls nothing between the edit and the move.
  it.skipIf(engine.missing)("carries the accepted edit on an unbound device whose pull has nothing else to do", async () => {
    const fixture = await openLiveMoveFixture({ workspaceId: "guard-carries-unbound", compiledRelayMain, engineExecutable: engine.require(),
      pages: ["peer-alone", "peer-slow", "warm-up"], peer: true });
    try {
      const { peer } = fixture;
      // Starts the peer's Markdown reader before the first move: its cold start is a separate, known slowness (#3356), not the guard's wait.
      const warmUp = async () => {
        await drain(peer);
        await fixture.waitPublished("warm-up", await fixture.edit("warm-up", marker("warm-up")));
        await drain(peer);
      };
      const recorded = timings.length;
      const carriedInTime = [
        await editThenMove(fixture, peer, { name: "peer-alone", guarded: true, proxyDelayMs: 0, unbound: "drained", beforeEdit: warmUp }),
        await editThenMove(fixture, peer, { name: "peer-slow", guarded: true, proxyDelayMs: PROXY_DELAY_MS, unbound: "drained",
          beforeEdit: () => drain(peer) }),
      ];
      expect(timings.slice(recorded).map(({ name, guard, outcome }) => `${name} ${guard} ${outcome}`)).toEqual([
        "peer-alone on carried", "peer-slow on carried",
      ]);
      expect(carriedInTime).toEqual([true, true]);
    } finally {
      await fixture.close();
    }
  }, 600_000);

  // A folder that holds a page this computer owns, whose newer edit is
  // installed but not yet saved into the file. The live-folder refusal comes
  // before the guard catches anything up, and the next pull saves the edit
  // into the page where it is. The live-folder suite covers an edit that
  // hasn't reached the owner; this one covers an installed one, with the
  // guard wired.
  it.skipIf(engine.missing)("refuses a folder move over an installed, unsaved edit before catching up, and keeps the edit", async () => {
    const fixture = await openLiveMoveFixture({ workspaceId: "guard-folder-refused", compiledRelayMain, engineExecutable: engine.require(),
      pages: ["box/refused"] });
    try {
      const { owner } = fixture;
      const page = fixture.page("box/refused");
      const text = marker("box-refused");
      const recorded = timings.length;
      const files = async () => (await readdir(join(owner.rootPath, "notes"), { recursive: true })).map(String).sort();
      fixture.refuseLogPulls(true);
      let failure: unknown;
      let accepted: ReturnType<LiveMoveFixture["ownerAccepted"]>;
      try {
        const cursor = await fixture.edit("box/refused", text);
        await fixture.ownerSync("box/refused");
        accepted = fixture.ownerAccepted("box/refused");
        expect(accepted.cursor).toBeGreaterThanOrEqual(cursor);
        await fixture.waitPublished("box/refused", cursor);
        expect(await fixture.read(owner, page.path)).not.toContain(text);
        const before = { files: await files(), outbound: fixture.outbound("box/refused"), notices: await owner.refusalNotices(),
          requested: owner.targetedPasses() };
        const started = performance.now();
        failure = await owner.move("notes/box", "notes/box-moved", { guarded: true }).then(() => undefined, (error: unknown) => error);
        const elapsedMs = performance.now() - started;
        timings.push({ name: "folder-refused", route: "bound", guard: "on", proxyDelayMs: 0, elapsedMs, outcome: "refused", guardPulls: await owner.guardPulls() });
        expect(failure).toBeInstanceOf(LiveFolderError);
        expect((failure as Error).message).toBe(`${liveFolderTitle("notes/box", "move")}\n${liveFolderBody("move")}`);
        // The guard caught nothing up, and the refused move changed nothing.
        expect(owner.targetedPasses()).toBe(before.requested);
        expect(await files()).toEqual(before.files);
        expect(existsSync(join(owner.rootPath, "notes/box-moved"))).toBe(false);
        expect(fixture.outbound("box/refused")).toBe(before.outbound);
        expect(await owner.refusalNotices()).toEqual(before.notices);
        expect(fixture.ownerAccepted("box/refused")).toEqual(accepted);
        expect(await fixture.read(owner, page.path)).not.toContain(text);
      } finally { fixture.refuseLogPulls(false); }
      expect(timings.slice(recorded).map(({ name, guard, outcome }) => `${name} ${guard} ${outcome}`)).toEqual(["folder-refused on refused"]);
      // The next pull saves the kept edit into the page at its old path.
      await owner.pull();
      expect(await fixture.read(owner, page.path)).toContain(text);
    } finally {
      await fixture.close();
    }
  }, 600_000);

  // A fresh fixture, so no guard's pull has run on either device. Without the
  // guard, a bound move is still refused, and an unbound one leaves the edit out.
  it.skipIf(engine.missing)("without the guard, a bound move is still refused and an unbound move leaves the accepted edit out", async () => {
    const fixture = await openLiveMoveFixture({ workspaceId: "guard-off-control", compiledRelayMain, engineExecutable: engine.require(),
      pages: ["off", "off-slow", "peer-off", "peer-off-slow"], peer: true });
    try {
      const { owner, peer } = fixture;
      await editThenRefusedMove(fixture, owner, { name: "off", guarded: false, proxyDelayMs: 0,
        before: async () => { expect(fixture.ownerPendingSettlements("off")).toBe(0); } });
      await editThenRefusedMove(fixture, owner, { name: "off-slow", guarded: false, proxyDelayMs: PROXY_DELAY_MS });
      await editThenMove(fixture, peer, { name: "peer-off", guarded: false, proxyDelayMs: 0 });
      await editThenMove(fixture, peer, { name: "peer-off-slow", guarded: false, proxyDelayMs: PROXY_DELAY_MS });
    } finally {
      await fixture.close();
    }
  }, 600_000);
});

it.skipIf(engine.missing)("refuses renaming an owner-bound live page, keeps its workspace publishing, and renames it after Stop (bound, unbound)",
  () => runRenameRepros(["bound", "unbound"]), 300_000);

it.skipIf(engine.missing)("renaming or deleting a captured owner-bound live page in the file manager keeps its workspace publishing",
  () => runRenameRepros(["capture-rename", "capture-delete"]), 300_000);
