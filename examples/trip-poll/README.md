# Trip poll example

This source-backed app asks for a destination and an optional name. It reads
shared responses and creates one response through the app collection broker.

The host sends a `MessageChannel` after the app loads. The app uses ordinary
React and ReactDOM. It does not import a dohc UI package or receive link
credentials. The host supplies authorization and the collection authority.

From the repository root, run:

```powershell
node apps/desktop/scripts/stage-trip-poll.mjs C:/path/to/workspace
```

The script creates `trip-poll` and refuses to overwrite an existing folder.
It copies the app source, installed React dependencies and their licenses,
the response collection schema, and an `app.publish.json` declaration.
Share the `trip-poll` folder and prepare it for publication in dohc.
Collection responses require the owner's approval and an enabled collection service.

`Retry response` sends the same key and fields after an uncertain save.
Keep the page open until the save is confirmed. Reloading loses this pending key.
`Discard pending response` unlocks the form but does not delete a response that was already saved.
Check shared responses before sending another. Quota refusals stop submission until the owner restores capacity and you reopen the poll.
`Refresh` reads other people's responses. `Show more responses` loads the next page.

The example does not enforce one vote per person. Names are optional, and
respondents can send another response. Authors can edit the app and schema to
fit their trip. Response editing and deletion are outside this example.
