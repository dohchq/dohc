---
status: accepted
---

# Access rules live in a file inside the folder they control

This records a planned design from [the workspace members plan](../plans/workspace-members.md). None of it is built yet.

An access rule decides which members reach a folder or a Group. We keep each rule in an `access.yaml` file inside the folder it controls. A Group's rule lives in the Group's folder. The relay trusts only the copy in the owner's workspace. The owner and admins change it through the checked write path that `collection.yaml` uses (see [direct Collection writes](../security-boundaries.md#direct-collection-writes-stay-narrow)). Members never see the file. It names people by their email.

Folders have no lasting id. A rule kept anywhere else would have to follow a folder by its path. If someone renamed the folder outside dohc, for example in File Explorer, the rule would stop matching and the folder would open to every member. A file inside the folder moves with it, whatever renames it. The rule also stays a plain file the owner can read, back up, and export, which AGENTS.md commitment 1 asks for.

## Considered options

- **The relay holds the rules and dohc gives folders lasting ids.** Rules would follow renames, but the engine would need folder identity first. That is more work than the members feature needs, and the rules would only be readable through dohc.
- **The relay holds the rules by path, and dohc updates them when it renames a folder.** Rejected. A rename outside dohc would show a restricted folder to every member.

## Consequences

- Access fails closed. If `access.yaml` cannot be read, members lose access to its folder, and the owner and admins still reach it.
- The relay must take a rule only from the owner's log, never from a member's write. A member with Edit cannot create, change, or delete an `access.yaml` file.
- An agent or tool the owner runs can change a rule by editing the file. History records that change like any other.
- Moving a folder keeps its own rule. Moving a file or a folder without a rule into another folder gives it that folder's rule.
