import type { JoinGameReply, SeatCredential } from "./types";

export interface StoredMatchSession {
  readonly gameId: string;
  readonly joinCode: string | null;
  readonly seats: readonly SeatCredential[];
  readonly activeSeat: 1 | 2;
}

export function withSeat(
  existing: StoredMatchSession | undefined,
  gameId: string,
  joinCode: string | null,
  credential: SeatCredential,
  focus: boolean,
): StoredMatchSession {
  const seats = existing
    ? [...existing.seats.filter((s) => s.seat !== credential.seat), credential]
    : [credential];
  return {
    gameId,
    joinCode,
    seats,
    activeSeat: focus ? credential.seat : (existing?.activeSeat ?? credential.seat),
  };
}

export function withJoinedSeat(
  existing: StoredMatchSession | undefined,
  data: JoinGameReply,
  focus: boolean,
): StoredMatchSession {
  const seat2: SeatCredential = {
    seat: 2,
    name: data.playerName,
    color: "cobalt",
    playerToken: data.playerToken,
  };
  return withSeat(existing, data.gameId, data.joinCode, seat2, focus);
}

export function lobbyMatches<T extends { readonly id: string }>(
  games: readonly T[],
  seated: ReadonlySet<string>,
  publicLimit: number,
): T[] {
  const shown = new Set(games.filter((game) => !seated.has(game.id)).slice(0, publicLimit));
  return games.filter((game) => seated.has(game.id) || shown.has(game));
}
