//! The owner's copy of what a hosted replica holds for a released chain: an
//! ordinary recovered file holding the merged projection the host inspected,
//! credited to everyone whose retained work the binding covers. One decision
//! per attempt makes creating it exactly-once across crashes, lost responses
//! and the owner's other devices. Creating it writes no native state and
//! resolves nothing; the host decides that from the accepted creation.

use std::collections::BTreeSet;

use dohc_engine_collab::DocKey;
use dohc_engine_collab::author_coverage::Authors;
use dohc_engine_collab::live_update_application::{
    ProtectedTails, ReleasedLineageBinding, RetainedContribution, RetainedCoverage,
    UnprovenCommitment,
};
use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

use super::{
    RecoveredNameParts, RecoveryCause, RecoveryIdentity, free_recovered_path, recovery_summary,
    valid_claim_id, write_recovery_in_tx,
};
use crate::error::local_corruption;
use crate::file_search::search_policy_for_connection;
use crate::{MAX_WIRE_INTEGER, RelayError, ReplicationEnvelope, SyncError};

/// Every copy's creation moment ID starts with this, so replication can tell
/// a copy's creation from any other moment.
pub const RELEASED_COPY_MOMENT_PREFIX: &str = "released-copy-moment-";
const RELEASED_COPY_OBJECT_PREFIX: &str = "released-copy-object-";
const IDENTITY_DOMAIN: &str = "dohc:released-retained-copy:v1";

/// What the owner keeps: a current binding's complete preservation, as the
/// host inspected it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeepRetainedVersion {
    pub binding: ReleasedLineageBinding,
    pub markdown: String,
    pub projection_sha256: String,
    /// Every contribution each of the binding's tails commits to, with its
    /// authors, by namespace in the binding's order.
    pub covered_contributions: Vec<(String, Vec<RetainedContribution>)>,
    /// The contributions merging added, in canonical order.
    pub merged_contribution_ids: Vec<RetainedContribution>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyPublicationState {
    /// Journaled here, not yet taken by the relay.
    Pending,
    /// The relay took it; which coordinate it accepted is not known yet.
    Acknowledged,
    /// The relay refused it durably. Only this permits another attempt.
    Refused,
    /// The relay's first creation of this copy, from this device or another.
    Accepted,
}

impl CopyPublicationState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Acknowledged => "acknowledged",
            Self::Refused => "refused",
            Self::Accepted => "accepted",
        }
    }
}

/// Where the copy's creation stands with the relay, and at which coordinate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyPublication {
    pub state: CopyPublicationState,
    pub origin_id: String,
    pub origin_seq: i64,
    /// Known for an accepted creation this device saw on the feed or in a
    /// push's answer; unknown for one it received before it kept the copy.
    pub relay_seq: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyResolutionOutcome {
    Resolved,
    Stale,
}

impl CopyResolutionOutcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Resolved => "resolved",
            Self::Stale => "stale",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "resolved" => Some(Self::Resolved),
            "stale" => Some(Self::Stale),
            _ => None,
        }
    }
}

/// [`keep_retained_version`]'s answer: the attempt that stands for the
/// binding, created now or before.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeptRetainedVersion {
    pub binding_digest: String,
    pub attempt: i64,
    pub recovery_object_id: String,
    pub recovery_moment_id: String,
    /// The path the copy was created at. A person may since have moved,
    /// edited or deleted it; the decision stands either way.
    pub recovered_path: String,
    /// This call created the copy.
    pub created: bool,
    pub publication: CopyPublication,
    pub merged_contribution_ids: Vec<RetainedContribution>,
    /// The canonical author list the copy's creation names: every author of
    /// the work the binding covers.
    pub recovery_author_json: String,
    /// The outcome resolution recorded, and when.
    pub resolution: Option<(CopyResolutionOutcome, i64)>,
}

/// The accepted creation a relay names for a copy this origin published
/// again: the coordinate stays in the log, and nothing else changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RedundantRecovery {
    pub origin_seq: i64,
    pub recovery_moment_id: String,
    pub accepted_origin_id: String,
    pub accepted_origin_seq: i64,
    pub accepted_relay_seq: i64,
}

