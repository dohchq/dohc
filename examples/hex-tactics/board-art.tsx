import { memo } from "react";
import type { TerrainType } from "./types";
import { MAX_PIPS, keptPips } from "./rules";
import { HEX_SIZE, countBadgeWidth, hexCenter, hexPoints } from "./geometry";

function Conifer({ x, y, h }: { readonly x: number; readonly y: number; readonly h: number }) {
  const w = h * 0.62;
  return (
    <g>
      <rect x={x - 1.4} y={y - 2} width={2.8} height={4} rx={0.8} fill="var(--t-trunk)" />
      <path
        d={`M ${x} ${y - h} L ${x - w / 2} ${y - 1} L ${x} ${y - 1} Z`}
        fill="var(--t-forest-light)"
      />
      <path
        d={`M ${x} ${y - h} L ${x + w / 2} ${y - 1} L ${x} ${y - 1} Z`}
        fill="var(--t-forest-dark)"
      />
      <path
        d={`M ${x} ${y - h * 1.18} L ${x - w * 0.36} ${y - h * 0.45} L ${x} ${y - h * 0.45} Z`}
        fill="var(--t-forest-light)"
      />
      <path
        d={`M ${x} ${y - h * 1.18} L ${x + w * 0.36} ${y - h * 0.45} L ${x} ${y - h * 0.45} Z`}
        fill="var(--t-forest-dark)"
      />
    </g>
  );
}

function Peak({
  x,
  y,
  w,
  h,
  snow,
}: {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly snow: boolean;
}) {
  const top = y - h;
  const capY = top + h * 0.34;
  return (
    <g>
      <path
        d={`M ${x - w / 2} ${y} L ${x} ${top} L ${x + w * 0.08} ${y} Z`}
        fill="var(--t-rock-light)"
      />
      <path
        d={`M ${x + w * 0.08} ${y} L ${x} ${top} L ${x + w / 2} ${y} Z`}
        fill="var(--t-rock-dark)"
      />
      {snow ? (
        <path
          d={`M ${x} ${top} L ${x - w * 0.17} ${capY} L ${x - w * 0.05} ${capY - 2} L ${x + w * 0.03} ${capY + 1.5} L ${x + w * 0.17} ${capY} Z`}
          fill="var(--t-snow)"
        />
      ) : null}
    </g>
  );
}

function Crystal({ x, y, h }: { readonly x: number; readonly y: number; readonly h: number }) {
  const w = h * 0.42;
  return (
    <g>
      <path
        d={`M ${x - w / 2} ${y} L ${x - w / 2} ${y - h * 0.62} L ${x} ${y - h} L ${x} ${y} Z`}
        fill="var(--t-gold-light)"
      />
      <path
        d={`M ${x} ${y} L ${x} ${y - h} L ${x + w / 2} ${y - h * 0.62} L ${x + w / 2} ${y} Z`}
        fill="var(--t-gold-dark)"
      />
    </g>
  );
}

function Keep({
  x,
  y,
  ownerSeat,
}: {
  readonly x: number;
  readonly y: number;
  readonly ownerSeat: 1 | 2 | null;
}) {
  const banner =
    ownerSeat === 1 ? "var(--hc-p1)" : ownerSeat === 2 ? "var(--hc-p2)" : "var(--t-stone-dark)";
  const wallTop = y - 12;
  const crenels = [-15, -9, 3, 9];
  return (
    <g className="hc-keep">
      <ellipse cx={x + 2} cy={y + 1} rx={21} ry={4.5} fill="var(--hc-shadow)" opacity={0.6} />
      <rect x={x - 17} y={wallTop} width={34} height={12} fill="var(--t-stone-light)" />
      <rect x={x + 3} y={wallTop} width={14} height={12} fill="var(--t-stone-dark)" />
      {crenels.map((dx) => (
        <rect
          key={dx}
          x={x + dx}
          y={wallTop - 3.5}
          width={4.5}
          height={3.5}
          fill={dx > 0 ? "var(--t-stone-dark)" : "var(--t-stone-light)"}
        />
      ))}
      <rect x={x - 6} y={wallTop - 13} width={12} height={25} fill="var(--t-stone-light)" />
      <rect x={x} y={wallTop - 13} width={6} height={25} fill="var(--t-stone-dark)" />
      <rect x={x - 6} y={wallTop - 16} width={3.5} height={3} fill="var(--t-stone-light)" />
      <rect x={x + 2.5} y={wallTop - 16} width={3.5} height={3} fill="var(--t-stone-dark)" />
      <path
        d={`M ${x - 2.2} ${y} L ${x - 2.2} ${y - 6} Q ${x} ${y - 9} ${x + 2.2} ${y - 6} L ${x + 2.2} ${y} Z`}
        fill="var(--t-gate)"
      />
      <line
        x1={x}
        y1={wallTop - 16}
        x2={x}
        y2={wallTop - 29}
        stroke="var(--t-stone-dark)"
        strokeWidth={1.3}
      />
      <path
        className="hc-banner-flag"
        d={`M ${x + 0.6} ${wallTop - 29} L ${x + 13} ${wallTop - 26} L ${x + 0.6} ${wallTop - 22.5} Z`}
        fill={banner}
      />
    </g>
  );
}

