# Workspace members, roles, and access

Reader: Ice, who agreed this design, and the agents who build and review this work. Ice asked for this plan to be tracked in the repository.

Status: draft. Ice settled the decisions below on November 12, 2026, in a design interview. Nothing here is built. Remove this plan when the work it describes has landed.

## Why

Today a person reaches another person's work one share at a time. To bring someone into a workspace, the owner shares each folder, each Group, and each app separately. Nothing added outside those folders and Groups reaches them. That is fine for a shared trip folder and wrong for a team or a community.

The first use is a community workspace, such as "dohc Community": docs, chats, and apps that every member reaches, run by an owner and a few admins. The same model serves any team. Keep it minimal: fixed roles, one access level for members, and rules on folders and Groups.

## What other tools do

Slack, Notion, and Linear give a workspace a few fixed roles: owner, admin, member, and guest. Buzz (buzz.xyz) adds a moderator. Notion lets an admin limit a page to certain people, and the page's children inherit that. Discord lets an admin limit a channel to certain roles or people, for example an announcements channel where only admins post. Custom roles appear only in Discord and in enterprise plans.

This plan takes the fixed roles, and Notion's and Discord's access on each page or channel, as rules on folders and Groups.

## Size

The first version serves up to about 1,000 members with about 100 online at once. Larger communities stay on other tools until this one teaches us more.

## Roles

| Role | What they can do |
| --- | --- |
| Owner | Everything an admin can do. Only the owner adds or removes admins and accepts change proposals. Like an admin, the owner does not reach other people's private chats. Each workspace has one owner. |
| Admin | Reaches everything except other people's private chats: direct messages, General, and chats with agents. Invites and removes members. Sets the member level and access rules. Creates folders and Groups. Moderates. |
| Member | Reaches the workspace at the member level, except where an access rule says otherwise. |

There is no Moderator role and no Guest role. Admins moderate. Sharing one item with someone outside the workspace keeps working as it does today, through shares and share links.

## The member level

The workspace has one level for every member. The owner or an admin sets it. The levels are the existing share access levels:

- **View**: read files, documents, Collections, and chats, and open apps.
- **Comment**: also post in Groups and comment on files. This is the default.
- **Edit**: also co-edit live documents, change Collections, and create new Markdown pages in folders that already exist. Only the owner and admins create folders, so a refused folder name never tells a member that a hidden folder exists. Renames, deletions, other new files, and changes to an app's source go to the owner as a change proposal. Only the owner accepts proposals.

In a Group, View means read only. Comment and Edit mean read and post.

## Access rules

An owner or admin can give a folder or a Group an access rule. A single file has no rule of its own; it takes its folder's. The rule lists the Member role and people, each with a level. A rule can raise a level as well as lower it. A member who is not covered by the rule loses access to the item and everything in it. A rule further down can change a member's level inside a folder they reach, but it never shows them a folder inside one they cannot reach. When a rule lists both a person and the Member role, the person's own entry wins. Rules never limit the owner or admins, who always have Edit, so a rule does not list them.

Examples:

- **Team only**: a "Team" folder with an empty rule. Only the owner and admins reach it.
- **Announcements**: an "Announcements" Group with the rule "Members: View". Members read it and cannot post.
- **One helper**: a "Drafts" folder with the rule "Members: View, Sam: Edit".
- **One reader**: a "Drafts" folder with the rule "Members: Edit, Sam: View". Sam's own entry wins, so Sam reads and cannot edit.

An item a member cannot reach is hidden. dohc does not list its name in the file list, search, History, links, Collections relations, chats, Notices, or presence. A work reference to it shows as unavailable, as it does today. A mention of a member in a Group they cannot reach does not notify them.

Hiding covers only the names dohc lists. Text that a member can read still shows whatever it says, such as a page link written as `[[Team/Plan]]` or a folder name typed in a message.

An automation runs a step only if every editor of its Collection could take that step. The editors are the owner, the admins, every member with Edit from the member level or from a rule, and anyone with Edit through a share. When members can edit a Collection:

- A step that touches a folder some editor cannot see, or changes one some editor cannot edit, stops.
- A step that posts in a Group stops if any editor cannot post there, such as an Announcements Group with "Members: View".
- A step that reads a Group stops if any editor cannot read it.

To keep these steps running, keep the Collection in a folder where members have View or Comment.

