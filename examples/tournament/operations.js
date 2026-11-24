const SPORTS = ["Pickleball", "Esports", "Tabletop"];
const BRACKET_SIZES = [4, 8, 16, 32];
const MAX_PARAMS_PER_STATEMENT = 128;
const TABLE_COLUMNS = {
  tournaments: [
    "id",
    "name",
    "sport",
    "status",
    "bracket_size",
    "points_to_win",
    "win_by",
    "k_factor",
    "champion_id",
    "created_at",
    "updated_at",
  ],
  players: [
    "id",
    "tournament_id",
    "name",
    "club",
    "seed",
    "rating",
    "start_rating",
    "wins",
    "losses",
    "points_for",
    "points_against",
    "eliminated_round",
  ],
  courts: ["id", "tournament_id", "name", "position"],
  matches: [
    "id",
    "tournament_id",
    "round",
    "slot",
    "player_a_id",
    "player_b_id",
    "next_match_id",
    "next_slot",
    "court_id",
    "status",
    "score_a",
    "score_b",
    "winner_id",
    "started_at",
    "finished_at",
    "version",
  ],
  match_events: [
    "id",
    "tournament_id",
    "match_id",
    "seq",
    "kind",
    "side",
    "score_a",
    "score_b",
    "court_id",
    "actor",
    "at",
  ],
};
const MATCH_COLUMNS =
  "id, round, slot, player_a_id AS playerA, player_b_id AS playerB, next_match_id AS nextMatchId, next_slot AS nextSlot, court_id AS courtId, status, score_a AS scoreA, score_b AS scoreB, winner_id AS winnerId, started_at AS startedAt, finished_at AS finishedAt, version";

function requireOrganizer(ctx) {
  if (ctx.caller.kind !== "owner") ctx.refuse("forbidden", "Only the organizer can do this.");
}

function requireScorekeeper(ctx) {
  if (ctx.caller.kind !== "owner" && !(ctx.caller.kind === "named" && ctx.caller.helper))
    ctx.refuse("forbidden", "Scorekeeper access is required.");
}

function actorOf(ctx) {
  if (ctx.caller.kind === "named") return `named:${ctx.caller.userId}`;
  if (ctx.caller.kind === "automation") return `automation:${ctx.caller.automationId}`;
  return ctx.caller.kind;
}

function cleanText(ctx, value, field, maxLength, optional) {
  const result = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!result && optional) return null;
  if (!result || result.length > maxLength)
    ctx.refuse("invalid_input", `Enter ${field} (up to ${maxLength} characters).`);
  return result;
}

function wholeNumber(ctx, value, fallback, min, max, field) {
  const result = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max)
    ctx.refuse("invalid_input", `${field} must be a whole number from ${min} to ${max}.`);
  return result;
}

function idText(ctx, value, field) {
  if (typeof value !== "string" || !value || value.length > 200)
    ctx.refuse("invalid_input", `Choose a ${field}.`);
  return value;
}

function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const next = order.length * 2;
    order = order.flatMap((seed) => [seed, next + 1 - seed]);
  }
  return order;
}

function eloDelta(winnerRating, loserRating, kFactor) {
  const expected = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
  return Math.round(kFactor * (1 - expected));
}

function isDecided(tournament, scoreA, scoreB) {
  return (
    Math.max(scoreA, scoreB) >= tournament.points_to_win &&
    Math.abs(scoreA - scoreB) >= tournament.win_by
  );
}

function matchLabel(state, match) {
  const remaining = Math.log2(state.tournament.bracket_size) - match.round;
  if (remaining === 0) return "The final";
  if (remaining === 1) return `Semifinal ${match.slot}`;
  if (remaining === 2) return `Quarterfinal ${match.slot}`;
  return `Round of ${2 ** (remaining + 1)} match ${match.slot}`;
}

function newState(tournament) {
  return {
    tournament,
    players: new Map(),
    courts: new Map(),
    matches: new Map(),
    seq: new Map(),
    events: [],
    changedPlayers: new Set(),
    changedMatches: new Set(),
    tournamentChanged: false,
  };
}

function touchMatch(state, match) {
  match.version += 1;
  state.changedMatches.add(match.id);
}

function touchTournament(state, at) {
  state.tournament.updated_at = at;
  state.tournamentChanged = true;
}

