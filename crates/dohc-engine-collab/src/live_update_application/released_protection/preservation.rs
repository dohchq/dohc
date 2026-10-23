//! Whether a held document's state, merged with every piece of retained work
//! its hold names, contains all of that work: the one check inspection and
//! resolution share. It reads the store and writes nothing. Each contribution
//! applies to scratch state loaded from the lineage the binding names, the
//! head's or an archived one; the canonical state stays as it is.
use super::*;
use crate::ContentKind;

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
pub fn inspect_held(
    conn: &Connection,
    binding: &ReleasedLineageBinding,
) -> Result<HeldInspection, ApplicationError> {
    let doc = DocKey {
        workspace_id: binding.workspace_id.clone(),
        version_id: binding.main_version_id.clone(),
        object_id: binding.object_id.clone(),
    };
    let lineage = binding.lineage_claim_id.as_str();
    let (state, digest) = match lineage_state(conn, &doc, lineage)? {
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
    let Some(work) = window_work(conn, &doc, lineage)? else {
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
    preserve(&canonical, kind, findings, readable, |digest| {
        stored_source(conn, digest)
    })
    .map(HeldInspection::Current)
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
/// None when the document holds no such lineage.
fn lineage_state(
    conn: &Connection,
    doc: &DocKey,
    lineage: &str,
) -> Result<Option<LineageState>, ApplicationError> {
    if let Some(marker) = durable::read_marker_in(conn, doc)? {
        if marker.lineage_claim_id.as_deref() == Some(lineage) {
            let head = match durable::load_doc_in(conn, doc) {
                Ok(head) => head,
                Err(error) if corrupt(&error) => return Ok(Some(LineageState::Corrupt(None))),
                Err(error) => return Err(error.into()),
            };
            let digest = hex_sha256(&head.encode_full_state());
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
    let state = Ydoc::wire();
    match state.apply(&bytes) {
        Ok(()) => {}
        Err(error) if corrupt(&error) => return Ok(Some(LineageState::Corrupt(Some(digest)))),
        Err(error) => return Err(error.into()),
    }
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
fn preserve(
    canonical: &Ydoc,
    kind: ContentKind,
    mut findings: Vec<PreservationFinding>,
    work: Vec<(String, Vec<RetainedContribution>)>,
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
    let scratch = Ydoc::wire();
    scratch.apply(&canonical.encode_full_state())?;
    let mut merged = Vec::new();
    // Contributions whose application left part of them parked, with what
    // each integrates: one counts as merged once the merge holds all of it,
    // whatever else stays pending.
    let mut waiting: Vec<(RetainedContribution, Integration)> = Vec::new();
    for (namespace, contributions) in &work {
        for contribution in contributions {
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
        let projection = scratch.project(kind)?.content;
        let markdown = match kind {
            ContentKind::Richdoc => scratch
                .preserved_markdown_source(&projection)
                .unwrap_or(projection),
            ContentKind::Plaintext | ContentKind::Scene => projection,
        };
        Some(PreservedState {
            markdown,
            full_state: scratch.encode_full_state(),
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
            |_| Ok(Source::Missing),
        )
        .unwrap();
        assert_eq!(invalid.status, PreservationStatus::InvalidEvidence);
        assert_eq!(reasons(&invalid), [PreservationReason::ContradictoryEvidence, PreservationReason::SourceMissing]);
        assert_eq!(invalid.preserved, None);
    }
}
