(function () {
  const MAP_RADIUS = 3;
  const VISION_RANGE = 2;
  const STARTING_GOLD = 4;
  const CAPITAL_START_UNITS = 6;
  const VANGUARD_START_UNITS = 2;
  const GOLD_MINE_GARRISON = 2;
  const FORTIFY_COST = 3;
  const REINFORCE_UNIT_COST = 2;
  const MAX_REINFORCE_PER_TURN = 5;
  const BASE_GOLD_INCOME = 2;
  const GOLD_MINE_INCOME = 2;
  const JOIN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  function countOf(count, singular, plural) {
    return count + " " + (count === 1 ? singular : plural);
  }

  const HEX_DIRECTIONS = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
  ];

  const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function utf8Bytes(text) {
    const out = [];
    for (let i = 0; i < text.length; i += 1) {
      let code = text.charCodeAt(i);
      if (code < 0x80) {
        out.push(code);
      } else if (code < 0x800) {
        out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if ((code & 0xfc00) === 0xd800 && i + 1 < text.length) {
        const next = text.charCodeAt(++i);
        code = 0x10000 + (((code & 0x3ff) << 10) | (next & 0x3ff));
        out.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        );
      } else {
        out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }
    return out;
  }

  function sha256Hex(text) {
    const bytes = utf8Bytes(text);
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const highBits = Math.floor(bitLen / 0x100000000);
    const lowBits = bitLen >>> 0;
    for (let shift = 24; shift >= 0; shift -= 8) bytes.push((highBits >>> shift) & 0xff);
    for (let shift = 24; shift >= 0; shift -= 8) bytes.push((lowBits >>> shift) & 0xff);

    let h0 = 0x6a09e667;
    let h1 = 0xbb67ae85;
    let h2 = 0x3c6ef372;
    let h3 = 0xa54ff53a;
    let h4 = 0x510e527f;
    let h5 = 0x9b05688c;
    let h6 = 0x1f83d9ab;
    let h7 = 0x5be0cd19;
    const w = new Array(64);

    for (let offset = 0; offset < bytes.length; offset += 64) {
      for (let i = 0; i < 16; i += 1) {
        const idx = offset + i * 4;
        w[i] =
          ((bytes[idx] << 24) | (bytes[idx + 1] << 16) | (bytes[idx + 2] << 8) | bytes[idx + 3]) >>>
          0;
      }
      for (let i = 16; i < 64; i += 1) {
        const s0 =
          ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^
          ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^
          (w[i - 15] >>> 3);
        const s1 =
          ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^
          ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^
          (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h0;
      let b = h1;
      let c = h2;
      let d = h3;
      let e = h4;
      let f = h5;
      let g = h6;
      let h = h7;
      for (let i = 0; i < 64; i += 1) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }
      h0 = (h0 + a) >>> 0;
      h1 = (h1 + b) >>> 0;
      h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0;
      h5 = (h5 + f) >>> 0;
      h6 = (h6 + g) >>> 0;
      h7 = (h7 + h) >>> 0;
    }

    return [h0, h1, h2, h3, h4, h5, h6, h7]
      .map((word) => word.toString(16).padStart(8, "0"))
      .join("");
  }

  function deriveToken(secret, label) {
    return sha256Hex("hexclash:token:v1:" + secret + ":" + label);
  }

  function deriveJoinCode(secret, salt) {
    const hash = sha256Hex("hexclash:join:v1:" + secret + ":" + salt);
    let code = "";
    for (let i = 0; i < 6; i += 1) {
      const byteVal = parseInt(hash.slice(i * 2, i * 2 + 2), 16);
      code += JOIN_ALPHABET[byteVal % JOIN_ALPHABET.length];
    }
    return code;
  }

  function deriveSeed(secret, requestId) {
    const hash = sha256Hex("hexclash:seed:v1:" + secret + ":" + requestId);
    return (parseInt(hash.slice(0, 8), 16) >>> 0) % 2147483647 || 1337;
  }

  function mulberry32(seed) {
    let state = seed >>> 0;
    return function next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hexKey(q, r) {
    return q + "," + r;
  }

  const PLACE_NAMES = {
    plains: "the plains",
    forest: "the forest",
    mountain: "the mountain",
    gold: "the gold mine",
    capital: "the capital",
  };

  function placeName(terrain) {
    return PLACE_NAMES[terrain] ?? "a hidden hex";
  }

  function hexDistance(aq, ar, bq, br) {
    return (Math.abs(aq - bq) + Math.abs(ar - br) + Math.abs(aq + ar - (bq + br))) / 2;
  }

  function expectObject(ctx, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      ctx.refuse("invalid_input", "Provide an object payload.");
    }
    return input;
  }

  function cleanText(ctx, value, fallback, code, noun, max) {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value !== "string" || /[\r\n\u0000-\u001f]/.test(value)) {
      ctx.refuse(code, "Enter a plain " + noun + " up to " + max + " characters.");
    }
    const trimmed = value.trim().replace(/\s+/g, " ");
    if (!trimmed || trimmed.length > max) {
      ctx.refuse(code, "Enter a " + noun + " between 1 and " + max + " characters.");
    }
    return trimmed;
  }

  function cleanName(ctx, value, fallback) {
    return cleanText(ctx, value, fallback, "invalid_name", "player name", 40);
  }

  function cleanTitle(ctx, value, fallback) {
    return cleanText(ctx, value, fallback, "invalid_title", "match title", 64);
  }

  function expectSafeInt(ctx, value, code, message) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      ctx.refuse(code, message);
    }
    return value;
  }

  function cleanDemoSeed(ctx, value) {
    if (value === undefined || value === null || value === "") {
      return deriveSeed(ctx.secret, ctx.requestId);
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
      ctx.refuse("invalid_seed", "Seed must be a whole number between 1 and 2,147,483,647.");
    }
    return value;
  }

  function cleanGameId(ctx, value) {
    if (typeof value !== "string" || value.length < 3 || value.length > 128) {
      ctx.refuse("game_not_found", "Select a valid match.");
    }
    return value;
  }

  function cleanToken(ctx, value) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
      ctx.refuse("unauthorized_player", "Your player token is missing or invalid.");
    }
    return value;
  }

  function isFullyConnected(tileMap, startKey) {
    const visited = new Set([startKey]);
    const queue = [startKey];
    let head = 0;
    while (head < queue.length) {
      const key = queue[head++];
      const tile = tileMap.get(key);
      for (const dir of HEX_DIRECTIONS) {
        const nk = hexKey(tile.q + dir[0], tile.r + dir[1]);
        if (visited.has(nk)) continue;
        const neighbor = tileMap.get(nk);
        if (!neighbor || neighbor.terrain === "mountain") continue;
        visited.add(nk);
        queue.push(nk);
      }
    }
    let passable = 0;
    for (const tile of tileMap.values()) if (tile.terrain !== "mountain") passable += 1;
    return visited.size === passable;
  }

  function generateBalancedMap(seed, radius, p1Id, p2Id) {
    const rng = mulberry32(seed);
    const tiles = [];
    const tileMap = new Map();

    for (let q = -radius; q <= radius; q += 1) {
      const r1 = Math.max(-radius, -q - radius);
      const r2 = Math.min(radius, -q + radius);
      for (let r = r1; r <= r2; r += 1) {
        const tile = {
          q,
          r,
          terrain: "plains",
          ownerSeat: null,
          ownerPlayerId: null,
          units: 0,
          fortified: 0,
        };
        tiles.push(tile);
        tileMap.set(hexKey(q, r), tile);
      }
    }

    const p1Cap = tileMap.get(hexKey(-radius, 0));
    const p2Cap = tileMap.get(hexKey(radius, 0));
    p1Cap.terrain = "capital";
    p1Cap.ownerSeat = 1;
    p1Cap.ownerPlayerId = p1Id;
    p1Cap.units = CAPITAL_START_UNITS;

    p2Cap.terrain = "capital";
    p2Cap.ownerSeat = 2;
    p2Cap.ownerPlayerId = p2Id;
    p2Cap.units = CAPITAL_START_UNITS;

    const p1Vanguard = tileMap.get(hexKey(-radius + 1, 0));
    const p2Vanguard = tileMap.get(hexKey(radius - 1, 0));
    p1Vanguard.terrain = "plains";
    p1Vanguard.ownerSeat = 1;
    p1Vanguard.ownerPlayerId = p1Id;
    p1Vanguard.units = VANGUARD_START_UNITS;

    p2Vanguard.terrain = "plains";
    p2Vanguard.ownerSeat = 2;
    p2Vanguard.ownerPlayerId = p2Id;
    p2Vanguard.units = VANGUARD_START_UNITS;

    const center = tileMap.get("0,0");
    center.terrain = "gold";
    center.units = GOLD_MINE_GARRISON;

    const protectedKeys = new Set([
      hexKey(-radius, 0),
      hexKey(radius, 0),
      hexKey(-radius + 1, 0),
      hexKey(radius - 1, 0),
      hexKey(-radius + 1, 1),
      hexKey(radius - 1, -1),
      hexKey(-radius, 1),
      hexKey(radius, -1),
      "0,0",
    ]);

    const halfPairs = [];
    const seen = new Set();
    for (const tile of tiles) {
      const k = hexKey(tile.q, tile.r);
      const mk = hexKey(-tile.q, -tile.r);
      if (protectedKeys.has(k) || protectedKeys.has(mk) || seen.has(k) || seen.has(mk)) continue;
      seen.add(k);
      seen.add(mk);
      halfPairs.push([tile, tileMap.get(mk)]);
    }

    for (let i = halfPairs.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = halfPairs[i];
      halfPairs[i] = halfPairs[j];
      halfPairs[j] = tmp;
    }

    let goldPairs = 0;
    let mountainPairs = 0;
    let forestPairs = 0;

    for (const pair of halfPairs) {
      const a = pair[0];
      const b = pair[1];
      if (goldPairs < 2 && hexDistance(a.q, a.r, 0, 0) >= 2) {
        a.terrain = "gold";
        a.units = GOLD_MINE_GARRISON;
        b.terrain = "gold";
        b.units = GOLD_MINE_GARRISON;
        goldPairs += 1;
      } else if (mountainPairs < 3) {
        a.terrain = "mountain";
        b.terrain = "mountain";
        if (isFullyConnected(tileMap, hexKey(-radius, 0))) {
          mountainPairs += 1;
        } else {
          a.terrain = "plains";
          b.terrain = "plains";
        }
      } else if (forestPairs < 4) {
        a.terrain = "forest";
        b.terrain = "forest";
        forestPairs += 1;
      }
    }

    return tiles;
  }

  function batchInsertTiles(ctx, gameId, tiles) {
    const chunkSize = 14;
    for (let start = 0; start < tiles.length; start += chunkSize) {
      const chunk = tiles.slice(start, start + chunkSize);
      const placeholders = [];
      const params = [];
      for (const tile of chunk) {
        placeholders.push("(?,?,?,?,?,?,?,?)");
        params.push(
          gameId + ":" + hexKey(tile.q, tile.r),
          gameId,
          tile.q,
          tile.r,
          tile.terrain,
          tile.ownerPlayerId,
          tile.units,
          tile.fortified,
        );
      }
      ctx.db.execute(
        "INSERT INTO hex_tiles(id,game_id,q,r,terrain,owner_player_id,units,fortified) VALUES " +
          placeholders.join(","),
        params,
      );
    }
  }

  function allocateJoinCode(ctx) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = deriveJoinCode(ctx.secret, ctx.requestId + ":" + attempt);
      const exists = ctx.db.query("SELECT id FROM games WHERE join_code = ?", [code])[0];
      if (!exists) return code;
    }
    ctx.refuse("join_code_exhausted", "Could not allocate a unique join code. Try again.");
  }

  function serializeInitialTiles(tiles) {
    return JSON.stringify(
      tiles.map((t) => ({
        q: t.q,
        r: t.r,
        terrain: t.terrain,
        ownerSeat: t.ownerSeat,
        units: t.units,
        fortified: Boolean(t.fortified),
      })),
    );
  }

  function formatPlayerPublic(row, gameTiles, viewerSeat, fullVisibility) {
    const shown = fullVisibility || row.seat === viewerSeat;
    let tileCount = 0;
    let unitCount = 0;
    if (shown) {
      for (const tile of gameTiles) {
        if (tile.owner_player_id !== row.id) continue;
        tileCount += 1;
        unitCount += tile.units;
      }
    }
    return {
      id: row.id,
      seat: row.seat,
      name: row.name,
      color: row.color,
      gold: shown ? row.gold : null,
      tileCount: shown ? tileCount : null,
      unitCount: shown ? unitCount : null,
    };
  }

  function computeVisibleSet(tiles, viewerPlayerId) {
    const owned = tiles.filter((t) => t.owner_player_id === viewerPlayerId);
    const visibleKeys = new Set();
    for (const tile of tiles) {
      for (const anchor of owned) {
        if (hexDistance(anchor.q, anchor.r, tile.q, tile.r) <= VISION_RANGE) {
          visibleKeys.add(hexKey(tile.q, tile.r));
          break;
        }
      }
    }
    return visibleKeys;
  }

  function opponentVision(ctx, gameId, opponentId) {
    const tiles = ctx.db.query("SELECT q,r,owner_player_id FROM hex_tiles WHERE game_id = ?", [gameId]);
    return computeVisibleSet(tiles, opponentId);
  }

  function stripLiveOutcome(outcome, fullVisibility) {
    if (!outcome || typeof outcome !== "object") return outcome;
    const { opponentSaw: _opponentSaw, ...shared } = outcome;
    if (fullVisibility) return shared;
    const { supply: _supply, ...publicOutcome } = shared;
    return publicOutcome;
  }

  function buildVisibleState(ctx, game, viewerPlayer, fullVisibility) {
    const players = ctx.db.query(
      "SELECT id,seat,name,color,gold FROM players WHERE game_id = ? ORDER BY seat ASC",
      [game.id],
    );
    const seatByPlayerId = new Map();
    const nameByPlayerId = new Map();
    for (const p of players) {
      seatByPlayerId.set(p.id, p.seat);
      nameByPlayerId.set(p.id, p.name);
    }

    const tiles = ctx.db.query(
      "SELECT q,r,terrain,owner_player_id,units,fortified FROM hex_tiles WHERE game_id = ? ORDER BY r ASC, q ASC",
      [game.id],
    );

    const visibleKeys = fullVisibility
      ? null
      : computeVisibleSet(tiles, viewerPlayer ? viewerPlayer.id : null);

    let visibleCount = 0;
    let foggedCount = 0;

    const projectedTiles = tiles.map((tile) => {
      const key = hexKey(tile.q, tile.r);
      const visible = fullVisibility || visibleKeys.has(key);
      if (visible) {
        visibleCount += 1;
        return {
          q: tile.q,
          r: tile.r,
          visible: true,
          terrain: tile.terrain,
          ownerSeat: tile.owner_player_id ? (seatByPlayerId.get(tile.owner_player_id) ?? null) : null,
          units: tile.units,
          fortified: tile.fortified === 1,
        };
      }
      foggedCount += 1;
      return {
        q: tile.q,
        r: tile.r,
        visible: false,
        terrain: null,
        ownerSeat: null,
        units: null,
        fortified: false,
      };
    });

    const moveRows = ctx.db.query(
      "SELECT turn_number,actor_player_id,action_type,from_hex,to_hex,units_moved,combat_outcome_json,created_at_ms FROM moves WHERE game_id = ? ORDER BY turn_number DESC LIMIT 20",
      [game.id],
    );

    const terrainByKey = new Map(tiles.map((tile) => [hexKey(tile.q, tile.r), tile.terrain]));
    const viewerSeat = viewerPlayer ? viewerPlayer.seat : null;
    const recentMoves = moveRows.map((row) => {
      const actorSeat = seatByPlayerId.get(row.actor_player_id) ?? null;
      const actorName = nameByPlayerId.get(row.actor_player_id) ?? "The enemy";
      const parsed = JSON.parse(row.combat_outcome_json);
      const saw = viewerSeat !== null ? parsed.opponentSaw : null;
      const fromVisible = Boolean(saw && saw.from);
      const toVisible = Boolean(saw && saw.to);
      const isOwnMove = viewerSeat !== null && actorSeat === viewerSeat;
      if (fullVisibility || isOwnMove || row.action_type === "resign") {
        return {
          turnNumber: row.turn_number,
          actorSeat,
          actionType: row.action_type,
          fromHex: row.from_hex,
          toHex: row.to_hex,
          unitsMoved: row.units_moved,
          outcome: stripLiveOutcome(parsed, fullVisibility),
          hidden: false,
          createdAtMs: row.created_at_ms,
        };
      }
      if (fromVisible || toVisible) {
        let safeSummary;
        if (row.action_type === "fortify" && fromVisible) {
          safeSummary = parsed.summary;
        } else if (row.action_type === "reinforce" && fromVisible) {
          safeSummary = parsed.summary;
        } else if (fromVisible && toVisible) {
          safeSummary = parsed.summary;
        } else if (toVisible) {
          const place = placeName(terrainByKey.get(row.to_hex));
          safeSummary =
            actorName +
            (parsed.kind === "transfer" ? " moved into " : parsed.claimed ? " claimed " : parsed.captured ? " captured " : " attacked ") +
            place +
            ".";
        } else {
          safeSummary = actorName + " left " + placeName(terrainByKey.get(row.from_hex)) + ".";
        }
        const safeOutcome = toVisible
          ? {
              kind: parsed.kind,
              captured: parsed.captured ?? false,
              claimed: parsed.claimed ?? false,
              capitalCaptured: parsed.capitalCaptured ?? false,
              summary: safeSummary,
            }
          : { summary: safeSummary };
        return {
          turnNumber: row.turn_number,
          actorSeat,
          actionType: row.action_type,
          fromHex: fromVisible ? row.from_hex : null,
          toHex: toVisible ? row.to_hex : null,
          unitsMoved: toVisible || (row.action_type === "reinforce" && fromVisible) ? row.units_moved : null,
          outcome: safeOutcome,
          hidden: false,
          createdAtMs: row.created_at_ms,
        };
      }
      return {
        turnNumber: row.turn_number,
        actorSeat,
        actionType: "hidden",
        fromHex: null,
        toHex: null,
        unitsMoved: null,
        outcome: { summary: "Activity in fog of war" },
        hidden: true,
        createdAtMs: row.created_at_ms,
      };
    });

    const winnerSeat = game.winner_player_id ? (seatByPlayerId.get(game.winner_player_id) ?? null) : null;

    return {
      game: {
        id: game.id,
        joinCode: viewerPlayer !== null ? game.join_code : null,
        title: game.title,
        seed: fullVisibility ? game.seed : null,
        radius: game.radius,
        status: game.status,
        turnNumber: game.turn_number,
        activeSeat: game.active_seat,
        winnerSeat,
        winReason: game.win_reason,
        createdAtMs: game.created_at_ms,
        updatedAtMs: game.updated_at_ms,
      },
      viewer: {
        seat: viewerSeat,
        spectator: fullVisibility && viewerSeat === null,
        visionRange: VISION_RANGE,
        visibleTiles: visibleCount,
        foggedTiles: foggedCount,
      },
      players: players.map((row) =>
        formatPlayerPublic(row, tiles, viewerSeat, fullVisibility),
      ),
      tiles: projectedTiles,
      recentMoves,
    };
  }

  function canSeeWholeBoard(ctx, game, playerTokens) {
    if (game.status === "finished") return true;
    if (!Array.isArray(playerTokens) || playerTokens.length !== 2) return false;
    const held = ctx.db.query("SELECT seat FROM players WHERE game_id = ? AND player_token IN (?, ?)", [
      game.id,
      cleanToken(ctx, playerTokens[0]),
      cleanToken(ctx, playerTokens[1]),
    ]);
    return held.length === 2;
  }

  function listGames(ctx) {
    const games = ctx.db.query(
      "SELECT id,title,seed,radius,status,turn_number,active_seat,winner_player_id,win_reason,created_at_ms,updated_at_ms FROM games ORDER BY updated_at_ms DESC, id DESC LIMIT 30",
    );
    if (games.length === 0) return { games: [] };
    const gameIds = games.map((g) => g.id);
    const placeholders = gameIds.map(() => "?").join(",");
    const players = ctx.db.query(
      "SELECT id,game_id,seat,name,color FROM players WHERE game_id IN (" +
        placeholders +
        ") ORDER BY game_id, seat ASC",
      gameIds,
    );
    const byGame = new Map();
    const seatByPlayerId = new Map();
    for (const p of players) {
      seatByPlayerId.set(p.id, p.seat);
      const list = byGame.get(p.game_id) ?? [];
      list.push({ seat: p.seat, name: p.name, color: p.color });
      byGame.set(p.game_id, list);
    }
    return {
      games: games.map((g) => {
        const list = byGame.get(g.id) ?? [];
        return {
          id: g.id,
          title: g.title,
          seed: g.status === "finished" ? g.seed : null,
          radius: g.radius,
          status: g.status,
          turnNumber: g.turn_number,
          activeSeat: g.active_seat,
          playerCount: list.length,
          players: list,
          winnerSeat: g.winner_player_id ? (seatByPlayerId.get(g.winner_player_id) ?? null) : null,
          winReason: g.win_reason,
          createdAtMs: g.created_at_ms,
          updatedAtMs: g.updated_at_ms,
        };
      }),
    };
  }

  function createGame(ctx, input) {
    const payload = expectObject(ctx, input);
    const playerName = cleanName(ctx, payload.playerName, "Crimson");
    const title = cleanTitle(ctx, payload.title, playerName + " match");
    const seed = deriveSeed(ctx.secret, ctx.requestId);
    const gameId = "g_" + ctx.requestId;
    const p1Id = "p1_" + gameId;
    const joinCode = allocateJoinCode(ctx);
    const p1Token = deriveToken(ctx.secret, "seat1:" + gameId);

    const tiles = generateBalancedMap(seed, MAP_RADIUS, p1Id, null);
    const initialTilesJson = serializeInitialTiles(tiles);

    ctx.db.execute(
      "INSERT INTO games(id,join_code,title,seed,radius,status,turn_number,active_seat,winner_player_id,win_reason,initial_tiles_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,'waiting',1,1,NULL,NULL,?,?,?)",
      [gameId, joinCode, title, seed, MAP_RADIUS, initialTilesJson, ctx.nowMs, ctx.nowMs],
    );
    ctx.db.execute(
      "INSERT INTO players(id,game_id,seat,name,color,player_token,gold,joined_at_ms) VALUES(?,?,1,?,'crimson',?,?,?)",
      [p1Id, gameId, playerName, p1Token, STARTING_GOLD, ctx.nowMs],
    );
    batchInsertTiles(ctx, gameId, tiles);

    return {
      gameId,
      joinCode,
      seat: 1,
      playerId: p1Id,
      playerName,
      playerToken: p1Token,
    };
  }

  function joinGame(ctx, input) {
    const payload = expectObject(ctx, input);
    const rawCode = typeof payload.joinCode === "string" ? payload.joinCode.trim().toUpperCase() : "";
    if (!/^[A-Z0-9]{6}$/.test(rawCode)) {
      ctx.refuse("invalid_join_code", "Enter a 6-character join code.");
    }
    const playerName = cleanName(ctx, payload.playerName, "Cobalt");
    const game = ctx.db.query("SELECT * FROM games WHERE join_code = ?", [rawCode])[0];
    if (!game) {
      ctx.refuse("game_not_found", "No match exists for that join code.");
    }
    if (game.status !== "waiting") {
      ctx.refuse("game_full", "This match already has two players.");
    }
    const existingSeat2 = ctx.db.query(
      "SELECT id FROM players WHERE game_id = ? AND seat = 2",
      [game.id],
    )[0];
    if (existingSeat2) {
      ctx.refuse("game_full", "Seat 2 is already taken.");
    }

    const p2Id = "p2_" + game.id;
    const p2Token = deriveToken(ctx.secret, "seat2:" + game.id);

    ctx.db.execute(
      "INSERT INTO players(id,game_id,seat,name,color,player_token,gold,joined_at_ms) VALUES(?,?,2,?,'cobalt',?,?,?)",
      [p2Id, game.id, playerName, p2Token, STARTING_GOLD, ctx.nowMs],
    );
    ctx.db.execute(
      "UPDATE hex_tiles SET owner_player_id = ? WHERE game_id = ? AND ((q = ? AND r = 0) OR (q = ? AND r = 0))",
      [p2Id, game.id, game.radius, game.radius - 1],
    );
    ctx.db.execute(
      "UPDATE games SET status = 'active', updated_at_ms = ? WHERE id = ? AND status = 'waiting'",
      [ctx.nowMs, game.id],
    );

    return {
      gameId: game.id,
      joinCode: game.join_code,
      seat: 2,
      playerId: p2Id,
      playerName,
      playerToken: p2Token,
    };
  }

  function startDemoMatch(ctx, input) {
    const payload = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const p1Name = cleanName(ctx, payload.player1Name, "Crimson");
    const p2Name = cleanName(ctx, payload.player2Name, "Cobalt");
    const rawFallbackTitle = p1Name + " vs " + p2Name;
    const fallbackTitle =
      rawFallbackTitle.length <= 64 ? rawFallbackTitle : rawFallbackTitle.slice(0, 64).trimEnd();
    const title = cleanTitle(ctx, payload.title, fallbackTitle);
    const seed = cleanDemoSeed(ctx, payload.seed);
    const gameId = "g_" + ctx.requestId;
    const p1Id = "p1_" + gameId;
    const p2Id = "p2_" + gameId;
    const joinCode = allocateJoinCode(ctx);
    const p1Token = deriveToken(ctx.secret, "demo1:" + gameId);
    const p2Token = deriveToken(ctx.secret, "demo2:" + gameId);

    const tiles = generateBalancedMap(seed, MAP_RADIUS, p1Id, p2Id);
    const initialTilesJson = serializeInitialTiles(tiles);

    ctx.db.execute(
      "INSERT INTO games(id,join_code,title,seed,radius,status,turn_number,active_seat,winner_player_id,win_reason,initial_tiles_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,'active',1,1,NULL,NULL,?,?,?)",
      [gameId, joinCode, title, seed, MAP_RADIUS, initialTilesJson, ctx.nowMs, ctx.nowMs],
    );
    ctx.db.execute(
      "INSERT INTO players(id,game_id,seat,name,color,player_token,gold,joined_at_ms) VALUES(?,?,1,?,'crimson',?,?,?),(?,?,2,?,'cobalt',?,?,?)",
      [
        p1Id,
        gameId,
        p1Name,
        p1Token,
        STARTING_GOLD,
        ctx.nowMs,
        p2Id,
        gameId,
        p2Name,
        p2Token,
        STARTING_GOLD,
        ctx.nowMs,
      ],
    );
    batchInsertTiles(ctx, gameId, tiles);

    return {
      gameId,
      joinCode,
      title,
      seats: [
        { seat: 1, playerId: p1Id, name: p1Name, color: "crimson", playerToken: p1Token },
        { seat: 2, playerId: p2Id, name: p2Name, color: "cobalt", playerToken: p2Token },
      ],
    };
  }

  function gameById(ctx, gameId) {
    return ctx.db.query("SELECT * FROM games WHERE id = ?", [gameId])[0];
  }

  function playerByToken(ctx, gameId, token) {
    return ctx.db.query("SELECT id,seat,name,color,gold FROM players WHERE game_id = ? AND player_token = ?", [gameId, token])[0];
  }

  function tileAt(ctx, gameId, q, r) {
    return ctx.db.query(
      "SELECT id,q,r,terrain,owner_player_id,units,fortified FROM hex_tiles WHERE game_id = ? AND q = ? AND r = ?",
      [gameId, q, r],
    )[0];
  }

  function getVisibleState(ctx, input) {
    const payload = expectObject(ctx, input);
    const gameId = cleanGameId(ctx, payload.gameId);
    const game = gameById(ctx, gameId);
    if (!game) {
      ctx.refuse("game_not_found", "Match not found.");
    }

    if (payload.spectator === true) {
      if (!canSeeWholeBoard(ctx, game, payload.playerTokens)) {
        ctx.refuse("spectator_forbidden", "The whole board opens when the match ends, or to someone holding both seat keys.");
      }
      return buildVisibleState(ctx, game, null, true);
    }

    const token = cleanToken(ctx, payload.playerToken);
    const player = playerByToken(ctx, game.id, token);
    if (!player) {
      ctx.refuse("unauthorized_player", "That player token does not belong to this match.");
    }
    return buildVisibleState(ctx, game, player, game.status === "finished");
  }

  function applyTurnSupply(ctx, gameId, nextPlayer) {
    const ownedTiles = ctx.db.query(
      "SELECT q,r,terrain FROM hex_tiles WHERE game_id = ? AND owner_player_id = ? AND terrain IN ('capital', 'gold') ORDER BY r ASC, q ASC",
      [gameId, nextPlayer.id],
    );
    let goldAdded = BASE_GOLD_INCOME;
    const supplyUpdates = [];
    for (const tile of ownedTiles) {
      if (tile.terrain === "gold") goldAdded += GOLD_MINE_INCOME;
      supplyUpdates.push({ q: tile.q, r: tile.r, addedUnits: 1 });
    }
    ctx.db.execute(
      "UPDATE hex_tiles SET units = units + 1 WHERE game_id = ? AND owner_player_id = ? AND terrain IN ('capital', 'gold')",
      [gameId, nextPlayer.id],
    );
    ctx.db.execute("UPDATE players SET gold = gold + ? WHERE id = ?", [goldAdded, nextPlayer.id]);
    return { nextSeat: nextPlayer.seat, goldAdded, supplyUpdates };
  }

  function submitMove(ctx, input) {
    const payload = expectObject(ctx, input);
    const gameId = cleanGameId(ctx, payload.gameId);
    const token = cleanToken(ctx, payload.playerToken);
    const actionType = payload.actionType;

    if (!["march", "fortify", "reinforce", "pass", "resign"].includes(actionType)) {
      ctx.refuse("invalid_action", "Choose march, fortify, reinforce, pass, or resign.");
    }

    const game = gameById(ctx, gameId);
    if (!game) {
      ctx.refuse("game_not_found", "Match not found.");
    }
    if (game.status !== "active") {
      ctx.refuse(
        "game_not_active",
        game.status === "waiting"
          ? "Waiting for Seat 2 to join before turns begin."
          : "This match has already finished.",
      );
    }

    const player = playerByToken(ctx, game.id, token);
    if (!player) {
      ctx.refuse("unauthorized_player", "That player token does not belong to this match.");
    }

    const opponent = ctx.db.query(
      "SELECT id,seat,name,color,gold FROM players WHERE game_id = ? AND seat != ?",
      [game.id, player.seat],
    )[0];
    if (!opponent) {
      ctx.refuse("game_not_active", "Waiting for an opponent to join.");
    }

    if (actionType !== "resign" && player.seat !== game.active_seat) {
      ctx.refuse("not_your_turn", "Wait for your turn before submitting a move.");
    }
    if (actionType !== "resign" && payload.expectedTurn !== undefined) {
      const expectedTurn = expectSafeInt(
        ctx,
        payload.expectedTurn,
        "invalid_turn",
        "expectedTurn must be a positive integer.",
      );
      if (expectedTurn < 1) {
        ctx.refuse("invalid_turn", "expectedTurn must be a positive integer.");
      }
      if (expectedTurn !== game.turn_number) {
        ctx.refuse(
          "stale_turn",
          "Board advanced to turn " + game.turn_number + ". Refresh before acting.",
        );
      }
    }

    const opponentSees = actionType === "pass" || actionType === "resign" ? new Set() : opponentVision(ctx, game.id, opponent.id);
    let fromHex = null;
    let toHex = null;
    let unitsMoved = 0;
    let winnerPlayerId = null;
    let winReason = null;
    let outcome = {};

    if (actionType === "resign") {
      winnerPlayerId = opponent.id;
      winReason = "resignation";
      outcome = {
        action: "resign",
        summary: player.name + " resigned. " + opponent.name + " wins.",
      };
    } else if (actionType === "pass") {
      outcome = {
        action: "pass",
        summary: player.name + " held position.",
      };
    } else if (actionType === "fortify") {
      const fq = expectSafeInt(ctx, payload.fromQ, "invalid_hex", "Choose a valid hex to fortify.");
      const fr = expectSafeInt(ctx, payload.fromR, "invalid_hex", "Choose a valid hex to fortify.");
      const tile = tileAt(ctx, game.id, fq, fr);
      if (!tile) ctx.refuse("invalid_hex", "That hex is outside the board.");
      if (tile.owner_player_id !== player.id) {
        ctx.refuse("not_tile_owner", "You can only fortify a hex you control.");
      }
      if (tile.fortified === 1) {
        ctx.refuse("already_fortified", "That hex is already fortified.");
      }
      if (player.gold < FORTIFY_COST) {
        ctx.refuse(
          "insufficient_gold",
          "Fortifying costs " + FORTIFY_COST + " gold. You have " + player.gold + ".",
        );
      }
      ctx.db.execute("UPDATE players SET gold = gold - ? WHERE id = ?", [FORTIFY_COST, player.id]);
      ctx.db.execute("UPDATE hex_tiles SET fortified = 1 WHERE id = ?", [tile.id]);
      fromHex = hexKey(fq, fr);
      outcome = {
        action: "fortify",
        goldSpent: FORTIFY_COST,
        summary: player.name + " fortified " + placeName(tile.terrain) + ".",
      };
    } else if (actionType === "reinforce") {
      const fq = expectSafeInt(ctx, payload.fromQ, "invalid_hex", "Choose a valid hex to reinforce.");
      const fr = expectSafeInt(ctx, payload.fromR, "invalid_hex", "Choose a valid hex to reinforce.");
      const count = expectSafeInt(
        ctx,
        payload.units,
        "invalid_units",
        "Deploy between 1 and " + MAX_REINFORCE_PER_TURN + " units per turn.",
      );
      if (count < 1 || count > MAX_REINFORCE_PER_TURN) {
        ctx.refuse(
          "invalid_units",
          "Deploy between 1 and " + MAX_REINFORCE_PER_TURN + " units per turn.",
        );
      }
      const tile = tileAt(ctx, game.id, fq, fr);
      if (!tile) ctx.refuse("invalid_hex", "That hex is outside the board.");
      if (tile.owner_player_id !== player.id) {
        ctx.refuse("not_tile_owner", "You can only reinforce a hex you control.");
      }
      const totalCost = count * REINFORCE_UNIT_COST;
      if (player.gold < totalCost) {
        ctx.refuse(
          "insufficient_gold",
          "Recruiting " +
            countOf(count, "unit", "units") +
            " costs " +
            totalCost +
            " gold. You have " +
            player.gold +
            ".",
        );
      }
      ctx.db.execute("UPDATE players SET gold = gold - ? WHERE id = ?", [totalCost, player.id]);
      ctx.db.execute("UPDATE hex_tiles SET units = units + ? WHERE id = ?", [count, tile.id]);
      fromHex = hexKey(fq, fr);
      unitsMoved = count;
      outcome = {
        action: "reinforce",
        goldSpent: totalCost,
        unitsAdded: count,
        summary:
          player.name + " recruited " + countOf(count, "unit", "units") + " for " + placeName(tile.terrain) + ".",
      };
    } else if (actionType === "march") {
      const fq = expectSafeInt(ctx, payload.fromQ, "invalid_hex", "Select valid origin and destination hexes.");
      const fr = expectSafeInt(ctx, payload.fromR, "invalid_hex", "Select valid origin and destination hexes.");
      const tq = expectSafeInt(ctx, payload.toQ, "invalid_hex", "Select valid origin and destination hexes.");
      const tr = expectSafeInt(ctx, payload.toR, "invalid_hex", "Select valid origin and destination hexes.");
      const units = expectSafeInt(ctx, payload.units, "insufficient_units", "Move at least 1 unit.");

      if (hexDistance(fq, fr, tq, tr) !== 1) {
        ctx.refuse("not_adjacent", "Units can only march to an adjacent hex (distance 1).");
      }

      const fromTile = tileAt(ctx, game.id, fq, fr);
      const toTile = tileAt(ctx, game.id, tq, tr);
      if (!fromTile || !toTile) {
        ctx.refuse("invalid_hex", "One of the chosen hexes is outside the board.");
      }
      if (fromTile.owner_player_id !== player.id) {
        ctx.refuse("not_tile_owner", "You can only march units from a hex you control.");
      }
      if (toTile.terrain === "mountain") {
        ctx.refuse("impassable_terrain", "Mountains cannot be crossed.");
      }
      if (units < 1) {
        ctx.refuse("insufficient_units", "Move at least 1 unit.");
      }
      if (fromTile.units <= 1 || units > fromTile.units - 1) {
        ctx.refuse(
          "insufficient_units",
          "Leave at least 1 unit behind to hold the hex you are leaving.",
        );
      }

      fromHex = hexKey(fq, fr);
      toHex = hexKey(tq, tr);
      unitsMoved = units;

      ctx.db.execute("UPDATE hex_tiles SET units = units - ? WHERE id = ?", [units, fromTile.id]);

      if (toTile.owner_player_id === player.id) {
        ctx.db.execute("UPDATE hex_tiles SET units = units + ? WHERE id = ?", [units, toTile.id]);
        outcome = {
          action: "march",
          kind: "transfer",
          attackerUnits: units,
          defenderUnits: toTile.units,
          attackerLosses: 0,
          defenderLosses: 0,
          captured: false,
          capitalCaptured: false,
          newToUnits: toTile.units + units,
          newToFortified: toTile.fortified === 1,
          summary:
            player.name + " moved " + countOf(units, "unit", "units") + " to " + placeName(toTile.terrain) + ".",
        };
      } else {
        const defenderUnits = toTile.units;
        const terrainBonus =
          defenderUnits > 0
            ? toTile.terrain === "capital"
              ? 2
              : toTile.terrain === "forest"
                ? 1
                : 0
            : 0;
        const fortifyBonus = defenderUnits > 0 && toTile.fortified === 1 ? 2 : 0;
        const defensePower = defenderUnits + terrainBonus + fortifyBonus;
        const wasEnemyCapital =
          toTile.terrain === "capital" && toTile.owner_player_id === opponent.id;
        const claimed = defenderUnits === 0 && toTile.owner_player_id === null;

        if (units > defensePower) {
          const attackerLosses =
            defenderUnits === 0 ? 0 : Math.min(units - 1, Math.ceil(defensePower * 0.6));
          const survivors = units - attackerLosses;
          ctx.db.execute(
            "UPDATE hex_tiles SET owner_player_id = ?, units = ?, fortified = 0 WHERE id = ?",
            [player.id, survivors, toTile.id],
          );
          if (wasEnemyCapital) {
            winnerPlayerId = player.id;
            winReason = "capital_captured";
          }
          outcome = {
            action: "march",
            kind: "combat",
            attackerUnits: units,
            defenderUnits,
            terrainBonus,
            fortifyBonus,
            defensePower,
            attackerLosses,
            defenderLosses: defenderUnits,
            captured: true,
            claimed,
            capitalCaptured: wasEnemyCapital,
            newToUnits: survivors,
            newToFortified: false,
            summary: wasEnemyCapital
              ? player.name + " captured the enemy capital."
              : player.name +
                (claimed ? " claimed " : " captured ") +
                placeName(toTile.terrain) +
                " and holds it with " +
                countOf(survivors, "unit", "units") +
                ".",
          };
        } else {
          const effectiveDamage = Math.max(
            0,
            units - Math.floor((terrainBonus + fortifyBonus) / 2),
          );
          const defenderLosses = Math.min(defenderUnits, Math.floor(effectiveDamage * 0.6));
          const remainingDefender = Math.max(0, defenderUnits - defenderLosses);
          const nextFortified = toTile.fortified === 1 && defenderLosses === 0 ? 1 : 0;
          ctx.db.execute("UPDATE hex_tiles SET units = ?, fortified = ? WHERE id = ?", [
            remainingDefender,
            nextFortified,
            toTile.id,
          ]);
          outcome = {
            action: "march",
            kind: "combat",
            attackerUnits: units,
            defenderUnits,
            terrainBonus,
            fortifyBonus,
            defensePower,
            attackerLosses: units,
            defenderLosses,
            captured: false,
            capitalCaptured: false,
            newToUnits: remainingDefender,
            newToFortified: nextFortified === 1,
            summary:
              player.name +
              "'s attack on " +
              placeName(toTile.terrain) +
              " was repelled. " +
              (remainingDefender === 0
                ? "No defenders are left, but the hex holds."
                : countOf(remainingDefender, "defender holds.", "defenders hold.")),
          };
        }
      }
    }

    let supply = null;
    const nextStatus = winnerPlayerId ? "finished" : "active";
    const nextTurnNumber = winnerPlayerId ? game.turn_number : game.turn_number + 1;
    const nextActiveSeat = winnerPlayerId ? game.active_seat : opponent.seat;

    if (!winnerPlayerId) {
      supply = applyTurnSupply(ctx, game.id, opponent);
    }

    const sawHex = (key) => Boolean(key && opponentSees.has(key));
    const storedOutcome = Object.assign({}, outcome, winnerPlayerId ? {} : { supply }, {
      opponentSaw: { from: sawHex(fromHex), to: sawHex(toHex) },
    });

    ctx.db.execute(
      "INSERT INTO moves(id,game_id,turn_number,actor_player_id,action_type,from_hex,to_hex,units_moved,combat_outcome_json,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [
        game.id + ":t" + game.turn_number,
        game.id,
        game.turn_number,
        player.id,
        actionType,
        fromHex,
        toHex,
        unitsMoved,
        JSON.stringify(storedOutcome),
        ctx.nowMs,
      ],
    );

    ctx.db.execute(
      "UPDATE games SET status = ?, turn_number = ?, active_seat = ?, winner_player_id = ?, win_reason = ?, updated_at_ms = ? WHERE id = ?",
      [
        nextStatus,
        nextTurnNumber,
        nextActiveSeat,
        winnerPlayerId,
        winReason,
        ctx.nowMs,
        game.id,
      ],
    );

    const updatedGame = gameById(ctx, game.id);
    const state = buildVisibleState(ctx, updatedGame, player, updatedGame.status === "finished");
    return {
      turnExecuted: game.turn_number,
      outcome: stripLiveOutcome(outcome, updatedGame.status === "finished"),
      state,
    };
  }

  function replayGame(ctx, input) {
    const payload = expectObject(ctx, input);
    const gameId = cleanGameId(ctx, payload.gameId);
    const afterTurn =
      payload.afterTurn === undefined
        ? 0
        : expectSafeInt(ctx, payload.afterTurn, "invalid_input", "afterTurn must be a non-negative integer.");
    if (afterTurn < 0) {
      ctx.refuse("invalid_input", "afterTurn must be a non-negative integer.");
    }
    const limit =
      payload.limit === undefined
        ? 200
        : expectSafeInt(ctx, payload.limit, "invalid_input", "limit must be between 1 and 200.");
    if (limit < 1 || limit > 200) {
      ctx.refuse("invalid_input", "limit must be between 1 and 200.");
    }
    const game = gameById(ctx, gameId);
    if (!game) {
      ctx.refuse("game_not_found", "Match not found.");
    }
    if (!canSeeWholeBoard(ctx, game, payload.playerTokens)) {
      ctx.refuse("replay_unavailable", "Full replay opens when the match ends, or to someone holding both seat keys.");
    }

    const players = ctx.db.query(
      "SELECT id,seat,name,color,gold FROM players WHERE game_id = ? ORDER BY seat ASC",
      [game.id],
    );
    const seatByPlayerId = new Map();
    for (const p of players) seatByPlayerId.set(p.id, p.seat);

    const moveRows = ctx.db.query(
      "SELECT turn_number,actor_player_id,action_type,from_hex,to_hex,units_moved,combat_outcome_json,created_at_ms FROM moves WHERE game_id = ? AND turn_number > ? ORDER BY turn_number ASC LIMIT ?",
      [game.id, afterTurn, limit + 1],
    );
    const hasMore = moveRows.length > limit;
    const pageRows = hasMore ? moveRows.slice(0, limit) : moveRows;
    const nextAfterTurn = hasMore ? pageRows[pageRows.length - 1].turn_number : null;

    return {
      game: {
        id: game.id,
        title: game.title,
        seed: game.seed,
        radius: game.radius,
        status: game.status,
        turnNumber: game.turn_number,
        activeSeat: game.active_seat,
        winnerSeat: game.winner_player_id ? (seatByPlayerId.get(game.winner_player_id) ?? null) : null,
        winReason: game.win_reason,
        createdAtMs: game.created_at_ms,
        updatedAtMs: game.updated_at_ms,
      },
      startingGold: STARTING_GOLD,
      players: players.map((p) => ({
        seat: p.seat,
        name: p.name,
        color: p.color,
        finalGold: p.gold,
      })),
      initialTiles: JSON.parse(game.initial_tiles_json),
      moves: pageRows.map((row) => ({
        turnNumber: row.turn_number,
        actorSeat: seatByPlayerId.get(row.actor_player_id) ?? null,
        actionType: row.action_type,
        fromHex: row.from_hex,
        toHex: row.to_hex,
        unitsMoved: row.units_moved,
        outcome: stripLiveOutcome(JSON.parse(row.combat_outcome_json), true),
        createdAtMs: row.created_at_ms,
      })),
      nextAfterTurn,
    };
  }

  globalThis.operations = {
    listGames,
    createGame,
    joinGame,
    startDemoMatch,
    getVisibleState,
    submitMove,
    replayGame,
  };
})();
