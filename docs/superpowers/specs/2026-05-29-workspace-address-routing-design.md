# Workspace Address Routing Design

## Goal

dohc should let one human use one account across many workspaces while preserving the familiar expectation that work shared to a work address appears in the work workspace, not the personal one.

## Product Model

- A workspace is the boundary for memory, files, permissions, agent context, and billing.
- An email address is an optional routing door. A workspace can exist without one.
- A signed-in account may verify many addresses over time.
- Each verified address can optionally route to one target workspace the account can access.
- If a share targets an email address that has no route yet, the share becomes a pending inbox item for that email instead of leaking into personal.

## Backend Design

Additive Convex tables:

- `workspaceAddressRoutes`: one route per normalized email. Stores owner workspace, target workspace, optional label, and verification status.
- `pendingAtomShares`: unresolved share-by-email records. Stores owner workspace, file id, target normalized email, permission, and status.

Existing behavior remains available:

- Direct `shareAtom` still shares to an explicit workspace id.
- Workspace-wide `shareAtomToOrg` still shares to every member of an org.
- Public link sharing remains unchanged.

New behavior:

- `shareAtomByEmail` first looks for a verified route.
- If a route exists, the grant goes to the route's target workspace.
- If no route exists but a legacy user profile exists, it falls back to that profile's personal workspace for backward compatibility.
- If neither exists, it creates or updates a pending share and returns a pending result.
- A user can list pending shares for their current sign-in email.
- A user can accept a pending share into personal or an active workspace they belong to.

## UI Design

Workspace management should make the model obvious:

- Personal and shared workspaces remain email-free by default.
- Each workspace shows whether it has an address route.
- Users can route their current signed-in email to a workspace.
- Billing is shown as workspace-scoped product state, even before Stripe exists.

Sharing UI should explain outcomes:

- The input accepts an email address.
- Routed emails resolve immediately to a workspace.
- Unrouted emails create a pending share instead of erroring.
- Existing access labels distinguish person, workspace, public link, and pending email.

## Security Invariants

- No client passes a user id for authorization.
- Active workspace access is still derived server-side through `requireWorkspace`.
- Pending share acceptance validates that the signed-in email matches the pending email.
- Accepting into an org validates active membership before creating the grant.
- A pending share never grants read access until accepted.