A step that acts as one person, such as waking the owner's agent, runs only while that person is the Collection's only editor. In a workspace with an admin, it never runs.

A folder's rule lives in a file inside it, `access.yaml`. The rule moves with its folder, whatever renames it, and it can be read and exported like any other file. Only the owner and admins see and change `access.yaml`; members never see it. It names people by a verified account email, as share invites do. The owner changes it like any file. An admin changes it through the relay's checked write path, which `collection.yaml` uses today. The relay alone checks that the writer is an admin, and the owner's computer accepts `access.yaml` on that path. If the file cannot be read, members lose access to the folder until it is fixed.

A Group's rule is saved on the Group itself, by its lasting id, and changed in the Group's settings. A Group is not a file, and its link to a folder does not follow renames, so its rule cannot live in a folder. The Group's rule covers its messages. The Group's folder is an ordinary folder with its own `access.yaml`. Changing a Group's rule never changes a folder's rule. Group settings shows the rule of the folder the Group recorded, with a link to that folder's own rule, and warns when members can reach that folder but not the Group. If no folder is at that path, Group settings says so. Only the owner and admins see and change a Group's rule.

A folder's files must never reach members before its rule. The owner's computer sends a folder's `access.yaml` with or before the folder's other files, so a restricted folder copied in from outside dohc is never briefly visible. [ADR 0015](../adr/0015-access-rules-live-in-the-folder.md) records why a folder's rule lives in the folder and a Group's rule lives on the Group.

A folder with its own rule keeps it when it moves. Any other file or folder takes the rule of the folder it moves into. dohc warns before a move changes who can reach an item.

## Copies on people's computers

When an item is hidden from a member, or a member is removed, the copies already on their computer stay. dohc cannot take them back. Before an admin hides an item or removes a member, dohc says so: people who could read it may still have a copy.

## Joining and leaving

- **Email invites.** They work as share invites do today.
- **One invite link.** Anyone with the link who signs in to the server becomes a member. The owner or an admin can turn the link off or reset it. Resetting stops the old link working. Turning the link off or resetting it does not remove anyone who already joined. On a server where sign-up is closed, the link also lets a new person create an account, only to join this workspace. That account is then an ordinary account on the server. Turning the link off stops that. Proposed, not yet confirmed by Ice: the server's operator can also turn it off for the whole server.
- **Accounts.** Members need a server account.
- **Leaving and removal.** A member can leave. The owner or an admin can remove a member, which ends their access immediately. What they posted and changed stays in History under their name. A removed person's account cannot rejoin through the invite link. Someone with a different account can, until the link is reset. The Members page lists the removed account, with **Let back in** as the way back.
- **Ending membership.** The owner can end membership for everyone at once, after a warning, as deleting a share does today. The owner cannot leave, and moving the owner role to someone else is not in this version.

## What a member sees

- The workspace opens as its own workspace in the member's app, and in a browser. It does not open as a read-only folder inside another workspace, because Comment and Edit would not work there.
- A new member sees everything they can reach, including messages and History from before they joined.
- Members see the names and roles of everyone in the workspace. The owner and admins also see emails.
- A member gets a Notice for a mention, a reply to their message, or a direct message. Other Group messages show as unread.

## Chats

Members see the Groups they can reach and the Comments on files they can see. Only the owner and admins create Groups. A new Group reaches members without an invite.

A member can start a direct message with anyone in the workspace from the member list. The server connects them without showing either person's email. General, direct messages, and chats with agents stay private to the people in them.

General is each workspace's personal chat. In a community, people may expect a "general" room to be public. The community makes a Group for that.

## Moderation

