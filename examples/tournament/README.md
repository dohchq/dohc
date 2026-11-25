# Tournament

This example runs a single- or double-elimination tournament on a dohc Collection. An organizer seeds a bracket, scorekeepers enter points court by court, and anyone with a link watches the bracket, the courts, and a big-screen board.

It is ordinary workspace source. Copy the folder, then change the rules, the screens, or the sports.

## What it shows

- **One Collection, five tables.** [schema.sql](schema.sql) holds `tournaments`, `players`, `courts`, `matches`, and `match_events`. [dataset.json](dataset.json) declares them and the fourteen operations.
- **Rules on the server.** [operations.js](operations.js) runs each operation in one transaction:
  - `createTournament` seeds 3 to 32 players into a bracket of 4, 8, 16, or 32, by rating or in the order given. Top seeds get the byes, and byes advance at once. The setup drawer lists players as editable rows in seed order. The organizer can add, remove, or move players, sort by rating, or paste a list.
  - Double elimination adds a losers bracket. Each loser drops to a set losers match. The grand final plays a reset match only when the losers-side player wins the first one.
  - A match is one game, or the best of 3 or 5 games. Scoring is rally scoring: the player who wins a point serves the next one.
  - `scorePoint` and `undoPoint` take the match version the scorekeeper saw. If someone else scored first, the operation refuses with `conflict` and the current score. `undoPoint` at 0–0 reopens the last game.
  - `completeMatch` records a won game. When a player has won enough games, it records the winner, updates both Elo ratings, frees the court, moves the winner on, and drops the loser to the losers bracket. The last match crowns the champion.
  - `awardWalkover` sends a player through when the other cannot play. Walkovers do not change Elo.
  - `reportResult` takes the game scores of a match played off the board, such as a score sheet a referee hands in. It checks each game against the rules, then completes the match like `completeMatch`. The log records who entered it, with no made-up points. Reopening a reported result puts the match back in the queue with no score, so a corrected sheet can be entered.
  - `reopenMatch` corrects a wrong result until the next match for either player has a point. It reverses both Elo changes and takes both players back out of their next matches. A next match that started at 0–0 goes back to waiting and frees its court. A next match with any result, a walkover included, blocks the reopen until that result is reopened first. A reopened match that was played on a court needs a free court again.
  - A unique index allows one live match per court. `startMatch` refuses a busy court. `returnToQueue` sends a started match with no points back to the queue and frees its court.
  - `moveMatch` moves a live match to a free court, for example when a court becomes unusable. It keeps the score, the server, and the start time, and takes the match version the scorekeeper saw.
  - Every start, point, undo, game, result, walkover, reopen, cancelled start, and court move goes into `match_events`, with who did it and who was playing.
- **Standings without SQL views.** `liveSnapshot` computes the leaderboard, bracket, courts, and recent events in one read. Players knocked out at the same stage share a place. Pass a `matchId` from the shown tournament and it adds that match's point-by-point timeline, without who entered each point.
- **One set of screens, two apps.** The organizer app ([index.tsx](index.tsx)) and the spectator app ([spectator/index.tsx](spectator/index.tsx)) share the views in `spectator/`:
  - **Bracket**: a canvas you drag to pan and zoom with Ctrl or pinch. Winners run along the top and losers below, with the grand final at the end. Empty slots say which match feeds them. Hover a player to trace their path, and select a match to open its timeline. Below 560px wide, it opens as a list of one round's matches under a strip of round tabs, on the first round with a live match. The canvas stays behind the Map button.
  - **Courts**: a scoreboard per live court with games, the server, and game, match, or championship point. Taps queue while earlier ones save, and points not yet saved show dimmed. Organizers score here.
  - **Standings**: a sortable table with win–loss, point difference, and Elo change, beside an Elo movers chart.
  - **TV mode**: a full-screen board for a venue screen. It says Out of date, with the last sync time, when it cannot reach the workspace.

  The spectator app keeps all of its source inside `spectator/`, so it publishes on a default View link.

## Who can do what

| Operation | Who |
| --- | --- |
| `liveSnapshot` | Anyone with a link. Link viewers and signed-in viewers see only tournaments shown on the share link. The owner and scorekeepers also see hidden ones. The spectator app always gets only shown tournaments and public history, without undone points or reopened results. |
| `matchLog`, `startMatch`, `returnToQueue`, `moveMatch`, `scorePoint`, `undoPoint`, `completeMatch`, `awardWalkover`, `reportResult`, `reopenMatch` | The owner and helpers. Scorekeepers correct results on purpose: whoever is at the court sees a wrong result first, and every reopen and walkover is logged with who did it. |
| `createTournament`, `setVisibility`, `seedDemo` | The owner |

`liveSnapshot` leaves out who entered each point. `matchLog` includes it.

## Try it

1. Copy this folder into a workspace as `tournament`.
2. Publish `tournament` and approve the Collection. The app opens empty.
3. Select **Load the 16-player demo**. It loads a double-elimination pickleball open, best of 3 games, with two matches live.
4. On **Courts**, select a side or press 1 or 2 to add a point, and Z to undo. Press C when a game is won, then Enter to record it. Start the next match from a free court or Up next. To move a live match, open it and pick a court under **Move to**. To fix a wrong result, select Reopen on the result notice, or open the match in the bracket. A match that cannot be played gets **Record a walkover** in the same panel.
5. Select **On share link** next to the event name to hide a tournament from spectators.
6. Publish `tournament/spectator` to a share link for read-only viewers. Its manifest, [spectator/app.publish.json](spectator/app.publish.json), binds only `liveSnapshot`.

## Keyboard

| Key | Action |
| --- | --- |
| B, C, S | Bracket, Courts, Standings |
| F | TV mode. Esc leaves it. |
| 1, 2 | Point to the left or right player on the selected court |
| Z | Undo the last point |
| C, then Enter | Record a won game or complete a won match |
| Tab | Next court |
| Arrows, +, −, 0 | Pan, zoom, and fit the bracket |

## Limits

- Both apps update the moment a score changes, on this computer and through a share link. The spectator app reads `liveSnapshot` every 5 seconds while visible until its first change event arrives, then on each change and every 15 seconds as a check. A scoring tap updates its match from the reply without another read.
- An operation may run 128 statements with 128 values each. `operations.js` loads a tournament once and writes it back in bulk, so a 32-player double-elimination bracket fits.

The tests are in [tournament-example.test.ts](../../packages/app-backend-runtime/src/tournament-example.test.ts). To typecheck the screens, run `pnpm exec tsc -p ../../examples/tournament/tsconfig.json` from `apps/desktop`.
