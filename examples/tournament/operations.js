const SPORTS = ["Pickleball", "Esports", "Tabletop"];
const BRACKET_SIZES = [4, 8, 16, 32];
const FORMATS = ["single", "double"];
const BEST_OF = [1, 3, 5];
const SEEDING = ["rating", "order"];
const VISIBILITY = ["shared", "private"];
const MAX_PARAMS_PER_STATEMENT = 128;
const TABLE_COLUMNS = {
  tournaments: [
    "id",
    "name",
    "sport",
    "format",
    "best_of",
    "visibility",
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
    "number",
    "bracket",
    "round",
    "slot",
    "player_a_id",
    "player_b_id",
    "next_match_id",
    "next_slot",
    "loser_next_match_id",
    "loser_next_slot",
    "court_id",
    "status",
    "score_a",
    "score_b",
    "games_a",
    "games_b",
    "game_scores",
    "server",
    "outcome",
    "winner_id",
    "started_at",
    "finished_at",
    "rating_change",
    "version",
  ],
  match_events: [
    "id",
    "tournament_id",
    "match_id",
    "seq",
    "game",
    "kind",
    "side",
    "player_a",
    "player_b",
    "score_a",
    "score_b",
    "court_id",
    "actor",
    "at",
  ],
};
const MATCH_COLUMNS =
  "id, number, bracket, round, slot, player_a_id AS playerA, player_b_id AS playerB, next_match_id AS nextMatchId, next_slot AS nextSlot, loser_next_match_id AS loserNextMatchId, loser_next_slot AS loserNextSlot, court_id AS courtId, status, score_a AS scoreA, score_b AS scoreB, games_a AS gamesA, games_b AS gamesB, game_scores AS gameScores, server, outcome, winner_id AS winnerId, started_at AS startedAt, finished_at AS finishedAt, rating_change AS ratingChange, version";

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

