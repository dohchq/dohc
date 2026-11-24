import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { afterEach, describe, expect, it } from "vitest";
import { compileDatasetOperations } from "../../packages/app-backend-runtime/src/dataset-compiler.ts";
import {
  parseAppDatasetReference,
  parseDatasetDefinition,
  resolveAppDatasetReferenceBinding,
} from "../../packages/security-contract/src/dataset.ts";
import { describeDatasetRevision } from "../../packages/security-contract/src/datasetArtifacts.ts";
import { verifyLocalAppFrontend } from "../../apps/desktop/src/workspaces/appFrontendVerifier.ts";
import { compileClosedApp } from "../../apps/desktop/src/workspaces/closedAppCompiler.ts";
import {
  createLocalDatasetHost,
  type LocalDatasetHost,
} from "../../apps/desktop/src/workspaces/localDatasetHost.ts";
import { createLocalStagedApps } from "../../apps/desktop/src/workspaces/localStagedApps.ts";
import { unguardedCollections } from "../../apps/desktop/src/testing/collectionsHolder.ts";
import { createDatasetFixtureCompiler } from "../../apps/desktop/src/testing/datasetFixtureCompiler.ts";
import { openedLocalState } from "../../apps/desktop/src/testing/preparedLocalState.ts";
import { sourceCaptureAdapter } from "../../apps/desktop/src/testing/sourceCaptureAdapter.ts";
import { axialDistance, reconstructReplayFrames } from "./replay.ts";
import type {
  CreateGameReply,
  GameSummary,
  JoinGameReply,
  ReplayPayload,
  StartDemoReply,
  SubmitMoveReply,
  VisibleBoardState,
} from "./types.ts";

const EXAMPLE_ROOT = resolve(import.meta.dirname);
const compileFixture = createDatasetFixtureCompiler();

const roots: string[] = [];
const hosts: LocalDatasetHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 25 });
  }
});

async function loadExampleFiles(): Promise<Map<string, string>> {
  const entries = await readdir(EXAMPLE_ROOT, { withFileTypes: true });
  const files = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const content = await readFile(join(EXAMPLE_ROOT, entry.name), "utf8");
    files.set(`hex-tactics/${entry.name}`, content);
  }
  return files;
}

async function openStagedHexClash() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-hex-tactics-"));
  roots.push(workspaceRoot);
  await openedLocalState({ workspaceId: "w", rootPath: workspaceRoot });

  const host = await createLocalDatasetHost({
    localPersonId: () => "owner-1",
    workspaceId: "w",
    workspaceRoot,
    capacityBytes: 8 * 1024 * 1024,
    compile: compileFixture,
    holder: unguardedCollections,
  });
  hosts.push(host);

  const staged = createLocalStagedApps({
    workspaceId: "w",
    workspaceRoot,
    assertCurrent() {},
    compile: compileClosedApp,
    preflightCreate: (input) => host.preflightCreate(input),
    tryApprovedArtifacts: async () => null,
    prepareCreate: (input) => host.prepare(input),
    approveCreate: (input) => host.approve(input),
    discardCreate: (id) => host.discard(id),
    prepareMigrationCandidate: (input) => host.prepareMigrationCandidate(input),
    approveMigrationCandidate: (input) => host.approveMigrationCandidate(input),
    discardMigrationCandidate: (input) => host.discardMigrationCandidate(input),
    activateApp: (prepared, signal, agent) => host.apps.activate(prepared, signal, agent),
    withExclusiveDatasets: (datasetIds, signal, work) =>
      host.withExclusiveDatasets(datasetIds, signal, (exclusive) =>
        work({
          approveCreate: (input) => exclusive.approve(input),
          approveMigrationCandidate: (input) => exclusive.approveMigrationCandidate(input),
        }),
      ),
  });

  const files = await loadExampleFiles();
  const signal = new AbortController().signal;
  const summary = await staged.stage({
    appRoot: "hex-tactics",
    deferredWrites: [],
    adapter: sourceCaptureAdapter(files),
    signal,
  });
  const approved = await staged.approve({
    stageId: summary.stageId,
    reviewDigest: summary.reviewDigest,
    signal,
  });

  let callSeq = 0;
  async function invoke<T = unknown>(
    operation: string,
    input: unknown = {},
    idempotencyKey = `op-${++callSeq}`,
  ): Promise<
    | { ok: true; result: T }
    | { ok: false; refusal: { code: string; message: string } }
  > {
    try {
      const reply = (await host.apps.request(approved.publicationId, "invoke", {
        authorityRevision: approved.authorityRevision,
        operation,
        idempotencyKey,
        input,
      })) as { result: T };
      return { ok: true, result: reply.result };
    } catch (caught: unknown) {
      const err = caught as {
        refusal?: { code: string; message: string };
        code?: string;
        message?: string;
      };
      return {
        ok: false,
        refusal: err.refusal ?? {
          code: err.code ?? "error",
          message: err.message ?? String(caught),
        },
      };
    }
  }

  return { workspaceRoot, host, staged, files, summary, approved, invoke };
}

