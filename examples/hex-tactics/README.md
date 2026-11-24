# HexClash

HexClash is a two-player turn-based hex strategy game built as a workspace example for dohc. It runs an authoritative SQLite game server inside one `formatVersion: 2` Collection and renders an interactive SVG axial hex board with `react`, `dohc/app`, `dohc/ui`, and `dohc/charts`.

## What it proves

- **Authoritative game state in SQLite:** All rules, turn ownership, combat math, supply income, and victory checks run inside one SQLite transaction per move in `operations.js`.
- **Server-side fog of war:** `getVisibleState` computes axial hex distance `<= 2` from the caller's owned tiles and strips terrain, ownership, unit counts, fortification flags, and out-of-range enemy moves before serializing JSON.
- **Private seat tokens and resume keys:** `createGame`, `joinGame`, and `startDemoMatch` derive 256-bit seat tokens from `ctx.secret` using SHA-256. The `player_token` column stays private in SQLite and is never returned by `listGames`, `getVisibleState`, or `replayGame`. Players can copy their private `HC1:...` seat key to reconnect after reloading the sandboxed app frame.
- **Hidden seeds and private join codes:** Live match seeds are generated server-side and withheld from `listGames` and active `getVisibleState` responses until the match ends. Join codes are returned only to seated players and omitted from the public match list.
- **Deterministic map and replay:** Maps use a seeded Mulberry32 generator with 180-degree rotational symmetry and BFS connectivity verification. Finished matches (and workspace owner spectators) unlock `replayGame` to scrub turn by turn from Turn 0 to victory.
- **Zero-deploy share links:** All seven operations use `access: "link"`, so a second player can join by 6-character join code from a phone browser through a published share link.

## Files

- `dataset.json`: Single multi-table `formatVersion: 2` Collection (`games`, `players`, `hex_tiles`, `moves`).
- `schema.sql`: SQLite tables, check constraints, foreign keys, and indexes (no views).
- `operations.js`: Isolated QuickJS server operations (`listGames`, `createGame`, `joinGame`, `startDemoMatch`, `getVisibleState`, `submitMove`, `replayGame`).
- `app.publish.json`: App manifest binding `hex-tactics/dataset.json` by operation name.
- `index.tsx`, `hex-board.tsx`, `replay.ts`, `types.ts`, `styles.css`: Interactive SVG board, pass-and-play demo flow, share-link join modals, turn log, and replay scrubber.
- `hex-tactics.test.mts`: Automated security, combat, fog-of-war, replay, and closed-compiler tests.

## Try it

1. Copy `examples/hex-tactics` into a dohc workspace folder named `hex-tactics`.
2. Stage the app and Collection with `dohc app stage`, then approve the staged review with `dohc app approveStaged` using the returned `stageId` and `reviewDigest` (or use Review app in dohc).
3. Open the app and click **Start 2-Player Demo Match**, then switch between Seat 1 and Seat 2 to watch server-side fog of war shift in real time.

## Run tests

Install Playwright's Chromium binary once if it is not already present, then run the suite:

```bash
pnpm exec playwright install chromium
pnpm exec vitest run examples/hex-tactics/hex-tactics.test.mts
```