The owner and admins can delete any message in a Group and remove a member. Anyone can delete their own messages. A deleted message leaves a "Message deleted" line. Copies already on people's computers are the same as in [Copies on people's computers](#copies-on-peoples-computers). Reports, timeouts, and bans of people who are not members are not in this version.

## Members' agents

A person's agent acts with at most that person's access. Today an agent's reach covers only workspaces its owner owns. A member can also give their agent reach in a workspace where they are a member, up to their own access. An admin's agent reaches the same files and Groups as the admin, including folders hidden from members. dohc gives it no tool to manage members or change access rules. That is not a boundary: an agent that runs as the admin can do what the admin can.

The owner's own dohc tools, the CLI and MCP on the owner's computer, do what the Members page does: list, invite, and remove members, set the member level, and change access rules. Today those tools list share grants, read a grant's details, and list or disconnect a link's agents. Admins use the app.

## Not in this version

- Custom roles, a Moderator role, a Guest role, and named sets of people.
- Rules on single files.
- Invite links that expire or count uses.
- Admins accepting change proposals, or renaming and deleting files directly.
- Reports, timeouts, and bans of people who are not members.
- Listing a community publicly or in search engines.
- Managing members from the phone.
- Admins managing members through the CLI or MCP.
- dohc Drive. A community needs a self-hosted server until Drive opens.

## What is new underneath

dohc already has email invites, the three access levels, grants with revocation, Groups, a checked write path for Collection files, server reads while the owner is offline, and per-workspace agent reach. These parts are new:

- **A share of the whole workspace.** Every live share today names specific paths, a Group, or a chat. A version share with no paths covers the whole workspace, but frozen at one version (`packages/security-contract/src/shareSelector.ts`). The relay's file filter allows nothing for a live file share with no paths (`services/sync-relay/src/shareFilter.ts`). A member's share covers the current workspace and anything added later.
- **Roles held by the relay**, next to the grants. A folder's rule comes from its `access.yaml` file in the owner's workspace. A Group's rule is saved on the Group, and the Group's folder has its own `access.yaml`.
- **One reachable set per member, used everywhere.** Files, search, History, links, Collections, chats, Notices, presence, and agent tools all read through it. Piece 1 builds this set before any rule exists, so piece 3 does not have to change every surface again.
- **New Markdown pages under Edit.** The checked write path that creates Collection records today also creates pages in folders where the person has Edit.
- **Sign-up through an invite link.** On a server with closed sign-up, only an email the operator listed or one with a pending invite can create an account today (`services/workspace-api/src/signUpAdmission.ts`). The invite link is a new way in, so the server gets a setting that turns it off (proposed, not yet confirmed by Ice).
- **Deleting Group messages.** Only share discussion messages can be deleted today (`services/sync-relay/src/discussionRoutes.ts`).
- **Chat limits for a community.** The relay holds at most 128 signed-in browser follow requests for a workspace's chats at once (`MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE` in `services/sync-relay/src/namedRecipientChat.ts`). Each request follows one Group, so 100 members online who each follow 10 Groups need about 1,000. Piece 2 gives each member one follow request for all their Groups, or raises the cap to fit. The relay also allows 32 follow requests per person. Each live connection is one open live document, and a workspace allows 96, of which 80 are for everyone but the owner (`services/sync-relay/src/selfHostLiveProfile.ts`). 100 members with a document open do not fit, so piece 2 raises that cap. The share-link caps do not apply to signed-in members.
- **Agent reach in workspaces the person does not own** (`services/sync-relay/src/storage/personalAgents.ts`).

Roles, access rules, and the whole-workspace share are authorization changes. Each piece needs a second reviewer for authorization and isolation, as `AGENTS.md` requires.

## Pieces

Each piece is one pull request, in this order:

1. **Members.** The whole-workspace share, the Owner, Admin, and Member roles, the member level, email invites, the invite link, leaving and removal, the proposed server setting for sign-up through the invite link, a Members page in Settings, and the same actions in the owner's CLI and MCP tools. The relay builds each member's reachable set, which is the whole workspace until piece 3.
2. **The member's workspace.** Opening it in the app and the browser, reaching every Group, direct messages between members, new pages under Edit, and the chat limits.
3. **Access rules.** `access.yaml` for folders, rules on Groups and their folders, inheritance, hiding everywhere, the move warning, and the warning before hiding an item.
4. **Moderation.** Deleting messages and removing members.
5. **Members' agents.** Agent reach in workspaces where its person is a member.

## Delivery

The work lands as one GitHub PR stack. The bottom PR holds this plan, an ADR for keeping access rules in `access.yaml`, and the terms in `CONTEXT.md`. Pieces 1 to 5 stack on it in order. Nothing in the stack merges to main until Ice says so.

## Terms

`CONTEXT.md` defines **Member**, **Member level**, **Workspace role**, **Access rule**, and **Invite link**. **Member** names the role. This plan says "people in the workspace" for the owner, admins, and members together. A Group is now "a named space where people and agents post", so "member" never means a Group member. "Owner" still names both a workspace's owner and an agent's owner; the thing it is attached to tells them apart.
