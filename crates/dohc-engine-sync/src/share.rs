use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::Value;

use crate::apply::apply_envelope_with;
use crate::cursor::advance_shared_peer_tx;
use crate::{
    ApplyOutcome, PathClass, ReplicationEnvelope, SyncError, classify_share_path,
    read_shared_peer_position,
};

/// The version a share follows when its selector names none, mirroring the
/// relay's `MAIN_VERSION_ID` (`services/sync-relay/src/shareFilter.ts`).
const MAIN_VERSION_ID: &str = "main";

/// Budget for a share's version id, in UTF-16 code units — the unit
/// `MAX_SHARE_VERSION_ID_CHARS` counts in
/// `packages/security-contract/src/shareSelector.ts`.
pub const MAX_SHARE_VERSION_ID_CHARS: usize = 128;

/// The deliberate Rust twin of `isValidShareVersionId`
/// (`packages/security-contract/src/shareSelector.ts`): whether `value` is a
/// version id the relay could have issued.
///
/// The selector's version dimension is ONE rule. The relay applies it when it
/// creates a selector, every surface that reads a selector back applies it,
/// and this surface applies it to the version a served moment claims — a
/// version id the relay would never have issued must not be read as one here
/// either. `crates/dohc-engine-sync/tests/security_contract.rs` holds this
/// twin to the TypeScript oracle vector by vector.
///
/// The trimmable set is JavaScript's `String.prototype.trim` set, not Rust's
/// `char::is_whitespace`. They differ at both ends — U+FEFF trims in
/// JavaScript only, U+0085 in Rust only — and a twin that disagrees about a
/// padded id is not a twin.
pub fn is_valid_share_version_id(value: &str) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= MAX_SHARE_VERSION_ID_CHARS
        && !value.starts_with(js_trimmable)
        && !value.ends_with(js_trimmable)
}

fn js_trimmable(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareSurface {
    SharedChannel,
    ShareView,
}

/// The file-share access level (issue #646, S7). The Rust twin of the
/// TypeScript rule in `packages/security-contract/src/shareSelector.ts` —
/// the one place the relay and the desktop both read it from — held to it
/// vector by vector in `crates/dohc-engine-sync/tests/security_contract.rs`.
///
/// PR1 carries and pins this on every `ShareGrant`; all three values grant
/// exactly what a share grants today. PR2 opens Comment and Edit to chat,
/// PR3 opens Edit to document writes — neither is wired here yet.
///
/// No `Default`. A level is always read from the grant the relay stated, and
/// a default would be a level nobody granted. The compiler is what keeps one
/// from appearing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareAccess {
    View,
    Comment,
    Edit,
}

impl ShareAccess {
    /// Accepts exactly the three lowercase level strings the relay issues —
    /// no case folding, no trimming. A grant whose level cannot be read this
    /// way is not a narrower grant, it is an unreadable one, and the caller
    /// must refuse it rather than substitute a default.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "view" => Some(Self::View),
            "comment" => Some(Self::Comment),
            "edit" => Some(Self::Edit),
            _ => None,
        }
    }

    /// The exact strings `parse` accepts, so both directions of the level
    /// vocabulary live beside each other and cannot drift apart.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::View => "view",
            Self::Comment => "comment",
            Self::Edit => "edit",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareBoundary {
    pub share_id: String,
    pub surface: ShareSurface,
    pub channel_wire_id: Option<String>,
    /// The share's pinned selector. A ShareView boundary without one admits
    /// nothing: an unscoped view pull would enforce no containment, which is
    /// the whole property this boundary exists to hold. A SharedChannel
    /// boundary carries none by design — it scopes by `channel_wire_id`.
    pub granted: Option<ShareGrant>,
}

