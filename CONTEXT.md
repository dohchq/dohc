# dohc

A local-first file sync and collaboration workspace for humans and agents. This glossary is the canonical vocabulary; check new names against it before defining them.

## Language

### Sharing

**Share**:
The durable object that owns a shared scope of a workspace: its selector, discussion, and history. Principals reach it through grants.
_Avoid_: export, publish (for grants)

**Grant**:
One grantee's authority on a share, with its own level, generation, and revocation. A named user, a pending email invite, and a share link each hold one. A link's browser principals derive from the link grant; they are provenance, not grants.
_Avoid_: permission, membership

**Share access**:
The level a file-share grant carries: View, Comment, or Edit. Comment adds the share's discussion. Edit adds live co-editing of the share's live documents, attributed and reversible through history. Named recipients with Edit can also send change proposals. A chat-channel grant carries read-only or read-write instead, typed by its selector kind.
_Avoid_: permission level, role

**Change proposal**:
A set of bulk or file-tree changes a named recipient submits for the granter to accept or decline. Live documents co-edit directly under Edit access. Everything else changes at the source only through a proposal.
_Avoid_: pull request, patch, suggestion

**Share code**:
The paste-into-dohc handle that names a share and its relay. Carries no authority; the recipient's signed-in identity does.
_Avoid_: share link (that is the URL grant), invite code

**Share link**:
A URL carrying the credential that authenticates a link grant: anyone holding it gets the grant's access level in a browser, no account needed. The owner can revoke the grant, change its level, or rotate the credential. Raising the level mints a new URL.
_Avoid_: public link, web share, share URL

**Link holder**:
A person using a share link without a dohc identity. Known by a link principal and an optional self-claimed, unverified name.
_Avoid_: guest (means an embedded web view in the desktop app), anonymous user, visitor

**Link principal**:
The server-minted identity for one browser holding one share link. It carries provenance on everything the link holder does; it never carries authority beyond the grant.
_Avoid_: anonymous id, device id

**Received share**:
The recipient-side materialization of a share: either its own workspace or a mount inside a host workspace under `shared-with-me/`, constrained by the grant's access.
_Avoid_: shared folder, remote workspace

**Pending invite**:
A share grant addressed to an email with no dohc account yet, claimed on the recipient's first relay contact.
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