/// An incoming creation, as the moment it would apply.
pub(crate) struct ReceivedCreation<'a> {
    pub moment_id: &'a str,
    pub version_id: &'a str,
    pub object_id: &'a str,
    pub operation: &'a str,
    pub before_present: &'a str,
    pub after_content_kind: Option<&'a str>,
    pub after_blob_sha256: &'a str,
    pub after_byte_length: Option<i64>,
    pub correlation_id: Option<&'a str>,
    /// The authors the creation names, as the feed carries them.
    pub authors: Option<&'a serde_json::Value>,
    /// The creation says its attribution is unavailable.
    pub attribution_unavailable: bool,
}

struct Decision {
    attempt: i64,
    binding_json: String,
    projection_sha256: String,
    projection_byte_length: i64,
    merged_contribution_ids_json: String,
    recovery_object_id: String,
    recovery_moment_id: String,
    recovered_path: String,
    recovery_author_json: String,
    accepted: Option<(String, i64, i64)>,
    resolution: Option<(CopyResolutionOutcome, i64)>,
}

fn invalid(reason: &'static str) -> SyncError {
    SyncError::InvalidInput { reason }
}

/// Keep `input`'s text as an ordinary copy beside the held document, or
/// answer the attempt that already stands for its binding. The copy and its
/// decision commit together or not at all.
pub fn keep_retained_version(
    store: &mut EngineStore,
    workspace_id: &str,
    input: &KeepRetainedVersion,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<KeptRetainedVersion>, SyncError> {
    store.write_with(faults, |tx| {
        keep_retained_version_in_tx(tx, workspace_id, input)
    })
}

/// A binding's decisions are read before any identity is allocated. The
/// latest attempt answers again after a rename, an edit, a deletion, a lost
/// response or a transient publication failure. Only a durable refusal of
/// an unresolved attempt allocates the next one; the refused copy stays.
fn keep_retained_version_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    input: &KeepRetainedVersion,
) -> Result<KeptRetainedVersion, SyncError> {
    let binding = &input.binding;
    let byte_length =
        i64::try_from(input.markdown.len()).map_err(|_| invalid("copy text is too large"))?;
    if binding.workspace_id != workspace_id
        || dohc_engine_storage::hex_sha256(input.markdown.as_bytes()) != input.projection_sha256
        || !input
            .merged_contribution_ids
            .windows(2)
            .all(|pair| pair[0] < pair[1])
    {
        return Err(invalid("the copy does not match its binding or text"));
    }
    let original_path = binding
        .current_path
        .as_deref()
        .ok_or_else(|| invalid("the binding names no path"))?;
    let author_json = covered_authors(
        binding,
        &input.covered_contributions,
        &input.merged_contribution_ids,
    )?;
    owner_lane(tx, workspace_id)?;
    let digest = binding.digest();
    let canonical = binding.canonical_json();
    let merged_json = merged_contributions_json(&input.merged_contribution_ids)?;
    let decisions = read_decisions(tx, workspace_id, &digest)?;
    let attempt = match decisions.last() {
        None => 0,
        Some(latest) => {
            if decisions
                .iter()
                .any(|decision| decision.binding_json != canonical)
            {
                return Err(SyncError::CoordinateDiverged);
            }
            if latest.projection_sha256 != input.projection_sha256
                || latest.projection_byte_length != byte_length
                || latest.merged_contribution_ids_json != merged_json
                || latest.recovery_author_json != author_json
            {
                return Err(invalid("this binding's copy kept other text"));
            }
            if let Some(settled) = decisions
                .iter()
                .find(|decision| decision.resolution.is_some())
            {
                return kept(tx, workspace_id, &digest, settled, input, false);
            }
            let publication = publication_in_tx(tx, workspace_id, latest)?;
            if publication.state != CopyPublicationState::Refused {
                return answer(&digest, latest, input, publication, false);
            }
            latest
                .attempt
                .checked_add(1)
                .filter(|attempt| *attempt <= MAX_WIRE_INTEGER)
                .ok_or_else(|| local_corruption("released copy attempts overflowed"))?
        }
    };
    let identity = copy_identity(workspace_id, &digest, attempt, original_path);
    let key = DocKey {
        workspace_id: workspace_id.to_owned(),
        version_id: binding.main_version_id.clone(),
        object_id: binding.object_id.clone(),
    };
    let received: Option<String> = tx
        .query_row(
            "SELECT path FROM moments WHERE workspace_id=?1 AND moment_id=?2",
            params![workspace_id, identity.moment_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let matches_stored = |tx: &Transaction<'_>, authors: &dyn Fn(Option<&str>) -> bool| {
        stored_creation_matches(
            tx,
            workspace_id,
            &key.version_id,
            &identity,
            &input.projection_sha256,
            byte_length,
            authors,
        )
    };
    let (recovered_path, created) = match received {
        // Another of the owner's devices kept this attempt first and this
        // one received it: the same copy, wherever its path now is, naming
        // the same authors as its push left them.
        Some(path) => {
            let published = published_authors(&author_json);
            let same = |stored: Option<&str>| published.contains(&parsed_authors(stored));
            if !matches_stored(tx, &same)? {
                return Err(SyncError::CoordinateDiverged);
            }
            (path, false)
        }
        None => {
            let occupied: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM file_objects WHERE workspace_id=?1 AND object_id=?2)",
                    params![workspace_id, identity.object_id],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)?;
            if occupied {
                return Err(SyncError::CoordinateDiverged);
            }
            let path = free_recovered_path(
                tx,
                &key,
                RecoveredNameParts::of_original(original_path),
                &digest,
                &input.projection_sha256,
                1,
            )?;
            let search_policy = search_policy_for_connection(tx);
            write_recovery_in_tx(
                tx,
                &key,
                &identity,
                &path,
                &input.markdown,
                Some(&author_json),
                input.now_ms,
                RecoveryCause::ReleasedRetained,
                search_policy.as_ref(),
            )?;
            // What the store kept, not what was asked for, is what the host
            // later compares with its projection.
            let credited = parsed_authors(Some(&author_json));
            if !matches_stored(tx, &|stored| parsed_authors(stored) == credited)? {
                return Err(local_corruption(
                    "the stored copy does not hold the kept text",
                ));
            }
            if outbound_creation(tx, workspace_id, &identity.moment_id)?.is_none() {
                return Err(local_corruption(
                    "the copy's creation is not journaled for the relay",
                ));
            }
            (path, true)
        }
    };
    let (_, collision_ordinal) =
        RecoveredNameParts::of_recovered(&recovered_path, &digest, &input.projection_sha256)
            .ok_or_else(|| local_corruption("a released copy's path lost its marker"))?;
    tx.execute(
        "INSERT INTO released_hold_copy_decisions (
             workspace_id,binding_digest,attempt,binding_json,projection_sha256,
             projection_byte_length,merged_contribution_ids_json,recovery_object_id,
             recovery_moment_id,recovered_path,collision_ordinal,recovery_author_json,created_at_ms
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            workspace_id,
            digest,
            attempt,
            canonical,
            input.projection_sha256,
            byte_length,
            merged_json,
            identity.object_id,
            identity.moment_id,
            recovered_path,
            collision_ordinal.to_string(),
            author_json,
            input.now_ms,
        ],
    )
    .map_err(SyncError::persist)?;
    let decision = read_decisions(tx, workspace_id, &digest)?
        .into_iter()
        .find(|decision| decision.attempt == attempt)
        .ok_or(SyncError::CoordinateDiverged)?;
    kept(tx, workspace_id, &digest, &decision, input, created)
}

