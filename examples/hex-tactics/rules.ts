import type { MoveRecord, TerrainType, VisibleTile } from "./types";

type Seat = 1 | 2;

export function factionName(seat: Seat | null): string {
  return seat === 1 ? "Crimson" : seat === 2 ? "Cobalt" : "Neutral";
}

export function otherSeat(seat: Seat): Seat {
  return seat === 1 ? 2 : 1;
}

export function playerName(players: ReadonlyArray<{ readonly seat: Seat; readonly name: string }> | undefined, seat: Seat | null): string {
  return players?.find((player) => player.seat === seat)?.name ?? factionName(seat);
}

export const VISION_RANGE = 2;
export const FORTIFY_COST = 3;
export const REINFORCE_UNIT_COST = 2;
export const MAX_REINFORCE_PER_TURN = 5;
export const GOLD_MINE_GOLD = 2;

export const TERRAIN_INFO: Record<
  TerrainType,
  { readonly name: string; readonly defense: number; readonly income: string; readonly passable: boolean }
> = {
  plains: { name: "Plains", defense: 0, income: "None", passable: true },
  forest: { name: "Forest", defense: 1, income: "None", passable: true },
  mountain: { name: "Mountain", defense: 0, income: "None", passable: false },
  gold: { name: "Gold mine", defense: 0, income: `+${GOLD_MINE_GOLD}g, +1 unit`, passable: true },
  capital: { name: "Capital", defense: 2, income: "+1 unit", passable: true },
};

export interface MarchForecast {
  readonly kind: "transfer" | "capture" | "repelled";
  readonly attackerUnits: number;
  readonly defenderUnits: number;
  readonly terrainBonus: number;
  readonly fortifyBonus: number;
  readonly defensePower: number;
  readonly attackerLosses: number;
  readonly defenderLosses: number;
  readonly resultUnits: number;
  readonly resultFortified: boolean;
  readonly supplyNext: number;
  readonly heldYield: { readonly gold: number; readonly units: number } | null;
  readonly capitalCaptured: boolean;
}

export function isClaim(tile: Pick<VisibleTile, "ownerSeat" | "units">): boolean {
  return tile.ownerSeat === null && (tile.units ?? 0) === 0;
}

export function forecastMarch(
  attackerUnits: number,
  target: Pick<VisibleTile, "terrain" | "ownerSeat" | "units" | "fortified">,
  attackerSeat: 1 | 2,
): MarchForecast {
  const defenderUnits = target.units ?? 0;
  if (target.ownerSeat === attackerSeat) {
    return {
      kind: "transfer",
      attackerUnits,
      defenderUnits,
      terrainBonus: 0,
      fortifyBonus: 0,
      defensePower: 0,
      attackerLosses: 0,
      defenderLosses: 0,
      resultUnits: defenderUnits + attackerUnits,
      resultFortified: target.fortified,
      supplyNext: 0,
      heldYield: null,
      capitalCaptured: false,
    };
  }
  const terrainBonus =
    defenderUnits > 0 ? (target.terrain === "capital" ? 2 : target.terrain === "forest" ? 1 : 0) : 0;
  const fortifyBonus = defenderUnits > 0 && target.fortified ? 2 : 0;
  const defensePower = defenderUnits + terrainBonus + fortifyBonus;
  if (attackerUnits > defensePower) {
    const attackerLosses =
      defenderUnits === 0 ? 0 : Math.min(attackerUnits - 1, Math.ceil(defensePower * 0.6));
    return {
      kind: "capture",
      attackerUnits,
      defenderUnits,
      terrainBonus,
      fortifyBonus,
      defensePower,
      attackerLosses,
      defenderLosses: defenderUnits,
      resultUnits: attackerUnits - attackerLosses,
      resultFortified: false,
      supplyNext: 0,
      heldYield: target.terrain === "gold" ? { gold: GOLD_MINE_GOLD, units: 1 } : null,
      capitalCaptured: target.terrain === "capital" && target.ownerSeat !== null,
    };
  }
  const effectiveDamage = Math.max(0, attackerUnits - Math.floor((terrainBonus + fortifyBonus) / 2));
  const defenderLosses = Math.min(defenderUnits, Math.floor(effectiveDamage * 0.6));
  return {
    kind: "repelled",
    attackerUnits,
    defenderUnits,
    terrainBonus,
    fortifyBonus,
    defensePower,
    attackerLosses: attackerUnits,
    defenderLosses,
    resultUnits: defenderUnits - defenderLosses,
    resultFortified: target.fortified && defenderLosses === 0,
    supplyNext: target.ownerSeat !== null && (target.terrain === "capital" || target.terrain === "gold") ? 1 : 0,
    heldYield: null,
    capitalCaptured: false,
  };
}

export function forecastLabel(forecast: MarchForecast, claim: boolean): string {
  if (forecast.kind === "transfer") return `+${forecast.attackerUnits}`;
  if (claim) return "CLAIM";
  if (forecast.kind === "capture") return forecast.capitalCaptured ? "WIN" : "CAPTURE";
  return "REPELLED";
}

export function maxReinforce(gold: number): number {
  return Math.min(MAX_REINFORCE_PER_TURN, Math.floor(gold / REINFORCE_UNIT_COST));
}

export const MAX_PIPS = 10;

export function keptPips(units: number, loss: number): number {
  return Math.min(MAX_PIPS, units - Math.min(units, loss));
}

export function flashKindForMove(move: MoveRecord): "capture" | "hit" | "move" | "build" | null {
  if (move.hidden) return null;
  if (move.actionType === "march") {
    if (move.outcome.kind === "combat") return move.outcome.claimed ? "move" : move.outcome.captured ? "capture" : "hit";
    return "move";
  }
  if (move.actionType === "fortify" || move.actionType === "reinforce") return "build";
  return null;
}
