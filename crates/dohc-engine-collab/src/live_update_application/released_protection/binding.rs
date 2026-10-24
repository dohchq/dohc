//! The one encoding of a [`ReleasedLineageBinding`]: the bytes a hold
//! persists and the wire carries, and the digest that names them. Keys sort
//! at every depth, an absent value is an explicit null, tails stay in
//! namespace order, and each tail names its unproven work by an
//! [`UnprovenCommitment`]. Decoding accepts only those bytes, so a duplicate
//! key, a dropped null or an integer outside the wire range never names a
//! binding. TypeScript reads and writes the same contract;
//! `releasedLineageBindingVectors.json` pins both.
use super::*;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

const VERSION: i64 = 3;
const DIGEST_DOMAIN: &[u8] = b"dohc:released-lineage-binding:v3\0";
const CONTRIBUTIONS_DOMAIN: &[u8] = b"dohc:released-tail-contributions:v2\0";

impl UnprovenCommitment {
    /// The commitment to `contributions`, none when there are none: their
    /// count, and `SHA256(UTF8("dohc:released-tail-contributions:v2\0") ||
    /// canonical JSON of all of them in canonical order)` in lowercase hex.
    /// Each names its authors, so other provenance names other work.
    pub fn of(mut contributions: Vec<RetainedContribution>) -> Option<Self> {
        contributions.sort();
        Self::of_sorted(&contributions)
    }

    /// [`Self::of`] for `contributions` already in canonical order.
    pub(super) fn of_sorted(contributions: &[RetainedContribution]) -> Option<Self> {
        if contributions.is_empty() {
            return None;
        }
        #[cfg(any(test, feature = "test-support"))]
        COMMITMENTS_HERE.with(|commitments| commitments.set(commitments.get() + 1));
        Some(Self::of_listed(contributions))
    }

    /// The count and digest of `contributions`, already in canonical order,
    /// in [`Self::of`]'s encoding; none of them hash as the canonical empty
    /// array. What inspection names the merged list by.
    pub fn of_listed(contributions: &[RetainedContribution]) -> Self {
        match Self::streamed(contributions, || Ok::<(), std::convert::Infallible>(())) {
            Ok(commitment) => commitment,
            Err(never) => match never {},
        }
    }

    /// [`Self::of_listed`] of a preservation's `merged` list, for an
    /// inspection whose artifact is too large to encode: one contribution's
    /// JSON held at a time, reserved through `stop` before it is written,
    /// and `stop` checked every [`ARTIFACT_CHECK_EVERY`] contributions.
    pub fn of_merged(
        merged: &[RetainedContribution],
        stop: Stop<'_>,
    ) -> Result<Self, ApplicationError> {
        let mut unit = stop.working();
        if unit.limited() {
            let longest = merged.iter().map(RetainedContribution::text_bytes).max();
            unit.grow(json_bytes(longest.unwrap_or(0)))?;
        }
        Self::streamed(merged, || stop.check(ProofStage::Encoding))
    }

    /// The commitment to `contributions`, already in canonical order, each
    /// written as canonical JSON in turn and hashed as it goes, so their
    /// array is never held whole; `check` runs before every
    /// [`ARTIFACT_CHECK_EVERY`] of them.
    fn streamed<E>(
        contributions: &[RetainedContribution],
        mut check: impl FnMut() -> Result<(), E>,
    ) -> Result<Self, E> {
        let mut digest = Sha256::new();
        digest.update(CONTRIBUTIONS_DOMAIN);
        digest.update(b"[");
        let mut unit = String::new();
        for (index, contribution) in contributions.iter().enumerate() {
            if index % ARTIFACT_CHECK_EVERY == 0 {
                check()?;
            }
            unit.clear();
            if index > 0 {
                unit.push(',');
            }
            write_canonical(&contribution_value(contribution), &mut unit);
            digest.update(unit.as_bytes());
        }
        digest.update(b"]");
        Ok(Self {
            count: contributions.len() as i64,
            digest: dohc_engine_storage::hex(&digest.finalize()),
        })
    }

    /// The commitment to `count` contributions whose canonical array is
    /// `listed`, hashed in place.
    fn committed(count: usize, listed: &str) -> Self {
        let mut digest = Sha256::new();
        digest.update(CONTRIBUTIONS_DOMAIN);
        digest.update(listed.as_bytes());
        Self {
            count: count as i64,
            digest: dohc_engine_storage::hex(&digest.finalize()),
        }
    }
}

/// The version of a [`ContributionArtifact`]'s encoding.
const ARTIFACT_VERSION: i64 = 1;

/// Contributions, or binding tails, a [`ContributionArtifact`] encodes
/// between its checks of whether to stop.
const ARTIFACT_CHECK_EVERY: usize = 1024;

/// The most a [`ContributionArtifact`] holds: what one blob streams.
pub(super) const MAX_ARTIFACT_BYTES: usize = dohc_engine_storage::MAX_BLOB_BYTES;

/// The most memory encoding one value, or one piece of a binding, as
/// canonical JSON holds for each byte of its text before it is appended:
/// its JSON value, and each string escaped, up to six bytes a byte, once by
/// itself and once in the piece.
const JSON_BYTES_PER_TEXT_BYTE: u64 = 24;

/// What one value's or piece's JSON holds beyond its text: its keys,
/// punctuation and numbers.
const JSON_OVERHEAD_BYTES: u64 = 1024;

/// Everything a current preservation names, as one canonical JSON document
/// the owner downloads by its SHA-256: the format version, the binding, each
/// valid tail's covered contributions with their authors, by namespace, and
/// the merged contributions in canonical order. Inspection's own answer
/// names it only by digest and length, so that answer stays small however
/// much work a hold covers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContributionArtifact {
    pub bytes: Vec<u8>,
    pub sha256: String,
    /// The merged list's commitment, an empty list's included.
    pub merged: UnprovenCommitment,
}

impl ContributionArtifact {
    /// The artifact of `preservation` under `binding`, written in canonical
    /// order one binding tail and one contribution at a time, its memory
    /// reserved through `stop` before each growth, and the value and binding
    /// piece it writes before appending each reserved before it starts.
    /// None, with nothing allocated past it, once it would pass the cap
    /// [`Stop::artifact_cap`], [`MAX_ARTIFACT_BYTES`] for a proof that set
    /// none; the proof goes on. One whose contributions' text alone passes
    /// the cap is none before anything is encoded or reserved. `stop` is
    /// checked before it starts, every [`ARTIFACT_CHECK_EVERY`] tails and
    /// contributions, and around each hash.
    pub fn of(
        binding: &ReleasedLineageBinding,
        preservation: &Preservation,
        stop: Stop<'_>,
    ) -> Result<Option<Self>, ApplicationError> {
        Self::within(binding, preservation, stop, stop.artifact_cap())
    }

