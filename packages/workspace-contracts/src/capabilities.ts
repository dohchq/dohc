// Metadata describes existing doors and drives desktop MCP registration. It never invokes a handler or admits a call.
import { DECLARATION_FAMILIES } from "./allDeclarations";
import type { McpAccessLevel, OperationDeclaration } from "./operationDeclaration";
import type { WriteDeclaration } from "./writeDeclaration";
import { OWNER_SETUP_REASON } from "./agentSetupWriteDeclarations";
import { WRITE_DECLARATION_FAMILIES } from "./allWriteDeclarations";

export const CAPABILITY_WAYS = [
  "control",
  "palette",
  "menu",
  "shortcut",
  "cli",
  "mcp",
  "app",
] as const;
export const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
export const RETIRED_CAPABILITY_IDS: readonly string[] = [
  "version.try",
  "version.try.read",
  "version.try.dismiss",
  "share.live.restore",
];

export interface CapabilityMetadata {
  readonly description: string;
  readonly ipc: { readonly operations: readonly string[]; readonly reason: string };
  readonly mcp: Readonly<Record<McpAccessLevel, readonly string[]>> & { readonly reason: string };
}

// These doors keep their own approvals and reach. B1 adds no tags or exposure.
export const SEPARATE_CAPABILITY_DOORS = {
  app: {
    source: "packages/security-contract/src/app-publication.ts",
    reason: "Owner-approved data capabilities, independent of local operation metadata.",
  },
  automationExecutor: {
    source: "packages/automation-executor/src",
    reason: "Executor steps retain their configured reach and approval checks.",
  },
  shareLink: {
    source: "services/share-web/src/remoteMcp.ts",
    reason:
      "Credential, selector, version, generation, and live-host checks; adoption is a separate reviewed change.",
  },
} as const;

const ADMIN_COLLECTION_ACCESS = {
  view: ["dohc_collection_access"],
  comment: ["dohc_collection_access"],
  edit: ["dohc_collection_access"],
} as const;

const publishAppTool = {
  owner: ["dohc_publish_app"],
  view: ["dohc_publish_app"],
  comment: ["dohc_publish_app"],
  edit: ["dohc_publish_app"],
};

function capability(
  description: string,
  exposure: {
    mcp?: Partial<Record<McpAccessLevel, readonly string[]>>;
    mcpReason?: string;
  } & ({ ipc: readonly string[]; ipcReason?: never } | { ipc?: never; ipcReason: string }),
): CapabilityMetadata {
  return {
    description,
    ipc: {
      operations: exposure.ipc ?? [],
      reason: exposure.ipc
        ? "Existing operation-table rows; admission stays in main."
        : exposure.ipcReason,
    },
    mcp: {
      owner: [],
      view: [],
      comment: [],
      edit: [],
      ...exposure.mcp,
      reason:
        exposure.mcpReason ??
        (exposure.mcp
          ? "Existing desktop advertisement, including access-level exceptions. Omitted levels offer no tool; socket admission remains separate."
          : "No desktop MCP tool; this registry adds none."),
    },
  };
}

const MEMBERS_MCP_REASON =
  "Agents do what the Members page does, in a workspace the person owns or joined. Every profile offers the tool; the socket refuses any share view but a joined workspace, and the relay decides every action for the signed-in account's role.";