export function TerrainArt({
  terrain,
  x,
  y,
  ownerSeat,
}: {
  readonly terrain: TerrainType;
  readonly x: number;
  readonly y: number;
  readonly ownerSeat: 1 | 2 | null;
}) {
  switch (terrain) {
    case "forest":
      return (
        <g aria-hidden="true" className="hc-art">
          <Conifer x={x - 17} y={y - 2} h={15} />
          <Conifer x={x + 16} y={y - 4} h={17} />
          <Conifer x={x - 3} y={y - 11} h={19} />
          <Conifer x={x + 23} y={y + 12} h={11} />
        </g>
      );
    case "mountain":
      return (
        <g aria-hidden="true" className="hc-art">
          <Peak x={x + 11} y={y + 13} w={28} h={24} snow={false} />
          <Peak x={x - 5} y={y + 15} w={40} h={38} snow />
        </g>
      );
    case "gold":
      return (
        <g aria-hidden="true" className="hc-art">
          <ellipse cx={x + 12} cy={y - 6} rx={13} ry={4} fill="var(--t-gold-ground)" />
          <Crystal x={x + 6} y={y - 5} h={16} />
          <Crystal x={x + 15} y={y - 4} h={21} />
          <Crystal x={x + 22} y={y - 5} h={11} />
        </g>
      );
    case "capital":
      return (
        <g aria-hidden="true" className="hc-art">
          <Keep x={x} y={y - 2} ownerSeat={ownerSeat} />
        </g>
      );
    default:
      return null;
  }
}

function Pawn({
  x,
  y,
  seat,
}: {
  readonly x: number;
  readonly y: number;
  readonly seat: 1 | 2 | null;
}) {
  const fill = seat === 1 ? "var(--hc-p1)" : seat === 2 ? "var(--hc-p2)" : "var(--hc-neutral)";
  const shade =
    seat === 1 ? "var(--hc-p1-deep)" : seat === 2 ? "var(--hc-p2-deep)" : "var(--hc-neutral-deep)";
  const body = `M ${x - 6.5} ${y} C ${x - 6.5} ${y - 6} ${x - 4.5} ${y - 9} ${x} ${y - 9} C ${x + 4.5} ${y - 9} ${x + 6.5} ${y - 6} ${x + 6.5} ${y} Z`;
  return (
    <g>
      <path d={body} fill={fill} stroke={shade} strokeWidth={1.1} strokeLinejoin="round" />
      <path
        d={`M ${x} ${y - 9} C ${x + 4.5} ${y - 9} ${x + 6.5} ${y - 6} ${x + 6.5} ${y} L ${x} ${y} Z`}
        fill={shade}
        opacity={0.35}
      />
      {seat === 2 ? (
        <rect
          x={x - 3.6}
          y={y - 16.6}
          width={7.2}
          height={7.2}
          transform={`rotate(45 ${x} ${y - 13})`}
          fill={fill}
          stroke={shade}
          strokeWidth={1.1}
        />
      ) : (
        <circle cx={x} cy={y - 13} r={4.3} fill={fill} stroke={shade} strokeWidth={1.1} />
      )}
    </g>
  );
}