function capitalized(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function loserRounds(tournament) {
  return 2 * (Math.log2(tournament.bracket_size) - 1);
}

function matchLabel(state, match) {
  return `M${match.number} (${roundName(state.tournament, match)})`;
}

function roundName(tournament, match) {
  if (match.bracket === "final") return match.round === 1 ? "Grand final" : "Grand final reset";
  if (match.bracket === "losers")
    return match.round === loserRounds(tournament) ? "Losers final" : `Losers round ${match.round}`;
  const side = tournament.format === "double" ? "winners " : "";
  const remaining = Math.log2(tournament.bracket_size) - match.round;
  if (remaining === 0) return capitalized(`${side}final`);
  if (remaining === 1) return capitalized(`${side}semifinal`);
  if (remaining === 2) return capitalized(`${side}quarterfinal`);
  return capitalized(`${side}round of ${2 ** (remaining + 1)}`);
}

function finishingPlaces(format, bracketSize, matches) {
  const feeders = new Map();
  for (const match of matches)
    for (const [target, loser] of [
      [match.nextMatchId, false],
      [match.loserNextMatchId, true],
    ])
      if (target) feeders.set(target, [...(feeders.get(target) ?? []), { from: match, loser }]);
  const entrants = new Map();
  const count = (match) => {
    if (entrants.has(match.id)) return entrants.get(match.id);
    const list = feeders.get(match.id) ?? [];
    const total =
      list.length === 0
        ? match.status === "bye"
          ? 1
          : 2
        : list.reduce(
            (sum, { from, loser }) =>
              sum + ((loser ? count(from) === 2 : count(from) >= 1) ? 1 : 0),
            0,
          );
    entrants.set(match.id, total);
    return total;
  };
  const single = format === "single";
  const rounds = Math.log2(bracketSize);
  const lastStage = single ? rounds : 2 * (rounds - 1);
  const knockedOut = new Map();
  for (const match of matches)
    if ((single || match.bracket === "losers") && count(match) === 2)
      knockedOut.set(match.round, (knockedOut.get(match.round) ?? 0) + 1);
  const final = (stage) => (single ? stage >= lastStage : stage > lastStage);
  return {
    place(stage) {
      if (final(stage)) return 2;
      let above = 3;
      for (let later = stage + 1; later <= lastStage - (single ? 1 : 0); later += 1)
        above += knockedOut.get(later) ?? 0;
      return above;
    },
    tied: (stage) => !final(stage) && (knockedOut.get(stage) ?? 0) > 1,
  };
}

function newState(tournament, lastSeq = () => 0) {
  return {
    tournament,
    players: new Map(),
    courts: new Map(),
    matches: new Map(),
    seq: new Map(),
    lastSeq,
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

function gameNumber(match) {
  return match.games_a + match.games_b + 1;
}

function hasPoints(match) {
  return match.score_a + match.score_b + match.games_a + match.games_b > 0;
}

function gamesToWin(tournament) {
  return Math.floor(tournament.best_of / 2) + 1;
}

function addEvent(
  state,
  match,
  kind,
  side,
  at,
  actor,
  game = gameNumber(match),
  score = [match.score_a, match.score_b],
) {
  const seq = (state.seq.get(match.id) ?? state.lastSeq(match.id)) + 1;
  state.seq.set(match.id, seq);
  state.events.push({
    id: `${match.id}-e${seq}`,
    tournament_id: match.tournament_id,
    match_id: match.id,
    seq,
    game,
    kind,
    side,
    player_a: match.player_a_id,
    player_b: match.player_b_id,
    score_a: score[0],
    score_b: score[1],
    court_id: match.court_id,
    actor,
    at,
  });
}

function feeders(state, target) {
  return [...state.matches.values()].filter(
    (match) =>
      (match.next_match_id === target.id && match.next_slot) ||
      match.loser_next_match_id === target.id,
  );
}

function resolve(state, target, at, actor) {
  if (target.status !== "waiting") return;
  const from = feeders(state, target);
  if (!from.length || !from.every((match) => match.status === "done" || match.status === "bye"))
    return;
  if (target.player_a_id && target.player_b_id) {
    target.status = "ready";
    touchMatch(state, target);
    return;
  }
  target.status = "bye";
  target.winner_id = target.player_a_id ?? target.player_b_id;
  target.finished_at = at;
  touchMatch(state, target);
  if (target.winner_id) addEvent(state, target, "bye", target.player_a_id ? "a" : "b", at, actor);
  send(state, target, target.winner_id, null, at, actor);
}

function place(state, targetId, slot, playerId, at, actor) {
  const target = targetId && slot ? state.matches.get(targetId) : null;
  if (!target) return null;
  target[slot === "a" ? "player_a_id" : "player_b_id"] = playerId;
  touchMatch(state, target);
  resolve(state, target, at, actor);
  return target.id;
}

function send(state, match, winnerId, loserId, at, actor) {
  return {
    advancedTo: place(state, match.next_match_id, match.next_slot, winnerId, at, actor),
    droppedTo: place(state, match.loser_next_match_id, match.loser_next_slot, loserId, at, actor),
  };
}

function retract(ctx, state, target, column, at, actor) {
  if (target.status === "done" || (target.status === "live" && hasPoints(target)))
    ctx.refuse(
      "next_started",
      `${matchLabel(state, target)} already has points, so this result can no longer change.`,
    );
  if (target.status === "live") {
    addEvent(state, target, "cancel", null, at, actor);
    target.court_id = null;
    target.started_at = null;
  }
  if (target.status === "bye") {
    for (const [id, slot] of [
      [target.next_match_id, target.next_slot],
      [target.loser_next_match_id, target.loser_next_slot],
    ])
      if (id && slot)
        retract(
          ctx,
          state,
          state.matches.get(id),
          slot === "a" ? "player_a_id" : "player_b_id",
          at,
          actor,
        );
    target.winner_id = null;
    target.finished_at = null;
  }
  if (column) target[column] = null;
  else {
    target.player_a_id = null;
    target.player_b_id = null;
  }
  target.status = "waiting";
  touchMatch(state, target);
}

const BRACKET_ORDER = { winners: 0, losers: 1, final: 2 };

function playOrder(match) {
  if (match.bracket === "winners") return 2 * match.round - 2;
  if (match.bracket === "losers") return match.round === 1 ? 1 : match.round + 1;
  return 1000 + match.round;
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
    format: plan.format,
    best_of: plan.bestOf,
    visibility: plan.visibility,
    status: "live",
    bracket_size: size,
    points_to_win: plan.pointsToWin,
    win_by: plan.winBy,
    k_factor: plan.kFactor,
    champion_id: null,
    created_at: plan.now,
    updated_at: plan.now,
  });
  const seeded =
    plan.seeding === "order"
      ? plan.players
      : plan.players
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
  const double = plan.format === "double";
  const lastLoser = 2 * (rounds - 1);
  const key = (bracket, round, slot) => `${id}-${bracket[0]}${round}-m${slot}`;
  const add = (bracket, round, slot) =>
    state.matches.set(key(bracket, round, slot), {
      id: key(bracket, round, slot),
      tournament_id: id,
      number: 0,
      bracket,
      round,
      slot,
      player_a_id: null,
      player_b_id: null,
      next_match_id: null,
      next_slot: null,
      loser_next_match_id: null,
      loser_next_slot: null,
      court_id: null,
      status: "waiting",
      score_a: 0,
      score_b: 0,
      games_a: 0,
      games_b: 0,
      game_scores: "",
      server: null,
      outcome: null,
      winner_id: null,
      started_at: null,
      finished_at: null,
      rating_change: null,
      version: 1,
    });
  const parity = (slot) => (slot % 2 === 1 ? "a" : "b");
  for (let round = 1; round <= rounds; round += 1)
    for (let slot = 1; slot <= size / 2 ** round; slot += 1) add("winners", round, slot);
  if (double) {
    for (let round = 1; round <= lastLoser; round += 1)
      for (let slot = 1; slot <= size / 2 ** (Math.ceil(round / 2) + 1); slot += 1)
        add("losers", round, slot);
    add("final", 1, 1);
    add("final", 2, 1);
  }
  for (const match of state.matches.values()) {
    const { bracket, round, slot } = match;
    if (bracket === "winners") {
      if (round < rounds) {
        match.next_match_id = key("winners", round + 1, Math.ceil(slot / 2));
        match.next_slot = parity(slot);
      } else if (double) {
        match.next_match_id = key("final", 1, 1);
        match.next_slot = "a";
      }
      if (double && round === 1) {
        match.loser_next_match_id = key("losers", 1, Math.ceil(slot / 2));
        match.loser_next_slot = parity(slot);
      } else if (double) {
        const across = size / 2 ** round;
        match.loser_next_match_id = key(
          "losers",
          2 * (round - 1),
          round % 2 === 0 ? across + 1 - slot : slot,
        );
        match.loser_next_slot = "b";
      }
    } else if (bracket === "losers") {
      if (round === lastLoser) {
        match.next_match_id = key("final", 1, 1);
        match.next_slot = "b";
      } else if (round % 2 === 1) {
        match.next_match_id = key("losers", round + 1, slot);
        match.next_slot = "a";
      } else {
        match.next_match_id = key("losers", round + 1, Math.ceil(slot / 2));
        match.next_slot = parity(slot);
      }
    } else if (round === 1) match.next_match_id = key("final", 2, 1);
  }
  [...state.matches.values()]
    .sort(
      (left, right) =>
        playOrder(left) - playOrder(right) ||
        BRACKET_ORDER[left.bracket] - BRACKET_ORDER[right.bracket] ||
        left.slot - right.slot,
    )
    .forEach((match, index) => {
      match.number = index + 1;
    });
  const order = seedOrder(size);
  const seedId = (seed) => (seed <= count ? `${id}-p${seed}` : null);
  for (let slot = 1; slot <= size / 2; slot += 1) {
    const match = state.matches.get(key("winners", 1, slot));
    match.player_a_id = seedId(order[2 * slot - 2]);
    match.player_b_id = seedId(order[2 * slot - 1]);
    if (match.player_a_id && match.player_b_id) match.status = "ready";
  }
  for (let slot = 1; slot <= size / 2; slot += 1) {
    const match = state.matches.get(key("winners", 1, slot));
    if (match.status === "ready") continue;
    match.status = "bye";
    match.winner_id = match.player_a_id ?? match.player_b_id;
    match.finished_at = plan.now;
    addEvent(state, match, "bye", match.player_a_id ? "a" : "b", plan.now, plan.actor);
    send(state, match, match.winner_id, null, plan.now, plan.actor);
  }
  for (const match of state.matches.values()) match.version = 1;
  return state;
}

function requireFreeCourt(ctx, state, match, court) {
  if (!court || court.tournament_id !== match.tournament_id)
    ctx.refuse("not_found", "That court is not part of this tournament.");
  for (const other of state.matches.values())
    if (other.court_id === court.id && other.status === "live")
      ctx.refuse(
        "court_busy",
        `${court.name} is already playing ${matchLabel(state, other)}. Complete that match first.`,
      );
}

function startMatchIn(ctx, state, match, court, at, actor) {
  if (match.status !== "ready")
    ctx.refuse(
      "match_not_ready",
      match.status === "waiting"
        ? `${matchLabel(state, match)} is still waiting for its players.`
        : `${matchLabel(state, match)} has already started.`,
    );
  requireFreeCourt(ctx, state, match, court);
  match.status = "live";
  match.court_id = court.id;
  match.started_at = at;
  match.server = match.server ?? "a";
  touchMatch(state, match);
  touchTournament(state, at);
  addEvent(state, match, "start", null, at, actor);
}

function scorePointIn(ctx, state, match, side, at, actor) {
  if (isDecided(state.tournament, match.score_a, match.score_b))
    ctx.refuse(
      "match_decided",
      `Game ${gameNumber(match)} is over at ${match.score_a}–${match.score_b}. Record it or undo a point.`,
    );
  if (side === "a") match.score_a += 1;
  else match.score_b += 1;
  match.server = side;
  touchMatch(state, match);
  touchTournament(state, at);
  addEvent(state, match, "point", side, at, actor);
}

function gameTotals(match) {
  return match.game_scores
    .split(" ")
    .filter(Boolean)
    .reduce(
      (sum, game) => {
        const [a, b] = game.split("-").map(Number);
        return { a: sum.a + a, b: sum.b + b };
      },
      { a: 0, b: 0 },
    );
}

function eliminationStage(state, match, loserWasA) {
  const tournament = state.tournament;
  if (tournament.format === "single") return match.round;
  if (match.bracket === "winners") return null;
  if (match.bracket === "losers") return match.round;
  if (match.round === 1 && loserWasA) return null;
  return loserRounds(tournament) + match.round;
}

function finishMatch(state, match, aWon, at, actor, outcome) {
  const tournament = state.tournament;
  const winner = state.players.get(aWon ? match.player_a_id : match.player_b_id);
  const loser = state.players.get(aWon ? match.player_b_id : match.player_a_id);
  const played = outcome !== "walkover";
  const totals = played ? gameTotals(match) : { a: 0, b: 0 };
  const delta = played ? eloDelta(winner.rating, loser.rating, tournament.k_factor) : 0;
  winner.rating += delta;
  winner.wins += 1;
  winner.points_for += aWon ? totals.a : totals.b;
  winner.points_against += aWon ? totals.b : totals.a;
  loser.rating -= delta;
  loser.losses += 1;
  loser.points_for += aWon ? totals.b : totals.a;
  loser.points_against += aWon ? totals.a : totals.b;
  const stage = eliminationStage(state, match, !aWon);
  if (stage !== null) loser.eliminated_round = stage;
  state.changedPlayers.add(winner.id);
  state.changedPlayers.add(loser.id);
  match.status = "done";
  match.winner_id = winner.id;
  match.finished_at = at;
  match.rating_change = delta;
  match.outcome = outcome;
  touchMatch(state, match);
  addEvent(
    state,
    match,
    outcome === "reported" ? "report" : played ? "complete" : "walkover",
    aWon ? "a" : "b",
    at,
    actor,
    played ? match.games_a + match.games_b : gameNumber(match),
  );
  let { advancedTo, droppedTo } = send(state, match, winner.id, loser.id, at, actor);
  let crowned = !match.next_match_id;
  if (match.bracket === "final" && match.round === 1) {
    const reset = state.matches.get(match.next_match_id);
    if (aWon) {
      reset.status = "skipped";
      crowned = true;
    } else {
      reset.player_a_id = match.player_a_id;
      reset.player_b_id = match.player_b_id;
      reset.status = "ready";
      advancedTo = reset.id;
    }
    touchMatch(state, reset);
  }
  if (crowned) {
    tournament.status = "finished";
    tournament.champion_id = winner.id;
  }
  touchTournament(state, at);
  return {
    winnerId: winner.id,
    loserId: loser.id,
    ratingChange: delta,
    advancedTo,
    droppedTo,
    championId: tournament.champion_id,
    loserOut: stage !== null,
    freedCourtId: match.court_id,
  };
}

function completeGameIn(ctx, state, match, at, actor) {
  const tournament = state.tournament;
  if (!isDecided(tournament, match.score_a, match.score_b))
    ctx.refuse(
      "not_decided",
      `A game needs ${tournament.points_to_win} points and a ${tournament.win_by}-point lead. The score is ${match.score_a}–${match.score_b}.`,
    );
  const aWon = match.score_a > match.score_b;
  match.game_scores = [match.game_scores, `${match.score_a}-${match.score_b}`]
    .filter(Boolean)
    .join(" ");
  if (aWon) match.games_a += 1;
  else match.games_b += 1;
  if (Math.max(match.games_a, match.games_b) >= gamesToWin(tournament))
    return { ...finishMatch(state, match, aWon, at, actor, "played"), matchOver: true };
  touchMatch(state, match);
  touchTournament(state, at);
  addEvent(state, match, "game", aWon ? "a" : "b", at, actor, match.games_a + match.games_b);
  match.score_a = 0;
  match.score_b = 0;
  match.server = aWon ? "b" : "a";
  return {
    matchOver: false,
    gameWinnerId: aWon ? match.player_a_id : match.player_b_id,
    gamesA: match.games_a,
    gamesB: match.games_b,
  };
}

function reopenMatchIn(ctx, state, match, at, actor) {
  if (match.status !== "done")
    ctx.refuse("not_done", `${matchLabel(state, match)} has no result to reopen.`);
  for (const [id, slot] of [
    [match.next_match_id, match.next_slot],
    [match.loser_next_match_id, match.loser_next_slot],
  ])
    if (id && slot)
      retract(
        ctx,
        state,
        state.matches.get(id),
        slot === "a" ? "player_a_id" : "player_b_id",
        at,
        actor,
      );
  if (match.bracket === "final" && match.round === 1)
    retract(ctx, state, state.matches.get(match.next_match_id), null, at, actor);
  const walkover = match.outcome === "walkover";
  const reported = match.outcome === "reported";
  const unstarted = reported || (walkover && match.started_at === null);
  const logged = {
    game: walkover ? gameNumber(match) : match.games_a + match.games_b,
    score: [match.score_a, match.score_b],
  };
  const busy = new Set(
    [...state.matches.values()]
      .filter((other) => other.status === "live")
      .map((other) => other.court_id),
  );
  const court = unstarted
    ? null
    : !match.court_id || busy.has(match.court_id)
      ? [...state.courts.values()]
          .sort((left, right) => left.position - right.position)
          .find((candidate) => !busy.has(candidate.id))
      : state.courts.get(match.court_id);
  if (!unstarted && !court)
    ctx.refuse("court_busy", "Every court is playing a match. Complete one, then reopen this one.");
  const aWon = match.winner_id === match.player_a_id;
  const winner = state.players.get(match.winner_id);
  const loser = state.players.get(aWon ? match.player_b_id : match.player_a_id);
  const totals = walkover ? { a: 0, b: 0 } : gameTotals(match);
  const delta = match.rating_change ?? 0;
  winner.rating -= delta;
  winner.wins -= 1;
  winner.points_for -= aWon ? totals.a : totals.b;
  winner.points_against -= aWon ? totals.b : totals.a;
  loser.rating += delta;
  loser.losses -= 1;
  loser.points_for -= aWon ? totals.b : totals.a;
  loser.points_against -= aWon ? totals.a : totals.b;
  if (eliminationStage(state, match, !aWon) !== null) loser.eliminated_round = null;
  state.changedPlayers.add(winner.id);
  state.changedPlayers.add(loser.id);
  if (state.tournament.champion_id) {
    state.tournament.status = "live";
    state.tournament.champion_id = null;
  }
  if (reported) {
    match.games_a = 0;
    match.games_b = 0;
    match.game_scores = "";
    match.score_a = 0;
    match.score_b = 0;
    match.started_at = null;
  } else if (!walkover) {
    if (aWon) match.games_a -= 1;
    else match.games_b -= 1;
    match.game_scores = match.game_scores.split(" ").slice(0, -1).join(" ");
  }
  match.status = unstarted ? "ready" : "live";
  match.court_id = court ? court.id : null;
  match.winner_id = null;
  match.finished_at = null;
  match.rating_change = null;
  match.outcome = null;
  touchMatch(state, match);
  touchTournament(state, at);
  addEvent(
    state,
    match,
    "reopen",
    walkover ? null : aWon ? "a" : "b",
    at,
    actor,
    logged.game,
    logged.score,
  );
  return { ratingChange: -delta, courtId: match.court_id };
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
    [...state.matches.values()].sort((left, right) => right.number - left.number),
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
  const state = newState(ctx.db.query("SELECT * FROM tournaments WHERE id = ?", [id])[0], (match) =>
    Number(
      ctx.db.query("SELECT MAX(seq) AS seq FROM match_events WHERE match_id = ?", [match])[0]
        ?.seq ?? 0,
    ),
  );
  for (const row of ctx.db.query("SELECT * FROM players WHERE tournament_id = ?", [id]))
    state.players.set(row.id, row);
  for (const row of ctx.db.query("SELECT * FROM courts WHERE tournament_id = ?", [id]))
    state.courts.set(row.id, row);
  for (const row of ctx.db.query("SELECT * FROM matches WHERE tournament_id = ?", [id]))
    state.matches.set(row.id, row);
  return { state, match: state.matches.get(matchId) };
}

function checkVersion(ctx, state, match, expectedVersion) {
  if (!Number.isInteger(expectedVersion))
    ctx.refuse("invalid_input", "Send the match version you are looking at.");
  if (match.version !== expectedVersion)
    ctx.refuse(
      "conflict",
      `Someone else updated ${matchLabel(state, match)} first. ${
        match.status === "live"
          ? `The score is now ${match.score_a}–${match.score_b}.`
          : match.status === "done"
            ? match.outcome === "walkover"
              ? "It was decided by walkover."
              : "It is finished."
            : match.status === "ready"
              ? "It is back in the queue."
              : "It is waiting for players."
      }`,
    );
}

function reportedGames(ctx, tournament, value) {
  const need = gamesToWin(tournament);
  if (!Array.isArray(value) || value.length < need || value.length > tournament.best_of)
    ctx.refuse(
      "invalid_input",
      need === tournament.best_of
        ? "Enter the game score."
        : `Enter ${need} to ${tournament.best_of} game scores.`,
    );
  const won = { a: 0, b: 0 };
  const games = value.map((game, index) => {
    if (won.a === need || won.b === need)
      ctx.refuse(
        "invalid_input",
        `The match was over after game ${index}. Remove game ${index + 1}.`,
      );
    const [a, b] = Array.isArray(game) ? game : [];
    if (![a, b].every((points) => Number.isInteger(points) && points >= 0 && points <= 999))
      ctx.refuse("invalid_input", `Enter both scores for game ${index + 1}.`);
    if (
      Math.max(a, b) !== Math.max(tournament.points_to_win, Math.min(a, b) + tournament.win_by) ||
      (tournament.win_by === 1 && Math.min(a, b) >= tournament.points_to_win)
    )
      ctx.refuse(
        "invalid_input",
        `Game ${index + 1} at ${a}–${b} is not a finished game. Games go to ${tournament.points_to_win}, win by ${tournament.win_by}.`,
      );
    won[a > b ? "a" : "b"] += 1;
    return [a, b];
  });
  if (won.a !== need && won.b !== need)
    ctx.refuse("invalid_input", `Nobody has won ${need} games yet. Add the missing games.`);
  return games;
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
    format: "double",
    bestOf: 3,
    visibility: "shared",
    pointsToWin: 11,
    winBy: 2,
    kFactor: 32,
    now: now - 5 * 60 * 60 * 1000,
    actor,
    players: DEMO_PLAYERS.map(([name, club, rating]) => ({ name, club, rating })),
    courts: ["Center Court", "Court 2", "Court 3", "Court 4"],
  });
  const courts = [...state.courts.values()];
  const random = mulberry32(20261124);
  let time = now - 280 * 60 * 1000;
  const tick = (ms) => (time += ms);
  const rally = (match, side) =>
    scorePointIn(ctx, state, match, side, tick(9_000 + Math.floor(random() * 10_000)), actor);
  const sequence = (match, a, b) => {
    const remaining = [a, b];
    while (remaining[0] + remaining[1] > 0) {
      const side = random() < remaining[0] / (remaining[0] + remaining[1]) ? "a" : "b";
      remaining[side === "a" ? 0 : 1] -= 1;
      rally(match, side);
    }
  };
  const game = (match, winner) => {
    const losing = 3 + Math.floor(random() * 7);
    sequence(match, winner === "a" ? 10 : losing, winner === "a" ? losing : 10);
    rally(match, winner);
    return completeGameIn(ctx, state, match, tick(45_000), actor);
  };
  const play = (bracket, round, slot, court, stop) => {
    const match = state.matches.get(`${state.tournament.id}-${bracket[0]}${round}-m${slot}`);
    startMatchIn(ctx, state, match, court, tick(90_000), actor);
    if (stop) {
      for (const winner of stop.games) game(match, winner);
      sequence(match, stop.score[0], stop.score[1]);
      return;
    }
    const a = state.players.get(match.player_a_id).rating;
    const b = state.players.get(match.player_b_id).rating;
    const chanceA = 0.5 + (1 / (1 + Math.pow(10, (b - a) / 400)) - 0.5) * 0.6;
    for (let over = false; !over;) over = game(match, random() < chanceA ? "a" : "b").matchOver;
  };
  for (let slot = 1; slot <= 8; slot += 1) play("winners", 1, slot, courts[(slot - 1) % 4]);
  for (let slot = 1; slot <= 4; slot += 1) play("losers", 1, slot, courts[(slot - 1) % 4]);
  for (let slot = 1; slot <= 4; slot += 1) play("winners", 2, slot, courts[(slot - 1) % 4]);
  play("losers", 2, 1, courts[0]);
  play("losers", 2, 2, courts[1]);
  time = now - 24 * 60 * 1000;
  play("winners", 3, 1, courts[0], { games: ["a"], score: [9, 7] });
  time = now - 11 * 60 * 1000;
  play("losers", 2, 3, courts[1], { games: [], score: [5, 6] });
  state.tournament.updated_at = now;
  return state;
}

