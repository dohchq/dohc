use super::*;
use dohc_engine_collab::live_update_application::{
    LiveUpdateReceipt, NativeHistoryReconstruction, OwnerAdoptionCut, RetainedPrefix,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CutHeader {
    relay_database_namespace: String,
    adoption_id: String,
    source_moment_id: String,
    source_digest: String,
    source_byte_length: i64,
    baseline_moment_relay_sequence: i64,
    baseline_registered_at_ms: i64,
    expected_local_sequence: i64,
    terminal_receipt: Option<LiveUpdateReceipt>,
    // Required, though it may be null.
    #[serde(deserialize_with = "Option::deserialize")]
    retained_prefix: Option<RetainedPrefix>,
    event_count: usize,
}

fn field<'a>(bytes: &mut &'a [u8]) -> Result<&'a [u8], WireError> {
    let prefix = bytes
        .get(..4)
        .ok_or_else(|| invalid("truncated-owner-adoption"))?;
    let size = u32::from_le_bytes(prefix.try_into().expect("four bytes")) as usize;
    let end = 4usize
        .checked_add(size)
        .ok_or_else(|| invalid("invalid-owner-adoption-length"))?;
    let value = bytes
        .get(4..end)
        .ok_or_else(|| invalid("truncated-owner-adoption"))?;
    *bytes = &bytes[end..];
    Ok(value)
}

