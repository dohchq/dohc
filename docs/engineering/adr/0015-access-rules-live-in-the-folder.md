---
status: accepted
---

# A folder's access rule lives in a file inside the folder

This records a planned design from [the workspace members plan](../plans/workspace-members.md). None of it is built yet.

An access rule decides which members reach a folder or a Group. We keep a folder's rule in an `access.yaml` file inside that folder. The owner edits it like any file. An admin changes it through the relay's checked write path that `collection.yaml` uses (see [direct Collection writes](../security-boundaries.md#direct-collection-writes-stay-narrow)). Members never see the file. It names people by a verified account email.

Folders have no lasting id. A rule kept anywhere else would have to follow a folder by its path. If someone renamed the folder outside dohc, for example in File Explorer, the rule would stop matching and the folder would open to every member. A file inside the folder moves with it, whatever renames it. The rule also stays a plain file the owner can read, back up, and export, which AGENTS.md commitment 1 asks for.

A Group's rule is saved on the Group, by the Group's lasting id. A Group is not a file. It records the folder it was created with, and that record does not follow a rename, so a rule in the Group's folder could separate from the Group and open it to every member. The Group's rule covers its messages. The Group's folder keeps its own `access.yaml`. Group settings never writes it, because the Group finds its folder by path, and more than one Group can record the same folder. Group settings shows that folder's rule and warns when members can reach the folder but not the Group.

## Considered options

- **The relay holds the rules and dohc gives folders lasting ids.** Rules would follow renames, but the engine would need folder identity first. That is more work than the members feature needs, and the rules would only be readable through dohc.
- **The relay holds the rules by path, and dohc updates them when it renames a folder.** Rejected. A rename outside dohc would show a restricted folder to every member.

## Consequences

- Access fails closed. If `access.yaml` cannot be read, members lose access to its folder, and the owner and admins still reach it.
- The relay takes a rule from the owner's log or from an admin's write on the checked path. An admin's change takes effect when the relay commits it. The relay alone vouches for the writer's role, so the owner's computer accepts `access.yaml` on that path. A member's write never changes a rule: a member cannot create, change, or delete an `access.yaml` file, directly or through a change proposal.
- The owner's computer sends a folder's `access.yaml` with or before the folder's other files, so a restricted folder is never briefly visible to members.
- An agent or tool the owner runs can change a rule by editing the file. History records that change like any other.
- Moving a folder keeps its own rule. Moving a file or a folder without a rule into another folder gives it that folder's rule.
