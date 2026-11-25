import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, Callout, Input } from "dohc/ui";
import { ArrowRight, ChevronDown, CircleX, Eye, Lock, Plus, RotateCcw, Users } from "dohc/icons";
import { FactionCrest, HexLogo, LobbyHero } from "./board-art";
import { playerName } from "./rules";
import type { GameSummary } from "./types";

export type LobbyPanel = "create" | "join" | "resume" | null;

export interface MutationView {
  readonly pending: boolean;
  readonly uncertain: boolean;
  readonly error: { readonly message: string } | null;
  readonly discard: () => void;
}

export interface LobbyProps {
  readonly overlay: boolean;
  readonly onClose: () => void;
  readonly panel: LobbyPanel;
  readonly onPanel: (panel: LobbyPanel) => void;
  readonly demo: MutationView & { readonly start: () => void };
  readonly create: MutationView & { readonly submit: (values: { name: string; title: string }) => void };
  readonly join: MutationView & { readonly submit: (values: { code: string; name: string }) => void };
  readonly resume: {
    readonly pending: boolean;
    readonly error: string | null;
    readonly submit: (seatKey: string) => void;
  };
  readonly games: readonly GameSummary[];
  readonly gamesLoading: boolean;
  readonly gamesError: string | null;
  readonly reloadGames: () => void;
  readonly seatedGameIds: ReadonlySet<string>;
  readonly activeGameId: string | null;
  readonly onOpenGame: (gameId: string) => void;
  readonly onWatchGame: (gameId: string) => void;
}

function MenuRow({
  id,
  icon,
  label,
  open,
  onToggle,
  children,
}: {
  readonly id: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="hc-menu-row" data-open={open ? "true" : "false"}>
      <button type="button" id={id} className="hc-menu-btn" aria-expanded={open} onClick={onToggle}>
        <span className="hc-menu-icon">{icon}</span>
        <span className="hc-menu-label">{label}</span>
        <ChevronDown size={15} className="hc-menu-chevron" aria-hidden="true" />
      </button>
      {open ? <div className="hc-menu-body">{children}</div> : null}
    </div>
  );
}

function statusText(game: GameSummary): string {
  if (game.status === "finished")
    return game.winnerSeat
      ? `${playerName(game.players, game.winnerSeat)} won on turn ${game.turnNumber}`
      : "Finished";
  if (game.status === "waiting") return "Waiting for player 2";
  return `Turn ${game.turnNumber}`;
}

function MutationError({ view, what }: { readonly view: MutationView; readonly what: string }) {
  if (!view.error && !view.uncertain) return null;
  return (
    <Callout
      tone="danger"
      title={view.uncertain ? `dohc could not confirm the ${what}` : `Could not ${what}`}
      action={
        view.uncertain ? (
          <Button type="button" size="sm" variant="ghost" disabled={view.pending} onClick={view.discard}>
            Discard
          </Button>
        ) : undefined
      }
    >
      {view.uncertain ? "Try again to recover the same request, or discard it." : view.error?.message}
    </Callout>
  );
}