/// Length-delimited metadata, original baseline, and ordered metadata/update pairs.
/// Events are committed relay records, so they must arrive canonical; nothing is repaired.
pub(super) fn decode(
    mut bytes: &[u8],
    max_events: usize,
    outbox_limits: dohc_engine_collab::OwnerOutboxLimits,
    reconstruction: NativeHistoryReconstruction,
) -> Result<OwnerAdoptionCut, WireError> {
    let header = field(&mut bytes)?;
    if header.len() > MAX_HEADER_BYTES {
        return Err(invalid("owner-adoption-header-too-large"));
    }
    let header: CutHeader =
        serde_json::from_slice(header).map_err(|_| invalid("invalid-owner-adoption-header"))?;
    if header.event_count > max_events {
        return Err(invalid("owner-adoption-event-limit"));
    }
    let baseline = field(&mut bytes)?;
    if baseline.is_empty() || baseline.len() > MAX_YDOC_UPDATE_BYTES {
        return Err(invalid("owner-adoption-baseline-limit"));
    }
    let mut cut = OwnerAdoptionCut {
        relay_database_namespace: header.relay_database_namespace,
        adoption_id: header.adoption_id,
        source_moment_id: header.source_moment_id,
        source_digest: header.source_digest,
        source_byte_length: header.source_byte_length,
        baseline_moment_relay_sequence: header.baseline_moment_relay_sequence,
        baseline_registered_at_ms: header.baseline_registered_at_ms,
        baseline_bytes: baseline.to_vec(),
        expected_local_sequence: header.expected_local_sequence,
        terminal_receipt: header.terminal_receipt,
        retained_prefix: header.retained_prefix,
        events: Vec::new(),
        outbox_limits,
        reconstruction,
    };
    for _ in 0..header.event_count {
        let metadata: serde_json::Value = serde_json::from_slice(field(&mut bytes)?)
            .map_err(|_| invalid("invalid-owner-adoption-event"))?;
        let update = field(&mut bytes)?;
        if update.len() > MAX_YDOC_UPDATE_BYTES {
            return Err(invalid("owner-adoption-update-limit"));
        }
        cut.events.push(
            AdmittedLiveUpdate::from_committed_metadata(metadata, update.to_vec())
                .map_err(|_| invalid("invalid-owner-adoption-event"))?,
        );
    }
    if !bytes.is_empty() {
        return Err(invalid("owner-adoption-trailing-bytes"));
    }
    Ok(cut)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_storage::hex_sha256;
    use serde_json::{Value, json};

    fn metadata(first_seen: Value) -> Value {
        json!({
            "accepted": {
                "receipt": {"deliveryId": "delivery", "updateDigest": hex_sha256(b"update"), "journalCursor": 1, "acceptingHostEpoch": 1},
                "binding": {"workspaceId": "w", "mainVersionId": "main", "objectId": "o", "lineageClaimId": "l",
                    "currentPath": "a.md", "selectorPaths": ["a.md"], "restoreFenceGeneration": 0},
                "authority": {"principalKind": "owner", "principalId": "owner", "grantId": null, "grantGeneration": null},
                "receivedAtMs": 0,
            },
            "firstSeen": first_seen,
        })
    }

    fn header() -> Value {
        json!({
            "relayDatabaseNamespace": "relay", "adoptionId": "adoption", "sourceMomentId": "moment",
            "sourceDigest": "0".repeat(64), "sourceByteLength": 0, "baselineMomentRelaySequence": 0,
            "baselineRegisteredAtMs": 0, "expectedLocalSequence": 0, "terminalReceipt": null,
            "retainedPrefix": null, "eventCount": 1,
        })
    }

    fn cut(metadata: Value) -> Vec<u8> {
        cut_with(header(), Some(metadata))
    }

    fn cut_with(header: Value, metadata: Option<Value>) -> Vec<u8> {
        let mut fields = vec![serde_json::to_vec(&header).unwrap(), vec![0, 0]];
        if let Some(metadata) = metadata {
            fields.push(serde_json::to_vec(&metadata).unwrap());
            fields.push(b"update".to_vec());
        }
        let mut bytes = Vec::new();
        for field in fields {
            bytes.extend_from_slice(&(field.len() as u32).to_le_bytes());
            bytes.extend_from_slice(&field);
        }
        bytes
    }

    fn limits() -> dohc_engine_collab::OwnerOutboxLimits {
        dohc_engine_collab::OwnerOutboxLimits {
            max_pending_bytes: 1_000_000,
            max_pending_age_ms: 60_000,
        }
    }

    fn reconstruction() -> NativeHistoryReconstruction {
        NativeHistoryReconstruction {
            working_reserve_bytes: 1,
        }
    }

    /// The retained prefix is required, null for a first adoption, and
    /// decodes exactly for a successor.
    #[test]
    fn the_retained_prefix_is_required() {
        let decoded = decode(&cut(metadata(json!([]))), 1, limits(), reconstruction()).unwrap();
        assert!(decoded.retained_prefix.is_none());
        let mut missing = header();
        missing.as_object_mut().unwrap().remove("retainedPrefix");
        let Err(error) = decode(
            &cut_with(missing, Some(metadata(json!([])))),
            1,
            limits(),
            reconstruction(),
        ) else {
            panic!("a header without its retained prefix decoded");
        };
        assert_eq!(error.message, "invalid-owner-adoption-header");
        let prefix = json!({"terminalReceipt": null, "eventCount": 0, "historyEvidenceDigest": "e".repeat(64),
            "predecessorActivationId": "predecessor"});
        let mut successor = header();
        successor["retainedPrefix"] = prefix.clone();
        successor["eventCount"] = json!(0);
        let decoded = decode(
            &cut_with(successor.clone(), None),
            1,
            limits(),
            reconstruction(),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(decoded.retained_prefix.unwrap()).unwrap(),
            prefix
        );
        successor["retainedPrefix"]["extra"] = json!(1);
        assert!(decode(&cut_with(successor, None), 1, limits(), reconstruction()).is_err());
    }

    #[test]
    fn events_must_arrive_canonical() {
        let limits = limits();
        let canonical = json!([{"clientId": 7, "startClock": 0, "endClock": 3}, {"clientId": 7, "startClock": 5, "endClock": 10}]);
        let canonical_metadata = metadata(canonical.clone());
        let decoded = decode(
            &cut(canonical_metadata.clone()),
            1,
            limits.clone(),
            reconstruction(),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&decoded.events[0].metadata.first_seen).unwrap(),
            canonical
        );
        let adjacent = json!([{"clientId": 7, "startClock": 0, "endClock": 3}, {"clientId": 7, "startClock": 3, "endClock": 10}]);
        let overlapping = json!([{"clientId": 7, "startClock": 0, "endClock": 6}, {"clientId": 7, "startClock": 5, "endClock": 10}]);
        let unsorted = json!([{"clientId": 7, "startClock": 5, "endClock": 10}, {"clientId": 7, "startClock": 0, "endClock": 3}]);
        let mut binding = canonical_metadata.clone();
        binding["accepted"]["binding"]["selectorPaths"] = json!(["b.md", "a.md"]);
        let mut current_path = canonical_metadata.clone();
        current_path["accepted"]["binding"]["currentPath"] = json!("./a.md");
        let mut v2 = canonical_metadata;
        v2["canonicalVersion"] = json!(2);
        v2["authorSnapshot"] = json!([]);
        v2["firstSeenDeletes"] = canonical.clone();
        v2["checkpointCoverage"] = json!([{
            "author": {"kind": "human", "humanId": "owner", "humanName": "Owner"},
            "structRanges": canonical, "deletionRanges": canonical,
        }]);
        let decoded = decode(&cut(v2.clone()), 1, limits.clone(), reconstruction()).unwrap();
        assert_eq!(
            serde_json::to_value(&decoded.events[0].metadata).unwrap(),
            v2
        );
        let mut deletes = v2.clone();
        deletes["firstSeenDeletes"] = unsorted.clone();
        let mut struct_coverage = v2.clone();
        struct_coverage["checkpointCoverage"][0]["structRanges"] = adjacent.clone();
        let mut deletion_coverage = v2;
        deletion_coverage["checkpointCoverage"][0]["deletionRanges"] = overlapping.clone();
        for (case, event) in [
            ("adjacent firstSeen", metadata(adjacent)),
            ("overlapping firstSeen", metadata(overlapping)),
            ("unsorted firstSeen", metadata(unsorted)),
            ("unsorted selectorPaths", binding),
            ("non-canonical currentPath", current_path),
            ("unsorted firstSeenDeletes", deletes),
            ("adjacent checkpoint structRanges", struct_coverage),
            ("overlapping checkpoint deletionRanges", deletion_coverage),
        ] {
            let Err(error) = decode(&cut(event), 1, limits.clone(), reconstruction()) else {
                panic!("{case} decoded");
            };
            assert_eq!(error.message, "invalid-owner-adoption-event", "{case}");
        }
    }
}
