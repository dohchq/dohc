# HexClash

HexClash is a two-player turn-based hex strategy game built as a workspace example for dohc. It runs an authoritative SQLite game server inside one `formatVersion: 2` Collection and renders an interactive SVG axial hex board with `react`, `dohc/app`, `dohc/ui`, and `dohc/charts`.

## What it proves

- **Authoritative game state in SQLite:** All rules, turn ownership, combat math, supply income, and victory checks run inside one SQLite transaction per move in `operations.js`.
- **Server-side fog of war:** `getVisibleState` computes axial hex distance `<= 2` from the caller's owned tiles and strips terrain, ownership, unit counts, fortification flags, and out-of-range enemy moves before serializing JSON. When only the destination of an enemy march is in vision, the move keeps its destination and unit count but drops its origin, so a defender learns how many units hit them but not where they came from.
- **Private seat tokens and resume keys:** `createGame`, `joinGame`, and `startDemoMatch` derive 256-bit seat tokens from `ctx.secret` using SHA-256. The `player_token` column stays private in SQLite and is never returned by `listGames`, `getVisibleState`, or `replayGame`. Players can copy their private `HC1:...` seat key to reconnect after reloading the sandboxed app frame.
- **Hidden seeds and private join codes:** Live match seeds are generated server-side and withheld from `listGames` and active `getVisibleState` responses until the match ends. Join codes are returned only to seated players and omitted from the public match list.
- **Deterministic map and replay:** Maps use a seeded Mulberry32 generator with 180-degree rotational symmetry and BFS connectivity verification. In the app, `replayGame` and the spectator view open when a match ends. Before that, they open only to a caller who passes both seat keys in `playerTokens`, since that caller can already see both sides. The app itself never sends both keys; this path is for agents and scripts that call the operations through the CLI or MCP. Fog protects the players from each other inside the app. It does not hide the match from the host: the host's workspace stores the raw match data in the HexClash Collection.
- **Zero-deploy share links:** All seven operations use `access: "link"`, so a second player can join by 6-character join code from a phone browser through a published share link.

## Files

- `dataset.json`: Single multi-table `formatVersion: 2` Collection (`games`, `players`, `hex_tiles`, `moves`).
- `schema.sql`: SQLite tables, check constraints, foreign keys, and indexes (no views).
- `operations.js`: Isolated QuickJS server operations (`listGames`, `createGame`, `joinGame`, `startDemoMatch`, `getVisibleState`, `submitMove`, `replayGame`).
- `app.publish.json`: App manifest binding `hex-tactics/dataset.json` by operation name.
- `index.tsx`: Game shell, queries, turn flow, keyboard shortcuts, and the pass-and-play hand-off.
- `hud.tsx`, `dock.tsx`, `dialogs.tsx`: Top bar and seat toggle, end-turn and victory controls, notices, and the invite and resign dialogs.
- `hex-board.tsx`, `board-art.tsx`, `geometry.ts`: SVG board, terrain and unit art, move, claim, and attack marks, the last-move arrow, and hex math.
- `panels.tsx`, `lobby.tsx`: Tile card, combat preview, battle log and replay drawer, hand-off cover, and the lobby.
- `selection.ts`, `orders.ts`: The selected stack and locked target, and the march targets and forecasts derived from them.
- `sessions.ts`: Seats held on this device and which matches the Game menu lists.
- `rules.ts`: Client copy of the combat math for the preview. Tests check it against real server outcomes.
- `replay.ts`, `use-replay.ts`, `types.ts`, `styles.css`: Replay frames and playback, shared types, and light and dark themes.
- `hex-tactics.test.mts`: Automated security, combat, fog-of-war, replay, and closed-compiler tests.

## Try it

1. Copy `examples/hex-tactics` into a dohc workspace folder named `hex-tactics`.
2. Stage the app and Collection with `dohc app stage`, then approve the staged review with `dohc app approveStaged` using the returned `stageId` and `reviewDigest` (or use Review app in dohc).
3. Open the app and click **Start demo match**. Select a stack, then click or tap a highlighted hex to lock it and read the combat forecast. Click or tap it again, press Enter, or use the order button to send it. A second tap within 400 ms of locking is ignored, so a double tap never sends an order you have not seen. Between turns, a cover hides the board until the next player clicks **Show map**.

Keyboard: arrow keys move the cursor. Enter or Space selects a stack and locks a target hex. Enter on the locked target sends the order; Space never does. Escape clears, and E ends the turn once no target is locked.

## Run tests

Install Playwright's Chromium binary once if it is not already present, then run the suite:

```bash
pnpm exec playwright install chromium
pnpm exec vitest run examples/hex-tactics/hex-tactics.test.mts
```
