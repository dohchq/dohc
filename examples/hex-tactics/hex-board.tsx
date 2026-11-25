import { useId, useMemo, useRef, type CSSProperties, type KeyboardEvent } from "react";
import { TerrainArt, UnitStack } from "./board-art";
import { HEX_SIZE, arrowPath, hexCenter, hexKeyOf, hexPoints } from "./geometry";
import type { VisibleTile } from "./types";

export type TargetKind = "move" | "claim" | "attack";

export interface BoardForecast {
  readonly fromHex: string;
  readonly toHex: string;
  readonly label: string;
  readonly tone: "move" | "claim" | "capture" | "repelled";
  readonly leaving: number;
  readonly defenderLoss: number;
  readonly gain: number;
}

export interface BoardFlash {
  readonly hex: string;
  readonly kind: "capture" | "hit" | "move" | "build";
  readonly token: number;
  readonly scope: string;
}

export interface HexBoardProps {
  readonly tiles: readonly VisibleTile[];
  readonly viewerSeat: 1 | 2 | null;
  readonly interactive: boolean;
  readonly canAct: boolean;
  readonly selectedHex: string | null;
  readonly targetHex: string | null;
  readonly cursorHex: string | null;
  readonly targets: ReadonlyMap<string, TargetKind>;
  readonly lastMove: {
    readonly fromHex: string | null;
    readonly toHex: string | null;
    readonly seat: 1 | 2 | null;
    readonly token: number;
  } | null;
  readonly forecast: BoardForecast | null;
  readonly flash: BoardFlash | null;
  readonly highlightHexes: readonly string[];
  readonly onActivate: (tile: VisibleTile, via: "pointer" | "enter" | "space") => void;
  readonly onHover: (key: string | null) => void;
  readonly onCursor: (key: string) => void;
}

const SKIRT = 7;
const NEIGHBORS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

function terrainKey(tile: VisibleTile): string {
  return tile.visible ? (tile.terrain ?? "plains") : "fog";
}

function ownerName(seat: 1 | 2 | null): string {
  return seat === 1 ? "Crimson" : seat === 2 ? "Cobalt" : "Neutral";
}

const MARK_GLYPH: Record<TargetKind, string> = {
  move: "M -3 1.6 L 0 -1.6 L 3 1.6",
  claim: "M -1.8 3 V -3 L 2.8 -1.5 L -1.8 0",
  attack: "M -3.2 -3.2 L 2.2 2.2 M 3.2 -3.2 L -2.2 2.2 M 0.6 2.9 L 2.9 0.6 M -2.9 0.6 L -0.6 2.9",
};

function tileLabel(tile: VisibleTile, target: TargetKind | undefined): string {
  const coord = `Hex ${tile.q}, ${tile.r}`;
  if (!tile.visible) return `${coord}, hidden by fog of war`;
  const units = tile.units ?? 0;
  const parts = [coord, tile.terrain ?? "plains", ownerName(tile.ownerSeat)];
  if (tile.terrain !== "mountain") parts.push(`${units} unit${units === 1 ? "" : "s"}`);
  if (tile.fortified) parts.push("fortified");
  if (target === "attack") parts.push("attack target");
  if (target === "move") parts.push("move target");
  if (target === "claim") parts.push("claim target");
  return parts.join(", ");
}

