import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Minus, Plus, Scan, Search, Trophy, X } from "./Icons";
import {
  CHAMP_W,
  GAP_X,
  GRID,
  MAX_ZOOM,
  MIN_ZOOM,
  NODE_H,
  NODE_W,
  ROW_H,
  clamp,
  colX,
  columnView,
  fitView,
  inView,
  initialView,
  layoutOf,
  readableZoom,
  type Column,
  type Layout,
  type Spot,
  type View,
} from "./bracketLayout";
import {
  feederText,
  isDecided,
  matchRound,
  playersById,
  roundLabel,
  type BracketSide,
  type Match,
  type Snapshot,
  type Standing,
  type Tournament,
} from "./model";

interface BracketProps {
  snapshot: Snapshot;
  selectedMatchId?: string | null;
  tracedPlayer: string | null;
  onTrace(playerId: string | null): void;
  onOpenMatch(match: Match): void;
}

const count = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"}`;

export function Bracket({
  snapshot,
  selectedMatchId,
  tracedPlayer,
  onTrace,
  onOpenMatch,
}: BracketProps) {
  const tournament = snapshot.tournament;
  const people = useMemo(() => playersById(snapshot), [snapshot]);
  const courts = useMemo(
    () => new Map(snapshot.courts.map((court) => [court.id, court.name])),
    [snapshot.courts],
  );
  const byId = useMemo(
    () => new Map(snapshot.matches.map((match) => [match.id, match])),
    [snapshot.matches],
  );
  const layout = useMemo(
    () => layoutOf(tournament, snapshot.matches),
    [tournament, snapshot.matches],
  );
  const liveCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const match of snapshot.matches)
      if (match.status === "live")
        counts.set(
          `${match.bracket}:${match.round}`,
          (counts.get(`${match.bracket}:${match.round}`) ?? 0) + 1,
        );
    return counts;
  }, [snapshot.matches]);
  const liveIn = (bracket: BracketSide, round: number) =>
    liveCounts.get(`${bracket}:${round}`) ?? 0;
  const [hovered, setHovered] = useState<string | null>(null);
  const openRef = useRef(onOpenMatch);
  openRef.current = onOpenMatch;
  const openNode = useCallback((picked: Match) => {
    setHovered(null);
    openRef.current(picked);
  }, []);
  const focus = hovered ?? (tracedPlayer && people.has(tracedPlayer) ? tracedPlayer : null);
  const contentW = layout.width;
  const contentH = layout.height;

  const viewport = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [box, setBox] = useState({ w: 0, h: 0 });

  const fit = useCallback(() => {
    const el = viewport.current;
    if (el) setView(fitView(layout, el.clientWidth, el.clientHeight));
  }, [layout]);

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  const frame = useCallback(() => {
    const el = viewport.current;
    if (el)
      setView(
        initialView(layout, snapshot.matches, snapshot.courts, el.clientWidth, el.clientHeight),
      );
  }, [layout, snapshot.matches, snapshot.courts]);

  const showColumn = (column: Column, from: Column = column, to: Column | null = null) => {
    const el = viewport.current;
    if (!el) return;
    setView((current) =>
      columnView(
        layout,
        snapshot.matches,
        column,
        from,
        to,
        current,
        el.clientWidth,
        el.clientHeight,
      ),
    );
  };

  const showSide = (side: "winners" | "losers") => {
    const columns = layout.columns.filter((column) => column.bracket === side);
    const open = (column: Column) =>
      snapshot.matches.some(
        (match) =>
          match.bracket === side &&
          match.round === column.round &&
          (match.status === "live" || match.status === "ready" || match.status === "waiting"),
      );
    const target =
      columns.find((column) => liveIn(column.bracket, column.round) > 0) ??
      columns.find(open) ??
      columns.at(-1);
    if (target) showColumn(target, columns[0], side === "losers" ? (columns.at(-1) ?? null) : null);
  };

  const fitted = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = `${tournament?.id}:${box.w > 0}`;
    if (box.w === 0 || fitted.current === key) return;
    fitted.current = key;
    frame();
  }, [box.w, frame, tournament?.id]);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => {
    if (!selectedMatchId || box.w === 0) return;
    const spot = layoutRef.current.at.get(selectedMatchId);
    if (!spot) return;
    setView((current) =>
      inView(current, spot, box)
        ? current
        : {
            ...current,
            x: box.w / 2 - (spot.x + NODE_W / 2) * current.k,
            y: box.h / 2 - spot.y * current.k,
          },
    );
  }, [selectedMatchId, box.w, box.h]);

  const traceFramed = useRef<string | null>(null);
  useEffect(() => {
    if (!tracedPlayer) {
      traceFramed.current = null;
      return;
    }
    if (box.w === 0 || traceFramed.current === tracedPlayer) return;
    traceFramed.current = tracedPlayer;
    const spots = snapshot.matches
      .filter((match) => match.playerA === tracedPlayer || match.playerB === tracedPlayer)
      .sort((a, b) => a.number - b.number)
      .flatMap((match) => layout.at.get(match.id) ?? []);
    const latest = spots.at(-1);
    if (!latest) return;
    setView((current) => {
      if (spots.some((spot) => inView(current, spot, box))) return current;
      const k = Math.max(current.k, readableZoom(box.w));
      return {
        k,
        x: box.w / 2 - (latest.x + NODE_W / 2) * k,
        y: box.h / 2 - latest.y * k,
      };
    });
  }, [tracedPlayer, box, layout, snapshot.matches]);

  const bound = useCallback(
    (next: View) => {
      const el = viewport.current;
      if (!el) return next;
      const keep = 96;
      return {
        k: next.k,
        x: clamp(next.x, keep - contentW * next.k, el.clientWidth - keep),
        y: clamp(next.y, keep - contentH * next.k, el.clientHeight - keep),
      };
    },
    [contentW, contentH],
  );

  const pan = useCallback(
    (dx: number, dy: number) =>
      setView((current) => bound({ ...current, x: current.x + dx, y: current.y + dy })),
    [bound],
  );

  const zoomAt = useCallback(
    (factor: number, px: number, py: number) => {
      setView((current) => {
        const k = clamp(current.k * factor, MIN_ZOOM, MAX_ZOOM);
        const ratio = k / current.k;
        return bound({ k, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio });
      });
    },
    [bound],
  );

  const zoomCenter = (factor: number) => {
    const el = viewport.current;
    if (el) zoomAt(factor, el.clientWidth / 2, el.clientHeight / 2);
  };

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey)
        zoomAt(
          Math.exp(-event.deltaY * 0.0025),
          event.clientX - rect.left,
          event.clientY - rect.top,
        );
      else
        pan(-(event.shiftKey ? event.deltaY : event.deltaX), -(event.shiftKey ? 0 : event.deltaY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, pan]);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ moved: boolean; startX: number; startY: number; pinch: number } | null>(
    null,
  );
  const suppressClick = useRef(false);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    suppressClick.current = false;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1)
      drag.current = { moved: false, startX: event.clientX, startY: event.clientY, pinch: 0 };
    else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      drag.current = {
        moved: true,
        startX: 0,
        startY: 0,
        pinch: Math.hypot(a!.x - b!.x, a!.y - b!.y),
      };
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const last = pointers.current.get(event.pointerId);
    const state = drag.current;
    if (!last || !state) return;
    const next = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, next);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const rect = event.currentTarget.getBoundingClientRect();
      if (state.pinch > 0)
        zoomAt(distance / state.pinch, (a!.x + b!.x) / 2 - rect.left, (a!.y + b!.y) / 2 - rect.top);
      state.pinch = distance;
      return;
    }
    if (!state.moved && Math.hypot(next.x - state.startX, next.y - state.startY) < 4) return;
    if (!state.moved) {
      state.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    pan(next.x - last.x, next.y - last.y);
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (drag.current?.moved) suppressClick.current = true;
    if (pointers.current.size === 0) drag.current = null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const step = 64;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      pan(move[0], move[1]);
    } else if (event.key === "+" || event.key === "=") zoomCenter(1.2);
    else if (event.key === "-" || event.key === "_") zoomCenter(1 / 1.2);
    else if (event.key === "0") fit();
  };

  if (!tournament) return null;
  const onPath = (match: Match) =>
    focus !== null && (match.playerA === focus || match.playerB === focus);
  const champion = tournament.championId ? people.get(tournament.championId) : undefined;
  const crowning = tournament.championId
    ? snapshot.matches.find(
        (match) =>
          match.winnerId === tournament.championId &&
          (match.nextMatchId === null || byId.get(match.nextMatchId)?.status === "skipped"),
      )
    : undefined;
  const titleMatch =
    crowning ??
    snapshot.matches.find(
      (match) =>
        match.nextMatchId === null && (tournament.format === "single" || match.bracket === "final"),
    );
  const championSpot = layout.champion;
  const titleSpot = titleMatch ? layout.at.get(titleMatch.id) : undefined;

  const header = (left: number, width: number) => {
    const shown = Math.max(left, 12);
    const right = box.w > 0 ? Math.min(left + width, box.w - 12) : left + width;
    const visible = Math.max(0, right - shown);
    return { left: shown, width: visible < Math.max(48, width / 2) ? 0 : visible };
  };

  const lengthFor = (losers: boolean) =>
    (["full", "short"] as const).find((length) =>
      layout.columns
        .filter((column) => (column.bracket === "losers") === losers)
        .every(
          (column) =>
            roundLabel(tournament, column.bracket, column.round, length).length * 8 +
              (liveIn(column.bracket, column.round) > 0 ? 56 : 0) <=
            (NODE_W + GAP_X) * view.k - 12,
        ),
    ) ?? "tiny";
  const labelLength = lengthFor(false);
  const laneLength = lengthFor(true);
  const laneY = layout.laneTop === null ? null : view.y + layout.laneTop * view.k;
  const inLosers = laneY !== null && laneY <= 16;
  const losersSide = laneY !== null && laneY < box.h / 2;
  const losersInView = laneY !== null && laneY < box.h - 24;

  return (
    <div className="co-canvas">
      <nav className="co-canvas-rounds" aria-label="Rounds">
        {layout.columns.map((column) => {
          if (column.bracket !== "final" && (column.bracket === "losers") !== inLosers) return null;
          const live = liveIn(column.bracket, column.round);
          const place = header(
            view.x + colX(column.index) * view.k,
            (NODE_W + GAP_X) * view.k - 12,
          );
          if (place.width < 48) return null;
          const full = roundLabel(tournament, column.bracket, column.round);
          return (
            <button
              type="button"
              key={column.key}
              className="co-canvas-round"
              style={place}
              aria-label={`Go to ${full}${live > 0 ? `, ${live} live` : ""}`}
              onClick={() => showColumn(column)}
            >
              <span>
                {roundLabel(
                  tournament,
                  column.bracket,
                  column.round,
                  column.bracket === "losers" ? laneLength : labelLength,
                )}
              </span>
              {live > 0 ? <em>{live} live</em> : null}
            </button>
          );
        })}
        {(() => {
          const place = header(view.x + championSpot.x * view.k, CHAMP_W * view.k);
          return place.width < 48 ? null : (
            <div aria-hidden="true" className="co-canvas-round" style={place}>
              <span>Champion</span>
            </div>
          );
        })()}
      </nav>
      <div
        ref={viewport}
        className={`co-canvas-viewport${focus ? " is-tracing" : ""}`}
        style={{
          backgroundSize: `${GRID * view.k}px ${GRID * view.k}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
        tabIndex={0}
        role="region"
        aria-label="Bracket. Drag or use arrow keys to move, plus and minus to zoom, 0 to fit."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={(event) => {
          onPointerEnd(event);
          suppressClick.current = false;
        }}
        onClickCapture={(event) => {
          if (suppressClick.current && event.detail > 0) {
            suppressClick.current = false;
            event.stopPropagation();
            event.preventDefault();
          }
        }}
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          if (event.target === event.currentTarget || !event.target.matches(":focus-visible"))
            return;
          const box = event.currentTarget.getBoundingClientRect();
          const card = event.target.getBoundingClientRect();
          const room = 24;
          const dx =
            card.left < box.left + room
              ? box.left + room - card.left
              : card.right > box.right - room
                ? box.right - room - card.right
                : 0;
          const dy =
            card.top < box.top + room
              ? box.top + room - card.top
              : card.bottom > box.bottom - room
                ? box.bottom - room - card.bottom
                : 0;
          if (dx !== 0 || dy !== 0) pan(dx, dy);
        }}
        onMouseLeave={() => setHovered(null)}
      >
        <div
          className="co-canvas-world"
          style={
            {
              width: contentW,
              height: contentH,
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
              "--co-k": view.k,
            } as CSSProperties
          }
        >
          {layout.laneTop !== null && losersInView ? (
            <div
              className={inLosers ? "co-lane is-headed" : "co-lane"}
              style={{
                top: layout.laneTop,
                width: contentW,
                fontSize: `${11 / view.k}px`,
              }}
              aria-hidden="true"
            >
              {layout.lanes.map((lane) => {
                const live = liveIn("losers", lane.round);
                const room = box.w - 12 - (view.x + colX(lane.index) * view.k);
                const text = roundLabel(tournament, "losers", lane.round, laneLength);
                return (
                  <span
                    key={lane.round}
                    style={{
                      left: colX(lane.index),
                      width: NODE_W,
                      visibility:
                        box.w > 0 && room < text.length * 8 + (live > 0 ? 56 : 0)
                          ? "hidden"
                          : undefined,
                    }}
                  >
                    {text}
                    {live > 0 ? <em>{live} live</em> : null}
                  </span>
                );
              })}
            </div>
          ) : null}
          <Wires
            matches={snapshot.matches}
            byId={byId}
            layout={layout}
            focus={focus}
            titleSpot={titleSpot}
            champion={champion}
          />
          {snapshot.matches.map((match) => {
            const spot = layout.at.get(match.id);
            if (!spot) return null;
            return (
              <MatchNode
                key={match.id}
                tournament={tournament}
                snapshot={snapshot}
                match={match}
                people={people}
                court={match.courtId ? courts.get(match.courtId) : undefined}
                focus={focus}
                traced={onPath(match)}
                selected={selectedMatchId === match.id}
                onHover={setHovered}
                onOpen={openNode}
                left={spot.x}
                top={spot.y - NODE_H / 2}
              />
            );
          })}
          <div
            className={`co-champ${champion ? " is-crowned" : ""}${
              champion && focus === champion.id ? " is-traced" : ""
            }`}
            style={{
              left: championSpot.x,
              top: championSpot.y - NODE_H / 2,
              width: CHAMP_W,
              height: NODE_H,
            }}
          >
            <Trophy size={18} />
            <span>{champion ? champion.name : "To be decided"}</span>
          </div>
        </div>
      </div>
      <CanvasTools
        zoom={view.k}
        people={snapshot.standings}
        traced={tracedPlayer && people.has(tracedPlayer) ? people.get(tracedPlayer)! : null}
        onTrace={onTrace}
        onZoomIn={() => zoomCenter(1.2)}
        onZoomOut={() => zoomCenter(1 / 1.2)}
        onFit={fit}
        side={layout.laneTop === null ? null : losersSide ? "losers" : "winners"}
        losersInView={losersInView}
        onSide={showSide}
        losersLive={layout.lanes.reduce((sum, lane) => sum + liveIn("losers", lane.round), 0)}
        rounds={layout.columns.map((column) => {
          const playing = liveIn(column.bracket, column.round);
          return {
            key: column.key,
            label: `${roundLabel(tournament, column.bracket, column.round)}${playing ? ` · ${playing} live` : ""}`,
            live: playing,
          };
        })}
        onRound={(key) => {
          const column = layout.columns.find((entry) => entry.key === key);
          if (column) showColumn(column);
        }}
        onActual={() => {
          const el = viewport.current;
          if (el) zoomAt(1 / view.k, el.clientWidth / 2, el.clientHeight / 2);
        }}
      />
    </div>
  );
}

interface WiresProps {
  matches: Match[];
  byId: Map<string, Match>;
  layout: Layout;
  focus: string | null;
  titleSpot: Spot | undefined;
  champion: Standing | undefined;
}

const Wires = memo(function Wires({
  matches,
  byId,
  layout,
  focus,
  titleSpot,
  champion,
}: WiresProps) {
  const championSpot = layout.champion;
  return (
    <svg className="co-wires" width={layout.width} height={layout.height} aria-hidden="true">
      {matches.map((match) => {
        const next = match.nextMatchId ? byId.get(match.nextMatchId) : undefined;
        const from = layout.at.get(match.id);
        const to = next ? layout.at.get(next.id) : undefined;
        if (!next || !from || !to) return null;
        const x1 = from.x + NODE_W;
        const y1 = from.y;
        const x2 = to.x;
        const y2 =
          match.nextSlot === null
            ? to.y
            : to.y - NODE_H / 2 + (match.nextSlot === "b" ? ROW_H * 1.5 : ROW_H / 2);
        const mid = x2 - GAP_X / 2;
        const advanced =
          match.nextSlot === null
            ? next.status !== "skipped" && next.status !== "waiting"
            : match.winnerId !== null;
        const lit =
          focus !== null &&
          match.winnerId === focus &&
          (next.playerA === focus || next.playerB === focus);
        return (
          <path
            key={match.id}
            d={`M${x1} ${y1} H${mid} V${y2} H${x2}`}
            className={`co-wire${advanced ? " is-advanced" : ""}${lit ? " is-lit" : ""}${
              next.status === "skipped" ? " is-unused" : ""
            }`}
          />
        );
      })}
      {focus
        ? matches.map((match) => {
            if (!match.loserNextMatchId || !match.winnerId || match.winnerId === focus) return null;
            if (match.playerA !== focus && match.playerB !== focus) return null;
            const from = layout.at.get(match.id);
            const to = layout.at.get(match.loserNextMatchId);
            if (!from || !to) return null;
            const x1 = from.x + NODE_W;
            const x2 = to.x;
            const y2 = to.y - NODE_H / 2 + (match.loserNextSlot === "b" ? ROW_H * 1.5 : ROW_H / 2);
            const gap = (layout.laneTop ?? 0) - 10;
            return (
              <path
                key={`drop-${match.id}`}
                d={`M${x1} ${from.y} H${x1 + 18} V${gap} H${Math.max(8, x2 - 54)} V${y2} H${x2}`}
                className="co-wire is-drop is-lit"
              />
            );
          })
        : null}
      {titleSpot ? (
        <path
          d={`M${titleSpot.x + NODE_W} ${titleSpot.y} H${championSpot.x}`}
          className={`co-wire${champion ? " is-advanced" : ""}${
            champion && champion.id === focus ? " is-lit" : ""
          }`}
        />
      ) : null}
    </svg>
  );
});

interface MatchNodeProps {
  tournament: Tournament;
  snapshot: Snapshot;
  match: Match;
  people: Map<string, Standing>;
  court: string | undefined;
  focus: string | null;
  traced: boolean;
  selected: boolean;
  onHover(id: string | null): void;
  onOpen(match: Match): void;
  left: number;
  top: number;
}

const MatchNode = memo(function MatchNode({
  tournament,
  snapshot,
  match,
  people,
  court,
  focus,
  traced,
  selected,
  onHover,
  onOpen,
  left,
  top,
}: MatchNodeProps) {
  const live = match.status === "live";
  const done = match.status === "done";
  const walkover = match.outcome === "walkover";
  const series = tournament.bestOf > 1;
  const skipped = match.status === "skipped";
  const reset = match.bracket === "final" && match.round === 2 && match.status === "waiting";
  const pending = live && isDecided(tournament, match.scoreA, match.scoreB);
  const name = (id: string | null) => (id ? (people.get(id)?.name ?? "Unknown") : "TBD");
  const spoken = (side: "a" | "b") =>
    live && series
      ? `${count(side === "a" ? match.gamesA : match.gamesB, "game")}, ${count(side === "a" ? match.scoreA : match.scoreB, "point")}`
      : result(side);
  const result = (side: "a" | "b") => {
    if (walkover)
      return match.winnerId === (side === "a" ? match.playerA : match.playerB) ? "W/O" : "–";
    if (done && series) return String(side === "a" ? match.gamesA : match.gamesB);
    if (done || live) return String(side === "a" ? match.scoreA : match.scoreB);
    return "";
  };
  const state = live
    ? `live on ${court ?? "court"}${series ? `, game ${match.gamesA + match.gamesB + 1}` : ""}${
        pending ? ", result pending" : ""
      }`
    : walkover
      ? "won by walkover"
      : skipped
        ? "not needed"
        : reset
          ? "played only if the losers side wins the grand final"
          : match.status;
  const label =
    `Match ${match.number}, ${matchRound(tournament, match)}, ${state}: ${name(match.playerA)} ${spoken(
      "a",
    )} vs ${name(match.playerB)} ${spoken("b")}`.replace(/ +/g, " ");
  return (
    <div
      className={`co-node is-${match.status}${traced ? " is-traced" : ""}${
        selected ? " is-selected" : ""
      }${series ? " is-series" : ""}`}
      style={{ left, top, width: NODE_W, height: NODE_H }}
    >
      <span className="co-node-num" aria-hidden="true">
        {match.number}
      </span>
      {live && series ? (
        <span className="co-node-caps" aria-hidden="true">
          <span>G</span>
          <span>Pts</span>
        </span>
      ) : null}
      {live ? (
        <span className="co-node-flag" aria-hidden="true">
          <span className="co-dot" />
          <span className="co-node-court">{court ?? "Live"}</span>
          {series || pending ? (
            <span className={pending ? "co-node-game is-pending" : "co-node-game"}>
              {pending ? "Pending" : `Game ${match.gamesA + match.gamesB + 1}`}
            </span>
          ) : null}
        </span>
      ) : match.status === "ready" ? (
        <span className="co-node-flag is-ready" aria-hidden="true">
          Ready
        </span>
      ) : skipped ? (
        <span className="co-node-flag is-ready" aria-hidden="true">
          Not needed
        </span>
      ) : reset ? (
        <span className="co-node-flag is-ready" aria-hidden="true">
          If needed
        </span>
      ) : null}
      <button
        type="button"
        className="co-node-hit"
        aria-label={label}
        aria-current={selected ? "true" : undefined}
        disabled={match.status === "bye" || skipped}
        onClick={() => onOpen(match)}
      >
        {(["a", "b"] as const).map((side) => {
          const id = side === "a" ? match.playerA : match.playerB;
          const player = id ? people.get(id) : undefined;
          const won = id !== null && match.winnerId === id;
          const lost = id !== null && match.winnerId !== null && !won;
          const score = side === "a" ? match.scoreA : match.scoreB;
          const leads = live && score > (side === "a" ? match.scoreB : match.scoreA);
          const games = side === "a" ? match.gamesA : match.gamesB;
          const hint = player
            ? player.name
            : match.status === "bye"
              ? "Bye"
              : skipped
                ? "—"
                : (feederText(snapshot, match, side) ?? "TBD");
          return (
            <span
              key={side}
              className={`co-slot${won ? " is-won" : ""}${lost ? " is-lost" : ""}${
                id && id === focus ? " is-focus" : ""
              }${id ? "" : " is-empty"}`}
              onMouseEnter={id ? () => onHover(id) : undefined}
              onMouseLeave={id ? () => onHover(null) : undefined}
            >
              <span className="co-slot-seed">{player?.seed ?? ""}</span>
              <span className="co-slot-name">
                {hint}
                {live && !pending && match.server === side ? (
                  <span className="co-serve" title="Serving" />
                ) : null}
              </span>
              {series && live ? <span className="co-slot-games">{games}</span> : null}
              <span
                className={`co-slot-score${leads ? " is-leading" : ""}${walkover ? " is-walkover" : ""}`}
              >
                {id ? result(side) : ""}
              </span>
            </span>
          );
        })}
      </button>
    </div>
  );
});

interface CanvasToolsProps {
  zoom: number;
  people: Standing[];
  traced: Standing | null;
  onTrace(id: string | null): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onFit(): void;
  onActual(): void;
  side: "winners" | "losers" | null;
  onSide(side: "winners" | "losers"): void;
  losersLive: number;
  losersInView: boolean;
  rounds: Array<{ key: string; label: string; live: number }>;
  onRound(key: string): void;
}

function CanvasTools({
  zoom,
  people,
  traced,
  onTrace,
  onZoomIn,
  onZoomOut,
  onFit,
  onActual,
  side,
  onSide,
  losersLive,
  losersInView,
  rounds,
  onRound,
}: CanvasToolsProps) {
  const live = rounds.reduce((sum, round) => sum + round.live, 0);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const refocus = useRef(false);
  const quiet = useRef(false);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (
      needle
        ? people.filter(
            (row) =>
              row.name.toLowerCase().includes(needle) ||
              (row.club ?? "").toLowerCase().includes(needle),
          )
        : [...people].sort((a, b) => a.seed - b.seed)
    ).slice(0, 8);
  }, [people, query]);
  const pick = (row: Standing | undefined) => {
    if (!row) return;
    onTrace(row.id);
    setQuery("");
    setOpen(false);
  };
  return (
    <div className="co-tools">
      <div className="co-tools-group co-trace">
        {traced ? (
          <span className="co-trace-chip">
            <span>
              Tracing <strong>{traced.name}</strong>
            </span>
            <button
              type="button"
              aria-label="Stop tracing"
              onClick={() => {
                refocus.current = true;
                onTrace(null);
              }}
            >
              <X size={14} />
            </button>
          </span>
        ) : (
          <label className="co-trace-field">
            <Search size={14} aria-hidden="true" />
            <span className="co-sr">Trace a player</span>
            <input
              ref={(el) => {
                if (!el || !refocus.current) return;
                refocus.current = false;
                quiet.current = true;
                el.focus();
                quiet.current = false;
              }}
              type="search"
              placeholder="Trace a player"
              value={query}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open && matches.length > 0}
              aria-controls={open && matches.length > 0 ? "co-trace-list" : undefined}
              aria-activedescendant={
                open && matches[active] ? `co-trace-${matches[active]!.id}` : undefined
              }
              onFocus={() => setOpen(!quiet.current)}
              onClick={() => setOpen(true)}
              onBlur={() => setOpen(false)}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
                setOpen(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  if (!open) return setOpen(true);
                  setActive((index) => Math.min(matches.length - 1, index + 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  if (!open) return setOpen(true);
                  setActive((index) => Math.max(0, index - 1));
                } else if (event.key === "Enter" && open) {
                  event.preventDefault();
                  pick(matches[active]);
                } else if (event.key === "Escape") {
                  setOpen(false);
                  event.currentTarget.blur();
                }
              }}
            />
            {open && matches.length > 0 ? (
              <ul className="co-trace-list" id="co-trace-list" role="listbox">
                {matches.map((row, index) => (
                  <li
                    key={row.id}
                    id={`co-trace-${row.id}`}
                    role="option"
                    aria-selected={index === active}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pick(row);
                    }}
                    onMouseEnter={() => setActive(index)}
                  >
                    <span className="co-num">{row.seed}</span>
                    <span>{row.name}</span>
                    {row.eliminatedRound === null ? <em>In</em> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </label>
        )}
      </div>
      <div className="co-tools-group">
        <select
          className="co-tool co-tool-text co-round-pick"
          aria-label={`Go to round${live ? `, ${live} live` : ""}`}
          value=""
          onChange={(event) => onRound(event.target.value)}
        >
          <option value="" disabled>
            {live ? `Rounds · ${live} live` : "Rounds"}
          </option>
          {rounds.map((round) => (
            <option key={round.key} value={round.key}>
              {round.label}
            </option>
          ))}
        </select>
      </div>
      {side ? (
        <div className="co-tools-group co-hide-sm" role="group" aria-label="Bracket side">
          {(["winners", "losers"] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              className="co-tool co-tool-text"
              aria-pressed={side === entry}
              onClick={() => onSide(entry)}
            >
              {entry === "losers" && losersLive > 0 && !losersInView ? (
                <span className="co-dot" aria-hidden="true" />
              ) : null}
              {entry === "winners" ? "Winners" : "Losers"}
              {entry === "losers" && losersLive > 0 ? (
                <span className="co-sr">, {losersLive} live</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className="co-tools-group" role="group" aria-label="Zoom">
        <button
          type="button"
          className="co-tool co-tool-zoom"
          onClick={onZoomOut}
          aria-label="Zoom out"
          title="Zoom out  −"
        >
          <Minus size={15} />
        </button>
        <button
          type="button"
          className="co-tool co-tool-pct co-tool-zoom"
          onClick={onActual}
          title="Actual size"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className="co-tool co-tool-zoom"
          onClick={onZoomIn}
          aria-label="Zoom in"
          title="Zoom in  +"
        >
          <Plus size={15} />
        </button>
        <span className="co-tools-sep co-tool-zoom" aria-hidden="true" />
        <button
          type="button"
          className="co-tool"
          onClick={onFit}
          aria-label="Fit bracket"
          title="Fit  0"
        >
          <Scan size={15} />
        </button>
      </div>
    </div>
  );
}
