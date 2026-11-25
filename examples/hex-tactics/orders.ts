import { axialDistance, hexKeyOf } from "./geometry";
import type { BoardForecast, TargetKind } from "./hex-board";
import { forecastLabel, forecastMarch, isClaim, type MarchForecast } from "./rules";
import { lockedTarget, type Selection } from "./selection";
import type { VisibleTile } from "./types";

export interface OrderInput {
  readonly tiles: readonly VisibleTile[];
  readonly tileByKey: ReadonlyMap<string, VisibleTile>;
  readonly selection: Selection;
  readonly viewerSeat: 1 | 2 | null;
  readonly canAct: boolean;
  readonly turnScope: string | null;
  readonly compact: boolean;
}

export interface Orders {
  readonly selectedTile: VisibleTile | null;
  readonly targets: ReadonlyMap<string, TargetKind>;
  readonly targetHex: string | null;
  readonly targetTile: VisibleTile | null;
  readonly maxMovable: number;
  readonly lockedUnits: number;
  readonly targetForecast: MarchForecast | null;
  readonly preview: { readonly tile: VisibleTile; readonly forecast: MarchForecast } | null;
  readonly boardForecast: BoardForecast | null;
}

function marchTargets(
  tiles: readonly VisibleTile[],
  from: VisibleTile | null,
  viewerSeat: 1 | 2 | null,
  canAct: boolean,
) {
  const targets = new Map<string, TargetKind>();
  if (!canAct || !from || from.ownerSeat !== viewerSeat || (from.units ?? 0) <= 1) return targets;
  for (const tile of tiles) {
    if (!tile.visible || tile.terrain === "mountain") continue;
    if (axialDistance(from.q, from.r, tile.q, tile.r) !== 1) continue;
    targets.set(
      hexKeyOf(tile.q, tile.r),
      tile.ownerSeat === viewerSeat ? "move" : isClaim(tile) ? "claim" : "attack",
    );
  }
  return targets;
}

export function deriveOrders({
  tiles,
  tileByKey,
  selection,
  viewerSeat,
  canAct,
  turnScope,
  compact,
}: OrderInput): Orders {
  const { selectedHex, hoverHex, cursorHex, marchUnits } = selection;
  const selectedTile = selectedHex ? (tileByKey.get(selectedHex) ?? null) : null;
  const targets = marchTargets(tiles, selectedTile, viewerSeat, canAct);
  const targetHex = lockedTarget(selection, turnScope, targets);
  const targetTile = targetHex ? (tileByKey.get(targetHex) ?? null) : null;
  const maxMovable = selectedTile ? Math.max(0, (selectedTile.units ?? 0) - 1) : 0;
  const lockedUnits = Math.min(marchUnits, maxMovable);
  const targetForecast =
    targetTile && viewerSeat !== null && maxMovable > 0
      ? forecastMarch(lockedUnits, targetTile, viewerSeat)
      : null;

  const previewHex =
    targetHex ?? [hoverHex, cursorHex].find((hex) => hex !== null && targets.has(hex)) ?? null;
  const previewTile =
    previewHex && (!compact || previewHex === targetHex)
      ? (tileByKey.get(previewHex) ?? null)
      : null;
  const previewUnits = previewHex === targetHex ? lockedUnits : maxMovable;
  const previewForecast =
    previewTile && viewerSeat !== null && previewUnits > 0
      ? forecastMarch(previewUnits, previewTile, viewerSeat)
      : null;
  const preview =
    previewTile && previewForecast ? { tile: previewTile, forecast: previewForecast } : null;

  let boardForecast: BoardForecast | null = null;
  if (previewForecast && previewHex && selectedHex) {
    const claim = targets.get(previewHex) === "claim";
    const transfer = previewForecast.kind === "transfer";
    boardForecast = {
      fromHex: selectedHex,
      toHex: previewHex,
      tone: transfer ? "move" : claim ? "claim" : previewForecast.kind,
      label: forecastLabel(previewForecast, claim),
      leaving: previewForecast.attackerUnits,
      defenderLoss: transfer ? 0 : previewForecast.defenderLosses,
      gain: transfer ? previewForecast.attackerUnits : 0,
    };
  }

  return {
    selectedTile,
    targets,
    targetHex,
    targetTile,
    maxMovable,
    lockedUnits,
    targetForecast,
    preview,
    boardForecast,
  };
}
