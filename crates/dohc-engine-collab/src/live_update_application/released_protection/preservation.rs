//! Whether a held document's state, merged with every piece of retained work
//! its hold names, contains all of that work: the one check inspection and
//! resolution share. It reads the store and writes nothing. Each contribution
//! applies to scratch state loaded from the lineage the binding names, the
//! head's or an archived one; the canonical state stays as it is.
use super::*;
use crate::ContentKind;

/// The most memory a Y.Doc holds for each byte of the encoded state and
/// updates applied to it, its items, branches and indexes included: an
/// estimate, conservative for text, that measuring a proof's peak keeps
/// honest.
const YDOC_BYTES_PER_ENCODED_BYTE: u64 = 24;

/// What one journal row a lineage's load lists holds: its sequence and
/// blob digest.
const LOADED_ROW_BYTES: u64 = 128;

/// What one contribution adds to a merge's lists beyond its bytes: its
/// place in the merged list and any finding, with room for each to double.
const CONTRIBUTION_SLOT_BYTES: u64 = 2048;

/// What [`inspect_held`] found for a binding.
#[derive(Debug)]
pub enum HeldInspection {
    /// The binding no longer names what the document holds: its lineage,
    /// that lineage's state, its path, restore generation or protected work
    /// changed since it was derived. Nothing about preservation is claimed.
    Stale,
    Current(Preservation),
}

/// Whether the merged state preserves every contribution, worst first:
/// a status never improves on any of its findings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PreservationStatus {
    Complete,
    PendingDependencies,
    MissingEvidence,
    InvalidEvidence,
}

impl PreservationStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::PendingDependencies => "pending-dependencies",
            Self::MissingEvidence => "missing-evidence",
            Self::InvalidEvidence => "invalid-evidence",
        }
    }
}

/// Why preservation is not complete.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PreservationReason {
    /// A contribution's bytes are not stored.
    SourceMissing,
    /// The canonical state holds structs or deletes it could not integrate.
    PendingHeadDependencies,
    /// The merged state still does once every contribution applied.
    PendingContributionDependencies,
    /// A contribution's stored bytes are not the ones its digest names.
    DigestMismatch,
    /// A contribution's bytes do not apply as an update.
    MalformedUpdate,
    /// The window's or a tail's evidence does not read, or contradicts itself.
    ContradictoryEvidence,
    /// The incoming feed names no relay namespace.
    MissingFeedIdentity,
    /// A contribution's evidence names its authors in no form that reads.
    MalformedAuthorship,
}

impl PreservationReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SourceMissing => "source-missing",
            Self::PendingHeadDependencies => "pending-head-dependencies",
            Self::PendingContributionDependencies => "pending-contribution-dependencies",
            Self::DigestMismatch => "digest-mismatch",
            Self::MalformedUpdate => "malformed-update",
            Self::ContradictoryEvidence => "contradictory-evidence",
            Self::MissingFeedIdentity => "missing-feed-identity",
            Self::MalformedAuthorship => "malformed-authorship",
        }
    }

    pub const fn status(self) -> PreservationStatus {
        match self {
            Self::SourceMissing => PreservationStatus::MissingEvidence,
            Self::PendingHeadDependencies | Self::PendingContributionDependencies => {
                PreservationStatus::PendingDependencies
            }
            Self::DigestMismatch
            | Self::MalformedUpdate
            | Self::ContradictoryEvidence
            | Self::MissingFeedIdentity
            | Self::MalformedAuthorship => PreservationStatus::InvalidEvidence,
        }
    }
}

