import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { transform } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { parseDatasetDefinition } from "@dohc/security-contract/dataset";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import { createDatasetJournal } from "./journal.ts";
import { createDatasetSupervisor } from "./supervisor.ts";
import { createDatasetHost } from "./dataset-host.ts";
import { privateFolder } from "./private-folder.test-helper";

type Context = "owner" | "scorer" | "fan";
type Json = Record<string, any>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const read = (file: string) =>
  readFileSync(new URL(`../../../examples/tournament/${file}`, import.meta.url), "utf8");

async function fixture() {
  const definition = parseDatasetDefinition(JSON.parse(read("dataset.json")), {
    descriptorPath: "tournament/dataset.json",
  });
  const schemaSql = read("schema.sql");
  const operationSource = read("operations.js");
  const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
  const directory = await mkdtemp(join(tmpdir(), "dohc-tournament-"));
  const db = new DatabaseSync(join(directory, "host.sqlite"));
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
  const supervisor = await createDatasetSupervisor({
    journal,
    directory: privateFolder(join(directory, "workers")),
  });
  cleanups.push(async () => {
    await supervisor.close();
    db.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  });
  const host = createDatasetHost<Context>({
    db,
    transaction,
    journal,
    supervisor,
    resolveAuthority(context, request) {
      if (request.access.kind === "app" && request.access.appId !== "spectator")
        throw new Error("Wrong app credential");
      return {
        principalKey: context,
        ...(request.access.kind === "app" ? { appId: request.access.appId } : {}),
        caller:
          context === "owner"
            ? { kind: "owner", userId: "owner" }
            : context === "scorer"
              ? {
                  kind: "named",
                  userId: "scorer",
                  grantId: "court-crew",
                  access: "view",
                  helper: false,
                }
              : { kind: "link", principalId: "fan", grantId: "spectators" },
      };
    },
    compileOperations: async (source) =>
      (await transform(source, { loader: "js", target: "es2022" })).code,
    operationResources: () => ({ files: [], accountAndAttach: () => undefined }),
  });
  const scope = { workspaceId: "workspace", datasetId: definition.datasetId };
  await host.activate("owner", { workspaceId: "workspace", revision, schemaSql, operationSource });
  const operation = (name: string) => {
    const found = definition.operations.find((entry) => entry.name === name);
    if (!found) throw new Error(`Unknown operation ${name}`);
    return found;
  };
  const spectatorManifest = JSON.parse(read("spectator/app.publish.json"));
  host.setBinding("owner", {
    ...scope,
    appId: "spectator",
    binding: {
      kind: "dataset",
      datasetId: definition.datasetId,
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationIds: (spectatorManifest.dataset.operations as string[]).map(
        (name) => operation(name).operationId,
      ),
    },
  });
  host.setDataGrant("owner", {
    ...scope,
    principalKey: "scorer",
    grant: {
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationIds: definition.operations
        .filter((entry) => entry.access === "helper")
        .map((entry) => entry.operationId),
      discover: true,
    },
  });
  let sequence = 0;
  async function call(name: string, input: AppBackendJson = {}, context: Context = "owner") {
    const reply = await host.invoke(context, {
      ...scope,
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationId: operation(name).operationId,
      input,
      idempotencyKey: `call-${++sequence}`,
      ...(context === "fan" ? { access: { kind: "app", appId: "spectator" } as const } : {}),
    });
    return reply.result as Json;
  }
  const snapshot = (tournamentId?: string, context: Context = "owner") =>
    call("liveSnapshot", tournamentId ? { tournamentId } : {}, context);
  return { definition, call, snapshot };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function roster(ratings: number[]) {
  return ratings.map((rating, index) => ({ name: `Player ${index + 1}`, rating }));
}

async function createTournament(f: Fixture, ratings: number[], courts = 4) {
  const created = await f.call("createTournament", {
    name: "Test Open",
    sport: "Pickleball",
    courts,
    pointsToWin: 11,
    winBy: 2,
    kFactor: 32,
    players: roster(ratings),
  });
  return { created, view: await f.snapshot(created.tournamentId) };
}

function matchAt(view: Json, round: number, slot: number): Json {
  return view.matches.find((match: Json) => match.round === round && match.slot === slot);
}

function freeCourt(view: Json): Json {
  return view.courts.find((court: Json) => court.matchId === null);
}

async function playTo(
  f: Fixture,
  matchId: string,
  courtId: string,
  points: Array<"a" | "b">,
  context: Context = "owner",
) {
  let tournamentId = "";
  let version = 0;
  const view = await f.snapshot();
  tournamentId = view.tournament.id;
  version = view.matches.find((match: Json) => match.id === matchId).version;
  let match = await f.call("startMatch", { matchId, courtId, expectedVersion: version }, context);
  for (const side of points)
    match = await f.call("scorePoint", { matchId, side, expectedVersion: match.version }, context);
  return { match, tournamentId };
}

const elevenTo = (losing: number, winner: "a" | "b") => {
  const loser = winner === "a" ? "b" : "a";
  return [
    ...Array.from({ length: losing }, () => loser),
    ...Array.from({ length: 11 }, () => winner),
  ];
};

describe("tournament example on the real Collection host", () => {
  it("seeds deterministic single-elimination brackets and advances byes for 3 to 32 players", async () => {
    const f = await fixture();
    for (const count of [3, 4, 5, 8, 12, 16, 17, 32]) {
      const ratings = Array.from({ length: count }, (_, index) => 1200 + index * 10);
      const { created, view } = await createTournament(f, ratings);
      const size = [4, 8, 16, 32].find((candidate) => candidate >= count)!;
      expect(created).toMatchObject({ bracketSize: size, byes: size - count });
      expect(view.matches).toHaveLength(size - 1);
      expect(
        view.standings.map((player: Json) => player.seed).sort((a: number, b: number) => a - b),
      ).toEqual(Array.from({ length: count }, (_, index) => index + 1));
      const bySeed = new Map<number, string>(view.standings.map((p: Json) => [p.seed, p.id]));
      const firstRound = view.matches.filter((match: Json) => match.round === 1);
      const byes = firstRound.filter((match: Json) => match.status === "bye");
      expect(byes).toHaveLength(size - count);
      expect(byes.map((match: Json) => match.winnerId).sort()).toEqual(
        Array.from({ length: size - count }, (_, index) => bySeed.get(index + 1)).sort(),
      );
      for (const bye of byes) {
        const next = view.matches.find((match: Json) => match.id === bye.nextMatchId);
        expect(bye.nextSlot === "a" ? next.playerA : next.playerB).toBe(bye.winnerId);
      }
      expect(
        firstRound
          .filter((match: Json) => match.status === "ready")
          .every((match: Json) => match.playerA && match.playerB),
      ).toBe(true);
      expect(view.matches.filter((match: Json) => match.status === "live")).toHaveLength(0);
    }
    const { view } = await createTournament(f, [1800, 1700, 1600, 1500, 1400, 1300, 1200, 1100]);
    const seedOf = new Map<string, number>(view.standings.map((p: Json) => [p.id, p.seed]));
    expect(
      view.matches
        .filter((match: Json) => match.round === 1)
        .map((match: Json) => [seedOf.get(match.playerA), seedOf.get(match.playerB)]),
    ).toEqual([
      [1, 8],
      [4, 5],
      [2, 7],
      [3, 6],
    ]);
    await expect(
      f.call("createTournament", {
        name: "Too big",
        sport: "Pickleball",
        players: roster(Array.from({ length: 33 }, () => 1500)),
      }),
    ).rejects.toMatchObject({ refusal: { code: "invalid_input" } });
  }, 120_000);

  it("refuses stale double taps from concurrent scorekeepers with a conflict", async () => {
    const f = await fixture();
    const { view } = await createTournament(f, [1600, 1550, 1450, 1400]);
    const opening = matchAt(view, 1, 1);
    const started = await f.call("startMatch", {
      matchId: opening.id,
      courtId: view.courts[0].id,
      expectedVersion: opening.version,
    });
    const taps = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        f.call(
          "scorePoint",
          { matchId: opening.id, side: index % 2 ? "b" : "a", expectedVersion: started.version },
          index % 2 ? "scorer" : "owner",
        ),
      ),
    );
    const accepted = taps.filter((tap) => tap.status === "fulfilled");
    const refused = taps.filter((tap) => tap.status === "rejected") as PromiseRejectedResult[];
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(5);
    for (const tap of refused)
      expect(tap.reason).toMatchObject({
        refusal: {
          code: "conflict",
          message: expect.stringMatching(
            /^Someone else updated Semifinal 1 first\. The score is now [01]–[01];/,
          ),
        },
      });
    const after = matchAt(await f.snapshot(), 1, 1);
    expect(after.scoreA + after.scoreB).toBe(1);
    expect(after.version).toBe(started.version + 1);
    const log = await f.call("matchLog", { matchId: opening.id }, "scorer");
    expect(log.filter((event: Json) => event.kind === "point")).toHaveLength(1);
  }, 60_000);

  it("completes a match atomically, updates ratings, frees the court, and advances the winner", async () => {
    const f = await fixture();
    const { view } = await createTournament(f, [1600, 1550, 1450, 1400], 1);
    const court = view.courts[0];
    const opener = matchAt(view, 1, 1);
    const second = matchAt(view, 1, 2);
    const { match } = await playTo(f, opener.id, court.id, elevenTo(7, "b"), "scorer");
    expect(match).toMatchObject({ scoreA: 7, scoreB: 11, status: "live" });

    await expect(
      f.call("startMatch", {
        matchId: second.id,
        courtId: court.id,
        expectedVersion: second.version,
      }),
    ).rejects.toMatchObject({ refusal: { code: "court_busy" } });
    await expect(
      f.call("scorePoint", { matchId: opener.id, side: "a", expectedVersion: match.version }),
    ).rejects.toMatchObject({ refusal: { code: "match_decided" } });
    await expect(
      f.call("completeMatch", { matchId: opener.id, expectedVersion: match.version - 1 }),
    ).rejects.toMatchObject({ refusal: { code: "conflict" } });

    const done = await f.call(
      "completeMatch",
      { matchId: opener.id, expectedVersion: match.version },
      "scorer",
    );
    const top = view.standings.find((p: Json) => p.seed === 1);
    const underdog = view.standings.find((p: Json) => p.seed === 4);
    expect(done).toMatchObject({
      winnerId: underdog.id,
      loserId: top.id,
      ratingChange: 24,
      advancedTo: opener.nextMatchId,
      championId: null,
      freedCourtId: court.id,
      match: { status: "done", winnerId: underdog.id },
    });

    const after = await f.snapshot();
    const people = new Map<string, Json>(after.standings.map((p: Json) => [p.id, p]));
    expect(people.get(underdog.id)).toMatchObject({
      rating: 1424,
      wins: 1,
      losses: 0,
      pointsFor: 11,
      pointsAgainst: 7,
      eliminatedRound: null,
    });
    expect(people.get(top.id)).toMatchObject({
      rating: 1576,
      wins: 0,
      losses: 1,
      eliminatedRound: 1,
    });
    expect(after.courts[0].matchId).toBeNull();
    const final = after.matches.find((m: Json) => m.id === opener.nextMatchId);
    expect(final).toMatchObject({ playerA: underdog.id, playerB: null, status: "waiting" });

    await playTo(f, second.id, court.id, elevenTo(9, "a"));
    const secondView = await f.snapshot();
    const secondLive = matchAt(secondView, 1, 2);
    await f.call("completeMatch", { matchId: second.id, expectedVersion: secondLive.version });
    const ready = matchAt(await f.snapshot(), 2, 1);
    expect(ready.status).toBe("ready");
    const seed2 = view.standings.find((p: Json) => p.seed === 2);
    expect(ready).toMatchObject({ playerA: underdog.id, playerB: seed2.id });
    const twoSeed = (await f.snapshot()).standings.find((p: Json) => p.id === seed2.id);
    expect(twoSeed.rating).toBe(1550 + 12);

    await expect(
      f.call("completeMatch", { matchId: ready.id, expectedVersion: ready.version }),
    ).rejects.toMatchObject({ refusal: { code: "match_not_live" } });
    const finalPlay = await playTo(f, ready.id, court.id, [...elevenTo(9, "a").slice(0, 19)]);
    await expect(
      f.call("completeMatch", { matchId: ready.id, expectedVersion: finalPlay.match.version }),
    ).rejects.toMatchObject({ refusal: { code: "not_decided" } });
    const unchanged = await f.snapshot();
    expect(matchAt(unchanged, 2, 1)).toMatchObject({ status: "live", winnerId: null });
    expect(unchanged.tournament).toMatchObject({ status: "live", championId: null });
    const winning = await f.call("scorePoint", {
      matchId: ready.id,
      side: "a",
      expectedVersion: finalPlay.match.version,
    });
    const crowned = await f.call("completeMatch", {
      matchId: ready.id,
      expectedVersion: winning.version,
    });
    expect(crowned).toMatchObject({ championId: underdog.id, advancedTo: null });
    const finished = await f.snapshot();
    expect(finished.tournament).toMatchObject({ status: "finished", championId: underdog.id });
    expect(finished.standings[0]).toMatchObject({ id: underdog.id, place: 1, wins: 2 });
    expect(finished.standings.reduce((sum: number, p: Json) => sum + p.rating, 0)).toBe(
      1600 + 1550 + 1450 + 1400,
    );
    expect(finished.courts[0].matchId).toBeNull();
  }, 60_000);

  it("undoes interleaved points through the latest matching total and refuses when nothing is left", async () => {
    const f = await fixture();
    const { view } = await createTournament(f, [1500, 1500, 1500, 1500]);
    const opener = matchAt(view, 1, 1);
    const { match } = await playTo(f, opener.id, view.courts[0].id, ["a", "b"]);
    const afterUndoB = await f.call("undoPoint", {
      matchId: opener.id,
      expectedVersion: match.version,
    });
    expect(afterUndoB).toMatchObject({ scoreA: 1, scoreB: 0 });
    const rescoreA = await f.call("scorePoint", {
      matchId: opener.id,
      side: "a",
      expectedVersion: afterUndoB.version,
    });
    expect(rescoreA).toMatchObject({ scoreA: 2, scoreB: 0 });
    const first = await f.call("undoPoint", {
      matchId: opener.id,
      expectedVersion: rescoreA.version,
    });
    expect(first).toMatchObject({ scoreA: 1, scoreB: 0 });
    const second = await f.call("undoPoint", {
      matchId: opener.id,
      expectedVersion: first.version,
    });
    expect(second).toMatchObject({ scoreA: 0, scoreB: 0 });
    await expect(
      f.call("undoPoint", { matchId: opener.id, expectedVersion: second.version }),
    ).rejects.toMatchObject({ refusal: { code: "nothing_to_undo" } });
    const log = await f.call("matchLog", { matchId: opener.id });
    expect(log.map((event: Json) => `${event.kind}:${event.side ?? ""}`)).toEqual([
      "undo:a",
      "undo:a",
      "point:a",
      "undo:b",
      "point:b",
      "point:a",
      "start:",
    ]);
    expect(log[0]).toMatchObject({ actor: "owner", scoreA: 0, scoreB: 0 });
  }, 60_000);

  it("keeps the spectator app manifest and imports inside tournament/spectator for default View links", () => {
    const manifest = JSON.parse(read("spectator/app.publish.json")) as {
      entryPath: string;
      inputs?: string[];
      dataset: { operations: string[] };
    };
    expect(manifest.entryPath).not.toMatch(/^(?:\/|\.\.)/);
    expect(manifest.inputs ?? []).toEqual([]);
    expect(manifest.dataset.operations).toEqual(["liveSnapshot"]);
    const spectatorDir = fileURLToPath(
      new URL("../../../examples/tournament/spectator", import.meta.url),
    );
    const files = readdirSync(spectatorDir).filter((name) => /\.(?:ts|tsx|css)$/.test(name));
    expect(files).toContain(manifest.entryPath);
    for (const file of files) {
      const source = read(`spectator/${file}`);
      expect(source, file).not.toMatch(/from\s+["']\.\.\//);
      expect(source, file).not.toMatch(/import\s+["']\.\.\//);
    }
  });

  it("lets the spectator link read the live board and refuses every organizer and scorekeeper action", async () => {
    const f = await fixture();
    const { view } = await createTournament(f, [1600, 1550, 1450, 1400]);
    const opener = matchAt(view, 1, 1);
    const fanView = await f.snapshot(view.tournament.id, "fan");
    expect(fanView.matches).toEqual(view.matches);
    expect(JSON.stringify(fanView)).not.toContain('"actor"');
    const attempts: Array<[string, AppBackendJson]> = [
      ["createTournament", { name: "Hijack", sport: "Esports", players: roster([1, 2, 3]) }],
      ["seedDemo", {}],
      [
        "startMatch",
        { matchId: opener.id, courtId: view.courts[0].id, expectedVersion: opener.version },
      ],
      ["scorePoint", { matchId: opener.id, side: "a", expectedVersion: opener.version }],
      ["undoPoint", { matchId: opener.id, expectedVersion: opener.version }],
      ["completeMatch", { matchId: opener.id, expectedVersion: opener.version }],
      ["matchLog", { matchId: opener.id }],
    ];
    for (const [name, input] of attempts)
      await expect(f.call(name, input, "fan"), name).rejects.toThrow();
    for (const name of ["createTournament", "seedDemo"])
      await expect(f.call(name, {}, "scorer"), name).rejects.toThrow();
    const unchanged = await f.snapshot();
    expect(unchanged.tournaments).toHaveLength(1);
    expect(unchanged.matches).toEqual(view.matches);

    for (let i = 0; i < 20; i += 1) await createTournament(f, [1600, 1550, 1450, 1400]);
    const pinnedFanView = await f.snapshot(view.tournament.id, "fan");
    expect(pinnedFanView.tournament.id).toBe(view.tournament.id);
    expect(pinnedFanView.tournaments.some((entry: Json) => entry.id === view.tournament.id)).toBe(
      true,
    );
  }, 60_000);

  it("loads the 16-player demo mid-tournament and plays it through to a champion", async () => {
    const f = await fixture();
    const { tournamentId } = await f.call("seedDemo");
    const demo = await f.snapshot(tournamentId);
    expect(demo.tournament).toMatchObject({ bracketSize: 16, status: "live", championId: null });
    expect(demo.standings).toHaveLength(16);
    expect(demo.matches.filter((m: Json) => m.round === 1 && m.status === "done")).toHaveLength(8);
    expect(
      demo.matches
        .filter((m: Json) => m.round === 2)
        .map((m: Json) => [m.status, m.scoreA, m.scoreB]),
    ).toEqual([
      ["done", expect.any(Number), expect.any(Number)],
      ["done", expect.any(Number), expect.any(Number)],
      ["live", 9, 7],
      ["live", 5, 6],
    ]);
    expect(matchAt(demo, 3, 1).status).toBe("ready");
    expect(demo.courts.filter((court: Json) => court.matchId)).toHaveLength(2);
    expect(demo.rallies).toBeGreaterThan(150);
    expect(demo.recent.length).toBeGreaterThan(0);
    for (const live of demo.matches.filter((m: Json) => m.status === "live")) {
      expect(live.startedAt).toBeLessThan(demo.now - 60_000);
      const log = await f.call("matchLog", { matchId: live.id });
      for (const event of log) expect(event.at).toBeLessThanOrEqual(demo.now);
    }
    const startSum = demo.standings.reduce((sum: number, p: Json) => sum + p.startRating, 0);
    expect(demo.standings.reduce((sum: number, p: Json) => sum + p.rating, 0)).toBe(startSum);

    let view = demo;
    for (let guard = 0; view.tournament.status === "live" && guard < 20; guard += 1) {
      const live = view.matches.find((m: Json) => m.status === "live");
      if (live) {
        let current = live;
        while (
          !(
            Math.max(current.scoreA, current.scoreB) >= 11 &&
            Math.abs(current.scoreA - current.scoreB) >= 2
          )
        )
          current = await f.call("scorePoint", {
            matchId: current.id,
            side: current.scoreA >= current.scoreB ? "a" : "b",
            expectedVersion: current.version,
          });
        await f.call("completeMatch", { matchId: current.id, expectedVersion: current.version });
      } else {
        const ready = view.matches.find((m: Json) => m.status === "ready");
        await f.call("startMatch", {
          matchId: ready.id,
          courtId: freeCourt(view).id,
          expectedVersion: ready.version,
        });
      }
      view = await f.snapshot(tournamentId);
    }
    expect(view.tournament.status).toBe("finished");
    const champion = view.standings.filter((p: Json) => p.eliminatedRound === null);
    expect(champion).toHaveLength(1);
    expect(view.tournament.championId).toBe(champion[0].id);
    expect(view.standings[0]).toMatchObject({ id: champion[0].id, place: 1, wins: 4 });
    expect(view.courts.every((court: Json) => court.matchId === null)).toBe(true);
    expect(view.standings.reduce((sum: number, p: Json) => sum + p.rating, 0)).toBe(startSum);
  }, 120_000);
});