const HISTORY_LIMIT = 500;

function publicHistory(rows) {
  const kept = new Map();
  for (const row of [...rows].reverse()) {
    const stack = kept.get(row.matchId ?? "") ?? [];
    kept.set(row.matchId ?? "", stack);
    const undone =
      row.kind === "undo"
        ? row.side
          ? ["point"]
          : ["game"]
        : row.kind === "reopen"
          ? ["complete", "walkover", "report"]
          : row.kind === "cancel"
            ? ["start"]
            : null;
    if (!undone) {
      stack.push(row);
      continue;
    }
    for (let index = stack.length - 1; index >= 0; index -= 1)
      if (undone.includes(stack[index].kind)) {
        stack.splice(index, 1);
        break;
      }
  }
  const shown = new Set([...kept.values()].flat());
  return rows.filter((row) => shown.has(row));
}

const LISTED = 200;

globalThis.operations = {
  liveSnapshot(ctx, input) {
    const scorekeeper =
      ctx.caller.kind === "owner" || (ctx.caller.kind === "named" && ctx.caller.helper);
    const fans = !scorekeeper || input?.view === "public";
    const summary = (where, params = [], limit = 1) =>
      ctx.db.query(
        `SELECT id, name, sport, status, visibility, created_at AS createdAt FROM tournaments WHERE ${where}${fans ? " AND visibility = 'shared'" : ""} ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
        params,
      );
    const tournaments = summary("1 = 1", [], LISTED);
    const requested = typeof input?.tournamentId === "string" ? input.tournamentId : null;
    const chosen =
      (requested ? summary("id = ?", [requested])[0] : undefined) ??
      summary("status = 'live'")[0] ??
      tournaments[0];
    if (!chosen) return { tournaments: [], tournament: null, now: ctx.nowMs };
    const listed = tournaments.some((row) => row.id === chosen.id)
      ? tournaments
      : [chosen, ...tournaments];
    const tournament = ctx.db.query(
      "SELECT id, name, sport, format, best_of AS bestOf, visibility, status, bracket_size AS bracketSize, points_to_win AS pointsToWin, win_by AS winBy, k_factor AS kFactor, champion_id AS championId, created_at AS createdAt, updated_at AS updatedAt FROM tournaments WHERE id = ?",
      [chosen.id],
    )[0];
    const matches = ctx.db.query(
      `SELECT ${MATCH_COLUMNS} FROM matches WHERE tournament_id = ? ORDER BY number`,
      [chosen.id],
    );
    const placeAt = finishingPlaces(tournament.format, tournament.bracketSize, matches);
    const standings = ctx.db
      .query(
        `SELECT id, name, club, seed, rating, start_rating AS startRating, rating - start_rating AS ratingChange,
          wins, losses, points_for AS pointsFor, points_against AS pointsAgainst,
          points_for - points_against AS pointDiff, eliminated_round AS eliminatedRound
         FROM players WHERE tournament_id = ?`,
        [chosen.id],
      )
      .map((row) => ({
        ...row,
        place:
          row.id === tournament.championId || row.eliminatedRound === null
            ? 1
            : placeAt.place(row.eliminatedRound),
        tied:
          row.id !== tournament.championId &&
          row.eliminatedRound !== null &&
          placeAt.tied(row.eliminatedRound),
      }))
      .sort(
        (left, right) =>
          left.place - right.place ||
          left.losses - right.losses ||
          right.wins - left.wins ||
          right.pointDiff - left.pointDiff ||
          right.rating - left.rating ||
          left.seed - right.seed,
      );
    const courts = ctx.db.query(
      `SELECT c.id, c.name, c.position, m.id AS matchId
       FROM courts c LEFT JOIN matches m ON m.court_id = c.id AND m.status = 'live'
       WHERE c.tournament_id = ? ORDER BY c.position`,
      [chosen.id],
    );
    const feed = ctx.db.query(
      `SELECT id, match_id AS matchId, seq, game, kind, side, player_a AS playerA, player_b AS playerB,
        score_a AS scoreA, score_b AS scoreB,
        court_id AS courtId, at
       FROM match_events WHERE tournament_id = ? AND kind IN ('point', 'undo', 'game', 'complete', 'report', 'walkover', 'reopen', 'start', 'cancel', 'move')
       ORDER BY at DESC, seq DESC LIMIT ${fans ? 200 : 14}`,
      [chosen.id],
    );
    const recent = fans ? publicHistory(feed).slice(0, 14) : feed;
    const timelineFor =
      typeof input?.matchId === "string" && matches.some((match) => match.id === input.matchId)
        ? input.matchId
        : null;
    const timeline = timelineFor
      ? ctx.db.query(
          `SELECT seq, game, kind, side, player_a AS playerA, player_b AS playerB, score_a AS scoreA, score_b AS scoreB, court_id AS courtId, at FROM match_events WHERE match_id = ? ORDER BY seq DESC LIMIT ${HISTORY_LIMIT}`,
          [timelineFor],
        )
      : null;
    return {
      tournaments: listed,
      tournament,
      standings,
      matches,
      courts,
      recent,
      now: ctx.nowMs,
      ...(timeline
        ? {
            timeline: fans ? publicHistory(timeline) : timeline,
            timelineCut: timeline.length >= HISTORY_LIMIT,
          }
        : {}),
    };
  },

  matchLog(ctx, input) {
    requireScorekeeper(ctx);
    return ctx.db.query(
      `SELECT seq, game, kind, side, player_a AS playerA, player_b AS playerB, score_a AS scoreA, score_b AS scoreB, court_id AS courtId, actor, at FROM match_events WHERE match_id = ? ORDER BY seq DESC LIMIT ${HISTORY_LIMIT}`,
      [idText(ctx, input?.matchId, "match")],
    );
  },

  createTournament(ctx, input) {
    requireOrganizer(ctx);
    const sport = SPORTS.includes(input?.sport) ? input.sport : null;
    if (!sport) ctx.refuse("invalid_input", "Choose Pickleball, Esports, or Tabletop.");
    const format = input?.format ?? "single";
    if (!FORMATS.includes(format))
      ctx.refuse("invalid_input", "Choose single or double elimination.");
    const bestOf = Number(input?.bestOf ?? 1);
    if (!BEST_OF.includes(bestOf)) ctx.refuse("invalid_input", "Matches are best of 1, 3, or 5.");
    const visibility = input?.visibility ?? "shared";
    if (!VISIBILITY.includes(visibility)) ctx.refuse("invalid_input", "Choose shared or private.");
    const seeding = input?.seeding ?? "rating";
    if (!SEEDING.includes(seeding))
      ctx.refuse("invalid_input", "Seed by rating or by the order given.");
    const courtCount = wholeNumber(ctx, input?.courts, 4, 1, 16, "Courts");
    const state = buildBracket(ctx, {
      id: `t-${ctx.requestId}`,
      name: cleanText(ctx, input?.name, "a tournament name", 80, false),
      sport,
      format,
      bestOf,
      visibility,
      pointsToWin: wholeNumber(ctx, input?.pointsToWin, 11, 1, 99, "Points to win"),
      winBy: wholeNumber(ctx, input?.winBy, 2, 1, 5, "Win by"),
      kFactor: wholeNumber(ctx, input?.kFactor, 32, 1, 64, "Rating K-factor"),
      now: ctx.nowMs,
      actor: actorOf(ctx),
      seeding,
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
      matches: state.matches.size,
    };
  },

  setVisibility(ctx, input) {
    requireOrganizer(ctx);
    const visibility = input?.visibility;
    if (!VISIBILITY.includes(visibility)) ctx.refuse("invalid_input", "Choose shared or private.");
    const id = idText(ctx, input?.tournamentId, "tournament");
    if (!ctx.db.query("SELECT 1 FROM tournaments WHERE id = ?", [id]).length)
      ctx.refuse("not_found", "That tournament no longer exists.");
    ctx.db.execute("UPDATE tournaments SET visibility = ?, updated_at = ? WHERE id = ?", [
      visibility,
      ctx.nowMs,
      id,
    ]);
    return { tournamentId: id, visibility };
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

  returnToQueue(ctx, input) {
    return liveMatchAction(ctx, input, (state, match) => {
      requireLive(ctx, state, match);
      if (hasPoints(match))
        ctx.refuse(
          "match_scored",
          `${matchLabel(state, match)} already has points. Undo them before returning it to the queue.`,
        );
      const at = ctx.nowMs;
      addEvent(state, match, "cancel", null, at, actorOf(ctx));
      match.status = "ready";
      match.court_id = null;
      match.started_at = null;
      touchMatch(state, match);
      touchTournament(state, at);
    });
  },

  moveMatch(ctx, input) {
    return liveMatchAction(ctx, input, (state, match) => {
      requireLive(ctx, state, match);
      const court = state.courts.get(idText(ctx, input?.courtId, "court"));
      if (court?.id === match.court_id)
        ctx.refuse("invalid_input", `${matchLabel(state, match)} is already on ${court.name}.`);
      requireFreeCourt(ctx, state, match, court);
      const at = ctx.nowMs;
      match.court_id = court.id;
      touchMatch(state, match);
      touchTournament(state, at);
      addEvent(state, match, "move", null, at, actorOf(ctx));
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
      const at = ctx.nowMs;
      const actor = actorOf(ctx);
      const total = match.score_a + match.score_b;
      const pointAt = (sum) =>
        ctx.db.query(
          "SELECT side FROM match_events WHERE match_id = ? AND kind = 'point' AND game = ? AND score_a + score_b = ? ORDER BY seq DESC LIMIT 1",
          [match.id, gameNumber(match), sum],
        )[0];
      if (total === 0) {
        const games = match.game_scores.split(" ").filter(Boolean);
        if (!games.length)
          ctx.refuse("nothing_to_undo", "There is no point to undo in this match.");
        const [a, b] = games[games.length - 1].split("-").map(Number);
        match.game_scores = games.slice(0, -1).join(" ");
        if (a > b) match.games_a -= 1;
        else match.games_b -= 1;
        match.score_a = a;
        match.score_b = b;
        match.server = a > b ? "a" : "b";
        touchMatch(state, match);
        touchTournament(state, at);
        addEvent(state, match, "undo", null, at, actor);
        return;
      }
      const last = pointAt(total);
      if (!last) ctx.refuse("nothing_to_undo", "There is no point to undo in this game.");
      if (last.side === "a") match.score_a -= 1;
      else match.score_b -= 1;
      const previous = total > 1 ? pointAt(total - 1) : null;
      const lastGame = match.game_scores.split(" ").filter(Boolean).pop();
      match.server = previous
        ? previous.side
        : lastGame
          ? Number(lastGame.split("-")[0]) > Number(lastGame.split("-")[1])
            ? "b"
            : "a"
          : "a";
      touchMatch(state, match);
      touchTournament(state, at);
      addEvent(state, match, "undo", last.side, at, actor);
    });
  },

  completeMatch(ctx, input) {
    return liveMatchAction(ctx, input, (state, match) => {
      requireLive(ctx, state, match);
      return completeGameIn(ctx, state, match, ctx.nowMs, actorOf(ctx));
    });
  },

  awardWalkover(ctx, input) {
    const winner = input?.winner;
    if (winner !== "a" && winner !== "b")
      ctx.refuse("invalid_input", "Choose which side wins the walkover.");
    return liveMatchAction(ctx, input, (state, match) => {
      if (match.status !== "ready" && match.status !== "live")
        ctx.refuse(
          "match_not_open",
          `${matchLabel(state, match)} needs both players and no result to award a walkover.`,
        );
      if (match.status === "live" && isDecided(state.tournament, match.score_a, match.score_b))
        ctx.refuse(
          "match_decided",
          `Game ${match.games_a + match.games_b + 1} of ${matchLabel(state, match)} is won. Record game ${
            match.games_a + match.games_b + 1
          } first.`,
        );
      return finishMatch(state, match, winner === "a", ctx.nowMs, actorOf(ctx), "walkover");
    });
  },

  reportResult(ctx, input) {
    return liveMatchAction(ctx, input, (state, match) => {
      if (match.status !== "ready" && match.status !== "live")
        ctx.refuse(
          "match_not_open",
          `${matchLabel(state, match)} needs both players and no result to enter one.`,
        );
      if (hasPoints(match))
        ctx.refuse(
          "match_scored",
          `${matchLabel(state, match)} already has points. Finish it on the board, or undo them first.`,
        );
      const games = reportedGames(ctx, state.tournament, input?.games);
      const at = ctx.nowMs;
      if (match.status === "live") {
        addEvent(state, match, "cancel", null, at, actorOf(ctx));
        match.started_at = null;
        match.court_id = null;
      }
      const [lastA, lastB] = games[games.length - 1];
      match.game_scores = games.map(([a, b]) => `${a}-${b}`).join(" ");
      match.games_a = games.filter(([a, b]) => a > b).length;
      match.games_b = games.length - match.games_a;
      match.score_a = lastA;
      match.score_b = lastB;
      return {
        ...finishMatch(state, match, lastA > lastB, at, actorOf(ctx), "reported"),
        matchOver: true,
      };
    });
  },

  reopenMatch(ctx, input) {
    return liveMatchAction(ctx, input, (state, match) =>
      reopenMatchIn(ctx, state, match, ctx.nowMs, actorOf(ctx)),
    );
  },
};