/// One reason, with the tail and where the contribution it concerns is,
/// when it concerns one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreservationFinding {
    pub reason: PreservationReason,
    pub namespace: Option<String>,
    pub contribution: Option<ContributionLocator>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Preservation {
    pub status: PreservationStatus,
    pub findings: Vec<PreservationFinding>,
    /// Every contribution each tail with valid coverage commits to, with its
    /// authors, by namespace in namespace order and then in canonical order:
    /// what a copy credits, whether or not merging added it.
    pub covered: Vec<(String, Vec<RetainedContribution>)>,
    /// The contributions whose application added state to the merge, once
    /// each, in canonical order. Work the canonical state already held adds
    /// nothing; work an earlier contribution left waiting on a later one
    /// counts once the later one integrated it.
    pub merged: Vec<RetainedContribution>,
    /// What a copy keeps; only a complete preservation has it.
    pub preserved: Option<PreservedState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreservedState {
    /// The merged state's file text: Markdown for a rich document.
    pub markdown: String,
    /// The merged native full state.
    pub full_state: Vec<u8>,
}

impl Preservation {
    /// The bytes the preservation keeps: its findings, its covered and
    /// merged lists with every entry's text, and the preserved Markdown and
    /// state.
    pub fn retained_bytes(&self) -> usize {
        use std::mem::size_of;
        let findings = self.findings.capacity() * size_of::<PreservationFinding>()
            + self
                .findings
                .iter()
                .map(|found| {
                    found.namespace.as_ref().map_or(0, String::capacity)
                        + found.contribution.as_ref().map_or(0, ContributionLocator::text_bytes)
                })
                .sum::<usize>();
        let listed = |contributions: &Vec<RetainedContribution>| {
            contributions.capacity() * size_of::<RetainedContribution>()
                + contributions
                    .iter()
                    .map(RetainedContribution::text_bytes)
                    .sum::<usize>()
        };
        let covered = self.covered.capacity() * size_of::<(String, Vec<RetainedContribution>)>()
            + self
                .covered
                .iter()
                .map(|(namespace, contributions)| namespace.capacity() + listed(contributions))
                .sum::<usize>();
        let preserved = self.preserved.as_ref().map_or(0, |preserved| {
            preserved.markdown.capacity() + preserved.full_state.capacity()
        });
        findings + covered + listed(&self.merged) + preserved
    }
}

impl ContributionLocator {
    /// The bytes its text keeps.
    fn text_bytes(&self) -> usize {
        match self {
            Self::Carried {
                delivery_id,
                update_digest,
                ..
            } => delivery_id.capacity() + update_digest.capacity(),
            Self::Outbox {
                outbox_id,
                delivery_id,
                update_digest,
                ..
            } => outbox_id.capacity() + delivery_id.capacity() + update_digest.capacity(),
        }
    }
}

impl RetainedContribution {
    /// The bytes its text keeps, its authors included.
    pub(super) fn text_bytes(&self) -> usize {
        match self {
            Self::Carried {
                delivery_id,
                update_digest,
                authors,
                ..
            } => delivery_id.capacity() + update_digest.capacity() + authors.json().len(),
            Self::Outbox {
                outbox_id,
                delivery_id,
                update_digest,
                authors,
                ..
            } => {
                outbox_id.capacity()
                    + delivery_id.capacity()
                    + update_digest.capacity()
                    + authors.json().len()
            }
        }
    }
}

/// A contribution's stored bytes, as found by the digest that names them.
enum Source {
    Bytes(Vec<u8>),
    Missing,
    Mismatched,
}

impl RetainedContribution {
    fn update_digest(&self) -> &str {
        match self {
            Self::Carried { update_digest, .. } | Self::Outbox { update_digest, .. } => {
                update_digest
            }
        }
    }
}

/// Whether `binding` still names what its document holds and, when it does,
/// whether every contribution it names survives in the state its lineage
/// keeps merged with all of them. The lineage is the one the binding names,
/// so an archived hold is inspected against its archive, never the head.
/// Tails are validated afresh on `conn`, with nothing kept; run it inside
/// one transaction, or on the store's only writer, so every read agrees.
/// `stop` ends it, cancelled, at its next check. What it works with is
/// reserved of `stop`'s memory before it is allocated, from the stored
/// sizes of what it reads: the lineage's state before it loads, each tail's
/// evidence before it is validated, and the merge as it grows.
pub fn inspect_held(
    conn: &Connection,
    binding: &ReleasedLineageBinding,
    stop: Stop<'_>,
) -> Result<HeldInspection, ApplicationError> {
    let doc = DocKey {
        workspace_id: binding.workspace_id.clone(),
        version_id: binding.main_version_id.clone(),
        object_id: binding.object_id.clone(),
    };
    let lineage = binding.lineage_claim_id.as_str();
    let mut working = stop.working();
    if working.limited() {
        working.grow(lineage_workload(conn, &doc, lineage)?)?;
    }
    let (state, digest) = match lineage_state(conn, &doc, lineage, stop)? {
        None => return Ok(HeldInspection::Stale),
        Some(LineageState::Read(canonical, kind, digest)) => (Some((canonical, kind)), digest),
        // A head whose journal does not load has no digest to compare; the
        // rest of the binding must still stand for the finding to be its own.
        Some(LineageState::Corrupt(digest)) => {
            (None, digest.unwrap_or_else(|| binding.head_digest.clone()))
        }
    };
    if digest != binding.head_digest {
        return Ok(HeldInspection::Stale);
    }
    let Some(work) = window_work(conn, &doc, lineage, stop, &mut working)? else {
        return Ok(HeldInspection::Stale);
    };
    let (tails, work) = match work {
        WindowWork::Listed(tails) => {
            let (tails, work): (Vec<_>, Vec<_>) = tails.into_iter().unzip();
            (ProtectedTails::Listed(tails), Some(work))
        }
        WindowWork::Invalid => (ProtectedTails::Invalid, None),
    };
    let key = ProtectionKey {
        doc: &doc,
        lineage_claim_id: lineage,
        incoming: &binding.incoming,
    };
    let current = ReleasedLineageBinding::bound(conn, &key, Arc::new(tails), digest)?;
    if current != *binding {
        return Ok(HeldInspection::Stale);
    }
    let mut findings = Vec::new();
    if binding.incoming.relay_namespace.is_none() {
        findings.push(finding(PreservationReason::MissingFeedIdentity, None, None));
    }
    let mut readable = Vec::new();
    match (&*current.tails, work) {
        (ProtectedTails::Listed(tails), Some(work)) => {
            for (tail, work) in tails.iter().zip(work) {
                match tail.coverage {
                    RetainedCoverage::Unproven(_) => {
                        readable.push((tail.namespace.clone(), work.contributions))
                    }
                    // What made the tail invalid, or the tail itself when
                    // its evidence does not enumerate.
                    RetainedCoverage::Invalid if !work.contradictions.is_empty() => {
                        findings.extend(work.contradictions)
                    }
                    RetainedCoverage::Invalid => findings.push(finding(
                        PreservationReason::ContradictoryEvidence,
                        Some(&tail.namespace),
                        None,
                    )),
                }
            }
        }
        _ => findings.push(finding(
            PreservationReason::ContradictoryEvidence,
            None,
            None,
        )),
    }
    let Some((canonical, kind)) = state else {
        findings.push(finding(PreservationReason::ContradictoryEvidence, None, None));
        return Ok(HeldInspection::Current(concluded(
            findings,
            readable,
            Vec::new(),
            None,
        )));
    };
    preserve(
        &canonical,
        kind,
        findings,
        readable,
        stop,
        |digest| stored_length(conn, digest),
        |digest| stored_source(conn, digest),
    )
    .map(HeldInspection::Current)
}

/// What loading `lineage`'s state holds at most, from the stored lengths of
/// the blobs it loads, read before any loads: the head's latest snapshot and
/// the journal rows after it, listed, or the full state an archive keeps.
/// Each blob loads, applies to the state, and the state is hashed as its
/// full state.
fn lineage_workload(conn: &Connection, doc: &DocKey, lineage: &str) -> Result<u64, ApplicationError> {
    let head = durable::read_marker_in(conn, doc)?
        .is_some_and(|marker| marker.lineage_claim_id.as_deref() == Some(lineage));
    let (rows, bytes): (i64, Option<i64>) = if head {
        conn.prepare_cached(
            "WITH snapshot AS (SELECT up_to_seq,snapshot_blob_sha256 AS sha256 FROM ydoc_snapshots
               WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3
               ORDER BY up_to_seq DESC LIMIT 1),
             loaded AS (SELECT sha256 FROM snapshot
               UNION ALL SELECT update_blob_sha256 FROM ydoc_updates
               WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3
               AND seq>coalesce((SELECT up_to_seq FROM snapshot),0))
             SELECT count(*),sum(length(b.bytes)) FROM loaded l
             LEFT JOIN binary_blobs b ON b.sha256=l.sha256",
        )
        .map_err(read_sql)?
        .query_row(
            params![doc.workspace_id, doc.version_id, doc.object_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(read_sql)?
    } else {
        conn.prepare_cached(
            "SELECT count(*),sum(length(b.bytes)) FROM ydoc_inactive_lineages l
             LEFT JOIN binary_blobs b ON b.sha256=l.full_state_blob_sha256
             WHERE l.workspace_id=?1 AND l.version_id=?2 AND l.object_id=?3
             AND l.lineage_claim_id=?4",
        )
        .map_err(read_sql)?
        .query_row(
            params![doc.workspace_id, doc.version_id, doc.object_id, lineage],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(read_sql)?
    };
    Ok(unsigned(rows)
        .saturating_mul(LOADED_ROW_BYTES)
        .saturating_add(unsigned(bytes.unwrap_or(0)).saturating_mul(YDOC_BYTES_PER_ENCODED_BYTE + 2)))
}

/// A stored count or length, which is never negative.
fn unsigned(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

/// The length of the bytes stored under `digest`, without loading them; 0
/// when none are.
fn stored_length(conn: &Connection, digest: &str) -> Result<u64, ApplicationError> {
    let length: Option<Option<i64>> = conn
        .prepare_cached("SELECT length(bytes) FROM binary_blobs WHERE sha256=?1")
        .map_err(read_sql)?
        .query_row([digest], |row| row.get(0))
        .optional()
        .map_err(read_sql)?;
    Ok(unsigned(length.flatten().unwrap_or(0)))
}

fn finding(
    reason: PreservationReason,
    namespace: Option<&str>,
    contribution: Option<&RetainedContribution>,
) -> PreservationFinding {
    PreservationFinding {
        reason,
        namespace: namespace.map(str::to_owned),
        contribution: contribution.map(RetainedContribution::locator),
    }
}

/// What [`lineage_state`] found of a lineage.
enum LineageState {
    /// Its state, content kind, and the digest a binding names it by.
    Read(Ydoc, ContentKind, String),
    /// Its stored state does not load: the head's journal, or an archive's
    /// bytes, are missing, mismatched or malformed. An archive still names
    /// its digest.
    Corrupt(Option<String>),
}

/// Whether `error` says stored state is corrupt, rather than unreadable.
fn corrupt(error: &CollabError) -> bool {
    matches!(
        error,
        CollabError::Corrupt { .. }
            | CollabError::MalformedUpdate { .. }
            | CollabError::ReplayParityViolation { .. }
    )
}

/// The state `lineage` of the document keeps: the head's, loaded from its
/// journal, or an archived one's, from the full state its archive keeps.
/// None when the document holds no such lineage. `stop` is checked before
/// the state loads, before each of its blobs loads and applies, and before
/// and after it is hashed.
fn lineage_state(
    conn: &Connection,
    doc: &DocKey,
    lineage: &str,
    stop: Stop<'_>,
) -> Result<Option<LineageState>, ApplicationError> {
    stop.check(ProofStage::Replay)?;
    if let Some(marker) = durable::read_marker_in(conn, doc)? {
        if marker.lineage_claim_id.as_deref() == Some(lineage) {
            let head = match durable::load_doc_between::<ApplicationError>(conn, doc, &mut || {
                stop.check(ProofStage::Replay)
            }) {
                Ok(head) => head,
                Err(ApplicationError::Collab(error)) if corrupt(&error) => {
                    return Ok(Some(LineageState::Corrupt(None)))
                }
                Err(error) => return Err(error),
            };
            stop.check(ProofStage::Replay)?;
            let digest = hex_sha256(&head.encode_full_state());
            stop.check(ProofStage::Replay)?;
            return Ok(Some(LineageState::Read(head, marker.content_kind, digest)));
        }
    }
    let archived: Option<(String, String)> = conn
        .query_row(
            "SELECT full_state_blob_sha256,content_kind FROM ydoc_inactive_lineages
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
            params![doc.workspace_id, doc.version_id, doc.object_id, lineage],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(read_sql)?;
    let Some((digest, kind)) = archived else {
        return Ok(None);
    };
    let Source::Bytes(bytes) = stored_source(conn, &digest)? else {
        return Ok(Some(LineageState::Corrupt(Some(digest))));
    };
    stop.check(ProofStage::Replay)?;
    let state = Ydoc::wire();
    match state.apply(&bytes) {
        Ok(()) => {}
        Err(error) if corrupt(&error) => return Ok(Some(LineageState::Corrupt(Some(digest)))),
        Err(error) => return Err(error.into()),
    }
    stop.check(ProofStage::Replay)?;
    Ok(Some(LineageState::Read(state, ContentKind::parse(&kind)?, digest)))
}

/// The bytes stored under `digest`, which must hash to it.
fn stored_source(conn: &Connection, digest: &str) -> Result<Source, ApplicationError> {
    let row: Option<(i64, Vec<u8>)> = conn
        .prepare_cached("SELECT byte_length,bytes FROM binary_blobs WHERE sha256=?1")
        .map_err(read_sql)?
        .query_row([digest], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()
        .map_err(read_sql)?;
    Ok(match row {
        None => Source::Missing,
        Some((length, bytes))
            if usize::try_from(length).is_ok_and(|length| length == bytes.len())
                && hex_sha256(&bytes) == digest =>
        {
            Source::Bytes(bytes)
        }
        Some(_) => Source::Mismatched,
    })
}

/// The state vector and delete set: what a doc has integrated.
fn integrated(doc: &Ydoc) -> (Vec<u8>, Vec<u8>) {
    (doc.encode_state_vector(), doc.encode_delete_set())
}

/// What an update integrates: where each client's insertions end, and what
/// it deletes.
struct Integration {
    ends: Vec<(yrs::ClientID, u32)>,
    deletes: yrs::IdSet,
}

impl Integration {
    fn of(bytes: &[u8]) -> Result<Self, ApplicationError> {
        use yrs::updates::decoder::Decode;
        let update = yrs::Update::decode_v1(bytes).map_err(|_| ApplicationError::Corrupt)?;
        let ends = update
            .insertions(true)
            .iter()
            .filter_map(|(client, ranges)| {
                ranges.iter().map(|range| range.end).max().map(|end| (*client, end))
            })
            .collect();
        Ok(Self {
            ends,
            deletes: update.delete_set().clone(),
        })
    }

    /// Whether a doc with this state vector and delete set holds all of it.
    /// A doc's insertions run from clock zero, so its vector covers every
    /// insertion that ends at or before it.
    fn within(&self, vector: &yrs::StateVector, deleted: &yrs::IdSet) -> bool {
        let empty = Default::default();
        self.ends.iter().all(|(client, end)| *end <= vector.get(client))
            && self
                .deletes
                .iter()
                .all(|(client, ranges)| ranges.subset_of(deleted.get(client).unwrap_or(&empty)))
    }
}

/// Merge every contribution of `work`, each tail's in its canonical order,
/// into scratch state loaded from `canonical`, loading each one's bytes by
/// its digest as it comes. Every contribution is loaded and checked, however
/// many share bytes. `canonical` is never changed. Preservation is complete
/// only when nothing in `findings` or found here holds it back and the
/// canonical and the final merged state hold nothing pending; an
/// intermediate application may wait on a later one.
///
/// Two contradictions stay out of reach. A contribution that reuses a
/// client and clock the merged state already holds, with other content,
/// counts as already integrated: Yjs keeps the first struct at an ID and
/// never compares a later one, so nothing records the difference. Two tails
/// naming one delivery under different digests are not compared with each
/// other: each tail's work is validated alone, and both apply, so neither
/// one's work is lost from the merge.
///
/// `stop` is checked around the scratch state's reconstruction, before each
/// contribution loads and again before it applies, and around the merged
/// state's projection and encoding. What the merge works with is reserved of
/// its memory before it is allocated: the scratch state once the encoding it
/// rebuilds from has its length, each contribution by the `length` of its
/// bytes before they `load`, and the projection by everything merged.
fn preserve(
    canonical: &Ydoc,
    kind: ContentKind,
    mut findings: Vec<PreservationFinding>,
    work: Vec<(String, Vec<RetainedContribution>)>,
    stop: Stop<'_>,
    mut length: impl FnMut(&str) -> Result<u64, ApplicationError>,
    mut load: impl FnMut(&str) -> Result<Source, ApplicationError>,
) -> Result<Preservation, ApplicationError> {
    // A full-state encoding drops what the canonical state holds pending.
    if canonical.has_pending_dependencies() {
        findings.push(finding(
            PreservationReason::PendingHeadDependencies,
            None,
            None,
        ));
        return Ok(concluded(findings, work, Vec::new(), None));
    }
    stop.check(ProofStage::Merge)?;
    let base = canonical.encode_full_state();
    let mut merging = u64::try_from(base.len()).unwrap_or(u64::MAX);
    // The scratch state, and the state vector and delete set read of it
    // before and after each application.
    let mut working = stop.working();
    working.grow(merging.saturating_mul(YDOC_BYTES_PER_ENCODED_BYTE + 2))?;
    stop.check(ProofStage::Merge)?;
    let scratch = Ydoc::wire();
    scratch.apply(&base)?;
    drop(base);
    let mut merged = Vec::new();
    // Contributions whose application left part of them parked, with what
    // each integrates: one counts as merged once the merge holds all of it,
    // whatever else stays pending.
    let mut waiting: Vec<(RetainedContribution, Integration)> = Vec::new();
    for (namespace, contributions) in &work {
        for contribution in contributions {
            stop.check(ProofStage::Merge)?;
            // Its bytes, what they add to the scratch state, to the state
            // vector and delete set read of it and to what waits on them,
            // and its place in the lists.
            let bytes = length(contribution.update_digest())?;
            working.grow(
                bytes
                    .saturating_mul(YDOC_BYTES_PER_ENCODED_BYTE + 4)
                    .saturating_add(CONTRIBUTION_SLOT_BYTES),
            )?;
            merging = merging.saturating_add(bytes);
            let held_back = |reason| finding(reason, Some(namespace.as_str()), Some(contribution));
            let bytes = match load(contribution.update_digest())? {
                Source::Bytes(bytes) => bytes,
                Source::Missing => {
                    findings.push(held_back(PreservationReason::SourceMissing));
                    continue;
                }
                Source::Mismatched => {
                    findings.push(held_back(PreservationReason::DigestMismatch));
                    continue;
                }
            };
            stop.check(ProofStage::Merge)?;
            let before = integrated(&scratch);
            if scratch.apply(&bytes).is_err() {
                findings.push(held_back(PreservationReason::MalformedUpdate));
                continue;
            }
            if integrated(&scratch) != before {
                merged.push(contribution.clone());
                // What this one added may be what an earlier one waited on.
                if !waiting.is_empty() {
                    let (vector, deleted) = (scratch.state_vector(), scratch.delete_set());
                    let (held, still): (Vec<_>, Vec<_>) = waiting
                        .drain(..)
                        .partition(|(_, integration)| integration.within(&vector, &deleted));
                    merged.extend(held.into_iter().map(|(contribution, _)| contribution));
                    waiting = still;
                }
            } else if scratch.has_pending_dependencies() {
                // It added nothing: either the merge held it already, or it
                // is parked, alone or beside an identical earlier one.
                let integration = Integration::of(&bytes)?;
                if !integration.within(&scratch.state_vector(), &scratch.delete_set()) {
                    waiting.push((contribution.clone(), integration));
                }
            }
        }
    }
    if scratch.has_pending_dependencies() {
        findings.push(finding(
            PreservationReason::PendingContributionDependencies,
            None,
            None,
        ));
    }
    merged.sort();
    merged.dedup();
    let complete = findings.is_empty();
    let preserved = if complete {
        // The projection, its Markdown source and the document checking
        // that source rebuilds, and the merged full state.
        working.grow(merging.saturating_mul(YDOC_BYTES_PER_ENCODED_BYTE + 4))?;
        stop.check(ProofStage::Projection)?;
        let projection = scratch.project(kind)?.content;
        let markdown = match kind {
            ContentKind::Richdoc => scratch
                .preserved_markdown_source(&projection)
                .unwrap_or(projection),
            ContentKind::Plaintext | ContentKind::Scene => projection,
        };
        stop.check(ProofStage::Projection)?;
        let full_state = scratch.encode_full_state();
        stop.check(ProofStage::Projection)?;
        Some(PreservedState {
            markdown,
            full_state,
        })
    } else {
        None
    };
    Ok(concluded(findings, work, merged, preserved))
}

fn concluded(
    findings: Vec<PreservationFinding>,
    covered: Vec<(String, Vec<RetainedContribution>)>,
    merged: Vec<RetainedContribution>,
    preserved: Option<PreservedState>,
) -> Preservation {
    let status = findings
        .iter()
        .map(|found| found.reason.status())
        .max()
        .unwrap_or(PreservationStatus::Complete);
    Preservation {
        status,
        findings,
        covered,
        merged,
        preserved,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn outbox(sequence: i64, bytes: &[u8]) -> RetainedContribution {
        RetainedContribution::Outbox {
            outbox_id: "outbox".into(),
            sequence,
            delivery_id: format!("delivery-{sequence}"),
            update_digest: hex_sha256(bytes),
            authors: RetainedAuthors::credited(None, None).unwrap(),
        }
    }

    /// A rich document with one paragraph, and the updates three later
    /// edits make: `first` over it, `second` over `first`, `third` over it.
    fn edits() -> (Ydoc, Vec<u8>, Vec<u8>, Vec<u8>) {
        let canonical = Ydoc::wire();
        let _ = canonical.richdoc_append_paragraph("Kept");
        let writer = Ydoc::wire();
        writer.apply(&canonical.encode_full_state()).unwrap();
        let first = writer.richdoc_append_paragraph("First");
        let second = writer.richdoc_append_paragraph("Second");
        let other = Ydoc::wire();
        other.apply(&canonical.encode_full_state()).unwrap();
        let third = other.richdoc_append_paragraph("Third");
        (canonical, first, second, third)
    }

    fn preserved(
        canonical: &Ydoc,
        work: Vec<RetainedContribution>,
        stored: &HashMap<String, Vec<u8>>,
    ) -> Preservation {
        preserve(
            canonical,
            ContentKind::Richdoc,
            Vec::new(),
            vec![("namespace".to_owned(), work)],
            Stop::NEVER,
            |digest| Ok(stored.get(digest).map_or(0, |bytes| bytes.len() as u64)),
            |digest| {
                Ok(match stored.get(digest) {
                    Some(bytes) if hex_sha256(bytes) == digest => Source::Bytes(bytes.clone()),
                    Some(_) => Source::Mismatched,
                    None => Source::Missing,
                })
            },
        )
        .unwrap()
    }

    fn stored(updates: &[&Vec<u8>]) -> HashMap<String, Vec<u8>> {
        updates
            .iter()
            .map(|bytes| (hex_sha256(bytes), bytes.to_vec()))
            .collect()
    }

    fn reasons(preservation: &Preservation) -> Vec<PreservationReason> {
        preservation.findings.iter().map(|found| found.reason).collect()
    }

    /// Plan r3, containment: work the canonical state already holds merges
    /// nothing and preserves; work only an outbox holds merges, appears in
    /// the copy and the merged state, and is named. The canonical state is
    /// byte-for-byte what it was.
    #[test]
    fn merged_state_contains_every_contribution_and_names_what_it_added() {
        let (canonical, first, _, third) = edits();
        let integrated = Ydoc::wire();
        integrated.apply(&canonical.encode_full_state()).unwrap();
        integrated.apply(&third).unwrap();
        let before = integrated.encode_full_state();
        let contained = preserved(&integrated, vec![outbox(1, &third)], &stored(&[&third]));
        assert_eq!(contained.status, PreservationStatus::Complete);
        assert!(contained.merged.is_empty(), "already integrated: {:?}", contained.merged);
        // Work the state already held is still covered, with its authors,
        // for the copy to credit.
        assert_eq!(contained.covered, [("namespace".to_owned(), vec![outbox(1, &third)])]);
        assert_eq!(integrated.encode_full_state(), before, "the canonical state is unchanged");

        let outbox_only = preserved(&integrated, vec![outbox(1, &third), outbox(2, &first)], &stored(&[&third, &first]));
        assert_eq!(outbox_only.status, PreservationStatus::Complete);
        assert_eq!(outbox_only.merged, vec![outbox(2, &first)]);
        let kept = outbox_only.preserved.expect("a complete preservation keeps its state");
        assert!(kept.markdown.contains("First") && kept.markdown.contains("Third"), "{}", kept.markdown);
        let pinned = Ydoc::wire();
        pinned.apply(&kept.full_state).unwrap();
        assert!(pinned.project(ContentKind::Richdoc).unwrap().content.contains("First"));
        assert_eq!(integrated.encode_full_state(), before, "the canonical state is unchanged");
        assert!(!integrated.project(ContentKind::Richdoc).unwrap().content.contains("First"));
    }

    /// Plan r3: an earlier contribution may wait on a later one, and both
    /// count as merged once it arrives; one whose dependency never arrives
    /// leaves the merge pending, with its own reason.
    #[test]
    fn a_later_contribution_satisfies_an_earlier_ones_dependency() {
        let (canonical, first, second, _) = edits();
        let both = stored(&[&first, &second]);
        // `second` comes first in canonical order and waits for `first`.
        let satisfied = preserved(&canonical, vec![outbox(1, &second), outbox(2, &first)], &both);
        assert_eq!(satisfied.status, PreservationStatus::Complete, "{:?}", satisfied.findings);
        assert_eq!(satisfied.merged, vec![outbox(1, &second), outbox(2, &first)]);
        let markdown = satisfied.preserved.unwrap().markdown;
        assert!(markdown.contains("First") && markdown.contains("Second"), "{markdown}");

        let unresolved = preserved(&canonical, vec![outbox(1, &second)], &both);
        assert_eq!(unresolved.status, PreservationStatus::PendingDependencies);
        assert_eq!(reasons(&unresolved), [PreservationReason::PendingContributionDependencies]);
        assert_eq!(unresolved.preserved, None);
        assert!(unresolved.merged.is_empty(), "nothing integrated: {:?}", unresolved.merged);
    }

    /// Sol's r2a finding 2: A waits for B, and B integrates both, while C
    /// stays pending on a dependency nothing supplies. A and B count as
    /// merged, however long C keeps the merge pending, and C has its reason.
    /// The same holds for a second identity naming A's bytes.
    #[test]
    fn work_a_later_contribution_integrates_counts_while_other_work_stays_pending() {
        let (canonical, first, second, _) = edits();
        let other = Ydoc::wire();
        other.apply(&canonical.encode_full_state()).unwrap();
        let _ = other.richdoc_append_paragraph("Never sent");
        let orphan = other.richdoc_append_paragraph("Orphan");
        let all = stored(&[&first, &second, &orphan]);
        let (a, b, c) = (outbox(1, &second), outbox(2, &first), outbox(3, &orphan));
        let accounted = preserved(&canonical, vec![a.clone(), b.clone(), c.clone()], &all);
        assert_eq!(accounted.status, PreservationStatus::PendingDependencies);
        assert_eq!(reasons(&accounted), [PreservationReason::PendingContributionDependencies]);
        assert_eq!(accounted.merged, vec![a.clone(), b.clone()], "C stays unmerged");
        assert_eq!(accounted.preserved, None);

        let again = RetainedContribution::Outbox {
            outbox_id: "other".into(),
            sequence: 1,
            delivery_id: "again".into(),
            update_digest: hex_sha256(&second),
            authors: RetainedAuthors::credited(None, None).unwrap(),
        };
        let repeated = preserved(&canonical, vec![a.clone(), again.clone(), b.clone(), c], &all);
        assert_eq!(repeated.merged, {
            let mut merged = vec![a, again, b];
            merged.sort();
            merged
        });
    }

    /// Plan r3: canonical pending state has a reason of its own, distinct
    /// from a merge left pending, and never preserves.
    #[test]
    fn pending_canonical_state_is_its_own_reason() {
        let (canonical, first, second, _) = edits();
        let parked = Ydoc::wire();
        parked.apply(&canonical.encode_full_state()).unwrap();
        parked.apply(&second).unwrap();
        assert!(parked.has_pending_dependencies());
        let pending = preserved(&parked, vec![outbox(1, &first)], &stored(&[&first]));
        assert_eq!(pending.status, PreservationStatus::PendingDependencies);
        assert_eq!(reasons(&pending), [PreservationReason::PendingHeadDependencies]);
        assert_eq!(pending.preserved, None);
    }

    /// Plan r3: missing bytes, a digest the stored bytes do not match and
    /// bytes that are no update each keep preservation from completing,
    /// whatever else merges, and name the contribution.
    #[test]
    fn missing_mismatched_or_malformed_bytes_never_preserve() {
        let (canonical, first, _, third) = edits();
        let missing = preserved(&canonical, vec![outbox(1, &first), outbox(2, &third)], &stored(&[&third]));
        assert_eq!(missing.status, PreservationStatus::MissingEvidence);
        assert_eq!(missing.findings, [finding(PreservationReason::SourceMissing, Some("namespace"), Some(&outbox(1, &first)))]);
        assert_eq!(missing.preserved, None);

        let mut swapped = stored(&[&third]);
        swapped.insert(hex_sha256(&first), third.clone());
        let mismatched = preserved(&canonical, vec![outbox(1, &first)], &swapped);
        assert_eq!(mismatched.status, PreservationStatus::InvalidEvidence);
        assert_eq!(reasons(&mismatched), [PreservationReason::DigestMismatch]);

        let garbage = vec![0xff, 0xff, 0xff];
        let malformed = preserved(&canonical, vec![outbox(1, &garbage)], &stored(&[&garbage]));
        assert_eq!(malformed.status, PreservationStatus::InvalidEvidence);
        assert_eq!(reasons(&malformed), [PreservationReason::MalformedUpdate]);
        assert_eq!(malformed.preserved, None);
    }

    /// Sol's r2c-3c-4 finding 2: what a preservation keeps counts its
    /// findings, each with the contribution it names, as well as its lists
    /// and preserved state, so many contradictions are charged.
    #[test]
    fn retained_bytes_count_every_finding() {
        let (canonical, first, _, _) = edits();
        let few = preserved(&canonical, vec![outbox(1, &first)], &stored(&[&first]));
        let many = Preservation {
            findings: (0..10_000)
                .map(|sequence| {
                    finding(
                        PreservationReason::ContradictoryEvidence,
                        Some("namespace"),
                        Some(&outbox(sequence + 1, &first)),
                    )
                })
                .collect(),
            ..few.clone()
        };
        let per_finding = std::mem::size_of::<PreservationFinding>() + "namespace".len() + 64;
        assert!(
            many.retained_bytes() >= few.retained_bytes() + 10_000 * per_finding,
            "{} against {}",
            many.retained_bytes(),
            few.retained_bytes()
        );
        assert!(few.retained_bytes() >= few.preserved.as_ref().unwrap().full_state.len());
    }

    /// Sol's r2c-3c-6 finding 2: a merge reserves what it works with of a
    /// real proof's memory before it allocates it. With room for all of it,
    /// it preserves, and what it keeps fits what it reserved. With room for
    /// less than the scratch state, it refuses before rebuilding it; with
    /// room for the scratch state alone, before it loads a contribution.
    /// Either way the proof is too large, and nothing reserved ever passes
    /// its memory.
    #[test]
    fn a_merge_reserves_what_it_works_with_before_it_allocates_it() {
        let canonical = Ydoc::wire();
        canonical
            .rewrite_content_to_markdown(
                ContentKind::Richdoc,
                &"A paragraph someone wrote in their plan.\n\n".repeat(2_000),
            )
            .unwrap();
        let writer = Ydoc::wire();
        writer.apply(&canonical.encode_full_state()).unwrap();
        let added = writer.richdoc_append_paragraph(&"Added work. ".repeat(1_000));
        let stored = stored(&[&added]);
        let scratch = canonical.encode_full_state().len() as u64 * (YDOC_BYTES_PER_ENCODED_BYTE + 2);
        let contribution =
            added.len() as u64 * (YDOC_BYTES_PER_ENCODED_BYTE + 4) + CONTRIBUTION_SLOT_BYTES;
        let directory = dohc_test_scratch::ScratchDir::new().unwrap();
        let store = dohc_engine_storage::EngineStore::open(&directory.path().join("engine.db"), 1).unwrap();
        // What the merge answers within `capacity`, whether its proof
        // stopped, how many contributions it loaded, how many checks it
        // passed, and the most it reserved at once.
        let merged = |capacity: u64| {
            let limit = HeldProofLimit::new(1, capacity, 0);
            let proofs: HeldProofs<(), ()> = HeldProofs::new(limit.clone());
            let HeldProofAdmission::Started(run, _wait) = proofs.admit(&store, "workspace", ()).unwrap() else {
                panic!("a free workspace starts its proof")
            };
            let (mut answer, mut loads) = (None, 0);
            run.prove(|job| {
                let preserved = preserve(
                    &canonical,
                    ContentKind::Richdoc,
                    Vec::new(),
                    vec![("namespace".to_owned(), vec![outbox(1, &added)])],
                    job.stop(),
                    |digest| Ok(stored.get(digest).map_or(0, |bytes| bytes.len() as u64)),
                    |digest| {
                        loads += 1;
                        Ok(stored.get(digest).map_or(Source::Missing, |bytes| Source::Bytes(bytes.clone())))
                    },
                );
                answer = Some((preserved, job.stopped()));
                ((), 0)
            });
            let (preserved, stopped) = answer.expect("the proof ran");
            (preserved, stopped, loads, proofs.checks_passed(), limit.peak_reserved_bytes())
        };

        let (preserved, stopped, loads, _, peak) = merged(1 << 30);
        let preserved = preserved.expect("room for all of it");
        assert_eq!((preserved.status, stopped, loads), (PreservationStatus::Complete, None, 1));
        assert!(
            peak >= scratch + contribution + preserved.retained_bytes() as u64,
            "what it keeps fits what it reserved: {peak}"
        );

        for (room, what, passed) in [
            (scratch - 1, "the scratch state", 1),
            (scratch + contribution - 1, "a contribution", 3),
        ] {
            let (preserved, stopped, loads, checks, peak) = merged(room);
            assert!(matches!(preserved, Err(ApplicationError::Cancelled)), "{what}: {preserved:?}");
            assert_eq!(stopped, Some(ProofStop::TooLarge), "{what}");
            assert_eq!((loads, checks), (0, passed), "{what}: refused before it was allocated");
            assert!(peak <= room, "{what}: {peak} reserved within {room}");
        }
    }

    /// Findings the caller brings, such as a tail whose evidence does not
    /// read, hold preservation back; the worst status wins.
    #[test]
    fn evidence_the_caller_found_invalid_never_preserves() {
        let (canonical, first, _, _) = edits();
        let invalid = preserve(
            &canonical,
            ContentKind::Richdoc,
            vec![finding(PreservationReason::ContradictoryEvidence, Some("other"), None)],
            vec![("namespace".to_owned(), vec![outbox(1, &first)])],
            Stop::NEVER,
            |_| Ok(0),
            |_| Ok(Source::Missing),
        )
        .unwrap();
        assert_eq!(invalid.status, PreservationStatus::InvalidEvidence);
        assert_eq!(reasons(&invalid), [PreservationReason::ContradictoryEvidence, PreservationReason::SourceMissing]);
        assert_eq!(invalid.preserved, None);
    }
}
