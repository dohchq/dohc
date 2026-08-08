# Identity model: accounts are spheres, workspaces are projects

Decision, Ice, 2026-08-07. Settles #690, reshapes #648, and gives #356 and
#646 their identity foundation.

## The model

dohc has three layers, and each answers a different question.

| Layer | Question it answers | Analogy |
| --- | --- | --- |
| dohc account | Which sphere of life is acting — work-me or home-me? | An email address |
| dohc profile | Where does that sphere live on this machine? | A Chrome profile |
| Workspace | Which project is this? | A repo, a vault |

A person is expected to hold one dohc account per sphere of life, the way
they hold a work email and a personal email. This is the recommended
convention, not a requirement: one account with many workspaces stays fully
supported, and no feature may force a second account.

Workspaces stay project-sized. They do not carry the work/personal split;
the account does. A user with five personal workspaces and three work
workspaces holds them under two accounts, not eight spheres.

## Two boundaries, two jobs

The word "boundary" was doing two jobs in #690. The decision splits them.

**The OS user is the trust boundary.** Everything dohc stores on a machine
belongs to the OS login that put it there, and dohc does not wall stores
from each other inside one OS user. This statement is about isolation
between profile stores, not about other OS users: a different OS login
with access to a workspace directory stays an attacker, and the engine's
defenses against one (symlink containment, daemon access control — see
the rust-engine decision record) are unchanged by this model. This matches every file-on-disk peer
(Obsidian, Dropbox, OneDrive, git) and dohc's own rule that a workspace is
the user's files first. A Chrome profile does not protect its folder from
the other profiles either — any process the OS user runs can read them all.
Per-account encryption or per-store account gates are declined; do not
build them. Declined means encryption as an isolation boundary between
accounts. Secret storage is untouched: credentials stay sealed at rest
(Electron `safeStorage`), as they are today.

**The dohc account is the organizational boundary, implemented as
profiles.** Each account gets its own profile: its own data directory
holding that account's workspace list, credentials, drafts, ui-state, and
DM home map. Signing into an account means being in its profile. Another
account's workspaces are not hidden by security — they are simply not part
of this profile, the way another Chrome profile's tabs are not in this
window.

Local use needs no account, so a signed-out install runs in a local
profile that no account owns — profiles do not gate local work on
authentication. What first sign-in does with that local profile (attach
the account to it, or keep it separate) is decided with the profile
switcher build; either way the user's existing local workspaces stay
visible to them.

Consequence: today's behavior — switch accounts and still see the previous
account's whole workspace list — is wrong by design, not by taste. The fix
is the profile switcher, not credential filters bolted onto shared stores.
Profiles replace list filtering only. Remote-to-session authorization
checks — such as the credential match a workspace remote must pass before
a token attaches — remain.

## What this settles

- **#690** — closed with this decision. No per-store account scoping. The
  future build is a lightweight profile switcher (Chrome's avatar menu
  shape, one data directory per account). Post-sweep, structural.
- **#648** — superseded. DMs stop auto-joining. An incoming DM becomes a
  request; accepting it picks the workspace it lives in, defaulting to a
  per-account default. "Move this DM" is re-running that picker. The
  sphere question is already answered by which account the sender wrote
  to, as with email. An account-level DM inbox that lives outside every
  workspace is worth real consideration — evaluate it inside the sync
  program (#356), where chat storage is rethought anyway. Today every
  chat is scoped to a workspace; adopting that inbox means either
  revising that invariant explicitly or keeping the inbox to request
  metadata while chat state stays in a workspace.
- **#646 / #356** — sharing across spheres is ordinary sharing to another
  account, like sending a Google Doc to an outside address. No
  cross-sphere machinery inside one account. Today that holds for
  accounts on the same relay deployment; sharing across deployments
  (separate cloud or self-hosted relays) is its own question for the
  sync program, not something this decision rules in or out.

## What this forbids

- An in-app multi-account switcher that mixes accounts inside one profile
  (the Slack shape). Accounts switch by switching profiles.
- Features that assume one account spans work and personal.
- Per-store account walls inside a profile directory.