/// The copy's object and moment for one attempt at one binding. The path is
/// allocated separately, so devices that chose different paths still name
/// the same copy.
fn copy_identity(
    workspace_id: &str,
    binding_digest: &str,
    attempt: i64,
    original_path: &str,
) -> RecoveryIdentity {
    let id = dohc_engine_storage::hex_sha256(
        format!("{IDENTITY_DOMAIN}\0{workspace_id}\0{binding_digest}\0{attempt}").as_bytes(),
    );
    RecoveryIdentity {
        object_id: format!("{RELEASED_COPY_OBJECT_PREFIX}{id}"),
        moment_id: format!("{RELEASED_COPY_MOMENT_PREFIX}{id}"),
        summary: recovery_summary(RecoveryCause::ReleasedRetained, original_path),
        correlation_id: binding_digest.to_owned(),
    }
}

/// A copy publishes through the owner's ordinary file-moment lane: not a
/// hosted replica's feed, and not a received share's proposals.
fn owner_lane(tx: &Transaction<'_>, workspace_id: &str) -> Result<(), SyncError> {
    let share_view: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM share_view_file_lane WHERE workspace_id=?1)",
            [workspace_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if share_view
        || !crate::journal::workspace_replicates_with_relay_in_tx(tx, workspace_id)?
        || crate::hosted::is_hosted(tx, workspace_id)?
    {
        return Err(invalid(
            "this workspace does not publish files to its owner relay",
        ));
    }
    Ok(())
}