    /// [`Self::of`] within `cap` bytes.
    fn within(
        binding: &ReleasedLineageBinding,
        preservation: &Preservation,
        stop: Stop<'_>,
        cap: usize,
    ) -> Result<Option<Self>, ApplicationError> {
        if artifact_floor(preservation) > cap {
            return Ok(None);
        }
        stop.check(ProofStage::Encoding)?;
        let mut buffers = stop.working();
        if buffers.limited() {
            buffers.grow(buffer_bytes(binding, preservation))?;
        }
        let mut text = Capped::new(cap, stop);
        let merged = match encode(binding, preservation, stop, &mut text) {
            Ok(merged) => merged,
            Err(_) if text.over => return Ok(None),
            Err(error) => return Err(error),
        };
        let text = text.text;
        stop.check(ProofStage::Encoding)?;
        let merged = UnprovenCommitment::committed(preservation.merged.len(), &text[merged]);
        stop.check(ProofStage::Encoding)?;
        let sha256 = hex_sha256(text.as_bytes());
        stop.check(ProofStage::Encoding)?;
        Ok(Some(Self {
            bytes: text.into_bytes(),
            sha256,
            merged,
        }))
    }
}

/// [`write_canonical`]'s form of the artifact, its keys in order, written
/// to `text` as it goes; where its merged list runs.
fn encode(
    binding: &ReleasedLineageBinding,
    preservation: &Preservation,
    stop: Stop<'_>,
    text: &mut Capped<'_>,
) -> Result<std::ops::Range<usize>, ApplicationError> {
    fn listed(
        contributions: &[RetainedContribution],
        out: &mut Capped<'_>,
        stop: Stop<'_>,
    ) -> Result<(), ApplicationError> {
        out.push("[")?;
        for (index, contribution) in contributions.iter().enumerate() {
            if index % ARTIFACT_CHECK_EVERY == 0 {
                stop.check(ProofStage::Encoding)?;
            }
            if index > 0 {
                out.push(",")?;
            }
            out.value(&contribution_value(contribution))?;
        }
        out.push("]")
    }
    text.push("{\"binding\":")?;
    write_binding(binding, &mut |piece: &str| text.push(piece), stop)?;
    text.push(",\"coveredContributions\":[")?;
    for (index, (namespace, contributions)) in preservation.covered.iter().enumerate() {
        if index > 0 {
            text.push(",")?;
        }
        text.push("{\"contributions\":")?;
        listed(contributions, text, stop)?;
        text.push(",\"namespace\":")?;
        text.value(&Value::String(namespace.clone()))?;
        text.push("}")?;
    }
    text.push("],\"mergedContributionIds\":")?;
    let merged_from = text.len();
    listed(&preservation.merged, text, stop)?;
    let merged_to = text.len();
    text.push(",\"version\":")?;
    text.value(&Value::from(ARTIFACT_VERSION))?;
    text.push("}")?;
    Ok(merged_from..merged_to)
}

/// What encoding the artifact of `preservation` under `binding` holds
/// beside the artifact, sized for the longest of each: the binding's head
/// as a JSON value and the piece of it written before its tails, one tail's
/// piece, and one value, a contribution or a namespace, before it is
/// appended.
fn buffer_bytes(binding: &ReleasedLineageBinding, preservation: &Preservation) -> u64 {
    let incoming = &binding.incoming;
    let head = [
        &binding.workspace_id,
        &binding.main_version_id,
        &binding.object_id,
        &binding.lineage_claim_id,
        &binding.head_digest,
        &incoming.replication_epoch,
        &incoming.stream_identity,
        &incoming.origin_id,
    ]
    .iter()
    .map(|text| text.len())
    .sum::<usize>()
        + binding.current_path.as_ref().map_or(0, String::len)
        + incoming.relay_namespace.as_ref().map_or(0, String::len);
    let tail = match &*binding.tails {
        ProtectedTails::Listed(tails) => tails
            .iter()
            .map(|tail| {
                tail.namespace.len()
                    + tail.activation_id.len()
                    + tail
                        .release
                        .as_ref()
                        .map_or(0, |release| release.path.len())
                    + match &tail.coverage {
                        RetainedCoverage::Unproven(unproven) => unproven.digest.len(),
                        RetainedCoverage::Invalid => 0,
                    }
            })
            .max()
            .unwrap_or(0),
        ProtectedTails::Invalid => 0,
    };
    let value = preservation
        .covered
        .iter()
        .flat_map(|(namespace, contributions)| {
            contributions
                .iter()
                .map(RetainedContribution::text_bytes)
                .chain([namespace.len()])
        })
        .chain(
            preservation
                .merged
                .iter()
                .map(RetainedContribution::text_bytes),
        )
        .max()
        .unwrap_or(0);
    [head, tail, value]
        .into_iter()
        .map(json_bytes)
        .fold(0, u64::saturating_add)
}

/// What encoding one value or piece of `text` bytes as canonical JSON holds.
fn json_bytes(text: usize) -> u64 {
    u64::try_from(text)
        .unwrap_or(u64::MAX)
        .saturating_mul(JSON_BYTES_PER_TEXT_BYTE)
        .saturating_add(JSON_OVERHEAD_BYTES)
}

/// The fewest bytes the artifact of `preservation` holds: the text of each
/// covered and merged contribution and of each namespace, which JSON
/// writes whole.
fn artifact_floor(preservation: &Preservation) -> usize {
    let listed = |contributions: &[RetainedContribution]| {
        contributions
            .iter()
            .map(RetainedContribution::text_len)
            .sum::<usize>()
    };
    preservation
        .covered
        .iter()
        .map(|(namespace, contributions)| namespace.len() + listed(contributions))
        .sum::<usize>()
        + listed(&preservation.merged)
}

/// Text that never grows past its cap, its capacity included, and reserves
/// its proof's memory for each growth before it allocates.
struct Capped<'a> {
    text: String,
    cap: usize,
    stop: Stop<'a>,
    /// One value's canonical JSON, before it is appended.
    unit: String,
    /// It refused to pass its cap.
    over: bool,
}

impl<'a> Capped<'a> {
    fn new(cap: usize, stop: Stop<'a>) -> Self {
        Self {
            text: String::new(),
            cap,
            stop,
            unit: String::new(),
            over: false,
        }
    }

    fn len(&self) -> usize {
        self.text.len()
    }

    /// Append `piece`, unless that passes the cap: over budget, marked
    /// over, and nothing allocated.
    fn push(&mut self, piece: &str) -> Result<(), ApplicationError> {
        let Some(needed) = self
            .text
            .len()
            .checked_add(piece.len())
            .filter(|needed| *needed <= self.cap)
        else {
            self.over = true;
            return Err(ApplicationError::ConfiguredByteBudgetExceeded);
        };
        if needed > self.text.capacity() {
            let grown = needed
                .max(self.text.capacity().saturating_mul(2))
                .max(4096)
                .min(self.cap);
            self.stop.reserve(grown - self.text.capacity())?;
            self.text.reserve_exact(grown - self.text.len());
        }
        self.text.push_str(piece);
        Ok(())
    }