const LISTED_CAPABILITIES = {
  // withDeclarations adds the IPC rows and MCP tools of the operations declared with these.
  "links.edges": capability("Read a bounded page of file links.", { ipc: [], mcp: {} }),
  "links.connections": capability("Read how Collections, apps, and automations connect.", {
    ipc: [],
    mcp: {},
  }),
  "links.in": capability("Read documents that link to a file.", { ipc: [], mcp: {} }),
  "links.resolve": capability("Resolve links from one document.", { ipc: [], mcp: {} }),
  "drawing.read": capability("Read a drawing's elements, as an open canvas holds them.", {
    ipc: [],
    mcp: {},
    mcpReason:
      "Only the original workspace reads drawings live. Shared profiles omit this read; the socket refuses received shares and read-only workspaces.",
  }),
  "drawing.create": capability("Create a drawing, optionally with elements.", {
    ipc: [],
    mcp: {},
  }),
  "drawing.edit": capability("Add, change, or delete a drawing's elements.", {
    ipc: [],
    mcp: {},
  }),
  "inbox.list": capability("List items in the workspace Inbox Collection.", {
    ipc: [],
    mcp: {},
    mcpReason:
      "Inbox belongs to the owning workspace. Shared profiles omit this read; socket admission and main workspace checks remain the gates.",
  }),
  "inbox.add": capability("Capture a note or link into the workspace Inbox Collection.", {
    ipc: [],
    mcp: {},
  }),
  "inbox.archive": capability("Mark a workspace Inbox item as Archived.", {
    ipc: [],
    mcp: {},
  }),
  "inbox.move": capability(
    "Move a workspace Inbox item and any linked Inbox attachments into an owned folder.",
    {
      ipc: [],
      mcp: {},
    },
  ),
  "inbox.archive.undo": capability(
    "Restore a workspace Inbox item's previous Status if it is still Archived.",
    {
      ipc: ["inboxUndoArchive"],
    },
  ),
  "inbox.move.undo": capability(
    "Undo a workspace Inbox move after checking old paths and preserving later note edits.",
    {
      ipc: ["inboxUndoMove"],
    },
  ),
  "inbox.capture.files": capability(
    "Capture dropped files, picked files, or pasted images into the workspace Inbox Collection.",
    {
      ipc: ["inboxCaptureFiles"],
    },
  ),
  "workspace.search": capability(
    "Search pages, Collections, records, and chats in the owning workspace.",
    {
      ipc: [],
      mcp: {},
      mcpReason:
        "Only the owning workspace offers cross-surface workspace search in this release. Shared profiles omit this read; socket admission and engine owner checks remain the gates.",
    },
  ),
  "settings.user.read": capability("Read this computer's user settings.", {
    ipc: ["getUserSettings"],
  }),
  "settings.user.reload": capability("Reload and apply this computer's user settings file.", {
    ipc: ["reloadUserSettings"],
  }),
  "settings.user.write": capability("Save changes to this computer's user settings.", {
    ipc: ["setUserSettings"],
  }),
  "agent.color.set": capability(
    "Choose a personal color for an agent shown in the admitted workspace.",
    { ipc: ["setAgentColor"] },
  ),
  "app.phone.retry": capability("Try again to send an app to your phones.", {
    ipc: ["retryPhoneApp"],
  }),
  "app.pin.set": capability("Pin or unpin an app in this computer's sidebar.", {
    ipc: ["setAppPinned"],
  }),
  "chat.archive.set": capability(
    "Archive or unarchive a chat in this computer's sidebar for the admitted workspace.",
    { ipc: ["setChatArchived"] },
  ),
  "app.view": capability(
    "Open, theme or close an approved app in a tab of the admitted workspace.",
    { ipc: ["appView"] },
  ),
  "settings.agents.order": capability(
    "Change the order of the agents in this computer's user settings.",
    { ipc: ["orderAgents"] },
  ),
  "settings.user.reset": capability("Reset this computer's user settings.", {
    ipc: ["resetUserSettings"],
  }),
  "settings.user.path.read": capability("Read the path of this computer's user settings file.", {
    ipc: ["getUserSettingsFilePath"],
  }),
  "settings.user.file.open": capability(
    "Open this computer's user settings file in the system editor.",
    { ipc: ["openUserSettingsFile"] },
  ),
  "settings.workspace.file.open": capability(
    "Open the admitted workspace's settings file in the system editor.",
    { ipc: ["openWorkspaceSettingsFile"] },
  ),
  "history.rules.file.open": capability(
    "Open one of the admitted workspace's History rules files in the system editor.",
    { ipc: ["openWorkspacePolicyFile"] },
  ),
  "settings.workspace.read": capability("Read the admitted workspace's settings.", {
    ipc: ["getWorkspaceSettings"],
  }),
  "settings.workspace.write": capability("Save a patch to the admitted workspace's settings.", {
    ipc: ["setWorkspaceSettings"],
  }),
  "settings.workspace.reset": capability("Reset the admitted workspace's settings.", {
    ipc: ["resetWorkspaceSettings"],
  }),
  "workspace.ui.read": capability("Read saved workbench state for the admitted workspace.", {
    ipc: ["getWorkspaceUiState"],
  }),
  "workspace.ui.write": capability("Save workbench state for the admitted workspace.", {
    ipc: ["setWorkspaceUiState"],
  }),
  "file.create": capability("Create a workspace file, optionally refusing an existing path.", {
    ipc: ["createWorkspaceFile"],
  }),
  "file.zip.export": capability("Export workspace files to a user-selected zip archive.", {
    ipc: ["exportWorkspaceZip"],
  }),
  "document.file.export": capability("Export supplied document content to a user-selected file.", {
    ipc: ["exportDocumentFile"],
  }),
  "file.import": capability("Import native picks or screened dropped files into a workspace.", {
    ipc: ["importWorkspaceFiles"],
  }),
  "file.text.read": capability("Read workspace text with its content hash for editing.", {
    ipc: ["readWorkspaceText"],
  }),
  "file.text.write": capability("Save workspace text if its expected content hash still matches.", {
    ipc: ["writeWorkspaceText"],
  }),
  "file.asset.write": capability("Write an image attachment inside a writable workspace.", {
    ipc: ["writeWorkspaceAsset"],
  }),
  "file.image.pick": capability(
    "Read user-selected images for insertion into a writable workspace.",
    { ipc: ["pickImageFiles"] },
  ),
  "file.external.open": capability("Open a contained workspace file with its system application.", {
    ipc: ["openFileExternally", "readExternalOpen"],
  }),
  "file.reveal": capability("Show a contained workspace path in the system file manager.", {
    ipc: ["revealExplorerPath"],
  }),
  "explorer.menu.read": capability("Read the actions the Explorer offers for a path.", {
    ipc: ["readExplorerMenu"],
  }),
  "access.object.read": capability("Read observed grants covering an object.", {
    ipc: ["getObjectAccess"],
  }),
  "access.sharing.read": capability("Page observed granted and received shares.", {
    ipc: ["listSharingAccess"],
  }),
  "access.refresh": capability("Request paced Sharing observations through the desktop or CLI.", {
    ipc: ["requestAccessRefresh"],
    mcpReason: "Available through dohc access refresh; no desktop MCP tool.",
  }),
  "cloud.connect.link.take": capability(
    "Take the server a dohc://connect link named, for the window it brought forward.",
    { ipc: ["takeConnectServerRequest"] },
  ),
  "share.handoff.status.read": capability(
    "Read the pending dohc://open handoff status on this computer.",
    { ipc: ["getShareHandoffStatus"] },
  ),
  "share.handoff.accept": capability("Accept the pending dohc://open handoff on this computer.", {
    ipc: ["acceptShareHandoff"],
  }),
  "share.handoff.retry": capability("Retry the pending dohc://open handoff on this computer.", {
    ipc: ["retryShareHandoff"],
  }),
  "share.handoff.dismiss": capability("Dismiss the pending dohc://open handoff on this computer.", {
    ipc: ["dismissShareHandoff"],
  }),
  "share.mount.add": capability("Mount a received share in a writable host workspace.", {
    ipc: ["mountShare"],
  }),
  "share.mounts.refresh": capability(
    "Pull changes into every share mount in a writable host workspace.",
    { ipc: ["refreshShareMounts"] },
  ),
  "share.mount.remove": capability(
    "Remove a received share mount from a writable host workspace.",
    { ipc: ["unmountShare"] },
  ),
  "share.view.open": capability(
    "Open a share code as a received-share workspace in an empty chosen folder.",
    { ipc: ["openSharedView"] },
  ),
  "share.proposals.list": capability("List change proposals sent to a workspace you shared.", {
    ipc: ["listShareProposals"],
  }),
  "share.proposal.read": capability("Read the files in a change proposal.", {
    ipc: ["readShareProposalChanges"],
  }),
  "share.proposal.file.read": capability("Read a change proposal file preview.", {
    ipc: ["readShareProposalFileContent"],
  }),
  "share.proposal.settle": capability("Accept or decline a change proposal.", {
    ipc: ["settleShareProposal"],
  }),
  "share.proposal.submit": capability("Send a change proposal from a received share.", {
    ipc: ["submitShareChanges"],
  }),
  "share.direct.writes.push": capability("Push direct writes from a received share.", {
    ipc: ["pushShareDirectWrites"],
  }),
  "share.proposals.sent.list": capability("List change proposals you sent from a received share.", {
    ipc: ["listMyShareChanges"],
  }),
  "share.proposal.withdraw": capability("Withdraw a change proposal you sent.", {
    ipc: ["withdrawShareChanges"],
  }),
  "group.share": capability("Share a workspace Group.", { ipc: ["shareChatChannel"] }),
  "group.joined.list": capability("Read joined Groups for the requested Group identities.", {
    ipc: ["listJoinedSharedChannels"],
  }),
  "group.shares.list": capability("List Group grants and invitations for this workspace.", {
    ipc: ["listChatChannelShares"],
  }),
  "group.join": capability("Join a shared Group in this workspace.", {
    ipc: ["joinSharedChannel"],
  }),
  "group.leave": capability("Leave a shared Group in this workspace.", {
    ipc: ["leaveSharedChannel"],
  }),
  "share.live.documents.list": capability("List the owner's live documents.", {
    ipc: ["listOwnerLiveDocuments"],
    mcp: { owner: ["dohc_list_live_documents"] },
    mcpReason:
      "Only the original workspace offers its live documents. Shared profiles omit this read; main admits the workspace and the relay checks the owner's account.",
  }),
  "share.live.refusals.list": capability("List live document refusals.", {
    ipc: ["listOwnerLiveRefusals"],
  }),
  "share.live.retry": capability("Retry live editing for a share.", {
    ipc: ["retryOwnerLiveShare"],
  }),
  "share.create": capability("Create a share for a named recipient.", {
    ipc: ["createRelayShare"],
  }),
  "share.link.create": capability("Create a new share from paths or a version with a share link.", {
    ipc: ["createRelayShareLink"],
  }),
  "share.link.add": capability("Add a share link to an existing share.", {
    ipc: ["addRelayShareLink"],
  }),
  "share.links.list": capability("List the workspace's share links.", {
    ipc: ["listRelayShareLinks"],
  }),
  "share.link.access.set": capability("Change a share link's access level.", {
    ipc: ["retuneRelayShareLink"],
  }),
  "share.link.rotate": capability("Rotate a share link.", { ipc: ["rotateRelayShareLink"] }),
  "share.link.revoke": capability("Revoke a share link.", { ipc: ["revokeRelayShareLink"] }),
  "share.link.agents.list": capability("List the agents connected through a share link.", {
    ipc: ["listRelayShareLinkAgents"],
    mcp: { owner: ["dohc_list_link_agents"] },
    mcpReason:
      "Only the owning workspace offers its links' agents. Shared profiles omit this read; socket admission and owner-account checks remain the gates.",
  }),
  "share.link.agent.disconnect": capability("Disconnect one agent from a share link.", {
    ipc: ["disconnectRelayShareLinkAgent"],
    mcp: { owner: ["dohc_disconnect_link_agent"] },
    mcpReason:
      "Only the owning workspace can disconnect its links' agents. Shared profiles omit this write; socket admission and owner-account checks remain the gates.",
  }),
  "share.discussion.read": capability("Read a share's discussion.", {
    ipc: ["listRelayShareDiscussion"],
  }),
  "share.discussion.post": capability("Post to a share's discussion.", {
    ipc: ["appendRelayShareDiscussion"],
  }),
  "share.discussion.message.delete": capability("Delete a discussion message.", {
    ipc: ["deleteRelayShareDiscussionMessage"],
  }),
  "share.discussion.principal.block": capability("Block a principal from a discussion.", {
    ipc: ["blockRelayShareDiscussionPrincipal"],
  }),
  "share.discussion.principal.unblock": capability("Unblock a principal from a discussion.", {
    ipc: ["unblockRelayShareDiscussionPrincipal"],
  }),
  "share.discussion.pause": capability("Pause a share's discussion.", {
    ipc: ["pauseRelayShareDiscussion"],
  }),
  "share.discussion.resume": capability("Resume a share's discussion.", {
    ipc: ["resumeRelayShareDiscussion"],
  }),
  "share.grant.promote": capability("Promote a share grant.", { ipc: ["promoteRelayShareGrant"] }),
  "share.grant.access.set": capability("Change a person's access on a share.", {
    ipc: ["retuneRelayShareGrant"],
  }),
  "share.grant.invitation.resend": capability("Email a person their share invitation again.", {
    ipc: ["resendRelayShareInvitation"],
  }),
  "share.grant.revoke": capability("Revoke a share grant.", { ipc: ["revokeRelayShareGrant"] }),
  "share.live.document.stop": capability("Stop live editing for a document.", {
    ipc: ["stopOwnerLiveDocument"],
    mcp: { owner: ["dohc_stop_live_editing", "dohc_stop_again"] },
    mcpReason:
      "Only the original workspace stops its live editing. Shared profiles omit this owner action; main admits the workspace, checks kept edits for Stop again, and refuses while an editor holds the document.",
  }),
  "share.live.document.resume": capability("Resume live editing for a document.", {
    ipc: [],
    mcp: {},
  }),
  "share.live.document.retry": capability(
    "Try once more to send a document's edits the server refused.",
    {
      ipc: ["retryOwnerLiveQuarantine"],
      mcp: { owner: ["dohc_retry_kept_edits"] },
      mcpReason:
        "Only the original workspace keeps refused edits. Shared profiles omit this owner action; main admits the workspace and checks the refusal.",
    },
  ),
  "share.live.document.recovery.save": capability(
    "Save a document's edits the server refused next to its file.",
    {
      ipc: ["saveOwnerLiveRecoveryCopy"],
      mcp: { owner: ["dohc_save_recovery_copy"] },
      mcpReason:
        "Only the original workspace keeps refused edits. Shared profiles omit this owner write; main admits the workspace and finds the edits by path.",
    },
  ),
  "share.live.document.recovery.list": capability(
    "List the recovery packages kept on this computer that have no readable copy.",
    { ipc: ["listOwnerLiveRecoveryPackages"] },
  ),
  "share.list": capability("List shares for the connected account.", { ipc: ["listRelayShares"] }),
  "share.received.read": capability("Read a received share.", { ipc: ["getRelayReceivedShare"] }),
  "share.revoke": capability("Remove a share.", { ipc: ["revokeRelayShare"] }),
  "share.leave": capability("Leave a share someone else made, or clear one they ended.", {
    ipc: ["leaveRelayShare"],
  }),
  "share.revoke.undo": capability("Undo a share removal.", { ipc: ["undoRelayShare"] }),
  "share.discussion.activity.wait": capability("Wait for share discussion activity.", {
    ipc: ["pollRelayShareDiscussionActivity"],
  }),
  "share.discussion.activity.cancel": capability("Cancel a share discussion activity wait.", {
    ipc: ["cancelRelayShareDiscussionActivity"],
  }),
  "share.skips.dismiss": capability("Acknowledge skipped changes in a received share.", {
    ipc: ["dismissShareSkips"],
  }),
  "app.member.list": capability(
    "List the apps members can open in a workspace and whether members may share apps.",
    {
      ipc: [],
      mcp: {},
    },
  ),
  "app.member.inspect": capability(
    "Show a Member app's author, Collection access, and source files.",
    {
      ipc: [],
      mcp: {},
    },
  ),
  "app.member.share": capability("Share a Personal app with a workspace's members, or update it.", {
    ipc: [],
    mcp: {},
  }),
  "app.member.source": capability("Read one source file of a Member app.", {
    ipc: [],
    mcp: {},
  }),
  "app.member.fork": capability("Copy a Member app's source into a new Personal app.", {
    ipc: [],
    mcp: {},
  }),
  "app.member.promote": capability(
    "Copy a Member app's source into a new folder of an owned workspace, to publish it.",
    {
      ipc: [],
      mcp: {},
    },
  ),
  "app.member.withdraw": capability("Stop sharing a Member app with a workspace.", {
    ipc: [],
    mcp: {},
  }),
  "app.member.sharing": capability("Turn members' app sharing on or off.", {
    ipc: [],
    mcp: {},
  }),
  "members.list": capability(
    "List a workspace's people, invites, removed accounts, member level, and invite link.",
    {
      ipc: ["workspaceMembers"],
      mcp: {
        owner: ["dohc_members"],
        view: ["dohc_members"],
        comment: ["dohc_members"],
        edit: ["dohc_members"],
      },
      mcpReason: MEMBERS_MCP_REASON,
    },
  ),
  "members.folder.rule": capability("Set or clear access to a workspace folder.", {
    ipc: ["workspaceMembers"],
    mcp: {
      owner: ["dohc_members"],
      view: ["dohc_members"],
      comment: ["dohc_members"],
      edit: ["dohc_members"],
    },
    mcpReason: MEMBERS_MCP_REASON,
  }),
  "members.folder.marker.remove": capability("Remove an unreadable or unknown folder marker.", {
    ipc: ["workspaceMembers"],
    mcp: {
      owner: ["dohc_members"],
      view: ["dohc_members"],
      comment: ["dohc_members"],
      edit: ["dohc_members"],
    },
    mcpReason: MEMBERS_MCP_REASON,
  }),
  "members.invite": capability("Invite someone to a workspace by email.", {
    ipc: ["workspaceMembers"],
    mcp: {
      owner: ["dohc_members"],
      view: ["dohc_members"],
      comment: ["dohc_members"],
      edit: ["dohc_members"],
    },
    mcpReason: MEMBERS_MCP_REASON,
  }),
  "members.level.set": capability(
    "Set what every member can do in a workspace: View, Comment, or Edit.",
    {
      ipc: ["workspaceMembers"],
      mcp: {
        owner: ["dohc_members"],
        view: ["dohc_members"],
        comment: ["dohc_members"],
        edit: ["dohc_members"],
      },
      mcpReason: MEMBERS_MCP_REASON,
    },
  ),
  "members.group.rule": capability(
    "Show or set what members can do in one Group: post, view, or nothing.",
    {
      ipc: ["workspaceMembers"],
      mcp: {
        owner: ["dohc_members"],
        view: ["dohc_members"],
        comment: ["dohc_members"],
        edit: ["dohc_members"],
      },
      mcpReason: MEMBERS_MCP_REASON,
    },
  ),
  "members.role.set": capability("Make a member an admin, or an admin a member.", {
    ipc: ["workspaceMembers"],
    mcp: {
      owner: ["dohc_members"],
      view: ["dohc_members"],
      comment: ["dohc_members"],
      edit: ["dohc_members"],
    },
    mcpReason: MEMBERS_MCP_REASON,
  }),
  "members.remove": capability("Remove a person or an invite from a workspace.", {
    ipc: ["workspaceMembers"],
    mcp: {
      owner: ["dohc_members"],
      view: ["dohc_members"],
      comment: ["dohc_members"],
      edit: ["dohc_members"],
    },
    mcpReason: MEMBERS_MCP_REASON,
  }),
  "members.readmit": capability("Let a removed account back into a workspace.", {
    ipc: ["workspaceMembers"],
    mcp: {
      owner: ["dohc_members"],
      view: ["dohc_members"],
      comment: ["dohc_members"],
      edit: ["dohc_members"],
    },
    mcpReason: MEMBERS_MCP_REASON,
  }),
  "members.link.change": capability("Turn a workspace's invite link on or off, or reset it.", {
    ipc: ["workspaceMembers"],
    mcp: {
      owner: ["dohc_members"],
      view: ["dohc_members"],
      comment: ["dohc_members"],
      edit: ["dohc_members"],
    },
    mcpReason: MEMBERS_MCP_REASON,
  }),
  "members.end": capability("End membership of a workspace for everyone.", {
    ipc: ["workspaceMembers"],
    mcp: {
      owner: ["dohc_members"],
      view: ["dohc_members"],
      comment: ["dohc_members"],
      edit: ["dohc_members"],
    },
    mcpReason: MEMBERS_MCP_REASON,
  }),
  "members.leave": capability("Leave a workspace you are a member or an admin of.", {
    ipc: ["workspaceMembers"],
  }),
  "direct.list": capability("List the signed-in account's direct conversations on its server.", {
    ipc: ["directConversations"],
  }),
  "direct.read": capability(
    "Read a direct conversation the signed-in account is in, or find the one it has with a person picked from a member list.",
    { ipc: ["directHistory", "directResolve", "directMarkRead"] },
  ),
  "direct.send": capability("Send a direct message as the signed-in account.", {
    ipc: ["directStart", "directSend"],
  }),
  "direct.block": capability(
    "Block or unblock a person in one of the signed-in account's direct conversations.",
    { ipc: ["directBlock"] },
  ),
  "share.copy.read": capability(
    "Read one owned grant's share code and named-account invite link.",
    {
      ipc: ["getShareCopyDetails"],
      mcp: { owner: ["dohc_read_share_copy"] },
      mcpReason:
        "Only the owning workspace offers copy details. Shared profiles omit this read; socket admission and owner-account checks remain the gates.",
    },
  ),
  "share.access.read": capability("Check the current user's received share access.", {
    ipc: ["checkSharedViewAccess"],
  }),
  "share.direct.writes.feedback": capability(
    "Subscribe to and acknowledge shared-view write feedback.",
    { ipc: ["updateShareDirectWriteDelivery"] },
  ),
  "share.view.refresh": capability("Pull changes into a received share.", {
    ipc: ["refreshSharedView", "retryShareViewRebuild"],
  }),
  "share.capture.notice.dismiss": capability("Dismiss a received share's capture Notice.", {
    ipc: ["dismissShareCaptureNotice"],
  }),
  "share.access.saved.dismiss": capability("Dismiss a joined workspace's recovery folder Notice.", {
    ipc: ["dismissAccessSavedNotice"],
  }),
  "share.restore.pending.read": capability("Read unfinished Stop and restore progress.", {
    ipc: ["pendingStopAndRestores"],
  }),
  "share.restore.pending.dismiss": capability("Dismiss unfinished Stop and restore progress.", {
    ipc: ["dismissStopAndRestore"],
  }),
  "capture.recovery.read": capability("Read capture recovery status.", {
    ipc: ["getCaptureRecoveryStatus"],
  }),
  "capture.held.retry": capability("Retry recording the outside edit to a held file.", {
    ipc: ["retryHeldCapture"],
  }),
  "capture.recovery.clear": capability("Clear a capture recovery notice persistently.", {
    ipc: ["clearCaptureRecovery"],
  }),
  "capture.outside.read": capability("List live notes whose file changed outside dohc.", {
    ipc: [],
    mcp: {},
    mcpReason:
      "Only the original workspace holds its live notes' outside changes. Shared profiles omit this read; main admits the workspace.",
  }),
  "capture.outside.keep": capability(
    "Keep a live note's outside change as a copy and put the note's text back in its file.",
    {
      ipc: ["keepOutsideChange"],
      mcp: { owner: ["dohc_keep_outside_change"] },
      mcpReason:
        "Only the original workspace holds its live notes' outside changes. Shared profiles omit this owner action; main admits the workspace.",
    },
  ),
  "capture.history.retry": capability("Restart History recording that stopped.", {
    ipc: ["retryHistoryCapture"],
  }),
  "capture.secret.retry": capability(
    "Retry saving protected files that wait on the workspace secret key.",
    { ipc: ["retrySecretKey"] },
  ),
  "file.observation.retry": capability("Retry reading a workspace's file changes.", {
    ipc: ["retryFileObservation"],
  }),
  "app.recognition.read": capability("Read folder app recognition for contextual offers.", {
    ipc: ["getFolderApp"],
  }),
  "version.list": capability("List workspace versions.", {
    ipc: ["listWorkspaceVersions"],
    mcp: { owner: ["dohc_list_versions"] },
    mcpReason:
      "Shared profiles omit this owner read. Owning-workspace admission and the History path policy remain the gates.",
  }),
  "version.unversioned.list": capability(
    "List the files the active version does not track, which have one copy for every version.",
    { ipc: ["listNotVersionedFiles"] },
  ),
  "version.create": capability("Create a workspace version.", {
    ipc: ["createWorkspaceVersion"],
    mcp: { owner: ["dohc_create_version"] },
    mcpReason:
      "Shared profiles omit this owner write. Owning-workspace admission and the History path policy remain the gates.",
  }),
  "version.switch": capability("Switch workspace versions.", {
    ipc: ["switchWorkspaceVersion"],
    mcp: { owner: ["dohc_switch_version"] },
    mcpReason:
      "Shared profiles omit this owner write. Owning-workspace admission and the History path policy remain the gates.",
  }),
  "version.compare": capability("Compare workspace versions.", {
    ipc: ["compareWorkspaceVersions", "countWorkspaceVersionChanges"],
    mcp: { owner: ["dohc_compare_version"] },
    mcpReason:
      "Shared profiles omit this owner read. Owning-workspace admission and the History path policy remain the gates.",
  }),
  "version.merge": capability("Merge a workspace version.", {
    ipc: ["mergeWorkspaceVersion"],
    mcp: { owner: ["dohc_merge_version"] },
    mcpReason:
      "Shared profiles omit this owner write. Owning-workspace admission and the History path policy remain the gates.",
  }),
  "version.update": capability("Update a workspace version from Main.", {
    ipc: ["updateWorkspaceVersion"],
    mcp: { owner: ["dohc_update_version"] },
    mcpReason:
      "Shared profiles omit this owner write. Owning-workspace admission and the History path policy remain the gates.",
  }),
  "version.archive": capability("Archive or restore a workspace version.", {
    ipc: ["archiveWorkspaceVersion"],
    mcp: { owner: ["dohc_archive_version"] },
    mcpReason:
      "Shared profiles omit this owner write. Owning-workspace admission and the History path policy remain the gates.",
  }),
  "version.conflicts.list": capability("List version conflicts.", {
    ipc: ["listWorkspaceVersionConflicts", "countWorkspaceVersionConflicts"],
    mcp: { owner: ["dohc_list_version_conflicts"] },
    mcpReason:
      "Shared profiles omit this owner read. Owning-workspace admission and the History path policy remain the gates.",
  }),
  "version.conflict.resolve": capability("Resolve a version conflict.", {
    ipc: ["resolveWorkspaceVersionConflict"],
    mcp: { owner: ["dohc_resolve_version_conflict"] },
    mcpReason:
      "Shared profiles omit this owner write. Owning-workspace admission and the History path policy remain the gates.",
  }),
  "file.kept.list": capability("List kept file copies.", {
    ipc: ["listKeptCopies"],
    mcp: {
      owner: ["dohc_list_kept_copies"],
      view: ["dohc_list_kept_copies"],
      comment: ["dohc_list_kept_copies"],
      edit: ["dohc_list_kept_copies"],
    },
  }),
  "file.kept.save": capability("Save a kept copy beside its file.", {
    ipc: ["saveKeptCopy"],
    mcp: { owner: ["dohc_save_kept_copy"] },
    mcpReason:
      "Shared profiles omit this owner write. Socket read-only admission and per-verb checks remain the gates.",
  }),
  "file.protected.restore": capability(
    "Write back a protected file's change that a sync replaced, kept on this computer.",
    { ipc: [], mcp: {} },
  ),
  "file.protected.discard": capability("Remove a protected file's kept change for good.", {
    ipc: ["discardProtectedCopy"],
    mcp: { owner: ["dohc_discard_protected_copy"] },
    mcpReason:
      "The copy stays on the computer that kept it, so shared profiles omit this write. Socket read-only admission and per-verb checks remain the gates.",
  }),
  "file.retained.list": capability(
    "List old file copies kept on a drive that cannot tell whether a program uses them.",
    {
      ipc: ["listRetainedCopies"],
      mcp: { owner: ["dohc_list_retained_copies"] },
      mcpReason:
        "Shared profiles omit this owner maintenance read. Socket admission and per-verb checks remain the gates.",
    },
  ),
  "file.retained.delete": capability(
    "Delete listed old file copies after accepting that a program still using one may lose its next write.",
    {
      ipc: ["deleteRetainedCopies"],
      mcp: { owner: ["dohc_delete_retained_copies"] },
      mcpReason:
        "Shared profiles omit this owner write. Socket read-only admission and per-verb checks remain the gates.",
    },
  ),
  "search.start": capability("Start a streamed workspace search.", { ipc: ["searchWorkspace"] }),
  "search.cancel": capability("Cancel a streamed workspace search.", {
    ipc: ["cancelWorkspaceSearch"],
  }),
  "crash.read": capability("Read a crash report on this computer.", { ipc: ["readCrashReport"] }),
  "crash.dismiss": capability("Dismiss a crash report.", { ipc: ["dismissCrashReport"] }),
  "crash.mark": capability("Mark a crash report read, so its toast does not show again.", {
    ipc: ["markCrashReportRead"],
  }),
  "crash.send": capability("Send a confirmed crash report.", { ipc: ["sendCrashReport"] }),
  "collection.copies.left.read": capability(
    "Read which workspaces hold offline Collection copies an account change could not remove.",
    { ipc: ["readCollectionCopiesLeft"] },
  ),
  "collection.copies.left.remove": capability(
    "Try again to remove the offline Collection copies an account change left.",
    { ipc: ["removeCollectionCopiesLeft"] },
  ),
  "workspace.trust.read": capability(
    "Read whether this computer trusts the admitted workspace to run its apps' code.",
    { ipc: ["readWorkspaceTrust"] },
  ),
  "workspace.trust.request": capability(
    "Show main's dialog that asks the person to trust the admitted workspace.",
    { ipc: ["requestWorkspaceTrust"] },
  ),
  "workspace.trust.restrict": capability(
    "Put the admitted workspace in Restricted Mode and stop its app commands.",
    { ipc: ["restrictWorkspace"] },
  ),
  "window.old.read": capability(
    "Read whether this window was left showing a workspace it can no longer edit, and whether another window shows it.",
    { ipc: ["readOldWindowState"] },
  ),
  "window.old.go": capability(
    "Bring the other window that shows this window's workspace to the front.",
    { ipc: ["goToWorkspaceWindow"] },
  ),
  "diagnostics.read": capability("Read diagnostics about this computer's dohc.", {
    ipc: ["readDiagnostics"],
  }),
  "diagnostics.save": capability("Save diagnostics to a file the person picks.", {
    ipc: ["saveDiagnostics"],
  }),
  "reports.notice.read": capability("Read which reports the notice must name.", {
    ipc: ["readReportsNotice"],
  }),
  "reports.notice.acknowledge": capability(
    "Record that a window showed the notice about reports.",
    { ipc: ["acknowledgeReportsNotice"] },
  ),
  "reports.error.send": capability("Report an error a dohc window met.", {
    ipc: ["reportRendererError"],
  }),
  // Privacy only. No agent door reads or changes the usage record.
  "usage.read": capability("Read this computer's usage record.", { ipc: ["readUsageRecord"] }),
  "usage.clear": capability("Clear this computer's usage record.", { ipc: ["clearUsageRecord"] }),
  "usage.switch": capability("Turn this computer's usage record on or off.", {
    ipc: ["setUsageRecordEnabled"],
  }),
  "usage.start": capability("Set aside a usage record dohc cannot read, and start a new one.", {
    ipc: ["startUsageRecord"],
  }),
  "usage.restore": capability("Restore the usage record set aside last.", {
    ipc: ["restoreUsageRecord"],
  }),
  "chat.dispatch.notices.read": capability("Read notices about agent replies.", {
    ipc: ["registerChatDispatchNotices"],
  }),
  "chat.dispatch.notice.dismiss": capability("Dismiss a notice about agent replies.", {
    ipc: ["dismissChatDispatchNotice"],
  }),
  "chat.dispatch.pause.read": capability(
    "Read whether agent replies are paused on this computer.",
    { ipc: ["readChatDispatchPaused"] },
  ),
  "chat.dispatch.pause.switch": capability("Pause or resume agent replies on this computer.", {
    ipc: ["setChatDispatchPaused"],
  }),
  "chat.wakes.retry": capability(
    "Try again to start this computer's agents for messages from your phone.",
    { ipc: ["retryChatWakes"] },
  ),
  "agent.run.state.read": capability(
    "Read whether this computer's agent is working in this workspace.",
    { ipc: ["readAgentRunState"] },
  ),
  "agent.run.retry": capability(
    "Run an agent's stopped request in a conversation again, as Try again does.",
    { ipc: [], mcp: {} },
  ),
  "agent.listening.read": capability(
    "Read which agents you run are waiting for messages on this computer.",
    { ipc: ["readAgentsListening"] },
  ),
  "agent.thread.connect": capability(
    "Connect one of your agents to its own thread in another tool.",
    { ipc: ["readyAgentThread", "changeAgentThread", "setAgentThreadWorkspace"] },
  ),
  "agent.thread.lines.read": capability(
    "Read what your agents' threads are doing with the messages dohc forwarded.",
    { ipc: ["readAgentThreadLines"] },
  ),
  "agent.thread.open": capability("Open one of your agents' threads in its own tool.", {
    ipc: ["openAgentThread"],
  }),
  "agent.thread.question.answer": capability(
    "Answer a question one of your agents' threads asks you in its own tool.",
    { ipc: ["answerAgentThreadQuestion"] },
  ),
  "agent.thread.question.read": capability(
    "Read a question one of your agents' threads asks you in its own tool.",
    { ipc: ["readAgentThreadQuestion"] },
  ),
  "agent.thread.read": capability("Read which thread one of your agents is connected to.", {
    ipc: ["readAgentThread"],
  }),
  "agent.thread.t3code.allow": capability("Allow dohc in T3 Code on this computer.", {
    ipc: ["allowDohcInT3Code", "cancelAllowDohcInT3Code"],
  }),
  "agent.thread.t3code.list": capability("List your projects and threads in T3 Code.", {
    ipc: ["listT3CodeProjects", "listT3CodeThreads"],
  }),
  "agent.thread.t3code.start": capability("Start a thread in T3 Code for an agent you add.", {
    ipc: ["startT3CodeThread"],
  }),
  "agent.thread.t3code.read": capability(
    "Read whether dohc is allowed in T3 Code on this computer.",
    { ipc: ["readT3CodeConnection"] },
  ),
  "agent.personal.read": capability("Read the personal agents of your server account.", {
    ipc: ["readPersonalAgents"],
  }),
  "agent.personal.change": capability(
    "Rename, recolor, change the reach of, sign out, or remove a personal agent.",
    { ipc: ["changePersonalAgent"] },
  ),
  "automation.host.read": capability("Read the computer that runs schedules.", {
    ipc: ["readScheduleHost"],
    mcp: { owner: ["dohc_read_automation_host"] },
    mcpReason: OWNER_SETUP_REASON,
  }),
  "automation.host.choose": capability("Choose the computer that runs schedules.", {
    ipc: ["chooseScheduleHost"],
  }),
  "automation.host.takeover": capability("Take over scheduled work.", {
    ipc: ["takeOverScheduleHost"],
  }),
  "notice.list": capability("List Notices rows and where each opens.", {
    ipc: ["listNotices"],
    mcp: {
      owner: ["dohc_list_notices"],
      view: ["dohc_list_notices"],
      comment: ["dohc_list_notices"],
      edit: ["dohc_list_notices"],
    },
  }),
  "notice.mark": capability("Mark Notices.", { ipc: ["markNotices"] }),
  "document.typing.kept.list": capability(
    "List typing kept for workspaces no longer in the list.",
    { ipc: ["listKeptTyping"] },
  ),
  "document.typing.kept.dismiss": capability(
    "Delete typing kept for a workspace no longer in the list.",
    { ipc: ["dismissKeptTyping"] },
  ),
  "automation.schedule.run": capability("Run a skipped schedule.", {
    ipc: ["runSkippedScheduleNow"],
  }),
  "automation.notice.retry": capability("Retry an automation from a Notice.", {
    ipc: ["retryAutomationNotice"],
  }),
  "workspace.open.failures.take": capability(
    "Take the launch open failures held for this window.",
    { ipc: ["takeWorkspacePathOpenFailures"] },
  ),
  "workspace.open.retry": capability("Open a folder again after a launch could not open it.", {
    ipc: ["retryWorkspacePathOpen"],
  }),
  "chat.bookmarks.list": capability("List the local person's saved chat bookmarks.", {
    ipc: ["listChatBookmarks"],
  }),
  "chat.bookmark.save": capability("Save a thread or message as a chat bookmark.", {
    ipc: ["saveChatBookmark"],
  }),
  "chat.bookmark.archive": capability("Archive a saved chat bookmark.", {
    ipc: ["archiveChatBookmark"],
  }),
  "chat.thread.revision.read": capability("Read a thread's revision without marking it read.", {
    ipc: ["getChatThreadRevision"],
  }),
  "chat.decisions.list": capability("List the decisions in a thread.", {
    ipc: ["listChatThreadDecisions"],
  }),
  "chat.decision.resolve": capability("Resolve a question or poll in a thread.", {
    ipc: ["resolveChatDecision"],
  }),
  "chat.attachments.list": capability("List file attachments in a thread.", {
    ipc: ["listChatThreadAttachments"],
  }),
  "chat.navigation.list": capability("List Groups and file-linked threads for chat navigation.", {
    ipc: ["listChatChannels"],
  }),
  "chat.unread.list": capability("List each chat's unread message count on this computer.", {
    ipc: ["listChatUnread"],
  }),
  "chat.follows.list": capability("List the local person's chat follows.", {
    ipc: ["listChatFollows"],
  }),
  "chat.follow.set": capability(
    "Set whether the local person follows a Group, thread, or author.",
    { ipc: ["setChatFollow"] },
  ),
  "chat.inbox.seen.mark": capability("Mark the personal chat feed seen through its head cursor.", {
    ipc: ["markPersonalChatFeedSeen"],
  }),
  "group.create": capability("Create a Group and its folder.", {
    ipc: ["createChatChannel"],
    mcp: { owner: ["dohc_create_group"], edit: ["dohc_create_group"] },
    mcpReason:
      "An admin has Edit, so Edit profiles offer it for a joined workspace, where the relay checks the role. Other profiles omit it; socket admission and per-verb checks remain the gates.",
  }),
  "chat.thread.read.mark": capability("Mark a thread read through a message sequence.", {
    ipc: ["markChatThreadRead"],
  }),
  "chat.reactions.list": capability("List a thread's reactions for the current viewer.", {
    ipc: ["listChatReactions"],
  }),
  "chat.reaction.set": capability("Set the local person's reaction to added or removed.", {
    ipc: ["setChatReaction"],
  }),
  "chat.message.delete": capability(
    "Delete a message in a Group or a file's Comments: your own, or any as the owner or an admin.",
    {
      ipc: ["workspaceMembers"],
      mcp: {
        owner: ["dohc_members"],
        view: ["dohc_members"],
        comment: ["dohc_members"],
        edit: ["dohc_members"],
      },
      mcpReason: MEMBERS_MCP_REASON,
    },
  ),
  "chat.message.link": capability("Make a web link to a message in a workspace that syncs.", {
    ipc: ["makeMessageLink"],
  }),
  "work.link.resolve": capability(
    "Find the message a work link names, in the window's workspace or another on the link's server.",
    { ipc: ["resolveWorkLink"] },
  ),
  "work.reference.make": capability(
    "Make a link to a chat, thread, message, file, or Collection to put in a chat message.",
    {
      ipcReason:
        "Agents make links through the CLI or MCP. People's chips come from the links agents write.",
      mcp: { owner: ["dohc_link"] },
      mcpReason:
        "Only the owning workspace makes links. Shared profiles omit it; socket admission remains the gate.",
    },
  ),
  "work.reference.describe": capability(
    "Show what the work links in chat messages name, and where each opens.",
    { ipc: ["describeWorkReferences"] },
  ),
  "group.list": capability("List the Groups in this workspace.", {
    ipcReason: "No IPC channel carries this capability.",
    mcp: {
      owner: ["dohc_list_groups"],
      view: ["dohc_list_groups"],
      comment: ["dohc_list_groups"],
      edit: ["dohc_list_groups"],
    },
  }),
  "chat.threads.list": capability("List the threads in a Group.", { ipc: ["listChannelThreads"] }),
  "chat.inbox.read": capability(
    "List unread threads. For an agent, also list its unread requests: mentions of it, its DMs, and replies in threads it posted in.",
    { ipc: ["listPersonalChatFeed"], mcp: { owner: ["dohc_wait_for_messages"] } },
  ),
  "chat.show": capability("Show a thread or message and mark the thread read.", {
    ipcReason: "CLI-only action with no IPC channel.",
  }),
  "chat.post": capability("Start a thread in a Group.", {
    ipc: ["startChannelThread"],
    mcp: {
      owner: ["dohc_start_group_chat"],
      comment: ["dohc_start_group_chat"],
      edit: ["dohc_start_group_chat"],
    },
    mcpReason:
      "Comment and Edit profiles offer it for a joined workspace's Groups. View profiles omit it; the socket refuses other share views, General, and DMs.",
  }),
  "chat.reply": capability("Reply in a thread.", {
    ipc: ["sendChatMessage"],
    mcp: {
      owner: ["dohc_reply_to_chat"],
      comment: ["dohc_reply_to_chat"],
      edit: ["dohc_reply_to_chat"],
    },
    mcpReason:
      "Comment and Edit profiles offer it for a joined workspace's Groups. View profiles omit it; the socket refuses other share views, General, and DMs.",
  }),
  "chat.react": capability("Add your reaction to a message, or remove it if it is already there.", {
    ipcReason: "No IPC channel carries this capability.",
  }),
  "chat.search": capability("Search message text and thread titles.", {
    ipcReason: "CLI-only action with no IPC channel.",
  }),
  "chat.export": capability("Save threads as Markdown files, one file per thread.", {
    ipcReason: "CLI-only action with no IPC channel.",
  }),
  "history.list": capability("List changes to files, newest first.", {
    ipc: ["listHistory", "listVersionLastChanges"],
    mcp: {
      owner: ["dohc_list_changes"],
      view: ["dohc_list_changes"],
      comment: ["dohc_list_changes"],
      edit: ["dohc_list_changes"],
    },
  }),
  "history.operation.read": capability("Read the paths changed by one operation.", {
    ipc: ["readHistoryOperation"],
    mcp: { owner: ["dohc_read_operation"] },
    mcpReason:
      "Shared profiles omit this owner read. Owning-workspace admission and the operation path floor remain the gates.",
  }),
  "history.operation.undo": capability("Undo a delete, move, or rename recorded in History.", {
    ipc: ["undoHistoryOperation"],
    mcp: { owner: ["dohc_undo_operation"] },
    mcpReason:
      "Shared profiles omit this owner write. Socket read-only admission and per-verb checks remain the gates.",
  }),
  "history.agent.run.plan": capability(
    "List which files saved during an agent run can be safely undone.",
    {
      ipc: [],
      mcp: {},
      mcpReason:
        "Only the original workspace plans an agent run undo. Shared profiles omit this read; main admits the workspace.",
    },
  ),
  "history.agent.run.undo": capability("Undo safe file changes saved during an agent run.", {
    ipc: [],
    mcp: {},
  }),
  "history.read": capability("Print a file's text as one change left it.", {
    ipcReason: "Hand-registered IPC channel readEngineMoment has no operation-table row.",
    mcp: {
      owner: ["dohc_read_change"],
      view: ["dohc_read_change"],
      comment: ["dohc_read_change"],
      edit: ["dohc_read_change"],
    },
  }),
  "file.chats.list": capability("List chats linked to a workspace file.", {
    ipc: ["listFileChats"],
    mcp: {
      owner: ["dohc_list_file_chats"],
      view: ["dohc_list_file_chats"],
      comment: ["dohc_list_file_chats"],
      edit: ["dohc_list_file_chats"],
    },
  }),
  "chat.read": capability("Read a chat thread.", {
    ipc: ["listChatMessages"],
    mcp: {
      owner: ["dohc_read_chat"],
      view: ["dohc_read_chat"],
      comment: ["dohc_read_chat"],
      edit: ["dohc_read_chat"],
    },
  }),
  "collection.query": capability("Query a Collection.", {
    ipcReason: "Hand-registered IPC channel queryCollectionRecords has no operation-table row.",
    mcp: {
      owner: ["dohc_query_collection"],
      view: ["dohc_query_collection"],
      comment: ["dohc_query_collection"],
      edit: ["dohc_query_collection"],
    },
  }),
  "collection.record.read": capability("Read one Collection record.", {
    ipcReason: "CLI and MCP action with no IPC channel.",
    mcp: {
      owner: ["dohc_read_record"],
      view: ["dohc_read_record"],
      comment: ["dohc_read_record"],
      edit: ["dohc_read_record"],
    },
  }),
  "collection.record.edit": capability("Edit fields on a Collection record.", {
    ipcReason: "CLI and MCP action with no IPC channel.",
    mcp: { owner: ["dohc_set_record_fields"], edit: ["dohc_set_record_fields"] },
    mcpReason:
      "Edit profiles offer it for a joined workspace, through the record's live session on the server. Other profiles omit it; the socket refuses other share views.",
  }),
  "collection.record.create": capability("Create a Collection record.", {
    ipcReason: "Hand-registered IPC channel createCollectionRecord has no operation-table row.",
    mcp: { owner: ["dohc_create_record"], edit: ["dohc_create_record"] },
    mcpReason:
      "Edit profiles offer it for a joined workspace, through the Collection's New record. Other profiles omit it; the socket refuses other share views.",
  }),
  "file.write": capability("Write ordinary workspace files.", {
    ipcReason: "No IPC channel carries this capability.",
    mcp: { owner: ["dohc_write_file"] },
    mcpReason:
      "Shared profiles omit this owner write. Socket read-only admission and per-verb checks remain the gates.",
  }),
  "file.duplicate": capability("Duplicate one workspace file with a fresh identity.", {
    ipc: ["duplicateWorkspaceFile"],
    mcp: { owner: ["dohc_duplicate_file"] },
    mcpReason:
      "Like moves, shared profiles omit this owner write. Socket read-only admission and path checks remain the gates.",
  }),
  "file.move": capability("Move a workspace path.", {
    ipc: ["moveWorkspacePath"],
    mcp: { owner: ["dohc_move_path"] },
    mcpReason:
      "Shared profiles omit this owner write. Socket read-only admission and per-verb checks remain the gates.",
  }),
  "file.delete": capability("Delete a workspace path.", {
    ipc: ["deleteWorkspacePath"],
    mcp: { owner: ["dohc_delete_path"] },
    mcpReason:
      "Shared profiles omit this owner write. Socket read-only admission and per-verb checks remain the gates.",
  }),
  "document.read": capability("Read the current Markdown, including edits in an open editor.", {
    ipcReason: "CLI and MCP action with no IPC channel.",
    mcp: {
      owner: ["dohc_read_document"],
      view: ["dohc_read_document"],
      comment: ["dohc_read_document"],
      edit: ["dohc_read_document"],
    },
  }),
  "document.held.read": capability(
    "Read a change dohc held: the file on disk and what saving the change would write.",
    {
      ipc: ["readHeldChange"],
      mcp: { owner: ["dohc_read_held_change"] },
      mcpReason:
        "Held saves belong to the workspace that writes the file. Shared profiles omit the tool.",
    },
  ),
  "document.held.change": capability(
    "Drop or restore a held note change on the owner's computer.",
    {
      ipc: ["heldNoteChange"],
      mcp: { owner: ["dohc_held_note_change"] },
      mcpReason:
        "Only the local owner can drop held edits. Shared profiles have no discard authority.",
    },
  ),
  "document.edit": capability(
    "Replace matching text or append Markdown through the live document.",
    {
      ipcReason: "CLI and MCP action with no IPC channel.",
      mcp: { owner: ["dohc_edit_document"], edit: ["dohc_edit_document"] },
      mcpReason:
        "Edit profiles offer it for a joined workspace, through the page's live session on the server. Other profiles omit it; the socket refuses other share views.",
    },
  ),
  "document.create": capability(
    "Create a Markdown document without overwriting an existing file.",
    {
      ipcReason: "CLI and MCP action with no IPC channel.",
      mcp: { owner: ["dohc_create_document"], edit: ["dohc_create_document"] },
      mcpReason:
        "Edit profiles offer it for a joined workspace, through the view's New page. Other profiles omit it; the socket refuses other share views.",
    },
  ),
  "file.chat.start": capability("Start a chat linked to a file.", {
    ipc: ["createFileChat"],
    mcp: {
      owner: ["dohc_start_file_chat"],
      comment: ["dohc_start_file_chat"],
      edit: ["dohc_start_file_chat"],
    },
    mcpReason:
      "Comment and Edit profiles offer it for a joined workspace's files. View profiles omit it; the socket refuses other share views.",
  }),
  "automation.runs.list": capability("List an automation's runs on this computer, newest first.", {
    ipcReason:
      "Hand-registered IPC channel listCollectionAutomationRuns has no operation-table row.",
    mcp: { owner: ["dohc_list_automation_runs"] },
    mcpReason:
      "Run records and retries belong to the host holding the runs. Shared profiles omit them.",
  }),
  "automation.list": capability(
    "Read a Collection's automation definitions and on/off file state.",
    {
      ipcReason:
        "Hand-registered IPC channel listCollectionAutomations has no operation-table row.",
      mcp: {
        owner: ["dohc_list_automations"],
        view: ["dohc_list_automations"],
        comment: ["dohc_list_automations"],
        edit: ["dohc_list_automations"],
      },
    },
  ),
  "automation.switch": capability("Switch one automation on or off in its file.", {
    ipcReason: "Hand-registered IPC channel switchCollectionAutomation has no operation-table row.",
    mcp: { edit: ["dohc_switch_automation"] },
    mcpReason:
      "Only Edit advertises file-state switching. Owner, View, and Comment omit the tool; CLI availability remains independent.",
  }),
  "automation.run.read": capability(
    "Show one run: what started it, what each step changed, and why it failed.",
    {
      ipcReason:
        "Hand-registered IPC channel getCollectionAutomationRun has no operation-table row.",
      mcp: { owner: ["dohc_read_automation_run"] },
      mcpReason:
        "Run records and retries belong to the host holding the runs. Shared profiles omit them.",
    },
  ),
  "automation.run.retry": capability(
    "Try a failed run again. It resumes after the last step that finished.",
    {
      ipcReason:
        "Hand-registered IPC channel retryCollectionAutomation has no operation-table row.",
      mcp: { owner: ["dohc_retry_automation_run"] },
      mcpReason:
        "Run records and retries belong to the host holding the runs. Shared profiles omit them.",
    },
  ),
  "automation.button.press": capability(
    "Press a Button field on one record, as a person clicks it in dohc.",
    {
      ipcReason: "Hand-registered IPC channel pressAutomationButton has no operation-table row.",
      mcp: {
        owner: ["dohc_press_button"],
        view: ["dohc_press_button"],
        comment: ["dohc_press_button"],
        edit: ["dohc_press_button"],
      },
    },
  ),
  "automation.buttons.inspect": capability(
    "Inspect Button fields and the actions they require you to confirm.",
    {
      ipcReason: "Hand-registered IPC channel listAutomationButtons has no operation-table row.",
      mcp: {
        owner: ["dohc_inspect_buttons"],
        view: ["dohc_inspect_buttons"],
        comment: ["dohc_inspect_buttons"],
        edit: ["dohc_inspect_buttons"],
      },
    },
  ),
  "dataset.list": capability("List Collections.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"], ...ADMIN_COLLECTION_ACCESS },
    mcpReason:
      "The Owner's agents use the multiplexed tool. A joined workspace's agents get only this, and the relay accepts it from an Admin alone.",
  }),
  "dataset.describe": capability("Show a Collection's tables, fields, and operations.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"], ...ADMIN_COLLECTION_ACCESS },
    mcpReason:
      "The Owner's agents use the multiplexed tool. A joined workspace's agents get only this, and the relay accepts it from an Admin alone.",
  }),
  "dataset.types.write": capability(
    "Write TypeScript types for a Collection's tables and operations.",
    {
      ipc: ["dataset"],
      mcp: { owner: ["dohc_dataset"] },
      mcpReason:
        "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
    },
  ),
  "dataset.sql.read": capability(
    "Run a read-only SQL query or EXPLAIN QUERY PLAN against a Collection.",
    {
      ipc: ["dataset"],
      mcp: { owner: ["dohc_dataset"] },
      mcpReason:
        "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
    },
  ),
  "dataset.trace.read": capability(
    "Show recent operation timings and SQL metrics for a Collection.",
    {
      ipc: ["dataset"],
      mcp: { owner: ["dohc_dataset"] },
      mcpReason:
        "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
    },
  ),
  "dataset.history.list": capability("List saved operations, with values to undo edits.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.history.revision": capability("Show the saved source of one past revision.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.history.restore.prepare": capability(
    "Prepare a change that reverses one saved change.",
    {
      ipc: ["dataset"],
      mcp: { owner: ["dohc_dataset"] },
      mcpReason:
        "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
    },
  ),
  "dataset.lifecycle.read": capability("Show a Collection's archive state and its apps.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.delete.preview": capability("Review what deleting a Collection affects.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.delete": capability("Permanently delete a Collection and all its data.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.archive": capability("Stop a Collection's operations and keep its records.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.restore": capability("Restore an archived Collection under its rules.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.attempts.list": capability("List pending responses that still hold a retry.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.attempt.reconcile": capability("Clear the retry of a saved pending response.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.attempt.cancel": capability("Cancel an unconfirmed pending response.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.permissions.read": capability("List app bindings and explicit data grants.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"], ...ADMIN_COLLECTION_ACCESS },
    mcpReason:
      "The Owner's agents use the multiplexed tool. A joined workspace's agents get only this, and the relay accepts it from an Admin alone.",
  }),
  "dataset.grant.set": capability("Add or change an explicit data grant.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"], ...ADMIN_COLLECTION_ACCESS },
    mcpReason:
      "The Owner's agents use the multiplexed tool. A joined workspace's agents get only this, and the relay accepts it from an Admin alone.",
  }),
  "dataset.defaults.set": capability(
    "Set the actions each workspace level gets in a Collection by default.",
    {
      ipc: ["dataset"],
      mcp: { owner: ["dohc_dataset"], ...ADMIN_COLLECTION_ACCESS },
      mcpReason:
        "The Owner's agents use the multiplexed tool. A joined workspace's agents get only this, and the relay accepts it from an Admin alone.",
    },
  ),
  "dataset.grant.remove": capability("Remove an explicit data grant.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"], ...ADMIN_COLLECTION_ACCESS },
    mcpReason:
      "The Owner's agents use the multiplexed tool. A joined workspace's agents get only this, and the relay accepts it from an Admin alone.",
  }),
  "dataset.holder.keep": capability(
    "Keep a workspace's Collections on this computer, after confirming when another computer may have them.",
    { ipc: ["keepCollectionsHere"] },
  ),
  "dataset.export": capability("Save a private recovery archive of a Collection.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.recovery.prepare": capability("Check a recovery archive before restoring it.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.recovery.claim": capability("Restore a Collection from a prepared archive.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.recovery.discard": capability("Cancel a prepared recovery before it installs.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.file.upload": capability("Upload a file for a file field.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.file.read": capability("Read an uploaded file.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.form.create": capability("Create a form app that adds records to a Collection.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.relation.choices.prepare": capability("Prepare public choices for a relation field.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.approval.read": capability("Show who approved the rules a Collection runs.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"], ...ADMIN_COLLECTION_ACCESS },
    mcpReason:
      "The Owner's agents use the multiplexed tool. A joined workspace's agents get only this, and the relay accepts it from an Admin alone.",
  }),
  "dataset.approval.confirm": capability(
    "Approve the rules a Collection runs again as the Owner, without changing them.",
    {
      ipc: ["dataset"],
      mcp: { owner: ["dohc_dataset"] },
      mcpReason:
        "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
    },
  ),
  "dataset.create": capability("Write source for a new Collection, ready to approve.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"], ...ADMIN_COLLECTION_ACCESS },
    mcpReason:
      "The Owner's agents use the multiplexed tool. A joined workspace's agents get only this, and the relay accepts it from an Admin alone.",
  }),
  "dataset.prepare": capability("Capture existing Collection source for review.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.approve": capability("Approve prepared source.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.discard": capability("Discard prepared source. The files stay in place.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
  }),
  "dataset.migration.prepare": capability("Prepare new source and migration SQL for review.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"], ...ADMIN_COLLECTION_ACCESS },
    mcpReason:
      "The Owner's agents use the multiplexed tool. A joined workspace's agents get only this, and the relay accepts it from an Admin alone.",
  }),
  "dataset.change.ask": capability(
    "Write a prepared Collection change to a file a chat message can ask a person to apply.",
    {
      ipc: ["dataset"],
      mcp: { owner: ["dohc_dataset"] },
      mcpReason:
        "Dataset owner administration retains its envelope and permissions. Shared profiles omit the multiplexed tool.",
    },
  ),
  "dataset.migration.preview": capability("Read more records a prepared migration changes.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"], ...ADMIN_COLLECTION_ACCESS },
    mcpReason:
      "The Owner's agents use the multiplexed tool. A joined workspace's agents get only this, and the relay accepts it from an Admin alone.",
  }),
  "dataset.schema.change.prepare": capability("Prepare one field, table, or name change.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"], ...ADMIN_COLLECTION_ACCESS },
    mcpReason:
      "The Owner's agents use the multiplexed tool. A joined workspace's agents get only this, and the relay accepts it from an Admin alone.",
  }),
  "dataset.migration.approve": capability("Apply a reviewed migration.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"], ...ADMIN_COLLECTION_ACCESS },
    mcpReason:
      "The Owner's agents use the multiplexed tool. A joined workspace's agents get only this, and the relay accepts it from an Admin alone.",
  }),
  "dataset.migration.discard": capability("Discard a prepared migration.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"], ...ADMIN_COLLECTION_ACCESS },
    mcpReason:
      "The Owner's agents use the multiplexed tool. A joined workspace's agents get only this, and the relay accepts it from an Admin alone.",
  }),
  "dataset.operation.invoke": capability("Run an approved operation.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"], ...ADMIN_COLLECTION_ACCESS },
    mcpReason:
      "The Owner's agents use the multiplexed tool. A joined workspace's agents get only this, and the relay accepts it from an Admin alone.",
  }),
  "dataset.operation.cancel": capability("Request cancellation of a running operation.", {
    ipc: ["dataset"],
    mcp: { owner: ["dohc_dataset"] },
    mcpReason:
      "Cancel a running Collection request in the workspace, identified by its invocationId. Shared profiles omit the multiplexed tool.",
  }),
  "app.frontend.verify": capability(
    "Verify a candidate or approved local app frontend in dohc's sandbox against an empty ephemeral Collection.",
    {
      ipcReason:
        "Hand-registered IPC channel publishOwnerApp dispatches this action without an operation-table row.",
      mcp: publishAppTool,
    },
  ),
  "app.link.create": capability("Create a share link for an app.", {
    ipcReason:
      "Hand-registered IPC channel publishOwnerApp dispatches this action without an operation-table row.",
    mcp: publishAppTool,
  }),
  "app.personal.folder": capability(
    "Show a joined workspace's Personal app folder on this computer, and the apps in it.",
    {
      ipcReason:
        "Hand-registered IPC channel publishOwnerApp dispatches this action without an operation-table row.",
      mcp: publishAppTool,
    },
  ),
  "app.local.list": capability("List an app's publications on this computer.", {
    ipcReason:
      "Hand-registered IPC channel publishOwnerApp dispatches this action without an operation-table row.",
    mcp: publishAppTool,
  }),
  "app.local.check": capability("Read an app's current source revision on this computer.", {
    ipcReason:
      "Hand-registered IPC channel publishOwnerApp dispatches this action without an operation-table row.",
    mcp: publishAppTool,
  }),
  "app.local.prepare": capability("Prepare an app to open on this computer.", {
    ipcReason:
      "Hand-registered IPC channel publishOwnerApp dispatches this action without an operation-table row.",
    mcp: publishAppTool,
  }),
  "app.local.stage": capability(
    "Stage an app and its new or updated Collections locally for one owner approval.",
    {
      ipcReason:
        "Hand-registered IPC channel publishOwnerApp dispatches this action without an operation-table row.",
      mcp: publishAppTool,
    },
  ),
  "app.local.staged.list": capability(
    "List staged app and Collection approvals waiting on this computer.",
    {
      ipcReason:
        "Hand-registered IPC channel publishOwnerApp dispatches this action without an operation-table row.",
      mcp: publishAppTool,
    },
  ),
  "app.local.staged.approve": capability(
    "Apply a reviewed staged proposal, creating or updating its Collections and approving the app.",
    {
      ipcReason:
        "Hand-registered IPC channel publishOwnerApp dispatches this action without an operation-table row.",
      mcp: publishAppTool,
    },
  ),
  "app.local.staged.discard": capability(
    "Discard a staged app proposal on this computer without changing workspace files.",
    {
      ipcReason:
        "Hand-registered IPC channel publishOwnerApp dispatches this action without an operation-table row.",
      mcp: publishAppTool,
    },
  ),
  "app.local.launch": capability("Get a local URL for an approved app.", {
    ipcReason:
      "Hand-registered IPC channel publishOwnerApp dispatches this action without an operation-table row.",
    mcp: publishAppTool,
  }),
  "app.publication.list": capability("List an app's shared publications.", {
    ipcReason:
      "Hand-registered IPC channel publishOwnerApp dispatches this action without an operation-table row.",
    mcp: publishAppTool,
  }),
  "app.publication.prepare": capability("Prepare an app for a share link.", {
    ipcReason:
      "Hand-registered IPC channel publishOwnerApp dispatches this action without an operation-table row.",
    mcp: publishAppTool,
  }),
  "app.publication.approve": capability("Publish a prepared app.", {
    ipcReason:
      "Hand-registered IPC channel publishOwnerApp dispatches this action without an operation-table row.",
    mcp: publishAppTool,
  }),
  "app.publication.cancel": capability("Discard a prepared app before approval.", {
    ipcReason:
      "Hand-registered IPC channel publishOwnerApp dispatches this action without an operation-table row.",
    mcp: publishAppTool,
  }),
  "app.publication.withdraw": capability("Stop a shared publication.", {
    ipcReason:
      "Hand-registered IPC channel publishOwnerApp dispatches this action without an operation-table row.",
    mcp: publishAppTool,
  }),
  "app.collection.revoke": capability("Remove a shared publication's Collection access.", {
    ipcReason:
      "Hand-registered IPC channel publishOwnerApp dispatches this action without an operation-table row.",
    mcp: publishAppTool,
  }),
  "app.publication.reactivation.review": capability(
    "Prepare a stopped publication to publish again.",
    {
      ipcReason:
        "Hand-registered IPC channel publishOwnerApp dispatches this action without an operation-table row.",
      mcp: publishAppTool,
    },
  ),
  "app.responses.list": capability("List responses link holders sent through a share link.", {
    ipcReason:
      "Hand-registered IPC channel ownerAppResponses dispatches this action without an operation-table row.",
  }),
  "app.responses.undo": capability("Remove responses link holders sent through a share link.", {
    ipcReason:
      "Hand-registered IPC channel ownerAppResponses dispatches this action without an operation-table row.",
  }),
  "workspace.list": capability("List registered workspaces.", {
    ipcReason: "Hand-registered IPC channel getWorkspaceRegistry has no operation-table row.",
    mcp: {
      owner: ["dohc_list_workspaces"],
      view: ["dohc_list_workspaces"],
      comment: ["dohc_list_workspaces"],
      edit: ["dohc_list_workspaces"],
    },
  }),
  "workspace.sync.stop": capability("Stop this device's workspace sync.", {
    ipc: ["cloudStopSync"],
    mcp: { owner: ["dohc_stop_workspace_sync"] },
    mcpReason: "Only the owner can stop sync. Main verifies the stored server and owner binding.",
  }),
  "workspace.status": capability("Read workspace sync status.", {
    ipcReason: "Hand-registered IPC channel getSyncStatus has no operation-table row.",
    mcp: {
      owner: ["dohc_workspace_status"],
      view: ["dohc_workspace_status"],
      comment: ["dohc_workspace_status"],
      edit: ["dohc_workspace_status"],
    },
  }),
  "file.list": capability("List workspace files.", {
    ipc: ["listWorkspaceFiles"],
    mcp: {
      owner: ["dohc_list_files"],
      view: ["dohc_list_files"],
      comment: ["dohc_list_files"],
      edit: ["dohc_list_files"],
    },
  }),
  "file.read": capability("Read settled file content.", {
    ipcReason: "No IPC channel carries this capability.",
    mcp: {
      owner: ["dohc_read_file"],
      view: ["dohc_read_file"],
      comment: ["dohc_read_file"],
      edit: ["dohc_read_file"],
    },
  }),
  "file.search": capability("Search workspace file content.", {
    ipcReason: "No IPC channel carries this capability.",
    mcp: {
      owner: ["dohc_search_files"],
      view: ["dohc_search_files"],
      comment: ["dohc_search_files"],
      edit: ["dohc_search_files"],
    },
  }),
  "folder.create": capability("Create a workspace folder.", {
    ipc: ["createWorkspaceFolder"],
    mcp: { owner: ["dohc_create_directory"] },
    mcpReason:
      "Shared profiles omit this owner write. Socket read-only admission and per-verb checks remain the gates.",
  }),
  "app.detect": capability("Find apps in workspace source.", {
    ipcReason: "Hand-registered IPC channel listSites has no operation-table row.",
    mcp: {
      owner: ["dohc_detect_apps"],
      view: ["dohc_detect_apps"],
      comment: ["dohc_detect_apps"],
      edit: ["dohc_detect_apps"],
    },
  }),
  "app.create": capability("Create app source in the workspace.", {
    ipcReason: "MCP-only action with no IPC channel.",
    mcp: { owner: ["dohc_create_app"] },
    mcpReason:
      "Shared profiles omit this owner write. Socket read-only admission and per-verb checks remain the gates.",
  }),
  "app.test": capability("Check an app in the workspace.", {
    ipcReason: "MCP-only action with no IPC channel.",
    mcp: {
      owner: ["dohc_test_app"],
      view: ["dohc_test_app"],
      comment: ["dohc_test_app"],
      edit: ["dohc_test_app"],
    },
  }),
  "data.import": capability("Import data into the local database.", {
    ipc: ["importToDatabase"],
    mcp: { owner: ["dohc_import_data"] },
    mcpReason:
      "Shared profiles omit this owner write. Socket read-only admission and per-verb checks remain the gates.",
  }),
  "data.import.undo": capability("Remove an unchanged database imported during this app run.", {
    ipc: ["undoDatabaseImport"],
    mcpReason:
      "IPC only. CLI and MCP agents can delete their imported workspace file through existing file operations; they do not own this app-run Undo record.",
  }),
  "data.query": capability("Query the local database.", {
    ipcReason: "MCP-only action with no IPC channel.",
    mcp: {
      owner: ["dohc_query_database"],
      view: ["dohc_query_database"],
      comment: ["dohc_query_database"],
      edit: ["dohc_query_database"],
    },
  }),
  "document.shared.admission.wait": capability(
    "Wait until a shared document is ready for live editing.",
    { ipc: ["waitForEngineYDocAdmission"] },
  ),
  "document.typing.recovery": capability("Keep and recover typing during an outage.", {
    ipc: ["typingRecovery"],
  }),
  "document.aside.list": capability("Read the edits this computer set aside.", {
    ipc: ["listSetAsideDrafts"],
  }),
  "document.aside.write": capability("Write an edit this computer set aside to disk.", {
    ipc: ["writeSetAsideDraft"],
  }),
  "document.aside.remove": capability("Remove an edit this computer set aside.", {
    ipc: ["removeSetAsideDraft"],
  }),
  "document.aside.move": capability("Move the edits this computer set aside with a rename.", {
    ipc: ["moveSetAsideDrafts"],
  }),
  "document.draft.discard": capability("Discard the recovery copy of a set-aside draft.", {
    ipc: ["discardLiveDraftRecovery"],
  }),
  "document.draft.list": capability("Read saved live drafts for review.", {
    ipc: ["listLiveDraftRecovery"],
  }),
  "document.save.retry": capability("Try again to save an open document to its file.", {
    ipc: ["retryEngineYDocSave"],
  }),
  "workspace.name.suggest": capability(
    "Suggest a new workspace's folder name that is free in a location dohc offered.",
    { ipc: ["suggestWorkspaceFolderName"] },
  ),
  "device.motion.read": capability("Read this computer's reduced-motion preference.", {
    ipc: ["getSystemReducedMotion"],
  }),
  "device.update.download": capability("Download the dohc update the last check found.", {
    ipc: ["downloadUpdate"],
  }),
  "device.privacy.open": capability("Open macOS privacy settings at Files & Folders.", {
    ipc: ["openSystemPrivacySettings"],
  }),
  "account.delete.preview": capability(
    "Review what deleting the connected server account removes.",
    {
      ipc: ["previewServerAccountDeletion"],
      mcpReason: "No desktop MCP tool; account deletion needs the account password.",
    },
  ),
  "account.delete": capability("Delete the connected server account with its password.", {
    ipc: ["deleteServerAccount", "retryServerAccountDisconnect"],
    mcpReason: "No desktop MCP tool; account deletion needs the account password.",
  }),
  "workspace.secrets.list": capability(
    "List the names, usages, and allowed hosts of this workspace's sealed secrets.",
    {
      ipc: ["listWorkspaceSecrets"],
      mcpReason: "Desktop UI only; workspace secrets are managed by the owner in Settings.",
    },
  ),
  "workspace.secrets.set": capability("Save or replace a sealed secret for this workspace.", {
    ipc: ["setWorkspaceSecret"],
    mcpReason:
      "Desktop UI only; local and connected agents cannot create or rotate workspace secrets.",
  }),
  "workspace.secrets.delete": capability("Delete a sealed secret from this workspace.", {
    ipc: ["deleteWorkspaceSecret", "clearLocalWorkspaceSecrets"],
    mcpReason: "Desktop UI only; local and connected agents cannot delete workspace secrets.",
  }),
  "workspace.webhooks.list": capability(
    "List incoming webhook metadata and recent deliveries for this workspace.",
    {
      ipc: ["listIncomingWebhooks"],
      mcp: { owner: ["dohc_list_incoming_webhooks"] },
      mcpReason: OWNER_SETUP_REASON,
    },
  ),
  "workspace.webhooks.create": capability(
    "Create an incoming webhook URL for a private Collection in this workspace.",
    { ipc: ["createIncomingWebhook"] },
  ),
  "workspace.webhooks.update": capability(
    "Rename, pause, or resume an incoming webhook in this workspace.",
    {
      ipc: ["updateIncomingWebhook"],
      mcpReason: "Desktop UI only; incoming webhooks are managed by the owner in Settings.",
    },
  ),
  "workspace.webhooks.rotate": capability(
    "Rotate an incoming webhook token, invalidating its previous URL.",
    {
      ipc: ["rotateIncomingWebhook"],
      mcpReason:
        "Desktop UI only; local and connected agents cannot rotate public incoming webhook URLs.",
    },
  ),
  "workspace.webhooks.delete": capability("Delete an incoming webhook from this workspace.", {
    ipc: ["deleteIncomingWebhook"],
    mcpReason: "Desktop UI only; incoming webhooks are managed by the owner in Settings.",
  }),
} as const;

