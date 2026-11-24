import { useId, useMemo, type KeyboardEvent } from "react";
import { axialDistance, hexKeyOf } from "./replay";
import type { VisibleTile } from "./types";

export { axialDistance, hexKeyOf };

const HEX_SIZE = 34;
const SQRT3 = Math.sqrt(3);

export interface HexBoardProps {
  readonly tiles: readonly VisibleTile[];
  readonly viewerSeat: 1 | 2 | null;
  readonly canAct: boolean;
  readonly selectedHex: string | null;
  readonly targetHex: string | null;
  readonly validTargets: ReadonlySet<string>;
  readonly lastMove: { readonly fromHex: string | null; readonly toHex: string | null } | null;
  readonly onSelectHex: (tile: VisibleTile) => void;
}

function hexCenter(q: number, r: number): { x: number; y: number } {
  return {
    x: HEX_SIZE * SQRT3 * (q + r / 2),
    y: HEX_SIZE * 1.5 * r,
  };
}

function hexPolygonPoints(cx: number, cy: number, radius: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = ((60 * i - 30) * Math.PI) / 180;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(" ");
}

function tileFill(tile: VisibleTile, fogPatternId: string): string {
  if (!tile.visible) return `url(#${fogPatternId})`;
  if (tile.ownerSeat === 1) return "var(--hex-p1-fill)";
  if (tile.ownerSeat === 2) return "var(--hex-p2-fill)";
  switch (tile.terrain) {
    case "gold":
      return "var(--hex-gold-fill)";
    case "forest":
      return "var(--hex-forest-fill)";
    case "mountain":
      return "var(--hex-mountain-fill)";
    default:
      return "var(--hex-plains-fill)";
  }
}

function tileStroke(tile: VisibleTile): string {
  if (!tile.visible) return "var(--hex-fog-stroke)";
  if (tile.ownerSeat === 1) return "var(--hex-p1-stroke)";
  if (tile.ownerSeat === 2) return "var(--hex-p2-stroke)";
  if (tile.terrain === "gold") return "var(--hex-gold-ink)";
  if (tile.terrain === "forest") return "var(--hex-forest-ink)";
  if (tile.terrain === "mountain") return "var(--hex-mountain-ink)";
  return "var(--hex-neutral-stroke)";
}

function tileAriaLabel(tile: VisibleTile, isTarget: boolean): string {
  const coord = `Hex ${tile.q}, ${tile.r}`;
  if (!tile.visible) return `${coord}, hidden by fog of war`;
  const owner =
    tile.ownerSeat === 1 ? "Crimson" : tile.ownerSeat === 2 ? "Cobalt" : "Neutral";
  const terrain = tile.terrain ?? "plains";
  const units = tile.units ?? 0;
  const fortified = tile.fortified ? ", fortified" : "";
  const moveHint = isTarget ? ", valid march target" : "";
  return `${coord}, ${terrain}, ${owner}, ${units} unit${units === 1 ? "" : "s"}${fortified}${moveHint}`;
}

function TerrainGlyph({
  terrain,
  cx,
  cy,
}: {
  readonly terrain: VisibleTile["terrain"];
  readonly cx: number;
  readonly cy: number;
}) {
  if (terrain === "mountain") {
    return (
      <g aria-hidden="true" stroke="var(--hex-mountain-ink)" strokeWidth={1.6} fill="none">
        <path d={`M ${cx - 12} ${cy + 7} L ${cx - 3} ${cy - 8} L ${cx + 5} ${cy + 7} Z`} />
        <path d={`M ${cx - 1} ${cy + 7} L ${cx + 6} ${cy - 4} L ${cx + 13} ${cy + 7} Z`} />
      </g>
    );
  }
  if (terrain === "gold") {
    return (
      <polygon
        aria-hidden="true"
        points={`${cx},${cy - 21} ${cx + 5.5},${cy - 15.5} ${cx},${cy - 10} ${cx - 5.5},${cy - 15.5}`}
        fill="var(--hex-gold-ink)"
        opacity={0.9}
      />
    );
  }
  if (terrain === "forest") {
    return (
      <g aria-hidden="true" stroke="var(--hex-forest-ink)" strokeWidth={1.5} fill="none">
        <path d={`M ${cx} ${cy - 21} L ${cx - 5} ${cy - 13} L ${cx + 5} ${cy - 13} Z`} />
        <line x1={cx} y1={cy - 13} x2={cx} y2={cy - 10} />
      </g>
    );
  }
  if (terrain === "capital") {
    return (
      <path
        aria-hidden="true"
        d={`M ${cx - 8} ${cy - 13} L ${cx - 7} ${cy - 21} L ${cx - 2.5} ${cy - 17} L ${cx} ${cy - 22} L ${cx + 2.5} ${cy - 17} L ${cx + 7} ${cy - 21} L ${cx + 8} ${cy - 13} Z`}
        fill="var(--hex-gold-ink)"
      />
    );
  }
  return null;
}