function addEvent(state, match, kind, side, at, actor) {
  const seq = (state.seq.get(match.id) ?? 0) + 1;
  state.seq.set(match.id, seq);
  state.events.push({
    id: `${match.id}-e${seq}`,
    tournament_id: match.tournament_id,
    match_id: match.id,
    seq,
    kind,
    side,
    score_a: match.score_a,
    score_b: match.score_b,
    court_id: match.court_id,
    actor,
    at,
  });
}

function advance(state, match, winnerId) {
  const next = match.next_match_id ? state.matches.get(match.next_match_id) : null;
  if (!next || next.status !== "waiting") return null;
  const column = match.next_slot === "a" ? "player_a_id" : "player_b_id";
  next[column] = winnerId;
  touchMatch(state, next);
  if (next.player_a_id && next.player_b_id) {
    next.status = "ready";
    touchMatch(state, next);
  }
  return next.id;
}

function buildBracket(ctx, plan) {
  const count = plan.players.length;
  const size = BRACKET_SIZES.find((candidate) => candidate >= count);
  if (count < 3 || !size) ctx.refuse("invalid_input", "A bracket needs 3 to 32 players.");
  const id = plan.id;
  const state = newState({
    id,
    name: plan.name,
    sport: plan.sport,
    status: "live",
    bracket_size: size,
    points_to_win: plan.pointsToWin,
    win_by: plan.winBy,
    k_factor: plan.kFactor,
    champion_id: null,
    created_at: plan.now,
    updated_at: plan.now,
  });
  const seeded = plan.players
    .map((player, index) => ({ ...player, index }))
    .sort(
      (left, right) =>
        right.rating - left.rating ||
        left.name.localeCompare(right.name) ||
        left.index - right.index,
    );
  seeded.forEach((player, index) => {
    const playerId = `${id}-p${index + 1}`;
    state.players.set(playerId, {
      id: playerId,
      tournament_id: id,
      name: player.name,
      club: player.club,
      seed: index + 1,
      rating: player.rating,
      start_rating: player.rating,
      wins: 0,
      losses: 0,
      points_for: 0,
      points_against: 0,
      eliminated_round: null,
    });
  });
  plan.courts.forEach((name, index) => {
    const courtId = `${id}-c${index + 1}`;
    state.courts.set(courtId, { id: courtId, tournament_id: id, name, position: index + 1 });
  });
  const rounds = Math.log2(size);
  const matchId = (round, slot) => `${id}-r${round}-m${slot}`;
  for (let round = rounds; round >= 1; round -= 1) {
    for (let slot = 1; slot <= size / Math.pow(2, round); slot += 1) {
      state.matches.set(matchId(round, slot), {
        id: matchId(round, slot),
        tournament_id: id,
        round,
        slot,
        player_a_id: null,
        player_b_id: null,
        next_match_id: round < rounds ? matchId(round + 1, Math.ceil(slot / 2)) : null,
        next_slot: round < rounds ? (slot % 2 === 1 ? "a" : "b") : null,
        court_id: null,
        status: "waiting",
        score_a: 0,
        score_b: 0,
        winner_id: null,
        started_at: null,
        finished_at: null,
        version: 1,
      });
    }
  }
  const order = seedOrder(size);
  const seedId = (seed) => (seed <= count ? `${id}-p${seed}` : null);
  for (let slot = 1; slot <= size / 2; slot += 1) {
    const match = state.matches.get(matchId(1, slot));
    match.player_a_id = seedId(order[2 * slot - 2]);
    match.player_b_id = seedId(order[2 * slot - 1]);
    if (match.player_a_id && match.player_b_id) {
      match.status = "ready";
      continue;
    }
    match.status = "bye";
    match.winner_id = match.player_a_id ?? match.player_b_id;
    match.finished_at = plan.now;
    addEvent(state, match, "bye", match.player_a_id ? "a" : "b", plan.now, plan.actor);
    advance(state, match, match.winner_id);
  }
  return state;
}

