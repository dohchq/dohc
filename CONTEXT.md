# dohc

A local-first workspace where people and their agents build, share, and manage small apps alongside their files, documents, data, and chat. This glossary is the canonical vocabulary; check new names against it before defining them.

## Language

### Offering

**dohc Drive**:
The optional managed service for dohc sync and sharing. dohc operates the services while users retain ownership of their work.
_Avoid_: dohc Cloud

**Self-hosted server**:
The dohc services operated by a person or organization on infrastructure they control. It provides sync and sharing for their workspaces.
_Avoid_: self-hosted Drive

**Server connection**:
A device's authenticated connection to a dohc server. Workspace permissions determine which work the connection can access.
_Avoid_: Drive connection (for a self-hosted server)

**Server account**:
A person's identity on one dohc server. A dohc Drive account is a server account on Drive and carries no authority on any other server.
_Avoid_: dohc account, global account

**Cell**:
One deployment of the dohc release behind dohc Drive, holding a set of workspaces. Each workspace lives on exactly one cell. People never see cells; to them Drive is one server.
_Avoid_: shard, node, tenant

### Privacy

**Usage record**:
Counts of finished actions per capability, way in, and day, kept on one computer. dohc never sends it. A person can see, copy, clear, or turn it off in Privacy.
_Avoid_: usage report, telemetry, analytics

**Usage report**:
A small count of events that a packaged build sends to its report service while the person's switch in Privacy allows it.
_Avoid_: usage record (that stays on the computer)