export interface UnitStackProps {
  readonly x: number;
  readonly y: number;
  readonly seat: 1 | 2 | null;
  readonly units: number;
  readonly fortified: boolean;
  readonly exhausted: boolean;
  readonly pipLoss: number;
  readonly pipGain: number;
  readonly className?: string;
}

export function UnitStack({
  x,
  y,
  seat,
  units,
  fortified,
  exhausted,
  pipLoss,
  pipGain,
  className,
}: UnitStackProps) {
  const pawnCount = units <= 1 ? 1 : units <= 4 ? 2 : 3;
  const offsets =
    pawnCount === 1
      ? [[0, 0]]
      : pawnCount === 2
        ? [
            [-5, -2],
            [5, 0],
          ]
        : [
            [0, -4],
            [-8, 0],
            [8, 0],
          ];
  const shownPips = Math.min(MAX_PIPS, units + pipGain);
  const pipW = 4;
  const pipGap = 1.6;
  const pipsWidth = shownPips * pipW + Math.max(0, shownPips - 1) * pipGap;
  const pipStart = x - pipsWidth / 2;
  const lostFrom = keptPips(units, pipLoss);
  const badgeFill =
    seat === 1 ? "var(--hc-p1-solid)" : seat === 2 ? "var(--hc-p2-solid)" : "var(--hc-neutral)";
  const badgeWidth = countBadgeWidth(seat, units);
  const badgeInk = seat === null ? "var(--hc-neutral-ink)" : "var(--hc-token-ink)";
  const pipFill =
    seat === 1 ? "var(--hc-p1)" : seat === 2 ? "var(--hc-p2)" : "var(--hc-neutral-deep)";
  return (
    <g
      aria-hidden="true"
      className={`hc-units${exhausted ? " hc-units-exhausted" : ""}${className ? ` ${className}` : ""}`}
    >
      <ellipse cx={x} cy={y + 1} rx={15} ry={3.6} fill="var(--hc-shadow)" />
      {offsets.map(([dx, dy], index) => (
        <Pawn key={index} x={x + dx!} y={y + dy!} seat={seat} />
      ))}
      <g className="hc-pips">
        <rect
          x={pipStart - 2}
          y={y + 4}
          width={pipsWidth + 4}
          height={7}
          rx={2}
          fill="var(--hc-pip-tray)"
        />
        {Array.from({ length: shownPips }, (_, index) => {
          const lost = pipLoss > 0 && index >= lostFrom && index < Math.min(MAX_PIPS, units);
          const gained = pipGain > 0 && index >= Math.min(MAX_PIPS, units);
          return (
            <rect
              key={index}
              className={lost ? "hc-pip-lost" : gained ? "hc-pip-gain" : undefined}
              x={pipStart + index * (pipW + pipGap)}
              y={y + 5.5}
              width={pipW}
              height={4}
              rx={1}
              fill={lost ? "none" : gained ? "var(--hc-move)" : pipFill}
              stroke={lost ? "#fff" : undefined}
              strokeWidth={lost ? 0.9 : undefined}
            />
          );
        })}
      </g>
      <g className="hc-count">
        {seat === 2 ? (
          <rect
            x={x + 24 - badgeWidth}
            y={y - 26}
            width={badgeWidth}
            height={13}
            rx={3}
            fill={badgeFill}
            stroke="var(--hc-token-ring)"
            strokeWidth={1.4}
          />
        ) : (
          <rect
            x={x + 24.1 - badgeWidth}
            y={y - 27.1}
            width={badgeWidth}
            height={15.2}
            rx={7.6}
            fill={badgeFill}
            stroke="var(--hc-token-ring)"
            strokeWidth={1.4}
          />
        )}
        <text
          x={x + 24 - badgeWidth / 2}
          y={y - 15.9}
          textAnchor="middle"
          className="hc-unit-count"
          fill={badgeInk}
        >
          {units}
        </text>
      </g>
      {fortified ? <FortBadge x={x - 17} y={y - 22} /> : null}
    </g>
  );
}