function startMatchIn(ctx, state, match, court, at, actor) {
  if (match.status !== "ready")
    ctx.refuse(
      "match_not_ready",
      match.status === "waiting"
        ? `${matchLabel(state, match)} is still waiting for its players.`
        : `${matchLabel(state, match)} has already started.`,
    );
  if (!court || court.tournament_id !== match.tournament_id)
    ctx.refuse("not_found", "That court is not part of this tournament.");
  for (const other of state.matches.values())
    if (other.court_id === court.id && other.status === "live")
      ctx.refuse(
        "court_busy",
        `${court.name} is already playing ${matchLabel(state, other)}. Complete that match first.`,
      );
  match.status = "live";
  match.court_id = court.id;
  match.started_at = at;
  touchMatch(state, match);
  touchTournament(state, at);
  addEvent(state, match, "start", null, at, actor);
}

function scorePointIn(ctx, state, match, side, at, actor) {
  if (isDecided(state.tournament, match.score_a, match.score_b))
    ctx.refuse(
      "match_decided",
      `The game is over at ${match.score_a}–${match.score_b}. Complete the match or undo a point.`,
    );
  if (side === "a") match.score_a += 1;
  else match.score_b += 1;
  touchMatch(state, match);
  touchTournament(state, at);
  addEvent(state, match, "point", side, at, actor);
}

function finishMatchIn(ctx, state, match, at, actor) {
  const tournament = state.tournament;
  if (!isDecided(tournament, match.score_a, match.score_b))
    ctx.refuse(
      "not_decided",
      `A game needs ${tournament.points_to_win} points and a ${tournament.win_by}-point lead. The score is ${match.score_a}–${match.score_b}.`,
    );
  const aWon = match.score_a > match.score_b;
  const winner = state.players.get(aWon ? match.player_a_id : match.player_b_id);
  const loser = state.players.get(aWon ? match.player_b_id : match.player_a_id);
  const winnerScore = aWon ? match.score_a : match.score_b;
  const loserScore = aWon ? match.score_b : match.score_a;
  const delta = eloDelta(winner.rating, loser.rating, tournament.k_factor);
  winner.rating += delta;
  winner.wins += 1;
  winner.points_for += winnerScore;
  winner.points_against += loserScore;
  loser.rating -= delta;
  loser.losses += 1;
  loser.points_for += loserScore;
  loser.points_against += winnerScore;
  loser.eliminated_round = match.round;
  state.changedPlayers.add(winner.id);
  state.changedPlayers.add(loser.id);
  match.status = "done";
  match.winner_id = winner.id;
  match.finished_at = at;
  touchMatch(state, match);
  addEvent(state, match, "complete", aWon ? "a" : "b", at, actor);
  const advancedTo = advance(state, match, winner.id);
  if (!match.next_match_id) {
    tournament.status = "finished";
    tournament.champion_id = winner.id;
  }
  touchTournament(state, at);
  return {
    winnerId: winner.id,
    loserId: loser.id,
    ratingChange: delta,
    advancedTo,
    championId: tournament.champion_id,
    freedCourtId: match.court_id,
  };
}