**Privacy denial**:
macOS refusing dohc a folder the person has not allowed in System Settings › Privacy & Security, such as Documents or a removable volume. It has the code `privacy-denied`. It is not about dohc's own Privacy settings.
_Avoid_: permission error (a file's own permissions)

### Offers

**Offer**:
A suggestion for a person at a relevant point in their work. Detection changes nothing; the person chooses whether to act.
_Avoid_: Offering (what dohc sells), Moment (see History)

### History

**Moment**:
A recorded file change within a workspace version. Writes, renames, and deletions create moments, including saved live edits and restores. History shows each moment as a row. Moments from one multi-file pass, such as a merge or restore, fold into one expandable row.
_Avoid_: version (the line of history that holds moments), snapshot (a file's current state within a version, which names its latest moment), checkpoint

### Notes

**Page**:
A Markdown file in a workspace, shown with its title and icon. The Explorer's Home lists pages by their folders. A page open in an editor is a live document.
_Avoid_: document (in the interface), doc

**Lossy note**:
A Markdown note whose meaning would change if dohc saved it from its editor, because the editor can't hold some of its parts, such as raw HTML or link reference definitions. dohc checks each note's current bytes when it opens and opens a lossy note read-only.
_Avoid_: reader-built note (a note the engine's reader built, marked by `dohcMarkdownSourceReader`), unsupported note

### Collections

**Collection**:
A workspace view of structured records with typed fields. It can show transactional dataset records or editable documents.
_Avoid_: database (for the user-facing Collection), table

**Record**:
One identifiable item in a Collection, with typed fields and, for document records, an editable document body. Its identity survives a change of name.
_Avoid_: row, page, item

**Field**:
One typed property defined for a Collection. Document records flag invalid values; transactional records require values accepted by the dataset rules.
_Avoid_: column, attribute, metadata

**Relation**:
A field that references records by id, so renames and moves cannot break it. A prose link in a body is a link, not a relation.
_Avoid_: link (that is a body link), backlink

**View**:
A named way to render a Collection, such as a table, board, or calendar. Available views depend on the Collection; the current view is local state.
_Avoid_: dashboard (see App), layout

**Notice**:
One item in a person's Notices: a problem or finished task on this computer, or something sent to that person, such as a mention or an automation's message. Items sent to a person reach all of their computers.
_Avoid_: notification (for the item), inbox, alert

**Automation**:
A rule on a Collection: one trigger, optional conditions, and steps that run in order. It belongs to the Collection, so anyone who can edit the Collection can change it, and it reaches only what all of those people can reach.
_Avoid_: workflow, zap

**Personal step**:
A step in an automation that uses one person's own reach, such as waking that person's agent. Only that person can change it.
_Avoid_: private step, owner step

### References

**WorkspaceRef**:
An exclusive source identity, either a workspace id or a recipient source handle, and native object identity with display labels. Labels do not affect equality. A reference grants no authority.

**Received source handle**:
A relay-derived identity for one source workspace within a recipient namespace. Named recipients share it across grants; link holders share it only within one link grant.

**Received object token**:
A relay-derived file identity within the same recipient namespace. It survives source renames and never exposes the source object id.

**Work link**:
A web link to one message, `<server origin>/l/<reference>`, on the server the workspace syncs with. It carries no credential and grants nothing. dohc opens it in the workspace on this computer that holds the message. In a browser, the server's page shows only an Open in dohc button. Messages are the only work that has one so far.
_Avoid_: share link (that is the URL grant), message URL

### Chat

**ActorKey**:
A key for grouping displayed authors and presence from admitted authorship facts. It grants no authority. Dataset principalKey is separate.

**ActorIssuer**:
The canonical server URL that distinguishes account identities from different servers. It grants no authority.

**Group**:
A named space with members where people and agents post, chat, or both.
_Avoid_: channel, room, space. An editor group is the split pane, not a Group.

**Comment**:
A chat about one file, started from the file's About. Its first message is the comment and its replies continue as chat. The share's discussion, which Comment share access adds, is separate.
_Avoid_: linked chat, file chat (in the interface)

### Agents

**Agent**:
An AI program that acts for one person, its owner, whether dohc starts it or not.
_Avoid_: bot, assistant

**Agent run**:
A period of an agent's work that dohc records, so History marks its changes as that agent's. dohc starts one when a person's message or an automation wakes an agent. A person can also start one in Settings for an agent working outside dohc.
_Avoid_: job, session

**Connected agent**:
An agent dohc does not start, which reaches dohc through the CLI or MCP.
_Avoid_: outside agent, external agent

**Personal agent link**:
An MCP URL tied to one person's server account. An agent signs in with it to act as that person's agent, within the reach the person chose. Planned, not built yet.
_Avoid_: API key, agent token

**Work report**:
What an agent's chat message says about work it does outside dohc, such as a thread in another product or a pull request: a status and an optional web link. dohc checks neither and shows both as reported.

**Work card**:
What a chat thread shows for an agent's work outside dohc: the status of its newest work report, and the newest link a report carried. The agent changes it by reporting again.
_Avoid_: status message, task card

### Sharing

**Share**:
The durable object that owns a shared scope of a workspace: its selector, discussion, and history. Principals reach it through grants.
_Avoid_: export, publish (for grants)

**Grant**:
One grantee's authority on a share, with its own level, generation, and revocation. A named user, a pending email invite, and a share link each hold one. A link's browser principals derive from the link grant; they are provenance, not grants.
_Avoid_: permission, membership

**Share access**:
The level a file-share grant carries: View, Comment, or Edit. Comment adds the share's discussion. Edit adds live co-editing of the share's live documents, attributed and reversible through history. Named recipients and share links with Edit can also change a shared Collection's schema and automations, and create records in document Collections and Collections in a shared folder. Named recipients with Edit can also send change proposals. A Group or direct message grant carries read-only or read-write instead, typed by its selector kind.
_Avoid_: permission level, role

**Change proposal**:
A set of bulk or file-tree changes a named recipient submits for the granter to accept or decline. Live documents co-edit directly under Edit access. A named recipient or a share link with Edit also changes a shared Collection's schema and automations directly, and creates records in document Collections and Collections in a shared folder; a link's grant is the author. Owner-approved app data takes link-holder writes live at any share level, because the approval, not the document level, is that lane's authority. Everything else changes at the source only through a proposal.
_Avoid_: pull request, patch, suggestion

**Share code**:
The paste-into-dohc handle that names a share and its relay. Carries no authority; the recipient's signed-in identity does.
_Avoid_: share link (that is the URL grant), invite code

**Share link**:
A URL carrying the credential that authenticates a link grant: anyone holding it gets the grant's access level in a browser, no account needed. The owner can revoke the grant, change its level, or rotate the credential. Raising the level mints a new URL.
_Avoid_: public link, web share, share URL

**Link holder**:
Whoever uses a share link without a server account: a person in a browser, or an agent that signs in with the link. The relay records each one as a link principal with an optional unverified name. For an agent, it also records the agent connection it signed in with. The agent's name is the one its client reported, under the rules for a person's name, or "Agent". Its chat posts, discussion messages, and Collection writes all show that name.
_Avoid_: guest (means sandboxed code in the app runtime), anonymous user, visitor

**Link principal**:
The server-minted identity for one browser or one agent connection holding one share link. It carries provenance on everything the link holder does; it never carries authority beyond the grant.
_Avoid_: anonymous id, device id

**Agent connection**:
One agent signed in through MCP with a share link, after a person allowed it on the consent page. It acts with the link's access under its own link principal. The owner sees it in the link's Agents list and can disconnect it alone. Reset link and End link end every connection on the link.
_Avoid_: agent session, OAuth client

**Received share**:
The recipient-side materialization of a share: either its own workspace or a mount inside a host workspace under `shared-with-me/`, constrained by the grant's access. A mount syncs only with the share's server.
_Avoid_: shared folder, remote workspace

**Pending invite**:
A share grant addressed to an email with no server account on the share's server yet, claimed on the recipient's first relay contact.
_Avoid_: unclaimed share

**Session host**:
The role that holds a live document session's canonical Y.Doc and settles it into the work. Each deployment configures one holder: the owner's device or a session service. With no host online, shared work stays viewable but live editing pauses.
_Avoid_: doc server, collab server

**App**:
Source-backed web content living in the workspace, from a static page to a dynamic tool, servable to a browser through a share link. An app that requests no capabilities is still an app, and still untrusted code.
_Avoid_: site, dashboard, artifact

**Publication**:
An immutable, owner-approved bundle of one app revision. Authority comes from the publication, never from the app's source or manifest alone.
_Avoid_: deploy, build (for the approved object)

**App domain**:
The domain that serves app launches, on a different registrable domain from the server's share pages. Each launch gets a random subdomain. With the domain on the Public Suffix List, browsers treat every subdomain as its own site and refuse cookies set for the shared parent, so one app cannot set cookies another app reads.
_Avoid_: publish domain, user content domain

**Dataset**:
A workspace-owned transactional data domain with its schema, operations, records, and file associations. Apps receive permission to use approved operations; they do not own a separate backend.
_Avoid_: app backend, private app database

**Dataset operation**:
A named action in an approved dataset revision with declared caller access and read or write authority. Forms, apps, owner views, and agents use the same operation to enforce its rules.
_Avoid_: raw database edit (for a governed data change)

## Replica current view

A replica current view is the relay-owned view of a shared workspace after the passive engine drains both replication lanes.
It contains a complete file manifest, current text, and the applied ordinary and journal cursors.
The union of current share selectors limits collection. It grants no recipient access.
The relay replaces the stored view atomically and removes text with no remaining references.
Settlement cuts remain a separate concept.

## History pin

An immutable recipient History version of one shared object, sampled from a stored replica current view.
The current grant, selector, and object visibility control access. A grant cannot read a pin superseded at or before that grant began.
Pins do not enter the owner's replication log or count against the owner's quota.

## History operation

A History operation groups the file changes made by one admitted action under a main-minted `dohc-operation:` id. Reading it returns paths and change references. Delete and move Undo also use the operation's recovery record. A file move's operation also holds its link rewrites, and its Undo reverses them.
