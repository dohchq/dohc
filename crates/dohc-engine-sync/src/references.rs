//! Borrowed file and blob references for known operations.
//!
//! Field types and wire defaults are read here. Each caller retains its
//! payload validation and refusal order, including sparse share payloads
//! and malformed operations that must reach durable replay refusal.

use serde_json::Value;

use crate::moment_apply::ContentKind;

/// Where one side of a change sits and the blob it holds.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ContentRef<'a> {
    pub path: Option<&'a str>,
    /// As the payload states it. Replay refuses an empty reference;
    /// `named_sha256` reads one as no blob at all.
    pub blob_sha256: Option<&'a str>,
    pub content_kind: ContentKind,
}

impl<'a> ContentRef<'a> {
    fn read(value: &'a Value, path: &str, blob_sha256: &str, content_kind: &str) -> Self {
        Self {
            path: string(value, path),
            blob_sha256: string(value, blob_sha256),
            content_kind: ContentKind::from_wire(string(value, content_kind)),
        }
    }

    pub fn named_sha256(self) -> Option<&'a str> {
        self.blob_sha256.filter(|sha256| !sha256.is_empty())
    }
}

/// A `moment.append`'s coordinates and its three content sides.
#[derive(Debug, Clone, Copy)]
pub(crate) struct MomentRefs<'a> {
    pub version_id: Option<&'a str>,
    pub object_id: Option<&'a str>,
    pub path: Option<&'a str>,
    pub operation: Option<&'a str>,
    pub payload_before: ContentRef<'a>,
    pub payload_after: ContentRef<'a>,
    /// The head this moment replaced.
    pub before: ContentRef<'a>,
}

impl<'a> MomentRefs<'a> {
    pub fn read(payload: &'a Value) -> Self {
        Self {
            version_id: string(payload, "versionId"),
            object_id: string(payload, "objectId"),
            path: string(payload, "path"),
            operation: string(payload, "operation"),
            payload_before: ContentRef::read(
                payload,
                "payloadBeforePath",
                "payloadBeforeBlobSha256",
                "payloadBeforeContentKind",
            ),
            payload_after: ContentRef::read(
                payload,
                "payloadAfterPath",
                "payloadAfterBlobSha256",
                "payloadAfterContentKind",
            ),
            before: ContentRef::read(
                payload,
                "beforePath",
                "beforeBlobSha256",
                "beforeContentKind",
            ),
        }
    }

    /// Every path the moment names, so a rename crossing a share boundary
    /// cannot hide its outside path in the one field a reader skipped.
    pub fn paths(self) -> impl Iterator<Item = &'a str> {
        [
            self.path,
            self.payload_before.path,
            self.payload_after.path,
            self.before.path,
        ]
        .into_iter()
        .flatten()
    }

    /// Where the change lands.
    pub fn after_path(self) -> Option<&'a str> {
        self.payload_after.path.or(self.path)
    }

    pub fn sides(self) -> [ContentRef<'a>; 3] {
        [self.payload_before, self.payload_after, self.before]
    }
}

/// A `version.create`'s two versions and the snapshots it ships.
#[derive(Debug, Clone, Copy)]
pub(crate) struct VersionCreateRefs<'a> {
    /// The version created. Apply lands the snapshots here.
    pub version_id: Option<&'a str>,
    /// The version forked from, whose accepted content the snapshots copy.
    pub fork_version_id: Option<&'a str>,
    /// `None` when the field is missing or is not a list.
    pub fork_snapshots: Option<&'a [Value]>,
}

/// One shipped snapshot row.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SnapshotRef<'a> {
    pub object_id: Option<&'a str>,
    pub content: ContentRef<'a>,
}

impl<'a> VersionCreateRefs<'a> {
    pub fn read(payload: &'a Value) -> Self {
        Self {
            version_id: string(payload, "versionId"),
            fork_version_id: string(payload, "forkVersionId"),
            fork_snapshots: payload
                .get("forkSnapshots")
                .and_then(Value::as_array)
                .map(Vec::as_slice),
        }
    }

    pub fn snapshots(self) -> impl Iterator<Item = SnapshotRef<'a>> {
        self.fork_snapshots
            .unwrap_or_default()
            .iter()
            .map(|row| SnapshotRef {
                object_id: string(row, "objectId"),
                content: ContentRef::read(row, "path", "blobSha256", "contentKind"),
            })
    }
}

/// A `ydoc.update`'s document coordinates, update blob and lineage claim.
#[derive(Debug, Clone, Copy)]
pub(crate) struct YdocRefs<'a> {
    pub version_id: Option<&'a str>,
    pub object_id: Option<&'a str>,
    pub path: Option<&'a str>,
    pub update_blob_sha256: Option<&'a str>,
    pub lineage_claim_id: Option<&'a str>,
}

impl<'a> YdocRefs<'a> {
    pub fn read(payload: &'a Value) -> Self {
        Self {
            version_id: string(payload, "versionId"),
            object_id: string(payload, "objectId"),
            path: string(payload, "path"),
            update_blob_sha256: string(payload, "updateBlobSha256"),
            lineage_claim_id: string(payload, "lineageClaimId"),
        }
    }
}

/// A `conflict.open` side that exists, with the version it was read from.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ConflictSideRef<'a> {
    pub version_id: Option<&'a str>,
    pub object_id: Option<&'a str>,
    pub path: Option<&'a str>,
    pub content_kind: ContentKind,
    pub sha256: Option<&'a str>,
    /// Inline text a text side carries instead of a blob.
    pub text: Option<&'a str>,
}

/// The base and current sides were read from the target version, the
/// incoming side from the source. An absent side names no content.
pub(crate) fn conflict_open_sides(payload: &Value) -> impl Iterator<Item = ConflictSideRef<'_>> {
    [
        ("base", "targetVersionId"),
        ("current", "targetVersionId"),
        ("incoming", "sourceVersionId"),
    ]
    .into_iter()
    .filter_map(move |(name, version)| {
        let side = payload.get(name)?;
        if side.get("exists").and_then(Value::as_bool) != Some(true) {
            return None;
        }
        Some(ConflictSideRef {
            version_id: string(payload, version),
            object_id: string(side, "objectId"),
            path: string(side, "path"),
            content_kind: ContentKind::from_wire(string(side, "contentKind")),
            sha256: string(side, "sha256"),
            text: string(side, "text"),
        })
    })
}

fn string<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    value.get(name).and_then(Value::as_str)
}