    /// Append `value`'s canonical JSON.
    fn value(&mut self, value: &Value) -> Result<(), ApplicationError> {
        let mut unit = std::mem::take(&mut self.unit);
        unit.clear();
        write_canonical(value, &mut unit);
        let pushed = self.push(&unit);
        self.unit = unit;
        pushed
    }
}

/// [`write_canonical`] of `binding`'s [`ReleasedLineageBinding::to_json`],
/// to `out` a piece at a time, its tails one at a time, with `stop` checked
/// every [`ARTIFACT_CHECK_EVERY`] tails: the same bytes, however many tails
/// it protects, without holding them all as JSON at once.
fn write_binding(
    binding: &ReleasedLineageBinding,
    out: &mut dyn FnMut(&str) -> Result<(), ApplicationError>,
    stop: Stop<'_>,
) -> Result<(), ApplicationError> {
    let head = binding.untailed_json();
    let mut entries: Vec<(&str, Option<&Value>)> = head
        .as_object()
        .into_iter()
        .flatten()
        .map(|(key, value)| (key.as_str(), Some(value)))
        .chain([("tails", None)])
        .collect();
    entries.sort_unstable_by(|a, b| a.0.cmp(b.0));
    let mut piece = String::from("{");
    for (index, (key, value)) in entries.into_iter().enumerate() {
        if index > 0 {
            piece.push(',');
        }
        piece.push_str(&Value::String(key.to_owned()).to_string());
        piece.push(':');
        match value {
            Some(value) => write_canonical(value, &mut piece),
            None => {
                out(piece.as_str())?;
                piece.clear();
                write_tails(&binding.tails, out, stop)?;
            }
        }
    }
    piece.push('}');
    out(piece.as_str())
}

/// [`write_canonical`] of `tails` as a binding names them, one at a time.
fn write_tails(
    tails: &ProtectedTails,
    out: &mut dyn FnMut(&str) -> Result<(), ApplicationError>,
    stop: Stop<'_>,
) -> Result<(), ApplicationError> {
    let ProtectedTails::Listed(tails) = tails else {
        return out("null");
    };
    out("[")?;
    let mut piece = String::new();
    for (index, tail) in tails.iter().enumerate() {
        if index % ARTIFACT_CHECK_EVERY == 0 {
            stop.check(ProofStage::Encoding)?;
        }
        piece.clear();
        if index > 0 {
            piece.push(',');
        }
        write_canonical(&tail_value(tail), &mut piece);
        out(piece.as_str())?;
    }
    out("]")
}

impl RetainedContribution {
    /// The contribution as a commitment names it, authors included.
    pub fn to_json(&self) -> Value {
        contribution_value(self)
    }

    /// The contribution `value` names, or none unless it has exactly
    /// [`Self::to_json`]'s keys, a lowercase SHA-256 digest, coordinates
    /// from 1 and authors in their canonical form.
    pub fn from_json(value: &Value) -> Option<Self> {
        let mut located = value.as_object()?.clone();
        let authors = RetainedAuthors::from_json(&located.remove("authors")?)?;
        Some(Self::at(
            ContributionLocator::from_json(&Value::Object(located))?,
            authors,
        ))
    }
}

impl ContributionLocator {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Carried {
                delivery_id,
                update_digest,
                journal_cursor,
            } => serde_json::json!({
                "kind": "carried",
                "deliveryId": delivery_id,
                "updateDigest": update_digest,
                "journalCursor": journal_cursor,
            }),
            Self::Outbox {
                outbox_id,
                sequence,
                delivery_id,
                update_digest,
            } => serde_json::json!({
                "kind": "outbox",
                "outboxId": outbox_id,
                "sequence": sequence,
                "deliveryId": delivery_id,
                "updateDigest": update_digest,
            }),
        }
    }

    /// The locator `value` names, or none unless it has exactly
    /// [`Self::to_json`]'s keys, a lowercase SHA-256 digest and coordinates
    /// from 1, as a journal cursor and an outbox sequence count.
    pub fn from_json(value: &Value) -> Option<Self> {
        match value.get("kind")?.as_str()? {
            "carried" => {
                let [delivery_id, journal_cursor, _, update_digest] = fields(
                    value,
                    ["deliveryId", "journalCursor", "kind", "updateDigest"],
                )?;
                Some(Self::Carried {
                    delivery_id: text(delivery_id)?,
                    update_digest: sha256(update_digest)?,
                    journal_cursor: integer(journal_cursor, 1)?,
                })
            }
            "outbox" => {
                let [delivery_id, _, outbox_id, sequence, update_digest] = fields(
                    value,
                    ["deliveryId", "kind", "outboxId", "sequence", "updateDigest"],
                )?;
                Some(Self::Outbox {
                    outbox_id: text(outbox_id)?,
                    sequence: integer(sequence, 1)?,
                    delivery_id: text(delivery_id)?,
                    update_digest: sha256(update_digest)?,
                })
            }
            _ => None,
        }
    }

    /// Whether every field is one [`Self::from_json`] reads: a finding names
    /// only work its reader can locate.
    pub fn readable(&self) -> bool {
        Self::from_json(&self.to_json()).as_ref() == Some(self)
    }
}

impl RetainedAuthors {
    /// The authors `value` names, or none unless it is the list of exactly
    /// one author a moment would record for the actor and attribution it
    /// names, each field within its bounds, or of the unattributed marker.
    pub fn from_json(value: &Value) -> Option<Self> {
        let [author] = value.as_array()?.as_slice() else {
            return None;
        };
        let (actor, attribution) = author_credit(author)?;
        let expected: Value =
            match dohc_engine_domain::moment_author_json(actor.as_deref(), attribution.as_ref()) {
                Some(json) => serde_json::from_str(&json).ok()?,
                None => serde_json::json!([{"kind": "unattributed"}]),
            };
        let mut canonical = String::new();
        write_canonical(&expected, &mut canonical);
        let mut given = String::new();
        write_canonical(value, &mut given);
        (canonical == given).then_some(Self(canonical))
    }

    pub fn to_json(&self) -> Value {
        serde_json::from_str(&self.0).expect("canonical authors are JSON")
    }
}

/// The actor and attribution one author entry names, if each validates as
/// a local write's would; neither for the unattributed marker.
fn author_credit(author: &Value) -> Option<crate::owner_outbox::EntryCredit> {
    use dohc_engine_domain::{ChangeActorKind, ChangeAttribution};
    let (field, actor_kind) = match author.get("kind")?.as_str()? {
        "unattributed" => return Some((None, None)),
        "agent" => ("agentId", ChangeActorKind::Agent),
        "automation" => ("automationId", ChangeActorKind::Automation),
        "human" => ("humanId", ChangeActorKind::Human),
        _ => return None,
    };
    let actor = author.get(field)?.as_str()?.to_owned();
    let on_behalf_of = match author.get("onBehalfOf") {
        None => None,
        Some(value) => Some(value.as_str()?.to_owned()),
    };
    let depth = match author.get("depth") {
        None => 0,
        Some(value) => u32::try_from(value.as_u64()?).ok()?,
    };
    let attribution = ChangeAttribution {
        actor_kind,
        on_behalf_of,
        depth,
        run: None,
    };
    crate::validate_actor_origin_id(&actor).ok()?;
    attribution.validate().ok()?;
    Some((Some(actor), Some(attribution)))
}

