# Share grant state machine

Reader: the relay implementer who stores grants, issues credentials, and checks mutations.

A share owns one immutable selector. It can hold many grants at the same time, including many link grants. Each grant changes independently unless it depends on a parent link grant.

Share access has this order: View, Comment, Edit. Every grant starts at generation 1. Every transition that changes authority increments the generation in the same transaction.

Every derived credential and open session carries a `GrantBinding` with `grantId`, `generation`, and `access`. The authoritative mutation transaction loads the current grant and compares the full binding. It also loads the parent link grant for a dependent user grant. A mismatch refuses the mutation. Closing an open connection can reduce delay, but it is not the authorization check.

## Record invariants

- An active grant has `status: "active"` and `revokedAt: null`.
- A revoked grant has `status: "revoked"` and a `revokedAt` timestamp.
- Only a user grant created by conversion can have `parentGrantId`.
- A link credential belongs to one link grant and one generation.
- A link grant has at most one current credential. A current credential has `retiredAt: null`.
- A revoked grant is terminal. No transition can reactivate it.
- No transition changes the share selector.

## Transitions

| Transition | Preconditions | Atomic record changes | Credentials and sessions |
| --- | --- | --- | --- |
| Create user | The share exists and the owner names a user. | Create an active user grant at generation 1. Set `parentGrantId` and `revokedAt` to null. | No credential exists yet. New sessions bind to generation 1 and the granted access. |
| Create email | The share exists and the owner names an email. | Create an active email grant at generation 1. Set `parentGrantId` and `revokedAt` to null. | No credential exists yet. A claimed invite uses this grant and its current binding. |
| Create link | The share exists and the owner requests a link. | Create an active link grant at generation 1. Create its first current link credential with a new secret. | The URL carries the new secret. New sessions bind to generation 1 and the granted access. |
| Narrow access | The grant is active and the requested access is lower. | Change access in place and increment the generation. For a link grant, move the current credential to the new generation without changing its secret. Narrow each active dependent user grant if its access is now too wide, and increment every active dependent grant generation. | The existing link URL stays valid at the narrower access. Every old binding for the grant or an affected dependent grant fails its next commit-time check. |
| Widen named access | The user or email grant is active and the requested access is higher. A dependent user grant cannot exceed its active parent link grant. | Change access in place and increment the generation. | No link credential changes. Every old binding for the grant fails its next commit-time check. |
| Widen link access | The link grant is active and the requested access is higher. | Change access in place and increment the generation. Retire the current credential. Create a current credential with a new secret for the new generation. Increment every active dependent user grant generation. Do not widen dependent access automatically. | The old URL stops working. The new URL carries the higher access. Old bindings for the link grant and its dependent grants fail their next commit-time check. |
| Rotate | The link grant is active. | Keep access unchanged and increment the generation. Retire the current credential. Create a current credential with a new secret. Increment every active dependent user grant generation. | The old URL stops working. Old bindings for the link grant and its dependent grants fail their next commit-time check. |
| Revoke | The grant is active. | Set status to revoked, set `revokedAt`, and increment the generation. If it is a link grant, retire its current credential. Revoke each active dependent user grant and increment each dependent generation. | No credential can derive new authority. Every old binding for the grant or an affected dependent grant fails its next commit-time check. Committed work remains in history. |
| Convert | The holder has an active link grant and explicitly accepts after signing in. | Create an active user grant at generation 1. Set its access to the link grant's current access. Set `parentGrantId` to the link grant ID and `revokedAt` to null. | The link credential and existing link sessions do not change. New named sessions bind to the new user grant. Parent transitions continue to reach this grant. |
| Promote | The owner selects an active user grant with `parentGrantId` set. | Keep the current access, clear `parentGrantId`, and increment the user grant generation. | Every old binding for the user grant fails its next commit-time check. Later changes to the former parent link grant do not affect it. |

## Refused transitions

The relay refuses these requests without changing a record:

- Any transition from a revoked grant.
- Rotate on a user or email grant.
- Convert from a user or email grant.
- Convert from a revoked link grant.
- Promote a link grant, an email grant, or an independent user grant.
- Widen a dependent user grant above its parent link grant's current access.
- Narrow to the current access or widen to the current access. These are not transitions.
- Change a share selector after share creation.
- Expire a grant. Version 1 has no expiry field or expiry transition. Owners use revoke instead.

Creating another grant is always a new create transition. It does not replace an existing grant. This rule permits mixed access levels and several independent links on one share.