async function openLinkHost() {
  const { createDatasetJournal } = await import(
    "../../packages/app-backend-runtime/src/journal.ts"
  );
  const { createDatasetSupervisor } = await import(
    "../../packages/app-backend-runtime/src/supervisor.ts"
  );
  const { createDatasetHost } = await import(
    "../../packages/app-backend-runtime/src/dataset-host.ts"
  );
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdirSync } = await import("node:fs");

  const rawDef = JSON.parse(await readFile(join(EXAMPLE_ROOT, "dataset.json"), "utf8"));
  const definition = parseDatasetDefinition(rawDef, {
    descriptorPath: "hex-tactics/dataset.json",
  });
  const schemaSql = await readFile(join(EXAMPLE_ROOT, "schema.sql"), "utf8");
  const operationSource = await readFile(join(EXAMPLE_ROOT, "operations.js"), "utf8");
  const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
  const manifest = JSON.parse(await readFile(join(EXAMPLE_ROOT, "app.publish.json"), "utf8"));
  const reference = parseAppDatasetReference(manifest.dataset);
  const binding = resolveAppDatasetReferenceBinding(reference, definition.datasetId, revision);

  const dir = await mkdtemp(join(tmpdir(), "dohc-hex-link-"));
  roots.push(dir);
  const workerDir = join(dir, "workers");
  mkdirSync(workerDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dir, "host.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  function transaction<T>(run: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const journal = createDatasetJournal({ db, transaction });
  let supervisor: Awaited<ReturnType<typeof createDatasetSupervisor>> | null = null;
  hosts.push({
    async close() {
      await supervisor?.close();
      db.close();
    },
  } as unknown as LocalDatasetHost);
  supervisor = await createDatasetSupervisor({ journal, directory: async () => workerDir });

  type Principal = "owner" | "linkA" | "linkB";
  const host = createDatasetHost<Principal>({
    db,
    transaction,
    journal,
    supervisor,
    resolveAuthority(context, request) {
      return {
        principalKey: context,
        ...(request.access.kind === "app" ? { appId: request.access.appId } : {}),
        caller:
          context === "owner"
            ? { kind: "owner", userId: "owner-1" }
            : { kind: "link", principalId: context, grantId: "share-link-1" },
      };
    },
    compileOperations: (src) => compileDatasetOperations(src, "operations.js"),
  });

  const scope = { workspaceId: "ws-hex", datasetId: definition.datasetId };
  await host.activate("owner", { workspaceId: "ws-hex", revision, schemaSql, operationSource });
  host.setBinding("owner", { ...scope, appId: "hexclash", binding });

  const opId = (name: string) =>
    definition.operations.find((o) => o.name === name)!.operationId;

  let seq = 0;
  async function call<T = unknown>(
    name: string,
    input: unknown = {},
    principal: Principal = "linkA",
    idempotencyKey = `link-${++seq}`,
  ): Promise<T> {
    const reply = await host.invoke(principal, {
      ...scope,
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationId: opId(name),
      input: input as never,
      idempotencyKey,
      access: { kind: "app", appId: "hexclash" },
    });
    return reply.result as T;
  }

  return { call, definition, revision, schemaSql, operationSource };
}

function findShortestPassablePath(
  tiles: ReadonlyArray<{ q: number; r: number; terrain: string | null }>,
  start: string,
  goal: string,
): Array<{ q: number; r: number }> {
  const byKey = new Map(tiles.map((t) => [`${t.q},${t.r}`, t]));
  const dirs = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
  ];
  const prev = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]!;
    if (cur === goal) break;
    const tile = byKey.get(cur)!;
    for (const [dq, dr] of dirs) {
      const nk = `${tile.q + dq},${tile.r + dr}`;
      if (prev.has(nk)) continue;
      const nt = byKey.get(nk);
      if (!nt || nt.terrain === "mountain") continue;
      prev.set(nk, cur);
      queue.push(nk);
    }
  }
  const path: Array<{ q: number; r: number }> = [];
  let cursor: string | null | undefined = goal;
  while (cursor) {
    const tile = byKey.get(cursor)!;
    path.push({ q: tile.q, r: tile.r });
    cursor = prev.get(cursor);
  }
  return path.reverse();
}

