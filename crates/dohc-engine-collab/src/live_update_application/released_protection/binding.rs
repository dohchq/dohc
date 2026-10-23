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
        let mut out = String::new();
        write_canonical(
            &Value::Array(contributions.iter().map(contribution_value).collect()),
            &mut out,
        );
        let mut input = CONTRIBUTIONS_DOMAIN.to_vec();
        input.extend_from_slice(out.as_bytes());
        Self {
            count: contributions.len() as i64,
            digest: hex_sha256(&input),
        }
    }
}

/// The version of a [`ContributionArtifact`]'s encoding.
const ARTIFACT_VERSION: i64 = 1;

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
    pub fn of(binding: &ReleasedLineageBinding, preservation: &Preservation) -> Self {
        fn listed(contributions: &[RetainedContribution]) -> Value {
            Value::Array(contributions.iter().map(contribution_value).collect())
        }
        let value = serde_json::json!({
            "version": ARTIFACT_VERSION,
            "binding": binding.to_json(),
            "coveredContributions": preservation
                .covered
                .iter()
                .map(|(namespace, contributions)| serde_json::json!({
                    "namespace": namespace,
                    "contributions": listed(contributions),
                }))
                .collect::<Vec<_>>(),
            "mergedContributionIds": listed(&preservation.merged),
        });
        let mut text = String::new();
        write_canonical(&value, &mut text);
        let bytes = text.into_bytes();
        Self {
            sha256: hex_sha256(&bytes),
            merged: UnprovenCommitment::of_listed(&preservation.merged),
            bytes,
        }
    }
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
        let mut input = DIGEST_DOMAIN.to_vec();
        input.extend_from_slice(self.canonical_json().as_bytes());
        hex_sha256(&input)
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
            "tails": match &*self.tails {
                ProtectedTails::Listed(tails) => Value::Array(tails.iter().map(tail_value).collect()),
                ProtectedTails::Invalid => Value::Null,
            },
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
            let parsed: Value = serde_json::from_str(vector["canonical"].as_str().unwrap()).unwrap();
            let binding = ReleasedLineageBinding::from_json(&parsed["binding"]).unwrap();
            let preservation = Preservation {
                status: PreservationStatus::Complete,
                findings: Vec::new(),
                covered: parsed["coveredContributions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|tail| (tail["namespace"].as_str().unwrap().to_owned(), listed(&tail["contributions"])))
                    .collect(),
                merged: listed(&parsed["mergedContributionIds"]),
                preserved: None,
            };
            let artifact = ContributionArtifact::of(&binding, &preservation);
            assert_eq!(std::str::from_utf8(&artifact.bytes).unwrap(), vector["canonical"], "{name}");
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
        assert_eq!(ReleasedLineageBinding::from_json(&binding.to_json()), Some(binding.clone()));
        let mut extra = binding.to_json();
        extra["extra"] = Value::Bool(true);
        assert_eq!(ReleasedLineageBinding::from_json(&extra), None);
        let mut dropped = binding.to_json();
        dropped["incoming"].as_object_mut().unwrap().remove("relayNamespace");
        assert_eq!(ReleasedLineageBinding::from_json(&dropped), None);
        for contribution in carried_and_outbox() {
            let value = contribution.to_json();
            assert_eq!(RetainedContribution::from_json(&value), Some(contribution.clone()));
            let coordinate = match contribution {
                RetainedContribution::Carried { .. } => "journalCursor",
                RetainedContribution::Outbox { .. } => "sequence",
            };
            let author = value["authors"][0].clone();
            let refused: [(&str, &dyn Fn(&mut Value)); 13] = [
                ("another key", &|value| value["extra"] = Value::Bool(true)),
                ("another kind", &|value| value["kind"] = Value::String("other".into())),
                ("no authors", &|value| {
                    value.as_object_mut().unwrap().remove("authors");
                }),
                ("a coordinate of 0", &|value| value[coordinate] = Value::from(0)),
                ("a fractional coordinate", &|value| value[coordinate] = Value::from(1.5)),
                ("an uppercase digest", &|value| value["updateDigest"] = Value::String("C".repeat(64))),
                ("a short digest", &|value| value["updateDigest"] = Value::String("c".repeat(63))),
                ("no author", &|value| value["authors"] = serde_json::json!([])),
                ("two authors", &|value| value["authors"] = Value::Array(vec![author.clone(), author.clone()])),
                ("an author with another key", &|value| value["authors"][0]["note"] = Value::from(1)),
                ("an unknown author kind", &|value| value["authors"] = serde_json::json!([{"kind": "public"}])),
                ("an agent at an explicit depth of 0", &|value| {
                    value["authors"] = serde_json::json!([{"kind": "agent", "agentId": "a", "depth": 0}])
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
            RetainedAuthors::from_json(&serde_json::json!([{"kind": "automation", "automationId": "sort"}])),
            None,
            "an automation names its depth"
        );
        assert_eq!(
            RetainedAuthors::from_json(&serde_json::json!([{"kind": "human", "humanId": "local-person"}])),
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
}