function insertRows(ctx, table, rows) {
  const columns = TABLE_COLUMNS[table];
  const perStatement = Math.floor(MAX_PARAMS_PER_STATEMENT / columns.length);
  for (let start = 0; start < rows.length; start += perStatement) {
    const chunk = rows.slice(start, start + perStatement);
    const placeholders = chunk.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
    ctx.db.execute(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders}`,
      chunk.flatMap((row) => columns.map((column) => row[column] ?? null)),
    );
  }
}

function insertState(ctx, state) {
  if (ctx.db.query("SELECT 1 FROM tournaments WHERE id = ?", [state.tournament.id]).length)
    ctx.refuse("conflict", "That tournament already exists.");
  insertRows(ctx, "tournaments", [state.tournament]);
  insertRows(ctx, "players", [...state.players.values()]);
  insertRows(ctx, "courts", [...state.courts.values()]);
  insertRows(
    ctx,
    "matches",
    [...state.matches.values()].sort((left, right) => right.round - left.round),
  );
  insertRows(ctx, "match_events", state.events);
}

function updateRow(ctx, table, row) {
  const columns = TABLE_COLUMNS[table].filter((column) => column !== "id");
  ctx.db.execute(
    `UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`,
    [...columns.map((column) => row[column] ?? null), row.id],
  );
}

function saveChanges(ctx, state) {
  for (const id of state.changedMatches) updateRow(ctx, "matches", state.matches.get(id));
  for (const id of state.changedPlayers) updateRow(ctx, "players", state.players.get(id));
  if (state.tournamentChanged) updateRow(ctx, "tournaments", state.tournament);
  insertRows(ctx, "match_events", state.events);
}

function loadState(ctx, matchId) {
  const found = ctx.db.query("SELECT tournament_id FROM matches WHERE id = ?", [
    idText(ctx, matchId, "match"),
  ])[0];
  if (!found) ctx.refuse("not_found", "That match no longer exists.");
  const id = found.tournament_id;
  const state = newState(ctx.db.query("SELECT * FROM tournaments WHERE id = ?", [id])[0]);
  for (const row of ctx.db.query("SELECT * FROM players WHERE tournament_id = ?", [id]))
    state.players.set(row.id, row);
  for (const row of ctx.db.query("SELECT * FROM courts WHERE tournament_id = ?", [id]))
    state.courts.set(row.id, row);
  for (const row of ctx.db.query("SELECT * FROM matches WHERE tournament_id = ?", [id]))
    state.matches.set(row.id, row);
  for (const row of ctx.db.query(
    "SELECT match_id, MAX(seq) AS seq FROM match_events WHERE tournament_id = ? GROUP BY match_id",
    [id],
  ))
    state.seq.set(row.match_id, Number(row.seq));
  return { state, match: state.matches.get(matchId) };
}

function checkVersion(ctx, state, match, expectedVersion) {
  if (!Number.isInteger(expectedVersion))
    ctx.refuse("invalid_input", "Send the match version you are looking at.");
  if (match.version !== expectedVersion)
    ctx.refuse(
      "conflict",
      `Someone else updated ${matchLabel(state, match)} first. The score is now ${match.score_a}–${match.score_b}; check it and try again.`,
    );
}

function requireLive(ctx, state, match) {
  if (match.status !== "live")
    ctx.refuse("match_not_live", `${matchLabel(state, match)} is not being played right now.`);
}

function liveMatchAction(ctx, input, run) {
  requireScorekeeper(ctx);
  const { state, match } = loadState(ctx, input?.matchId);
  checkVersion(ctx, state, match, input?.expectedVersion);
  const extra = run(state, match);
  saveChanges(ctx, state);
  const saved = ctx.db.query(`SELECT ${MATCH_COLUMNS} FROM matches WHERE id = ?`, [match.id])[0];
  return extra ? { ...extra, match: saved } : saved;
}

function parsePlayers(ctx, value) {
  if (!Array.isArray(value) || value.length < 3 || value.length > 32)
    ctx.refuse("invalid_input", "Add 3 to 32 players.");
  const seen = new Set();
  return value.map((entry, index) => {
    const name = cleanText(ctx, entry?.name, `player ${index + 1}'s name`, 60, false);
    const key = name.toLowerCase();
    if (seen.has(key)) ctx.refuse("invalid_input", `${name} is listed twice.`);
    seen.add(key);
    return {
      name,
      club: cleanText(ctx, entry?.club, `player ${index + 1}'s club`, 60, true),
      rating: wholeNumber(ctx, entry?.rating, 1500, 100, 3500, `${name}'s rating`),
    };
  });
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_PLAYERS = [
  ["Maya Okafor", "Harbor PC", 1724],
  ["Diego Alvarez", "Northside Dinkers", 1688],
  ["Priya Raman", "Harbor PC", 1662],
  ["Tomás Becker", "Riverside Smash", 1641],
  ["Hana Sato", "Eastgate Rally", 1618],
  ["Lucas Moreau", "Northside Dinkers", 1597],
  ["Amara Nwosu", "Kitchen Line Club", 1580],
  ["Jonah Fields", "Riverside Smash", 1561],
  ["Sofia Lindqvist", "Eastgate Rally", 1543],
  ["Ravi Menon", "Kitchen Line Club", 1526],
  ["Elena Petrova", "Harbor PC", 1508],
  ["Kwame Mensah", "Northside Dinkers", 1489],
  ["Isla Mackenzie", "Riverside Smash", 1471],
  ["Noah Kim", "Eastgate Rally", 1452],
  ["Camila Reyes", "Kitchen Line Club", 1430],
  ["Ben Carter", "Harbor PC", 1408],
];

