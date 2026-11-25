import type { JoinGameReply, SeatCredential } from "./types";

export interface StoredMatchSession {
  readonly gameId: string;
  readonly joinCode: string | null;
  readonly seats: readonly SeatCredential[];
  readonly activeSeat: 1 | 2;
}

export function withJoinedSeat(existing: StoredMatchSession | undefined, data: JoinGameReply, focus: boolean): StoredMatchSession {
  const seat2: SeatCredential = { seat: 2, playerId: data.playerId, name: data.playerName, color: "cobalt", playerToken: data.playerToken };
  const seats = existing ? [...existing.seats.filter((s) => s.seat !== 2), seat2] : [seat2];
  return { gameId: data.gameId, joinCode: data.joinCode, seats, activeSeat: focus ? 2 : (existing?.activeSeat ?? 2) };
}
