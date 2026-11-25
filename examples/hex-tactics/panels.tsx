import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "dohc/ui";
import { ChevronLeft, ChevronRight, CircleX, EyeOff, Lock, Minus, Plus } from "dohc/icons";
import { LineChart } from "dohc/charts";
import { CoinGlyph, FactionCrest, FortBadge, TerrainSwatch } from "./board-art";
import {
  FORTIFY_COST,
  REINFORCE_UNIT_COST,
  TERRAIN_INFO,
  VISION_RANGE,
  factionName,
  isClaim,
  type MarchForecast,
} from "./rules";
import type { ReplayFrame } from "./replay";
import type { MoveRecord, VisibleTile } from "./types";

export function Kbd({ children }: { readonly children: ReactNode }) {
  return <kbd className="hc-kbd">{children}</kbd>;
}

export function PlayGlyph({ playing }: { readonly playing: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {playing ? (
        <path d="M3.5 2.5h2.4v9H3.5zM8.1 2.5h2.4v9H8.1z" fill="currentColor" />
      ) : (
        <path d="M4 2.2 L11.6 7 L4 11.8 Z" fill="currentColor" />
      )}
    </svg>
  );
}

export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
  id,
}: {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (next: number) => void;
  readonly label: string;
  readonly id?: string;
}) {
  return (
    <div className="hc-stepper" role="group" aria-label={label}>
      <button
        type="button"
        className="hc-step-btn"
        aria-label={`Fewer ${label.toLowerCase()}`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        <Minus size={13} aria-hidden="true" />
      </button>
      <output id={id} className="hc-step-value" aria-live="polite">
        {value}
      </output>
      <button
        type="button"
        className="hc-step-btn"
        aria-label={`More ${label.toLowerCase()}`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        <Plus size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

function Pips({ count, seat }: { readonly count: number; readonly seat: 1 | 2 | null }) {
  const shown = Math.min(12, count);
  return (
    <span className={`hc-pipbar hc-pipbar-${seat ?? 0}`} aria-hidden="true">
      {Array.from({ length: shown }, (_, index) => (
        <i key={index} />
      ))}
    </span>
  );
}

export function CombatPreview({
  forecast,
  attackerSeat,
  target,
  onClose,
}: {
  readonly forecast: MarchForecast;
  readonly attackerSeat: 1 | 2;
  readonly target: VisibleTile;
  readonly onClose?: () => void;
}) {
  const defenderSeat = target.ownerSeat;
  const terrainName = TERRAIN_INFO[target.terrain ?? "plains"].name;
  const verdict =
    forecast.kind === "transfer"
      ? "Move"
      : isClaim(target)
        ? "Claim"
        : forecast.kind === "capture"
        ? forecast.capitalCaptured
          ? "Capture capital"
          : "Capture"
        : "Repelled";
  return (
    <div className={`hc-preview hc-preview-${isClaim(target) ? "claim" : forecast.kind}`} role="status" data-testid="combat-preview">
      <div className="hc-preview-head">
        <span className="hc-preview-verdict">{verdict}</span>
        <span className="hc-preview-coord">{terrainName}</span>
        {forecast.heldYield ? (
          <span className="hc-preview-yield-chip">
            <CoinGlyph size={13} />+{forecast.heldYield.gold}g, +{forecast.heldYield.units} unit if held
          </span>
        ) : null}
        {onClose ? (
          <button type="button" className="hc-icon-btn hc-card-close" aria-label="Deselect hex" onClick={onClose}>
            <CircleX size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {forecast.kind === "transfer" || isClaim(target) ? (
        <>
          <div className="hc-preview-duel">
            <span className="hc-preview-side">
              <FactionCrest seat={attackerSeat} size={18} />
              <b>{forecast.attackerUnits}</b>
            </span>
            <ChevronRight size={14} aria-hidden="true" />
            <span className="hc-preview-side">
              <b>{forecast.resultUnits}</b> {forecast.kind === "transfer" ? "on hex" : "hold it"}
            </span>
          </div>
          {forecast.kind === "transfer" ? null : <div className="hc-preview-math">Undefended. No losses.</div>}
          <HeldYield forecast={forecast} />
        </>
      ) : (
        <>
          <div className="hc-preview-duel">
            <span className="hc-preview-side">
              <FactionCrest seat={attackerSeat} size={18} />
              <b>{forecast.attackerUnits}</b>
              <span className="hc-preview-sub">attack</span>
            </span>
            <span className="hc-preview-vs">vs</span>
            <span className="hc-preview-side">
              <FactionCrest seat={defenderSeat} size={18} />
              <b>{forecast.defensePower}</b>
              <span className="hc-preview-sub">defense</span>
            </span>
          </div>
          {forecast.terrainBonus + forecast.fortifyBonus > 0 ? (
            <div className="hc-preview-details">
              <div className="hc-preview-math">
                {forecast.defenderUnits} unit{forecast.defenderUnits === 1 ? "" : "s"}
                {forecast.terrainBonus > 0 ? ` +${forecast.terrainBonus} ${terrainName.toLowerCase()}` : ""}
                {forecast.fortifyBonus > 0 ? ` +${forecast.fortifyBonus} fort` : ""}
              </div>
              {forecast.kind === "repelled" && forecast.fortifyBonus > 0 ? (
                <div className={`hc-preview-fort${forecast.resultFortified ? "" : " hc-pos"}`}>
                  <svg width="12" height="14" viewBox="-7 -8 14 16" aria-hidden="true">
                    <FortBadge x={0} y={0} />
                  </svg>
                  {forecast.resultFortified ? (
                    "Fort holds"
                  ) : (
                    <span>
                      Fort breaks<span className="hc-preview-fort-more">, −2 defense from now on</span>
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          ) : forecast.defenderUnits === 0 ? (
            <div className="hc-preview-math">Undefended</div>
          ) : null}
          <dl className="hc-preview-losses">
            <div>
              <dt>You lose</dt>
              <dd className={forecast.attackerLosses > 0 ? "hc-neg" : undefined}>
                {forecast.attackerLosses > 0 ? `−${forecast.attackerLosses}` : "0"}
              </dd>
            </div>
            <div>
              <dt>They lose</dt>
              <dd className={forecast.defenderLosses > 0 ? "hc-pos" : undefined}>
                {forecast.defenderLosses > 0 ? `−${forecast.defenderLosses}` : "0"}
              </dd>
            </div>
            <div>
              <dt>{forecast.kind === "capture" ? "Hold with" : "Left on hex"}</dt>
              <dd>
                {forecast.resultUnits}
                {forecast.supplyNext > 0 ? (
                  <>
                    {" "}
                    <small className="hc-preview-supply">+{forecast.supplyNext} supply</small>
                  </>
                ) : null}
              </dd>
            </div>
          </dl>
          {forecast.supplyNext > 0 ? (
            <div className="hc-preview-note">
              {forecast.resultUnits} survive, then +{forecast.supplyNext} from {target.terrain === "capital" ? "their capital" : "the mine"} as
              their turn starts
            </div>
          ) : null}
          <HeldYield forecast={forecast} />
        </>
      )}
    </div>
  );
}

function HeldYield({ forecast }: { readonly forecast: MarchForecast }) {
  if (!forecast.heldYield) return null;
  return (
    <div className="hc-preview-note hc-preview-yield">
      <CoinGlyph size={14} />
      <span>
        +{forecast.heldYield.gold} gold and +{forecast.heldYield.units} unit on your next turn if held
      </span>
    </div>
  );
}

export interface TacticalCardProps {
  readonly tile: VisibleTile;
  readonly viewerSeat: 1 | 2 | null;
  readonly canOrder: boolean;
  readonly gold: number;
  readonly pending: boolean;
  readonly blocked: boolean;
  readonly target: VisibleTile | null;
  readonly forecast: MarchForecast | null;
  readonly marchUnits: number;
  readonly maxMovable: number;
  readonly reinforceUnits: number;
  readonly maxReinforce: number;
  readonly onMarchUnits: (next: number) => void;
  readonly onReinforceUnits: (next: number) => void;
  readonly onMarch: () => void;
  readonly onFortify: () => void;
  readonly onReinforce: () => void;
  readonly onClose?: () => void;
}

export function TacticalCard({
  tile,
  viewerSeat,
  canOrder,
  gold,
  pending,
  blocked,
  target,
  forecast,
  marchUnits,
  maxMovable,
  reinforceUnits,
  maxReinforce,
  onMarchUnits,
  onReinforceUnits,
  onMarch,
  onFortify,
  onReinforce,
  onClose,
}: TacticalCardProps) {
  const info = tile.terrain ? TERRAIN_INFO[tile.terrain] : null;
  const units = tile.units ?? 0;
  const own = viewerSeat !== null && tile.ownerSeat === viewerSeat;
  const bonus = info && units > 0 ? info.defense + (tile.fortified ? 2 : 0) : 0;
  const recruits = Math.min(reinforceUnits, Math.max(1, maxReinforce));
  return (
    <section className="hc-card" aria-label="Selected hex" data-testid="tactical-card">
      <header className="hc-card-head">
        <TerrainSwatch terrain={tile.visible ? tile.terrain : null} size={34} />
        <div className="hc-card-title">
          <strong>{tile.visible ? (info?.name ?? "Plains") : "Unscouted hex"}</strong>
          <span className="hc-card-sub">
            {tile.visible ? (
              <>
                <FactionCrest seat={tile.ownerSeat} size={12} />
                {factionName(tile.ownerSeat)}
              </>
            ) : (
              <>
                <EyeOff size={12} aria-hidden="true" />
                Outside your {VISION_RANGE}-hex vision
              </>
            )}
          </span>
        </div>
        {onClose ? (
          <button type="button" className="hc-icon-btn hc-card-close" aria-label="Deselect hex" title="Deselect (Esc)" onClick={onClose}>
            <CircleX size={16} aria-hidden="true" />
          </button>
        ) : null}
      </header>

      {tile.visible ? (
        <dl className="hc-card-stats">
          {tile.terrain !== "mountain" ? (
            <div>
              <dt>Units</dt>
              <dd>
                <span className="hc-num">{units}</span>
                <Pips count={units} seat={tile.ownerSeat} />
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Defense</dt>
            <dd>
              <span className="hc-num">{info && !info.passable ? "Blocked" : units + bonus}</span>
              {bonus > 0 ? <span className="hc-card-bonus">incl. +{bonus}</span> : null}
              {tile.fortified ? (
                <svg width="12" height="14" viewBox="-7 -8 14 16" aria-label="Fortified">
                  <FortBadge x={0} y={0} />
                </svg>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Yield</dt>
            <dd>{info?.income ?? "None"}</dd>
          </div>
        </dl>
      ) : null}

      {canOrder && own ? (
        target && forecast ? (
          <div className="hc-card-orders" data-testid="march-orders">
            <div className="hc-order-row">
              <span className="hc-order-label">
                {forecast.kind === "transfer" ? "Move to the" : isClaim(target) ? "Claim the" : "Attack the"}{" "}
                {TERRAIN_INFO[target.terrain ?? "plains"].name.toLowerCase()} with
              </span>
              <Stepper
                label="Units"
                value={marchUnits}
                min={1}
                max={Math.max(1, maxMovable)}
                onChange={onMarchUnits}
              />
            </div>
            <Button
              id="order-march-btn"
              variant={forecast.kind === "repelled" ? "danger" : "primary"}
              className="hc-order-main"
              loading={pending}
              disabled={blocked || maxMovable < 1}
              onClick={onMarch}
            >
              {forecast.kind === "transfer"
                ? `Move ${marchUnits}`
                : isClaim(target)
                  ? `Claim with ${marchUnits}`
                  : forecast.kind === "capture"
                    ? "Attack and capture"
                    : "Attack anyway"}
              <Kbd>Enter</Kbd>
            </Button>
          </div>
        ) : (
          <div className="hc-card-orders">
            <div className="hc-order-row">
              <Button
                id="order-fortify-btn"
                size="sm"
                loading={pending}
                disabled={tile.fortified || gold < FORTIFY_COST || blocked}
                onClick={onFortify}
                title={tile.fortified ? "Already fortified" : gold < FORTIFY_COST ? `Needs ${FORTIFY_COST} gold` : "+2 defense"}
              >
                <svg width="12" height="14" viewBox="-7 -8 14 16" aria-hidden="true">
                  <FortBadge x={0} y={0} />
                </svg>
                Fortify <span className="hc-cost">{FORTIFY_COST}g</span>
              </Button>
              <span className="hc-order-split">
                <Stepper
                  label="Recruits"
                  value={recruits}
                  min={1}
                  max={Math.max(1, maxReinforce)}
                  onChange={onReinforceUnits}
                />
                <Button
                  id="order-reinforce-btn"
                  size="sm"
                  loading={pending}
                  disabled={maxReinforce < 1 || blocked}
                  onClick={onReinforce}
                  title={maxReinforce < 1 ? `Needs ${REINFORCE_UNIT_COST} gold per unit` : undefined}
                >
                  Recruit <span className="hc-cost">{recruits * REINFORCE_UNIT_COST}g</span>
                </Button>
              </span>
            </div>
            {maxMovable < 1 ? <p className="hc-card-note">A hex keeps 1 unit as garrison, so this one cannot march.</p> : null}
          </div>
        )
      ) : null}
    </section>
  );
}

export function HandoffCover({
  seat,
  turn,
  name,
  previousName,
  ready,
  onReady,
}: {
  readonly seat: 1 | 2;
  readonly turn: number;
  readonly name: string;
  readonly previousName: string;
  readonly ready: boolean;
  readonly onReady: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const button = cardRef.current?.querySelector<HTMLButtonElement>("#handoff-ready-btn");
    if (ready && button) button.focus();
    else cardRef.current?.focus();
  }, [ready]);
  return (
    <div className={`hc-handoff hc-handoff-${seat}`} role="dialog" aria-modal="true" aria-labelledby="hc-handoff-title">
      <div className="hc-handoff-card" ref={cardRef} tabIndex={-1}>
        <FactionCrest seat={seat} size={48} />
        <span className="hc-handoff-turn">Turn {turn}</span>
        <h2 id="hc-handoff-title">Pass the device to {name}</h2>
        <p>
          {previousName}'s map stays hidden until {name} is ready.
        </p>
        <Button id="handoff-ready-btn" variant="primary" disabled={!ready} onClick={onReady}>
          {ready ? `Show ${name}'s map` : `Loading ${name}'s map`}
        </Button>
      </div>
    </div>
  );
}

export function TurnBanner({
  seat,
  turn,
  label,
  token,
}: {
  readonly seat: 1 | 2 | null;
  readonly turn: number;
  readonly label: string;
  readonly token: number;
}) {
  return (
    <div key={token} className={`hc-turn-banner hc-turn-banner-${seat ?? 0}`} aria-hidden="true">
      <span className="hc-turn-banner-turn">Turn {turn}</span>
      <span className="hc-turn-banner-name">
        <FactionCrest seat={seat} size={26} />
        <span className="hc-name">{label}</span>
      </span>
    </div>
  );
}

function moveGlyph(move: MoveRecord) {
  if (move.hidden || move.actionType === "hidden") return <EyeOff size={13} aria-hidden="true" />;
  return <FactionCrest seat={move.actorSeat} size={13} />;
}

export interface LogDrawerProps {
  readonly open: boolean;
  readonly compact: boolean;
  readonly moves: readonly MoveRecord[];
  readonly replay: {
    readonly frames: readonly ReplayFrame[];
    readonly step: number;
    readonly onStep: (index: number) => void;
    readonly chart: { labels: string[]; series: { name: string; values: number[]; color: string }[] } | null;
    readonly names: readonly [string, string];
  } | null;
  readonly replayLocked: boolean;
  readonly onPreviewMove: (turnNumber: number | null) => void;
  readonly pinnedTurn: number | null;
  readonly onPinMove: (turnNumber: number | null) => void;
  readonly onClose: () => void;
}

export function LogDrawer({
  open,
  compact,
  moves,
  replay,
  replayLocked,
  onClose,
  onPreviewMove,
  pinnedTurn,
  onPinMove,
}: LogDrawerProps) {
  const frame = replay ? replay.frames[Math.min(replay.step, replay.frames.length - 1)] : null;
  const activeStepRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [movesOpen, setMovesOpen] = useState(false);
  if (movesOpen && (!open || !replay)) setMovesOpen(false);
  const replayStep = replay?.step ?? null;
  const replaying = replayStep !== null;
  useEffect(() => {
    const list = listRef.current;
    if (!open || !replaying || !list) return;
    const observer = new ResizeObserver(() => activeStepRef.current?.scrollIntoView({ block: "nearest" }));
    observer.observe(list);
    return () => observer.disconnect();
  }, [open, replaying]);
  useEffect(() => {
    if (open && replayStep !== null) activeStepRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, replayStep, movesOpen]);
  return (
    <aside
      className="hc-drawer"
      data-open={open ? "true" : "false"}
      data-moves={movesOpen ? "open" : "closed"}
      aria-label="Battle log"
      aria-hidden={!open}
      inert={!open}
    >
      <header className="hc-drawer-head">
        <h2>{replay ? "Match history" : "Battle log"}</h2>
        {replay ? (
          <Button
            size="sm"
            variant="ghost"
            className="hc-drawer-moves"
            aria-expanded={movesOpen}
            aria-controls="hc-replay-moves"
            onClick={() => setMovesOpen((value) => !value)}
          >
            {movesOpen ? "Hide moves" : "Show moves"}
          </Button>
        ) : null}
        <button type="button" className="hc-icon-btn" aria-label="Close battle log" title="Close (R)" onClick={onClose}>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </header>
      {replay && frame ? (
        <div className="hc-drawer-section">
          <div className="hc-force-grid">
            {([1, 2] as const).map((seat) => (
              <div key={seat} className="hc-force">
                <span className="hc-force-name">
                  <FactionCrest seat={seat} size={13} />
                  <span className="hc-name">{replay.names[seat - 1]}</span>
                </span>
                <span className="hc-force-stats">
                  <span>
                    <b>{seat === 1 ? frame.seat1Units : frame.seat2Units}</b> units
                  </span>
                  <span className="hc-dot-sep" />
                  <span>
                    <b>{seat === 1 ? frame.seat1Tiles : frame.seat2Tiles}</b> hexes
                  </span>
                  <span className="hc-dot-sep" />
                  <span>
                    <b>{seat === 1 ? frame.seat1Gold : frame.seat2Gold}</b>g
                  </span>
                </span>
              </div>
            ))}
          </div>
          {replay.chart && !compact ? (
            <div className="hc-chart">
              <LineChart
                labels={replay.chart.labels}
                series={replay.chart.series}
                height={150}
                ariaLabel="Units per side over the match"
              />
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="hc-drawer-list" ref={listRef} id={replay ? "hc-replay-moves" : undefined}>
        {replay ? (
          <ol className="hc-log">
            {replay.frames.slice(1).map((entry, index) => (
              <li key={entry.stepIndex}>
                <button
                  ref={replay.step === index + 1 ? activeStepRef : undefined}
                  type="button"
                  className={`hc-move-btn${replay.step === index + 1 ? " hc-move-btn-active" : ""}`}
                  aria-current={replay.step === index + 1 ? "step" : undefined}
                  onClick={() => replay.onStep(index + 1)}
                >
                  <span className="hc-log-turn">{entry.move?.turnNumber}</span>
                  {entry.move ? moveGlyph(entry.move) : null}
                  <span className="hc-log-text">{entry.move?.outcome.summary}</span>
                </button>
              </li>
            ))}
          </ol>
        ) : moves.length === 0 ? (
          <p className="hc-empty-line">No orders yet. Crimson moves first.</p>
        ) : (
          <ol className="hc-log">
            {moves.map((move) => (
              <li key={move.turnNumber} className="hc-log-item">
                {move.hidden ? (
                  <span className="hc-log-row hc-log-row-hidden">
                    <span className="hc-log-turn">{move.turnNumber}</span>
                    {moveGlyph(move)}
                    <span className="hc-log-text">{move.outcome.summary}</span>
                  </span>
                ) : (
                  <button
                    type="button"
                    className={`hc-move-btn${pinnedTurn === move.turnNumber ? " hc-move-btn-active" : ""}`}
                    aria-pressed={pinnedTurn === move.turnNumber}
                    onClick={() => onPinMove(pinnedTurn === move.turnNumber ? null : move.turnNumber)}
                    onPointerEnter={() => onPreviewMove(move.turnNumber)}
                    onPointerLeave={() => onPreviewMove(null)}
                    onFocus={() => onPreviewMove(move.turnNumber)}
                    onBlur={() => onPreviewMove(null)}
                  >
                    <span className="hc-log-turn">{move.turnNumber}</span>
                    {moveGlyph(move)}
                    <span className="hc-log-text">{move.outcome.summary}</span>
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
      {replayLocked ? (
        <p className="hc-drawer-foot">
          <Lock size={12} aria-hidden="true" />
          Full replay opens when the match ends
        </p>
      ) : null}
    </aside>
  );
}

export function ReplayDock({
  frames,
  step,
  playing,
  onStep,
  onTogglePlay,
  onExit,
}: {
  readonly frames: readonly ReplayFrame[];
  readonly step: number;
  readonly playing: boolean;
  readonly onStep: (index: number) => void;
  readonly onTogglePlay: () => void;
  readonly onExit: () => void;
}) {
  const last = Math.max(0, frames.length - 1);
  const frame = frames[Math.min(step, last)];
  return (
    <div className="hc-replay" data-testid="replay-controls">
      <div className="hc-replay-buttons">
        <button
          type="button"
          className="hc-icon-btn"
          aria-label="Previous turn"
          title="Previous turn (Left arrow)"
          disabled={step <= 0}
          onClick={() => onStep(Math.max(0, step - 1))}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          id="replay-play-btn"
          className="hc-icon-btn hc-icon-btn-strong"
          aria-label={playing ? "Pause replay" : "Play replay"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
          onClick={onTogglePlay}
        >
          <PlayGlyph playing={playing} />
        </button>
        <button
          type="button"
          className="hc-icon-btn"
          aria-label="Next turn"
          title="Next turn (Right arrow)"
          disabled={step >= last}
          onClick={() => onStep(Math.min(last, step + 1))}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="hc-replay-track">
        <div className="hc-replay-meta">
          <span className="hc-replay-turn">
            {step === 0 ? "Opening" : `Turn ${frame?.move?.turnNumber ?? step}`}
            <span className="hc-replay-of"> / {frames[last]?.move?.turnNumber ?? 0}</span>
          </span>
          <span className="hc-replay-summary">{frame?.move ? frame.move.outcome.summary : "Starting positions"}</span>
        </div>
        <input
          id="replay-slider"
          className="hc-range"
          type="range"
          min={0}
          max={last}
          value={step}
          aria-label="Replay turn"
          aria-valuetext={step === 0 ? "Opening positions" : `Turn ${frame?.move?.turnNumber ?? step}`}
          onChange={(event) => onStep(Number(event.target.value))}
        />
      </div>
      <Button size="sm" variant="ghost" id="exit-replay-btn" onClick={onExit}>
        Exit replay
      </Button>
    </div>
  );
}

export function RulesSheet() {
  const terrains = ["plains", "forest", "gold", "capital", "mountain"] as const;
  return (
    <div className="hc-rules">
      <section className="hc-rules-orders">
        <h3>Each turn, give one order</h3>
        <ul className="hc-rule-list">
          <li>
            <b>March</b> units from a hex you hold to a neighbor, leaving at least 1 behind. Moving onto your own hex merges them.
          </li>
          <li>
            <b>Fortify</b> a hex for {FORTIFY_COST} gold: +2 defense until its defenders take losses.
          </li>
          <li>
            <b>Recruit</b> up to 5 units on a hex for {REINFORCE_UNIT_COST} gold each.
          </li>
          <li>
            <b>End turn</b> to hold position.
          </li>
        </ul>
      </section>
      <section className="hc-rules-combat">
        <h3>Combat</h3>
        <p>
          An attack captures the hex when attackers outnumber defense: defending units plus terrain and fort bonuses. The
          forecast shows exact losses before you commit. Take the enemy capital to win.
        </p>
        <p>
          With a stack selected, outlines mark where it can go: a teal chevron moves to your own hex, a dashed gold flag claims an
          empty hex, and a red crosshair attacks. Click or tap one to lock it and read the forecast, then click or tap it again,
          or use the order button, to send the order.
        </p>
      </section>
      <section className="hc-rules-terrain">
        <h3>Terrain</h3>
        <table className="hc-terrain-table">
          <thead>
            <tr>
              <th scope="col">Hex</th>
              <th scope="col">Defense</th>
              <th scope="col">Each turn</th>
            </tr>
          </thead>
          <tbody>
            {terrains.map((terrain) => (
              <tr key={terrain}>
                <th scope="row">
                  <span className="hc-terrain-name">
                    <TerrainSwatch terrain={terrain} size={24} />
                    {TERRAIN_INFO[terrain].name}
                  </span>
                </th>
                <td className="hc-num">
                  {TERRAIN_INFO[terrain].passable ? (TERRAIN_INFO[terrain].defense > 0 ? `+${TERRAIN_INFO[terrain].defense}` : "0") : "Blocked"}
                </td>
                <td>{TERRAIN_INFO[terrain].income}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hc-rules-foot">
          Terrain defense counts only while the hex has defenders. Every turn also pays 2 gold. You see {VISION_RANGE} hexes
          around what you hold.
        </p>
      </section>
      <section className="hc-rules-keys">
        <h3>Keys</h3>
        <dl className="hc-keys">
          <div>
            <dt>
              <Kbd>←</Kbd>
              <Kbd>→</Kbd>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
            </dt>
            <dd>Move between hexes</dd>
          </div>
          <div>
            <dt>
              <Kbd>Enter</Kbd>
            </dt>
            <dd>Select a stack, lock a target, then send the order</dd>
          </div>
          <div>
            <dt>
              <Kbd>Space</Kbd>
            </dt>
            <dd>Select or lock a target without sending</dd>
          </div>
          <div>
            <dt>
              <Kbd>Esc</Kbd>
            </dt>
            <dd>Cancel</dd>
          </div>
          <div>
            <dt>
              <Kbd>E</Kbd>
            </dt>
            <dd>End turn (Esc first if a target is locked)</dd>
          </div>
          <div>
            <dt>
              <Kbd>R</Kbd>
            </dt>
            <dd>Battle log and replay</dd>
          </div>
          <div>
            <dt>
              <Kbd>1</Kbd>
              <Kbd>2</Kbd>
            </dt>
            <dd>Switch seat on a shared device</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
