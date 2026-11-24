import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { compileClosedApp } from "./closedAppCompiler";
import { createLocalDatasetHost, type LocalDatasetHost } from "./localDatasetHost";
import { createLocalStagedApps } from "./localStagedApps";
import { readLocalStateFrom } from "./workspaceLocalState";
import { openedLocalState } from "../testing/preparedLocalState";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";
import { createDatasetFixtureCompiler } from "../testing/datasetFixtureCompiler";
import { unguardedCollections } from "../testing/collectionsHolder";
import { reconstructReplayFrames } from "../../../../examples/hex-tactics/replay";
import type {
  ReplayPayload,
  StartDemoReply,
  SubmitMoveReply,
  VisibleBoardState,
} from "../../../../examples/hex-tactics/types";

const EXAMPLE_ROOT = resolve(import.meta.dirname, "../../../../examples/hex-tactics");
const roots: string[] = [];
const hosts: LocalDatasetHost[] = [];

afterEach(async () => {
  const failures: unknown[] = [];
  readLocalStateFrom(null);
  for (const host of hosts.splice(0)) {
    try {
      await host.close();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const root of roots.splice(0)) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 25 });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
});

async function exampleFiles(): Promise<Map<string, string>> {
  const entries = await readdir(EXAMPLE_ROOT, { withFileTypes: true });
  const files = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith(".test.mts") || entry.name === "README.md") continue;
    files.set(`hex-tactics/${entry.name}`, await readFile(join(EXAMPLE_ROOT, entry.name), "utf8"));
  }
  return files;
}

it("stages HexClash, enforces server-side fog of war, runs turns, and replays a finished match", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-hex-tactics-"));
  roots.push(workspaceRoot);
  await openedLocalState({ workspaceId: "w", rootPath: workspaceRoot });
  const host = await createLocalDatasetHost({
    localPersonId: () => "owner-1",
    workspaceId: "w",
    workspaceRoot,
    capacityBytes: 8 * 1024 * 1024,
    compile: createDatasetFixtureCompiler(),
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

  const signal = new AbortController().signal;
  const summary = await staged.stage({
    appRoot: "hex-tactics",
    deferredWrites: [],
    adapter: sourceCaptureAdapter(await exampleFiles()),
    signal,
  });
  const approved = await staged.approve({
    stageId: summary.stageId,
    reviewDigest: summary.reviewDigest,
    signal,
  });

  let callSeq = 0;
  const invoke = async <T>(operation: string, input: unknown = {}): Promise<T> =>
    (
      (await host.apps.request(approved.publicationId, "invoke", {
        authorityRevision: approved.authorityRevision,
        operation,
        idempotencyKey: `hex-${++callSeq}`,
        input,
      })) as { result: T }
    ).result;

  const demo = await invoke<StartDemoReply>("startDemoMatch", { seed: 2026 });
  expect(demo.seats).toHaveLength(2);
  const [seat1, seat2] = demo.seats;

  const p1View = await invoke<VisibleBoardState>("getVisibleState", {
    gameId: demo.gameId,
    playerToken: seat1!.playerToken,
  });
  expect(p1View.viewer.seat).toBe(1);
  expect(p1View.viewer.foggedTiles).toBeGreaterThan(0);
  const enemyCapital = p1View.tiles.find((tile) => tile.q === 3 && tile.r === 0);
  expect(enemyCapital).toMatchObject({ visible: false, ownerSeat: null, units: null });
  expect(JSON.stringify(p1View)).not.toContain(seat1!.playerToken);
  expect(JSON.stringify(p1View)).not.toContain(seat2!.playerToken);

  await expect(
    invoke("submitMove", {
      gameId: demo.gameId,
      playerToken: "a".repeat(64),
      actionType: "pass",
    }),
  ).rejects.toMatchObject({ refusal: { code: "unauthorized_player" } });

  await expect(
    invoke("submitMove", {
      gameId: demo.gameId,
      playerToken: seat2!.playerToken,
      actionType: "pass",
    }),
  ).rejects.toMatchObject({ refusal: { code: "not_your_turn" } });

  await expect(
    invoke("submitMove", {
      gameId: demo.gameId,
      playerToken: seat1!.playerToken,
      actionType: "pass",
      expectedTurn: p1View.game.turnNumber + 1,
    }),
  ).rejects.toMatchObject({ refusal: { code: "stale_turn" } });

  await expect(
    invoke("submitMove", {
      gameId: demo.gameId,
      playerToken: seat1!.playerToken,
      actionType: "march",
      expectedTurn: p1View.game.turnNumber,
      fromQ: -3,
      fromR: 0,
      toQ: -1,
      toR: 0,
      units: 2,
    }),
  ).rejects.toMatchObject({ refusal: { code: "not_adjacent" } });

  const marched = await invoke<SubmitMoveReply>("submitMove", {
    gameId: demo.gameId,
    playerToken: seat1!.playerToken,
    actionType: "march",
    expectedTurn: p1View.game.turnNumber,
    fromQ: -3,
    fromR: 0,
    toQ: -2,
    toR: 0,
    units: 2,
  });
  expect(marched.state.game.activeSeat).toBe(2);
  expect(marched.state.game.turnNumber).toBe(p1View.game.turnNumber + 1);

  const resigned = await invoke<SubmitMoveReply>("submitMove", {
    gameId: demo.gameId,
    playerToken: seat2!.playerToken,
    actionType: "resign",
    expectedTurn: marched.state.game.turnNumber,
  });
  expect(resigned.state.game.status).toBe("finished");
  expect(resigned.state.game.winnerSeat).toBe(1);

  const replay = await invoke<ReplayPayload>("replayGame", { gameId: demo.gameId });
  expect(replay.moves).toHaveLength(2);
  expect("joinCode" in replay.game).toBe(false);
  const frames = reconstructReplayFrames(replay);
  expect(frames).toHaveLength(3);
  const finalBoard = await invoke<VisibleBoardState>("getVisibleState", {
    gameId: demo.gameId,
    spectator: true,
  });
  const normalizeTiles = (
    list: ReadonlyArray<{
      q: number;
      r: number;
      terrain: string | null;
      ownerSeat: number | null;
      units: number | null;
      fortified: boolean;
    }>,
  ) =>
    list
      .map(({ q, r, terrain, ownerSeat, units, fortified }) => ({
        q,
        r,
        terrain,
        ownerSeat,
        units,
        fortified,
      }))
      .sort((a, b) => a.r - b.r || a.q - b.q);
  expect(normalizeTiles(frames.at(-1)!.tiles)).toEqual(normalizeTiles(finalBoard.tiles));
});
