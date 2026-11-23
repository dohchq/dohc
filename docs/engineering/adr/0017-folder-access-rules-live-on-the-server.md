---
status: accepted
---

# The server keeps a folder's access rule, and a marker follows the folder

This records a design from [the workspace members plan](../plans/workspace-members.md).

An access rule decides which members reach a folder or a Group. The relay keeps every folder rule, as it keeps Group rules. The owner and admins change a rule in Members settings, the CLI, or MCP, and all three call one relay operation. Each rule has an id the relay mints and a revision. A change names the revision it was made from, and the relay refuses a stale one, so two admins cannot silently undo each other's entries. A rule names people by account email, and only a verified email matches a person.

Folders have no lasting id. A rule kept by path would stop matching when someone renamed the folder outside dohc, for example in File Explorer, and the folder would open to every member. So each ruled folder holds a marker file, `.dohc-access`, that names its rule's id and nothing else. The marker moves with its folder whatever renames it, and the relay follows the marker. The relay writes and deletes markers itself, in the owner's log and in the same transaction as the rule change. The owner's engine takes a marker op only from that relay origin. No desktop, admin copy, or change proposal writes a marker. Only the owner's computer holds markers. Members, admins, and share links never see them.

A rule covers a set of folders. The rule operation adds the folder it names. A marker that names the rule adds its folder too, so a copied folder shares its original's rule, and Members settings lists both folders. A folder leaves the set only once no file remains under it and another folder still holds the marker, so the History of a moved folder's old path never shows it unruled. A deleted folder's rule stays. Members settings shows the folder as missing and offers Remove.

A Group's rule is saved on the Group, by the Group's lasting id. A Group is not a file. It records the folder it was created with, and that record does not follow a rename. The Group's rule covers its messages, and the Group's folder can have its own folder rule. Changing a Group's rule never changes a folder's rule, because the Group finds its folder by path, and more than one Group can record the same folder. Group settings shows that folder's rule and warns when members can reach the folder but not the Group.

## Considered options

- **A rule file inside the folder, `access.yaml`, edited like any file.** Built first and replaced in November 2026, before it shipped. The owner's engine had to hold half-written rule files, a second rule parser ran on the owner's computer, and only the owner could change a rule, because no other writer could be trusted with the file.
- **The relay holds the rules and dohc gives folders lasting ids.** Rules would follow renames without a marker, but the engine would need folder identity first. That is more work than the members feature needs.
- **The relay holds the rules by path, and dohc updates them when it renames a folder.** Rejected. A rename outside dohc would show a restricted folder to every member.

## Consequences

- Access fails closed. A marker that names an unknown rule, cannot be read, has a case twin, or sits in a folder that two rules cover hides its folder from members. The owner or an admin removes an unknown marker in Members settings.
- Editing a marker on disk never takes a folder out of its rule. A marker edited to name a second rule leaves the folder covered by two rules, which hides it.
- On the owner's computer, a marker's write goes before any other step under its folder, and its delete goes after them. When a capture adds paths under a folder, the engine checks that folder and its ancestors on disk for a marker and sends it first.
- Moving a folder keeps its own rule. Moving a file or a folder without a rule into another folder gives it that folder's rule.
- A rule needs a connection to change.
- A tool that copies a folder and writes the marker after the folder's files can let members see those files until the marker arrives. The relay then hides them and their History.
- A folder whose marker was deleted and that was then moved keeps its old path ruled. Its new path is open, and Members settings shows the rule's folder as missing its marker.
- Exporting a workspace does not include its folder rules yet. Its files keep only the markers' ids. Exporting the rules is a follow-up.