// Each declared operation joins its capability after the listed rows and tools.
// The listed rows name every IPC operation, so a declared name or tool that
// repeats any of them, or another declaration's, fails at load.
function withDeclarations<Listed extends Readonly<Record<string, CapabilityMetadata>>>(
  listed: Listed,
  ...families: readonly Readonly<
    Record<string, OperationDeclaration & { readonly capabilityId: keyof Listed }>
  >[]
): Listed {
  const joined: Record<string, CapabilityMetadata> = { ...listed };
  const operations = new Set(Object.values(listed).flatMap((meta) => meta.ipc.operations));
  const tools = new Set(
    Object.values(listed).flatMap((meta) => [
      ...meta.mcp.owner,
      ...meta.mcp.view,
      ...meta.mcp.comment,
      ...meta.mcp.edit,
    ]),
  );
  for (const family of families) {
    for (const [name, { capabilityId, mcp }] of Object.entries(family)) {
      for (const [names, value] of [
        [operations, name],
        [tools, mcp.tool],
      ] as const) {
        if (names.has(value)) throw new Error(`${value} is declared twice.`);
        names.add(value);
      }
      const id = capabilityId as string;
      const meta = joined[id];
      if (!meta) throw new Error(`${name} names an unknown capability ${id}.`);
      joined[id] = {
        ...meta,
        ipc: { ...meta.ipc, operations: [...meta.ipc.operations, name] },
        mcp: {
          ...meta.mcp,
          ...Object.fromEntries(mcp.levels.map((level) => [level, [...meta.mcp[level], mcp.tool]])),
        },
      };
    }
  }
  return joined as Listed;
}

