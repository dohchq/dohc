# Workspace members, roles, and access

Reader: Ice, who decides the open questions below, and the agents who build and review this work.

Status: draft. Ice settled the decisions below on November 12, 2026, in a design interview. Nothing here is built. Remove this plan when the work it describes has landed.

## Why

Today a person reaches another person's work one share at a time. To bring someone into a workspace, the owner shares each folder, each Group, and each app separately. Nothing added later reaches them. That is fine for a shared trip folder and wrong for a team or a community.

The first use is a community workspace, such as "dohc Community": docs, chats, and apps that every member reaches, run by an owner and a few admins. The same model serves any team. Keep it minimal: fixed roles, one access level for members, and rules on folders and Groups.

## What other tools do

Slack, Notion, and Linear give a workspace a few fixed roles: owner, admin, member, and guest. Buzz (buzz.xyz) adds a moderator. Notion lets an admin limit a page to certain people, and the page's children inherit that. Discord lets an admin limit a channel to certain roles or people, for example an announcements channel where only admins post. Custom roles appear only in Discord and in enterprise plans.

This plan takes the fixed roles, and Notion's and Discord's access on each folder or channel.

## Size

The first version serves up to about 1,000 members with about 100 online at once. Larger communities stay on other tools until this one teaches us more.

## Roles

| Role | What they can do |
| --- | --- |
| Owner | Everything. Only the owner adds or removes admins. Each workspace has one owner. |
| Admin | Reaches everything except other people's direct messages. Invites and removes members. Sets the member level and access rules. Moderates. |
| Member | Reaches the workspace at the member level, except where an access rule says otherwise. |

There is no Moderator role and no Guest role. Admins moderate. Sharing one item with someone outside the workspace keeps working as it does today, through shares and share links.

## The member level

The workspace has one level for every member. The owner or an admin sets it. The levels are the existing share access levels:

- **View**: read files, documents, Collections, and chats, and open apps.
- **Comment**: also post in Groups and comment on files. This is the default.
- **Edit**: also co-edit live documents, change Collections, and create new Markdown pages. A new page can create new folders on its way, such as `Guides/Setup.md`, and a new folder takes its parent's access rule. Renames, deletions, other new files, and changes to an app's source go to the owner as a change proposal. Only the owner accepts proposals.

In a Group, View means read only. Comment and Edit mean read and post.

## Access rules

An owner or admin can give a folder or a Group an access rule. A single file has no rule of its own; it takes its folder's. The rule lists roles and people, each with a level. A rule can raise a level as well as lower it. A member who is not covered by the rule loses access to the item and everything in it, until a rule further down says otherwise.

Examples:

- **Team only**: a "Team" folder with the rule "Admins: Edit".
- **Announcements**: an "Announcements" Group with the rule "Admins: Edit, Members: View". Members read it and cannot post.
- **One helper**: a "Drafts" folder with the rule "Admins: Edit, Members: View, Sam: Edit".

An item a member cannot reach is hidden. Its name does not show in the file list, search, History, links, Collections relations, or chats. A work reference to it shows as unavailable, as it does today. Rules never hide anything from the owner or admins.

The rule lives in a file inside the folder, such as `access.yaml`. A Group's rule lives in the Group's folder. The rule moves with its folder, whatever renames it, and it can be read and exported like any other file. Only the owner and admins see and change `access.yaml`; members never see it. It names people by their email. The server trusts only the copy in the owner's workspace. Admins change it through the same checked write path that `collection.yaml` uses today. If the file cannot be read, members lose access to the folder until it is fixed. [ADR 0015](../adr/0015-access-rules-live-in-the-folder.md) records why rules live in the folder.

Moving an item into another folder gives it that folder's rule. dohc warns before a move changes who can reach an item.

## Copies on people's computers

When an item is hidden from a member, or a member is removed, the copies already on their computer stay. dohc cannot take them back. Before an admin hides an item or removes a member, dohc says so: people who could read it may still have a copy.

## Joining and leaving

- **Email invites.** They work as share invites do today.
- **One invite link.** Anyone with the link who signs in to the server becomes a member. The owner or an admin can turn the link off or reset it. Resetting stops the old link working.
- **Accounts.** Members need a server account.
- **Leaving and removal.** A member can leave. The owner or an admin can remove a member, which ends their access immediately. What they posted and changed stays in History under their name. A removed person cannot rejoin through the invite link. The Members page lists them as removed, with **Let back in** as the way back.
- **Ending membership.** The owner can end membership for everyone at once, after a warning, as deleting a share does today. The owner cannot leave, and moving the owner role to someone else is not in this version.