export function HexBoard({
  tiles,
  viewerSeat,
  canAct,
  selectedHex,
  targetHex,
  validTargets,
  lastMove,
  onSelectHex,
}: HexBoardProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const fogPatternId = `hc-fog-${uid}`;
  const arrowMarkerId = `hc-arrow-${uid}`;

  const layout = useMemo(() => {
    const positioned = tiles.map((tile) => {
      const center = hexCenter(tile.q, tile.r);
      return { tile, key: hexKeyOf(tile.q, tile.r), ...center };
    });
    let minX = -200;
    let maxX = 200;
    let minY = -180;
    let maxY = 180;
    if (positioned.length > 0) {
      minX = Math.min(...positioned.map((p) => p.x)) - HEX_SIZE - 14;
      maxX = Math.max(...positioned.map((p) => p.x)) + HEX_SIZE + 14;
      minY = Math.min(...positioned.map((p) => p.y)) - HEX_SIZE - 14;
      maxY = Math.max(...positioned.map((p) => p.y)) + HEX_SIZE + 14;
    }
    const byKey = new Map(positioned.map((p) => [p.key, p]));
    return {
      positioned,
      byKey,
      viewBox: `${minX.toFixed(1)} ${minY.toFixed(1)} ${(maxX - minX).toFixed(1)} ${(maxY - minY).toFixed(1)}`,
    };
  }, [tiles]);

  const arrowCoords = useMemo(() => {
    if (!lastMove?.fromHex || !lastMove?.toHex) return null;
    const from = layout.byKey.get(lastMove.fromHex);
    const to = layout.byKey.get(lastMove.toHex);
    if (!from || !to) return null;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return null;
    const ux = dx / dist;
    const uy = dy / dist;
    return {
      x1: from.x + ux * 14,
      y1: from.y + uy * 14,
      x2: to.x - ux * 16,
      y2: to.y - uy * 16,
    };
  }, [lastMove, layout.byKey]);

  const handleKeyDown = (event: KeyboardEvent<SVGGElement>, tile: VisibleTile) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectHex(tile);
    }
  };

  return (
    <div className="hc-board-frame">
      <svg
        className="hc-board-svg"
        viewBox={layout.viewBox}
        role="group"
        aria-label="HexClash tactical board"
      >
        <defs>
          <pattern
            id={fogPatternId}
            width="8"
            height="8"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="8" height="8" fill="var(--hex-fog-fill)" />
            <line x1="0" y1="0" x2="0" y2="8" stroke="var(--hex-fog-hatch)" strokeWidth="2.5" />
          </pattern>
          <marker
            id={arrowMarkerId}
            markerWidth="8"
            markerHeight="8"
            refX="6"
            refY="4"
            orient="auto"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--hex-arrow)" />
          </marker>
        </defs>

        {layout.positioned.map(({ tile, key, x, y }) => {
          const isSelected = selectedHex === key;
          const isTarget = validTargets.has(key);
          const isChosenTarget = targetHex === key;
          const isOwn = tile.visible && viewerSeat !== null && tile.ownerSeat === viewerSeat;
          const interactive = Boolean(
            tile.visible && (isTarget || (canAct && isOwn) || tile.ownerSeat !== null),
          );
          const isEnemyOrNeutralTarget = isTarget && tile.ownerSeat !== viewerSeat;
          const units = tile.units ?? 0;

          return (
            <g
              key={key}
              className="hc-hex-group"
              data-hex={key}
              data-visible={tile.visible ? "true" : "false"}
              data-owner={tile.ownerSeat ?? "neutral"}
              data-terrain={tile.terrain ?? "fog"}
              data-interactive={interactive ? "true" : "false"}
              role="button"
              tabIndex={interactive ? 0 : -1}
              aria-label={tileAriaLabel(tile, isTarget)}
              aria-pressed={isSelected || isChosenTarget}
              onClick={() => onSelectHex(tile)}
              onKeyDown={(event) => handleKeyDown(event, tile)}
            >
              <polygon
                className="hc-hex-poly"
                points={hexPolygonPoints(x, y, HEX_SIZE - 1.5)}
                fill={tileFill(tile, fogPatternId)}
                stroke={tileStroke(tile)}
                strokeWidth={tile.ownerSeat ? 2 : 1.2}
              />

              {isSelected ? (
                <polygon
                  points={hexPolygonPoints(x, y, HEX_SIZE - 4.5)}
                  fill="none"
                  stroke="var(--hex-select)"
                  strokeWidth={2.5}
                  pointerEvents="none"
                />
              ) : null}

              {isTarget ? (
                <polygon
                  points={hexPolygonPoints(x, y, HEX_SIZE - 4.5)}
                  fill="none"
                  stroke={
                    isEnemyOrNeutralTarget
                      ? "var(--hex-target-attack)"
                      : "var(--hex-target-friendly)"
                  }
                  strokeWidth={isChosenTarget ? 3 : 2}
                  strokeDasharray={isChosenTarget ? undefined : "5 3"}
                  pointerEvents="none"
                />
              ) : null}

              <polygon
                className="hc-hex-focus"
                points={hexPolygonPoints(x, y, HEX_SIZE - 0.5)}
              />

              {tile.visible ? (
                <>
                  <TerrainGlyph terrain={tile.terrain} cx={x} cy={y} />

                  {tile.fortified ? (
                    <path
                      aria-hidden="true"
                      d={`M ${x + 12} ${y - 17} L ${x + 18} ${y - 15} L ${x + 18} ${y - 9} C ${x + 18} ${y - 5.5} ${x + 15} ${y - 3.5} ${x + 12} ${y - 2} C ${x + 9} ${y - 3.5} ${x + 6} ${y - 5.5} ${x + 6} ${y - 9} L ${x + 6} ${y - 15} Z`}
                      fill="var(--kit-bg)"
                      stroke="var(--kit-ink)"
                      strokeWidth={1.3}
                    />
                  ) : null}

                  {tile.terrain !== "mountain" && (units > 0 || tile.ownerSeat !== null) ? (
                    <g aria-hidden="true">
                      {tile.ownerSeat === 1 ? (
                        <circle
                          cx={x}
                          cy={y + 2}
                          r={11.5}
                          fill="var(--hex-p1)"
                          stroke="var(--hex-p1-stroke)"
                          strokeWidth={1.2}
                        />
                      ) : tile.ownerSeat === 2 ? (
                        <rect
                          x={x - 10.5}
                          y={y - 8.5}
                          width={21}
                          height={21}
                          rx={4}
                          fill="var(--hex-p2)"
                          stroke="var(--hex-p2-stroke)"
                          strokeWidth={1.2}
                        />
                      ) : (
                        <rect
                          x={x - 10}
                          y={y - 7.5}
                          width={20}
                          height={19}
                          rx={9.5}
                          fill="var(--kit-bg)"
                          stroke="var(--hex-neutral-stroke)"
                          strokeWidth={1.2}
                        />
                      )}
                      <text
                        x={x}
                        y={y + 6.5}
                        textAnchor="middle"
                        className="hc-hex-units"
                        fill={
                          tile.ownerSeat === 1
                            ? "var(--hex-p1-ink)"
                            : tile.ownerSeat === 2
                              ? "var(--hex-p2-ink)"
                              : "var(--kit-ink)"
                        }
                      >
                        {units}
                      </text>
                    </g>
                  ) : null}

                  <text x={x} y={y + 24} textAnchor="middle" className="hc-hex-coord">
                    {tile.q},{tile.r}
                  </text>
                </>
              ) : (
                <text
                  x={x}
                  y={y + 4}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="600"
                  fill="var(--hex-fog-ink)"
                  pointerEvents="none"
                >
                  ?
                </text>
              )}
            </g>
          );
        })}

        {arrowCoords ? (
          <line
            x1={arrowCoords.x1}
            y1={arrowCoords.y1}
            x2={arrowCoords.x2}
            y2={arrowCoords.y2}
            stroke="var(--hex-arrow)"
            strokeWidth={2.4}
            strokeLinecap="round"
            markerEnd={`url(#${arrowMarkerId})`}
            opacity={0.78}
            pointerEvents="none"
          />
        ) : null}
      </svg>

      <div className="hc-legend" aria-label="Board legend">
        <span className="hc-legend-item">
          <span className="hc-swatch hc-swatch-circle hc-swatch-p1" />
          Crimson (circle)
        </span>
        <span className="hc-legend-item">
          <span className="hc-swatch hc-swatch-p2" />
          Cobalt (square)
        </span>
        <span className="hc-legend-item">
          <span className="hc-swatch hc-swatch-gold" />
          Gold mine (+2g, +1u)
        </span>
        <span className="hc-legend-item">
          <span className="hc-swatch hc-swatch-forest" />
          Forest (+1 def)
        </span>
        <span className="hc-legend-item">
          <span className="hc-swatch hc-swatch-mountain" />
          Mountain (blocked)
        </span>
        <span className="hc-legend-item">
          <span className="hc-swatch hc-swatch-fog" />
          Fog of war (range 2)
        </span>
      </div>
    </div>
  );
}