// Each declared write joins its capability the same way. Its declaration gives
// the reason for its MCP levels, and for a door it is not offered at.
function withWrites<Listed extends Readonly<Record<string, CapabilityMetadata>>>(
  listed: Listed,
  ...families: readonly Readonly<
    Record<string, WriteDeclaration & { readonly capabilityId: keyof Listed }>
  >[]
): Listed {
  const joined: Record<string, CapabilityMetadata> = { ...listed };
  const operations = new Set(Object.values(listed).flatMap((meta) => meta.ipc.operations));
  const tools = new Set(
    Object.values(listed).flatMap((meta) => [
      ...meta.mcp.owner,
      ...meta.mcp.view,
      ...meta.mcp.comment,
      ...meta.mcp.edit,
    ]),
  );
  for (const family of families) {
    for (const [name, { capabilityId, ipc, mcp }] of Object.entries(family)) {
      const id = capabilityId as string;
      let meta = joined[id];
      if (!meta) throw new Error(`${name} names an unknown capability ${id}.`);
      if ("none" in ipc) meta = { ...meta, ipc: { ...meta.ipc, reason: ipc.none } };
      else {
        if (operations.has(name)) throw new Error(`${name} is declared twice.`);
        operations.add(name);
        meta = { ...meta, ipc: { ...meta.ipc, operations: [...meta.ipc.operations, name] } };
      }
      if ("none" in mcp) meta = { ...meta, mcp: { ...meta.mcp, reason: mcp.none } };
      else {
        if (tools.has(mcp.tool)) throw new Error(`${mcp.tool} is declared twice.`);
        tools.add(mcp.tool);
        const current = meta.mcp;
        meta = {
          ...meta,
          mcp: {
            ...current,
            ...Object.fromEntries(
              mcp.levels.map((level) => [level, [...current[level], mcp.tool]]),
            ),
            reason: mcp.reason,
          },
        };
      }
      joined[id] = meta;
    }
  }
  return joined as Listed;
}

export const CAPABILITIES = withWrites(
  withDeclarations(LISTED_CAPABILITIES, ...Object.values(DECLARATION_FAMILIES)),
  ...Object.values(WRITE_DECLARATION_FAMILIES),
);

export type CapabilityId = keyof typeof CAPABILITIES;