/// Whether the stored creation `identity` names is the copy of exactly
/// `projection_sha256`: a text write of a new object whose stored bytes hash
/// to the digest and have its length, and whose authors `authors` accepts.
fn stored_creation_matches(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    identity: &RecoveryIdentity,
    projection_sha256: &str,
    byte_length: i64,
    authors: &dyn Fn(Option<&str>) -> bool,
) -> Result<bool, SyncError> {
    let stored: Option<(i64, String, Option<String>)> = tx
        .query_row(
            "SELECT blob.byte_length,blob.text,moment.author_json FROM moments AS moment
               JOIN blobs AS blob ON blob.sha256=moment.after_blob_sha256
              WHERE moment.workspace_id=?1 AND moment.moment_id=?2 AND moment.version_id=?3
                AND moment.object_id=?4 AND moment.operation='write'
                AND moment.after_content_kind='text' AND moment.before_present IN (0,1)
                AND moment.after_blob_sha256=?5 AND moment.metadata_correlation_id=?6",
            params![
                workspace_id,
                identity.moment_id,
                version_id,
                identity.object_id,
                projection_sha256,
                identity.correlation_id,
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    Ok(stored.is_some_and(|(length, text, author_json)| {
        length == byte_length
            && i64::try_from(text.len()).is_ok_and(|actual| actual == length)
            && dohc_engine_storage::hex_sha256(text.as_bytes()) == projection_sha256
            && authors(author_json.as_deref())
    }))
}

/// The one author list a copy names: the union of every covered
/// contribution's authors, by the rules a settlement's interval follows,
/// within a moment's limits and never truncated. Each tail's contributions
/// must be exactly the ones its commitment names, so no request can credit
/// other work under the binding; every merged contribution is among them.
fn covered_authors(
    binding: &ReleasedLineageBinding,
    covered: &[(String, Vec<RetainedContribution>)],
    merged: &[RetainedContribution],
) -> Result<String, SyncError> {
    let refused = || invalid("the covered contributions do not match the binding");
    let ProtectedTails::Listed(tails) = &*binding.tails else {
        return Err(refused());
    };
    if tails.len() != covered.len() {
        return Err(refused());
    }
    let mut authors = Authors::default();
    let mut every = BTreeSet::new();
    for (tail, (namespace, contributions)) in tails.iter().zip(covered) {
        let RetainedCoverage::Unproven(commitment) = &tail.coverage else {
            return Err(refused());
        };
        if tail.namespace != *namespace
            || !contributions.windows(2).all(|pair| pair[0] <= pair[1])
            || UnprovenCommitment::of(contributions.clone()).as_ref() != Some(commitment)
        {
            return Err(refused());
        }
        for contribution in contributions {
            authors
                .union_json(contribution.authors().json())
                .map_err(|_| refused())?;
            every.insert(contribution);
        }
    }
    if merged
        .iter()
        .any(|contribution| !every.contains(contribution))
    {
        return Err(invalid("a merged contribution is not covered"));
    }
    if authors.len() > dohc_engine_domain::MAX_MOMENT_AUTHORS
        || authors.journal_bytes() > dohc_engine_domain::MAX_AUTHOR_JSON_BYTES
    {
        return Err(invalid("the covered authors exceed what a moment names"));
    }
    Ok(authors.json())
}

/// The canonical JSON a decision keeps of the merged contributions.
fn merged_contributions_json(merged: &[RetainedContribution]) -> Result<String, SyncError> {
    serde_json::to_string(
        &merged
            .iter()
            .map(RetainedContribution::to_json)
            .collect::<Vec<_>>(),
    )
    .map_err(|_| invalid("merged contributions do not encode"))
}

/// The author list `author_json` names, none for none or one that does not
/// parse.
fn parsed_authors(author_json: Option<&str>) -> Option<serde_json::Value> {
    author_json.and_then(|json| serde_json::from_str(json).ok())
}

/// Each form of a copy's authors its creation can carry on the feed: as
/// kept, or as an owner's push repairs them, which leaves out people only
/// this installation names.
fn published_authors(author_json: &str) -> Vec<Option<serde_json::Value>> {
    let kept = parsed_authors(Some(author_json));
    let mut forms = vec![kept.clone()];
    let repairs: [fn(&mut serde_json::Value) -> bool; 2] = [
        crate::outbound::omit_local_person_authors,
        crate::outbound::omit_client_identity_authors,
    ];
    for repair in repairs {
        let mut payload = serde_json::json!({"authors": kept.clone()});
        repair(&mut payload);
        forms.push(
            payload
                .get("authors")
                .filter(|authors| !authors.is_null())
                .cloned(),
        );
    }
    forms
}

/// The coordinate this device journaled the creation of `moment_id` at.
fn outbound_creation(
    tx: &Transaction<'_>,
    workspace_id: &str,
    moment_id: &str,
) -> Result<Option<(String, i64)>, SyncError> {
    tx.query_row(
        "SELECT origin_id,origin_seq FROM replication_log
          WHERE workspace_id=?1 AND imported=0 AND op_kind='moment.append'
            AND json_extract(payload_json,'$.momentId')=?2
          ORDER BY origin_seq LIMIT 1",
        params![workspace_id, moment_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(SyncError::corrupt)
}

/// Where `decision`'s creation stands. Accepted evidence wins; then this
/// device's own coordinate, refused only by a durable refusal there; then a
/// creation another device published and this one applied.
fn publication_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    decision: &Decision,
) -> Result<CopyPublication, SyncError> {
    if let Some((origin_id, origin_seq, relay_seq)) = &decision.accepted {
        return Ok(CopyPublication {
            state: CopyPublicationState::Accepted,
            origin_id: origin_id.clone(),
            origin_seq: *origin_seq,
            relay_seq: Some(*relay_seq),
        });
    }
    if let Some((origin_id, origin_seq)) =
        outbound_creation(tx, workspace_id, &decision.recovery_moment_id)?
    {
        let refused: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM replication_pending_refusals
                  WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3)",
                params![workspace_id, origin_id, origin_seq],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        let pushed: Option<i64> = tx
            .query_row(
                "SELECT pushed_seq FROM sync_relay_push_state WHERE workspace_id=?1 AND origin_id=?2",
                params![workspace_id, origin_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(SyncError::corrupt)?;
        let state = if refused {
            CopyPublicationState::Refused
        } else if pushed.is_some_and(|pushed| pushed >= origin_seq) {
            CopyPublicationState::Acknowledged
        } else {
            CopyPublicationState::Pending
        };
        return Ok(CopyPublication {
            state,
            origin_id,
            origin_seq,
            relay_seq: None,
        });
    }
    let received: Option<(String, i64)> = tx
        .query_row(
            "SELECT origin_id,origin_seq FROM replication_log
              WHERE workspace_id=?1 AND imported=1 AND apply_disposition='applied'
                AND op_kind='moment.append' AND json_extract(payload_json,'$.momentId')=?2
              ORDER BY rowid LIMIT 1",
            params![workspace_id, decision.recovery_moment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let (origin_id, origin_seq) = received
        .ok_or_else(|| local_corruption("a released copy's creation has no journal entry"))?;
    Ok(CopyPublication {
        state: CopyPublicationState::Accepted,
        origin_id,
        origin_seq,
        relay_seq: None,
    })
}

fn kept(
    tx: &Transaction<'_>,
    workspace_id: &str,
    digest: &str,
    decision: &Decision,
    input: &KeepRetainedVersion,
    created: bool,
) -> Result<KeptRetainedVersion, SyncError> {
    let publication = publication_in_tx(tx, workspace_id, decision)?;
    answer(digest, decision, input, publication, created)
}

fn answer(
    digest: &str,
    decision: &Decision,
    input: &KeepRetainedVersion,
    publication: CopyPublication,
    created: bool,
) -> Result<KeptRetainedVersion, SyncError> {
    Ok(KeptRetainedVersion {
        binding_digest: digest.to_owned(),
        attempt: decision.attempt,
        recovery_object_id: decision.recovery_object_id.clone(),
        recovery_moment_id: decision.recovery_moment_id.clone(),
        recovered_path: decision.recovered_path.clone(),
        created,
        publication,
        merged_contribution_ids: input.merged_contribution_ids.clone(),
        recovery_author_json: decision.recovery_author_json.clone(),
        resolution: decision.resolution,
    })
}

fn read_decisions(
    tx: &Transaction<'_>,
    workspace_id: &str,
    binding_digest: &str,
) -> Result<Vec<Decision>, SyncError> {
    type Row = (
        (i64, String, String, i64, Option<i64>, String, String),
        (String, String, String),
        (
            Option<String>,
            Option<i64>,
            Option<i64>,
            Option<String>,
            Option<i64>,
        ),
    );
    let mut statement = tx
        .prepare_cached(
            "SELECT attempt,binding_json,projection_sha256,projection_byte_length,
                    (SELECT byte_length FROM blobs WHERE sha256=projection_sha256),
                    merged_contribution_ids_json,recovery_author_json,recovery_object_id,
                    recovery_moment_id,recovered_path,accepted_recovery_origin_id,
                    accepted_recovery_origin_seq,accepted_recovery_relay_seq,resolution_outcome,
                    resolution_outcome_at_ms
               FROM released_hold_copy_decisions
              WHERE workspace_id=?1 AND binding_digest=?2
              ORDER BY attempt",
        )
        .map_err(SyncError::corrupt)?;
    let rows = statement
        .query_map(params![workspace_id, binding_digest], |row| {
            Ok((
                (
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ),
                (row.get(7)?, row.get(8)?, row.get(9)?),
                (
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                    row.get(13)?,
                    row.get(14)?,
                ),
            ))
        })
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<Row>, _>>()
        .map_err(SyncError::corrupt)?;
    rows.into_iter()
        .map(
            |(
                (
                    attempt,
                    binding_json,
                    projection_sha256,
                    projection_byte_length,
                    stored_byte_length,
                    merged_contribution_ids_json,
                    recovery_author_json,
                ),
                (recovery_object_id, recovery_moment_id, recovered_path),
                (origin_id, origin_seq, relay_seq, outcome, outcome_at_ms),
            )| {
                if !decision_reads(
                    binding_digest,
                    &binding_json,
                    &merged_contribution_ids_json,
                    &recovery_author_json,
                ) || stored_byte_length != Some(projection_byte_length)
                {
                    return Err(local_corruption("a copy decision does not read"));
                }
                let accepted = match (origin_id, origin_seq, relay_seq) {
                    (Some(origin_id), Some(origin_seq), Some(relay_seq)) => {
                        Some((origin_id, origin_seq, relay_seq))
                    }
                    (None, None, None) => None,
                    _ => return Err(local_corruption("a copy decision's acceptance is partial")),
                };
                let resolution = match (outcome, outcome_at_ms) {
                    (Some(outcome), Some(at_ms)) => Some((
                        CopyResolutionOutcome::parse(&outcome).ok_or_else(|| {
                            local_corruption("a copy decision's outcome is unknown")
                        })?,
                        at_ms,
                    )),
                    (None, None) => None,
                    _ => return Err(local_corruption("a copy decision's outcome is partial")),
                };
                Ok(Decision {
                    attempt,
                    binding_json,
                    projection_sha256,
                    projection_byte_length,
                    merged_contribution_ids_json,
                    recovery_object_id,
                    recovery_moment_id,
                    recovered_path,
                    recovery_author_json,
                    accepted,
                    resolution,
                })
            },
        )
        .collect()
}

/// Whether a decision's columns agree with each other and with its key: the
/// binding's canonical JSON names `binding_digest`, the merged contributions
/// are valid ones in canonical order as their canonical JSON, and the
/// authors a canonical list within a moment's limits that credits every
/// merged contribution's.
fn decision_reads(
    binding_digest: &str,
    binding_json: &str,
    merged_json: &str,
    author_json: &str,
) -> bool {
    let binding_reads = ReleasedLineageBinding::from_canonical_json(binding_json)
        .is_some_and(|binding| binding.digest() == binding_digest);
    let merged = serde_json::from_str::<Vec<serde_json::Value>>(merged_json)
        .ok()
        .and_then(|values| {
            values
                .iter()
                .map(RetainedContribution::from_json)
                .collect::<Option<Vec<_>>>()
        })
        .filter(|merged| merged.windows(2).all(|pair| pair[0] < pair[1]))
        .filter(|merged| {
            merged_contributions_json(merged).is_ok_and(|canonical| canonical == merged_json)
        });
    let Some(merged) = merged else {
        return false;
    };
    let mut authors = Authors::default();
    if !binding_reads
        || authors.union_json(author_json).is_err()
        || authors.is_empty()
        || authors.json() != author_json
        || authors.len() > dohc_engine_domain::MAX_MOMENT_AUTHORS
        || authors.journal_bytes() > dohc_engine_domain::MAX_AUTHOR_JSON_BYTES
    {
        return false;
    }
    merged.iter().all(|contribution| {
        authors.union_json(contribution.authors().json()).is_ok() && authors.json() == author_json
    })
}

/// Whether `creation` is a copy this replica already holds: the same
/// version, object and moment, a text creation of a new object with the same
/// stored bytes, length and correlation, and the same retained authorship:
/// the copy here and the creation each name the authors this device's
/// decision credits, as kept or as an owner's push repairs them, or, with no
/// decision here, the creation names exactly the copy's authors.
/// Recording time and path do not decide it.
pub(crate) fn equivalent_released_copy_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    creation: &ReceivedCreation<'_>,
) -> Result<bool, SyncError> {
    let Some(correlation_id) = creation.correlation_id else {
        return Ok(false);
    };
    if !creation.moment_id.starts_with(RELEASED_COPY_MOMENT_PREFIX)
        || creation.operation != "write"
        || !matches!(creation.before_present, "absent" | "null")
        || !matches!(creation.after_content_kind, None | Some("text"))
        || !valid_claim_id(correlation_id)
        || creation.attribution_unavailable
    {
        return Ok(false);
    }
    let stored: Option<(i64, String, Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT blob.byte_length,blob.text,moment.author_json,decision.recovery_author_json
               FROM moments AS moment
               JOIN blobs AS blob ON blob.sha256=moment.after_blob_sha256
               LEFT JOIN released_hold_copy_decisions AS decision
                 ON decision.workspace_id=moment.workspace_id
                AND decision.recovery_moment_id=moment.moment_id
                AND decision.binding_digest=moment.metadata_correlation_id
              WHERE moment.workspace_id=?1 AND moment.moment_id=?2 AND moment.version_id=?3
                AND moment.object_id=?4 AND moment.operation='write'
                AND moment.after_content_kind='text' AND moment.before_present IN (0,1)
                AND moment.after_blob_sha256=?5 AND moment.metadata_correlation_id=?6",
            params![
                workspace_id,
                creation.moment_id,
                creation.version_id,
                creation.object_id,
                creation.after_blob_sha256,
                correlation_id,
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    Ok(stored.is_some_and(|(length, text, author_json, credited)| {
        creation
            .after_byte_length
            .is_none_or(|incoming| incoming == length)
            && i64::try_from(text.len()).is_ok_and(|actual| actual == length)
            && dohc_engine_storage::hex_sha256(text.as_bytes()) == creation.after_blob_sha256
            && match credited {
                Some(credited) => {
                    let published = published_authors(&credited);
                    published.contains(&parsed_authors(author_json.as_deref()))
                        && published.contains(&creation.authors.cloned())
                }
                // Received here, never kept: the copy here is the first
                // creation as it was published.
                None => parsed_authors(author_json.as_deref()) == creation.authors.cloned(),
            }
    }))
}

/// Record the relay's accepted creation of `moment_id` on the decision that
/// created it. The first coordinate recorded stands: the feed delivers the
/// accepted creation before any redundant one.
pub(crate) fn record_released_copy_acceptance_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    moment_id: &str,
    origin_id: &str,
    origin_seq: i64,
    relay_seq: i64,
) -> Result<(), SyncError> {
    if !moment_id.starts_with(RELEASED_COPY_MOMENT_PREFIX) {
        return Ok(());
    }
    tx.execute(
        "UPDATE released_hold_copy_decisions
            SET accepted_recovery_origin_id=?3,accepted_recovery_origin_seq=?4,
                accepted_recovery_relay_seq=?5
          WHERE workspace_id=?1 AND recovery_moment_id=?2
            AND accepted_recovery_origin_id IS NULL",
        params![workspace_id, moment_id, origin_id, origin_seq, relay_seq],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

/// A copy's creation coming back on the feed at its relay coordinate.
pub(crate) fn record_released_copy_echo_in_tx(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
) -> Result<(), SyncError> {
    let (Some(relay_seq), Some(moment_id)) = (
        envelope.relay_seq,
        envelope
            .payload
            .get("momentId")
            .and_then(serde_json::Value::as_str),
    ) else {
        return Ok(());
    };
    if envelope.op_kind != "moment.append" {
        return Ok(());
    }
    record_released_copy_acceptance_in_tx(
        tx,
        &envelope.workspace_id,
        moment_id,
        &envelope.origin_id,
        envelope.origin_seq,
        relay_seq,
    )
}

/// A relay's redundant classifications must each name a copy's creation in
/// `batch` and an accepted coordinate other than its own. Only the owner's
/// log classifies them.
pub(crate) fn validate_redundant_recoveries(
    redundant: &[RedundantRecovery],
    batch: &[ReplicationEnvelope],
    hosted: bool,
) -> Result<(), RelayError> {
    if hosted && !redundant.is_empty() {
        return Err(RelayError::InvalidResponse);
    }
    let mut seen = std::collections::BTreeSet::new();
    for recovery in redundant {
        let op = batch
            .iter()
            .find(|op| op.origin_seq == recovery.origin_seq)
            .ok_or(RelayError::InvalidResponse)?;
        let named = op
            .payload
            .get("momentId")
            .and_then(serde_json::Value::as_str);
        if !seen.insert(recovery.origin_seq)
            || op.op_kind != "moment.append"
            || named != Some(recovery.recovery_moment_id.as_str())
            || !recovery
                .recovery_moment_id
                .starts_with(RELEASED_COPY_MOMENT_PREFIX)
            || recovery.accepted_origin_id.is_empty()
            || !(0..=MAX_WIRE_INTEGER).contains(&recovery.accepted_origin_seq)
            || !(1..=MAX_WIRE_INTEGER).contains(&recovery.accepted_relay_seq)
            || (recovery.accepted_origin_id == op.origin_id
                && recovery.accepted_origin_seq == op.origin_seq)
        {
            return Err(RelayError::InvalidResponse);
        }
    }
    Ok(())
}

/// Record a push's redundant classifications before its cursor moves, so a
/// crash between the two resends the batch and the relay answers the same.
pub(crate) fn record_redundant_publication(
    store: &mut EngineStore,
    workspace_id: &str,
    redundant: &[RedundantRecovery],
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<()>, SyncError> {
    store.write_with(faults, |tx| {
        for recovery in redundant {
            record_released_copy_acceptance_in_tx(
                tx,
                workspace_id,
                &recovery.recovery_moment_id,
                &recovery.accepted_origin_id,
                recovery.accepted_origin_seq,
                recovery.accepted_relay_seq,
            )?;
        }
        Ok(())
    })
}
