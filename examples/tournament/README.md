# Tournament

This example runs a single-elimination tournament on a dohc Collection. An organizer seeds a bracket, scorekeepers enter points court by court, and anyone with a link watches the bracket, the courts, and a big-screen board.

It is ordinary workspace source. Copy the folder, then change the rules, the screens, or the sports.

## What it shows

- **One Collection, five tables.** [schema.sql](schema.sql) holds `tournaments`, `players`, `courts`, `matches`, and `match_events`. [dataset.json](dataset.json) declares them and the eight operations.
- **Rules on the server.** [operations.js](operations.js) runs each operation in one transaction:
  - `createTournament` seeds 3 to 32 players by rating into a bracket of 4, 8, 16, or 32. Top seeds get the byes, and byes advance at once.
  - `scorePoint` and `undoPoint` take the match version the scorekeeper saw. If someone else scored first, the operation refuses with `conflict` and the current score.
  - `completeMatch` records the winner, updates both Elo ratings, frees the court, and moves the winner into the next match. The final crowns the champion.
  - A unique index allows one live match per court. `startMatch` refuses a busy court.
  - Every start, point, undo, and result goes into `match_events`, with who did it.
- **Standings without SQL views.** `liveSnapshot` computes the leaderboard, bracket, courts, and recent events in one read.
- **Three ways to watch.** The organizer app ([index.tsx](index.tsx)) has the scorekeeper board, the bracket, standings, and a TV board. The spectator app ([spectator/index.tsx](spectator/index.tsx)) shows the same views read-only and keeps all of its source inside `spectator/` so it publishes on a default View link.

## Who can do what

| Operation | Who |
| --- | --- |
| `liveSnapshot` | Anyone with a link |
| `matchLog`, `startMatch`, `scorePoint`, `undoPoint`, `completeMatch` | The owner and helpers |
| `createTournament`, `seedDemo` | The owner |

`liveSnapshot` leaves out who entered each point. `matchLog` includes it.

## Try it

1. Copy this folder into a workspace as `tournament`.
2. Publish `tournament` and approve the Collection. The app opens empty.
3. Select **Load the 16-player demo**. It loads a pickleball open in the quarterfinals, with two matches live.
4. On **Scorekeeper**, tap a player to add a point. Complete a match when it is won, then start the next one on the free court.
5. Publish `tournament/spectator` to a share link for read-only viewers. Its manifest, [spectator/app.publish.json](spectator/app.publish.json), binds only `liveSnapshot`.

## Limits

- The apps poll `liveSnapshot` every 4 seconds (organizer) or 5 seconds (spectator), and pause while hidden. A scoring tap updates its match from the reply without another read.
- An operation may run 128 statements with 128 values each. `operations.js` loads a tournament once and writes it back in bulk, so a 32-player bracket fits.

The tests are in [tournament-example.test.ts](../../packages/app-backend-runtime/src/tournament-example.test.ts). To typecheck the screens, run `pnpm exec tsc -p ../../examples/tournament/tsconfig.json` from `apps/desktop`.