function buildDemo(ctx) {
  const now = ctx.nowMs;
  const actor = actorOf(ctx);
  const state = buildBracket(ctx, {
    id: `demo-${ctx.requestId}`,
    name: "Harbor City Winter Open",
    sport: "Pickleball",
    pointsToWin: 11,
    winBy: 2,
    kFactor: 32,
    now: now - 3 * 60 * 60 * 1000,
    actor,
    players: DEMO_PLAYERS.map(([name, club, rating]) => ({ name, club, rating })),
    courts: ["Center Court", "Court 2", "Court 3", "Court 4"],
  });
  const courts = [...state.courts.values()];
  const random = mulberry32(20261124);
  let time = now - 150 * 60 * 1000;
  const tick = (ms) => (time += ms);
  const play = (round, slot, court, stopAt) => {
    const match = state.matches.get(`${state.tournament.id}-r${round}-m${slot}`);
    startMatchIn(ctx, state, match, court, tick(90_000), actor);
    const a = state.players.get(match.player_a_id).rating;
    const b = state.players.get(match.player_b_id).rating;
    const rallyChanceA = 0.5 + (1 / (1 + Math.pow(10, (b - a) / 400)) - 0.5) * 0.45;
    const remaining = stopAt ? [...stopAt] : null;
    while (!isDecided(state.tournament, match.score_a, match.score_b)) {
      if (remaining && remaining[0] + remaining[1] === 0) return;
      const chance = remaining ? remaining[0] / (remaining[0] + remaining[1]) : rallyChanceA;
      const side = random() < chance ? "a" : "b";
      if (remaining) remaining[side === "a" ? 0 : 1] -= 1;
      scorePointIn(ctx, state, match, side, tick(18_000 + Math.floor(random() * 20_000)), actor);
    }
    finishMatchIn(ctx, state, match, tick(30_000), actor);
  };
  for (let slot = 1; slot <= 8; slot += 1) play(1, slot, courts[(slot - 1) % 4], null);
  play(2, 1, courts[0], null);
  play(2, 2, courts[1], null);
  time = now - 13 * 60 * 1000;
  play(2, 3, courts[0], [9, 7]);
  time = now - 9 * 60 * 1000;
  play(2, 4, courts[1], [5, 6]);
  state.tournament.updated_at = now;
  return state;
}