function updatedAgo(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Updated ${hours} h ago`;
  return `Updated ${new Date(ms).toLocaleDateString()}`;
}

function matchMeta(game: GameSummary): string {
  const names = (game.players ?? []).map((p) => p.name).join(" vs ") || "Open seat";
  return names === game.title ? updatedAgo(game.updatedAtMs) : `${names} · ${updatedAgo(game.updatedAtMs)}`;
}

export function Lobby(props: LobbyProps) {
  const { panel, onPanel, demo, create, join, resume } = props;
  const toggle = (next: Exclude<LobbyPanel, null>) => onPanel(panel === next ? null : next);
  const recent = props.games.slice(0, 8);
  const cardRef = useRef<HTMLDivElement>(null);
  const overlay = props.overlay;
  const [createName, setCreateName] = useState("Crimson");
  const [createTitle, setCreateTitle] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinName, setJoinName] = useState("Cobalt");
  const [seatKey, setSeatKey] = useState("");
  const submitWith = (send: () => void) => (event: FormEvent) => {
    event.preventDefault();
    send();
  };

  useEffect(() => {
    if (!overlay) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.focus();
    return () => previous?.focus();
  }, [overlay]);

  return (
    <div
      className="hc-lobby"
      data-overlay={props.overlay ? "true" : "false"}
      role={props.overlay ? "dialog" : undefined}
      aria-modal={props.overlay ? "true" : undefined}
      aria-label={props.overlay ? "Game menu" : undefined}
      onKeyDown={(event) => {
        if (props.overlay && event.key === "Escape") {
          event.stopPropagation();
          props.onClose();
        }
      }}
    >
      <div className="hc-lobby-card" ref={cardRef} tabIndex={-1}>
        <LobbyHero />
        <header className="hc-lobby-head">
          <HexLogo size={40} />
          <div>
            <h1 className="hc-wordmark">HexClash</h1>
            <p className="hc-lobby-tag">Two-player hex strategy with fog of war</p>
          </div>
          {props.overlay ? (
            <button type="button" className="hc-icon-btn hc-lobby-close" aria-label="Close menu" title="Close (Esc)" onClick={props.onClose}>
              <CircleX size={18} aria-hidden="true" />
            </button>
          ) : null}
        </header>

        <div className="hc-lobby-primary">
          <Button id="start-demo-btn" variant={panel ? "secondary" : "primary"} className="hc-cta" loading={demo.pending} onClick={demo.start}>
            <span className="hc-cta-crests">
              <FactionCrest seat={1} size={18} />
              <FactionCrest seat={2} size={18} />
            </span>
            <span className="hc-cta-text">
              <span>{demo.uncertain ? "Retry demo match" : "Start demo match"}</span>
              <small>Both seats on this device</small>
            </span>
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
          <MutationError view={demo} what="start the demo match" />
        </div>

        <div className="hc-menu" role="group" aria-label="Other ways to play">
          <MenuRow id="open-create-btn" icon={<Plus size={16} />} label="Create a match to share" open={panel === "create"} onToggle={() => toggle("create")}>
            <form onSubmit={submitWith(() => create.submit({ name: createName, title: createTitle }))}>
              <fieldset disabled={create.pending} className="hc-form">
                <MutationError view={create} what="create the match" />
                <label className="hc-field">
                  <span>Your name</span>
                  <Input
                    autoFocus
                    id="create-name"
                    value={createName}
                    onChange={(event) => setCreateName(event.target.value)}
                    placeholder="Crimson"
                    maxLength={40}
                    disabled={create.uncertain}
                    required
                  />
                </label>
                <label className="hc-field">
                  <span>Match name</span>
                  <Input
                    id="create-title"
                    value={createTitle}
                    onChange={(event) => setCreateTitle(event.target.value)}
                    placeholder="Friday skirmish"
                    maxLength={64}
                    disabled={create.uncertain}
                  />
                </label>
                <Button id="submit-create-btn" type="submit" variant="primary" loading={create.pending}>
                  {create.uncertain ? "Try again" : "Create match"}
                </Button>
              </fieldset>
            </form>
          </MenuRow>

          <MenuRow id="open-join-btn" icon={<Users size={16} />} label="Join with a code" open={panel === "join"} onToggle={() => toggle("join")}>
            <form onSubmit={submitWith(() => join.submit({ code: joinCode, name: joinName }))}>
              <fieldset disabled={join.pending} className="hc-form">
                <MutationError view={join} what="join the match" />
                <label className="hc-field">
                  <span>Join code</span>
                  <Input
                    autoFocus
                    id="join-code-input"
                    className="hc-code-input"
                    value={joinCode}
                    onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                    placeholder="AB12CD"
                    maxLength={6}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={join.uncertain}
                    required
                  />
                </label>
                <label className="hc-field">
                  <span>Your name</span>
                  <Input
                    id="join-name-input"
                    value={joinName}
                    onChange={(event) => setJoinName(event.target.value)}
                    placeholder="Cobalt"
                    maxLength={40}
                    disabled={join.uncertain}
                    required
                  />
                </label>
                <Button id="submit-join-btn" type="submit" variant="primary" loading={join.pending}>
                  {join.uncertain ? "Try again" : "Join as Cobalt"}
                </Button>
              </fieldset>
            </form>
          </MenuRow>

          <MenuRow id="open-resume-btn" icon={<Lock size={16} />} label="Resume with a seat key" open={panel === "resume"} onToggle={() => toggle("resume")}>
            <form onSubmit={submitWith(() => resume.submit(seatKey))}>
              <fieldset disabled={resume.pending} className="hc-form">
                {resume.error ? (
                  <p className="hc-field-error" role="alert">
                    {resume.error}
                  </p>
                ) : null}
                <label className="hc-field">
                  <span>Seat key</span>
                  <Input
                    autoFocus
                    id="resume-key-input"
                    className="hc-mono"
                    value={seatKey}
                    onChange={(event) => setSeatKey(event.target.value)}
                    placeholder="HC1:g_…"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={resume.error ? true : undefined}
                    required
                  />
                </label>
                <Button id="submit-resume-btn" type="submit" variant="primary" loading={resume.pending}>
                  Resume seat
                </Button>
              </fieldset>
            </form>
          </MenuRow>
        </div>

        <section className="hc-matches" aria-label="Matches">
          <h2 className="hc-section-label">Matches</h2>
          {props.gamesError ? (
            <div className="hc-retry-line" role="alert">
              <span>dohc could not load matches. {props.gamesError}</span>
              <Button size="sm" variant="ghost" onClick={props.reloadGames}>
                <RotateCcw size={13} aria-hidden="true" />
                Try again
              </Button>
            </div>
          ) : props.gamesLoading && recent.length === 0 ? (
            <div className="hc-match-skeleton" aria-busy="true" aria-label="Loading matches">
              <i />
              <i />
            </div>
          ) : recent.length === 0 ? (
            <p className="hc-empty-line">No matches yet.</p>
          ) : (
            <ul className="hc-match-list">
              {recent.map((game) => {
                const seated = props.seatedGameIds.has(game.id);
                return (
                  <li key={game.id} className="hc-match" data-current={props.activeGameId === game.id ? "true" : "false"}>
                    <span className="hc-match-crests" aria-hidden="true">
                      <FactionCrest seat={1} size={14} />
                      <FactionCrest seat={game.playerCount === 2 || game.status !== "waiting" ? 2 : null} size={14} />
                    </span>
                    <span className="hc-match-main">
                      <span className="hc-match-title" title={game.title}>
                        {game.title}
                      </span>
                      <span className="hc-match-meta" title={matchMeta(game)}>
                        {matchMeta(game)}
                      </span>
                    </span>
                    <span className={`hc-match-status hc-match-status-${game.status}`}>{statusText(game)}</span>
                    <span className="hc-match-actions">
                      {seated ? (
                        <Button size="sm" variant="secondary" onClick={() => props.onOpenGame(game.id)}>
                          {props.activeGameId === game.id ? "Back to match" : "Open"}
                        </Button>
                      ) : game.status === "waiting" ? (
                        <Button size="sm" onClick={() => onPanel("join")}>
                          Enter code
                        </Button>
                      ) : null}
                      {game.status === "finished" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="hc-match-replay"
                          aria-label={`Watch replay of ${game.title}`}
                          onClick={() => props.onWatchGame(game.id)}
                        >
                          <Eye size={14} aria-hidden="true" />
                          Replay
                        </Button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