impl ReleasedLineageBinding {
    /// The binding's canonical JSON.
    pub fn canonical_json(&self) -> String {
        let mut out = String::new();
        write_canonical(&self.to_json(), &mut out);
        out
    }

    /// `SHA256(UTF8("dohc:released-lineage-binding:v3\0") || canonical bytes)`,
    /// in lowercase hex.
    pub fn digest(&self) -> String {
        Self::canonical_digest(&self.canonical_json())
    }

    /// [`Self::digest`] of the binding whose canonical JSON is `canonical`,
    /// hashed in place: a stored binding [`Self::from_canonical_json`] reads
    /// is its canonical JSON, so this names it without encoding it again.
    pub fn canonical_digest(canonical: &str) -> String {
        let mut digest = Sha256::new();
        digest.update(DIGEST_DOMAIN);
        digest.update(canonical.as_bytes());
        dohc_engine_storage::hex(&digest.finalize())
    }

    /// The binding `text` encodes, or none unless `text` is exactly its
    /// canonical JSON.
    pub fn from_canonical_json(text: &str) -> Option<Self> {
        #[cfg(any(test, feature = "test-support"))]
        BINDING_DECODES_HERE.with(|decodes| decodes.set(decodes.get() + 1));
        let binding = Self::from_value(&serde_json::from_str(text).ok()?)?;
        (binding.canonical_json() == text).then_some(binding)
    }

    /// The binding a parsed JSON value names, or none unless it has exactly
    /// [`Self::to_json`]'s keys, explicit nulls and wire-range integers.
    pub fn from_json(value: &Value) -> Option<Self> {
        Self::from_value(value)
    }

    /// The binding as a JSON value with the canonical JSON's keys and values.
    pub fn to_json(&self) -> Value {
        let mut value = self.untailed_json();
        value["tails"] = match &*self.tails {
            ProtectedTails::Listed(tails) => Value::Array(tails.iter().map(tail_value).collect()),
            ProtectedTails::Invalid => Value::Null,
        };
        value
    }

    /// [`Self::to_json`] without its tails.
    fn untailed_json(&self) -> Value {
        let incoming = &self.incoming;
        serde_json::json!({
            "version": VERSION,
            "workspaceId": self.workspace_id,
            "mainVersionId": self.main_version_id,
            "objectId": self.object_id,
            "lineageClaimId": self.lineage_claim_id,
            "currentPath": self.current_path,
            "restoreGeneration": self.restore_generation,
            "incoming": {
                "relayNamespace": incoming.relay_namespace,
                "replicationEpoch": incoming.replication_epoch,
                "streamIdentity": incoming.stream_identity,
                "originId": incoming.origin_id,
                "originSeq": incoming.origin_seq,
                "relaySeq": incoming.relay_seq,
            },
            "headDigest": self.head_digest,
        })
    }

    fn from_value(value: &Value) -> Option<Self> {
        let [current_path, head_digest, incoming, lineage_claim_id, main_version_id, object_id, restore_generation, tails, version, workspace_id] =
            fields(
                value,
                [
                    "currentPath",
                    "headDigest",
                    "incoming",
                    "lineageClaimId",
                    "mainVersionId",
                    "objectId",
                    "restoreGeneration",
                    "tails",
                    "version",
                    "workspaceId",
                ],
            )?;
        if integer(version, VERSION)? != VERSION {
            return None;
        }
        let [origin_id, origin_seq, relay_namespace, relay_seq, replication_epoch, stream_identity] =
            fields(
                incoming,
                [
                    "originId",
                    "originSeq",
                    "relayNamespace",
                    "relaySeq",
                    "replicationEpoch",
                    "streamIdentity",
                ],
            )?;
        let tails = match tails {
            Value::Null => ProtectedTails::Invalid,
            Value::Array(tails) if !tails.is_empty() => {
                let tails = tails.iter().map(tail_from).collect::<Option<Vec<_>>>()?;
                // One tail per namespace, in namespace order.
                if !tails
                    .windows(2)
                    .all(|pair| pair[0].namespace < pair[1].namespace)
                {
                    return None;
                }
                ProtectedTails::Listed(tails)
            }
            _ => return None,
        };
        Some(Self {
            workspace_id: text(workspace_id)?,
            main_version_id: text(main_version_id)?,
            object_id: text(object_id)?,
            lineage_claim_id: text(lineage_claim_id)?,
            current_path: nullable(current_path, text)?,
            restore_generation: nullable(restore_generation, |value| integer(value, 0))?,
            incoming: IncomingCoordinate {
                relay_namespace: nullable(relay_namespace, text)?,
                replication_epoch: text(replication_epoch)?,
                stream_identity: text(stream_identity)?,
                origin_id: text(origin_id)?,
                origin_seq: integer(origin_seq, 0)?,
                relay_seq: integer(relay_seq, 1)?,
            },
            head_digest: text(head_digest)?,
            tails: Arc::new(tails),
        })
    }
}

fn tail_value(tail: &ProtectedTail) -> Value {
    serde_json::json!({
        "namespace": tail.namespace,
        "activationId": tail.activation_id,
        "release": tail.release.as_ref().map(|release| serde_json::json!({
            "path": release.path,
            "restoreGeneration": release.restore_generation,
        })),
        "unproven": match &tail.coverage {
            RetainedCoverage::Unproven(unproven) => serde_json::json!({
                "count": unproven.count,
                "digest": unproven.digest,
            }),
            RetainedCoverage::Invalid => Value::Null,
        },
    })
}

fn tail_from(value: &Value) -> Option<ProtectedTail> {
    let [activation_id, namespace, release, unproven] =
        fields(value, ["activationId", "namespace", "release", "unproven"])?;
    let release = nullable(release, |release| {
        let [path, restore_generation] = fields(release, ["path", "restoreGeneration"])?;
        Some(TailRelease {
            path: text(path)?,
            restore_generation: integer(restore_generation, 0)?,
        })
    })?;
    let coverage = match nullable(unproven, |unproven| {
        let [count, digest] = fields(unproven, ["count", "digest"])?;
        Some(UnprovenCommitment {
            count: integer(count, 1)?,
            digest: sha256(digest)?,
        })
    })? {
        Some(unproven) => RetainedCoverage::Unproven(unproven),
        None => RetainedCoverage::Invalid,
    };
    Some(ProtectedTail {
        namespace: text(namespace)?,
        activation_id: text(activation_id)?,
        release,
        coverage,
    })
}