globalThis.operations = {
  liveSnapshot(ctx, input) {
    const tournaments = ctx.db.query(
      "SELECT id, name, sport, status, created_at AS createdAt FROM tournaments ORDER BY created_at DESC, id DESC LIMIT 20",
    );
    const requested = typeof input?.tournamentId === "string" ? input.tournamentId : null;
    const explicit = requested
      ? ctx.db.query(
          "SELECT id, name, sport, status, created_at AS createdAt FROM tournaments WHERE id = ?",
          [requested],
        )[0]
      : null;
    const chosen = explicit ?? tournaments.find((row) => row.status === "live") ?? tournaments[0];
    if (!chosen) return { tournaments: [], tournament: null, now: ctx.nowMs };
    const listed = tournaments.some((row) => row.id === chosen.id)
      ? tournaments
      : [chosen, ...tournaments];
    const tournament = ctx.db.query(
      "SELECT id, name, sport, status, bracket_size AS bracketSize, points_to_win AS pointsToWin, win_by AS winBy, k_factor AS kFactor, champion_id AS championId, created_at AS createdAt, updated_at AS updatedAt FROM tournaments WHERE id = ?",
      [chosen.id],
    )[0];
    const standings = ctx.db.query(
      `SELECT id, name, club, seed, rating, start_rating AS startRating, rating - start_rating AS ratingChange,
        wins, losses, points_for AS pointsFor, points_against AS pointsAgainst,
        points_for - points_against AS pointDiff, eliminated_round AS eliminatedRound,
        RANK() OVER (ORDER BY (eliminated_round IS NULL) DESC, eliminated_round DESC, wins DESC,
          points_for - points_against DESC, rating DESC) AS place
       FROM players WHERE tournament_id = ?
       ORDER BY place, seed`,
      [chosen.id],
    );
    const matches = ctx.db.query(
      `SELECT ${MATCH_COLUMNS} FROM matches WHERE tournament_id = ? ORDER BY round, slot`,
      [chosen.id],
    );
    const courts = ctx.db.query(
      `SELECT c.id, c.name, c.position, m.id AS matchId
       FROM courts c LEFT JOIN matches m ON m.court_id = c.id AND m.status = 'live'
       WHERE c.tournament_id = ? ORDER BY c.position`,
      [chosen.id],
    );
    const recent = ctx.db.query(
      `SELECT id, match_id AS matchId, seq, kind, side, score_a AS scoreA, score_b AS scoreB,
        court_id AS courtId, at
       FROM match_events WHERE tournament_id = ? AND kind IN ('point', 'undo', 'complete', 'start')
       ORDER BY at DESC, seq DESC LIMIT 14`,
      [chosen.id],
    );
    const rallies = ctx.db.query(
      "SELECT COUNT(*) AS n FROM match_events WHERE tournament_id = ? AND kind = 'point'",
      [chosen.id],
    )[0].n;
    return {
      tournaments: listed,
      tournament,
      standings,
      matches,
      courts,
      recent,
      rallies: Number(rallies),
      now: ctx.nowMs,
    };
  },

  matchLog(ctx, input) {
    requireScorekeeper(ctx);
    return ctx.db.query(
      "SELECT seq, kind, side, score_a AS scoreA, score_b AS scoreB, court_id AS courtId, actor, at FROM match_events WHERE match_id = ? ORDER BY seq DESC LIMIT 200",
      [idText(ctx, input?.matchId, "match")],
    );
  },

  createTournament(ctx, input) {
    requireOrganizer(ctx);
    const sport = SPORTS.includes(input?.sport) ? input.sport : null;
    if (!sport) ctx.refuse("invalid_input", "Choose Pickleball, Esports, or Tabletop.");
    const courtCount = wholeNumber(ctx, input?.courts, 4, 1, 16, "Courts");
    const state = buildBracket(ctx, {
      id: `t-${ctx.requestId}`,
      name: cleanText(ctx, input?.name, "a tournament name", 80, false),
      sport,
      pointsToWin: wholeNumber(ctx, input?.pointsToWin, 11, 1, 99, "Points to win"),
      winBy: wholeNumber(ctx, input?.winBy, 2, 1, 5, "Win by"),
      kFactor: wholeNumber(ctx, input?.kFactor, 32, 1, 64, "Rating K-factor"),
      now: ctx.nowMs,
      actor: actorOf(ctx),
      players: parsePlayers(ctx, input?.players),
      courts: Array.from({ length: courtCount }, (_, index) =>
        index === 0 ? "Center Court" : `Court ${index + 1}`,
      ),
    });
    insertState(ctx, state);
    return {
      tournamentId: state.tournament.id,
      bracketSize: state.tournament.bracket_size,
      byes: state.tournament.bracket_size - state.players.size,
    };
  },

  seedDemo(ctx) {
    requireOrganizer(ctx);
    const state = buildDemo(ctx);
    insertState(ctx, state);
    return { tournamentId: state.tournament.id };
  },

  startMatch(ctx, input) {
    return liveMatchAction(ctx, input, (state, match) => {
      const court = state.courts.get(idText(ctx, input?.courtId, "court"));
      startMatchIn(ctx, state, match, court, ctx.nowMs, actorOf(ctx));
    });
  },

  scorePoint(ctx, input) {
    const side = input?.side;
    if (side !== "a" && side !== "b") ctx.refuse("invalid_input", "Choose which side scored.");
    return liveMatchAction(ctx, input, (state, match) => {
      requireLive(ctx, state, match);
      scorePointIn(ctx, state, match, side, ctx.nowMs, actorOf(ctx));
    });
  },

  undoPoint(ctx, input) {
    return liveMatchAction(ctx, input, (state, match) => {
      requireLive(ctx, state, match);
      const total = match.score_a + match.score_b;
      const last =
        total > 0
          ? ctx.db.query(
              "SELECT side FROM match_events WHERE match_id = ? AND kind = 'point' AND score_a + score_b = ? ORDER BY seq DESC LIMIT 1",
              [match.id, total],
            )[0]
          : null;
      if (!last) ctx.refuse("nothing_to_undo", "There is no point to undo in this match.");
      if (last.side === "a") match.score_a -= 1;
      else match.score_b -= 1;
      touchMatch(state, match);
      touchTournament(state, ctx.nowMs);
      addEvent(state, match, "undo", last.side, ctx.nowMs, actorOf(ctx));
    });
  },

  completeMatch(ctx, input) {
    return liveMatchAction(ctx, input, (state, match) => {
      requireLive(ctx, state, match);
      return finishMatchIn(ctx, state, match, ctx.nowMs, actorOf(ctx));
    });
  },
};