export function FortBadge({ x, y }: { readonly x: number; readonly y: number }) {
  return (
    <path
      d={`M ${x} ${y - 7} L ${x + 6} ${y - 5} L ${x + 6} ${y} C ${x + 6} ${y + 3.6} ${x + 3} ${y + 5.6} ${x} ${y + 7} C ${x - 3} ${y + 5.6} ${x - 6} ${y + 3.6} ${x - 6} ${y} L ${x - 6} ${y - 5} Z`}
      fill="var(--hc-fort)"
      stroke="var(--hc-fort-ring)"
      strokeWidth={1.3}
      strokeLinejoin="round"
    />
  );
}

export function FactionCrest({
  seat,
  size = 18,
}: {
  readonly seat: 1 | 2 | null;
  readonly size?: number;
}) {
  const fill = seat === 1 ? "var(--hc-p1)" : seat === 2 ? "var(--hc-p2)" : "var(--hc-neutral)";
  const deep =
    seat === 1 ? "var(--hc-p1-deep)" : seat === 2 ? "var(--hc-p2-deep)" : "var(--hc-neutral-deep)";
  return (
    <svg className="hc-crest" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M10 1.5 L17.5 4 L17.5 10 C17.5 14.2 14.2 17 10 18.5 C5.8 17 2.5 14.2 2.5 10 L2.5 4 Z"
        fill={fill}
        stroke={deep}
        strokeWidth={1.2}
      />
      {seat === 2 ? (
        <rect
          x={7.2}
          y={6.2}
          width={5.6}
          height={5.6}
          transform="rotate(45 10 9)"
          fill="var(--hc-token-ink)"
        />
      ) : seat === 1 ? (
        <circle cx={10} cy={9} r={3.1} fill="var(--hc-token-ink)" />
      ) : null}
    </svg>
  );
}

export function TerrainSwatch({
  terrain,
  size = 30,
}: {
  readonly terrain: TerrainType | null;
  readonly size?: number;
}) {
  const fill = terrain ? `var(--t-${terrain}-top)` : "var(--t-fog-top)";
  return (
    <svg
      className="hc-swatch"
      width={size}
      height={size}
      viewBox="-42 -44 84 92"
      aria-hidden="true"
    >
      <polygon
        points={hexPoints(0, 6, HEX_SIZE)}
        fill={terrain ? `var(--t-${terrain}-side)` : "var(--t-fog-side)"}
      />
      <polygon points={hexPoints(0, 0, HEX_SIZE)} fill={fill} />
      {terrain ? <TerrainArt terrain={terrain} x={0} y={0} ownerSeat={null} /> : null}
    </svg>
  );
}

export function CoinGlyph({ size = 16 }: { readonly size?: number }) {
  return (
    <svg className="hc-glyph" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <ellipse cx={8} cy={9.6} rx={6.2} ry={4.6} fill="var(--t-gold-dark)" />
      <ellipse
        cx={8}
        cy={7.6}
        rx={6.2}
        ry={4.6}
        fill="var(--t-gold-light)"
        stroke="var(--t-gold-dark)"
        strokeWidth={1}
      />
      <ellipse
        cx={8}
        cy={7.6}
        rx={3.2}
        ry={2.2}
        fill="none"
        stroke="var(--t-gold-dark)"
        strokeWidth={0.9}
        opacity={0.7}
      />
    </svg>
  );
}

export function UnitGlyph({
  seat,
  size = 16,
}: {
  readonly seat: 1 | 2 | null;
  readonly size?: number;
}) {
  return (
    <svg className="hc-glyph" width={size} height={size} viewBox="-8 -18 16 19" aria-hidden="true">
      <Pawn x={0} y={0} seat={seat} />
    </svg>
  );
}

export function HexGlyph({
  seat,
  size = 16,
}: {
  readonly seat: 1 | 2 | null;
  readonly size?: number;
}) {
  const fill =
    seat === 1 ? "var(--hc-p1-tint)" : seat === 2 ? "var(--hc-p2-tint)" : "var(--t-plains-top)";
  const edge = seat === 1 ? "var(--hc-p1)" : seat === 2 ? "var(--hc-p2)" : "var(--hc-neutral-deep)";
  return (
    <svg className="hc-glyph" width={size} height={size} viewBox="-9 -9 18 18" aria-hidden="true">
      <polygon
        points={hexPoints(0, 0, 7.6)}
        fill={fill}
        stroke={edge}
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
    </svg>
  );
}