fn contribution_value(contribution: &RetainedContribution) -> Value {
    let mut value = contribution.locator().to_json();
    value["authors"] = contribution.authors().to_json();
    value
}

/// A lowercase SHA-256 hex digest.
fn sha256(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        })
        .map(str::to_owned)
}

/// The values of an object with exactly `keys`, in that order.
fn fields<'a, const N: usize>(value: &'a Value, keys: [&str; N]) -> Option<[&'a Value; N]> {
    let object: &Map<String, Value> = value.as_object()?;
    if object.len() != N {
        return None;
    }
    let values = keys
        .iter()
        .map(|key| object.get(*key))
        .collect::<Option<Vec<_>>>()?;
    values.try_into().ok()
}

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// An integer from `min` through the largest the wire carries exactly.
fn integer(value: &Value, min: i64) -> Option<i64> {
    value.as_i64().filter(|value| (min..=SAFE).contains(value))
}

fn nullable<T>(value: &Value, read: impl FnOnce(&Value) -> Option<T>) -> Option<Option<T>> {
    match value {
        Value::Null => Some(None),
        value => read(value).map(Some),
    }
}

/// `value` with every object's keys in byte order and no whitespace.
fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_unstable_by(|a, b| a.0.cmp(b.0));
            out.push('{');
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write_canonical(value, out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        scalar => out.push_str(&scalar.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTORS: &str = include_str!(
        "../../../../../packages/workspace-engine-client/src/relay/releasedLineageBindingVectors.json"
    );

    fn vectors() -> Value {
        serde_json::from_str(VECTORS).unwrap()
    }

    fn contribution(value: &Value) -> RetainedContribution {
        RetainedContribution::from_json(value).unwrap_or_else(|| panic!("{value}"))
    }

    fn agent(id: &str, on_behalf_of: Option<&str>, depth: u32) -> RetainedAuthors {
        RetainedAuthors::credited(
            Some(id),
            Some(&dohc_engine_domain::ChangeAttribution {
                actor_kind: dohc_engine_domain::ChangeActorKind::Agent,
                on_behalf_of: on_behalf_of.map(str::to_owned),
                depth,
                run: None,
            }),
        )
        .unwrap()
    }

    fn unattributed() -> RetainedAuthors {
        RetainedAuthors::credited(None, None).unwrap()
    }

    /// The first commitment vector's contributions, built here rather than
    /// read.
    fn carried_and_outbox() -> Vec<RetainedContribution> {
        vec![
            RetainedContribution::Carried {
                delivery_id: "delivery-1".into(),
                update_digest: "c".repeat(64),
                journal_cursor: 7,
                authors: agent("trip-agent", Some("owner"), 1),
            },
            RetainedContribution::Outbox {
                outbox_id: "outbox".into(),
                sequence: 3,
                delivery_id: "delivery-2".into(),
                update_digest: "d".repeat(64),
                authors: unattributed(),
            },
        ]
    }

    fn digest(contributions: Vec<RetainedContribution>) -> String {
        UnprovenCommitment::of(contributions).unwrap().digest
    }

    /// Both languages commit to the shared vectors' contributions alike, in
    /// any order they are listed in.
    #[test]
    fn the_shared_vectors_commit_as_typescript_does() {
        let vectors = vectors();
        let commitments = vectors["commitments"].as_array().unwrap();
        assert_eq!(
            commitments[0]["digest"],
            digest(carried_and_outbox()),
            "built here"
        );
        for vector in commitments {
            let mut contributions: Vec<_> = vector["contributions"]
                .as_array()
                .unwrap()
                .iter()
                .map(contribution)
                .collect();
            let expected = UnprovenCommitment {
                count: vector["count"].as_i64().unwrap(),
                digest: vector["digest"].as_str().unwrap().to_owned(),
            };
            assert_eq!(
                UnprovenCommitment::of(contributions.clone()).as_ref(),
                Some(&expected),
                "{}",
                vector["name"]
            );
            contributions.reverse();
            assert_eq!(
                UnprovenCommitment::of(contributions),
                Some(expected),
                "{} reversed",
                vector["name"]
            );
        }
        assert_eq!(UnprovenCommitment::of(Vec::new()), None);
    }

    /// Inspection's contribution artifact and the merged list's commitment
    /// encode as the shared vectors pin them, an empty list included.
    #[test]
    fn the_shared_artifact_vectors_encode_as_typescript_does() {
        let vectors = vectors();
        let listed = |value: &Value| -> Vec<RetainedContribution> {
            value.as_array().unwrap().iter().map(contribution).collect()
        };
        for vector in vectors["artifacts"].as_array().unwrap() {
            let name = &vector["name"];
            let parsed: Value =
                serde_json::from_str(vector["canonical"].as_str().unwrap()).unwrap();
            let binding = ReleasedLineageBinding::from_json(&parsed["binding"]).unwrap();
            let preservation = Preservation {
                status: PreservationStatus::Complete,
                findings: Vec::new(),
                covered: parsed["coveredContributions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|tail| {
                        (
                            tail["namespace"].as_str().unwrap().to_owned(),
                            listed(&tail["contributions"]),
                        )
                    })
                    .collect(),
                merged: listed(&parsed["mergedContributionIds"]),
                preserved: None,
            };
            let artifact = ContributionArtifact::of(&binding, &preservation, Stop::NEVER)
                .unwrap()
                .expect("within its cap");
            assert_eq!(
                std::str::from_utf8(&artifact.bytes).unwrap(),
                vector["canonical"],
                "{name}"
            );
            assert_eq!(artifact.sha256, vector["sha256"], "{name}");
            assert_eq!(
                serde_json::json!({"count": artifact.merged.count, "digest": artifact.merged.digest}),
                vector["mergedContributions"],
                "{name}"
            );
        }
    }

    /// A commitment names every field, kind and repetition of the work: a
    /// changed identity, digest, sequence, cursor or author, an addition and
    /// a removal each name other work. Its domain is its own.
    #[test]
    fn a_commitment_changes_with_any_contribution() {
        let [carried, outbox]: [RetainedContribution; 2] = carried_and_outbox().try_into().unwrap();
        let committed = digest(vec![carried.clone(), outbox.clone()]);
        let RetainedContribution::Carried {
            delivery_id,
            update_digest,
            journal_cursor,
            authors: carried_authors,
        } = carried.clone()
        else {
            unreachable!()
        };
        let RetainedContribution::Outbox {
            outbox_id,
            sequence,
            delivery_id: outbox_delivery,
            update_digest: outbox_digest,
            authors: outbox_authors,
        } = outbox.clone()
        else {
            unreachable!()
        };
        let carried_as = |delivery_id: &str, update_digest: &str, journal_cursor: i64| {
            RetainedContribution::Carried {
                delivery_id: delivery_id.into(),
                update_digest: update_digest.into(),
                journal_cursor,
                authors: carried_authors.clone(),
            }
        };
        let outbox_as = |outbox_id: &str, sequence: i64, delivery_id: &str, update_digest: &str| {
            RetainedContribution::Outbox {
                outbox_id: outbox_id.into(),
                sequence,
                delivery_id: delivery_id.into(),
                update_digest: update_digest.into(),
                authors: outbox_authors.clone(),
            }
        };
        let authored = |contribution: &RetainedContribution, authors: RetainedAuthors| {
            RetainedContribution::at(contribution.locator(), authors)
        };
        let other = "e".repeat(64);
        let changed = [
            (
                "a Carried delivery's identity",
                vec![
                    carried_as("delivery-9", &update_digest, journal_cursor),
                    outbox.clone(),
                ],
            ),
            (
                "a Carried delivery's digest",
                vec![
                    carried_as(&delivery_id, &other, journal_cursor),
                    outbox.clone(),
                ],
            ),
            (
                "a Carried delivery's cursor",
                vec![
                    carried_as(&delivery_id, &update_digest, journal_cursor + 1),
                    outbox.clone(),
                ],
            ),
            (
                "an outbox entry's outbox",
                vec![
                    carried.clone(),
                    outbox_as("outbox-9", sequence, &outbox_delivery, &outbox_digest),
                ],
            ),
            (
                "an outbox entry's sequence",
                vec![
                    carried.clone(),
                    outbox_as(&outbox_id, sequence + 1, &outbox_delivery, &outbox_digest),
                ],
            ),
            (
                "an outbox entry's delivery",
                vec![
                    carried.clone(),
                    outbox_as(&outbox_id, sequence, "delivery-9", &outbox_digest),
                ],
            ),
            (
                "an outbox entry's digest",
                vec![
                    carried.clone(),
                    outbox_as(&outbox_id, sequence, &outbox_delivery, &other),
                ],
            ),
            (
                "a Carried delivery's agent",
                vec![
                    authored(&carried, agent("other-agent", Some("owner"), 1)),
                    outbox.clone(),
                ],
            ),
            (
                "a Carried delivery's principal",
                vec![
                    authored(&carried, agent("trip-agent", Some("someone"), 1)),
                    outbox.clone(),
                ],
            ),
            (
                "a Carried delivery's chain depth",
                vec![
                    authored(&carried, agent("trip-agent", Some("owner"), 2)),
                    outbox.clone(),
                ],
            ),
            (
                "a Carried delivery made unattributed",
                vec![authored(&carried, unattributed()), outbox.clone()],
            ),
            (
                "an outbox entry given an author",
                vec![
                    carried.clone(),
                    authored(&outbox, agent("trip-agent", None, 0)),
                ],
            ),
            (
                "the kind of the same identity",
                vec![
                    carried.clone(),
                    carried_as(&outbox_delivery, &outbox_digest, sequence),
                ],
            ),
            (
                "an addition",
                vec![
                    carried.clone(),
                    outbox.clone(),
                    carried_as("delivery-3", &other, 8),
                ],
            ),
            (
                "a repetition",
                vec![carried.clone(), outbox.clone(), carried.clone()],
            ),
            ("a removal", vec![outbox.clone()]),
        ];
        for (case, contributions) in changed {
            assert_ne!(digest(contributions), committed, "{case}");
        }
        assert_eq!(digest(vec![outbox, carried]), committed, "order");
        let mut undomained = String::new();
        write_canonical(
            &Value::Array(
                carried_and_outbox()
                    .iter()
                    .map(contribution_value)
                    .collect(),
            ),
            &mut undomained,
        );
        assert_ne!(hex_sha256(undomained.as_bytes()), committed, "its domain");
    }

    /// The first vector, built here rather than read.
    fn listed() -> ReleasedLineageBinding {
        ReleasedLineageBinding {
            workspace_id: "workspace".into(),
            main_version_id: "main".into(),
            object_id: "object".into(),
            lineage_claim_id: "a".repeat(64),
            current_path: Some("notes/café \"q\"\u{1}.md".into()),
            restore_generation: Some(0),
            incoming: IncomingCoordinate {
                relay_namespace: Some("relay-a".into()),
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
                origin_id: "desktop".into(),
                origin_seq: 0,
                relay_seq: SAFE,
            },
            head_digest: "b".repeat(64),
            tails: Arc::new(ProtectedTails::Listed(vec![
                ProtectedTail {
                    namespace: "relay-a".into(),
                    activation_id: "activation-a".into(),
                    release: Some(TailRelease {
                        path: "notes/plan.md".into(),
                        restore_generation: 2,
                    }),
                    coverage: RetainedCoverage::Unproven(
                        UnprovenCommitment::of(carried_and_outbox()).unwrap(),
                    ),
                },
                ProtectedTail {
                    namespace: "relay-b".into(),
                    activation_id: "activation-b".into(),
                    release: None,
                    coverage: RetainedCoverage::Invalid,
                },
            ])),
        }
    }

    /// Both languages read the shared vectors to the same bytes and digest,
    /// and refuse every malformed one.
    #[test]
    fn the_shared_vectors_encode_and_digest_as_typescript_does() {
        let vectors = vectors();
        let valid = vectors["valid"].as_array().unwrap();
        assert_eq!(valid[0]["canonical"], listed().canonical_json());
        assert_eq!(valid[0]["digest"], listed().digest());
        for vector in valid {
            let canonical = vector["canonical"].as_str().unwrap();
            let binding = ReleasedLineageBinding::from_canonical_json(canonical)
                .unwrap_or_else(|| panic!("{} reads", vector["name"]));
            assert_eq!(binding.canonical_json(), canonical);
            assert_eq!(binding.digest(), vector["digest"].as_str().unwrap());
        }
        for vector in vectors["invalid"].as_array().unwrap() {
            assert_eq!(
                ReleasedLineageBinding::from_canonical_json(vector["text"].as_str().unwrap()),
                None,
                "{} is refused",
                vector["name"]
            );
        }
    }

    /// A parsed binding or contribution reads back only in its exact shape:
    /// a copy request carries both as JSON values, not canonical text.
    #[test]
    fn parsed_values_read_back_only_in_their_exact_shape() {
        let binding = listed();
        assert_eq!(
            ReleasedLineageBinding::from_json(&binding.to_json()),
            Some(binding.clone())
        );
        let mut extra = binding.to_json();
        extra["extra"] = Value::Bool(true);
        assert_eq!(ReleasedLineageBinding::from_json(&extra), None);
        let mut dropped = binding.to_json();
        dropped["incoming"]
            .as_object_mut()
            .unwrap()
            .remove("relayNamespace");
        assert_eq!(ReleasedLineageBinding::from_json(&dropped), None);
        for contribution in carried_and_outbox() {
            let value = contribution.to_json();
            assert_eq!(
                RetainedContribution::from_json(&value),
                Some(contribution.clone())
            );
            let coordinate = match contribution {
                RetainedContribution::Carried { .. } => "journalCursor",
                RetainedContribution::Outbox { .. } => "sequence",
            };
            let author = value["authors"][0].clone();
            type Refusal<'a> = (&'a str, &'a dyn Fn(&mut Value));
            let refused: [Refusal<'_>; 13] = [
                ("another key", &|value| value["extra"] = Value::Bool(true)),
                ("another kind", &|value| {
                    value["kind"] = Value::String("other".into())
                }),
                ("no authors", &|value| {
                    value.as_object_mut().unwrap().remove("authors");
                }),
                ("a coordinate of 0", &|value| {
                    value[coordinate] = Value::from(0)
                }),
                ("a fractional coordinate", &|value| {
                    value[coordinate] = Value::from(1.5)
                }),
                ("an uppercase digest", &|value| {
                    value["updateDigest"] = Value::String("C".repeat(64))
                }),
                ("a short digest", &|value| {
                    value["updateDigest"] = Value::String("c".repeat(63))
                }),
                ("no author", &|value| {
                    value["authors"] = serde_json::json!([])
                }),
                ("two authors", &|value| {
                    value["authors"] = Value::Array(vec![author.clone(), author.clone()])
                }),
                ("an author with another key", &|value| {
                    value["authors"][0]["note"] = Value::from(1)
                }),
                ("an unknown author kind", &|value| {
                    value["authors"] = serde_json::json!([{"kind": "public"}])
                }),
                ("an agent at an explicit depth of 0", &|value| {
                    value["authors"] =
                        serde_json::json!([{"kind": "agent", "agentId": "a", "depth": 0}])
                }),
                ("an author with a control character", &|value| {
                    value["authors"] = serde_json::json!([{"kind": "agent", "agentId": "a\u{1}"}])
                }),
            ];
            for (case, change) in refused {
                let mut changed = value.clone();
                change(&mut changed);
                assert_eq!(RetainedContribution::from_json(&changed), None, "{case}");
            }
        }
        assert_eq!(
            RetainedAuthors::from_json(
                &serde_json::json!([{"kind": "automation", "automationId": "sort"}])
            ),
            None,
            "an automation names its depth"
        );
        assert_eq!(
            RetainedAuthors::from_json(
                &serde_json::json!([{"kind": "human", "humanId": "local-person"}])
            ),
            RetainedAuthors::credited(
                Some("local-person"),
                Some(&dohc_engine_domain::ChangeAttribution {
                    actor_kind: dohc_engine_domain::ChangeActorKind::Human,
                    on_behalf_of: None,
                    depth: 0,
                    run: None,
                })
            ),
        );
    }

    /// Opus's r2c-3c-6 finding 3: a stored binding's digest, hashed in place
    /// from its canonical bytes, is the one its encoding names, for every
    /// pinned vector.
    #[test]
    fn a_digest_hashed_in_place_is_the_bindings_own() {
        for vector in vectors()["valid"].as_array().unwrap() {
            let canonical = vector["canonical"].as_str().unwrap();
            let binding = ReleasedLineageBinding::from_canonical_json(canonical).unwrap();
            let mut encoded = DIGEST_DOMAIN.to_vec();
            encoded.extend_from_slice(binding.canonical_json().as_bytes());
            let digest = ReleasedLineageBinding::canonical_digest(canonical);
            assert_eq!(digest, hex_sha256(&encoded), "{}", vector["name"]);
            assert_eq!(digest, binding.digest(), "{}", vector["name"]);
            assert_eq!(
                digest,
                vector["digest"].as_str().unwrap(),
                "{}",
                vector["name"]
            );
        }
    }

    /// The digest names the domain as well as the bytes.
    #[test]
    fn the_digest_is_domain_separated() {
        let binding = listed();
        assert_ne!(
            binding.digest(),
            hex_sha256(binding.canonical_json().as_bytes())
        );
    }

    /// A none namespace stays an explicit null, never an empty or absent one.
    #[test]
    fn a_none_namespace_is_an_explicit_null() {
        let mut binding = listed();
        binding.incoming.relay_namespace = None;
        let canonical = binding.canonical_json();
        assert!(canonical.contains("\"relayNamespace\":null"));
        assert_eq!(
            ReleasedLineageBinding::from_canonical_json(&canonical),
            Some(binding)
        );
        for dropped in [
            canonical.replace("\"relayNamespace\":null,", ""),
            canonical.replace("\"relayNamespace\":null", "\"relayNamespace\":\"\""),
        ] {
            assert_eq!(ReleasedLineageBinding::from_canonical_json(&dropped), None);
        }
    }

    /// [`listed`] protecting `count` tails.
    fn many_tails(count: usize) -> ReleasedLineageBinding {
        let mut binding = listed();
        binding.tails = Arc::new(ProtectedTails::Listed(
            (0..count)
                .map(|index| ProtectedTail {
                    namespace: format!("relay-{index:08}"),
                    activation_id: format!("activation-{index}"),
                    release: None,
                    coverage: RetainedCoverage::Invalid,
                })
                .collect(),
        ));
        binding
    }

    /// How many tails `piece`, one [`write_binding`] wrote, encodes.
    fn tails_in(piece: &str) -> usize {
        usize::from(
            piece.starts_with("{\"activationId\"") || piece.starts_with(",{\"activationId\""),
        )
    }

    /// [`write_binding`] with nothing to stop it.
    fn written(binding: &ReleasedLineageBinding) -> String {
        let mut out = String::new();
        write_binding(
            binding,
            &mut |piece: &str| {
                out.push_str(piece);
                Ok(())
            },
            Stop::NEVER,
        )
        .unwrap();
        out
    }

    /// Sol's r2c-3c-4 finding 4: the artifact encodes its binding's tails
    /// one at a time, to the bytes the one-pass encoding writes, many tails,
    /// none and invalid ones alike. A proof that stopped encodes none of
    /// them, and one cancelled partway, at its second check, stops there
    /// with only the tails before it encoded.
    #[test]
    fn a_bindings_tails_encode_one_at_a_time_and_stop_partway() {
        let mut invalid = listed();
        invalid.tails = Arc::new(ProtectedTails::Invalid);
        for binding in [
            listed(),
            many_tails(3 * ARTIFACT_CHECK_EVERY),
            many_tails(0),
            invalid,
        ] {
            let mut one_pass = String::new();
            write_canonical(&binding.to_json(), &mut one_pass);
            assert_eq!(written(&binding), one_pass);
        }

        let scratch = dohc_test_scratch::ScratchDir::new().unwrap();
        let store =
            dohc_engine_storage::EngineStore::open(&scratch.path().join("engine.db"), 1).unwrap();
        let proofs: HeldProofs<(), u32> = HeldProofs::new(HeldProofLimit::default());
        let started = || match proofs.admit(&store, "workspace", ()).unwrap() {
            HeldProofAdmission::Started(run, wait) => (run, wait),
            _ => panic!("a free workspace starts its proof"),
        };
        let binding = many_tails(3 * ARTIFACT_CHECK_EVERY);

        let (run, wait) = started();
        let (mut encoded, mut tails) = (Ok(()), usize::MAX);
        run.prove(|job| {
            // Its last caller leaves before it encodes.
            drop(wait);
            let mut count = 0;
            encoded = write_binding(
                &binding,
                &mut |piece: &str| {
                    count += tails_in(piece);
                    Ok(())
                },
                job.stop(),
            );
            tails = count;
            (0, 0)
        });
        assert!(
            matches!(encoded, Err(ApplicationError::Cancelled)),
            "{encoded:?}"
        );
        assert_eq!(tails, 0, "a stopped proof encodes no tail");

        proofs.pause_proofs_at_check(ProofStage::Encoding, 2);
        let (run, wait) = started();
        let encoding = std::thread::spawn(move || {
            let (mut encoded, mut tails) = (Ok(()), 0);
            run.prove(|job| {
                encoded = write_binding(
                    &binding,
                    &mut |piece: &str| {
                        tails += tails_in(piece);
                        Ok(())
                    },
                    job.stop(),
                );
                (0, 0)
            });
            (encoded, tails)
        });
        proofs.wait_for_paused_proof();
        drop(wait);
        let (encoded, tails) = encoding.join().unwrap();
        assert!(
            matches!(encoded, Err(ApplicationError::Cancelled)),
            "{encoded:?}"
        );
        assert_eq!(
            tails, ARTIFACT_CHECK_EVERY,
            "it stopped at its second check"
        );
    }

    /// Sol's r2c-3c-4 finding 2: an artifact refuses before it would pass
    /// its cap, and never allocates past it. Opus's r2c-3c-6 finding 1: past
    /// its cap there is no artifact, and the proof that encoded it goes on,
    /// unstopped, to answer the rest. One exactly at its cap encodes.
    #[test]
    fn an_artifact_refuses_before_it_allocates_past_its_cap() {
        let mut text = Capped::new(10_000, Stop::NEVER);
        let piece = "x".repeat(999);
        let mut pushed = 0;
        let refused = loop {
            match text.push(&piece) {
                Ok(()) => pushed += 1,
                Err(error) => break error,
            }
            assert!(text.text.capacity() <= 10_000, "{}", text.text.capacity());
        };
        assert!(
            matches!(refused, ApplicationError::ConfiguredByteBudgetExceeded),
            "{refused:?}"
        );
        assert!(text.over);
        assert_eq!((pushed, text.len()), (10, 9_990));
        assert!(text.text.capacity() <= 10_000);

        let binding = listed();
        let preservation = Preservation {
            status: PreservationStatus::Complete,
            findings: Vec::new(),
            covered: vec![("relay-a".to_owned(), carried_and_outbox())],
            merged: carried_and_outbox(),
            preserved: None,
        };
        let whole = ContributionArtifact::of(&binding, &preservation, Stop::NEVER)
            .unwrap()
            .expect("within its cap");
        let at_cap =
            ContributionArtifact::within(&binding, &preservation, Stop::NEVER, whole.bytes.len());
        assert_eq!(
            at_cap.ok().flatten().as_ref(),
            Some(&whole),
            "exactly at its cap"
        );
        let past = ContributionArtifact::within(
            &binding,
            &preservation,
            Stop::NEVER,
            whole.bytes.len() - 1,
        );
        assert!(matches!(past, Ok(None)), "{past:?}");

        let scratch = dohc_test_scratch::ScratchDir::new().unwrap();
        let store =
            dohc_engine_storage::EngineStore::open(&scratch.path().join("engine.db"), 1).unwrap();
        let proofs: HeldProofs<(), u32> = HeldProofs::new(HeldProofLimit::default());
        proofs.set_artifact_cap(whole.bytes.len() - 1);
        let HeldProofAdmission::Started(run, _wait) =
            proofs.admit(&store, "workspace", ()).unwrap()
        else {
            panic!("a free workspace starts its proof")
        };
        let mut encoded = None;
        run.prove(|job| {
            encoded = Some((
                ContributionArtifact::of(&binding, &preservation, job.stop()),
                job.stopped(),
            ));
            (0, 0)
        });
        let (encoded, stopped) = encoded.expect("the proof ran");
        assert!(matches!(encoded, Ok(None)), "{encoded:?}");
        assert_eq!(stopped, None, "the proof goes on");
    }

    /// Opus's r2c-3c-8 finding 5: an artifact whose contributions' text
    /// alone passes its cap is too large before it encodes or reserves
    /// anything; one whose text fits but whose JSON does not is encoded
    /// until it passes. Finding 4: either way the merged list's commitment,
    /// hashed as a stream, is the one a whole artifact names.
    #[test]
    fn an_artifact_whose_text_passes_its_cap_is_too_large_without_encoding() {
        let binding = listed();
        let preservation = Preservation {
            status: PreservationStatus::Complete,
            findings: Vec::new(),
            covered: vec![("relay-a".to_owned(), carried_and_outbox())],
            merged: carried_and_outbox(),
            preserved: None,
        };
        let whole = ContributionArtifact::of(&binding, &preservation, Stop::NEVER)
            .unwrap()
            .expect("within its cap");
        let floor = artifact_floor(&preservation);
        assert!(
            floor < whole.bytes.len(),
            "{floor} against {}",
            whole.bytes.len()
        );

        let scratch = dohc_test_scratch::ScratchDir::new().unwrap();
        let store =
            dohc_engine_storage::EngineStore::open(&scratch.path().join("engine.db"), 1).unwrap();
        // What the artifact answers under `cap`, how many checks it passed,
        // and the most its proof reserved.
        let encoded = |cap: usize| {
            let limit = HeldProofLimit::new(1, 1 << 30, 0);
            let proofs: HeldProofs<(), ()> = HeldProofs::new(limit.clone());
            proofs.set_artifact_cap(cap);
            let HeldProofAdmission::Started(run, _wait) =
                proofs.admit(&store, "workspace", ()).unwrap()
            else {
                panic!("a free workspace starts its proof")
            };
            let mut answer = None;
            run.prove(|job| {
                answer = Some(ContributionArtifact::of(
                    &binding,
                    &preservation,
                    job.stop(),
                ));
                ((), 0)
            });
            (
                answer.expect("the proof ran"),
                proofs.checks_passed(),
                limit.peak_reserved_bytes(),
            )
        };
        let (answer, checks, peak) = encoded(floor - 1);
        assert!(matches!(answer, Ok(None)), "{answer:?}");
        assert_eq!((checks, peak), (0, 0), "nothing encoded or reserved");
        let (answer, checks, peak) = encoded(floor);
        assert!(matches!(answer, Ok(None)), "{answer:?}");
        assert!(
            checks > 0 && peak > 0,
            "encoded until it passed: {checks} checks, {peak} bytes"
        );

        let streamed = UnprovenCommitment::of_merged(&preservation.merged, Stop::NEVER).unwrap();
        assert_eq!(streamed, whole.merged);
        assert_eq!(
            UnprovenCommitment::of_listed(&preservation.merged),
            whole.merged
        );
    }
}