/// The selector the RELAY stated for a received share, pinned by the
/// recipient the first time it read it and enforced against every later pull
/// (trust on first use). The recipient never chooses or reviews this scope;
/// pinning only stops the relay from restating a wider one later.
///
/// Mirrors the relay's own `ShareSelector`
/// (`services/sync-relay/src/shareFilter.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareGrant {
    /// Granted paths. Each selects itself and everything beneath it. EMPTY
    /// selects every tracked path, but ONLY together with a `version_id` —
    /// see `path_within_grant`.
    pub paths: Vec<String>,
    /// The granted version. `None` is a live-follow share of the workspace's
    /// main version, which is never entitled to a `version.create`; `Some(id)`
    /// is a version share, entitled to exactly that version's create.
    pub version_id: Option<String>,
    /// The pinned level (#646). Parsed from the relay's own selector at pin
    /// time (`ShareAccess::parse`) and refused, not defaulted, when
    /// unreadable. Neither this type nor `ShareAccess` derives `Default`, so
    /// every construction states a level.
    pub access: ShareAccess,
}

/// Apply an inbound shared op only if its channel/path selector remains inside
/// the receiving grant. This surface never captures a new local outbound op.
///
/// Enforcement is fail-closed. ShareView is validated before the transaction
/// (it needs no store state). SharedChannel is validated INSIDE the write
/// transaction, because message/reaction/decision/attachment ops carry no
/// channel field and must be scoped by resolving `thread_id ->
/// chat_threads.channel_id -> chat_channel_wire_ids.wire_id` against the
/// granted wire id — a denied op then rolls back with nothing applied or acked.
pub fn apply_shared_envelope(
    store: &mut EngineStore,
    boundary: &ShareBoundary,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<i64>, SyncError> {
    crate::model::bounded(&boundary.share_id, "share_id must be non-empty and bounded")?;
    // #646 PR2: a file share carries chat about the files it shares, and chat
    // needs the store. `chat.message.append` carries no path, only a threadId,
    // so the file it belongs to is a fact the store holds — the same situation
    // the SharedChannel path already solves by validating inside the write
    // transaction. File ops still need no store state and keep their
    // before-the-transaction check.
    let share_view_chat =
        boundary.surface == ShareSurface::ShareView && is_share_view_chat_kind(&envelope.op_kind);
    if boundary.surface == ShareSurface::ShareView && !share_view_chat {
        enforce_share_view_boundary(boundary, envelope)?;
        return Ok(ApplyOutcome::Applied(envelope.origin_seq));
    }
    if share_view_chat {
        enforce_share_view_thread_create(boundary, envelope)?;
    }

    let source_origin_id = envelope.origin_id.clone();
    let source_origin_seq = envelope.origin_seq;
    let position = read_shared_peer_position(
        store,
        &envelope.workspace_id,
        &boundary.share_id,
        &source_origin_id,
    )?;
    if source_origin_seq <= position.applied_origin_seq {
        return Ok(ApplyOutcome::Skipped);
    }
    let dense_seq = position
        .dense_seq
        .checked_add(1)
        .ok_or(SyncError::CoordinateDiverged)?;
    let mut dense = envelope.clone();
    dense.origin_id = format!("shared:{}:{}", boundary.share_id, source_origin_id);
    dense.origin_seq = dense_seq;

    let mut replay_refusals = Vec::new();
    let outcome = apply_envelope_with(store, &dense, faults, |tx, op| {
        if share_view_chat {
            enforce_share_view_chat_boundary(tx, boundary, op)?;
        } else {
            enforce_shared_channel_boundary(tx, boundary, op)?;
        }
        replay_refusals = crate::apply::apply_chat_tx(tx, op)?;
        advance_shared_peer_tx(
            tx,
            &op.workspace_id,
            &boundary.share_id,
            &source_origin_id,
            source_origin_seq,
        )
    })?;
    let advance_source = match &outcome {
        ApplyOutcome::Applied(_) | ApplyOutcome::Crashed { .. } => false,
        ApplyOutcome::Refused(_) | ApplyOutcome::Skipped => true,
        ApplyOutcome::WithDiagnostics { .. } => unreachable!("diagnostics are attached below"),
    };
    if advance_source {
        match store.write_with(faults, |tx| {
            advance_shared_peer_tx(
                tx,
                &envelope.workspace_id,
                &boundary.share_id,
                &source_origin_id,
                source_origin_seq,
            )?;
            Ok::<(), SyncError>(())
        })? {
            TxnOutcome::Committed(()) => {}
            TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
        }
    }
    Ok(outcome.with_refusals(replay_refusals))
}

/// Fail-closed SharedChannel scoping. Every admitted op must positively bind to
/// the granted channel wire id; receiver-private ops and everything else are
/// denied. Mirrors `services/sync-relay/src/shareFilter.ts`
/// `filterChatOpForChannelShare`.
fn enforce_shared_channel_boundary(
    tx: &Transaction<'_>,
    boundary: &ShareBoundary,
    op: &ReplicationEnvelope,
) -> Result<(), SyncError> {
    let granted = boundary
        .channel_wire_id
        .as_deref()
        .ok_or(SyncError::ShareBoundaryViolation)?;
    match op.op_kind.as_str() {
        // The create ops carry the channel selector on the wire; require it
        // present AND equal to the grant (absent -> deny).
        "chat.channel.create" => {
            let wire = op
                .payload
                .get("wireId")
                .and_then(Value::as_str)
                .ok_or(SyncError::ShareBoundaryViolation)?;
            if wire != granted {
                return Err(SyncError::ShareBoundaryViolation);
            }
        }
        "chat.thread.create" => {
            let wire = op
                .payload
                .get("channelWireId")
                .and_then(Value::as_str)
                .ok_or(SyncError::ShareBoundaryViolation)?;
            if wire != granted {
                return Err(SyncError::ShareBoundaryViolation);
            }
        }
        // These carry no channel field: resolve the binding in-store and
        // require equality to the grant. Unresolved (missing thread, or a
        // thread with no / a different channel) -> deny.
        "chat.message.append"
        | "chat.reaction.set"
        | "chat.decision.set"
        | "chat.attachment.add" => {
            let thread_id = op
                .payload
                .get("threadId")
                .and_then(Value::as_str)
                .ok_or(SyncError::ShareBoundaryViolation)?;
            if !thread_bound_to_wire(tx, &op.workspace_id, thread_id, granted)? {
                return Err(SyncError::ShareBoundaryViolation);
            }
        }
        // Receiver-private feed state and any other op kind: never served
        // through a channel share.
        _ => return Err(SyncError::ShareBoundaryViolation),
    }
    Ok(())
}

/// The EXACTLY five chat kinds a file share carries (#646 PR2), mirroring the
/// relay's own allowlist (`services/sync-relay/src/shareFilter.ts`,
/// `filterFileChatOpForPathShare`).
///
/// `chat.follow.set` and `chat.feed.read.set` are absent on purpose: they are
/// the reader's OWN state, for the same reason written above for the channel
/// branch's terminal deny. `chat.channel.create` is a channel's bootstrap and
/// a file share has no channel. Everything not named here reaches
/// `enforce_share_view_boundary` and is refused as a kind a share does not
/// carry.
pub(crate) const SHARE_VIEW_CHAT_KINDS: [&str; 5] = [
    "chat.thread.create",
    "chat.message.append",
    "chat.reaction.set",
    "chat.decision.set",
    "chat.attachment.add",
];

pub(crate) fn is_share_view_chat_kind(op_kind: &str) -> bool {
    SHARE_VIEW_CHAT_KINDS.contains(&op_kind)
}

/// The four fields a `moment.append` payload can name a path in. Every surface
/// that decides whether a moment is inside a grant reads all four, so a rename
/// crossing the boundary cannot leak the outside path through the one field a
/// reader forgot.
pub(crate) const MOMENT_PATH_FIELDS: [&str; 4] = [
    "path",
    "payloadBeforePath",
    "payloadAfterPath",
    "beforePath",
];

/// Whether `path` is one a share may place at all AND inside the pinned grant.
///
/// The containment rule, in one place, so the inbound boundary and the
/// outbound scan cannot drift apart. `PathClass::Tracked` is the floor: a
/// secret, unsafe, or ignored path is never a share's to carry, whichever
/// direction it travels.
pub(crate) fn tracked_path_within_grant(path: &str, granted: &ShareGrant) -> bool {
    classify_share_path(path) == PathClass::Tracked && path_within_grant(path, granted)
}

/// Whether `path` is inside a grant that SELECTS PATHS (#646 PR2, PR3a).
///
/// Chat and proposed changes both follow PATHS, and only paths. A grant with
/// no paths is a VERSION share, and `path_within_grant` reads an empty path
/// list as "every tracked path" — which for chat would admit the live
/// discussion about every file on main, and for a change would offer an edit
/// to a file the share never named. A version share is a snapshot; neither the
/// conversation nor a new edit is in it. The relay refuses both shapes
/// (`services/sync-relay/src/shareFilter.ts`: `filterFileChatOpForPathShare`
/// and `filterProposedChangeForShare` each return early on an empty path
/// list), and this is the recipient's own answer to the same question.
pub(crate) fn selected_path_within_grant(path: &str, granted: &ShareGrant) -> bool {
    !granted.paths.is_empty() && tracked_path_within_grant(path, granted)
}

/// The BEFORE-the-transaction half of the ShareView chat boundary, for the one
/// kind that carries its own file: a served `chat.thread.create` names the
/// granted PATH.
///
/// It is a path and never an object id because the served `moment.append`
/// deliberately drops the granter's `objectId`
/// (`services/sync-relay/src/shareFilter.ts`), so this store minted its own
/// and a granter object id would name nothing here. `linkedObjectId` and
/// `linkedPathHint` are therefore shapes a share NEVER carries, and a relay
/// offering one is offering something this boundary must not place — which is
/// a malformed payload, not a scope decision, because no grant admits it and
/// widening the share changes nothing.
fn enforce_share_view_thread_create(
    boundary: &ShareBoundary,
    op: &ReplicationEnvelope,
) -> Result<(), SyncError> {
    if op.op_kind != "chat.thread.create" {
        return Ok(());
    }
    let granted = boundary
        .granted
        .as_ref()
        .ok_or(SyncError::ShareBoundaryViolation)?;
    if op.payload.get("linkedObjectId").is_some() || op.payload.get("linkedPathHint").is_some() {
        return Err(SyncError::InvalidInput {
            reason: "share-view chat.thread.create must carry linkedPath, never a linked object id or path hint",
        });
    }
    let path =
        op.payload
            .get("linkedPath")
            .and_then(Value::as_str)
            .ok_or(SyncError::InvalidInput {
                reason: "share-view chat.thread.create must carry a linkedPath string",
            })?;
    if !selected_path_within_grant(path, granted) {
        return Err(SyncError::ShareBoundaryViolation);
    }
    Ok(())
}

/// The INSIDE-the-transaction half. The four thread-scoped kinds carry no file
/// of their own — only a `threadId` — so the file they belong to is a fact
/// this store holds: `thread_id -> chat_threads.linked_object_id -> that
/// object's current local path -> inside the pinned grant`.
///
/// Unresolved denies at every hop. A thread this store does not have, a thread
/// bound to no file, and a file whose object no longer sits at any path are all
/// the same answer: the share does not cover this op.
fn enforce_share_view_chat_boundary(
    tx: &Transaction<'_>,
    boundary: &ShareBoundary,
    op: &ReplicationEnvelope,
) -> Result<(), SyncError> {
    let granted = boundary
        .granted
        .as_ref()
        .ok_or(SyncError::ShareBoundaryViolation)?;
    match op.op_kind.as_str() {
        // Decided before the transaction, against the path it carries itself.
        // Re-running that rule here would restate it against the same bytes.
        "chat.thread.create" => Ok(()),
        "chat.message.append"
        | "chat.reaction.set"
        | "chat.decision.set"
        | "chat.attachment.add" => {
            let thread_id = op
                .payload
                .get("threadId")
                .and_then(Value::as_str)
                .ok_or(SyncError::ShareBoundaryViolation)?;
            let path = thread_linked_path(tx, &op.workspace_id, thread_id)?
                .ok_or(SyncError::ShareBoundaryViolation)?;
            if !selected_path_within_grant(&path, granted) {
                return Err(SyncError::ShareBoundaryViolation);
            }
            Ok(())
        }
        _ => Err(SyncError::ShareBoundaryViolation),
    }
}

/// Where the file a thread is about sits RIGHT NOW, locally. The file sibling
/// of `thread_bound_to_wire`: `thread_id -> chat_threads.linked_object_id ->
/// path_aliases` in the workspace's main version. `None` at any hop.
/// The file a thread is about, as this replica records it.
pub(crate) fn thread_linked_object(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    thread_id: &str,
) -> Result<Option<String>, SyncError> {
    conn.query_row(
        "SELECT linked_object_id FROM chat_threads WHERE workspace_id = ?1 AND thread_id = ?2",
        params![workspace_id, thread_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(Option::flatten)
    .map_err(SyncError::corrupt)
}

/// Where an object sits in this workspace's main version RIGHT NOW.
pub(crate) fn object_main_path(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<Option<String>, SyncError> {
    conn.query_row(
        "SELECT path FROM path_aliases \
         WHERE workspace_id = ?1 AND object_id = ?2 \
           AND version_id = (SELECT main_version_id FROM versioned_workspaces \
                             WHERE workspace_id = ?1)",
        params![workspace_id, object_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(SyncError::corrupt)
}

fn thread_linked_path(
    tx: &Transaction<'_>,
    workspace_id: &str,
    thread_id: &str,
) -> Result<Option<String>, SyncError> {
    let Some(object_id) = thread_linked_object(tx, workspace_id, thread_id)? else {
        return Ok(None);
    };
    object_main_path(tx, workspace_id, &object_id)
}

/// Whether `thread_id` resolves to a channel carrying the granted wire id.
/// `thread_id -> chat_threads.channel_id -> chat_channel_wire_ids.wire_id`.
fn thread_bound_to_wire(
    tx: &Transaction<'_>,
    workspace_id: &str,
    thread_id: &str,
    granted: &str,
) -> Result<bool, SyncError> {
    let channel_id: Option<String> = tx
        .query_row(
            "SELECT channel_id FROM chat_threads WHERE workspace_id = ?1 AND thread_id = ?2",
            params![workspace_id, thread_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?
        .flatten();
    let Some(channel_id) = channel_id else {
        return Ok(false);
    };
    let bound: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM chat_channel_wire_ids \
             WHERE workspace_id = ?1 AND channel_id = ?2 AND wire_id = ?3)",
            params![workspace_id, channel_id, granted],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    Ok(bound)
}

/// Fail-closed ShareView scoping. EVERY referenced path (`path`,
/// `payloadBeforePath`, `payloadAfterPath`, `beforePath`) must classify
/// `Tracked` and sit within the pinned grant, and at least one must be
/// present — mirroring `services/sync-relay/src/shareFilter.ts` moment.append
/// all-paths visibility so a rename crossing the boundary cannot leak the
/// outside path.
fn enforce_share_view_boundary(
    boundary: &ShareBoundary,
    op: &ReplicationEnvelope,
) -> Result<(), SyncError> {
    // Every refusal below is classified by ONE question, because the reader's
    // copy reads the answer: is this a SCOPE decision — the share does not
    // cover this op, which its granter could change — or a payload this
    // boundary cannot place, which nobody but the relay can fix?
    //
    // Scope: no pinned grant (nothing is covered), an op kind a share never
    // carries, a create for a version this share did not grant, a path
    // outside the grant, and a path this surface never replays (secret,
    // unsafe, ignored) — a share covers none of those, ever.
    // Malformed: a create naming no readable version, a snapshot list that is
    // not a list, a snapshot row with no path, a moment with no path at all,
    // and a version id the relay could not have issued.
    //
    // No pinned grant, no containment to enforce — so nothing is admitted.
    let granted = boundary
        .granted
        .as_ref()
        .ok_or(SyncError::ShareBoundaryViolation)?;
    if !matches!(op.op_kind.as_str(), "moment.append" | "version.create") {
        // A KNOWN kind a share does not carry is a scope decision — a secret
        // op, or a chat kind outside the five in `SHARE_VIEW_CHAT_KINDS`
        // (which never reach here), is outside what any file share covers.
        // That is where `chat.follow.set` and `chat.feed.read.set` land: the
        // reader's own state, refused by falling through to this deny. A kind
        // this
        // engine cannot interpret is not: no grant admits it, widening the
        // share changes nothing, and only the sender can fix it.
        return Err(if crate::router::is_owned_op_kind(&op.op_kind) {
            SyncError::ShareBoundaryViolation
        } else {
            SyncError::UnsupportedOperation
        });
    }
    // The version dimension, mirroring the relay's `targetVersionId`: a served
    // op names EXACTLY the version this share granted. A `version.create` is
    // entitled only to a VERSION share, and only to the version it granted.
    //
    // The two failures are NOT the same class, and the reader's copy reads
    // them apart: a create this share does not cover is a scope decision, and
    // a create that names no readable version is a payload this boundary
    // cannot place — the grant may well cover it.
    if op.op_kind == "version.create" {
        // Validity BEFORE the comparison. An unusable version id is not a
        // version this share failed to grant — it is one the relay could
        // never have issued, and comparing it first would report the malformed
        // field as a scope decision and throw its measurements away.
        let claimed = usable_version_id(
            op.payload.get("versionId").and_then(Value::as_str),
            &op.op_kind,
        )?;
        match granted.version_id.as_deref() {
            Some(entitled) if entitled == claimed => {}
            // Both versions named, like the moment path: the reader has to see
            // WHICH lineage was offered against the one the share granted.
            Some(entitled) => {
                return Err(SyncError::ShareVersionMismatch {
                    op_kind: op.op_kind.clone(),
                    granted: entitled.to_owned(),
                    offered: claimed.to_owned(),
                });
            }
            // A share that grants no version is entitled to no create at all,
            // and there is no granted version to name. The moment path reads
            // an absent grant as the main version because that is what the
            // relay serves it moments from; a create has no such reading, and
            // reporting "granted main, offered main" for a create naming main
            // would be a sentence that refutes itself.
            None => return Err(SyncError::ShareBoundaryViolation),
        }
    }
    if op.op_kind == "moment.append" {
        enforce_granted_version(granted, op)?;
    }
    let mut paths = Vec::new();
    for field in MOMENT_PATH_FIELDS {
        if let Some(path) = op.payload.get(field).and_then(Value::as_str) {
            paths.push(path);
        }
    }
    if op.op_kind == "version.create" {
        // The list must BE a list. An explicit `[]` is a healthy served op
        // (see the empty-list note below); a missing, null, or non-array
        // field is a payload this boundary cannot read, and admitting it
        // would replay a version with no files and commit the cursor past it
        // — the same silent loss, with no refusal recorded.
        let snapshots = op
            .payload
            .get("forkSnapshots")
            .and_then(Value::as_array)
            .ok_or(SyncError::InvalidInput {
                reason: "share-view version.create forkSnapshots must be an array",
            })?;
        for snapshot in snapshots {
            let path =
                snapshot
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or(SyncError::InvalidInput {
                        reason: "share-view version.create fork snapshot must carry a path string",
                    })?;
            paths.push(path);
        }
    }
    // A `moment.append` that references no path is malformed, not out of
    // scope — there is nothing to place. A `version.create` is different: it is scoped by the
    // VERSION checked above, and its snapshot list is legitimately empty when
    // the granted version forked with no files, or when none of the source
    // version's files sit inside the granted paths. The relay serves that op
    // (`shareFilter.ts` redacts the list and keeps the op), so refusing it
    // would report damage on a healthy share.
    if paths.is_empty() && op.op_kind != "version.create" {
        return Err(SyncError::InvalidInput {
            reason: "share-view moment.append must reference at least one path",
        });
    }
    for path in paths {
        if !tracked_path_within_grant(path, granted) {
            return Err(SyncError::ShareBoundaryViolation);
        }
    }
    Ok(())
}

/// The relay's own selection rule (`shareFilter.ts` `pathVisibleThroughShare`),
/// re-run against the pinned grant. A granted path selects itself and
/// everything beneath it. NO paths selects every tracked path, but only for a
/// version share: the relay answers `selector.versionId !== null` there, and
/// refuses to create a selector with neither dimension at all
/// (`validateShareSelector`, `empty_selector`). Reading no paths as "the whole
/// workspace" regardless of version is exactly the divergence that would let a
/// grant the relay serves NOTHING through admit everything here.
pub(crate) fn path_within_grant(path: &str, grant: &ShareGrant) -> bool {
    if grant.paths.is_empty() {
        return grant.version_id.is_some();
    }
    grant.paths.iter().any(|selected| {
        path == selected
            || path
                .strip_prefix(selected.as_str())
                .is_some_and(|tail| tail.starts_with('/'))
    })
}

/// The version a served op names, or a MEASURED refusal saying why it is not
/// one the relay could have issued. Both share-view op kinds read their
/// version through this, so neither can compare a value it should have
/// refused, and both report the same limit, unit and observed usage.
fn usable_version_id<'a>(claimed: Option<&'a str>, op_kind: &str) -> Result<&'a str, SyncError> {
    claimed
        .filter(|claimed| is_valid_share_version_id(claimed))
        .ok_or_else(|| SyncError::ShareVersionUnusable {
            // The kind the boundary already admitted, so the persisted detail
            // names the operation that was actually refused.
            op_kind: op_kind.to_owned(),
            limit: MAX_SHARE_VERSION_ID_CHARS,
            // The unit the shared rule measures, so an oversized astral id
            // reports the length that broke the limit, not half of it.
            observed: claimed.map(|claimed| claimed.encode_utf16().count()),
        })
}

/// The version rule, stated identically on the serving side by
/// `services/sync-relay/src/shareFilter.ts` (`filterOpForShare` +
/// `targetVersionId`): a served `moment.append` names EXACTLY the version this
/// share granted — the pinned selector's `versionId`, or `main` when the
/// selector names none. No descendant and no fork is admitted, because the
/// relay serves exactly one version per share, ever.
///
/// What this catches, stated honestly: a relay whose selection diverges from
/// the selector the recipient pinned — a later widened or swapped selector, or
/// a bug in the relay's own filter — cannot land another lineage's moments in
/// the shared view. What it does NOT do is prove authorship. The served
/// payload is constructed by the relay and carries no signature, so a relay
/// that means to lie can restate this field as easily as any other. Pinning
/// plus this check bounds what a diverging relay can DELIVER; it is not
/// forgery resistance, and #506 records the same limit for the path dimension.
///
/// Fail closed on shape as well as value: a moment whose `versionId` is not
/// one the relay could have issued is refused. It cannot be version-checked at
/// all, and accepting it would let a relay disarm this rule by dropping one
/// field. `is_valid_share_version_id` decides "could have issued", which is
/// the selector rule the relay applies at creation — one rule, one place.
fn enforce_granted_version(
    granted: &ShareGrant,
    op: &ReplicationEnvelope,
) -> Result<(), SyncError> {
    let offered = usable_version_id(
        op.payload.get("versionId").and_then(Value::as_str),
        &op.op_kind,
    )?;
    // A grant with no version follows the workspace's main version, which is
    // the version the relay serves moments from for that share — NOT "compare
    // nothing". `version.create` above reads the same field raw, because only
    // a version share is entitled to one at all.
    let entitled = granted.version_id.as_deref().unwrap_or(MAIN_VERSION_ID);
    if entitled != offered {
        return Err(SyncError::ShareVersionMismatch {
            op_kind: op.op_kind.clone(),
            granted: entitled.to_owned(),
            offered: offered.to_owned(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod granted_path_tests {
    use super::{ShareAccess, ShareGrant, path_within_grant};

    fn grant(paths: &[&str], version_id: Option<&str>) -> ShareGrant {
        ShareGrant {
            paths: paths.iter().map(|path| (*path).to_owned()).collect(),
            version_id: version_id.map(str::to_owned),
            access: ShareAccess::View,
        }
    }

    #[test]
    fn no_paths_selects_the_whole_tracked_workspace_only_for_a_version_share() {
        let version_share = grant(&[], Some("v1"));
        assert!(path_within_grant("notes/plan.md", &version_share));
        assert!(path_within_grant("plan.md", &version_share));
    }

    /// The relay refuses to create this selector and serves nothing through
    /// one that exists anyway. The mirror must agree.
    #[test]
    fn no_paths_and_no_version_selects_nothing() {
        let selects_nothing = grant(&[], None);
        assert!(!path_within_grant("notes/plan.md", &selects_nothing));
        assert!(!path_within_grant("plan.md", &selects_nothing));
    }

    #[test]
    fn a_granted_path_selects_itself_and_its_children_only() {
        let granted = grant(&["notes"], None);
        assert!(path_within_grant("notes", &granted));
        assert!(path_within_grant("notes/plan.md", &granted));
        assert!(!path_within_grant("notes-private/plan.md", &granted));
        assert!(!path_within_grant("other/plan.md", &granted));
    }
}