describe("HexClash authoritative strategy game", () => {
  it("stages and approves one formatVersion:2 multi-table Collection and compiles cleanly with omitted inputs", async () => {
    const { summary, approved, invoke } = await openStagedHexClash();
    expect(summary.appRoot).toBe("hex-tactics");
    expect(summary.collections).toHaveLength(1);
    expect(summary.collections[0]!.name).toBe("HexClash");
    expect(approved.collectionsApplied).toHaveLength(1);

    const listed = await invoke<{ games: GameSummary[]; canSpectateActive?: boolean }>(
      "listGames",
      {},
    );
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.result.games).toEqual([]);
      expect(listed.result.canSpectateActive).toBe(true);
    }
  });

  it("enforces server-side Fog of War and hides seeds, join codes, opponent supply, tokens, and out-of-vision moves", async () => {
    const { call } = await openLinkHost();

    const p1 = await call<CreateGameReply>(
      "createGame",
      { title: "Fog Proof", playerName: "Crimson", seed: 4242 },
      "linkA",
    );
    expect(p1.seat).toBe(1);
    expect(p1.playerToken).toMatch(/^[a-f0-9]{64}$/);
    expect(p1.joinCode).toMatch(/^[A-Z0-9]{6}$/);
    expect("seed" in p1).toBe(false);

    const waitingLobby = await call<{ games: GameSummary[]; canSpectateActive?: boolean }>(
      "listGames",
      {},
      "linkB",
    );
    const waitingJson = JSON.stringify(waitingLobby);
    expect(waitingJson).not.toContain(p1.playerToken);
    expect(waitingJson).not.toContain(p1.joinCode);
    expect(waitingLobby.canSpectateActive).toBe(false);
    expect(waitingLobby.games[0]!.seed).toBeNull();
    expect("joinCode" in waitingLobby.games[0]!).toBe(false);

    const ownerLobby = await call<{ games: GameSummary[]; canSpectateActive?: boolean }>(
      "listGames",
      {},
      "owner",
    );
    expect(ownerLobby.canSpectateActive).toBe(true);

    const joinKey = "join-seat-2-retry-key";
    const p2 = await call<JoinGameReply>(
      "joinGame",
      { joinCode: p1.joinCode, playerName: "Cobalt" },
      "linkB",
      joinKey,
    );
    expect(p2.seat).toBe(2);
    expect(p2.playerToken).toMatch(/^[a-f0-9]{64}$/);
    expect(p2.playerToken).not.toBe(p1.playerToken);

    const p2Replay = await call<JoinGameReply>(
      "joinGame",
      { joinCode: p1.joinCode, playerName: "Cobalt" },
      "linkB",
      joinKey,
    );
    expect(p2Replay).toEqual(p2);

    await expect(
      call("joinGame", { joinCode: p1.joinCode, playerName: "Intruder" }, "linkB"),
    ).rejects.toMatchObject({ refusal: { code: "game_full" } });

    const view1 = await call<VisibleBoardState>(
      "getVisibleState",
      { gameId: p1.gameId, playerToken: p1.playerToken },
      "linkA",
    );
    const view1Json = JSON.stringify(view1);
    expect(view1Json).not.toContain(p1.playerToken);
    expect(view1Json).not.toContain(p2.playerToken);
    expect(view1.game.seed).toBeNull();
    expect(view1.game.joinCode).toBe(p1.joinCode);

    expect(view1.tiles).toHaveLength(37);
    const owned1 = view1.tiles.filter((t) => t.ownerSeat === 1);
    expect(owned1.map((t) => `${t.q},${t.r}`).sort()).toEqual(["-2,0", "-3,0"]);

    let foggedCount = 0;
    for (const tile of view1.tiles) {
      const minDist = Math.min(...owned1.map((o) => axialDistance(o.q, o.r, tile.q, tile.r)));
      if (minDist > 2) {
        foggedCount += 1;
        expect(tile).toEqual({
          q: tile.q,
          r: tile.r,
          visible: false,
          terrain: null,
          ownerSeat: null,
          units: null,
          fortified: false,
        });
      } else {
        expect(tile.visible).toBe(true);
        expect(tile.terrain).not.toBeNull();
      }
    }
    expect(foggedCount).toBeGreaterThan(15);

    const enemyCap = view1.tiles.find((t) => t.q === 3 && t.r === 0)!;
    const enemyVanguard = view1.tiles.find((t) => t.q === 2 && t.r === 0)!;
    expect(enemyCap.visible).toBe(false);
    expect(enemyCap.units).toBeNull();
    expect(enemyCap.ownerSeat).toBeNull();
    expect(enemyVanguard.visible).toBe(false);
    expect(enemyVanguard.units).toBeNull();

    const p2SummaryInView1 = view1.players.find((p) => p.seat === 2)!;
    expect(p2SummaryInView1.gold).toBeNull();
    expect(p2SummaryInView1.tileCount).toBeNull();
    expect(p2SummaryInView1.unitCount).toBeNull();

    await expect(
      call("getVisibleState", { gameId: p1.gameId, spectator: true }, "linkA"),
    ).rejects.toMatchObject({ refusal: { code: "spectator_forbidden" } });

    await expect(
      call("replayGame", { gameId: p1.gameId }, "linkA"),
    ).rejects.toMatchObject({ refusal: { code: "replay_unavailable" } });

    const p1Pass = await call<SubmitMoveReply>(
      "submitMove",
      { gameId: p1.gameId, playerToken: p1.playerToken, actionType: "pass" },
      "linkA",
    );
    expect("supply" in p1Pass.outcome).toBe(false);
    expect("supply" in p1Pass.state.recentMoves[0]!.outcome).toBe(false);

    const p2Reinforce = await call<SubmitMoveReply>(
      "submitMove",
      {
        gameId: p1.gameId,
        playerToken: p2.playerToken,
        actionType: "reinforce",
        fromQ: 3,
        fromR: 0,
        units: 2,
      },
      "linkB",
    );
    expect("supply" in p2Reinforce.outcome).toBe(false);

    const view1AfterP2 = await call<VisibleBoardState>(
      "getVisibleState",
      { gameId: p1.gameId, playerToken: p1.playerToken },
      "linkA",
    );
    const latestForP1 = view1AfterP2.recentMoves[0]!;
    expect(latestForP1.hidden).toBe(true);
    expect(latestForP1.actionType).toBe("hidden");
    expect(latestForP1.fromHex).toBeNull();
    expect(latestForP1.toHex).toBeNull();
    expect(latestForP1.unitsMoved).toBeNull();
    expect("supply" in view1AfterP2.recentMoves[1]!.outcome).toBe(false);

    const demoBoundary = await call<StartDemoReply>("startDemoMatch", { seed: 2026 }, "owner");
    const [b1, b2] = demoBoundary.seats;
    const bView = await call<VisibleBoardState>(
      "getVisibleState",
      { gameId: demoBoundary.gameId, spectator: true },
      "owner",
    );
    const toCenter = findShortestPassablePath(bView.tiles, "-3,0", "0,0");
    for (let i = 0; i < toCenter.length - 1; i += 1) {
      const from = toCenter[i]!;
      const to = toCenter[i + 1]!;
      while (true) {
        const cur = await call<VisibleBoardState>(
          "getVisibleState",
          { gameId: demoBoundary.gameId, spectator: true },
          "owner",
        );
        const fromTile = cur.tiles.find((t) => t.q === from.q && t.r === from.r)!;
        const toTile = cur.tiles.find((t) => t.q === to.q && t.r === to.r)!;
        const need =
          toTile.ownerSeat === 1
            ? 1
            : (toTile.units ?? 0) + (toTile.terrain === "forest" && (toTile.units ?? 0) > 0 ? 1 : 0) + 1;
        if ((fromTile.units ?? 0) - 1 >= need) {
          await call(
            "submitMove",
            {
              gameId: demoBoundary.gameId,
              playerToken: b1!.playerToken,
              actionType: "march",
              fromQ: from.q,
              fromR: from.r,
              toQ: to.q,
              toR: to.r,
              units: (fromTile.units ?? 0) - 1,
            },
            "linkA",
          );
          if (i < toCenter.length - 2) {
            await call(
              "submitMove",
              { gameId: demoBoundary.gameId, playerToken: b2!.playerToken, actionType: "pass" },
              "linkB",
            );
          }
          break;
        }
        await call(
          "submitMove",
          {
            gameId: demoBoundary.gameId,
            playerToken: b1!.playerToken,
            actionType: "reinforce",
            fromQ: from.q,
            fromR: from.r,
            units: 1,
          },
          "linkA",
        );
        await call(
          "submitMove",
          { gameId: demoBoundary.gameId, playerToken: b2!.playerToken, actionType: "pass" },
          "linkB",
        );
      }
    }
    const p1CenterView = await call<VisibleBoardState>(
      "getVisibleState",
      { gameId: demoBoundary.gameId, playerToken: b1!.playerToken },
      "linkA",
    );
    const v20 = p1CenterView.tiles.find((t) => t.q === 2 && t.r === 0)!;
    const v30 = p1CenterView.tiles.find((t) => t.q === 3 && t.r === 0)!;
    expect(v20.visible).toBe(true);
    expect(v30.visible).toBe(false);

    await call(
      "submitMove",
      {
        gameId: demoBoundary.gameId,
        playerToken: b2!.playerToken,
        actionType: "march",
        fromQ: 2,
        fromR: 0,
        toQ: 3,
        toR: 0,
        units: 1,
      },
      "linkB",
    );
    const p1AfterBoundary = await call<VisibleBoardState>(
      "getVisibleState",
      { gameId: demoBoundary.gameId, playerToken: b1!.playerToken },
      "linkA",
    );
    const boundaryMove = p1AfterBoundary.recentMoves[0]!;
    expect(boundaryMove.fromHex).toBe("2,0");
    expect(boundaryMove.toHex).toBeNull();
    expect("captured" in boundaryMove.outcome).toBe(false);
    expect("capitalCaptured" in boundaryMove.outcome).toBe(false);
  }, 20_000);

  it("refuses forged tokens, out-of-turn moves, stale turns, illegal distance, coerced types, and invalid orders without mutating state", async () => {
    const { invoke } = await openStagedHexClash();

    const longP1 = "A".repeat(40);
    const longP2 = "B".repeat(40);
    const longDemo = await invoke<StartDemoReply>("startDemoMatch", {
      player1Name: longP1,
      player2Name: longP2,
      seed: 1234,
    });
    expect(longDemo.ok).toBe(true);
    if (!longDemo.ok) throw new Error("Expected long-name demo match to succeed");
    expect(longDemo.result.title.length).toBeLessThanOrEqual(64);
    expect(longDemo.result.seats[0]!.name).toBe(longP1);
    expect(longDemo.result.seats[1]!.name).toBe(longP2);

    const demo = await invoke<StartDemoReply>("startDemoMatch", { seed: 7777 });
    expect(demo.ok).toBe(true);
    if (!demo.ok) throw new Error("Expected demo match to succeed");
    const { gameId, seats } = demo.result;
    const s1 = seats[0]!;
    const s2 = seats[1]!;

    const forgedRes = await invoke("submitMove", {
      gameId,
      playerToken: "a".repeat(64),
      actionType: "pass",
    });
    expect(forgedRes).toMatchObject({ ok: false, refusal: { code: "unauthorized_player" } });

    const wrongTurnRes = await invoke("submitMove", {
      gameId,
      playerToken: s2.playerToken,
      actionType: "pass",
    });
    expect(wrongTurnRes).toMatchObject({ ok: false, refusal: { code: "not_your_turn" } });

    const staleTurnRes = await invoke("submitMove", {
      gameId,
      playerToken: s1.playerToken,
      actionType: "pass",
      expectedTurn: 2,
    });
    expect(staleTurnRes).toMatchObject({ ok: false, refusal: { code: "stale_turn" } });

    const badDistRes = await invoke("submitMove", {
      gameId,
      playerToken: s1.playerToken,
      actionType: "march",
      fromQ: -3,
      fromR: 0,
      toQ: -1,
      toR: 0,
      units: 2,
    });
    expect(badDistRes).toMatchObject({ ok: false, refusal: { code: "not_adjacent" } });

    const boolUnitsRes = await invoke("submitMove", {
      gameId,
      playerToken: s1.playerToken,
      actionType: "reinforce",
      fromQ: -3,
      fromR: 0,
      units: true,
    });
    expect(boolUnitsRes).toMatchObject({ ok: false, refusal: { code: "invalid_units" } });

    const nullCoordRes = await invoke("submitMove", {
      gameId,
      playerToken: s1.playerToken,
      actionType: "fortify",
      fromQ: -3,
      fromR: null,
    });
    expect(nullCoordRes).toMatchObject({ ok: false, refusal: { code: "invalid_hex" } });

    const objectUnitsRes = await invoke("submitMove", {
      gameId,
      playerToken: s1.playerToken,
      actionType: "march",
      fromQ: -3,
      fromR: 0,
      toQ: -2,
      toR: 0,
      units: { malicious: 1 },
    });
    expect(objectUnitsRes).toMatchObject({ ok: false, refusal: { code: "insufficient_units" } });

    const notOwnerRes = await invoke("submitMove", {
      gameId,
      playerToken: s1.playerToken,
      actionType: "march",
      fromQ: -1,
      fromR: 0,
      toQ: 0,
      toR: 0,
      units: 1,
    });
    expect(notOwnerRes).toMatchObject({ ok: false, refusal: { code: "not_tile_owner" } });

    const leaveZeroRes = await invoke("submitMove", {
      gameId,
      playerToken: s1.playerToken,
      actionType: "march",
      fromQ: -3,
      fromR: 0,
      toQ: -2,
      toR: 0,
      units: 6,
    });
    expect(leaveZeroRes).toMatchObject({ ok: false, refusal: { code: "insufficient_units" } });

    const tooExpensiveReinforce = await invoke("submitMove", {
      gameId,
      playerToken: s1.playerToken,
      actionType: "reinforce",
      fromQ: -3,
      fromR: 0,
      units: 5,
    });
    expect(tooExpensiveReinforce).toMatchObject({
      ok: false,
      refusal: { code: "insufficient_gold" },
    });

    const spectator = await invoke<VisibleBoardState>("getVisibleState", {
      gameId,
      spectator: true,
    });
    expect(spectator.ok).toBe(true);
    if (!spectator.ok) throw new Error("Expected spectator read to succeed");
    expect(spectator.result.game.turnNumber).toBe(1);
    expect(spectator.result.players.find((p) => p.seat === 1)?.gold).toBe(4);
    expect(spectator.result.tiles.find((t) => t.q === -3 && t.r === 0)?.units).toBe(6);

    const matchingTurnPass = await invoke<SubmitMoveReply>("submitMove", {
      gameId,
      playerToken: s1.playerToken,
      actionType: "pass",
      expectedTurn: 1,
    });
    expect(matchingTurnPass.ok).toBe(true);
  });

  it("plays a deterministic match to capital capture victory and reconstructs every turn identically in replay", async () => {
    const { call } = await openLinkHost();

    const matchA = await call<StartDemoReply>("startDemoMatch", { seed: 2026 }, "owner");
    const matchB = await call<StartDemoReply>("startDemoMatch", { seed: 2026 }, "owner");
    const replayInitA = await call<ReplayPayload>("replayGame", { gameId: matchA.gameId }, "owner");
    const replayInitB = await call<ReplayPayload>("replayGame", { gameId: matchB.gameId }, "owner");
    expect(replayInitA.initialTiles).toEqual(replayInitB.initialTiles);

    const { gameId, seats } = matchA;
    const p1 = seats[0]!;
    const p2 = seats[1]!;

    const mountain = replayInitA.initialTiles.find((t) => t.terrain === "mountain")!;
    const path = findShortestPassablePath(replayInitA.initialTiles, "-3,0", "3,0");
    expect(path.length).toBeGreaterThanOrEqual(7);

    const fortifyTurn = await call<SubmitMoveReply>(
      "submitMove",
      { gameId, playerToken: p1.playerToken, actionType: "fortify", fromQ: -3, fromR: 0 },
      "linkA",
    );
    expect(fortifyTurn.turnExecuted).toBe(1);

    await call<SubmitMoveReply>(
      "submitMove",
      { gameId, playerToken: p2.playerToken, actionType: "fortify", fromQ: 3, fromR: 0 },
      "linkB",
    );

    await expect(
      call(
        "submitMove",
        { gameId, playerToken: p1.playerToken, actionType: "fortify", fromQ: -3, fromR: 0 },
        "linkA",
      ),
    ).rejects.toMatchObject({ refusal: { code: "already_fortified" } });

    await call<SubmitMoveReply>(
      "submitMove",
      {
        gameId,
        playerToken: p1.playerToken,
        actionType: "reinforce",
        fromQ: -3,
        fromR: 0,
        units: 1,
      },
      "linkA",
    );
    await call<SubmitMoveReply>(
      "submitMove",
      { gameId, playerToken: p2.playerToken, actionType: "pass" },
      "linkB",
    );

    let mountainTested = false;
    let repelledCombatTested = false;

    for (let idx = 0; idx < path.length - 1; idx += 1) {
      const from = path[idx]!;
      const to = path[idx + 1]!;

      let currentBoard = await call<VisibleBoardState>(
        "getVisibleState",
        { gameId, spectator: true },
        "owner",
      );
      if (currentBoard.game.status === "finished") break;

      if (!mountainTested && axialDistance(from.q, from.r, mountain.q, mountain.r) === 1) {
        const fromTileCheck = currentBoard.tiles.find((t) => t.q === from.q && t.r === from.r)!;
        if (fromTileCheck.ownerSeat === 1 && (fromTileCheck.units ?? 0) > 1) {
          await expect(
            call(
              "submitMove",
              {
                gameId,
                playerToken: p1.playerToken,
                actionType: "march",
                fromQ: from.q,
                fromR: from.r,
                toQ: mountain.q,
                toR: mountain.r,
                units: 1,
              },
              "linkA",
            ),
          ).rejects.toMatchObject({ refusal: { code: "impassable_terrain" } });
          mountainTested = true;
        }
      }

      while (true) {
        currentBoard = await call<VisibleBoardState>(
          "getVisibleState",
          { gameId, spectator: true },
          "owner",
        );
        const fromTile = currentBoard.tiles.find((t) => t.q === from.q && t.r === from.r)!;
        const toTile = currentBoard.tiles.find((t) => t.q === to.q && t.r === to.r)!;
        const p1Row = currentBoard.players.find((p) => p.seat === 1)!;

        const defBonus =
          (toTile.units ?? 0) > 0
            ? (toTile.terrain === "capital" ? 2 : toTile.terrain === "forest" ? 1 : 0) +
              (toTile.fortified ? 2 : 0)
            : 0;
        const requiredToCapture =
          toTile.ownerSeat === 1 ? 1 : (toTile.units ?? 0) + defBonus + 1;

        if (
          !repelledCombatTested &&
          to.q === 3 &&
          to.r === 0 &&
          (fromTile.units ?? 0) >= 3 &&
          (toTile.units ?? 0) >= 4
        ) {
          const probe = await call<SubmitMoveReply>(
            "submitMove",
            {
              gameId,
              playerToken: p1.playerToken,
              actionType: "march",
              fromQ: from.q,
              fromR: from.r,
              toQ: to.q,
              toR: to.r,
              units: 2,
            },
            "linkA",
          );
          expect(probe.outcome.captured).toBe(false);
          expect(probe.outcome.attackerLosses).toBe(2);
          repelledCombatTested = true;
          await call<SubmitMoveReply>(
            "submitMove",
            { gameId, playerToken: p2.playerToken, actionType: "pass" },
            "linkB",
          );
          continue;
        }

        if ((fromTile.units ?? 0) - 1 >= requiredToCapture) {
          const marchCount = (fromTile.units ?? 0) - 1;
          const moveRes = await call<SubmitMoveReply>(
            "submitMove",
            {
              gameId,
              playerToken: p1.playerToken,
              actionType: "march",
              fromQ: from.q,
              fromR: from.r,
              toQ: to.q,
              toR: to.r,
              units: marchCount,
            },
            "linkA",
          );
          if (moveRes.state.game.status === "finished") {
            expect(moveRes.state.game.winnerSeat).toBe(1);
            expect(moveRes.state.game.winReason).toBe("capital_captured");
            expect(moveRes.outcome.capitalCaptured).toBe(true);
            break;
          }
          await call<SubmitMoveReply>(
            "submitMove",
            { gameId, playerToken: p2.playerToken, actionType: "pass" },
            "linkB",
          );
          break;
        }

        const deployable = Math.min(5, Math.floor((p1Row.gold ?? 0) / 2));
        if (deployable >= 1) {
          await call<SubmitMoveReply>(
            "submitMove",
            {
              gameId,
              playerToken: p1.playerToken,
              actionType: "reinforce",
              fromQ: from.q,
              fromR: from.r,
              units: deployable,
            },
            "linkA",
          );
        } else {
          await call<SubmitMoveReply>(
            "submitMove",
            { gameId, playerToken: p1.playerToken, actionType: "pass" },
            "linkA",
          );
        }
        await call<SubmitMoveReply>(
          "submitMove",
          { gameId, playerToken: p2.playerToken, actionType: "pass" },
          "linkB",
        );
      }
    }

    const finalBoard = await call<VisibleBoardState>(
      "getVisibleState",
      { gameId, playerToken: p2.playerToken },
      "linkB",
    );
    expect(finalBoard.game.status).toBe("finished");
    expect(finalBoard.game.winnerSeat).toBe(1);
    expect(finalBoard.game.winReason).toBe("capital_captured");
    expect(finalBoard.game.seed).toBe(2026);
    expect(finalBoard.viewer.foggedTiles).toBe(0);
    expect(repelledCombatTested).toBe(true);

    const replay = await call<ReplayPayload>("replayGame", { gameId }, "linkB");
    expect(replay.moves.length).toBeGreaterThan(5);
    expect(replay.nextAfterTurn).toBeNull();
    expect("joinCode" in replay.game).toBe(false);

    const pagedMoves = [];
    let cursor: number | null = 0;
    let pageCount = 0;
    while (cursor !== null) {
      const page = await call<ReplayPayload>(
        "replayGame",
        { gameId, afterTurn: cursor, limit: 2 },
        "linkB",
      );
      expect(page.moves.length).toBeLessThanOrEqual(2);
      pagedMoves.push(...page.moves);
      cursor = page.nextAfterTurn;
      pageCount += 1;
    }
    expect(pageCount).toBeGreaterThan(3);
    expect(pagedMoves).toEqual(replay.moves);

    const frames = reconstructReplayFrames(replay);
    expect(frames).toHaveLength(replay.moves.length + 1);

    const lastFrame = frames[frames.length - 1]!;
    const sortTiles = (
      list: ReadonlyArray<{
        q: number;
        r: number;
        terrain: string | null;
        ownerSeat: number | null;
        units: number | null;
        fortified: boolean;
      }>,
    ) =>
      [...list]
        .map(({ q, r, terrain, ownerSeat, units, fortified }) => ({
          q,
          r,
          terrain,
          ownerSeat,
          units,
          fortified,
        }))
        .sort((a, b) => a.r - b.r || a.q - b.q);

    expect(sortTiles(lastFrame.tiles)).toEqual(sortTiles(finalBoard.tiles));
    expect(lastFrame.seat1Gold).toBe(finalBoard.players.find((p) => p.seat === 1)!.gold);
    expect(lastFrame.seat2Gold).toBe(finalBoard.players.find((p) => p.seat === 2)!.gold);
  }, 30_000);

  it("boots inside dohc's sandboxed iframe over the real MessagePort broker, plays turns, and resumes a seat key across reload", async () => {
    const files = await loadExampleFiles();
    const rawDef = JSON.parse(files.get("hex-tactics/dataset.json")!);
    const definition = parseDatasetDefinition(rawDef, {
      descriptorPath: "hex-tactics/dataset.json",
    });
    const schemaSql = files.get("hex-tactics/schema.sql")!;
    const operationSource = files.get("hex-tactics/operations.js")!;
    const revision = describeDatasetRevision({
      definition,
      revision: 1,
      schemaSql,
      operationSource,
    });

    const controller = new AbortController();

    const verified = await verifyLocalAppFrontend(
      {
        action: "verifyFrontend",
        workspaceId: "w",
        appRoot: "hex-tactics",
      },
      {
        workspaceId: "w",
        workspaceRoot: EXAMPLE_ROOT,
        signal: controller.signal,
        assertCurrent() {},
        flushCapture: async () => ({ deferredWrites: [] }),
        withAdapter: async (work) => work(sourceCaptureAdapter(files)),
        compile: (req) => compileClosedApp(req),
        compileDataset: (src, path) => compileDatasetOperations(src, path),
        datasetRuntime: {},
        approvedArtifacts: async () => ({
          revision,
          schemaSql,
          operationSource,
          active: true,
        }),
        verificationPublication: async () => {
          throw new Error("Unexpected publicationId path");
        },
        runBrowser: async (browserInput) => {
          const started = await browserInput.startSession();
          const browser = await chromium.launch({ headless: true });
          const errors: string[] = [];
          const observedCalls: Array<{
            op: string;
            operation?: string;
            ok: boolean;
            status: number;
          }> = [];
          let handshakeDelivered = false;
          let messageCount = 0;

          try {
            const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
            const page = await context.newPage();
            await page.exposeFunction("__dohcVerifyObserve", (raw: string) => {
              const event = JSON.parse(raw) as {
                kind?: string;
                op?: string;
                operation?: string;
                ok?: boolean;
                status?: number;
              };
              if (event.kind === "handshake-delivered") handshakeDelivered = true;
              if (event.kind === "completed") {
                messageCount += 1;
                observedCalls.push({
                  op: event.op ?? "backend.invoke",
                  ...(event.operation ? { operation: event.operation } : {}),
                  ok: Boolean(event.ok),
                  status: typeof event.status === "number" ? event.status : 200,
                });
              }
            });
            page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
            page.on("console", (msg) => {
              if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
            });

            await page.goto(started.url, { waitUntil: "domcontentloaded" });
            const frame = page.frameLocator("iframe").first();
            await frame.locator("#start-demo-btn").waitFor({ state: "visible", timeout: 15_000 });
            await frame.locator("#start-demo-btn").click();
            await frame.locator('[data-hex="-3,0"][data-visible="true"]').waitFor({
              state: "visible",
              timeout: 15_000,
            });
            expect(
              await frame.locator('[data-hex="3,0"]').getAttribute("data-visible"),
            ).toBe("false");

            await frame.locator('[data-hex="-3,0"]').click();
            await frame.locator('[data-hex="-2,0"]').click();
            await frame.locator("#order-march-btn").click();
            await frame.locator('[data-hex="3,0"][data-visible="true"]').waitFor({
              state: "visible",
              timeout: 15_000,
            });

            await frame.locator("#open-seat-key-btn").click();
            await frame.locator("#copy-seat-key-btn").click();
            await frame.locator("#seat-key-feedback").waitFor({
              state: "visible",
              timeout: 5_000,
            });
            const copyFeedback = await frame.locator("#seat-key-feedback").textContent();
            expect(copyFeedback).toMatch(/Copied to clipboard|Press Ctrl\+C/i);
            const seat2Key = await frame.locator("#seat-key-value").inputValue();
            expect(seat2Key).toMatch(/^HC1:g_[^:]+:[a-f0-9]{64}$/);

            await page.reload({ waitUntil: "domcontentloaded" });
            const reloadedFrame = page.frameLocator("iframe").first();
            await reloadedFrame.locator("#open-resume-btn").waitFor({
              state: "visible",
              timeout: 15_000,
            });
            await reloadedFrame.locator("#open-resume-btn").click();
            await reloadedFrame.locator("#resume-key-input").fill(seat2Key);
            await reloadedFrame.locator("#submit-resume-btn").click();
            await reloadedFrame.locator('[data-hex="3,0"][data-visible="true"]').waitFor({
              state: "visible",
              timeout: 15_000,
            });
            expect(
              await reloadedFrame.locator('[data-hex="-3,0"]').getAttribute("data-visible"),
            ).toBe("false");

            await reloadedFrame.locator("#order-resign-btn").click();
            await reloadedFrame.locator("#confirm-resign-btn").waitFor({
              state: "visible",
              timeout: 5_000,
            });
            expect(await reloadedFrame.locator("#replay-toggle-btn").count()).toBe(0);
            await reloadedFrame.locator("#cancel-resign-btn").click();
            await reloadedFrame.locator("#confirm-resign-btn").waitFor({
              state: "hidden",
              timeout: 5_000,
            });
            expect(await reloadedFrame.locator("#replay-toggle-btn").count()).toBe(0);

            await reloadedFrame.locator("#order-resign-btn").click();
            await reloadedFrame.locator("#confirm-resign-btn").waitFor({
              state: "visible",
              timeout: 5_000,
            });
            await reloadedFrame.locator("#confirm-resign-btn").click();
            await reloadedFrame.locator("#replay-toggle-btn").waitFor({
              state: "visible",
              timeout: 15_000,
            });
            await reloadedFrame.locator("#replay-toggle-btn").click();
            await reloadedFrame.locator('[data-testid="replay-controls"]').waitFor({
              state: "visible",
              timeout: 15_000,
            });
            expect(
              await reloadedFrame.locator('[data-hex="-3,0"]').getAttribute("data-interactive"),
            ).toBe("false");
            expect(
              await reloadedFrame.locator('[data-hex="-3,0"]').getAttribute("role"),
            ).toBeNull();
            expect(await reloadedFrame.locator("button.hc-move-btn").count()).toBeGreaterThanOrEqual(
              2,
            );

            expect(errors).toEqual([]);
            expect(handshakeDelivered).toBe(true);
            expect(messageCount).toBeGreaterThanOrEqual(5);

            return {
              ok: true,
              stage: "complete",
              startupOk: true,
              stepsOk: true,
              handshake: { delivered: handshakeDelivered, messageCount },
              brokerCalls: observedCalls,
              steps: [],
              externalRequestsBlocked: 0,
              diagnostics: [],
            };
          } finally {
            await browser.close();
          }
        },
      },
    );

    expect(verified.ok).toBe(true);
    expect(verified.stage).toBe("complete");
    expect(verified.handshake.delivered).toBe(true);
    expect(verified.diagnostics).toEqual([]);
  }, 45_000);
});
