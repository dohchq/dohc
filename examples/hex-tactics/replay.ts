import { FORTIFY_COST, REINFORCE_UNIT_COST } from "./rules";
import type { MoveRecord, ReplayPayload, VisibleTile } from "./types";

export interface ReplayFrame {
  readonly stepIndex: number;
  readonly move: MoveRecord | null;
  readonly tiles: readonly VisibleTile[];
  readonly seat1Units: number;
  readonly seat2Units: number;
  readonly seat1Tiles: number;
  readonly seat2Tiles: number;
  readonly seat1Gold: number;
  readonly seat2Gold: number;
}

function snapshotTiles(
  map: Map<
    string,
    {
      q: number;
      r: number;
      terrain: VisibleTile["terrain"];
      ownerSeat: 1 | 2 | null;
      units: number;
      fortified: boolean;
    }
  >,
): { tiles: VisibleTile[]; seat1Units: number; seat2Units: number; seat1Tiles: number; seat2Tiles: number } {
  let seat1Units = 0;
  let seat2Units = 0;
  let seat1Tiles = 0;
  let seat2Tiles = 0;
  const tiles: VisibleTile[] = [];
  for (const tile of map.values()) {
    if (tile.ownerSeat === 1) {
      seat1Tiles += 1;
      seat1Units += tile.units;
    } else if (tile.ownerSeat === 2) {
      seat2Tiles += 1;
      seat2Units += tile.units;
    }
    tiles.push({
      q: tile.q,
      r: tile.r,
      visible: true,
      terrain: tile.terrain,
      ownerSeat: tile.ownerSeat,
      units: tile.units,
      fortified: tile.fortified,
    });
  }
  return { tiles, seat1Units, seat2Units, seat1Tiles, seat2Tiles };
}

export function reconstructReplayFrames(replay: ReplayPayload): ReplayFrame[] {
  const tileMap = new Map<
    string,
    {
      q: number;
      r: number;
      terrain: VisibleTile["terrain"];
      ownerSeat: 1 | 2 | null;
      units: number;
      fortified: boolean;
    }
  >();

  for (const tile of replay.initialTiles) {
    tileMap.set(`${tile.q},${tile.r}`, {
      q: tile.q,
      r: tile.r,
      terrain: tile.terrain,
      ownerSeat: tile.ownerSeat,
      units: tile.units,
      fortified: tile.fortified,
    });
  }

  let seat1Gold = replay.startingGold;
  let seat2Gold = replay.startingGold;

  const initial = snapshotTiles(tileMap);
  const frames: ReplayFrame[] = [
    {
      stepIndex: 0,
      move: null,
      ...initial,
      seat1Gold,
      seat2Gold,
    },
  ];

  for (const move of replay.moves) {
    const actor = move.actorSeat;
    const outcome = move.outcome;

    if (move.actionType === "fortify" && move.fromHex) {
      const tile = tileMap.get(move.fromHex);
      if (tile) tile.fortified = true;
      const spent = outcome.goldSpent ?? FORTIFY_COST;
      if (actor === 1) seat1Gold = Math.max(0, seat1Gold - spent);
      else if (actor === 2) seat2Gold = Math.max(0, seat2Gold - spent);
    } else if (move.actionType === "reinforce" && move.fromHex) {
      const tile = tileMap.get(move.fromHex);
      const added = outcome.unitsAdded ?? move.unitsMoved ?? 0;
      if (tile) tile.units += added;
      const spent = outcome.goldSpent ?? added * REINFORCE_UNIT_COST;
      if (actor === 1) seat1Gold = Math.max(0, seat1Gold - spent);
      else if (actor === 2) seat2Gold = Math.max(0, seat2Gold - spent);
    } else if (move.actionType === "march" && move.fromHex && move.toHex) {
      const fromTile = tileMap.get(move.fromHex);
      const toTile = tileMap.get(move.toHex);
      const moved = move.unitsMoved ?? 0;
      if (fromTile) fromTile.units = Math.max(0, fromTile.units - moved);
      if (toTile) {
        if (outcome.kind === "transfer") {
          toTile.units = outcome.newToUnits ?? toTile.units + moved;
        } else {
          if (outcome.captured && actor) {
            toTile.ownerSeat = actor;
          }
          if (typeof outcome.newToUnits === "number") {
            toTile.units = outcome.newToUnits;
          }
          if (typeof outcome.newToFortified === "boolean") {
            toTile.fortified = outcome.newToFortified;
          }
        }
      }
    }

    if (outcome.supply) {
      for (const delta of outcome.supply.supplyUpdates) {
        const target = tileMap.get(`${delta.q},${delta.r}`);
        if (target) target.units += delta.addedUnits;
      }
      if (outcome.supply.nextSeat === 1) seat1Gold += outcome.supply.goldAdded;
      else if (outcome.supply.nextSeat === 2) seat2Gold += outcome.supply.goldAdded;
    }

    const snap = snapshotTiles(tileMap);
    frames.push({
      stepIndex: frames.length,
      move,
      ...snap,
      seat1Gold,
      seat2Gold,
    });
  }

  return frames;
}