## What a member sees

- The workspace opens as its own workspace in the member's app, and in a browser. It does not open as a read-only folder inside another workspace, because Comment and Edit would not work there.
- Members see the other members' names and roles. The owner and admins also see emails.
- A member gets an alert for a mention, a reply to their message, or a direct message. Other Group messages show as unread.

## Chats

Members see the Groups they can reach and the Comments on files they can see. A new Group reaches them without an invite. General, direct messages, and chats with agents stay private to the people in them.

General is each workspace's personal channel. In a community, people may expect a "general" room to be public. The community makes a Group for that.

## Moderation

The owner and admins can delete any message in a Group and remove a member. Anyone can delete their own messages. A deleted message leaves a "Message deleted" line. Copies already on people's computers are the same as in [Copies on people's computers](#copies-on-peoples-computers). Reports, timeouts, and bans are not in this version.

## Members' agents

A person's agent acts with at most that person's access. Today an agent's reach covers only workspaces its owner owns. A member can also give their agent reach in a workspace where they are a member, up to their own access. An admin's agent does not get admin powers.

## Not in this version

- Custom roles, a Moderator role, a Guest role, and named sets of people.
- Rules on single files.
- Invite links that expire or count uses.
- Admins accepting change proposals, or renaming and deleting files directly.
- Reports, timeouts, and bans.
- Listing a community publicly or in search engines.
- Managing members from the phone.
- dohc Drive. A community needs a self-hosted server until Drive opens.

## What is new underneath

dohc already has email invites, the three access levels, grants with revocation, Groups, a checked write path for Collection files, server reads while the owner is offline, and per-workspace agent reach. These parts are new:

- **A share of the whole workspace.** Every share today names specific paths, a Group, or a chat. The relay's file filter allows nothing for a file share with no paths (`services/sync-relay/src/shareFilter.ts`). A member's share covers the workspace and anything added later.
- **Roles held by the relay**, next to the grants. Access rules come from `access.yaml` files in the owner's workspace.
- **One reachable set per member, used everywhere.** Files, search, History, links, Collections, chats, and agent tools all read through it. Piece 1 builds this set before any rule exists, so piece 3 does not have to change every surface again.
- **New Markdown pages under Edit.** The checked write path that creates Collection records today also creates pages in folders where the person has Edit.
- **Deleting Group messages.** Only share discussion messages can be deleted today (`services/sync-relay/src/discussionRoutes.ts`).
- **Chat limits for a community.** The relay lets 128 signed-in browsers follow a workspace's chats at once (`MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE` in `services/sync-relay/src/namedRecipientChat.ts`). The first version needs room for about 100 members online, with spare. The share-link caps do not apply to signed-in members.
- **Agent reach in workspaces the person does not own** (`services/sync-relay/src/storage/personalAgents.ts`).

Roles, access rules, and the whole-workspace share are authorization changes. Each piece needs a second reviewer for authorization and isolation, as `AGENTS.md` requires.

## Pieces

Each piece is one pull request, in this order:

1. **Members.** The whole-workspace share, the Owner, Admin, and Member roles, the member level, email invites, the invite link, leaving and removal, and a Members page in Settings. The relay builds each member's reachable set, which is the whole workspace until piece 3.
2. **The member's workspace.** Opening it in the app and the browser, reaching every Group, new pages under Edit, and the chat limits.
3. **Access rules.** `access.yaml`, inheritance, hiding everywhere, the move warning, and the warning before hiding an item.
4. **Moderation.** Deleting messages and removing members.
5. **Members' agents.** Agent reach in workspaces where its person is a member.

## Delivery

The work lands as one GitHub PR stack. The bottom PR holds this plan, an ADR for keeping access rules in `access.yaml`, and the terms in `CONTEXT.md`. Pieces 1 to 5 stack on it in order. Nothing in the stack merges to main until Ice says so.

## Terms

`CONTEXT.md` defines **Member**, **Member level**, **Workspace role**, and **Access rule**. A Group is now "a named space where people and agents post", so "member" means only a workspace member. "Owner" still names both a workspace's owner and an agent's owner; the thing it is attached to tells them apart.