const HERO_TILES: ReadonlyArray<{
  q: number;
  r: number;
  terrain: TerrainType;
  owner: 1 | 2 | null;
  units: number;
}> = [
  { q: -2, r: 1, terrain: "capital", owner: 1, units: 6 },
  { q: -1, r: 0, terrain: "forest", owner: 1, units: 3 },
  { q: -1, r: 1, terrain: "plains", owner: null, units: 0 },
  { q: 0, r: 0, terrain: "gold", owner: null, units: 2 },
  { q: 0, r: -1, terrain: "mountain", owner: null, units: 0 },
  { q: 1, r: -1, terrain: "forest", owner: null, units: 0 },
  { q: 1, r: 0, terrain: "plains", owner: 2, units: 4 },
  { q: 2, r: -1, terrain: "capital", owner: 2, units: 7 },
  { q: 0, r: 1, terrain: "plains", owner: null, units: 0 },
  { q: 1, r: 1, terrain: "forest", owner: null, units: 0 },
  { q: -2, r: 0, terrain: "plains", owner: null, units: 0 },
  { q: 2, r: 0, terrain: "gold", owner: null, units: 2 },
];

const HERO_PLACED = HERO_TILES.map((tile) => ({ ...tile, ...hexCenter(tile.q, tile.r) })).sort(
  (a, b) => a.y - b.y || a.x - b.x,
);

export const LobbyHero = memo(function LobbyHero() {
  const placed = HERO_PLACED;
  return (
    <svg
      className="hc-hero"
      viewBox="-200 -118 400 232"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
    >
      {placed.map(({ q, r, x, y, terrain, owner }) => (
        <g key={`${q},${r}`}>
          <polygon points={hexPoints(x, y + 7, HEX_SIZE - 1)} fill={`var(--t-${terrain}-side)`} />
          <polygon points={hexPoints(x, y, HEX_SIZE - 1)} fill={`var(--t-${terrain}-top)`} />
          {owner ? (
            <polygon
              points={hexPoints(x, y, HEX_SIZE - 1)}
              fill={owner === 1 ? "var(--hc-p1-tint)" : "var(--hc-p2-tint)"}
            />
          ) : null}
          {owner ? (
            <polygon
              points={hexPoints(x, y, HEX_SIZE - 4)}
              fill="none"
              stroke={owner === 1 ? "var(--hc-p1-edge)" : "var(--hc-p2-edge)"}
              strokeWidth={2.4}
              strokeLinejoin="round"
            />
          ) : null}
        </g>
      ))}
      {placed.map(({ q, r, x, y, terrain, owner }) => (
        <TerrainArt key={`a-${q},${r}`} terrain={terrain} x={x} y={y} ownerSeat={owner} />
      ))}
      {placed.map(({ q, r, x, y, terrain, owner, units }) =>
        units > 0 && terrain !== "mountain" ? (
          <UnitStack
            key={`u-${q},${r}`}
            x={x}
            y={y + 15}
            seat={owner}
            units={units}
            fortified={q === -1 && r === 0}
            exhausted={false}
            pipLoss={0}
            pipGain={0}
          />
        ) : null,
      )}
    </svg>
  );
});

export function HexLogo({ size = 28 }: { readonly size?: number }) {
  return (
    <svg className="hc-logo" width={size} height={size} viewBox="-22 -22 44 44" aria-hidden="true">
      <polygon points={hexPoints(0, 2, 19)} fill="var(--hc-logo-side)" />
      <polygon points={hexPoints(0, 0, 19)} fill="var(--hc-logo-top)" />
      <path d="M -1 -10 L -9 1 L -1 1 Z" fill="var(--hc-p1)" />
      <path d="M 1 10 L 9 -1 L 1 -1 Z" fill="var(--hc-p2)" />
    </svg>
  );
}

export function SwapGlyph() {
  return (
    <svg className="hc-seat-swap" width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M1.5 4h8M7 1.5 9.5 4 7 6.5M10.5 8h-8M5 5.5 2.5 8 5 10.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
