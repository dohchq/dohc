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

async function playThrough(
  f: Fixture,
  tournamentId: string,
  pick: (match: Json) => "a" | "b",
): Promise<Json> {
  let view = await f.snapshot(tournamentId);
  const goal = view.tournament.pointsToWin as number;
  const lead = view.tournament.winBy as number;
  const decided = (a: number, b: number) => Math.max(a, b) >= goal && Math.abs(a - b) >= lead;
  for (let guard = 0; view.tournament.status === "live" && guard < 400; guard += 1) {
    const live = view.matches.find((m: Json) => m.status === "live");
    if (live) {
      let current = live;
      const side = pick(current);
      while (!decided(current.scoreA, current.scoreB))
        current = await f.call("scorePoint", {
          matchId: current.id,
          side,
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
  return view;
}

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
    const manual = await f.call("createTournament", {
      name: "Manual seeds",
      sport: "Pickleball",
      seeding: "order",
      players: roster([1100, 1800, 1500, 1300]),
    });
    const manualView = await f.snapshot(manual.tournamentId);
    expect(
      [...manualView.standings]
        .sort((a: Json, b: Json) => a.seed - b.seed)
        .map((player: Json) => player.name),
    ).toEqual(["Player 1", "Player 2", "Player 3", "Player 4"]);
    await expect(
      f.call("createTournament", {
        name: "Bad seeding",
        sport: "Pickleball",
        seeding: "random",
        players: roster([1500, 1400, 1300]),
      }),
    ).rejects.toMatchObject({ refusal: { code: "invalid_input" } });
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
            /^Someone else updated M\d+ \(Semifinal\) first\. The score is now [01]–[01]\.$/,
          ),
        },
      });
    const after = matchAt(await f.snapshot(), 1, 1);
    expect(after.scoreA + after.scoreB).toBe(1);
    expect(after.version).toBe(started.version + 1);
    const log = await f.call("matchLog", { matchId: opening.id }, "scorer");
    expect(log.filter((event: Json) => event.kind === "point")).toHaveLength(1);
  }, 60_000);

  it("returns a live match with no points to the queue, freeing its court and logging who was on it", async () => {
    const f = await fixture();
    const { view } = await createTournament(f, [1600, 1550, 1450, 1400]);
    const opener = matchAt(view, 1, 1);
    const court = view.courts[0].id;
    const started = await f.call(
      "startMatch",
      { matchId: opener.id, courtId: court, expectedVersion: opener.version },
      "scorer",
    );
    await expect(
      f.call("returnToQueue", { matchId: opener.id, expectedVersion: opener.version }, "scorer"),
    ).rejects.toMatchObject({ refusal: { code: "conflict" } });
    const scored = await f.call(
      "scorePoint",
      { matchId: opener.id, side: "a", expectedVersion: started.version },
      "scorer",
    );
    await expect(
      f.call("returnToQueue", { matchId: opener.id, expectedVersion: scored.version }, "scorer"),
    ).rejects.toMatchObject({ refusal: { code: "match_scored" } });
    const undone = await f.call(
      "undoPoint",
      { matchId: opener.id, expectedVersion: scored.version },
      "scorer",
    );
    const returned = await f.call(
      "returnToQueue",
      { matchId: opener.id, expectedVersion: undone.version },
      "scorer",
    );
    expect(returned).toMatchObject({ status: "ready", courtId: null });
    const after = await f.snapshot();
    expect(after.courts.find((entry: Json) => entry.id === court).matchId).toBeNull();
    await expect(
      f.call("returnToQueue", { matchId: opener.id, expectedVersion: returned.version }, "scorer"),
    ).rejects.toMatchObject({ refusal: { code: "match_not_live" } });
    const log = await f.call("matchLog", { matchId: opener.id }, "scorer");
    expect(log.map((event: Json) => event.kind)).toEqual(["cancel", "undo", "point", "start"]);
    for (const event of log)
      expect(event).toMatchObject({ playerA: opener.playerA, playerB: opener.playerB });
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
      f.call("awardWalkover", { matchId: opener.id, winner: "a", expectedVersion: match.version }),
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
      ["returnToQueue", { matchId: opener.id, expectedVersion: opener.version }],
      ["scorePoint", { matchId: opener.id, side: "a", expectedVersion: opener.version }],
      ["undoPoint", { matchId: opener.id, expectedVersion: opener.version }],
      ["completeMatch", { matchId: opener.id, expectedVersion: opener.version }],
      ["reportResult", { matchId: opener.id, games: [[11, 4]], expectedVersion: opener.version }],
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

  it("reopens a wrongly completed match, reversing ratings, the advance, and the crown, until the next match has points", async () => {
    const f = await fixture();
    const { view } = await createTournament(f, [1600, 1550, 1450, 1400], 1);
    const court = view.courts[0];
    const opener = matchAt(view, 1, 1);
    await playTo(f, opener.id, court.id, elevenTo(3, "a"));
    const before = await f.snapshot();
    const done = await f.call(
      "completeMatch",
      { matchId: opener.id, expectedVersion: matchAt(before, 1, 1).version },
      "scorer",
    );
    await expect(
      f.call("reopenMatch", { matchId: opener.id, expectedVersion: done.match.version }, "fan"),
    ).rejects.toThrow();
    const reopened = await f.call(
      "reopenMatch",
      { matchId: opener.id, expectedVersion: done.match.version },
      "scorer",
    );
    expect(reopened).toMatchObject({ ratingChange: -done.ratingChange, courtId: court.id });
    expect(reopened.match).toMatchObject({
      status: "live",
      winnerId: null,
      ratingChange: null,
      scoreA: 11,
      scoreB: 3,
    });
    const after = await f.snapshot();
    const strip = (rows: Json[]) =>
      rows.map(({ id, rating, wins, losses, pointsFor, pointsAgainst, eliminatedRound }) => ({
        id,
        rating,
        wins,
        losses,
        pointsFor,
        pointsAgainst,
        eliminatedRound,
      }));
    expect(strip(after.standings)).toEqual(strip(before.standings));
    expect(matchAt(after, 2, 1)).toMatchObject({ status: "waiting", playerA: null });
    expect(after.courts[0].matchId).toBe(opener.id);
    await expect(
      f.call("reopenMatch", { matchId: opener.id, expectedVersion: reopened.match.version }),
    ).rejects.toMatchObject({ refusal: { code: "not_done" } });

    const redone = await f.call("completeMatch", {
      matchId: opener.id,
      expectedVersion: reopened.match.version,
    });
    const second = matchAt(after, 1, 2);
    await playTo(f, second.id, court.id, elevenTo(4, "b"));
    const semis = await f.snapshot();
    await f.call("completeMatch", {
      matchId: second.id,
      expectedVersion: matchAt(semis, 1, 2).version,
    });
    const final = matchAt(await f.snapshot(), 2, 1);
    await playTo(f, final.id, court.id, []);
    const corrected = await f.call("reopenMatch", {
      matchId: opener.id,
      expectedVersion: redone.match.version,
    });
    expect(corrected.courtId).toBe(court.id);
    expect(matchAt(await f.snapshot(), 2, 1)).toMatchObject({
      status: "waiting",
      playerA: null,
      courtId: null,
    });
    const cancelled = await f.snapshot();
    const fanView = await f.snapshot(cancelled.tournament.id, "fan");
    expect(fanView.recent.filter((entry: Json) => entry.matchId === final.id)).toEqual([]);
    expect(cancelled.recent.find((entry: Json) => entry.matchId === final.id)).toMatchObject({
      kind: "cancel",
      courtId: court.id,
    });
    expect(
      (await f.call("matchLog", { matchId: final.id })).map((entry: Json) => [
        entry.kind,
        entry.playerA,
        entry.playerB,
      ]),
    ).toEqual([
      ["cancel", final.playerA, final.playerB],
      ["start", final.playerA, final.playerB],
    ]);
    const confirmed = await f.call("completeMatch", {
      matchId: opener.id,
      expectedVersion: corrected.match.version,
    });
    await playTo(f, final.id, court.id, ["a"]);
    await expect(
      f.call("reopenMatch", { matchId: opener.id, expectedVersion: confirmed.match.version }),
    ).rejects.toMatchObject({
      refusal: {
        code: "next_started",
        message: "M3 (Final) already has points, so this result can no longer change.",
      },
    });

    const crowned = await f.call("scorePoint", {
      matchId: final.id,
      side: "a",
      expectedVersion: matchAt(await f.snapshot(), 2, 1).version,
    });
    let current = crowned;
    for (let i = 0; i < 9; i += 1)
      current = await f.call("scorePoint", {
        matchId: final.id,
        side: "a",
        expectedVersion: current.version,
      });
    const champion = await f.call("completeMatch", {
      matchId: final.id,
      expectedVersion: current.version,
    });
    expect((await f.snapshot()).tournament).toMatchObject({ status: "finished" });
    await f.call("reopenMatch", { matchId: final.id, expectedVersion: champion.match.version });
    expect((await f.snapshot()).tournament).toMatchObject({ status: "live", championId: null });
  }, 60_000);

  it("gives the spectator link a point-by-point timeline without actors, scoped to the shown tournament", async () => {
    const f = await fixture();
    const { view } = await createTournament(f, [1600, 1550, 1450, 1400]);
    const opener = matchAt(view, 1, 1);
    await playTo(f, opener.id, view.courts[0].id, ["a", "b", "a"], "scorer");
    const fan = await f.call(
      "liveSnapshot",
      { tournamentId: view.tournament.id, matchId: opener.id },
      "fan",
    );
    expect(fan.timeline.map((entry: Json) => [entry.kind, entry.scoreA, entry.scoreB])).toEqual([
      ["point", 2, 1],
      ["point", 1, 1],
      ["point", 1, 0],
      ["start", 0, 0],
    ]);
    expect(JSON.stringify(fan.timeline)).not.toContain("actor");
    expect((await f.snapshot(view.tournament.id, "fan")).timeline).toBeUndefined();

    const scored = await f.call(
      "scorePoint",
      { matchId: opener.id, side: "b", expectedVersion: matchAt(await f.snapshot(), 1, 1).version },
      "scorer",
    );
    await f.call("undoPoint", { matchId: opener.id, expectedVersion: scored.version }, "scorer");
    const corrected = await f.call(
      "liveSnapshot",
      { tournamentId: view.tournament.id, matchId: opener.id },
      "fan",
    );
    expect(
      corrected.timeline.map((entry: Json) => [entry.kind, entry.scoreA, entry.scoreB]),
    ).toEqual([
      ["point", 2, 1],
      ["point", 1, 1],
      ["point", 1, 0],
      ["start", 0, 0],
    ]);
    expect(corrected.recent.map((entry: Json) => entry.kind)).toEqual([
      "point",
      "point",
      "point",
      "start",
    ]);
    const ownerOnSpectator = await f.call("liveSnapshot", {
      tournamentId: view.tournament.id,
      matchId: opener.id,
      view: "public",
    });
    expect(ownerOnSpectator.timeline).toEqual(corrected.timeline);
    expect(ownerOnSpectator.recent.map((entry: Json) => entry.kind)).toEqual(
      corrected.recent.map((entry: Json) => entry.kind),
    );
    expect(
      (await f.snapshot(view.tournament.id)).recent.map((entry: Json) => entry.kind),
    ).toContain("undo");
    expect(
      (await f.call("matchLog", { matchId: opener.id }, "scorer")).map((entry: Json) => entry.kind),
    ).toEqual(["undo", "point", "point", "point", "point", "start"]);

    const other = await createTournament(f, [1500, 1400, 1300, 1200]);
    const elsewhere = await f.call(
      "liveSnapshot",
      { tournamentId: other.view.tournament.id, matchId: opener.id },
      "fan",
    );
    expect(elsewhere.tournament.id).toBe(other.view.tournament.id);
    expect(elsewhere.timeline).toBeUndefined();
  }, 60_000);

  it("loads the 16-player double-elimination demo mid-tournament and plays it through to a champion", async () => {
    const f = await fixture();
    const { tournamentId } = await f.call("seedDemo");
    const demo = await f.snapshot(tournamentId);
    expect(demo.tournament).toMatchObject({
      bracketSize: 16,
      format: "double",
      bestOf: 3,
      status: "live",
      championId: null,
    });
    expect(demo.standings).toHaveLength(16);
    expect(demo.matches).toHaveLength(31);
    expect(demo.matches.map((m: Json) => m.number)).toEqual(
      Array.from({ length: 31 }, (_, index) => index + 1),
    );
    const done = demo.matches.filter((m: Json) => m.status === "done");
    expect(done).toHaveLength(18);
    for (const match of done) {
      expect(Math.max(match.gamesA, match.gamesB)).toBe(2);
      expect(match.gameScores.split(" ")).toHaveLength(match.gamesA + match.gamesB);
    }
    const live = demo.matches.filter((m: Json) => m.status === "live");
    expect(
      live.map((m: Json) => [m.bracket, m.round, m.gamesA, m.gamesB, m.scoreA, m.scoreB]),
    ).toEqual([
      ["losers", 2, 0, 0, 5, 6],
      ["winners", 3, 1, 0, 9, 7],
    ]);
    expect(
      demo.standings
        .filter((p: Json) => p.eliminatedRound !== null)
        .map((p: Json) => [p.eliminatedRound, p.place, p.tied]),
    ).toEqual([
      [2, 9, true],
      [2, 9, true],
      [1, 13, true],
      [1, 13, true],
      [1, 13, true],
      [1, 13, true],
    ]);
    expect(
      demo.standings.filter((p: Json) => p.eliminatedRound === null).map((p: Json) => p.losses),
    ).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
    expect(demo.courts.filter((court: Json) => court.matchId)).toHaveLength(2);
    for (const match of live) {
      expect(match.startedAt).toBeLessThan(demo.now - 60_000);
      const log = (await f.call("matchLog", { matchId: match.id })) as unknown as Json[];
      for (const event of log) expect(event.at).toBeLessThanOrEqual(demo.now);
    }
    const startSum = demo.standings.reduce((sum: number, p: Json) => sum + p.startRating, 0);
    expect(demo.standings.reduce((sum: number, p: Json) => sum + p.rating, 0)).toBe(startSum);

    const view = await playThrough(f, tournamentId, (match) =>
      match.scoreA >= match.scoreB ? "a" : "b",
    );
    expect(view.tournament.status).toBe("finished");
    const alive = view.standings.filter((p: Json) => p.eliminatedRound === null);
    expect(alive.map((p: Json) => p.id)).toEqual([view.tournament.championId]);
    expect(view.standings[0]).toMatchObject({ id: view.tournament.championId, place: 1 });
    expect(view.standings.map((p: Json) => p.place)).toEqual([
      1, 2, 3, 4, 5, 5, 7, 7, 9, 9, 9, 9, 13, 13, 13, 13,
    ]);
    expect(view.standings.map((p: Json) => p.tied)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    for (const player of view.standings)
      expect(player.losses).toBe(player.id === view.tournament.championId ? player.losses : 2);
    expect(view.courts.every((court: Json) => court.matchId === null)).toBe(true);
    expect(view.standings.reduce((sum: number, p: Json) => sum + p.rating, 0)).toBe(startSum);
  }, 180_000);

  it("builds double-elimination brackets with byes, drops losers, and resets the grand final", async () => {
    const f = await fixture();
    const small = await f.call("createTournament", {
      name: "Drop check",
      sport: "Esports",
      format: "double",
      pointsToWin: 1,
      winBy: 1,
      players: roster([1600, 1500, 1400, 1300]),
    });
    const opening = (await f.snapshot(small.tournamentId)).matches.find(
      (m: Json) => m.bracket === "winners" && m.round === 1 && m.slot === 1,
    );
    const { match } = await playTo(f, opening.id, freeCourt(await f.snapshot()).id, ["a"]);
    const result = await f.call("completeMatch", {
      matchId: opening.id,
      expectedVersion: match.version,
    });
    expect(result.droppedTo).toBe(opening.loserNextMatchId);
    const dropped = (await f.snapshot(small.tournamentId)).matches.find(
      (m: Json) => m.id === opening.loserNextMatchId,
    );
    expect(dropped).toMatchObject({ bracket: "losers", round: 1, playerA: opening.playerB });
    const undone = await f.call("reopenMatch", {
      matchId: opening.id,
      expectedVersion: result.match.version,
    });
    expect(undone.match.status).toBe("live");
    const cleared = (await f.snapshot(small.tournamentId)).matches.find(
      (m: Json) => m.id === opening.loserNextMatchId,
    );
    expect(cleared).toMatchObject({ status: "waiting", playerA: null });
    for (const count of [3, 5, 8, 13]) {
      const ratings = Array.from({ length: count }, (_, index) => 1800 - index * 25);
      const created = await f.call("createTournament", {
        name: `Double ${count}`,
        sport: "Esports",
        format: "double",
        pointsToWin: 1,
        winBy: 1,
        courts: 2,
        players: roster(ratings),
      });
      const size = created.bracketSize as number;
      expect(created.matches).toBe(2 * size - 1);
      let turn = 0;
      const view = await playThrough(f, created.tournamentId, (match) => {
        turn += 1;
        if (match.bracket === "final") return match.round === 1 ? "b" : "a";
        return turn % 3 === 0 ? "b" : "a";
      });
      expect(view.tournament.status, `${count} players`).toBe("finished");
      const champion = view.standings.find((p: Json) => p.id === view.tournament.championId);
      expect(champion.losses).toBe(1);
      expect(
        view.standings.filter((p: Json) => p.id !== champion.id).map((p: Json) => p.losses),
      ).toEqual(Array.from({ length: count - 1 }, () => 2));
      const reset = view.matches.find((m: Json) => m.bracket === "final" && m.round === 2);
      expect(reset).toMatchObject({ status: "done", winnerId: champion.id });
      const loserMatches = view.matches.filter((m: Json) => m.bracket === "losers");
      for (const match of loserMatches) expect(["done", "bye"]).toContain(match.status);
      const players = new Set(view.standings.map((p: Json) => p.id));
      for (const match of view.matches.filter((m: Json) => m.status === "done")) {
        expect(players.has(match.playerA)).toBe(true);
        expect(players.has(match.playerB)).toBe(true);
        expect(match.playerA).not.toBe(match.playerB);
      }
    }
  }, 180_000);

  it("plays best-of-three games, undoes across a game, and awards and reopens a walkover", async () => {
    const f = await fixture();
    const created = await f.call("createTournament", {
      name: "Best of three",
      sport: "Pickleball",
      bestOf: 3,
      pointsToWin: 3,
      winBy: 1,
      courts: 2,
      players: roster([1600, 1550, 1450, 1400]),
    });
    const view = await f.snapshot(created.tournamentId);
    const opener = matchAt(view, 1, 1);
    let { match } = await playTo(f, opener.id, view.courts[0].id, ["b", "a", "a", "a"]);
    expect(match).toMatchObject({ scoreA: 3, scoreB: 1, server: "a" });
    const firstGame = await f.call("completeMatch", {
      matchId: opener.id,
      expectedVersion: match.version,
    });
    expect(firstGame).toMatchObject({
      matchOver: false,
      gamesA: 1,
      gamesB: 0,
      match: { status: "live", scoreA: 0, scoreB: 0, gameScores: "3-1", server: "b" },
    });
    const undone = await f.call("undoPoint", {
      matchId: opener.id,
      expectedVersion: firstGame.match.version,
    });
    expect(undone).toMatchObject({ scoreA: 3, scoreB: 1, gamesA: 0, gameScores: "" });
    const point = await f.call("undoPoint", {
      matchId: opener.id,
      expectedVersion: undone.version,
    });
    expect(point).toMatchObject({ scoreA: 2, scoreB: 1, server: "a" });
    match = point;
    for (const side of ["b", "b"] as const)
      match = await f.call("scorePoint", {
        matchId: opener.id,
        side,
        expectedVersion: match.version,
      });
    expect(match).toMatchObject({ scoreA: 2, scoreB: 3, server: "b" });
    await expect(
      f.call("scorePoint", { matchId: opener.id, side: "b", expectedVersion: match.version }),
    ).rejects.toMatchObject({ refusal: { code: "match_decided" } });
    let game = await f.call("completeMatch", {
      matchId: opener.id,
      expectedVersion: match.version,
    });
    match = game.match;
    for (const side of ["a", "a", "a"] as const)
      match = await f.call("scorePoint", {
        matchId: opener.id,
        side,
        expectedVersion: match.version,
      });
    game = await f.call("completeMatch", { matchId: opener.id, expectedVersion: match.version });
    match = game.match;
    for (const side of ["a", "a", "b", "a"] as const)
      match = await f.call("scorePoint", {
        matchId: opener.id,
        side,
        expectedVersion: match.version,
      });
    const won = await f.call("completeMatch", {
      matchId: opener.id,
      expectedVersion: match.version,
    });
    expect(won).toMatchObject({
      matchOver: true,
      winnerId: opener.playerA,
      match: { status: "done", gamesA: 2, gamesB: 1, gameScores: "2-3 3-0 3-1", outcome: "played" },
    });
    const seriesLog = (await f.call("matchLog", { matchId: opener.id })) as unknown as Json[];
    expect(seriesLog.find((entry) => entry.kind === "complete")).toMatchObject({
      side: "a",
      game: 3,
    });
    const standings = new Map<string, Json>(
      (await f.snapshot(created.tournamentId)).standings.map((p: Json) => [p.id, p]),
    );
    expect(standings.get(opener.playerA)).toMatchObject({ pointsFor: 8, pointsAgainst: 4 });

    const second = matchAt(view, 1, 2);
    await expect(
      f.call(
        "awardWalkover",
        { matchId: second.id, winner: "b", expectedVersion: second.version },
        "fan",
      ),
    ).rejects.toThrow();
    const walkover = await f.call("awardWalkover", {
      matchId: second.id,
      winner: "b",
      expectedVersion: second.version,
    });
    expect(walkover).toMatchObject({
      winnerId: second.playerB,
      ratingChange: 0,
      advancedTo: opener.nextMatchId,
      match: { status: "done", outcome: "walkover", courtId: null },
    });
    const final = (await f.snapshot(created.tournamentId)).matches.find(
      (m: Json) => m.id === opener.nextMatchId,
    );
    expect(final).toMatchObject({ status: "ready", playerB: second.playerB });
    await expect(
      f.call("awardWalkover", {
        matchId: second.id,
        winner: "a",
        expectedVersion: walkover.match.version,
      }),
    ).rejects.toMatchObject({ refusal: { code: "match_not_open" } });
    const reopened = await f.call("reopenMatch", {
      matchId: second.id,
      expectedVersion: walkover.match.version,
    });
    expect(reopened.match).toMatchObject({ status: "ready", courtId: null, outcome: null });
    const walkoverLog = (await f.call("matchLog", { matchId: second.id })) as unknown as Json[];
    expect(walkoverLog.find((entry) => entry.kind === "reopen")).toMatchObject({ side: null });
    const after = await f.snapshot(created.tournamentId);
    expect(after.matches.find((m: Json) => m.id === opener.nextMatchId)).toMatchObject({
      status: "waiting",
      playerB: null,
    });
    const loser = after.standings.find((p: Json) => p.id === second.playerA);
    expect(loser).toMatchObject({ losses: 0, eliminatedRound: null, rating: loser.startRating });
  }, 60_000);

  it("records a handed-in score sheet in one step, checks every game, and puts it back in the queue on reopen", async () => {
    const f = await fixture();
    const created = await f.call("createTournament", {
      name: "Sheet Open",
      sport: "Pickleball",
      bestOf: 3,
      pointsToWin: 11,
      winBy: 2,
      players: roster([1600, 1550, 1450, 1400]),
    });
    const view = await f.snapshot(created.tournamentId);
    const opener = matchAt(view, 1, 1);
    const report = (games: AppBackendJson, context: Context = "owner", version = opener.version) =>
      f.call("reportResult", { matchId: opener.id, games, expectedVersion: version }, context);
    await expect(
      report(
        [
          [11, 4],
          [11, 6],
        ],
        "fan",
      ),
    ).rejects.toThrow();
    for (const [games, message] of [
      [[[11, 4]], "Enter 2 to 3 game scores."],
      [
        [
          [11, 10],
          [11, 4],
        ],
        "Game 1 at 11–10 is not a finished game.",
      ],
      [
        [
          [13, 9],
          [11, 4],
        ],
        "Game 1 at 13–9 is not a finished game.",
      ],
      [
        [
          [11, 4],
          [11, 6],
          [4, 11],
        ],
        "The match was over after game 2.",
      ],
      [
        [
          [11, 4],
          [6, 11],
        ],
        "Nobody has won 2 games yet.",
      ],
    ] as const)
      await expect(report(games as unknown as AppBackendJson)).rejects.toMatchObject({
        refusal: { code: "invalid_input", message: expect.stringContaining(message) },
      });
    const done = await report([
      [12, 10],
      [4, 11],
      [11, 7],
    ]);
    expect(done).toMatchObject({
      matchOver: true,
      winnerId: opener.playerA,
      advancedTo: opener.nextMatchId,
      match: {
        status: "done",
        gamesA: 2,
        gamesB: 1,
        gameScores: "12-10 4-11 11-7",
        outcome: "reported",
        startedAt: null,
      },
    });
    expect(done.ratingChange).toBeGreaterThan(0);
    const log = (await f.call("matchLog", { matchId: opener.id })) as unknown as Json[];
    expect(log.map((entry) => entry.kind)).toEqual(["report"]);
    expect(log[0]).toMatchObject({ actor: "owner", game: 3 });
    const after = await f.snapshot(created.tournamentId);
    expect(after.standings.find((p: Json) => p.id === opener.playerA)).toMatchObject({
      wins: 1,
      pointsFor: 27,
      pointsAgainst: 28,
    });
    await expect(
      report(
        [
          [11, 4],
          [11, 6],
        ],
        "owner",
        done.match.version,
      ),
    ).rejects.toMatchObject({
      refusal: { code: "match_not_open" },
    });
    await expect(
      report(
        [
          [11, 4],
          [11, 6],
        ],
        "owner",
        opener.version,
      ),
    ).rejects.toMatchObject({
      refusal: { code: "conflict", message: expect.stringContaining("first. It is finished.") },
    });
    const reopened = await f.call("reopenMatch", {
      matchId: opener.id,
      expectedVersion: done.match.version,
    });
    expect(reopened.match).toMatchObject({
      status: "ready",
      gamesA: 0,
      gamesB: 0,
      scoreA: 0,
      scoreB: 0,
      gameScores: "",
      courtId: null,
      startedAt: null,
      outcome: null,
    });
    const reopenLog = (await f.call("matchLog", { matchId: opener.id })) as unknown as Json[];
    expect(reopenLog.find((entry) => entry.kind === "reopen")).toMatchObject({
      kind: "reopen",
      side: "a",
      game: 3,
      scoreA: 11,
      scoreB: 7,
    });
    const reopenedView = await f.snapshot(created.tournamentId);
    expect(reopenedView.standings.find((p: Json) => p.id === opener.playerA)).toMatchObject({
      wins: 0,
      pointsFor: 0,
      pointsAgainst: 0,
    });
    const corrected = await report(
      [
        [4, 11],
        [11, 9],
        [9, 11],
      ],
      "owner",
      reopened.match.version,
    );
    expect(corrected).toMatchObject({
      winnerId: opener.playerB,
      match: {
        status: "done",
        gamesA: 1,
        gamesB: 2,
        gameScores: "4-11 11-9 9-11",
        outcome: "reported",
      },
    });

    const second = matchAt(view, 1, 2);
    const started = await f.call("startMatch", {
      matchId: second.id,
      courtId: freeCourt(await f.snapshot(created.tournamentId)).id,
      expectedVersion: second.version,
    });
    const scored = await f.call("scorePoint", {
      matchId: second.id,
      side: "a",
      expectedVersion: started.version,
    });
    await expect(
      f.call("reportResult", {
        matchId: second.id,
        games: [
          [11, 4],
          [11, 6],
        ],
        expectedVersion: scored.version,
      }),
    ).rejects.toMatchObject({ refusal: { code: "match_scored" } });
    const unscored = (await f.call("undoPoint", {
      matchId: second.id,
      expectedVersion: scored.version,
    })) as unknown as Json;
    const sheet = await f.call("reportResult", {
      matchId: second.id,
      games: [
        [11, 4],
        [11, 6],
      ],
      expectedVersion: unscored.version,
    });
    expect(sheet.match).toMatchObject({
      status: "done",
      courtId: null,
      startedAt: null,
      outcome: "reported",
    });
    const freed = await f.snapshot(created.tournamentId);
    expect(freed.courts.some((court: Json) => court.matchId === second.id)).toBe(false);
    const sheetLog = (await f.call("matchLog", { matchId: second.id })) as unknown as Json[];
    expect(sheetLog.slice(0, 2).map((entry) => entry.kind)).toEqual(["report", "cancel"]);

    const short = await f.call("createTournament", {
      name: "Win By One",
      sport: "Pickleball",
      bestOf: 1,
      pointsToWin: 11,
      winBy: 1,
      players: roster([1600, 1500, 1400, 1300]),
    });
    const single = matchAt(await f.snapshot(short.tournamentId), 1, 1);
    await expect(
      f.call("reportResult", {
        matchId: single.id,
        games: [[12, 11]],
        expectedVersion: single.version,
      }),
    ).rejects.toMatchObject({
      refusal: { code: "invalid_input", message: expect.stringContaining("12–11") },
    });
    await expect(
      f.call("reportResult", {
        matchId: single.id,
        games: [[11, 10]],
        expectedVersion: single.version,
      }),
    ).resolves.toMatchObject({ match: { outcome: "reported", gameScores: "11-10" } });
  }, 60_000);

  it("hides private tournaments from share links and lets only the organizer change that", async () => {
    const f = await fixture();
    const shared = await createTournament(f, [1600, 1550, 1450, 1400]);
    const hidden = await f.call("createTournament", {
      name: "Staff scrimmage",
      sport: "Tabletop",
      visibility: "private",
      players: roster([1500, 1400, 1300]),
    });
    const fan = await f.snapshot(undefined, "fan");
    expect(fan.tournaments.map((t: Json) => t.id)).toEqual([shared.view.tournament.id]);
    const pinned = await f.snapshot(hidden.tournamentId, "fan");
    expect(pinned.tournament.id).toBe(shared.view.tournament.id);
    expect(JSON.stringify(pinned)).not.toContain("Staff scrimmage");
    const owner = await f.snapshot(hidden.tournamentId);
    expect(owner.tournament).toMatchObject({ id: hidden.tournamentId, visibility: "private" });
    for (const context of ["fan", "scorer"] as const)
      await expect(
        f.call(
          "setVisibility",
          { tournamentId: hidden.tournamentId, visibility: "shared" },
          context,
        ),
      ).rejects.toThrow();
    await f.call("setVisibility", { tournamentId: hidden.tournamentId, visibility: "shared" });
    expect((await f.snapshot(hidden.tournamentId, "fan")).tournament.id).toBe(hidden.tournamentId);
    await f.call("setVisibility", {
      tournamentId: shared.view.tournament.id,
      visibility: "private",
    });
    const onlyHidden = await f.snapshot(undefined, "fan");
    expect(onlyHidden.tournaments.map((t: Json) => t.id)).toEqual([hidden.tournamentId]);
  }, 60_000);
});
