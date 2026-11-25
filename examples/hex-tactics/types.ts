export type TerrainType = "capital" | "plains" | "gold" | "forest" | "mountain";
export type GameStatus = "waiting" | "active" | "finished";
export type WinReason = "capital_captured" | "resignation";
export type ActionType = "march" | "fortify" | "reinforce" | "pass" | "resign";

export interface GameSummary {
  readonly id: string;
  readonly joinCode?: string | null;
  readonly title: string;
  readonly seed: number | null;
  readonly radius: number;
  readonly status: GameStatus;
  readonly turnNumber: number;
  readonly activeSeat: 1 | 2;
  readonly playerCount?: number;
  readonly players?: ReadonlyArray<{ readonly seat: 1 | 2; readonly name: string; readonly color: string }>;
  readonly winnerSeat: 1 | 2 | null;
  readonly winReason: WinReason | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface PlayerPublicState {
  readonly id?: string;
  readonly seat: 1 | 2;
  readonly name: string;
  readonly color: "crimson" | "cobalt";
  readonly gold: number | null;
  readonly tileCount: number | null;
  readonly unitCount: number | null;
}

export interface VisibleTile {
  readonly q: number;
  readonly r: number;
  readonly visible: boolean;
  readonly terrain: TerrainType | null;
  readonly ownerSeat: 1 | 2 | null;
  readonly units: number | null;
  readonly fortified: boolean;
}

export interface SupplyOutcome {
  readonly nextSeat: 1 | 2;
  readonly goldAdded: number;
  readonly supplyUpdates: ReadonlyArray<{ readonly q: number; readonly r: number; readonly addedUnits: number }>;
}

export interface MoveOutcome {
  readonly action?: ActionType;
  readonly kind?: "transfer" | "combat";
  readonly attackerUnits?: number;
  readonly defenderUnits?: number;
  readonly terrainBonus?: number;
  readonly fortifyBonus?: number;
  readonly defensePower?: number;
  readonly attackerLosses?: number;
  readonly defenderLosses?: number;
  readonly captured?: boolean;
  readonly claimed?: boolean;
  readonly capitalCaptured?: boolean;
  readonly newToUnits?: number;
  readonly newToFortified?: boolean;
  readonly goldSpent?: number;
  readonly unitsAdded?: number;
  readonly supply?: SupplyOutcome;
  readonly summary: string;
}

export interface MoveRecord {
  readonly turnNumber: number;
  readonly actorSeat: 1 | 2 | null;
  readonly actionType: ActionType | "hidden";
  readonly fromHex: string | null;
  readonly toHex: string | null;
  readonly unitsMoved: number | null;
  readonly outcome: MoveOutcome;
  readonly hidden?: boolean;
  readonly createdAtMs: number;
}

export interface VisibleBoardState {
  readonly game: GameSummary;
  readonly viewer: {
    readonly seat: 1 | 2 | null;
    readonly spectator: boolean;
    readonly visionRange: number;
    readonly visibleTiles: number;
    readonly foggedTiles: number;
  };
  readonly players: readonly PlayerPublicState[];
  readonly tiles: readonly VisibleTile[];
  readonly recentMoves: readonly MoveRecord[];
}

export interface SeatCredential {
  readonly seat: 1 | 2;
  readonly playerId: string;
  readonly name: string;
  readonly color: "crimson" | "cobalt";
  readonly playerToken: string;
}

export interface StartDemoReply {
  readonly gameId: string;
  readonly joinCode: string;
  readonly title: string;
  readonly seats: readonly SeatCredential[];
}

export interface CreateGameReply {
  readonly gameId: string;
  readonly joinCode: string;
  readonly seat: 1;
  readonly playerId: string;
  readonly playerName: string;
  readonly playerToken: string;
}

export interface JoinGameReply {
  readonly gameId: string;
  readonly joinCode: string;
  readonly seat: 2;
  readonly playerId: string;
  readonly playerName: string;
  readonly playerToken: string;
}

export interface SubmitMoveReply {
  readonly turnExecuted: number;
  readonly outcome: MoveOutcome;
  readonly state: VisibleBoardState;
}

export interface ReplayInitialTile {
  readonly q: number;
  readonly r: number;
  readonly terrain: TerrainType;
  readonly ownerSeat: 1 | 2 | null;
  readonly units: number;
  readonly fortified: boolean;
}

export interface ReplayPayload {
  readonly game: GameSummary;
  readonly startingGold: number;
  readonly players: ReadonlyArray<{
    readonly seat: 1 | 2;
    readonly name: string;
    readonly color: "crimson" | "cobalt";
    readonly finalGold: number;
  }>;
  readonly initialTiles: readonly ReplayInitialTile[];
  readonly moves: readonly MoveRecord[];
  readonly nextAfterTurn: number | null;
}
