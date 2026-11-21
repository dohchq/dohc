---
status: accepted
---

# A folder's access rule lives in a file inside the folder

This records a planned design from [the workspace members plan](../plans/workspace-members.md). None of it is built yet.

An access rule decides which members reach a folder or a Group. We keep a folder's rule in an `access.yaml` file inside that folder. Only the owner changes it, and edits it like any file. Admins read it; members never see it. It names people by account email, and only a verified email matches a person.

Folders have no lasting id. A rule kept anywhere else would have to follow a folder by its path. If someone renamed the folder outside dohc, for example in File Explorer, the rule would stop matching and the folder would open to every member. A file inside the folder moves with it, whatever renames it. The rule also stays a plain file the owner can read, back up, and export, which AGENTS.md commitment 1 asks for.

A Group's rule is kept by the server with the Group's people and the member level. The server keys it by the Group's lasting id. A Group is not a file. It records the folder it was created with, and that record does not follow a rename, so a rule in the Group's folder could separate from the Group and open it to every member. The Group's rule covers its messages. The Group's folder keeps its own `access.yaml`. Changing a Group's rule never changes it, because the Group finds its folder by path, and more than one Group can record the same folder. Group settings names that folder, links to it, and says that its files follow that folder's own access rule.

## Considered options

- **The relay holds the rules and dohc gives folders lasting ids.** Rules would follow renames, but the engine would need folder identity first. That is more work than the members feature needs, and the rules would only be readable through dohc.
- **The relay holds the rules by path, and dohc updates them when it renames a folder.** Rejected. A rename outside dohc would show a restricted folder to every member.
- **The relay holds the rules, changed through one operation, and the folder holds a marker file with the rule's id.** The marker follows a rename, and a missing or unknown marker leaves the folder restricted. The engine would not need to hold half-written rule files, and no second parser would run on the owner's computer. Not chosen in November 2026: editing the file would no longer change access, a change would need a connection, and the rule file pieces were already built. Reconsider it if admins must change folder rules.

## Consequences

- Access fails closed. If `access.yaml` cannot be read, members lose access to its folder, and the owner and admins still reach it.
- The relay takes a rule only from the owner's log. No other writer changes a rule: an admin or member cannot create, change, or delete an `access.yaml` file, directly or through a change proposal.
- The owner's computer sends a folder's `access.yaml` with or before the folder's other files, so a restricted folder is never briefly visible to members. One gap is accepted: the owner changes a folder's rule on one computer and adds a file to that folder on another. If the file reaches the relay before the rule does, members can see it until the rule arrives. The relay then hides the file and its history. Closing it would hold every new owner file from members, and a rule written offline would still miss.
- At first share, the engine sends earlier history split at each unresolved conflict, and moves a rule across a split only where that gives nobody more over a file it passes. A rule whose own file a pending conflict names stays on its side, because resolving that conflict checks the file at that path. If the split falls between that rule's delete and its replacement, or resolving the conflict replaces the rule, members of the folder above see the covered files until the replacement arrives. Moving ordinary files across a conflict's resolution to close it carries more risk than this needs, so it stays.
- An agent or tool the owner runs can change a rule by editing the file. History records that change like any other.
- Moving a folder keeps its own rule. Moving a file or a folder without a rule into another folder gives it that folder's rule.