export function HexBoard({
  tiles,
  viewerSeat,
  interactive,
  canAct,
  selectedHex,
  targetHex,
  cursorHex,
  targets,
  lastMove,
  forecast,
  flash,
  highlightHexes,
  onActivate,
  onHover,
  onCursor,
}: HexBoardProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const ids = {
    bevel: `hc-bevel-${uid}`,
    grass: `hc-grass-${uid}`,
    mist: `hc-mist-${uid}`,
    blur: `hc-blur-${uid}`,
    clip: `hc-clip-${uid}`,
  };
  const hitRefs = useRef(new Map<string, SVGPolygonElement>());
  const anchorX = useRef<number | null>(null);

  const layout = useMemo(() => {
    const positioned = tiles.map((tile) => ({ tile, key: hexKeyOf(tile.q, tile.r), ...hexCenter(tile.q, tile.r) }));
    let minX = -200;
    let maxX = 200;
    let minY = -180;
    let maxY = 180;
    if (positioned.length > 0) {
      minX = Math.min(...positioned.map((p) => p.x)) - HEX_SIZE - 8;
      maxX = Math.max(...positioned.map((p) => p.x)) + HEX_SIZE + 8;
      minY = Math.min(...positioned.map((p) => p.y)) - HEX_SIZE - 26;
      maxY = Math.max(...positioned.map((p) => p.y)) + HEX_SIZE + SKIRT + 10;
    }
    const byKey = new Map(positioned.map((p) => [p.key, p]));
    return { positioned, byKey, minX, minY, width: maxX - minX, height: maxY - minY };
  }, [tiles]);

  const tabStop = cursorHex && layout.byKey.has(cursorHex) ? cursorHex : (selectedHex ?? layout.positioned.find((p) => p.tile.ownerSeat === viewerSeat)?.key ?? layout.positioned[0]?.key ?? null);

  const arrow = useMemo(() => {
    if (!lastMove?.fromHex || !lastMove.toHex) return null;
    const from = layout.byKey.get(lastMove.fromHex);
    const to = layout.byKey.get(lastMove.toHex);
    if (!from || !to) return null;
    return arrowPath(from, to);
  }, [lastMove, layout.byKey]);

  const fogTiles = layout.positioned.filter((p) => !p.tile.visible);

  const moveCursor = (event: KeyboardEvent<SVGPolygonElement>, from: { x: number; y: number; tile: VisibleTile }) => {
    let next: string | null = null;
    const horizontal = NEIGHBORS[event.key];
    if (horizontal) {
      const key = hexKeyOf(from.tile.q + horizontal[0], from.tile.r + horizontal[1]);
      if (layout.byKey.has(key)) next = key;
      anchorX.current = layout.byKey.get(next ?? "")?.x ?? from.x;
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const dr = event.key === "ArrowUp" ? -1 : 1;
      const candidates = [hexKeyOf(from.tile.q, from.tile.r + dr), hexKeyOf(from.tile.q - dr, from.tile.r + dr)]
        .map((key) => layout.byKey.get(key))
        .filter((p): p is NonNullable<typeof p> => Boolean(p));
      const goal = anchorX.current ?? from.x;
      candidates.sort((a, b) => Math.abs(a.x - goal) - Math.abs(b.x - goal) || a.x - b.x);
      next = candidates[0]?.key ?? null;
      if (anchorX.current === null) anchorX.current = from.x;
    } else {
      return false;
    }
    event.preventDefault();
    if (next) {
      onCursor(next);
      hitRefs.current.get(next)?.focus();
    }
    return true;
  };

  const style = { "--hc-ratio": (layout.width / layout.height).toFixed(4) } as CSSProperties;

  return (
    <div className="hc-board" style={style} data-can-act={canAct ? "true" : "false"}>
      <svg
        className="hc-board-svg"
        viewBox={`${layout.minX.toFixed(1)} ${layout.minY.toFixed(1)} ${layout.width.toFixed(1)} ${layout.height.toFixed(1)}`}
        role="group"
        aria-label="HexClash battlefield"
        onPointerLeave={() => onHover(null)}
      >
        <defs>
          <linearGradient id={ids.bevel} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--hc-bevel-hi)" />
            <stop offset="0.45" stopColor="var(--hc-bevel-hi)" stopOpacity="0" />
            <stop offset="1" stopColor="var(--hc-bevel-lo)" />
          </linearGradient>
          <pattern id={ids.grass} width="23" height="17" patternUnits="userSpaceOnUse">
            <path d="M 4 10 l 1.6 -3.4 l 1.6 3.4 M 15 4 l 1.4 -3 l 1.4 3" fill="none" stroke="var(--t-plains-ink)" strokeWidth="1" strokeLinecap="round" />
          </pattern>
          <pattern id={ids.mist} width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
            <path d="M 0 5 h 4" fill="none" stroke="var(--t-fog-ink)" strokeWidth="1.3" strokeLinecap="round" />
          </pattern>
          <filter id={ids.blur} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="9" />
          </filter>
          <clipPath id={ids.clip}>
            {layout.positioned.map(({ key, x, y }) => (
              <polygon key={key} points={hexPoints(x, y, HEX_SIZE)} />
            ))}
            {layout.positioned.map(({ key, x, y }) => (
              <polygon key={`s-${key}`} points={hexPoints(x, y + SKIRT, HEX_SIZE)} />
            ))}
          </clipPath>
        </defs>

        <g className="hc-layer-tiles">
          {layout.positioned.map(({ tile, key, x, y }) => {
            const t = terrainKey(tile);
            const owned = tile.visible && tile.ownerSeat !== null;
            return (
              <g key={key} className="hc-tile" data-t={t}>
                <polygon points={hexPoints(x, y + SKIRT, HEX_SIZE - 1)} fill={`var(--t-${t}-side)`} />
                <polygon points={hexPoints(x, y, HEX_SIZE - 1)} fill={`var(--t-${t}-top)`} />
                {t === "plains" || t === "capital" ? (
                  <polygon points={hexPoints(x, y, HEX_SIZE - 1)} fill={`url(#${ids.grass})`} opacity={0.5} />
                ) : null}
                {t === "fog" ? <polygon points={hexPoints(x, y, HEX_SIZE - 1)} fill={`url(#${ids.mist})`} /> : null}
                {owned ? (
                  <polygon
                    points={hexPoints(x, y, HEX_SIZE - 1)}
                    fill={tile.ownerSeat === 1 ? "var(--hc-p1-tint)" : "var(--hc-p2-tint)"}
                  />
                ) : null}
                <polygon points={hexPoints(x, y, HEX_SIZE - 1)} fill={`url(#${ids.bevel})`} />
                {owned ? (
                  <polygon
                    points={hexPoints(x, y, HEX_SIZE - 4)}
                    fill="none"
                    stroke={tile.ownerSeat === 1 ? "var(--hc-p1-edge)" : "var(--hc-p2-edge)"}
                    strokeWidth={2.4}
                    strokeLinejoin="round"
                  />
                ) : null}
              </g>
            );
          })}
        </g>

        <g className="hc-layer-art">
          {layout.positioned.map(({ tile, key, x, y }) =>
            tile.visible && tile.terrain ? (
              <TerrainArt key={key} terrain={tile.terrain} x={x} y={y} ownerSeat={tile.ownerSeat} />
            ) : null,
          )}
        </g>

        {fogTiles.length > 0 ? (
          <g className="hc-layer-fog" clipPath={`url(#${ids.clip})`} pointerEvents="none" aria-hidden="true">
            <g filter={`url(#${ids.blur})`}>
              {fogTiles.map(({ key, x, y }) => (
                <polygon key={key} points={hexPoints(x, y + 3, HEX_SIZE + 6)} fill="var(--t-fog-haze)" />
              ))}
            </g>
          </g>
        ) : null}

        <g className="hc-layer-marks" pointerEvents="none" aria-hidden="true">
          {layout.positioned.map(({ key, x, y, tile }) => {
            const kind = targets.get(key);
            if (!kind) return null;
            const chosen = targetHex === key;
            return (
              <g key={key} className={`hc-mark hc-mark-${kind}${chosen ? " hc-mark-chosen" : ""}`}>
                <polygon points={hexPoints(x, y, HEX_SIZE - 1)} className="hc-mark-fill" />
                <polygon points={hexPoints(x, y, HEX_SIZE - 5)} className="hc-mark-edge" />
                {kind === "attack" ? (
                  <g className="hc-reticle">
                    <circle cx={x} cy={y + 2} r={19} />
                    <path d={`M ${x} ${y - 21} v 7 M ${x} ${y + 18} v 7 M ${x - 23} ${y + 2} h 7 M ${x + 16} ${y + 2} h 7`} />
                  </g>
                ) : null}
                {!forecast || forecast.toHex === key ? (
                  <g className="hc-mark-badge" transform={`translate(${x} ${y + 33}) scale(0.85)`}>
                    <circle r={6.5} />
                    <path d={MARK_GLYPH[kind]} />
                  </g>
                ) : null}
              </g>
            );
          })}
          {highlightHexes.map((hex) => {
            const p = layout.byKey.get(hex);
            return p ? <polygon key={`log-${hex}`} className="hc-log-ring" points={hexPoints(p.x, p.y, HEX_SIZE - 3)} /> : null;
          })}
          {selectedHex && layout.byKey.has(selectedHex) ? (
            <polygon
              className="hc-select-ring"
              points={hexPoints(layout.byKey.get(selectedHex)!.x, layout.byKey.get(selectedHex)!.y, HEX_SIZE - 2)}
            />
          ) : null}
          {flash && layout.byKey.get(flash.hex)?.tile.visible ? (
            <polygon
              key={`flash-${flash.token}`}
              className={`hc-flash hc-flash-${flash.kind}`}
              points={hexPoints(layout.byKey.get(flash.hex)!.x, layout.byKey.get(flash.hex)!.y, HEX_SIZE - 1)}
            />
          ) : null}
        </g>

        {arrow ? (
          <g
            key={`arrow-${lastMove?.token ?? 0}`}
            className={`hc-arrow hc-arrow-${lastMove?.seat ?? 0}`}
            pointerEvents="none"
            aria-hidden="true"
          >
            <path d={arrow.d} pathLength={1} />
            <polygon points={arrow.head} />
          </g>
        ) : null}

        <g className="hc-layer-units">
          {layout.positioned.map(({ tile, key, x, y }) => {
            if (!tile.visible || tile.terrain === "mountain") return null;
            const units = tile.units ?? 0;
            if (units <= 0 && !(forecast?.toHex === key && forecast.gain > 0)) return null;
            const isOwn = viewerSeat !== null && tile.ownerSeat === viewerSeat;
            const pipLoss =
              forecast?.toHex === key ? forecast.defenderLoss : forecast?.fromHex === key ? forecast.leaving : 0;
            const pipGain = forecast?.toHex === key ? forecast.gain : 0;
            const arrived = lastMove?.toHex === key;
            return (
              <UnitStack
                key={arrived ? `${key}-${lastMove?.token}` : key}
                x={x}
                y={y + 15}
                seat={tile.ownerSeat}
                units={units}
                fortified={tile.fortified}
                exhausted={canAct && isOwn && units <= 1}
                pipLoss={pipLoss}
                pipGain={pipGain}
                className={arrived ? "hc-units-arrived" : undefined}
              />
            );
          })}
        </g>

        {forecast && layout.byKey.has(forecast.toHex) ? (
          <g className={`hc-forecast hc-forecast-${forecast.tone}`} pointerEvents="none" aria-hidden="true">
            {(() => {
              const p = layout.byKey.get(forecast.toHex)!;
              const width = forecast.label.length * 5.9 + 10;
              return (
                <>
                  <rect x={p.x - width / 2} y={p.y - 33} width={width} height={15} rx={4} />
                  <text x={p.x} y={p.y - 22.6} textAnchor="middle">
                    {forecast.label}
                  </text>
                </>
              );
            })()}
          </g>
        ) : null}

        <g className="hc-layer-hit">
          {layout.positioned.map(({ tile, key, x, y }) => {
            const target = targets.get(key);
            return (
              <polygon
                key={key}
                ref={(node) => {
                  if (node) hitRefs.current.set(key, node);
                  else hitRefs.current.delete(key);
                }}
                className="hc-hit"
                points={hexPoints(x, y, HEX_SIZE - 0.5)}
                data-hex={key}
                data-visible={tile.visible ? "true" : "false"}
                data-owner={tile.ownerSeat ?? "neutral"}
                data-terrain={tile.terrain ?? "fog"}
                data-target={target ?? undefined}
                data-interactive={interactive ? "true" : "false"}
                role={interactive ? "button" : undefined}
                tabIndex={interactive ? (key === tabStop ? 0 : -1) : undefined}
                aria-label={tileLabel(tile, target)}
                aria-pressed={interactive ? selectedHex === key || targetHex === key : undefined}
                onClick={interactive ? () => onActivate(tile, "pointer") : undefined}
                onPointerEnter={interactive ? () => onHover(key) : undefined}
                onFocus={interactive ? () => onCursor(key) : undefined}
                onKeyDown={
                  interactive
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          if (event.repeat) return;
                          onActivate(tile, event.key === "Enter" ? "enter" : "space");
                          return;
                        }
                        moveCursor(event, { x, y, tile });
                      }
                    : undefined
                }
              />
            );
          })}
        </g>
      </svg>
    </div>
  );
}
