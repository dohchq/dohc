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

const VERSION: i64 = 2;
const DIGEST_DOMAIN: &[u8] = b"dohc:released-lineage-binding:v2\0";
const CONTRIBUTIONS_DOMAIN: &[u8] = b"dohc:released-tail-contributions:v1\0";

impl UnprovenCommitment {
    /// The commitment to `contributions`, none when there are none: their
    /// count, and `SHA256(UTF8("dohc:released-tail-contributions:v1\0") ||
    /// canonical JSON of all of them in canonical order)` in lowercase hex.
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
        let mut out = String::new();
        write_canonical(
            &Value::Array(contributions.iter().map(contribution_value).collect()),
            &mut out,
        );
        let mut input = CONTRIBUTIONS_DOMAIN.to_vec();
        input.extend_from_slice(out.as_bytes());
        Some(Self {
            count: contributions.len() as i64,
            digest: hex_sha256(&input),
        })
    }
}

impl RetainedContribution {
    /// The contribution's identity as a commitment names it, for inspection.
    pub fn to_json(&self) -> Value {
        contribution_value(self)
    }
}

impl ReleasedLineageBinding {
    /// The binding's canonical JSON.
    pub fn canonical_json(&self) -> String {
        let mut out = String::new();
        write_canonical(&self.to_json(), &mut out);
        out
    }

    /// `SHA256(UTF8("dohc:released-lineage-binding:v2\0") || canonical bytes)`,
    /// in lowercase hex.
    pub fn digest(&self) -> String {
        let mut input = DIGEST_DOMAIN.to_vec();
        input.extend_from_slice(self.canonical_json().as_bytes());
        hex_sha256(&input)
    }

    /// The binding `text` encodes, or none unless `text` is exactly its
    /// canonical JSON.
    pub fn from_canonical_json(text: &str) -> Option<Self> {
        let binding = Self::from_value(&serde_json::from_str(text).ok()?)?;
        (binding.canonical_json() == text).then_some(binding)
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
        let digest = digest.as_str().filter(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        })?;
        Some(UnprovenCommitment {
            count: integer(count, 1)?,
            digest: digest.to_owned(),
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
    match contribution {
        RetainedContribution::Carried {
            delivery_id,
            update_digest,
            journal_cursor,
        } => serde_json::json!({
            "kind": "carried",
            "deliveryId": delivery_id,
            "updateDigest": update_digest,
            "journalCursor": journal_cursor,
        }),
        RetainedContribution::Outbox {
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
        let text = |key: &str| value[key].as_str().unwrap().to_owned();
        let integer = |key: &str| value[key].as_i64().unwrap();
        match value["kind"].as_str().unwrap() {
            "carried" => RetainedContribution::Carried {
                delivery_id: text("deliveryId"),
                update_digest: text("updateDigest"),
                journal_cursor: integer("journalCursor"),
            },
            "outbox" => RetainedContribution::Outbox {
                outbox_id: text("outboxId"),
                sequence: integer("sequence"),
                delivery_id: text("deliveryId"),
                update_digest: text("updateDigest"),
            },
            kind => panic!("{kind}"),
        }
    }

    /// The first commitment vector's contributions, built here rather than
    /// read.
    fn carried_and_outbox() -> Vec<RetainedContribution> {
        vec![
            RetainedContribution::Carried {
                delivery_id: "delivery-1".into(),
                update_digest: "c".repeat(64),
                journal_cursor: 7,
            },
            RetainedContribution::Outbox {
                outbox_id: "outbox".into(),
                sequence: 3,
                delivery_id: "delivery-2".into(),
                update_digest: "d".repeat(64),
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

    /// A commitment names every field, kind and repetition of the work: a
    /// changed identity, digest, sequence or cursor, an addition and a
    /// removal each name other work. Its domain is its own.
    #[test]
    fn a_commitment_changes_with_any_contribution() {
        let [carried, outbox]: [RetainedContribution; 2] = carried_and_outbox().try_into().unwrap();
        let committed = digest(vec![carried.clone(), outbox.clone()]);
        let RetainedContribution::Carried {
            delivery_id,
            update_digest,
            journal_cursor,
        } = carried.clone()
        else {
            unreachable!()
        };
        let RetainedContribution::Outbox {
            outbox_id,
            sequence,
            delivery_id: outbox_delivery,
            update_digest: outbox_digest,
        } = outbox.clone()
        else {
            unreachable!()
        };
        let carried_as = |delivery_id: &str, update_digest: &str, journal_cursor: i64| {
            RetainedContribution::Carried {
                delivery_id: delivery_id.into(),
                update_digest: update_digest.into(),
                journal_cursor,
            }
        };
        let outbox_as = |outbox_id: &str, sequence: i64, delivery_id: &str, update_digest: &str| {
            RetainedContribution::Outbox {
                outbox_id: outbox_id.into(),
                sequence,
                delivery_id: delivery_id.into(),
                update_digest: update_digest.into(),
            }
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
