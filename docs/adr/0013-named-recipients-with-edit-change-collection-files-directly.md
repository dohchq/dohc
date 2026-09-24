# A named recipient with Edit changes a Collection's own files directly

Status: accepted September 25, 2026. It amends [ADR 0002](0002-edit-access-is-multiplayer.md), whose consequence "change proposals remain the only lane for bulk and file-tree changes" now has one exception.

[ADR 0012](0012-automations-reach-only-what-their-editors-share.md) lets anyone who can edit a Collection change its automations. A Collection keeps its schema in `collection.yaml` and its automations in `automations.yaml`. Neither is a live document, so a recipient's change to either reached the owner only as a change proposal, and every automation or field change waited for the owner to accept it.

We decided that a named recipient whose grant carries Edit on a Collection's folder changes that Collection's `collection.yaml` and `automations.yaml` without a proposal. The same recipient can create a new Collection, with its first records, inside a shared folder. The recipient's other changes, including deletes, renames, and every other file, stay on proposals. Link holders do not get this lane, and a grant that came from a share link does not get it until the owner promotes it.

As in ADR 0002, the lane depends on its safeguards. The relay checks the grant and its generation when it commits each write, and refuses a write whose base is not the current file or whose content is not a valid schema or automations file. It records the recipient's user and grant as the author. The owner can stop the person and restore every file they changed. The lane stays off until stop and restore works end to end.

The two checks draw different lines. The owner's engine accepts that author per file: a write to a Collection's own `collection.yaml` or `automations.yaml`, or a new `.md` record in a folder that holds `collection.yaml`. The relay narrows each request further, to an in-place edit of one of those files or a batch that creates one new Collection.

## Considered options

- Keep these files on proposals. The owner then approves every automation change, which is the approval step ADR 0012 rejected.
- Make both files live documents. Live editing merges concurrent keystrokes, and a merge of two valid YAML files can be invalid or describe an automation neither person wrote. These files need a whole-file check before they take effect.
- Open the lane to every file under Edit. The relay can check a schema or an automations file before it commits it, but not an arbitrary file. Code files that automations run stay on proposals for the same reason.
- Include link holders. A share link can reach people the owner never chose, and a link principal names a browser, not a person. ADR 0002 already gives link holders no file-tree operations.

## Consequences

- An owner can find a schema or an automation changed by someone they shared with, without having accepted anything. History names that person, and stop and restore undoes their changes.
- Two people who write the same file at once cannot both win. At the relay, the second write is refused as stale and its author keeps their text. An owner's edit that the relay has not received yet becomes a conflict on the owner's computer.
- A refused direct write never turns into a proposal on its own. The person chooses to send it as one.
