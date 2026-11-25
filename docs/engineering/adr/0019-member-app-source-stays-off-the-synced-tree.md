---
status: accepted
---

# Personal and Member app source stays off the synced workspace tree

This records a design from [the team apps and Collections plan](../plans/team-apps-and-collections.md).

In [the workspace members plan](../plans/workspace-members.md), Members cannot create folders or edit shared app source directly; changes to shared app source go to the Owner as a change proposal. At the same time, [AGENTS.md](../../../AGENTS.md) commits dohc to real, inspectable web apps whose source people and agents can read and continue.

Personal apps and local forks of Member apps live on disk in a dedicated local folder outside the synced received-workspace tree, with Open folder, Copy path, CLI verbs, and generated Collection types written into that folder. Because the folder sits outside the synced tree, unfinished personal experiments never clash with team files or require special sync-engine ignore rules, and any local coding agent can edit them as ordinary files.

When a Member or Admin shares a Member app to the workspace, the desktop uploads both the compiled bundle blobs and the declared source input blobs to the relay, verified byte for byte against the candidate digests. Teammates and their agents can inspect the source during first-open review and fork a copy into their own local Personal app folder, without any Member mutating the Owner's synced file tree. The relay never fills missing Member app blobs by looking up hashes in the workspace blob store, so a Member cannot expose bytes from hidden folders by naming their SHA-256 digests.

## Considered options

- **Open a direct non-Markdown file write lane inside the synced workspace (such as `apps/<member>/`).** Rejected for Phase 1. It changes the workspace members file-tree boundary and requires new direct-write admission rules in both the relay and the Rust engine before we know whether synced member app folders are needed.
- **Store Personal apps in a dot-folder or reserved subfolder inside the received workspace checkout.** Rejected. Dot-folders are classified as ignored by the engine path floor and refused by app publication validation, and a reserved subfolder name could collide with real folders in a workspace.
- **Upload only compiled bundle blobs when sharing a Member app.** Rejected. That turns a teammate's shared app into a black box that reviewers and agents cannot inspect or fork.

## Consequences

- Personal apps iterate locally with zero relay storage or quota churn until the author chooses to share them.
- Sharing a Member app counts both its compiled bundle and its source blobs against workspace storage quota and per-member upload limits.
- Forking a Member app copies its source into a new Personal app folder with no runtime coupling to the original author.
- Promoting a Member app into an official Workspace Publication means copying its inspected source into the Owner's workspace and publishing it through the Owner publication flow.
