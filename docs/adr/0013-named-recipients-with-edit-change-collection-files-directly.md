# Edit changes a Collection's own files directly

Status: accepted September 25, 2026, and amended September 27, 2026 to include share links with Edit. It amends [ADR 0002](0002-edit-access-is-multiplayer.md), whose consequence "change proposals remain the only lane for bulk and file-tree changes" now has one exception.

[ADR 0012](0012-automations-reach-only-what-their-editors-share.md) lets anyone who can edit a Collection change its automations. A Collection keeps its schema in `collection.yaml` and its automations in `automations.yaml`. Neither is a live document, so a recipient's change to either reached the owner only as a change proposal, and every automation or field change waited for the owner to accept it.

We decided that a named recipient whose grant carries Edit on a Collection's folder changes that Collection's `collection.yaml` and `automations.yaml` without a proposal. The same recipient can create a new Collection, with its first records, inside a shared folder. The recipient's other changes, including deletes, renames, and every other file, stay on proposals. A named grant that came from a share link does not get the lane until the owner promotes it.

A share link whose grant carries Edit on a Collection's folder gets the same lane, whether a browser or an agent holds it. The link's grant is the author of each write, and the link principal is recorded beside it to tell browser sessions apart. Neither the person who made the link nor an account signed in to the browser becomes the author, and a name the link holder claims stays unverified. A link holder cannot send a proposal, so a write the lane refuses stays refused.

As in ADR 0002, the lane depends on its safeguards. The relay checks the grant and its generation when it commits each write, and refuses a write whose base is not the current file or whose content is not a valid schema or automations file. It records the author: the recipient's user and grant, or the link's grant and principal. The owner can stop the person or revoke the link, and restore every file they changed. Each kind of author gets the lane only once stop and restore for that kind works end to end. It is part of Edit on every relay, not a setting a relay operator turns on.

The two checks draw different lines. The owner's engine accepts either author only from the relay's origin for that author's grant, and per file: a write to a Collection's own `collection.yaml` or `automations.yaml`, or a new `.md` record in a folder that holds `collection.yaml`. The relay narrows each request further, to an in-place edit of one of those files or a batch that creates one new Collection.

## Considered options

- Keep these files on proposals. The owner then approves every automation change, which is the approval step ADR 0012 rejected.
- Make both files live documents. Live editing merges concurrent keystrokes, and a merge of two valid YAML files can be invalid or describe an automation neither person wrote. These files need a whole-file check before they take effect.
- Open the lane to every file under Edit. The relay can check a schema or an automations file before it commits it, but not an arbitrary file. Code files that automations run stay on proposals for the same reason.
- Keep link holders out, as this decision first did. A share link can reach people the owner never chose, and a link principal names a browser, not a person. But an Edit link already lets anyone who holds it co-edit the share's live documents, and an agent given the link should be able to do what a person given it can. A link holder also has no proposal to fall back on, so keeping links out left their schema and automation changes with no lane at all.

## Consequences

- An owner can find a schema or an automation changed by someone they shared with, or through an Edit link, without having accepted anything. History names the person, or the link holder and the link's grant, and stop and restore undoes their changes.
- A leaked Edit link lets anyone who holds it change these files within the link's reach. History cannot say which person held the link, only which browser session wrote. Revoking the link stops every holder at once.
- Each Edit link counts as its own editor of the Collection's automations for ADR 0012's reach. It never merges with the person who made it, with a named recipient, or with another link.
- Two people who write the same file at once cannot both win. At the relay, the second write is refused as stale and its author keeps their text. An owner's edit that the relay has not received yet becomes a conflict on the owner's computer.
- A refused direct write never turns into a proposal on its own. A named recipient chooses to send it as one.
