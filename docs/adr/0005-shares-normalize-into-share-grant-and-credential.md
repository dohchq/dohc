# Shares normalize into share, grant, and link credential

The original relay model stored one row per grant: one share id, one recipient, access inside the selector, one revocation timestamp. That row cannot represent a share link's lifecycle: a link that rotates its secret independently, changes level in place, and converts holders into named grantees who join the same share, discussion, and history. Mutating the row consumes the link; copying it forks the share.

We replaced the model instead of extending it. A **share** owns the workspace, selector scope, discussion, and history. A **grant** owns its principal kind, access, generation, status, and timestamps. A **link credential** owns a secret hash and rotation metadata for one link grant. A grant named through "Open in dohc" stays dependent on its parent link grant (rotation and revoke reach it) until the owner promotes it explicitly. Access moves from the selector to the grant; every derived credential and session binds to `{grant, generation, access}` and is rechecked at the authoritative mutation transaction. Raising a link's level mints a new secret, so a leaked View URL can never silently become a write credential.

dohc is pre-launch, so this replaces the old rows outright: no nullable fields, no compatibility paths. The TS and Rust engines still receive one effective selector plus access after the server resolves the grant; they never see credentials or principal records.

## Consequences

For View links, the relay materializes the accepted current file state per workspace version. Each listing and blob read derives authority from that projection, so a move, deletion, epoch reset, or different-object recreation cannot leave an old digest readable. Rotation and widening advance the link generation, invalidate existing sessions, and mint a new URL. Narrowing keeps the generation and current URL; each request derives the grant's current access, so existing sessions immediately lose the removed authority. Narrowing still advances dependent grant generations and reduces any dependent access above the new level. Revocation advances the generation and ends access. Phase 4 adds the corresponding append-time access, selector, and generation races.

Promotion is not part of the View slice. Phase 3 adds the permanent promotion warning and the visible reverse path: revoke the named grant itself.
