//! The wire-facing yrs `Doc` wrapper and the shared dohc root schema.
//!
//! Every method here enforces the yrs interop harness's four caveats
//! (`crates/yrs-interop/README.md`) plus the shared root schema:
//!
//! 1. **`OffsetKind::Utf16` everywhere.** [`Ydoc::wire`] is the only constructor
//!    a durable/replicated doc may use; it hard-codes `OffsetKind::Utf16`. The
//!    default `OffsetKind::Bytes` is wire-unsafe against Yjs (positional
//!    divergence and a struct-store panic on non-ASCII). Only the cross-engine
//!    `offsetProbe` test reaches it, through [`Ydoc::with_mode`] with
//!    [`OffsetMode::Bytes`], to pin the divergence.
//! 2. **Nested `Any::Map` key order is nondeterministic through a yrs re-encode.**
//!    [`Ydoc::canonical_content`] sorts every map through `BTreeMap`, and
//!    [`project_frontmatter`] sorts nested keys, so neither the convergence
//!    surface nor the content projection depends on HashMap iteration order.
//! 3. **Well-formed UTF-16 at the boundary.** Rust `String` cannot hold a lone
//!    surrogate, so every string this module produces is well-formed. Raw
//!    [`Ydoc::apply`] stays permissive; durable callers also use
//!    [`crate::validate_replay_parity`] before journaling so a wire edit cannot
//!    split a multi-unit scalar.
//! 4. **Shared declared root schema; projection is destructive on the TS side.**
//!    The Yjs v1 wire carries no root kinds, so roots are read through the
//!    declared dohc schema ([`ROOT_FRONTMATTER`], [`ROOT_META`], [`ROOT_BODY`],
//!    [`ROOT_PLAINTEXT`], and the three scene maps). The projection records
//!    provenance including a `destructive` flag.
//! 5. **yjs `applyUpdate` is not atomic on malformed input; yrs is.** The durable
//!    layer never journals bytes that failed validation. [`Ydoc::apply`] decodes
//!    the whole update before applying, so a truncated update is rejected with
//!    state unchanged, and the caller persists only bytes an apply accepted.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use yrs::encoding::write::Write as _;
use yrs::types::text::{TextDiffChunk, YChange};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};
use yrs::{
    Any, Array, Doc, GetString, IdSet, Map, Options, Out, ReadTxn, StateVector, Text, Transact,
    Update, Xml, XmlElementPrelim, XmlFragment, XmlOut, XmlTextPrelim,
};

use crate::error::CollabError;
use crate::limits::{MAX_PROJECTION_BYTES, MAX_PROJECTION_DEPTH, MAX_PROJECTION_NODES};

mod bounded_encoder;
mod frontmatter_yaml;
#[cfg(test)]
mod nested_markdown_contract_tests;
#[cfg(test)]
mod outside_save_fold_tests;
mod read_markdown;
mod removed_text;
mod restore_copy;
mod wikilinks;

pub use removed_text::RemovedText;

/// The declared dohc root schema. The Yjs v1 wire format does not carry
/// root-type kinds — a root's kind is defined by typed API access — so both
/// engines must read roots through this identical declaration.
pub const ROOT_FRONTMATTER: &str = "frontmatter";
/// Secondary map root (engine metadata).
pub const ROOT_META: &str = "meta";
/// Reserved engine metadata that identifies one immutable lineage epoch.
pub const LINEAGE_EPOCH_META_KEY: &str = "dohcLineageEpoch";
/// Reserved engine metadata that preserves a CRLF Markdown artifact's line endings.
const MARKDOWN_CRLF_META_KEY: &str = "dohcMarkdownCrlf";
/// The frontmatter text a document was imported with, kept while it reads as
/// the current frontmatter. See [`frontmatter_yaml::kept`].
const FRONTMATTER_SOURCE_META_KEY: &str = "dohcFrontmatterSource";
/// The item a frontmatter key held when its text was kept, as `client:clock`,
/// one meta entry per key so edits to different keys on different devices
/// merge. Writing a key creates a new item, so a key written since, by any
/// writer, no longer matches and its kept comments are not written back.
const FRONTMATTER_SOURCE_ITEM_META_PREFIX: &str = "dohcFrontmatterSourceItem:";
const MARKDOWN_SOURCE_META_KEY: &str = "dohcMarkdownSource";
const MARKDOWN_SOURCE_SHA_META_KEY: &str = "dohcMarkdownSourceSha256";
const MARKDOWN_SOURCE_PROJECTION_SHA_META_KEY: &str = "dohcMarkdownSourceProjectionSha256";
pub(crate) const MARKDOWN_SOURCE_READER_META_KEY: &str = "dohcMarkdownSourceReader";

pub(crate) fn reader_source_meta_key(key: &str) -> bool {
    matches!(
        key,
        MARKDOWN_SOURCE_META_KEY
            | MARKDOWN_SOURCE_SHA_META_KEY
            | MARKDOWN_SOURCE_PROJECTION_SHA_META_KEY
            | MARKDOWN_SOURCE_READER_META_KEY
            | FRONTMATTER_SOURCE_META_KEY
            | MARKDOWN_CRLF_META_KEY
    ) || key.starts_with(FRONTMATTER_SOURCE_ITEM_META_PREFIX)
}
/// The rich-document body: a ProseMirror `XmlFragment`.
pub const ROOT_BODY: &str = "body";
/// The plaintext-document body: a single `Y.Text`.
pub const ROOT_PLAINTEXT: &str = "plainText";
/// Immutable Excalidraw element snapshots, keyed by revision tuple JSON.
pub const ROOT_SCENE_REVISIONS: &str = "excalidraw:revisions";
/// Excalidraw app-state properties, keyed by property name.
pub const ROOT_SCENE_APP_STATE: &str = "excalidraw:app-state";
/// Durable Excalidraw asset metadata, keyed by file id.
pub const ROOT_SCENE_ASSETS: &str = "excalidraw:assets";

/// Which offset mode a `Doc` is built with. `Utf16` is the only wire-safe mode;
/// `Bytes` exists solely so the pinned divergence probe can demonstrate the
/// failure the spike found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OffsetMode {
    /// UTF-16 code units — matches Yjs; the only mode a durable doc may use.
    Utf16,
    /// UTF-8 byte offsets — wire-UNSAFE against Yjs. Probe/test only.
    Bytes,
}

/// The content kind of a durable Y.Doc, mirroring the TS driver's
/// `content_kind` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentKind {
    /// Root `Y.Text` under [`ROOT_PLAINTEXT`]; the projection is the exact text.
    Plaintext,
    /// Root `XmlFragment` under [`ROOT_BODY`] plus a [`ROOT_FRONTMATTER`] map.
    Richdoc,
    /// Excalidraw scene roots projected through the bundled scene codec.
    Scene,
}

impl ContentKind {
    /// The stable column string.
    pub fn as_str(self) -> &'static str {
        match self {
            ContentKind::Plaintext => "plaintext",
            ContentKind::Richdoc => "richdoc",
            ContentKind::Scene => "scene",
        }
    }

    /// Parse the durable column string.
    pub fn parse(raw: &str) -> Result<Self, CollabError> {
        match raw {
            "plaintext" => Ok(ContentKind::Plaintext),
            "richdoc" => Ok(ContentKind::Richdoc),
            "scene" => Ok(ContentKind::Scene),
            kind => Err(CollabError::UnsupportedContentKind {
                kind: kind.to_owned(),
            }),
        }
    }
}

const SUCCESSOR_EPOCH_DOMAIN: &[u8] = b"dohc:ydoc-successor-epoch:v1";
const SUCCESSOR_CLIENT_DOMAIN: &[u8] = b"dohc:ydoc-successor-client:v1";
const SEED_CLIENT_DOMAIN: &[u8] = b"dohc:ydoc-seed-client:v1";
const SCHEMA_VERSION_CLIENT_DOMAIN: &[u8] = b"dohc:ydoc-schema-version-client:v1";

/// The Yjs client an editor seeds `key`'s lineage under, from the head it
/// seeds.
///
/// Every device that seeds the same head moment gets the same client, so their
/// seeds are the same bytes, originate the same base, and share one lineage. A
/// later head gets another client even when its text is the same, so a lineage
/// seeded after a delete, a restore, or an archive never reuses a retired
/// claim. The value fits a Yjs client id: nonzero and at most 32 bits.
pub fn seed_client_id(
    key: &crate::DocKey,
    content_kind: ContentKind,
    head_moment_id: &str,
    head_blob_sha256: &str,
) -> u32 {
    let mut hash = Sha256::new();
    hash.update(SEED_CLIENT_DOMAIN);
    for field in [
        key.workspace_id.as_str(),
        key.version_id.as_str(),
        key.object_id.as_str(),
        content_kind.as_str(),
        head_moment_id,
        head_blob_sha256,
    ] {
        let length = u64::try_from(field.len()).unwrap_or(u64::MAX);
        hash.update(length.to_be_bytes());
        hash.update(field.as_bytes());
    }
    let digest = hash.finalize();
    u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]).max(1)
}

/// The Yjs client the engine adds `key`'s missing schema version under. One
/// client per document, so a retried claim proposes the same base. The value
/// fits a Yjs client id: nonzero and at most 32 bits.
fn schema_version_client_id(key: &crate::DocKey) -> u32 {
    let mut hash = Sha256::new();
    hash.update(SCHEMA_VERSION_CLIENT_DOMAIN);
    for field in [
        key.workspace_id.as_str(),
        key.version_id.as_str(),
        key.object_id.as_str(),
    ] {
        let length = u64::try_from(field.len()).unwrap_or(u64::MAX);
        hash.update(length.to_be_bytes());
        hash.update(field.as_bytes());
    }
    let digest = hash.finalize();
    u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]).max(1)
}

/// The deterministic identity of one fresh successor lineage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuccessorIdentity {
    key: crate::DocKey,
    epoch_tag: String,
    client_id: u64,
    content_kind: ContentKind,
    predecessor_state_vector_sha256: String,
    artifact_preimage_sha256: String,
    result_sha256: String,
}

/// Every durable value that defines one deterministic successor identity.
#[derive(Debug, Clone, Copy)]
pub struct SuccessorIdentityInput<'a> {
    pub key: &'a crate::DocKey,
    pub predecessor_claim_id: &'a str,
    pub predecessor_state_vector_sha256: &'a str,
    pub artifact_op_kind: &'a str,
    pub artifact_id: &'a str,
    pub artifact_preimage_sha256: &'a str,
    pub content_kind: ContentKind,
    pub result_sha256: &'a str,
}

impl SuccessorIdentity {
    /// Bind a successor to its predecessor, artifact, object, and exact result.
    pub fn derive(input: SuccessorIdentityInput<'_>) -> Self {
        let SuccessorIdentityInput {
            key,
            predecessor_claim_id,
            predecessor_state_vector_sha256,
            artifact_op_kind,
            artifact_id,
            artifact_preimage_sha256,
            content_kind,
            result_sha256,
        } = input;
        let mut identity = Vec::new();
        identity.extend_from_slice(SUCCESSOR_EPOCH_DOMAIN);
        for field in [
            key.workspace_id.as_str(),
            key.version_id.as_str(),
            key.object_id.as_str(),
            predecessor_claim_id,
            predecessor_state_vector_sha256,
            artifact_op_kind,
            artifact_id,
            artifact_preimage_sha256,
            content_kind.as_str(),
            result_sha256,
        ] {
            let length = u64::try_from(field.len()).unwrap_or(u64::MAX);
            identity.extend_from_slice(&length.to_be_bytes());
            identity.extend_from_slice(field.as_bytes());
        }
        let epoch_tag = crate::hex_sha256(&identity);
        let mut client_hash = Sha256::new();
        client_hash.update(SUCCESSOR_CLIENT_DOMAIN);
        client_hash.update(epoch_tag.as_bytes());
        let digest = client_hash.finalize();
        let mut client_bytes = [0_u8; 8];
        client_bytes.copy_from_slice(&digest[..8]);
        let client_id = (u64::from_be_bytes(client_bytes) & ((1_u64 << 53) - 1)).max(1);
        Self {
            key: key.clone(),
            epoch_tag,
            client_id,
            content_kind,
            predecessor_state_vector_sha256: predecessor_state_vector_sha256.to_owned(),
            artifact_preimage_sha256: artifact_preimage_sha256.to_owned(),
            result_sha256: result_sha256.to_owned(),
        }
    }

    /// The immutable tag stored in the successor's engine metadata root.
    pub fn epoch_tag(&self) -> &str {
        &self.epoch_tag
    }
}

/// The encoded base and claim for one fresh successor lineage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuccessorBase {
    pub lineage_claim_id: String,
    pub epoch_tag: String,
    pub content_kind: ContentKind,
    pub predecessor_state_vector_sha256: String,
    pub artifact_preimage_sha256: String,
    pub result_sha256: String,
    pub update: Vec<u8>,
    pub state_vector: Vec<u8>,
}

/// Build a fresh Y.Doc from an exact artifact without merging predecessor items.
pub fn fresh_successor_base(
    identity: &SuccessorIdentity,
    artifact: &str,
) -> Result<SuccessorBase, CollabError> {
    let observed_result = crate::hex_sha256(artifact.as_bytes());
    if observed_result != identity.result_sha256 {
        return Err(CollabError::SuccessorResultMismatch {
            expected: identity.result_sha256.clone(),
            observed: observed_result,
        });
    }
    let doc = Ydoc::with_client_id(identity.client_id);
    let meta = doc.doc.get_or_insert_map(ROOT_META);
    {
        let mut txn = doc.doc.transact_mut();
        meta.insert(&mut txn, "schemaVersion", Any::Number(1.0));
        if identity.content_kind == ContentKind::Plaintext {
            meta.insert(&mut txn, "contentKind", "plain-text");
        }
        meta.insert(
            &mut txn,
            LINEAGE_EPOCH_META_KEY,
            identity.epoch_tag.as_str(),
        );
    }
    let projected = if identity.content_kind == ContentKind::Scene {
        let asset_bytes = crate::scene::seed_portable_scene(&doc, &identity.key, artifact)
            .map_err(|error| CollabError::InvalidSuccessorBase {
                constraint: "scene successor portable artifact",
                expected: "a valid portable Excalidraw scene".to_owned(),
                observed: error.to_string(),
            })?;
        doc.fold_scene()
            .portable_json_with_asset_bytes(&asset_bytes)?
    } else {
        doc.rewrite_content_to_markdown(identity.content_kind, artifact)?;
        let projection = doc.project(identity.content_kind)?.content;
        if identity.content_kind == ContentKind::Richdoc && projection != artifact {
            if artifact.len() > crate::limits::MAX_PUBLIC_MARKDOWN_BYTES {
                return Err(CollabError::MarkdownNotRepresentable);
            }
            // Write with the deterministic client, not a staged edit's random
            // client. Installation makes this artifact the settled body.
            doc.record_validated_markdown_source_reference(artifact)?;
            doc.settled_markdown_source(&projection, || {
                Ok::<_, CollabError>(Some(artifact.to_owned()))
            })?
            .unwrap_or(projection)
        } else {
            projection
        }
    };
    if projected != artifact {
        return Err(CollabError::SuccessorProjectionMismatch {
            expected_sha256: crate::hex_sha256(artifact.as_bytes()),
            observed_sha256: crate::hex_sha256(projected.as_bytes()),
        });
    }
    let update = doc.encode_full_state();
    Ok(SuccessorBase {
        lineage_claim_id: crate::hex_sha256(&update),
        epoch_tag: identity.epoch_tag.clone(),
        content_kind: identity.content_kind,
        predecessor_state_vector_sha256: identity.predecessor_state_vector_sha256.clone(),
        artifact_preimage_sha256: identity.artifact_preimage_sha256.clone(),
        result_sha256: identity.result_sha256.clone(),
        state_vector: doc.encode_state_vector(),
        update,
    })
}

/// A content projection of a durable Y.Doc with its provenance. Constraint 4:
/// a projector can mutate its source, so provenance records the state that
/// produced the content and whether projection changed that state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarkdownWriteSafety {
    NotMarkdown,
    SourcePreserving,
    SafeWitness,
    UnsafeWitness,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Projection {
    /// The projected artifact content (well-formed UTF-8 by `String`).
    pub content: String,
    /// The content kind that drove the projection.
    pub content_kind: ContentKind,
    /// Lowercase-hex sha-256 of the doc's state vector at projection time — the
    /// durable provenance link from a settled content blob back to the exact
    /// CRDT state it came from.
    pub source_state_vector_sha256: String,
    /// Whether producing this projection mutated the live doc. The Rust
    /// projection is read-only (`false`); the TS `yDocToMarkdown` can mutate
    /// (drops PM-invalid elements), which the live adapter journals as an
    /// ordinary update. Recorded so a cross-engine settle can reconcile.
    pub destructive: bool,
    pub markdown_write_safety: MarkdownWriteSafety,
    pub witness_source_sha256: Option<String>,
}

/// Digests for exact Markdown source held in the Y.Doc's reserved engine
/// metadata. The source is canonical artifact state, not a pointer into local
/// history; the projection digest invalidates it when the semantic roots move.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownSourceReference {
    pub source_sha256: String,
    pub projection_sha256: String,
}
/// A wire-facing durable Y.Doc.
pub struct Ydoc {
    doc: Doc,
}

impl std::fmt::Debug for Ydoc {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ydoc").finish_non_exhaustive()
    }
}

impl Ydoc {
    /// Construct an empty wire-facing doc with `OffsetKind::Utf16` (constraint 1).
    /// This is the constructor durable/replicated code paths use.
    pub fn wire() -> Self {
        Ydoc::with_offset_kind(yrs::OffsetKind::Utf16)
    }

    /// Construct a doc in the requested offset mode. `Bytes` is wire-unsafe and
    /// exists only for the pinned divergence probe (a `Bytes` doc fed the same
    /// non-ASCII lineage diverges from / panics against a `Utf16` doc).
    pub fn with_mode(mode: OffsetMode) -> Self {
        let offset_kind = match mode {
            OffsetMode::Utf16 => yrs::OffsetKind::Utf16,
            OffsetMode::Bytes => yrs::OffsetKind::Bytes,
        };
        Ydoc::with_offset_kind(offset_kind)
    }

    fn with_offset_kind(offset_kind: yrs::OffsetKind) -> Self {
        let doc = Doc::with_options(Options {
            offset_kind,
            // Durable snapshots and restore proofs retain deleted CRDT payload.
            skip_gc: true,
            ..Options::default()
        });
        Self::from_doc(doc)
    }

    pub(crate) fn with_client_id(client_id: u64) -> Self {
        let doc = Doc::with_options(Options {
            client_id: yrs::ClientID::new(client_id),
            offset_kind: yrs::OffsetKind::Utf16,
            skip_gc: true,
            ..Options::default()
        });
        Self::from_doc(doc)
    }

    fn from_doc(doc: Doc) -> Self {
        // Yjs v1 updates do not carry root kinds. Declare every scene root as a
        // map before any update is applied, including replay reconstruction.
        doc.get_or_insert_map(ROOT_SCENE_REVISIONS);
        doc.get_or_insert_map(ROOT_SCENE_APP_STATE);
        doc.get_or_insert_map(ROOT_SCENE_ASSETS);
        Ydoc { doc }
    }

    /// Validate an update without mutating any doc: decode the whole v1 update.
    /// A truncated/malformed update fails here (yrs decodes the full update
    /// before applying — constraint 5), so the durable layer can refuse to
    /// journal bytes that would fail an apply.
    ///
    /// Pre-validates the raw wire bytes first via
    /// [`crate::replay_parity::prevalidate_update_bytes`], before the real
    /// `Update::decode_v1` below: yrs 0.27.3's `decode_v1` can HARD-ABORT the
    /// whole process on adversarial bytes (uncatchable UB —
    /// `std::panic::catch_unwind` cannot intercept it; see
    /// `replay_parity::safe_read_string`'s doc comment for the root cause).
    /// This method, [`Ydoc::apply`] below, and [`merge_updates`] are the
    /// crate's `Update::decode_v1` call sites, and each pre-validates first, so
    /// guarding here — not merely at the durable layer's `validate_update_bytes`
    /// choke point — is what makes every caller of the raw primitive (durable,
    /// replication, tests, and any future caller) intrinsically safe, not just
    /// the ones that remember to pre-validate first.
    pub fn validate_update(bytes: &[u8]) -> Result<(), CollabError> {
        crate::replay_parity::prevalidate_update_bytes(bytes)?;
        Update::decode_v1(bytes).map_err(|e| CollabError::MalformedUpdate {
            reason: e.to_string(),
        })?;
        Ok(())
    }

    /// Apply a Yjs v1 update. Decodes the whole update first (constraint 5): a
    /// truncated update is rejected on decode with the doc state-unchanged, and
    /// no bytes that fail here are ever journaled by the caller.
    ///
    /// Pre-validates the raw wire bytes first — see [`Ydoc::validate_update`]'s
    /// doc comment for why this (not just the durable layer) is the abort-safe
    /// choke point.
    pub fn apply(&self, bytes: &[u8]) -> Result<(), CollabError> {
        crate::replay_parity::prevalidate_update_bytes(bytes)?;
        let update = Update::decode_v1(bytes).map_err(|e| CollabError::MalformedUpdate {
            reason: e.to_string(),
        })?;
        let mut txn = self.doc.transact_mut();
        txn.apply_update(update)
            .map_err(|e| CollabError::MalformedUpdate {
                reason: e.to_string(),
            })?;
        Ok(())
    }

    /// [`Ydoc::apply`], with what applying it deleted given to `deleted`
    /// once its transaction commits, whether or not it applied whole: every
    /// range it marked deleted, the items it integrated into an already
    /// deleted parent and the pending deletions it could now apply among
    /// them. Nothing is given when the bytes do not decode.
    pub(crate) fn apply_seeing_deletions(
        &self,
        bytes: &[u8],
        deleted: impl FnOnce(&IdSet),
    ) -> Result<(), CollabError> {
        crate::replay_parity::prevalidate_update_bytes(bytes)?;
        let update = Update::decode_v1(bytes).map_err(|e| CollabError::MalformedUpdate {
            reason: e.to_string(),
        })?;
        let mut txn = self.doc.transact_mut();
        let applied = txn.apply_update(update);
        txn.commit();
        deleted(txn.delete_set());
        applied.map_err(|e| CollabError::MalformedUpdate {
            reason: e.to_string(),
        })
    }

    /// Apply an update only when a complete scratch replay keeps the epoch tag.
    pub fn apply_preserving_lineage_epoch(
        &self,
        bytes: &[u8],
        expected_epoch_tag: &str,
    ) -> Result<(), CollabError> {
        let observed = self.lineage_epoch_tag();
        if observed.as_deref() != Some(expected_epoch_tag) {
            return Err(CollabError::LineageEpochChanged {
                expected: expected_epoch_tag.to_owned(),
                observed: observed.unwrap_or_else(|| "<missing>".to_owned()),
            });
        }
        let scratch = Ydoc::wire();
        scratch.apply(&self.encode_full_state())?;
        if scratch.has_pending_dependencies() {
            return Err(CollabError::MissingDependencies);
        }
        scratch.apply(bytes)?;
        if scratch.has_pending_dependencies() {
            return Err(CollabError::MissingDependencies);
        }
        let observed = scratch.lineage_epoch_tag();
        if observed.as_deref() != Some(expected_epoch_tag) {
            return Err(CollabError::LineageEpochChanged {
                expected: expected_epoch_tag.to_owned(),
                observed: observed.unwrap_or_else(|| "<missing>".to_owned()),
            });
        }
        self.apply(bytes)
    }

    /// Read the reserved lineage epoch from the engine metadata root.
    pub fn lineage_epoch_tag(&self) -> Option<String> {
        let meta = self.doc.get_or_insert_map(ROOT_META);
        let txn = self.doc.transact();
        match meta.get(&txn, LINEAGE_EPOCH_META_KEY) {
            Some(Out::Any(Any::String(value))) => Some(value.to_string()),
            _ => None,
        }
    }

    /// Read a well-formed exact-source reference from the replicated metadata.
    pub fn markdown_source_reference(&self) -> Option<MarkdownSourceReference> {
        let meta = self.doc.get_or_insert_map(ROOT_META);
        let txn = self.doc.transact();
        let source_sha256 = match meta.get(&txn, MARKDOWN_SOURCE_SHA_META_KEY) {
            Some(Out::Any(Any::String(value))) if valid_sha256(&value) => value.to_string(),
            _ => return None,
        };
        let projection_sha256 = match meta.get(&txn, MARKDOWN_SOURCE_PROJECTION_SHA_META_KEY) {
            Some(Out::Any(Any::String(value))) if valid_sha256(&value) => value.to_string(),
            _ => return None,
        };
        Some(MarkdownSourceReference {
            source_sha256,
            projection_sha256,
        })
    }

    pub fn has_reader_source(&self) -> bool {
        let meta = self.doc.get_or_insert_map(ROOT_META);
        let txn = self.doc.transact();
        meta.get(&txn, MARKDOWN_SOURCE_READER_META_KEY).is_some()
    }

    pub fn has_markdown_witness(&self) -> bool {
        let meta = self.doc.get_or_insert_map(ROOT_META);
        let txn = self.doc.transact();
        [
            MARKDOWN_SOURCE_META_KEY,
            MARKDOWN_SOURCE_SHA_META_KEY,
            MARKDOWN_SOURCE_PROJECTION_SHA_META_KEY,
        ]
        .iter()
        .any(|key| meta.get(&txn, key).is_some())
    }

    /// Resolve exact Markdown only after its lightweight projection witness
    /// matches. This avoids cloning and hashing stale source after a document
    /// edit, and never returns bytes the versioned text store cannot hold.
    pub fn markdown_source(&self, reference: &MarkdownSourceReference) -> Option<String> {
        let meta = self.doc.get_or_insert_map(ROOT_META);
        let txn = self.doc.transact();
        let source = match meta.get(&txn, MARKDOWN_SOURCE_META_KEY) {
            Some(Out::Any(Any::String(value)))
                if value.len() <= dohc_engine_domain::MAX_TEXT_BYTES =>
            {
                value.to_string()
            }
            _ => return None,
        };
        (crate::hex_sha256(source.as_bytes()) == reference.source_sha256).then_some(source)
    }

    /// Resolve exact Markdown source only when it is equivalent to
    /// `canonical_projection`: the projection witness must be fresh, the
    /// source digest must match, and differing source bytes must parse and
    /// reproject to the canonical projection. The digests alone prove freshness
    /// and self-consistency, never equivalence — the metadata rides the
    /// replicated doc, so a crafted update can pair the current projection's
    /// digest with foreign source bytes, and settlement would write bytes the
    /// canonical Y.Doc never represented. Reprojection admits only lexical
    /// variants of the canonical state — the authority every collaborator
    /// already has by editing the document.
    ///
    /// The desktop seeds a file as its importer reads it, and the engine
    /// records source over documents its fold rebuilt, so either reading can
    /// be the one that reproduces the canonical state. Neither drops content.
    /// Both keep a block's text as written, so the source's text must also
    /// read, block by block, as the projection's text does.
    pub fn preserved_markdown_source(&self, canonical_projection: &str) -> Option<String> {
        let reference = self.markdown_source_reference()?;
        if reference.projection_sha256 != crate::hex_sha256(canonical_projection.as_bytes()) {
            return None;
        }
        let source = self.markdown_source(&reference)?;
        if source == canonical_projection {
            return Some(source);
        }
        self.source_reproduces(&source, canonical_projection, true)
            .then_some(source)
    }

    /// The exact Markdown source for the version's file, where `snapshot_text`
    /// reads the file's current snapshot. This is
    /// [`Ydoc::preserved_markdown_source`], or else a source whose body is the
    /// snapshot's body and that still rebuilds the document. That body is
    /// already the version's file, so keeping it writes no bytes the file did
    /// not hold, even where a Markdown reader sees structure the engine's
    /// reader keeps as text, such as raw HTML. Without it, a
    /// frontmatter-only engine edit rewrote such a body. Every projection
    /// compared with the version's file uses this rule, so a settle, a later
    /// check that the version is settled, and live activation agree. The
    /// live baseline keeps the strict rule.
    pub fn settled_markdown_source<E>(
        &self,
        canonical_projection: &str,
        snapshot_text: impl FnOnce() -> Result<Option<String>, E>,
    ) -> Result<Option<String>, E> {
        if let Some(source) = self.preserved_markdown_source(canonical_projection) {
            return Ok(Some(source));
        }
        let Some(reference) = self.markdown_source_reference() else {
            return Ok(None);
        };
        if reference.projection_sha256 != crate::hex_sha256(canonical_projection.as_bytes()) {
            return Ok(None);
        }
        let Some(source) = self.markdown_source(&reference) else {
            return Ok(None);
        };
        let Some(snapshot) = snapshot_text()? else {
            return Ok(None);
        };
        let body = |markdown: &'_ str| {
            dohc_engine_domain::collections::markdown_frontmatter_json_with_body(markdown)
                .map_or(markdown.len(), |(_, body)| body.len())
        };
        let (source_body, snapshot_body) = (body(&source), body(&snapshot));
        Ok(
            (source[source.len() - source_body..] == snapshot[snapshot.len() - snapshot_body..]
                && self.source_reproduces(&source, canonical_projection, false))
            .then_some(source),
        )
    }

    /// The current witness source, if it rebuilds this canonical projection
    /// under the settled rule's reading, without a file's body comparison.
    pub(crate) fn reprojected_markdown_source(&self, canonical_projection: &str) -> Option<String> {
        let reference = self.markdown_source_reference()?;
        if reference.projection_sha256 != crate::hex_sha256(canonical_projection.as_bytes()) {
            return None;
        }
        let source = self.markdown_source(&reference)?;
        self.source_reproduces(&source, canonical_projection, false)
            .then_some(source)
    }

    /// Whether `source` rebuilds `canonical_projection`. With `reads_alike`,
    /// it must also read as the projection does; see [`markdown_reads_alike`].
    fn source_reproduces(
        &self,
        source: &str,
        canonical_projection: &str,
        reads_alike: bool,
    ) -> bool {
        let staged = Ydoc::wire();
        staged
            .rewrite_content_to_markdown_checked::<false>(
                ContentKind::Richdoc,
                source,
                FileFold::No,
            )
            .is_ok()
            && staged
                .project_richdoc()
                .is_ok_and(|projection| projection == canonical_projection)
            && (!reads_alike || markdown_reads_alike(source, canonical_projection))
    }

    pub(crate) fn has_missing_updates(&self) -> bool {
        self.doc.transact().has_missing_updates()
    }

    pub(crate) fn validate_public_baseline(&self, bytes: &[u8]) -> Result<(), CollabError> {
        self.validate_public_baseline_as(bytes, false)
    }

    /// Schema/budget checks only. Exact output also requires the strict reader proof.
    pub(crate) fn validate_reader_baseline(&self, bytes: &[u8]) -> Result<(), CollabError> {
        self.validate_public_baseline_as(bytes, true)
    }

    fn validate_public_baseline_as(&self, bytes: &[u8], reader: bool) -> Result<(), CollabError> {
        let meta = self.doc.get_or_insert_map(ROOT_META);
        self.doc.get_or_insert_map(ROOT_FRONTMATTER);
        self.doc.get_or_insert_xml_fragment(ROOT_BODY);
        let txn = self.doc.transact();
        let invalid = || CollabError::MalformedUpdate {
            reason: "invalid public baseline schema".into(),
        };
        for (name, root) in txn.root_refs() {
            match name {
                ROOT_META | ROOT_FRONTMATTER | ROOT_BODY => {}
                ROOT_SCENE_REVISIONS | ROOT_SCENE_APP_STATE | ROOT_SCENE_ASSETS => {
                    if !matches!(root, Out::YMap(ref map) if map.len(&txn) == 0) {
                        return Err(invalid());
                    }
                }
                _ => return Err(invalid()),
            }
        }
        for (key, value) in meta.iter(&txn) {
            let valid = matches!(
                (key, &value),
                ("schemaVersion", Out::Any(Any::Number(1.0)))
                    | (MARKDOWN_CRLF_META_KEY, Out::Any(Any::Bool(true)))
                    | (
                        FRONTMATTER_SOURCE_META_KEY
                            | MARKDOWN_SOURCE_META_KEY
                            | MARKDOWN_SOURCE_SHA_META_KEY
                            | MARKDOWN_SOURCE_PROJECTION_SHA_META_KEY,
                        Out::Any(Any::String(_)),
                    )
            );
            let item_record = matches!(
                (key, &value),
                (key, Out::Any(Any::String(_))) if key.starts_with(FRONTMATTER_SOURCE_ITEM_META_PREFIX)
            );
            let reader_meta = reader
                && matches!(
                    (key, &value),
                    (MARKDOWN_SOURCE_READER_META_KEY, Out::Any(Any::Number(1.0)))
                );
            if !valid && !item_record && !reader_meta {
                return Err(invalid());
            }
        }
        if bytes != [0, 0] && !meta.contains_key(&txn, "schemaVersion") {
            return Err(CollabError::BaselineSchemaVersionMissing);
        }
        if matches!(
            meta.get(&txn, FRONTMATTER_SOURCE_META_KEY),
            Some(Out::Any(Any::String(text)))
                if text.len() > crate::limits::MAX_PUBLIC_MARKDOWN_BYTES
        ) {
            return Err(invalid());
        }
        // The item records name each frontmatter key once, as `client:clock`.
        let mut item_bytes = 0usize;
        for (key, value) in meta.iter(&txn) {
            if let (true, Out::Any(Any::String(item))) =
                (key.starts_with(FRONTMATTER_SOURCE_ITEM_META_PREFIX), value)
            {
                item_bytes = item_bytes.saturating_add(key.len() + item.len());
                if item_bytes > crate::limits::MAX_PUBLIC_MARKDOWN_BYTES {
                    return Err(invalid());
                }
            }
        }
        let source_fields = [
            MARKDOWN_SOURCE_META_KEY,
            MARKDOWN_SOURCE_SHA_META_KEY,
            MARKDOWN_SOURCE_PROJECTION_SHA_META_KEY,
        ]
        .iter()
        .filter(|key| meta.contains_key(&txn, key))
        .count();
        if source_fields != 0 && source_fields != 3 {
            return Err(invalid());
        }
        drop(txn);
        // A well-formed source the engine cannot prove equivalent is not
        // refused: every projection drops it, as it drops a stale one, so the
        // engine never writes those bytes.
        if source_fields == 3 {
            let reference = self.markdown_source_reference().ok_or_else(invalid)?;
            let source = self.markdown_source(&reference).ok_or_else(invalid)?;
            if source.len() > crate::limits::MAX_PUBLIC_MARKDOWN_BYTES
                && reference.projection_sha256
                    == crate::hex_sha256(self.project_richdoc()?.as_bytes())
            {
                return Err(invalid());
            }
        }
        Ok(())
    }

    /// Whether the doc holds updates it could not integrate yet (a
    /// cross-origin missing dependency durably parked in the log). A
    /// projection taken in this state omits pending remote content.
    pub fn has_pending_dependencies(&self) -> bool {
        self.has_missing_updates()
    }

    pub(crate) fn pending_update_v1(&self) -> Option<Vec<u8>> {
        let txn = self.doc.transact();
        txn.store()
            .pending_update()
            .map(|pending| pending.update.encode_v1())
    }

    pub(crate) fn pending_update_v1_with_missing(&self) -> Option<(Vec<u8>, StateVector)> {
        let txn = self.doc.transact();
        txn.store()
            .pending_update()
            .map(|pending| (pending.update.encode_v1(), pending.missing.clone()))
    }

    /// What held updates here wait for: the lowest missing clock of each
    /// client, and deletions of items this doc does not have.
    pub(crate) fn pending_waits(&self) -> (Option<StateVector>, Option<IdSet>) {
        let txn = self.doc.transact();
        let store = txn.store();
        (
            store
                .pending_update()
                .map(|pending| pending.missing.clone()),
            store.pending_ds().cloned(),
        )
    }

    /// Whether a held update here needs text in `ids`: the lowest clock it
    /// waits for from some client, or a deletion it holds, falls in `ids`.
    pub(crate) fn waits_on_any(&self, ids: &IdSet) -> bool {
        let txn = self.doc.transact();
        let store = txn.store();
        store.pending_update().is_some_and(|pending| {
            pending
                .missing
                .iter()
                .any(|(client, clock)| ids.contains(&yrs::ID::new(*client, *clock)))
        }) || store
            .pending_ds()
            .is_some_and(|deletes| !deletes.intersect(ids).is_empty())
    }

    pub(crate) fn pending_delete_set(&self) -> Option<IdSet> {
        self.doc.transact().store().pending_ds().cloned()
    }

    #[cfg(test)]
    pub(crate) fn replace_pending_delete_set_for_test(&self, replacement: IdSet) {
        use yrs::WriteTxn;

        let mut txn = self.doc.transact_mut();
        let pending = txn
            .store_mut()
            .pending_ds_mut()
            .expect("test document must already have a pending delete set");
        *pending = replacement;
    }

    #[cfg(test)]
    pub(crate) fn replace_pending_missing_for_test(&self, replacement: StateVector) {
        use yrs::WriteTxn;

        let mut txn = self.doc.transact_mut();
        let pending = txn
            .store_mut()
            .pending_update_mut()
            .expect("test document must already have a pending update");
        pending.missing = replacement;
    }

    pub(crate) fn state_vector(&self) -> StateVector {
        self.doc.transact().state_vector()
    }

    /// The full state re-encoded as a single v1 update — the snapshot primitive.
    pub fn encode_full_state(&self) -> Vec<u8> {
        let txn = self.doc.transact();
        txn.encode_state_as_update_v1(&StateVector::default())
    }

    pub(crate) fn encode_full_state_bounded(&self, max_bytes: usize) -> Option<Vec<u8>> {
        let mut encoder = bounded_encoder::BoundedEncoder::new(max_bytes)?;
        self.doc
            .transact()
            .encode_state_as_update(&StateVector::default(), &mut encoder);
        encoder.finish()
    }

    /// The state vector, v1-encoded in ascending client-id order — the
    /// provenance/diff primitive.
    ///
    /// `yrs::StateVector::encode_v1` iterates its HashMap directly. Two Y.Docs
    /// with identical state can therefore emit different bytes, which made
    /// projection and lineage provenance hashes depend on the reconstructed
    /// instance. The wire format is order-insensitive, so sort the entries
    /// before encoding them.
    pub fn encode_state_vector(&self) -> Vec<u8> {
        let txn = self.doc.transact();
        encode_state_vector_canonical(&txn.state_vector())
    }

    /// The normalized deleted clock ranges, ordered by client and clock.
    pub fn encode_delete_set(&self) -> Vec<u8> {
        self.delete_set().encode_v1()
    }

    pub(crate) fn delete_set(&self) -> IdSet {
        self.doc.transact().snapshot().delete_set
    }

    /// The v1 update carrying everything this doc has that `remote_sv` lacks
    /// (the sync-by-diff primitive).
    pub fn diff(&self, remote_sv: &[u8]) -> Result<Vec<u8>, CollabError> {
        crate::replay_parity::prevalidate_state_vector_bytes(remote_sv)?;
        let sv = StateVector::decode_v1(remote_sv).map_err(|e| CollabError::MalformedUpdate {
            reason: format!("state vector decode: {e}"),
        })?;
        let txn = self.doc.transact();
        Ok(txn.encode_state_as_update_v1(&sv))
    }

    /// Bounded output allocation. Yrs traversal itself is not preemptible.
    pub(crate) fn diff_bounded(
        &self,
        remote_sv: &[u8],
        max_bytes: usize,
    ) -> Result<Option<Vec<u8>>, CollabError> {
        crate::replay_parity::prevalidate_state_vector_bytes(remote_sv)?;
        let sv = StateVector::decode_v1(remote_sv).map_err(|e| CollabError::MalformedUpdate {
            reason: format!("state vector decode: {e}"),
        })?;
        let Some(mut encoder) = bounded_encoder::BoundedEncoder::new(max_bytes) else {
            return Ok(None);
        };
        self.doc
            .transact()
            .encode_state_as_update(&sv, &mut encoder);
        Ok(encoder.finish())
    }

    pub(crate) fn encode_state_vector_bounded(&self, max_bytes: usize) -> Option<Vec<u8>> {
        let txn = self.doc.transact();
        let vector = txn.state_vector();
        // Each client needs at least two encoded bytes. Bound sorting scratch before allocation.
        if vector.iter().count() > max_bytes.saturating_sub(1) / 2 {
            return None;
        }
        let mut entries = Vec::new();
        entries.try_reserve_exact(vector.iter().count()).ok()?;
        entries.extend(vector.iter().map(|(client, clock)| (client.get(), *clock)));
        entries.sort_unstable_by_key(|(client, _)| *client);
        let mut encoder = bounded_encoder::BoundedEncoder::new(max_bytes)?;
        encoder.write_var(entries.len());
        for (client, clock) in entries {
            encoder.write_var(client);
            encoder.write_var(clock);
        }
        encoder.finish()
    }

    /// The canonical semantic content — the convergence surface the JS driver
    /// computes identically from Yjs (`scripts/canonical.ts`). Every map is
    /// key-sorted (constraint 2) so HashMap iteration order cannot cause a false
    /// mismatch or a nondeterministic fingerprint.
    pub fn canonical_content(&self) -> Value {
        content_json(&self.doc)
    }

    /// Lowercase-hex sha-256 of the canonical content (stable, deterministic —
    /// the convergence fingerprint the tests compare and compaction preserves).
    pub fn canonical_content_sha256(&self) -> String {
        let canonical = serde_json::to_vec(&self.canonical_content()).unwrap_or_default();
        crate::hex_sha256(&canonical)
    }

    /// Project artifact content with provenance (constraint 4).
    pub fn project(&self, content_kind: ContentKind) -> Result<Projection, CollabError> {
        let content = match content_kind {
            ContentKind::Plaintext => self.project_plaintext(),
            ContentKind::Richdoc => self.project_richdoc(),
            ContentKind::Scene => self.project_scene(),
        }?;
        Ok(Projection {
            content,
            content_kind,
            source_state_vector_sha256: crate::hex_sha256(&self.encode_state_vector()),
            destructive: false,
            markdown_write_safety: if content_kind != ContentKind::Richdoc {
                MarkdownWriteSafety::NotMarkdown
            } else if self.has_markdown_witness() {
                MarkdownWriteSafety::UnsafeWitness
            } else {
                MarkdownWriteSafety::SafeWitness
            },
            witness_source_sha256: self
                .markdown_source_reference()
                .map(|reference| reference.source_sha256),
        })
    }

    /// Fold the format-owned scene maps without serializing the portable
    /// artifact. The runtime can use the validated assets from this value when
    /// it hydrates native `BinaryFileData`.
    pub fn fold_scene(&self) -> crate::scene::FoldedScene {
        crate::scene::fold_scene(
            &self.scene_string_map(ROOT_SCENE_REVISIONS),
            &self.scene_string_map(ROOT_SCENE_APP_STATE),
            &self.scene_string_map(ROOT_SCENE_ASSETS),
        )
    }

    fn project_scene(&self) -> Result<String, CollabError> {
        self.fold_scene().portable_json()
    }

    fn scene_string_map(&self, root: &str) -> BTreeMap<String, String> {
        let map = self.doc.get_or_insert_map(root);
        let txn = self.doc.transact();
        map.iter(&txn)
            .filter_map(|(key, value)| match value {
                Out::Any(Any::String(value)) => Some((key.to_string(), value.to_string())),
                _ => None,
            })
            .collect()
    }

    pub(crate) fn seed_scene_maps(
        &self,
        revisions: &BTreeMap<String, String>,
        app_state: &BTreeMap<String, String>,
        assets: &BTreeMap<String, String>,
    ) -> Vec<u8> {
        let revision_map = self.doc.get_or_insert_map(ROOT_SCENE_REVISIONS);
        let app_state_map = self.doc.get_or_insert_map(ROOT_SCENE_APP_STATE);
        let asset_map = self.doc.get_or_insert_map(ROOT_SCENE_ASSETS);
        self.with_delta(|txn| {
            for (key, value) in revisions {
                revision_map.insert(txn, key.as_str(), value.as_str());
            }
            for (key, value) in app_state {
                app_state_map.insert(txn, key.as_str(), value.as_str());
            }
            for (key, value) in assets {
                asset_map.insert(txn, key.as_str(), value.as_str());
            }
        })
    }

    fn project_plaintext(&self) -> Result<String, CollabError> {
        let text = self.doc.get_or_insert_text(ROOT_PLAINTEXT);
        let txn = self.doc.transact();
        // yrs exposes no incremental plain-string reader. `get_string` is the
        // smallest materialization here because it ignores formatting runs,
        // unlike `diff`, but it still allocates eagerly. A UTF-16 code-unit
        // count bounds its worst-case UTF-8 result before that allocation.
        if text.len(&txn) as usize > MAX_PROJECTION_BYTES {
            return Err(projection_too_large(text.len(&txn) as usize));
        }
        ensure_projection_string(text.get_string(&txn))
    }

    /// The exact plaintext content (the [`ROOT_PLAINTEXT`] `Y.Text` string). The
    /// cross-engine tests compare this against the yjs-authored string.
    pub fn plaintext_string(&self) -> String {
        let text = self.doc.get_or_insert_text(ROOT_PLAINTEXT);
        let txn = self.doc.transact();
        text.get_string(&txn)
    }

    /// The [`ROOT_FRONTMATTER`] map as plain JSON (scalars unwrapped, all keys
    /// sorted — constraint 2). Compared against the yjs frontmatter object.
    pub fn frontmatter_json(&self) -> Value {
        let map = self.doc.get_or_insert_map(ROOT_FRONTMATTER);
        let txn = self.doc.transact();
        let mut entries: BTreeMap<String, Value> = BTreeMap::new();
        for (k, v) in map.iter(&txn) {
            let value = match v {
                Out::Any(any) => any_to_json(&any),
                other => out_json(&txn, other),
            };
            entries.insert(k.to_string(), value);
        }
        Value::Object(entries.into_iter().collect())
    }

    /// Parse provenance for the frontmatter this document shows, read without
    /// projecting the body. Only kept source text can hold YAML that the
    /// values cannot show, such as an unquoted `.nan` or a tag.
    pub fn frontmatter_provenance(
        &self,
    ) -> Result<dohc_engine_domain::collections::FrontmatterProvenance, CollabError> {
        let current = self.frontmatter_json();
        let map = self.doc.get_or_insert_map(ROOT_FRONTMATTER);
        let meta = self.doc.get_or_insert_map(ROOT_META);
        let txn = self.doc.transact();
        let source = match meta.get(&txn, FRONTMATTER_SOURCE_META_KEY) {
            Some(Out::Any(Any::String(source))) => source,
            _ => return Ok(Default::default()),
        };
        let rendered = current
            .as_object()
            .ok_or(CollabError::FrontmatterEditRefused)?
            .iter()
            .map(|(key, value)| Ok((key.clone(), project_frontmatter(key, value)?)))
            .collect::<ProjectionResult<BTreeMap<_, _>>>()?;
        let written = written_frontmatter_keys(&map, &meta, &txn);
        let kept = frontmatter_yaml::kept(&source, &rendered, &written)
            .ok_or(CollabError::FrontmatterEditRefused)?;
        let provenance =
            dohc_engine_domain::collections::markdown_frontmatter_json_with_provenance(&kept)
                .map_or_else(Default::default, |(_, provenance)| provenance);
        Ok(provenance)
    }

    /// Per body paragraph, its formatted runs `(text, bold, italic)` — the
    /// structural surface the cross-engine tests compare against the yjs
    /// paragraph deltas (marks / formatting fidelity).
    pub fn body_paragraph_runs(&self) -> Vec<Vec<(String, bool, bool)>> {
        let frag = self.doc.get_or_insert_xml_fragment(ROOT_BODY);
        let txn = self.doc.transact();
        let mut paragraphs = Vec::new();
        for child in frag.children(&txn) {
            if let XmlOut::Element(el) = child {
                let mut runs = Vec::new();
                for inner in el.children(&txn) {
                    if let XmlOut::Text(t) = inner {
                        for d in t.diff(&txn, YChange::identity) {
                            let s = match &d.insert {
                                Out::Any(Any::String(s)) => s.to_string(),
                                _ => continue,
                            };
                            let (bold, italic) = match &d.attributes {
                                Some(attrs) => (
                                    attrs.contains_key("bold") || attrs.contains_key("strong"),
                                    attrs.contains_key("italic") || attrs.contains_key("em"),
                                ),
                                None => (false, false),
                            };
                            runs.push((s, bold, italic));
                        }
                    }
                }
                paragraphs.push(runs);
            }
        }
        paragraphs
    }

    fn project_richdoc(&self) -> Result<String, CollabError> {
        self.project_richdoc_with_node_budget(MAX_PROJECTION_NODES)
    }

    fn project_richdoc_with_node_budget(
        &self,
        projection_node_budget: usize,
    ) -> Result<String, CollabError> {
        // Acquire both roots before opening the read txn: yrs `get_or_insert_*`
        // takes the store lock, so calling one while a transaction is live
        // deadlocks (spike harness note).
        let frontmatter = self.doc.get_or_insert_map(ROOT_FRONTMATTER);
        let meta = self.doc.get_or_insert_map(ROOT_META);
        let body = self.doc.get_or_insert_xml_fragment(ROOT_BODY);
        let txn = self.doc.transact();
        let uses_crlf = matches!(
            meta.get(&txn, MARKDOWN_CRLF_META_KEY),
            Some(Out::Any(Any::Bool(true)))
        );
        let mut has_frontmatter = false;
        let mut remaining_nodes = projection_node_budget;
        let mut source_text_bytes = 0usize;
        let mut frontmatter_yaml = ProjectionBuffer::new();
        let mut entries: BTreeMap<String, Value> = BTreeMap::new();
        let mut rendered: BTreeMap<String, String> = BTreeMap::new();
        if frontmatter.len(&txn) > 0 {
            has_frontmatter = true;
            for (k, v) in frontmatter.iter(&txn) {
                source_text_bytes = checked_projection_len(source_text_bytes, k.len())?;
                entries.insert(
                    k.to_string(),
                    projection_frontmatter_value(
                        &txn,
                        v,
                        0,
                        &mut remaining_nodes,
                        &mut source_text_bytes,
                    )?,
                );
            }
            for (key, value) in &entries {
                rendered.insert(key.clone(), project_frontmatter(key, value)?);
            }
            let mut ordered: Vec<_> = rendered.iter().collect();
            ordered
                .sort_by(|(left, _), (right, _)| frontmatter_yaml::compare_keys(left, right, true));
            for (_, entry) in ordered {
                frontmatter_yaml.push_str(entry)?;
            }
        }
        let children: Vec<MarkdownNode> = body
            .children(&txn)
            .map(|child| {
                markdown_node(&txn, child, 0, &mut remaining_nodes, &mut source_text_bytes)
            })
            .collect::<ProjectionResult<_>>()?;
        let body_markdown = markdown_document(&children)?;
        if let Some(Out::Any(Any::String(source))) = meta.get(&txn, FRONTMATTER_SOURCE_META_KEY) {
            let written = written_frontmatter_keys(&frontmatter, &meta, &txn);
            {
                let kept = frontmatter_yaml::kept(&source, &rendered, &written)
                    .ok_or(CollabError::FrontmatterEditRefused)?;
                let kept = without_blank_lines(
                    &kept,
                    body_markdown.len() - body_markdown.trim_start_matches('\n').len(),
                );
                let mut preserved = ProjectionBuffer::new();
                preserved.push_str(kept)?;
                // A closing delimiter at the end of the file needs a line
                // break before the body a person adds under it.
                if !kept.is_empty() && !body_markdown.is_empty() && !kept.ends_with('\n') {
                    preserved.push_str(if uses_crlf { "\r\n\r\n" } else { "\n\n" })?;
                }
                preserved.push_str(&if uses_crlf {
                    body_markdown.replace('\n', "\r\n")
                } else {
                    body_markdown
                })?;
                end_with_line_break(&mut preserved, if uses_crlf { "\r\n" } else { "\n" })?;
                return Ok(preserved.into_string());
            }
        }
        let mut out = ProjectionBuffer::new();
        if has_frontmatter {
            out.push_str("---\n")?;
            out.push_str(&frontmatter_yaml.value)?;
            out.push_str("---")?;
            out.push_str(if body_markdown.starts_with('\n') {
                "\n"
            } else {
                "\n\n"
            })?;
        }
        out.push_str(&body_markdown)?;
        end_with_line_break(&mut out, "\n")?;
        let projected = out.into_string();
        if uses_crlf {
            ensure_projection_string(projected.replace('\n', "\r\n"))
        } else {
            Ok(projected)
        }
    }

    // ---- Rust-side edit helpers (used to build lineages in unit tests without
    // a Node fixture; the cross-engine tests feed real yjs bytes instead) ------

    /// Insert plaintext at a UTF-16 index into the [`ROOT_PLAINTEXT`] text and
    /// return the encoded v1 delta (state-before → state-after).
    pub fn plaintext_insert(&self, index: u32, text: &str) -> Vec<u8> {
        let t = self.doc.get_or_insert_text(ROOT_PLAINTEXT);
        self.with_delta(|txn| {
            let idx = snap_utf16(&t.get_string(txn), index);
            t.insert(txn, idx, text);
        })
    }

    /// Delete `len` raw UTF-16 units starting at `index` from the
    /// [`ROOT_PLAINTEXT`] text (not snapped to a code-point boundary — used to
    /// construct interior-scalar-split delete probes) and return the encoded
    /// v1 delta. Test/probe helper, mirroring [`Ydoc::plaintext_insert`].
    pub fn plaintext_delete(&self, index: u32, len: u32) -> Vec<u8> {
        let t = self.doc.get_or_insert_text(ROOT_PLAINTEXT);
        self.with_delta(|txn| {
            t.remove_range(txn, index, len);
        })
    }

    /// Append a `<paragraph>` holding `text` to the [`ROOT_BODY`] fragment and
    /// return the encoded v1 delta.
    pub fn richdoc_append_paragraph(&self, text: &str) -> Vec<u8> {
        let frag = self.doc.get_or_insert_xml_fragment(ROOT_BODY);
        self.with_delta(|txn| {
            let index = frag.len(txn);
            let el = frag.insert(txn, index, XmlElementPrelim::empty("paragraph"));
            el.insert(txn, 0, XmlTextPrelim::new(text));
        })
    }

    /// Append a paragraph holding `text` inside `depth` nested blockquotes and
    /// return the encoded v1 delta.
    #[cfg(test)]
    pub(crate) fn richdoc_append_quoted(&self, depth: usize, text: &str) -> Vec<u8> {
        let frag = self.doc.get_or_insert_xml_fragment(ROOT_BODY);
        self.with_delta(|txn| {
            let index = frag.len(txn);
            let mut quote = frag.insert(txn, index, XmlElementPrelim::empty("blockquote"));
            for _ in 1..depth {
                quote = quote.insert(txn, 0, XmlElementPrelim::empty("blockquote"));
            }
            let paragraph = quote.insert(txn, 0, XmlElementPrelim::empty("paragraph"));
            paragraph.insert(txn, 0, XmlTextPrelim::new(text));
        })
    }

    /// Remove the [`ROOT_BODY`] block at `index` and return the encoded v1
    /// delta.
    pub fn richdoc_remove_block(&self, index: u32) -> Vec<u8> {
        let frag = self.doc.get_or_insert_xml_fragment(ROOT_BODY);
        self.with_delta(|txn| frag.remove_range(txn, index, 1))
    }

    #[cfg(test)]
    pub(crate) fn richdoc_block_count(&self) -> u32 {
        let frag = self.doc.get_or_insert_xml_fragment(ROOT_BODY);
        frag.len(&self.doc.transact())
    }

    /// Insert `text` at a UTF-16 `offset` into the text of the [`ROOT_BODY`]
    /// block at `index` and return the encoded v1 delta. None when that block
    /// holds no text first.
    pub fn richdoc_insert_text(&self, index: u32, offset: u32, text: &str) -> Option<Vec<u8>> {
        let content = self.richdoc_block_text(index)?;
        Some(self.with_delta(|txn| content.insert(txn, offset, text)))
    }

    /// Replace `delete` UTF-16 units at `offset` in the text of the
    /// [`ROOT_BODY`] block at `index` with `text`, as one keystroke, and
    /// return only what that keystroke's transaction did, v1-encoded: unlike
    /// [`Ydoc::richdoc_insert_text`], it costs its own size, not the
    /// document's. None when that block holds no text first.
    pub fn richdoc_keystroke(
        &self,
        index: u32,
        offset: u32,
        delete: u32,
        text: &str,
    ) -> Option<Vec<u8>> {
        let content = self.richdoc_block_text(index)?;
        let mut txn = self.doc.transact_mut();
        if delete > 0 {
            content.remove_range(&mut txn, offset, delete);
        }
        if !text.is_empty() {
            content.insert(&mut txn, offset, text);
        }
        Some(txn.encode_update_v1())
    }

    /// The text the [`ROOT_BODY`] block at `index` holds first.
    fn richdoc_block_text(&self, index: u32) -> Option<yrs::XmlTextRef> {
        let frag = self.doc.get_or_insert_xml_fragment(ROOT_BODY);
        let txn = self.doc.transact();
        match frag.get(&txn, index) {
            Some(XmlOut::Element(element)) => match element.get(&txn, 0) {
                Some(XmlOut::Text(content)) => Some(content),
                _ => None,
            },
            _ => None,
        }
    }

    /// Rewrite the document's projected content to `markdown` and return one
    /// encoded v1 update — the conflict-resolution fold. The user chose these
    /// exact bytes over the lineage's current projection, so the update
    /// deletes the current content and writes the choice in the lineage's own
    /// kind, keeping CRDT convergence while making the choice durable.
    ///
    /// Plaintext replaces the [`ROOT_PLAINTEXT`] text. Richdoc parses the
    /// chosen projected Markdown into the projection's own block schema —
    /// frontmatter scalars, headings, blockquotes, bullet/ordered/task
    /// lists, fenced code blocks, horizontal rules, and paragraphs — so the
    /// folded document projects the chosen bytes back and renders as structure,
    /// not literal syntax. The production caller reprojects this rewrite and
    /// refuses the resolution when the parser cannot reproduce the chosen bytes.
    pub fn rewrite_content_to_markdown(
        &self,
        content_kind: ContentKind,
        markdown: &str,
    ) -> Result<Vec<u8>, CollabError> {
        self.rewrite_content_to_markdown_checked::<true>(content_kind, markdown, FileFold::No)
    }

    /// Rewrite a file fold, refusing a body nested past the reader's limits
    /// before mutation. A new fold invalidates the previous exact-source witness.
    pub fn rewrite_content_to_markdown_for_fold(
        &self,
        content_kind: ContentKind,
        markdown: &str,
    ) -> Result<Vec<u8>, CollabError> {
        self.rewrite_content_to_markdown_checked::<true>(content_kind, markdown, FileFold::Strict)
    }

    /// Check a reader fold on a clone. Reader witnesses cannot authorize this path.
    pub fn native_fold_candidate(&self, update: &[u8]) -> Result<Ydoc, CollabError> {
        crate::validate_replay_parity(self, update)?;
        let candidate = Ydoc::wire();
        candidate.apply(&self.encode_full_state())?;
        candidate.apply(update)?;
        let epoch = candidate.lineage_epoch_tag();
        if candidate.has_pending_dependencies() || epoch != self.lineage_epoch_tag() {
            return Err(CollabError::MarkdownNotRepresentable);
        }
        let meta = candidate.doc.get_or_insert_map(ROOT_META);
        let txn = candidate.doc.transact();
        if (epoch.is_none() && meta.contains_key(&txn, LINEAGE_EPOCH_META_KEY))
            || [
                MARKDOWN_SOURCE_META_KEY,
                MARKDOWN_SOURCE_SHA_META_KEY,
                MARKDOWN_SOURCE_PROJECTION_SHA_META_KEY,
                MARKDOWN_SOURCE_READER_META_KEY,
            ]
            .iter()
            .any(|key| meta.contains_key(&txn, key))
        {
            return Err(CollabError::MarkdownNotRepresentable);
        }
        drop(txn);
        // Public schema validation excludes the engine's private lineage tag.
        let public = Ydoc::wire();
        public.apply(&candidate.encode_full_state())?;
        public
            .doc
            .get_or_insert_map(ROOT_META)
            .remove(&mut public.doc.transact_mut(), LINEAGE_EPOCH_META_KEY);
        public.validate_public_baseline(&public.encode_full_state())?;
        public.project(ContentKind::Richdoc)?;
        Ok(candidate)
    }

    /// The update that gives this document of `key` the rich-document schema
    /// version, or `None` when it already names one. New page's editor writes
    /// a note's first update without the version.
    pub(crate) fn missing_schema_version_update(
        &self,
        key: &crate::DocKey,
    ) -> Result<Option<Vec<u8>>, CollabError> {
        let meta = self.doc.get_or_insert_map(ROOT_META);
        if meta.contains_key(&self.doc.transact(), "schemaVersion") {
            return Ok(None);
        }
        let writer = Ydoc::with_client_id(u64::from(schema_version_client_id(key)));
        writer.apply(&self.encode_full_state())?;
        let meta = writer.doc.get_or_insert_map(ROOT_META);
        Ok(Some(writer.with_delta(|txn| {
            meta.insert(txn, "schemaVersion", Any::Number(1.0));
        })))
    }

    /// Replace an outside fold's frontmatter without rebuilding its body.
    /// The caller checks the settled body and proves this source against the
    /// retained XML before journaling the returned update.
    pub fn replace_frontmatter_for_fold(&self, markdown: &str) -> Result<Vec<u8>, CollabError> {
        let (frontmatter, _, _) = split_markdown_frontmatter(markdown);
        self.stage_source_preserving_edit_bounded(markdown, None, false, false, None, |staged| {
            let map = staged.doc.get_or_insert_map(ROOT_FRONTMATTER);
            let meta = staged.doc.get_or_insert_map(ROOT_META);
            let mut transaction = staged.doc.transact_mut();
            let txn = &mut transaction;
            match meta.get(txn, "schemaVersion") {
                None => {
                    meta.insert(txn, "schemaVersion", Any::Number(1.0));
                }
                Some(Out::Any(Any::Number(1.0))) => {}
                _ => {
                    return Err(CollabError::MalformedUpdate {
                        reason: "unsupported rich-document schema version".into(),
                    })
                }
            }
            let keys: Vec<String> = map.keys(txn).map(str::to_owned).collect();
            for key in keys {
                map.remove(txn, &key);
            }
            for (key, value) in &frontmatter {
                map.insert(txn, key.as_str(), json_to_any(value));
            }
            if markdown.contains("\r\n") {
                meta.insert(txn, MARKDOWN_CRLF_META_KEY, true);
            } else {
                meta.remove(txn, MARKDOWN_CRLF_META_KEY);
            }
            Ok(())
        })
    }

    /// Seed a never-opened Collection relation referrer through the
    /// exact-source proof before it can enter a lineage.
    pub fn seed_collection_relation_markdown(&self, markdown: &str) -> Result<(), CollabError> {
        self.rewrite_content_to_markdown(ContentKind::Richdoc, markdown)?;
        let canonical = self.project_richdoc()?;
        if canonical != markdown {
            if markdown.len() > crate::limits::MAX_PUBLIC_MARKDOWN_BYTES {
                return Err(CollabError::MarkdownNotRepresentable);
            }
            self.preserve_folded_markdown_source(markdown)
                .map_err(|_| CollabError::MarkdownNotRepresentable)?;
            if self.preserved_markdown_source(&canonical).as_deref() != Some(markdown) {
                return Err(CollabError::MarkdownNotRepresentable);
            }
        }
        Ok(())
    }

    fn rewrite_content_to_markdown_checked<const WIRE_SEED: bool>(
        &self,
        content_kind: ContentKind,
        markdown: &str,
        fold: FileFold,
    ) -> Result<Vec<u8>, CollabError> {
        let file_fold = fold != FileFold::No;
        let update = match content_kind {
            ContentKind::Plaintext => {
                let t = self.doc.get_or_insert_text(ROOT_PLAINTEXT);
                self.with_delta(|txn| {
                    let len = t.len(txn);
                    if len > 0 {
                        t.remove_range(txn, 0, len);
                    }
                    t.insert(txn, 0, markdown);
                })
            }
            ContentKind::Richdoc => {
                let meta = self.doc.get_or_insert_map(ROOT_META);
                let missing_schema_version = match meta.get(&self.doc.transact(), "schemaVersion") {
                    None => true,
                    Some(Out::Any(Any::Number(1.0))) => false,
                    _ => {
                        return Err(CollabError::MalformedUpdate {
                            reason: "unsupported rich-document schema version".into(),
                        });
                    }
                };
                let frag = self.doc.get_or_insert_xml_fragment(ROOT_BODY);
                let map = self.doc.get_or_insert_map(ROOT_FRONTMATTER);
                let (frontmatter, prefix, body) = split_markdown_frontmatter(markdown);
                let uses_crlf = markdown.contains("\r\n");
                let source = match prefix {
                    Some(prefix) => frontmatter_yaml::source(prefix, &frontmatter, uses_crlf)?,
                    None => None,
                };
                let normalized_body = uses_crlf.then(|| body.replace("\r\n", "\n"));
                let blocks =
                    read_markdown::read_markdown(normalized_body.as_deref().unwrap_or(body))
                        .map_err(|unreadable| match unreadable {
                            read_markdown::Unreadable::QuoteTooDeep if file_fold => {
                                CollabError::MarkdownQuoteDepthExceeded
                            }
                            _ => CollabError::MarkdownNotRepresentable,
                        })?;
                let edit = |txn: &mut yrs::TransactionMut<'_>| {
                    if WIRE_SEED && missing_schema_version {
                        meta.insert(txn, "schemaVersion", Any::Number(1.0));
                    }
                    if file_fold {
                        for key in [
                            MARKDOWN_SOURCE_META_KEY,
                            MARKDOWN_SOURCE_SHA_META_KEY,
                            MARKDOWN_SOURCE_PROJECTION_SHA_META_KEY,
                            MARKDOWN_SOURCE_READER_META_KEY,
                        ] {
                            meta.remove(txn, key);
                        }
                    }
                    if uses_crlf {
                        meta.insert(txn, MARKDOWN_CRLF_META_KEY, true);
                    } else {
                        meta.remove(txn, MARKDOWN_CRLF_META_KEY);
                    }
                    let keys: Vec<String> = map.iter(txn).map(|(key, _)| key.to_string()).collect();
                    for key in keys {
                        map.remove(txn, &key);
                    }
                    for (key, value) in &frontmatter {
                        map.insert(txn, key.as_str(), json_to_any(value));
                    }
                    keep_frontmatter_source(&map, &meta, txn, source.as_deref());
                    // A live note keeps every block it deletes, so an outside
                    // save keeps the blocks it left alone at either end and
                    // adds only what changed.
                    let (start, end) = if file_fold {
                        unchanged_ends(&*txn, &frag, &blocks)
                    } else {
                        (0, 0)
                    };
                    let len = frag.len(txn);
                    if len > start + end {
                        frag.remove_range(txn, start, len - start - end);
                    }
                    for block in blocks[start as usize..blocks.len() - end as usize]
                        .iter()
                        .rev()
                    {
                        read_markdown::insert_element(txn, &frag, start, block);
                    }
                };
                if WIRE_SEED {
                    self.with_delta(edit)
                } else {
                    let mut txn = self.doc.transact_mut();
                    edit(&mut txn);
                    Vec::new()
                }
            }
            ContentKind::Scene => {
                return Err(CollabError::MarkdownRewriteUnsupported {
                    kind: content_kind.as_str(),
                });
            }
        };
        Ok(update)
    }

    /// Whether edits to this document's properties are refused, because its
    /// kept frontmatter cannot split into entries without rewriting the others.
    /// Callers check this before [`Ydoc::frontmatter_set`].
    pub fn frontmatter_edits_refused(&self) -> bool {
        let meta = self.doc.get_or_insert_map(ROOT_META);
        let txn = self.doc.transact();
        matches!(
            meta.get(&txn, FRONTMATTER_SOURCE_META_KEY),
            Some(Out::Any(Any::String(source)))
                if dohc_engine_domain::collections::markdown_frontmatter_edits_refused(&source)
        )
    }

    /// Set a top-level [`ROOT_FRONTMATTER`] scalar and return the encoded delta.
    pub fn frontmatter_set(&self, key: &str, value: &str) -> Result<Vec<u8>, CollabError> {
        self.frontmatter_set_value(key, Value::String(value.to_owned()))
    }

    /// Validate the candidate projection before changing a frontmatter item.
    pub fn frontmatter_set_value(&self, key: &str, value: Value) -> Result<Vec<u8>, CollabError> {
        let mut current = self.frontmatter_json();
        current
            .as_object_mut()
            .ok_or(CollabError::FrontmatterEditRefused)?
            .insert(key.to_owned(), value.clone());
        self.validate_frontmatter_edit(&current, &[key], None)?;
        Ok(self.write_frontmatter_value(key, &value))
    }

    fn write_frontmatter_value(&self, key: &str, value: &Value) -> Vec<u8> {
        let map = self.doc.get_or_insert_map(ROOT_FRONTMATTER);
        let meta = self.doc.get_or_insert_map(ROOT_META);
        self.with_delta(|txn| {
            let before = map.entry_id(txn, key);
            map.insert(txn, key, json_to_any(value));
            carry_frontmatter_source_item(&map, &meta, txn, key, before);
        })
    }

    fn validate_frontmatter_edit(
        &self,
        current: &Value,
        edited: &[&str],
        supplied_candidate: Option<&str>,
    ) -> Result<(), CollabError> {
        let original = supplied_candidate
            .map(|_| self.project_richdoc())
            .transpose()?;
        let map = self.doc.get_or_insert_map(ROOT_FRONTMATTER);
        let meta = self.doc.get_or_insert_map(ROOT_META);
        let txn = self.doc.transact();
        let rendered = current
            .as_object()
            .ok_or(CollabError::FrontmatterEditRefused)?
            .iter()
            .map(|(key, value)| Ok((key.clone(), project_frontmatter(key, value)?)))
            .collect::<ProjectionResult<BTreeMap<_, _>>>()?;
        let expected = format!(
            "---\n{}---\n",
            rendered.values().cloned().collect::<String>()
        );
        let candidate = if let Some(candidate) = supplied_candidate {
            candidate.to_owned()
        } else if let Some(Out::Any(Any::String(source))) =
            meta.get(&txn, FRONTMATTER_SOURCE_META_KEY)
        {
            let written = written_frontmatter_keys(&map, &meta, &txn);
            frontmatter_yaml::kept(&source, &rendered, &written)
                .ok_or(CollabError::FrontmatterEditRefused)?
        } else {
            expected.clone()
        };
        if candidate.is_empty() && rendered.is_empty() {
            return Ok(());
        }
        let reread = dohc_engine_domain::collections::markdown_frontmatter_block(&candidate)
            .ok_or(CollabError::FrontmatterEditRefused)?;
        let reloaded = reread
            .value
            .iter()
            .map(|(key, value)| Ok((key.clone(), project_frontmatter(key, value)?)))
            .collect::<ProjectionResult<BTreeMap<_, _>>>()?;
        if reloaded != rendered {
            return Err(CollabError::FrontmatterEditRefused);
        }
        if let Some(original) = original {
            let untouched: Vec<_> = rendered
                .keys()
                .map(String::as_str)
                .filter(|key| !edited.contains(key))
                .collect();
            if !untouched.is_empty()
                && !dohc_engine_domain::collections::frontmatter_preserves_yaml_values(
                    &original, &candidate, &untouched,
                )
            {
                return Err(CollabError::FrontmatterEditRefused);
            }
        }
        if !edited.is_empty()
            && !dohc_engine_domain::collections::frontmatter_preserves_yaml_values(
                &expected, &candidate, edited,
            )
        {
            return Err(CollabError::FrontmatterEditRefused);
        }
        Ok(())
    }

    /// Set one frontmatter scalar and bind the resulting semantic projection
    /// to exact source bytes already destined for the versioned text store.
    pub fn frontmatter_set_preserving_markdown_source(
        &self,
        key: &str,
        value: &str,
        markdown: &str,
    ) -> Result<Vec<u8>, CollabError> {
        if markdown.len() > dohc_engine_domain::MAX_TEXT_BYTES {
            return Err(CollabError::ProjectionTooLarge {
                actual: markdown.len(),
                max: dohc_engine_domain::MAX_TEXT_BYTES,
            });
        }
        let value = Value::String(value.to_owned());
        let mut current = self.frontmatter_json();
        current
            .as_object_mut()
            .ok_or(CollabError::FrontmatterEditRefused)?
            .insert(key.to_owned(), value.clone());
        self.validate_frontmatter_edit(&current, &[key], Some(markdown))?;
        self.stage_source_preserving_edit_bounded(markdown, None, true, true, None, |staged| {
            let _ = staged.write_frontmatter_value(key, &value);
            Ok(())
        })
    }

    /// Rewrite a source-preserving rich document and advance its exact-source
    /// reference in the same CRDT delta.
    pub fn rewrite_content_to_markdown_preserving_source(
        &self,
        content_kind: ContentKind,
        markdown: &str,
    ) -> Result<Vec<u8>, CollabError> {
        if content_kind != ContentKind::Richdoc {
            return self.rewrite_content_to_markdown(content_kind, markdown);
        }
        self.stage_source_preserving_edit(markdown, |staged| {
            let _ = staged.rewrite_content_to_markdown(content_kind, markdown)?;
            Ok(())
        })
    }

    /// Bind a non-canonical file fold to its exact source. The caller has
    /// already rewritten the body and must append both deltas together.
    pub fn preserve_folded_markdown_source(&self, markdown: &str) -> Result<Vec<u8>, CollabError> {
        self.stage_source_preserving_edit(markdown, |_| Ok(()))
    }

    /// Clear a converted source without changing document content or its private tail.
    pub fn clear_markdown_source_witness(&self) -> Vec<u8> {
        let meta = self.doc.get_or_insert_map(ROOT_META);
        self.with_delta(|txn| {
            for key in [
                MARKDOWN_SOURCE_META_KEY,
                MARKDOWN_SOURCE_SHA_META_KEY,
                MARKDOWN_SOURCE_PROJECTION_SHA_META_KEY,
                MARKDOWN_SOURCE_READER_META_KEY,
            ] {
                meta.remove(txn, key);
            }
        })
    }

    pub fn reset_held_content_to_file(
        &self,
        content_kind: ContentKind,
        source: &str,
    ) -> Result<Vec<u8>, CollabError> {
        if content_kind != ContentKind::Richdoc {
            return self.rewrite_content_to_markdown(content_kind, source);
        }
        self.stage_source_preserving_edit_bounded(
            source,
            Some(crate::limits::MAX_YDOC_UPDATE_BYTES * 3),
            true,
            true,
            None,
            |staged| {
                staged.doc.get_or_insert_map(ROOT_META).remove(
                    &mut staged.doc.transact_mut(),
                    MARKDOWN_SOURCE_READER_META_KEY,
                );
                staged.rewrite_content_to_markdown(content_kind, source)?;
                Ok(())
            },
        )
    }

    pub fn restore_held_content(
        &self,
        content_kind: ContentKind,
        point: &Ydoc,
    ) -> Result<Vec<u8>, CollabError> {
        if content_kind != ContentKind::Richdoc {
            return self
                .rewrite_content_to_markdown(content_kind, &point.project(content_kind)?.content);
        }
        let before = self.doc.transact().state_vector();
        let staged = Ydoc::wire();
        let max_bytes = crate::limits::MAX_YDOC_UPDATE_BYTES;
        let full = self
            .encode_full_state_bounded(max_bytes)
            .ok_or(CollabError::ConfiguredByteBudgetExceeded)?;
        staged.apply(&full)?;
        restore_copy::copy(point, &staged, crate::limits::MAX_YDOC_UPDATE_BYTES)?;
        let waiting_text = point.project(content_kind)?.content;
        staged.keep_frontmatter_source_of(&waiting_text)?;
        let source = point.doc.get_or_insert_map(ROOT_META);
        let source_txn = point.doc.transact();
        let target = staged.doc.get_or_insert_map(ROOT_META);
        {
            let mut txn = staged.doc.transact_mut();
            for key in [
                MARKDOWN_SOURCE_META_KEY,
                MARKDOWN_SOURCE_SHA_META_KEY,
                MARKDOWN_SOURCE_PROJECTION_SHA_META_KEY,
                MARKDOWN_SOURCE_READER_META_KEY,
            ] {
                match source.get(&source_txn, key) {
                    Some(Out::Any(value)) => {
                        target.insert(&mut txn, key, value);
                    }
                    None => {
                        target.remove(&mut txn, key);
                    }
                    _ => return Err(CollabError::MarkdownNotRepresentable),
                }
            }
        }
        if staged.project(content_kind)?.content != waiting_text {
            return Err(CollabError::MarkdownNotRepresentable);
        }
        let delta = staged.doc.transact().encode_state_as_update_v1(&before);
        if delta.len() > max_bytes || staged.encode_full_state_bounded(max_bytes).is_none() {
            return Err(CollabError::ConfiguredByteBudgetExceeded);
        }
        Ydoc::validate_update(&delta)?;
        self.apply(&delta)?;
        Ok(delta)
    }

    pub(crate) fn rewrite_richdoc_preserving_source_bounded(
        &self,
        markdown: &str,
        point: &Ydoc,
        max_bytes: usize,
        reader_client: Option<u64>,
    ) -> Result<Vec<u8>, CollabError> {
        self.stage_source_preserving_edit_bounded(
            markdown,
            Some(max_bytes),
            true,
            true,
            reader_client,
            |staged| restore_copy::copy(point, staged, max_bytes),
        )
    }

    /// Remove one target from a relation field. A single relation removes the
    /// key; a many relation keeps the sequence and removes matching entries.
    /// Returns `None` when there is no such link or edits cannot preserve
    /// other entries.
    pub fn frontmatter_drop_relation_target(
        &self,
        key: &str,
        target_record_id: &str,
        many: bool,
    ) -> Option<Vec<u8>> {
        if self.frontmatter_edits_refused() {
            return None;
        }
        let current = self.frontmatter_json();
        let value = current.as_object()?.get(key)?;
        let map = self.doc.get_or_insert_map(ROOT_FRONTMATTER);
        if many {
            let values = value.as_array()?;
            if !values
                .iter()
                .any(|value| value.as_str() == Some(target_record_id))
            {
                return None;
            }
            let retained = Value::Array(
                values
                    .iter()
                    .filter(|value| value.as_str() != Some(target_record_id))
                    .cloned()
                    .collect(),
            );
            let meta = self.doc.get_or_insert_map(ROOT_META);
            let mut next = current.clone();
            next.as_object_mut()?
                .insert(key.to_owned(), retained.clone());
            self.validate_frontmatter_edit(&next, &[key], None).ok()?;
            Some(self.with_delta(|txn| {
                let before = map.entry_id(txn, key);
                map.insert(txn, key, json_to_any(&retained));
                carry_frontmatter_source_item(&map, &meta, txn, key, before);
            }))
        } else if value.as_str() == Some(target_record_id) {
            let mut next = current.clone();
            next.as_object_mut()?.remove(key);
            self.validate_frontmatter_edit(&next, &[], None).ok()?;
            Some(self.with_delta(|txn| {
                map.remove(txn, key);
            }))
        } else {
            None
        }
    }

    /// Remove one relation target while keeping the current exact Markdown
    /// body source when its projection witness is still valid.
    pub fn frontmatter_drop_relation_target_preserving_markdown_source(
        &self,
        key: &str,
        target_record_id: &str,
        many: bool,
    ) -> Result<Option<Vec<u8>>, CollabError> {
        let Some(reference) = self.markdown_source_reference() else {
            return Ok(self.frontmatter_drop_relation_target(key, target_record_id, many));
        };
        let projection = self.project_richdoc()?;
        if reference.projection_sha256 != crate::hex_sha256(projection.as_bytes()) {
            return Ok(self.frontmatter_drop_relation_target(key, target_record_id, many));
        }
        let Some(source) = self.markdown_source(&reference) else {
            return Ok(self.frontmatter_drop_relation_target(key, target_record_id, many));
        };
        let Some((_, source_body)) =
            dohc_engine_domain::collections::markdown_frontmatter_json_with_body(&source)
        else {
            return Ok(self.frontmatter_drop_relation_target(key, target_record_id, many));
        };

        let staged = Ydoc::wire();
        staged.apply(&self.encode_full_state())?;
        if staged
            .frontmatter_drop_relation_target(key, target_record_id, many)
            .is_none()
        {
            return Ok(None);
        }
        let projected = staged.project_richdoc()?;
        let Some((_, projected_body)) =
            dohc_engine_domain::collections::markdown_frontmatter_json_with_body(&projected)
        else {
            return Err(CollabError::Corrupt {
                reason: "relation cleanup projection lost record frontmatter".to_owned(),
            });
        };
        let frontmatter_end = projected.len() - projected_body.len();
        let mut preserved = String::with_capacity(frontmatter_end + source_body.len());
        preserved.push_str(&projected[..frontmatter_end]);
        preserved.push_str(source_body);

        self.stage_source_preserving_edit(&preserved, |staged| {
            staged
                .frontmatter_drop_relation_target(key, target_record_id, many)
                .ok_or_else(|| CollabError::Corrupt {
                    reason: "relation cleanup target disappeared while staging".to_owned(),
                })?;
            Ok(())
        })
        .map(Some)
    }

    fn with_delta(&self, edit: impl FnOnce(&mut yrs::TransactionMut)) -> Vec<u8> {
        let before = self.doc.transact().state_vector();
        {
            let mut txn = self.doc.transact_mut();
            edit(&mut txn);
        }
        self.doc.transact().encode_state_as_update_v1(&before)
    }

    fn stage_source_preserving_edit(
        &self,
        markdown: &str,
        edit: impl FnOnce(&Ydoc) -> Result<(), CollabError>,
    ) -> Result<Vec<u8>, CollabError> {
        self.stage_source_preserving_edit_bounded(markdown, None, true, false, None, edit)
    }

    fn stage_source_preserving_edit_bounded(
        &self,
        markdown: &str,
        budget: Option<usize>,
        retain_matching_source: bool,
        reader_edit: bool,
        reader_client: Option<u64>,
        edit: impl FnOnce(&Ydoc) -> Result<(), CollabError>,
    ) -> Result<Vec<u8>, CollabError> {
        if self.has_reader_source() && retain_matching_source && !reader_edit {
            return Err(CollabError::MarkdownReaderUnavailable);
        }
        if markdown.len() > dohc_engine_domain::MAX_TEXT_BYTES {
            return Err(CollabError::ProjectionTooLarge {
                actual: markdown.len(),
                max: dohc_engine_domain::MAX_TEXT_BYTES,
            });
        }

        let before = self.doc.transact().state_vector();
        let staged = reader_client.map_or_else(Ydoc::wire, Ydoc::with_client_id);
        let capacity_error = || CollabError::ConfiguredByteBudgetExceeded;
        let encoder_error = |remaining: usize| {
            if remaining < crate::limits::MAX_YDOC_UPDATE_BYTES {
                CollabError::ConfiguredByteBudgetExceeded
            } else {
                CollabError::UpdateTooLarge {
                    actual: crate::limits::MAX_YDOC_UPDATE_BYTES + 1,
                    max: crate::limits::MAX_YDOC_UPDATE_BYTES,
                }
            }
        };
        let bounded = budget.is_some();
        let mut max_bytes = budget.unwrap_or(usize::MAX);
        let full = if bounded {
            self.encode_full_state_bounded(max_bytes.min(crate::limits::MAX_YDOC_UPDATE_BYTES))
                .ok_or_else(|| encoder_error(max_bytes))?
        } else {
            self.encode_full_state()
        };
        max_bytes = max_bytes
            .checked_sub(full.len())
            .ok_or_else(capacity_error)?;
        staged.apply(&full)?;
        drop(full);
        edit(&staged)?;
        staged.keep_frontmatter_source_of(markdown)?;
        let projection = staged.project_richdoc()?;
        if reader_client.is_some() && staged.has_reader_source() {
            // Restore proves the copied witness against its selected stored artifact.
        } else if !retain_matching_source && projection == markdown {
            let meta = staged.doc.get_or_insert_map(ROOT_META);
            let mut txn = staged.doc.transact_mut();
            for key in [
                MARKDOWN_SOURCE_META_KEY,
                MARKDOWN_SOURCE_SHA_META_KEY,
                MARKDOWN_SOURCE_PROJECTION_SHA_META_KEY,
                MARKDOWN_SOURCE_READER_META_KEY,
            ] {
                meta.remove(&mut txn, key);
            }
        } else {
            staged.record_markdown_source_reference(markdown, &projection);
        }
        let update = if bounded {
            let mut encoder = bounded_encoder::BoundedEncoder::new(
                max_bytes.min(crate::limits::MAX_YDOC_UPDATE_BYTES),
            )
            .ok_or_else(capacity_error)?;
            staged
                .doc
                .transact()
                .encode_state_as_update(&before, &mut encoder);
            encoder.finish().ok_or_else(|| encoder_error(max_bytes))?
        } else {
            staged.doc.transact().encode_state_as_update_v1(&before)
        };
        if update.len() > crate::limits::MAX_YDOC_UPDATE_BYTES {
            return Err(CollabError::UpdateTooLarge {
                actual: update.len(),
                max: crate::limits::MAX_YDOC_UPDATE_BYTES,
            });
        }
        max_bytes = max_bytes
            .checked_sub(update.len())
            .ok_or_else(capacity_error)?;
        let final_bytes = if bounded {
            staged
                .encode_full_state_bounded(max_bytes.min(crate::limits::MAX_YDOC_UPDATE_BYTES))
                .ok_or_else(|| encoder_error(max_bytes))?
        } else {
            staged.encode_full_state()
        };
        if final_bytes.len() > crate::limits::MAX_YDOC_UPDATE_BYTES {
            return Err(CollabError::UpdateTooLarge {
                actual: final_bytes.len(),
                max: crate::limits::MAX_YDOC_UPDATE_BYTES,
            });
        }
        Ydoc::validate_update(&update)?;

        self.apply(&update)?;
        Ok(update)
    }

    /// Keep the frontmatter text of exact source bytes, so the frontmatter
    /// survives once a later edit makes the bytes stale.
    fn keep_frontmatter_source_of(&self, markdown: &str) -> Result<(), CollabError> {
        let (frontmatter, prefix, _) = split_markdown_frontmatter(markdown);
        let source = match prefix {
            Some(prefix) => {
                frontmatter_yaml::source(prefix, &frontmatter, markdown.contains("\r\n"))?
            }
            None => None,
        };
        let map = self.doc.get_or_insert_map(ROOT_FRONTMATTER);
        let meta = self.doc.get_or_insert_map(ROOT_META);
        let mut txn = self.doc.transact_mut();
        keep_frontmatter_source(&map, &meta, &mut txn, source.as_deref());
        Ok(())
    }

    fn record_validated_markdown_source_reference(
        &self,
        markdown: &str,
    ) -> Result<(), CollabError> {
        self.record_markdown_source_reference(markdown, &self.project_richdoc()?);
        Ok(())
    }

    fn record_markdown_source_reference(&self, markdown: &str, projection: &str) {
        let projection_sha256 = crate::hex_sha256(projection.as_bytes());
        let source_sha256 = crate::hex_sha256(markdown.as_bytes());
        let meta = self.doc.get_or_insert_map(ROOT_META);
        let mut txn = self.doc.transact_mut();
        meta.insert(&mut txn, MARKDOWN_SOURCE_META_KEY, markdown);
        meta.insert(
            &mut txn,
            MARKDOWN_SOURCE_SHA_META_KEY,
            source_sha256.as_str(),
        );
        meta.insert(
            &mut txn,
            MARKDOWN_SOURCE_PROJECTION_SHA_META_KEY,
            projection_sha256.as_str(),
        );
    }
}

fn item_text(id: yrs::ID) -> String {
    format!("{}:{}", id.client.get(), id.clock)
}

fn item_meta_key(key: &str) -> String {
    format!("{FRONTMATTER_SOURCE_ITEM_META_PREFIX}{key}")
}

/// Keep `source` as the document's frontmatter text, with the item each
/// frontmatter key holds now, in the caller's transaction. `None` removes both.
/// Kept frontmatter text without up to `count` of the blank lines that end
/// it. A body that starts with line breaks writes the blank lines under its
/// frontmatter itself, as under a canonical block, so a source that adds
/// frontmatter above such a body still reads as it is written.
fn without_blank_lines(kept: &str, count: usize) -> &str {
    let mut kept = kept;
    for _ in 0..count {
        match kept
            .strip_suffix("\r\n")
            .or_else(|| kept.strip_suffix('\n'))
        {
            Some(rest) if rest.ends_with('\n') => kept = rest,
            _ => break,
        }
    }
    kept
}

fn keep_frontmatter_source(
    map: &yrs::MapRef,
    meta: &yrs::MapRef,
    txn: &mut yrs::TransactionMut,
    source: Option<&str>,
) {
    let stale: Vec<String> = meta
        .keys(txn)
        .filter(|key| key.starts_with(FRONTMATTER_SOURCE_ITEM_META_PREFIX))
        .map(str::to_owned)
        .collect();
    for key in stale {
        meta.remove(txn, &key);
    }
    let Some(source) = source else {
        meta.remove(txn, FRONTMATTER_SOURCE_META_KEY);
        return;
    };
    let items: Vec<(String, String)> = map
        .keys(txn)
        .filter_map(|key| {
            map.entry_id(txn, key)
                .map(|id| (item_meta_key(key), item_text(id)))
        })
        .collect();
    meta.insert(txn, FRONTMATTER_SOURCE_META_KEY, source);
    for (key, item) in items {
        meta.insert(txn, key.as_str(), item);
    }
}

/// The frontmatter keys still held by the items their kept text was written for.
fn written_frontmatter_keys<T: ReadTxn>(
    map: &yrs::MapRef,
    meta: &yrs::MapRef,
    txn: &T,
) -> BTreeSet<String> {
    meta.iter(txn)
        .filter_map(|(meta_key, item)| {
            let key = meta_key.strip_prefix(FRONTMATTER_SOURCE_ITEM_META_PREFIX)?;
            matches!(item, Out::Any(Any::String(item))
                if map.entry_id(txn, key).is_some_and(|id| item.as_ref() == item_text(id)))
            .then(|| key.to_owned())
        })
        .collect()
}

/// After an edit writes `key`, move its kept text to the new item when the
/// replaced item was the one the text was written for, so an edited value
/// keeps its place and comments. A key that was absent, or written by someone
/// else since, stays unmatched.
fn carry_frontmatter_source_item(
    map: &yrs::MapRef,
    meta: &yrs::MapRef,
    txn: &mut yrs::TransactionMut,
    key: &str,
    before: Option<yrs::ID>,
) {
    let (Some(before), Some(after)) = (before, map.entry_id(txn, key)) else {
        return;
    };
    let meta_key = item_meta_key(key);
    if matches!(meta.get(txn, &meta_key), Some(Out::Any(Any::String(item))) if item.as_ref() == item_text(before))
    {
        meta.insert(txn, meta_key.as_str(), item_text(after));
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn encode_state_vector_canonical(state_vector: &StateVector) -> Vec<u8> {
    let mut entries: Vec<_> = state_vector
        .iter()
        .map(|(client, clock)| (client.get(), *clock))
        .collect();
    entries.sort_unstable_by_key(|(client, _)| *client);

    let mut encoder = EncoderV1::new();
    encoder.write_var(entries.len());
    for (client, clock) in entries {
        encoder.write_var(client);
        encoder.write_var(clock);
    }
    encoder.to_vec()
}

/// Whether `source` reads as `projection` does: the editor builds the same
/// body from both, where `\[` and `[` are the same text, and a renderer finds the same markup the editor keeps as
/// text, such as raw HTML, in the same places.
fn markdown_reads_alike(source: &str, projection: &str) -> bool {
    let read = |markdown: &str| {
        let (_, _, body) = split_markdown_frontmatter(markdown);
        read_markdown::read_markdown(&body.replace("\r\n", "\n"))
    };
    matches!(
        (read(source), read(projection)),
        (Ok(source), Ok(projection)) if read_markdown::shows_alike(&source, &projection)
    )
}

/// Whether renderers decode this reference, which the importer keeps as
/// text, to a character a reader may not see as written: any numeric
/// reference, which can name a control, format, or bidirectional character;
/// a name with a capital letter, as in `&LT;` or `&ZeroWidthSpace;`; or a
/// name for a space or an invisible character. `&copy;` stays text.
fn rendered_reference(name: &str) -> bool {
    name.starts_with('#')
        || name.bytes().any(|byte| byte.is_ascii_uppercase())
        || matches!(
            name,
            "nbsp"
                | "ensp"
                | "emsp"
                | "emsp13"
                | "emsp14"
                | "numsp"
                | "puncsp"
                | "thinsp"
                | "hairsp"
                | "zwnj"
                | "zwj"
                | "lrm"
                | "rlm"
                | "shy"
                | "af"
                | "it"
                | "ic"
        )
}

/// HTML elements a Markdown renderer shows as HTML rather than text. A
/// renderer hides a comment and may load what an element points at, so a
/// source may not spell either where its projection holds text. A `<` before
/// any other name, as in `Vec<T>`, is text to the importer and stays so.
const HTML_ELEMENTS: &[&str] = &[
    "a",
    "abbr",
    "address",
    "applet",
    "area",
    "article",
    "aside",
    "audio",
    "b",
    "base",
    "basefont",
    "bdi",
    "bdo",
    "big",
    "blink",
    "blockquote",
    "body",
    "br",
    "button",
    "canvas",
    "caption",
    "center",
    "cite",
    "code",
    "col",
    "colgroup",
    "data",
    "datalist",
    "dd",
    "del",
    "details",
    "dfn",
    "dialog",
    "dir",
    "div",
    "dl",
    "dt",
    "em",
    "embed",
    "fieldset",
    "figcaption",
    "figure",
    "font",
    "footer",
    "form",
    "frame",
    "frameset",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hgroup",
    "hr",
    "html",
    "i",
    "iframe",
    "image",
    "img",
    "input",
    "ins",
    "kbd",
    "label",
    "legend",
    "li",
    "link",
    "main",
    "map",
    "mark",
    "marquee",
    "math",
    "menu",
    "meta",
    "meter",
    "nav",
    "nobr",
    "noembed",
    "noframes",
    "noscript",
    "object",
    "ol",
    "optgroup",
    "option",
    "output",
    "p",
    "param",
    "picture",
    "plaintext",
    "pre",
    "progress",
    "q",
    "rp",
    "rt",
    "ruby",
    "s",
    "samp",
    "script",
    "search",
    "section",
    "select",
    "slot",
    "small",
    "source",
    "span",
    "strike",
    "strong",
    "style",
    "sub",
    "summary",
    "sup",
    "svg",
    "table",
    "tbody",
    "td",
    "template",
    "textarea",
    "tfoot",
    "th",
    "thead",
    "time",
    "title",
    "tr",
    "track",
    "tt",
    "u",
    "ul",
    "var",
    "video",
    "wbr",
    "xmp",
];

/// The raw HTML or autolink that `text`, which starts with `<`, opens: a
/// comment, a processing instruction, a declaration, CDATA, a tag whose name
/// is an HTML element, or any other tag with attributes. Browsers and the
/// renderers that show shared files hide or act on each of these. A tag with
/// no attributes and another name, as in `Vec<T>` or `<file>`, is text.
fn inline_syntax(text: &str) -> Option<String> {
    let rest = &text[1..];
    if rest.starts_with("!--") {
        return Some("comment".into());
    }
    if rest.starts_with('?')
        || rest.starts_with("![CDATA[")
        || rest
            .strip_prefix('!')
            .is_some_and(|declaration| declaration.starts_with(|c: char| c.is_ascii_alphabetic()))
    {
        return Some("declaration".into());
    }
    let tag = rest.strip_prefix('/').unwrap_or(rest);
    let name_end = tag
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
        .unwrap_or(tag.len());
    let name = &tag[..name_end];
    let element = HTML_ELEMENTS
        .iter()
        .any(|element| element.eq_ignore_ascii_case(name))
        && tag[name_end..]
            .chars()
            .next()
            .is_none_or(|next| next.is_whitespace() || next == '>' || next == '/');
    if element || html_tag_end(text, true).is_some() {
        return Some(format!("element {}", name.to_ascii_lowercase()));
    }
    let close = text[1..].find(|c: char| c == '>' || c == '<' || c.is_whitespace())? + 1;
    if !text[close..].starts_with('>') {
        return None;
    }
    let inner = &text[1..close];
    let scheme = inner.split_once(':').map_or("", |(scheme, _)| scheme);
    let uri = (2..=32).contains(&scheme.len())
        && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    let email = inner.split_once('@').is_some_and(|(local, domain)| {
        !local.is_empty()
            && !domain.is_empty()
            && domain
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
    });
    (uri || email).then(|| "autolink".into())
}

fn html_tag_end(text: &str, require_attributes: bool) -> Option<usize> {
    let bytes = text.as_bytes();
    let space = |at: usize| matches!(bytes.get(at), Some(b' ' | b'\t' | b'\n' | b'\r' | b'\x0c'));
    let skip_space = |mut at: usize| {
        while space(at) {
            at += 1;
        }
        at
    };
    if !bytes.get(1).is_some_and(u8::is_ascii_alphabetic) {
        return None;
    }
    let mut at = 1;
    while bytes
        .get(at)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
    {
        at += 1;
    }
    let mut attributes = false;
    loop {
        let name = skip_space(at);
        if name == at
            || !bytes
                .get(name)
                .is_some_and(|byte| byte.is_ascii_alphabetic() || matches!(byte, b'_' | b':'))
        {
            break;
        }
        at = name + 1;
        while bytes.get(at).is_some_and(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
        }) {
            at += 1;
        }
        attributes = true;
        let equals = skip_space(at);
        if bytes.get(equals) != Some(&b'=') {
            continue;
        }
        let value = skip_space(equals + 1);
        at = match bytes.get(value) {
            Some(quote @ (b'"' | b'\'')) => value + text[value + 1..].find(char::from(*quote))? + 2,
            _ => {
                let mut end = value;
                while !space(end)
                    && bytes.get(end).is_some_and(|byte| {
                        !matches!(byte, b'"' | b'\'' | b'=' | b'<' | b'>' | b'`')
                    })
                {
                    end += 1;
                }
                if end == value {
                    return None;
                }
                end
            }
        };
    }
    let mut end = skip_space(at);
    if bytes.get(end) == Some(&b'/') {
        end += 1;
    }
    ((attributes || !require_attributes) && bytes.get(end) == Some(&b'>')).then_some(end + 1)
}

/// Split a leading `---` YAML frontmatter block, with the blank lines after
/// it, off the chosen markdown. The prefix is `None` when the document has no
/// readable block. Values use the collection indexer's YAML parser so a
/// richdoc seed and its index agree on scalar, sequence, and mapping types.
fn split_markdown_frontmatter(
    markdown: &str,
) -> (serde_json::Map<String, Value>, Option<&str>, &str) {
    match dohc_engine_domain::collections::markdown_frontmatter_block(markdown) {
        Some(block) => {
            let mut body = block.body;
            while let Some(rest) = body
                .strip_prefix("\r\n")
                .or_else(|| body.strip_prefix('\n'))
            {
                body = rest;
            }
            (
                block.value,
                Some(&markdown[..markdown.len() - body.len()]),
                body,
            )
        }
        None => match dohc_engine_domain::collections::unreadable_frontmatter_prefix(markdown) {
            // A block neither loader reads stays as written, with no values.
            Some(prefix) => {
                let mut body = &markdown[prefix.len()..];
                while let Some(rest) = body
                    .strip_prefix("\r\n")
                    .or_else(|| body.strip_prefix('\n'))
                {
                    body = rest;
                }
                (
                    serde_json::Map::new(),
                    Some(&markdown[..markdown.len() - body.len()]),
                    body,
                )
            }
            None => (serde_json::Map::new(), None, markdown),
        },
    }
}

/// Whether a rewrite applies the outside-file fold restrictions.
#[derive(Clone, Copy, PartialEq, Eq)]
enum FileFold {
    No,
    Strict,
}

const TABLE_ROW_HEIGHTS_PREFIX: &str = "<!-- dohc:table row-heights=";

/// The pairs of a row-height annotation the projector wrote, or `None` for any
/// other line. Pairs the TypeScript importer would drop are dropped here too.
fn parse_table_row_heights(line: &str) -> Option<Vec<(usize, i64)>> {
    let pairs = line
        .strip_prefix(TABLE_ROW_HEIGHTS_PREFIX)?
        .strip_suffix(" -->")?;
    let mut heights = Vec::new();
    for pair in pairs.split(',') {
        let (row, height) = pair.split_once(':')?;
        if row.is_empty()
            || height.is_empty()
            || !row.bytes().all(|byte| byte.is_ascii_digit())
            || !height.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        let (Ok(row), Ok(height)) = (row.parse::<usize>(), height.parse::<i64>()) else {
            return None;
        };
        if table_row_height_in_range(height) {
            heights.push((row, height));
        }
    }
    Some(heights)
}

/// Merge independent v1 updates into one (the compaction analog / `merge_updates`
/// primitive). Every input is pre-validated (the same abort-safe choke point as
/// [`Ydoc::apply`] — see [`Ydoc::validate_update`]'s doc comment) and then
/// decoded; a malformed or adversarial input is rejected fail-closed before it
/// can reach yrs' uncatchable `Update::decode_v1` abort.
pub fn merge_updates(updates: &[Vec<u8>]) -> Result<Vec<u8>, CollabError> {
    let mut decoded = Vec::with_capacity(updates.len());
    for u in updates {
        crate::replay_parity::prevalidate_update_bytes(u)?;
        decoded.push(
            Update::decode_v1(u).map_err(|e| CollabError::MalformedUpdate {
                reason: e.to_string(),
            })?,
        );
    }
    Ok(Update::merge_updates(decoded).encode_v1())
}

/// Snap a UTF-16 offset down to a code-point boundary (Rust strings cannot hold
/// lone surrogates). Mirrors the spike harness.
fn snap_utf16(s: &str, idx: u32) -> u32 {
    let mut units: u32 = 0;
    for c in s.chars() {
        let next = units + c.len_utf16() as u32;
        if next > idx {
            return units;
        }
        units = next;
    }
    units
}

fn content_json(doc: &Doc) -> Value {
    let mut roots = BTreeMap::new();
    // Read each declared root through its typed accessor (defining the kind
    // locally, exactly like the TS engine's typed getters). Empty roots are
    // omitted: whether an empty root exists depends on local API access, not
    // replicated state, so both sides skip them.
    let map_roots = [
        ROOT_FRONTMATTER,
        ROOT_META,
        ROOT_SCENE_REVISIONS,
        ROOT_SCENE_APP_STATE,
        ROOT_SCENE_ASSETS,
    ];
    for name in map_roots {
        let m = doc.get_or_insert_map(name);
        let txn = doc.transact();
        if m.len(&txn) == 0 {
            continue;
        }
        roots.insert(name.to_string(), out_json(&txn, Out::YMap(m)));
    }
    {
        let t = doc.get_or_insert_text(ROOT_PLAINTEXT);
        let txn = doc.transact();
        if t.len(&txn) > 0 {
            roots.insert(ROOT_PLAINTEXT.to_string(), out_json(&txn, Out::YText(t)));
        }
    }
    {
        let f = doc.get_or_insert_xml_fragment(ROOT_BODY);
        let txn = doc.transact();
        if f.len(&txn) > 0 {
            roots.insert(ROOT_BODY.to_string(), out_json(&txn, Out::YXmlFragment(f)));
        }
    }
    // Surface any replicated root the schema did not declare so a mismatch in
    // root enumeration cannot pass silently.
    let txn = doc.transact();
    let declared = [
        ROOT_FRONTMATTER,
        ROOT_META,
        ROOT_BODY,
        ROOT_PLAINTEXT,
        ROOT_SCENE_REVISIONS,
        ROOT_SCENE_APP_STATE,
        ROOT_SCENE_ASSETS,
    ];
    for (name, _) in txn.root_refs() {
        if !declared.contains(&name) {
            roots.insert(name.to_string(), json!({ "type": "undeclaredRoot" }));
        }
    }
    Value::Object(roots.into_iter().collect())
}

fn out_json<T: ReadTxn>(txn: &T, out: Out) -> Value {
    match out {
        Out::YMap(m) => {
            let mut entries = BTreeMap::new();
            for (k, v) in m.iter(txn) {
                entries.insert(k.to_string(), out_json(txn, v));
            }
            json!({ "type": "map", "value": Value::Object(entries.into_iter().collect()) })
        }
        Out::YArray(a) => {
            let items: Vec<Value> = a.iter(txn).map(|v| out_json(txn, v)).collect();
            json!({ "type": "array", "value": items })
        }
        Out::YText(t) => {
            json!({ "type": "text", "delta": diffs_json(t.diff(txn, YChange::identity)) })
        }
        Out::YXmlFragment(f) => {
            let children: Vec<Value> = f.children(txn).map(|c| xml_json(txn, c)).collect();
            json!({ "type": "xmlFragment", "children": children })
        }
        Out::YXmlElement(el) => xml_json(txn, XmlOut::Element(el)),
        Out::YXmlText(t) => xml_json(txn, XmlOut::Text(t)),
        Out::Any(any) => json!({ "type": "any", "value": any_to_json(&any) }),
        other => json!({ "type": "unsupported", "debug": format!("{other:?}") }),
    }
}

/// What an outside save's fold did to find the blocks it keeps, counted on
/// this thread so tests can hold its cost to counts rather than times.
#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct FoldWork {
    /// Blocks built in the scratch body to compare against.
    pub(crate) built: usize,
    /// Nodes `same_xml` compared.
    pub(crate) compared: usize,
    /// Nodes `xml_json` serialized.
    pub(crate) serialized: usize,
}

#[cfg(test)]
thread_local! {
    pub(crate) static FOLD_WORK: std::cell::Cell<FoldWork> = const {
        std::cell::Cell::new(FoldWork { built: 0, compared: 0, serialized: 0 })
    };
}

macro_rules! count_fold_work {
    ($field:ident) => {
        #[cfg(test)]
        FOLD_WORK.with(|work| {
            let mut now = work.get();
            now.$field += 1;
            work.set(now);
        });
    };
}

/// `blocks` as the writer writes them, as a whole note's body (`note`) or
/// inside one, which the reader's check reads again.
fn write_blocks(blocks: &[read_markdown::Element], note: bool) -> Option<String> {
    let doc = yrs::Doc::new();
    let fragment = doc.get_or_insert_xml_fragment(ROOT_BODY);
    {
        let mut txn = doc.transact_mut();
        // Inserting at the front walks no items, so blocks go in last first.
        for block in blocks.iter().rev() {
            read_markdown::insert_element(&mut txn, &fragment, 0, block);
        }
    }
    let txn = doc.transact();
    let mut remaining = MAX_PROJECTION_NODES;
    let mut bytes = 0;
    let children = fragment
        .children(&txn)
        .map(|child| markdown_node(&txn, child, 0, &mut remaining, &mut bytes))
        .collect::<ProjectionResult<Vec<_>>>()
        .ok()?;
    if note {
        markdown_document(&children).ok()
    } else {
        render_nodes(&children, "doc", &BTreeMap::new(), "\n\n", false).ok()
    }
}

/// Each run of `blocks` as [`write_blocks`] writes it outside a note, from
/// one document, so a note of a thousand parts builds one document, not a
/// thousand.
fn write_runs(
    blocks: &[read_markdown::Element],
    runs: &[std::ops::Range<usize>],
) -> Vec<Option<String>> {
    let doc = yrs::Doc::new();
    let fragment = doc.get_or_insert_xml_fragment(ROOT_BODY);
    {
        let mut txn = doc.transact_mut();
        for block in blocks.iter().rev() {
            read_markdown::insert_element(&mut txn, &fragment, 0, block);
        }
    }
    let txn = doc.transact();
    let children: Vec<XmlOut> = fragment.children(&txn).collect();
    runs.iter()
        .map(|run| {
            let mut remaining = MAX_PROJECTION_NODES;
            let mut bytes = 0;
            let nodes = children
                .get(run.clone())?
                .iter()
                .map(|child| markdown_node(&txn, child.clone(), 0, &mut remaining, &mut bytes))
                .collect::<ProjectionResult<Vec<_>>>()
                .ok()?;
            render_nodes(&nodes, "doc", &BTreeMap::new(), "\n\n", false).ok()
        })
        .collect()
}

/// How many of `body`'s blocks at the start and at the end are already what
/// `blocks` would insert there, compared without overlapping.
fn unchanged_ends<T: ReadTxn>(
    txn: &T,
    body: &yrs::XmlFragmentRef,
    blocks: &[read_markdown::Element],
) -> (u32, u32) {
    let len = body.len(txn);
    if len == 0 || blocks.is_empty() {
        return (0, 0);
    }
    // Read by index, a block walks every item before it, deleted ones too,
    // so the body is read once. `children` stops at a value that is not
    // XML, so a body holding one keeps nothing.
    let old: Vec<XmlOut> = body.children(txn).collect();
    if old.len() as u32 != len {
        return (0, 0);
    }
    let scratch = yrs::Doc::new();
    let fresh = scratch.get_or_insert_xml_fragment(ROOT_BODY);
    let mut scratch_txn = scratch.transact_mut();
    let mut kept = |old: &XmlOut, block: &read_markdown::Element| {
        let before = fresh.len(&scratch_txn);
        count_fold_work!(built);
        read_markdown::insert_element(&mut scratch_txn, &fresh, 0, block);
        if fresh.len(&scratch_txn) != before + 1 {
            return false;
        }
        fresh
            .get(&scratch_txn, 0)
            .is_some_and(|new| same_xml(txn, old, &scratch_txn, &new))
    };
    let most = len.min(blocks.len() as u32);
    let mut start = 0;
    while start < most && kept(&old[start as usize], &blocks[start as usize]) {
        start += 1;
    }
    let mut end = 0;
    while start + end < most
        && kept(
            &old[(len - 1 - end) as usize],
            &blocks[blocks.len() - 1 - end as usize],
        )
    {
        end += 1;
    }
    (start, end)
}

/// Whether `old` is exactly `new`: the same tag, attributes and children, and
/// the same text runs with the same formatting. Only plain values compare, so
/// an embedded shared type or a value that isn't XML never matches.
fn same_xml<A: ReadTxn, B: ReadTxn>(old_txn: &A, old: &XmlOut, new_txn: &B, new: &XmlOut) -> bool {
    count_fold_work!(compared);
    match (old, new) {
        (XmlOut::Element(old), XmlOut::Element(new)) => {
            if old.tag() != new.tag() {
                return false;
            }
            let mut attributes = 0;
            for (key, value) in old.attributes(old_txn) {
                attributes += 1;
                match (value, new.get_attribute(new_txn, key)) {
                    (Out::Any(value), Some(Out::Any(other))) if value == other => {}
                    _ => return false,
                }
            }
            if attributes != new.attributes(new_txn).count() {
                return false;
            }
            // An empty text piece shows nothing, so a line holding one is the
            // same line as one without, as the server's check reads it.
            // `children` stops at a value that isn't XML, so such a child
            // leaves a count short.
            let (old_len, new_len) = (old.len(old_txn), new.len(new_txn));
            let (mut old_seen, mut new_seen) = (0, 0);
            let mut olds = old
                .children(old_txn)
                .inspect(|_| old_seen += 1)
                .filter(|child| !is_empty_text(old_txn, child));
            let mut news = new
                .children(new_txn)
                .inspect(|_| new_seen += 1)
                .filter(|child| !is_empty_text(new_txn, child));
            loop {
                match (olds.next(), news.next()) {
                    (None, None) => break,
                    (Some(old), Some(new)) if same_xml(old_txn, &old, new_txn, &new) => {}
                    _ => return false,
                }
            }
            drop((olds, news));
            old_seen == old_len && new_seen == new_len
        }
        (XmlOut::Text(old), XmlOut::Text(new)) => {
            let old = old.diff(old_txn, YChange::identity);
            let new = new.diff(new_txn, YChange::identity);
            old.len() == new.len()
                && old.iter().zip(&new).all(|(old, new)| {
                    matches!(old.insert, Out::Any(_))
                        && old.insert == new.insert
                        && old.attributes == new.attributes
                })
        }
        _ => false,
    }
}

fn is_empty_text<T: ReadTxn>(txn: &T, node: &XmlOut) -> bool {
    matches!(node, XmlOut::Text(text) if text.len(txn) == 0)
}

fn xml_json<T: ReadTxn>(txn: &T, node: XmlOut) -> Value {
    count_fold_work!(serialized);
    match node {
        XmlOut::Element(el) => {
            let mut attrs = BTreeMap::new();
            for (k, v) in el.attributes(txn) {
                attrs.insert(k.to_string(), out_json_attr(txn, v));
            }
            let children: Vec<Value> = el.children(txn).map(|c| xml_json(txn, c)).collect();
            json!({
                "type": "element",
                "tag": el.tag().to_string(),
                "attrs": Value::Object(attrs.into_iter().collect()),
                "children": children,
            })
        }
        XmlOut::Text(t) => {
            json!({ "type": "xmlText", "delta": diffs_json(t.diff(txn, YChange::identity)) })
        }
        XmlOut::Fragment(f) => {
            let children: Vec<Value> = f.children(txn).map(|c| xml_json(txn, c)).collect();
            json!({ "type": "xmlFragment", "children": children })
        }
    }
}

fn out_json_attr<T: ReadTxn>(txn: &T, out: Out) -> Value {
    match out {
        Out::Any(any) => any_to_json(&any),
        other => out_json(txn, other),
    }
}

fn consume_projection_value_node(
    depth: usize,
    remaining_nodes: &mut usize,
) -> ProjectionResult<()> {
    if depth > MAX_PROJECTION_DEPTH || *remaining_nodes == 0 {
        return Err(CollabError::ProjectionTooComplex {
            max_depth: MAX_PROJECTION_DEPTH,
            max_nodes: MAX_PROJECTION_NODES,
        });
    }
    *remaining_nodes -= 1;
    Ok(())
}

fn projection_out_json<T: ReadTxn>(
    txn: &T,
    out: Out,
    depth: usize,
    remaining_nodes: &mut usize,
    source_bytes: &mut usize,
) -> ProjectionResult<Value> {
    consume_projection_value_node(depth, remaining_nodes)?;
    match out {
        Out::YMap(map) => {
            let mut entries = BTreeMap::new();
            for (key, value) in map.iter(txn) {
                *source_bytes = checked_projection_len(*source_bytes, key.len())?;
                entries.insert(
                    key.to_string(),
                    projection_out_json(txn, value, depth + 1, remaining_nodes, source_bytes)?,
                );
            }
            Ok(json!({
                "type": "map",
                "value": Value::Object(entries.into_iter().collect())
            }))
        }
        Out::YArray(array) => {
            let mut items = Vec::new();
            for value in array.iter(txn) {
                items.push(projection_out_json(
                    txn,
                    value,
                    depth + 1,
                    remaining_nodes,
                    source_bytes,
                )?);
            }
            Ok(json!({ "type": "array", "value": items }))
        }
        Out::YText(text) => Ok(json!({
            "type": "text",
            "delta": projection_text_json(
                txn,
                &text,
                depth + 1,
                remaining_nodes,
                source_bytes,
            )?
        })),
        Out::YXmlFragment(fragment) => {
            let mut children = Vec::new();
            for child in fragment.children(txn) {
                children.push(projection_xml_json(
                    txn,
                    child,
                    depth + 1,
                    remaining_nodes,
                    source_bytes,
                )?);
            }
            Ok(json!({ "type": "xmlFragment", "children": children }))
        }
        Out::YXmlElement(element) => projection_xml_json(
            txn,
            XmlOut::Element(element),
            depth + 1,
            remaining_nodes,
            source_bytes,
        ),
        Out::YXmlText(text) => projection_xml_json(
            txn,
            XmlOut::Text(text),
            depth + 1,
            remaining_nodes,
            source_bytes,
        ),
        Out::Any(any) => Ok(json!({
            "type": "any",
            "value": projection_any_to_json(
                &any,
                depth + 1,
                remaining_nodes,
                source_bytes,
            )?
        })),
        other => {
            let debug = ensure_projection_string(format!("{other:?}"))?;
            Ok(json!({ "type": "unsupported", "debug": debug }))
        }
    }
}

#[cfg(test)]
thread_local! {
    static PROJECTION_TEXT_BYTES_COPIED: std::cell::Cell<usize> =
        const { std::cell::Cell::new(0) };
    static TEXT_RUN_BYTES_CLONED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static RAW_HTML_REFERENCES_RECORDED: std::cell::Cell<usize> =
        const { std::cell::Cell::new(0) };
    static INLINE_PARTS_MATERIALIZED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static EMPTY_LINK_READER_STEPS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static LITERAL_LINKS_WRITTEN: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn append_admitted_projection_text(target: &mut String, text: &str) {
    #[cfg(test)]
    PROJECTION_TEXT_BYTES_COPIED.with(|count| count.set(count.get() + text.len()));
    target.push_str(text);
}

fn projection_xml_json<T: ReadTxn>(
    txn: &T,
    node: XmlOut,
    depth: usize,
    remaining_nodes: &mut usize,
    source_bytes: &mut usize,
) -> ProjectionResult<Value> {
    consume_projection_value_node(depth, remaining_nodes)?;
    match node {
        XmlOut::Element(element) => {
            *source_bytes = checked_projection_len(*source_bytes, element.tag().len())?;
            let mut attrs = BTreeMap::new();
            for (key, value) in element.attributes(txn) {
                *source_bytes = checked_projection_len(*source_bytes, key.len())?;
                attrs.insert(
                    key.to_string(),
                    projection_out_json_attr(txn, value, depth + 1, remaining_nodes, source_bytes)?,
                );
            }
            let mut children = Vec::new();
            for child in element.children(txn) {
                children.push(projection_xml_json(
                    txn,
                    child,
                    depth + 1,
                    remaining_nodes,
                    source_bytes,
                )?);
            }
            Ok(json!({
                "type": "element",
                "tag": element.tag().to_string(),
                "attrs": Value::Object(attrs.into_iter().collect()),
                "children": children,
            }))
        }
        XmlOut::Text(text) => Ok(json!({
            "type": "xmlText",
            "delta": projection_text_json(
                txn,
                &text,
                depth + 1,
                remaining_nodes,
                source_bytes,
            )?
        })),
        XmlOut::Fragment(fragment) => {
            let mut children = Vec::new();
            for child in fragment.children(txn) {
                children.push(projection_xml_json(
                    txn,
                    child,
                    depth + 1,
                    remaining_nodes,
                    source_bytes,
                )?);
            }
            Ok(json!({ "type": "xmlFragment", "children": children }))
        }
    }
}

fn projection_out_json_attr<T: ReadTxn>(
    txn: &T,
    out: Out,
    depth: usize,
    remaining_nodes: &mut usize,
    source_bytes: &mut usize,
) -> ProjectionResult<Value> {
    match out {
        Out::Any(any) => projection_any_to_json(&any, depth, remaining_nodes, source_bytes),
        other => projection_out_json(txn, other, depth, remaining_nodes, source_bytes),
    }
}

fn projection_text_json<T: ReadTxn, R: Text>(
    txn: &T,
    text: &R,
    depth: usize,
    remaining_nodes: &mut usize,
    source_bytes: &mut usize,
) -> ProjectionResult<Value> {
    let mut items: Vec<Value> = Vec::new();
    text.try_visit_diff(txn, |chunk| -> ProjectionResult<()> {
        if let TextDiffChunk::Text {
            text,
            continues_previous: true,
            ..
        } = &chunk
        {
            *source_bytes = checked_projection_len(*source_bytes, text.len())?;
            if let Some(Value::String(previous)) =
                items.last_mut().and_then(|item| item.get_mut("insert"))
            {
                append_admitted_projection_text(previous, text);
            }
            return Ok(());
        }
        consume_projection_value_node(depth, remaining_nodes)?;
        let (insert, attrs) = match chunk {
            TextDiffChunk::Text {
                text, attributes, ..
            } => {
                projection_text_insert(text, attributes, depth + 1, remaining_nodes, source_bytes)?
            }
            TextDiffChunk::Embed {
                insert: Out::Any(Any::String(text)),
                attributes,
            } => {
                projection_text_insert(&text, attributes, depth + 1, remaining_nodes, source_bytes)?
            }
            TextDiffChunk::Embed { insert, attributes } => {
                let insert = match insert {
                    Out::Any(any) => {
                        projection_any_to_json(&any, depth + 1, remaining_nodes, source_bytes)?
                    }
                    other => {
                        consume_projection_value_node(depth + 1, remaining_nodes)?;
                        json!(ensure_projection_string(format!("{other:?}"))?)
                    }
                };
                let attrs = projection_diff_attributes(
                    attributes,
                    depth + 1,
                    remaining_nodes,
                    source_bytes,
                )?;
                (insert, attrs)
            }
        };
        items.push(match attrs {
            Some(attrs) => json!({ "insert": insert, "attrs": attrs }),
            None => json!({ "insert": insert }),
        });
        Ok(())
    })?;
    Ok(Value::Array(items))
}

fn projection_text_insert(
    text: &str,
    attributes: &yrs::types::Attrs,
    depth: usize,
    remaining_nodes: &mut usize,
    source_bytes: &mut usize,
) -> ProjectionResult<(Value, Option<Value>)> {
    consume_projection_value_node(depth, remaining_nodes)?;
    *source_bytes = checked_projection_len(*source_bytes, text.len())?;
    let attrs = projection_diff_attributes(attributes, depth, remaining_nodes, source_bytes)?;
    let mut value = String::new();
    append_admitted_projection_text(&mut value, text);
    Ok((Value::String(value), attrs))
}

fn projection_diff_attributes(
    attrs: &yrs::types::Attrs,
    depth: usize,
    remaining_nodes: &mut usize,
    source_bytes: &mut usize,
) -> ProjectionResult<Option<Value>> {
    if attrs.is_empty() {
        return Ok(None);
    }
    let mut sorted = BTreeMap::new();
    for (key, value) in attrs {
        *source_bytes = checked_projection_len(*source_bytes, key.len())?;
        let value = projection_any_to_json(value, depth, remaining_nodes, source_bytes)?;
        sorted.insert(key.to_string(), value);
    }
    Ok(Some(Value::Object(sorted.into_iter().collect())))
}

fn projection_any_to_json(
    any: &Any,
    depth: usize,
    remaining_nodes: &mut usize,
    source_bytes: &mut usize,
) -> ProjectionResult<Value> {
    consume_projection_value_node(depth, remaining_nodes)?;
    match any {
        Any::Null | Any::Undefined => Ok(Value::Null),
        Any::Bool(value) => Ok(json!(value)),
        Any::Number(value) => {
            if value.fract() == 0.0 && value.is_finite() && value.abs() < 9.007_199_254_740_992e15 {
                Ok(json!(*value as i64))
            } else {
                Ok(json!(value))
            }
        }
        Any::BigInt(value) => Ok(json!(value)),
        Any::String(value) => {
            *source_bytes = checked_projection_len(*source_bytes, value.len())?;
            Ok(json!(value.as_ref()))
        }
        Any::Buffer(value) => {
            let encoded_len = value
                .len()
                .div_ceil(3)
                .checked_mul(4)
                .ok_or_else(|| projection_too_large(usize::MAX))?;
            *source_bytes = checked_projection_len(*source_bytes, encoded_len)?;
            Ok(json!({ "__bytes__": base64_encode(value.as_ref()) }))
        }
        Any::Array(values) => {
            let mut items = Vec::new();
            for value in values.iter() {
                items.push(projection_any_to_json(
                    value,
                    depth + 1,
                    remaining_nodes,
                    source_bytes,
                )?);
            }
            Ok(Value::Array(items))
        }
        Any::Map(map) => {
            let mut sorted = BTreeMap::new();
            for (key, value) in map.iter() {
                *source_bytes = checked_projection_len(*source_bytes, key.len())?;
                sorted.insert(
                    key.clone(),
                    projection_any_to_json(value, depth + 1, remaining_nodes, source_bytes)?,
                );
            }
            Ok(Value::Object(sorted.into_iter().collect()))
        }
    }
}

fn diffs_json<D>(diffs: Vec<yrs::types::text::Diff<D>>) -> Value {
    let items: Vec<Value> = diffs
        .into_iter()
        .map(|d| {
            let insert = match d.insert {
                Out::Any(any) => any_to_json(&any),
                other => json!(format!("{other:?}")),
            };
            let attrs = d.attributes.map(|a| {
                let mut sorted = BTreeMap::new();
                for (k, v) in a.iter() {
                    sorted.insert(k.to_string(), any_to_json(v));
                }
                Value::Object(sorted.into_iter().collect())
            });
            match attrs {
                Some(attrs) => json!({ "insert": insert, "attrs": attrs }),
                None => json!({ "insert": insert }),
            }
        })
        .collect();
    Value::Array(items)
}

pub(crate) fn any_to_json(any: &Any) -> Value {
    match any {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(b) => json!(b),
        Any::Number(n) => {
            if n.fract() == 0.0 && n.is_finite() && n.abs() < 9.007_199_254_740_992e15 {
                json!(*n as i64)
            } else {
                json!(n)
            }
        }
        Any::BigInt(i) => json!(i),
        Any::String(s) => json!(s.as_ref()),
        Any::Buffer(b) => json!({ "__bytes__": base64_encode(b.as_ref()) }),
        Any::Array(items) => Value::Array(items.iter().map(any_to_json).collect()),
        Any::Map(map) => {
            let mut sorted = BTreeMap::new();
            for (k, v) in map.iter() {
                sorted.insert(k.clone(), any_to_json(v));
            }
            Value::Object(sorted.into_iter().collect())
        }
    }
}

fn json_to_any(value: &Value) -> Any {
    match value {
        Value::Null => Any::Null,
        Value::Bool(value) => Any::Bool(*value),
        Value::Number(value) => {
            const MAX_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;
            match value.as_i64() {
                Some(integer) if integer.unsigned_abs() > MAX_SAFE_INTEGER => Any::BigInt(integer),
                _ => Any::Number(value.as_f64().unwrap_or(f64::NAN)),
            }
        }
        Value::String(value) => Any::from(value.as_str()),
        Value::Array(values) => Any::from(values.iter().map(json_to_any).collect::<Vec<_>>()),
        Value::Object(values) => Any::from(
            values
                .iter()
                .map(|(key, value)| (key.clone(), json_to_any(value)))
                .collect::<HashMap<String, Any>>(),
        ),
    }
}

/// Minimal standard-base64 for the rare `Any::Buffer` case in canonical content.
/// (dohc content has no binary Any values today; kept for completeness/parity.)
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = chunk.get(1).copied().unwrap_or(0) as usize;
        let b2 = chunk.get(2).copied().unwrap_or(0) as usize;
        out.push(ALPHABET[b0 >> 2] as char);
        out.push(ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[b2 & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

type ProjectionResult<T> = Result<T, CollabError>;

fn projection_too_large(actual: usize) -> CollabError {
    CollabError::ProjectionTooLarge {
        actual,
        max: MAX_PROJECTION_BYTES,
    }
}

fn checked_projection_len(current: usize, additional: usize) -> Result<usize, CollabError> {
    let attempted = current
        .checked_add(additional)
        .ok_or_else(|| projection_too_large(usize::MAX))?;
    if attempted > MAX_PROJECTION_BYTES {
        Err(projection_too_large(attempted))
    } else {
        Ok(attempted)
    }
}

fn ensure_projection_string(value: String) -> Result<String, CollabError> {
    if value.len() > MAX_PROJECTION_BYTES {
        Err(projection_too_large(value.len()))
    } else {
        Ok(value)
    }
}

/// A saved note that isn't empty ends with one line break.
fn end_with_line_break(out: &mut ProjectionBuffer, line_break: &str) -> Result<(), CollabError> {
    if out.value.is_empty() || out.value.ends_with('\n') {
        return Ok(());
    }
    out.push_str(line_break)
}

struct ProjectionBuffer {
    value: String,
}

impl ProjectionBuffer {
    fn new() -> Self {
        Self {
            value: String::new(),
        }
    }

    fn with_capacity(capacity: usize) -> Result<Self, CollabError> {
        if capacity > MAX_PROJECTION_BYTES {
            return Err(projection_too_large(capacity));
        }
        Ok(Self {
            value: String::with_capacity(capacity),
        })
    }

    fn push_str(&mut self, value: &str) -> Result<(), CollabError> {
        checked_projection_len(self.value.len(), value.len())?;
        self.value.push_str(value);
        Ok(())
    }

    fn push(&mut self, value: char) -> Result<(), CollabError> {
        checked_projection_len(self.value.len(), value.len_utf8())?;
        self.value.push(value);
        Ok(())
    }

    fn push_repeat(&mut self, value: char, count: usize) -> Result<(), CollabError> {
        let bytes = value
            .len_utf8()
            .checked_mul(count)
            .ok_or_else(|| projection_too_large(usize::MAX))?;
        checked_projection_len(self.value.len(), bytes)?;
        self.value.extend(std::iter::repeat_n(value, count));
        Ok(())
    }

    fn into_string(self) -> String {
        self.value
    }
}

/// yjs cannot place a bigint directly in a `Y.Array`, so its shared-type
/// frontmatter branch stores one as a singleton `Y.Map` under this key.
/// Literal user keys spelled like the sentinel arrive prefix-escaped with one
/// extra `$` (any escape depth), mirroring the `$dohcInt64` wire markers.
const FRONTMATTER_SHARED_BIGINT_KEY: &str = "$dohcBigInt";

fn is_frontmatter_shared_bigint_spelling(key: &str) -> bool {
    key.strip_prefix('$')
        .is_some_and(|rest| rest.trim_start_matches('$') == "dohcBigInt")
}

fn unescape_frontmatter_shared_bigint_key(key: &str) -> &str {
    if key.starts_with("$$") && is_frontmatter_shared_bigint_spelling(key) {
        &key[1..]
    } else {
        key
    }
}

/// One frontmatter value as the plain JSON both engines settle. Shared-type
/// values (yjs writes them for maps with a `constructor` key and for bigints
/// in arrays) must render exactly like their plain-`Any` twins: the bigint
/// sentinel becomes its integer and escaped sentinel keys lose one `$`.
fn projection_frontmatter_value<T: ReadTxn>(
    txn: &T,
    out: Out,
    depth: usize,
    remaining_nodes: &mut usize,
    source_bytes: &mut usize,
) -> ProjectionResult<Value> {
    match out {
        Out::YMap(map) => {
            consume_projection_value_node(depth, remaining_nodes)?;
            if map.len(txn) == 1 {
                if let Some(Out::Any(Any::BigInt(integer))) =
                    map.get(txn, FRONTMATTER_SHARED_BIGINT_KEY)
                {
                    return Ok(json!(integer));
                }
            }
            let mut entries = BTreeMap::new();
            for (key, value) in map.iter(txn) {
                *source_bytes = checked_projection_len(*source_bytes, key.len())?;
                entries.insert(
                    unescape_frontmatter_shared_bigint_key(key).to_owned(),
                    projection_frontmatter_value(
                        txn,
                        value,
                        depth + 1,
                        remaining_nodes,
                        source_bytes,
                    )?,
                );
            }
            Ok(Value::Object(entries.into_iter().collect()))
        }
        Out::YArray(array) => {
            consume_projection_value_node(depth, remaining_nodes)?;
            let mut items = Vec::new();
            for value in array.iter(txn) {
                items.push(projection_frontmatter_value(
                    txn,
                    value,
                    depth + 1,
                    remaining_nodes,
                    source_bytes,
                )?);
            }
            Ok(Value::Array(items))
        }
        Out::Any(any) => frontmatter_any(&any, depth, remaining_nodes, source_bytes),
        other => projection_out_json(txn, other, depth, remaining_nodes, source_bytes),
    }
}

fn frontmatter_any(
    any: &Any,
    depth: usize,
    nodes: &mut usize,
    bytes: &mut usize,
) -> ProjectionResult<Value> {
    match any {
        Any::Number(value) => {
            consume_projection_value_node(depth, nodes)?;
            Ok(json!(value))
        }
        Any::Array(values) => {
            consume_projection_value_node(depth, nodes)?;
            values
                .iter()
                .map(|value| frontmatter_any(value, depth + 1, nodes, bytes))
                .collect::<ProjectionResult<Vec<_>>>()
                .map(Value::Array)
        }
        Any::Map(values) => {
            consume_projection_value_node(depth, nodes)?;
            let mut map = serde_json::Map::new();
            for (key, value) in values.iter() {
                *bytes = checked_projection_len(*bytes, key.len())?;
                map.insert(
                    key.clone(),
                    frontmatter_any(value, depth + 1, nodes, bytes)?,
                );
            }
            Ok(Value::Object(map))
        }
        _ => projection_any_to_json(any, depth, nodes, bytes),
    }
}

fn project_frontmatter(key: &str, value: &Value) -> ProjectionResult<String> {
    let mut output = ProjectionBuffer::new();
    frontmatter_yaml::entry(&mut output, key, value, 0)?;
    Ok(output.into_string())
}

#[derive(Debug)]
enum MarkdownNode {
    Text(Vec<TextRun>),
    Element {
        tag: String,
        attrs: BTreeMap<String, Value>,
        children: Vec<MarkdownNode>,
    },
    Fragment(Vec<MarkdownNode>),
}

#[derive(Debug)]
#[cfg_attr(not(test), derive(Clone))]
struct TextRun {
    text: String,
    marks: Vec<MarkdownMark>,
}

// Tests count the text each clone copies.
#[cfg(test)]
impl Clone for TextRun {
    fn clone(&self) -> Self {
        TEXT_RUN_BYTES_CLONED.with(|count| count.set(count.get() + self.text.len()));
        Self {
            text: self.text.clone(),
            marks: self.marks.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MarkdownMark {
    kind: MarkKind,
    attrs: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum MarkKind {
    Link,
    Highlight,
    Bold,
    Code,
    Italic,
    Strike,
    Underline,
}

impl MarkKind {
    fn rank(self) -> usize {
        match self {
            Self::Link => 0,
            Self::Highlight => 1,
            Self::Bold => 2,
            Self::Code => 3,
            Self::Italic => 4,
            Self::Strike => 5,
            Self::Underline => 6,
        }
    }

    fn html_tags(self) -> Option<(&'static str, &'static str)> {
        match self {
            Self::Bold => Some(("<strong>", "</strong>")),
            Self::Italic => Some(("<em>", "</em>")),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpeningMode {
    Markdown,
    Html,
}

struct RenderContext<'a> {
    parent_tag: &'a str,
    parent_attrs: &'a BTreeMap<String, Value>,
    previous: Option<&'a MarkdownNode>,
    index: usize,
    /// Whether the node sits in a table cell, where the projector writes a
    /// `<br>` as a real tag. The importer reads a real tag as raw HTML, so
    /// such a `<br>` bounds no raw HTML span.
    table_cell: bool,
}

fn markdown_node<T: ReadTxn>(
    txn: &T,
    node: XmlOut,
    depth: usize,
    remaining_nodes: &mut usize,
    source_text_bytes: &mut usize,
) -> ProjectionResult<MarkdownNode> {
    if depth > MAX_PROJECTION_DEPTH || *remaining_nodes == 0 {
        return Err(CollabError::ProjectionTooComplex {
            max_depth: MAX_PROJECTION_DEPTH,
            max_nodes: MAX_PROJECTION_NODES,
        });
    }
    *remaining_nodes -= 1;
    match node {
        XmlOut::Text(text) => {
            let mut runs = Vec::new();
            text.try_visit_diff(txn, |chunk| match chunk {
                TextDiffChunk::Text {
                    text,
                    attributes,
                    continues_previous,
                } => append_markdown_text(
                    &mut runs,
                    text,
                    attributes,
                    continues_previous,
                    depth,
                    remaining_nodes,
                    source_text_bytes,
                ),
                TextDiffChunk::Embed {
                    insert: Out::Any(Any::String(text)),
                    attributes,
                } => append_markdown_text(
                    &mut runs,
                    &text,
                    attributes,
                    false,
                    depth,
                    remaining_nodes,
                    source_text_bytes,
                ),
                TextDiffChunk::Embed { .. } => Ok(()),
            })?;
            Ok(MarkdownNode::Text(runs))
        }
        XmlOut::Element(element) => {
            *source_text_bytes = checked_projection_len(*source_text_bytes, element.tag().len())?;
            let mut attrs = BTreeMap::new();
            for (key, value) in element.attributes(txn) {
                *source_text_bytes = checked_projection_len(*source_text_bytes, key.len())?;
                let value = projection_out_json_attr(
                    txn,
                    value,
                    depth + 1,
                    remaining_nodes,
                    source_text_bytes,
                )?;
                if matches!(element.tag().as_ref(), "tableCell" | "tableHeader")
                    && matches!(key, "colspan" | "rowspan")
                    && value.as_f64() == Some(1.0)
                {
                    continue;
                }
                attrs.insert(key.to_string(), value);
            }
            let mut children = Vec::new();
            for child in element.children(txn) {
                let child =
                    markdown_node(txn, child, depth + 1, remaining_nodes, source_text_bytes)?;
                // An empty text piece writes nothing; its line is still an empty line.
                if !matches!(&child, MarkdownNode::Text(runs) if runs.is_empty()) {
                    children.push(child);
                }
            }
            Ok(MarkdownNode::Element {
                tag: element.tag().to_string(),
                attrs,
                children,
            })
        }
        XmlOut::Fragment(fragment) => Ok(MarkdownNode::Fragment(
            fragment
                .children(txn)
                .map(|child| {
                    markdown_node(txn, child, depth + 1, remaining_nodes, source_text_bytes)
                })
                .collect::<ProjectionResult<_>>()?,
        )),
    }
}

fn append_markdown_text(
    runs: &mut Vec<TextRun>,
    text: &str,
    attrs: &yrs::types::Attrs,
    continues_previous: bool,
    depth: usize,
    remaining_nodes: &mut usize,
    source_text_bytes: &mut usize,
) -> ProjectionResult<()> {
    if continues_previous {
        *source_text_bytes = checked_projection_len(*source_text_bytes, text.len())?;
        if let Some(previous) = runs.last_mut() {
            append_admitted_projection_text(&mut previous.text, text);
        }
        return Ok(());
    }
    consume_projection_value_node(depth, remaining_nodes)?;
    *source_text_bytes = checked_projection_len(*source_text_bytes, text.len())?;
    let mut marks = Vec::new();
    for key in attrs.keys() {
        *source_text_bytes = checked_projection_len(*source_text_bytes, key.len())?;
    }
    push_mark(
        &mut marks,
        MarkKind::Link,
        attrs.get("link"),
        depth + 2,
        remaining_nodes,
        source_text_bytes,
    )?;
    push_mark(
        &mut marks,
        MarkKind::Highlight,
        attrs.get("highlight"),
        depth + 2,
        remaining_nodes,
        source_text_bytes,
    )?;
    push_mark(
        &mut marks,
        MarkKind::Bold,
        attrs.get("bold").or_else(|| attrs.get("strong")),
        depth + 2,
        remaining_nodes,
        source_text_bytes,
    )?;
    push_mark(
        &mut marks,
        MarkKind::Code,
        attrs.get("code"),
        depth + 2,
        remaining_nodes,
        source_text_bytes,
    )?;
    push_mark(
        &mut marks,
        MarkKind::Italic,
        attrs.get("italic").or_else(|| attrs.get("em")),
        depth + 2,
        remaining_nodes,
        source_text_bytes,
    )?;
    push_mark(
        &mut marks,
        MarkKind::Strike,
        attrs.get("strike").or_else(|| attrs.get("strikethrough")),
        depth + 2,
        remaining_nodes,
        source_text_bytes,
    )?;
    push_mark(
        &mut marks,
        MarkKind::Underline,
        attrs.get("underline"),
        depth + 2,
        remaining_nodes,
        source_text_bytes,
    )?;
    let mut value = String::new();
    append_admitted_projection_text(&mut value, text);
    runs.push(TextRun { text: value, marks });
    Ok(())
}

fn push_mark(
    marks: &mut Vec<MarkdownMark>,
    kind: MarkKind,
    attrs: Option<&Any>,
    depth: usize,
    remaining_nodes: &mut usize,
    source_text_bytes: &mut usize,
) -> ProjectionResult<()> {
    if let Some(attrs) = attrs {
        marks.push(MarkdownMark {
            kind,
            attrs: projection_any_to_json(attrs, depth, remaining_nodes, source_text_bytes)?,
        });
    }
    Ok(())
}

fn markdown_document(children: &[MarkdownNode]) -> ProjectionResult<String> {
    let attrs = BTreeMap::new();
    let rendered = render_nodes(children, "doc", &attrs, "\n\n", false)?;
    // Blank lines are written `&nbsp;`, so output of only that is an empty
    // note, unless a sealed piece holds it as the file's own text.
    if markdown_output_is_empty(&rendered) && !children.iter().any(holds_sealed_piece) {
        Ok(String::new())
    } else {
        Ok(trim_js_end(&rendered).to_string())
    }
}

fn holds_sealed_piece(node: &MarkdownNode) -> bool {
    match node {
        MarkdownNode::Text(_) => false,
        MarkdownNode::Element { tag, children, .. } => {
            matches!(tag.as_str(), "rawBlock" | "rawInline")
                || children.iter().any(holds_sealed_piece)
        }
        MarkdownNode::Fragment(children) => children.iter().any(holds_sealed_piece),
    }
}

fn markdown_output_is_empty(markdown: &str) -> bool {
    let without_entities = markdown.replace("&nbsp;", "").replace('\u{00a0}', "");
    trim_js(&without_entities).is_empty()
}

/// With `definition`, for a definition in a table cell, the `[` that starts
/// `markdown` is written as `&#91;`, the reference later lines already use,
/// which the importer reads back as text, not as an escape. See
/// [`definition_paragraph`].
fn escape_markdown_block_syntax(
    markdown: &str,
    mut starts_line: bool,
    mut definition: bool,
) -> ProjectionResult<String> {
    let mut output = ProjectionBuffer::new();
    let markdown = encode_paragraph_whitespace(markdown);
    for line in markdown.split_inclusive('\n') {
        let body = line.strip_suffix('\n').unwrap_or(line);
        if starts_line {
            if let Some(entity) = indented_code_leading_entity(body) {
                output.push_str(entity)?;
                output.push_str(&body[1..])?;
            } else if let Some((index, escape_next)) = leading_markdown_block_escape_index(body) {
                output.push_str(&body[..index])?;
                if definition && index == 0 && body.starts_with('[') {
                    output.push_str("&#91;")?;
                    output.push_str(&body[1..])?;
                } else if escape_next {
                    output.push('\\')?;
                    output.push_str(&body[index..index + 1])?;
                    output.push('\\')?;
                    output.push_str(&body[index + 1..])?;
                } else {
                    output.push('\\')?;
                    output.push_str(&body[index..])?;
                }
            } else {
                output.push_str(body)?;
            }
        } else {
            output.push_str(body)?;
        }
        definition = false;
        if line.ends_with('\n') {
            output.push('\n')?;
            starts_line = true;
        } else {
            starts_line = false;
        }
    }
    Ok(output.into_string())
}

/// Paragraph text writes a `\r`, and an NBSP that task-list parsing would read
/// as indentation, as references. They are written in place, so the text
/// around them stays one run for block openers and marks.
fn encode_paragraph_whitespace(text: &str) -> String {
    text.replace('\r', "&#13;").replace('\u{a0}', "&#160;")
}

fn indented_code_leading_entity(markdown: &str) -> Option<&'static str> {
    let mut column = 0usize;
    for byte in markdown.bytes() {
        match byte {
            b' ' => column += 1,
            b'\t' => column += 4 - (column % 4),
            _ => break,
        }
        if column >= 4 {
            return match markdown.as_bytes().first() {
                Some(b' ') => Some("&#32;"),
                Some(b'\t') => Some("&#9;"),
                _ => None,
            };
        }
    }
    None
}

fn leading_markdown_block_escape_index(markdown: &str) -> Option<(usize, bool)> {
    let bytes = markdown.as_bytes();
    let indent = bytes
        .iter()
        .take(4)
        .take_while(|byte| **byte == b' ')
        .count();
    if indent == 4 {
        return None;
    }
    let rest = &bytes[indent..];
    let boundary = |index: usize| {
        rest.get(index)
            .is_none_or(|byte| matches!(*byte, b' ' | b'\t'))
    };

    let hashes = rest.iter().take_while(|byte| **byte == b'#').count();
    if (1..=6).contains(&hashes) && boundary(hashes) {
        return Some((indent, false));
    }
    if rest.starts_with(b"$$") {
        return Some((indent, true));
    }
    if rest
        .first()
        .is_some_and(|byte| matches!(*byte, b'-' | b'+' | b'*'))
        && boundary(1)
    {
        return Some((indent, false));
    }
    if rest.starts_with(b"```") || rest.starts_with(b"~~~") {
        return Some((indent, false));
    }
    if let Some(marker @ (b'-' | b'*' | b'_')) = rest.first().copied() {
        let marker_count = rest.iter().filter(|byte| **byte == marker).count();
        if marker_count >= 3
            && rest
                .iter()
                .all(|byte| matches!(*byte, b' ' | b'\t') || *byte == marker)
        {
            return Some((indent, false));
        }
    }
    let setext_end = rest
        .iter()
        .rposition(|byte| !matches!(*byte, b' ' | b'\t'))
        .map_or(0, |index| index + 1);
    let setext = &rest[..setext_end];
    if !setext.is_empty()
        && setext.iter().all(|byte| *byte == b'=' || *byte == b'-')
        && setext.iter().all(|byte| *byte == setext[0])
    {
        return Some((indent, false));
    }
    if rest.starts_with(b"![") {
        return Some((indent + 1, false));
    }
    // A link with no text starts no definition, and the importer reads it as
    // text.
    if rest.starts_with(b"[") && !rest.starts_with(b"[](") {
        return Some((indent, false));
    }
    let digits = rest.iter().take_while(|byte| byte.is_ascii_digit()).count();
    if (1..=9).contains(&digits)
        && rest
            .get(digits)
            .is_some_and(|byte| matches!(*byte, b'.' | b')'))
        && boundary(digits + 1)
    {
        return Some((indent + digits, false));
    }
    None
}

// The importer keeps a link reference definition and a link with no text as
// the text the file holds, and reads them with marked 17's own rules. The
// projector finds them by the same rules: it writes an empty link as it is,
// and a definition as one tag span, whose exact bytes the importer reads back
// as the same text. The importer's tests pin marked's readings of the cases
// `marked_literal_source_readings` repeats here, and compare the importer's
// own copy of `EmptyLinks` with marked on generated text.

/// A run of bare destination text, which every candidate whose destination
/// starts in it shares: where it stops, its last two `)`, and what the rule
/// reads after it, each found once.
struct BareRun {
    start: usize,
    stop: usize,
    close: Option<usize>,
    previous_close: Option<usize>,
    tail: Option<Option<usize>>,
    /// The trimmed end and closing backslashes before the stop and before
    /// the last `)`.
    shapes: Vec<(usize, (usize, usize))>,
    walk: Option<ParenthesisWalk>,
}

/// marked's `findClosingBracket` for each candidate whose destination starts
/// in a run, in candidate order: its start, its first unmatched `)` or
/// `u32::MAX`, and its depth, and the depth at the run's stop and last `)`.
/// Indexes fit `u32` because the projection admits at most
/// `MAX_PROJECTION_BYTES` of text.
struct ParenthesisWalk {
    candidates: Vec<(u32, u32, i32)>,
    stop_depth: i32,
    close_depth: i32,
    next: usize,
}

/// A title's scan from a start: the first delimiter no backslash escapes or
/// the end, the close after it, and the last escaped delimiter whose close
/// succeeds, with that close.
#[derive(Clone, Copy)]
struct TitleScan {
    start: usize,
    end: usize,
    close: Option<usize>,
    escaped: Option<(usize, usize)>,
}

/// marked's inline `link` rule and `Tokenizer.link` checks for a link with
/// no text, read at each `[](` in order. After `[](` the rule is `\s*`, a
/// destination `<(?:\\.|[^\n<>\\])+>` or `[^ \t\n\x00-\x1f]*`, an optional
/// title after `[ \t]+(?:\n[ \t]*)?` or `\n[ \t]*`, then `\s*\)`. Its regex
/// tries the longest choices first, so each step names the first choice
/// that succeeds. Indexes are bytes.
///
/// The reader keeps no table of the text. Each candidate scans its own
/// leading whitespace, and an angle destination stops at the next `<`. Work
/// that candidates share sits in memos that only move forward: the bare run,
/// and each delimiter's title scan for each of three streams of title starts
/// that only grow. A run whose destinations hold `)` is walked once. So the
/// work is linear in the text, and the storage is a few words plus twelve
/// bytes for each candidate in one run, and four more while it is walked.
struct EmptyLinks<'a> {
    text: &'a str,
    run: Option<BareRun>,
    titles: [Option<TitleScan>; 9],
}

/// The bytes the reader of links with no text examines, which its tests
/// count.
fn read_steps(steps: usize) {
    #[cfg(test)]
    EMPTY_LINK_READER_STEPS.with(|count| count.set(count.get() + steps));
    #[cfg(not(test))]
    let _ = steps;
}

impl<'a> EmptyLinks<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            text,
            run: None,
            titles: [None; 9],
        }
    }

    /// Past the whitespace from an index.
    fn solid(&self, index: usize) -> usize {
        let spaces = split_leading_js_whitespace(&self.text[index..]).0.len();
        read_steps(spaces + 1);
        index + spaces
    }

    /// `\s*\)` from an index: the end of the `)`.
    fn close_at(&self, index: usize) -> Option<usize> {
        let at = self.solid(index);
        (self.text.as_bytes().get(at) == Some(&b')')).then_some(at + 1)
    }

    fn tab_end(&self, index: usize) -> usize {
        let tabs = self.text.as_bytes()[index..]
            .iter()
            .take_while(|byte| matches!(byte, b' ' | b'\t'))
            .count();
        read_steps(tabs + 1);
        index + tabs
    }

    fn trim_end(&self, index: usize) -> usize {
        let end = trim_js_end(&self.text[..index]).len();
        read_steps(index - end + 1);
        end
    }

    /// Where an angle destination's characters stop.
    fn angled(&self, index: usize) -> usize {
        let text = self.text;
        let mut at = index;
        while let Some(character) = text[at..].chars().next() {
            match character {
                '\\' => match text[at + 1..].chars().next() {
                    Some(next) if !matches!(next, '\n' | '\r' | '\u{2028}' | '\u{2029}') => {
                        at += 1 + next.len_utf8();
                    }
                    _ => break,
                },
                '\n' | '<' | '>' => break,
                _ => at += character.len_utf8(),
            }
        }
        read_steps(at - index + 1);
        at
    }

    /// A title's scan is fixed from its start: an escaped delimiter is
    /// skipped whole, and the first other delimiter ends it. Backtracking can
    /// end it at an escaped delimiter instead, the last one first. Each of
    /// three streams keeps its last scan, and its starts only grow.
    fn title(&mut self, at: usize, stream: usize) -> Option<usize> {
        let text = self.text;
        let bytes = text.as_bytes();
        let (slot, delimiter) = match bytes.get(at) {
            Some(b'"') => (0, b'"'),
            Some(b'\'') => (1, b'\''),
            Some(b'(') => (2, b')'),
            _ => return None,
        };
        let key = stream * 3 + slot;
        let from = at + 1;
        let known = self.titles[key].filter(|scan| scan.start <= from && from <= scan.end);
        let scan = match known {
            Some(scan) => scan,
            None => {
                let mut scan = TitleScan {
                    start: from,
                    end: bytes.len(),
                    close: None,
                    escaped: None,
                };
                let mut index = from;
                while index < bytes.len() {
                    if bytes[index] == b'\\' && bytes.get(index + 1) == Some(&delimiter) {
                        if let Some(close) = self.close_at(index + 2) {
                            scan.escaped = Some((index + 1, close));
                        }
                        index += 2;
                    } else if bytes[index] == delimiter {
                        scan.end = index;
                        scan.close = self.close_at(index + 1);
                        break;
                    } else {
                        index += 1;
                    }
                }
                read_steps(index - from + 1);
                self.titles[key] = Some(scan);
                scan
            }
        };
        scan.close.or(scan
            .escaped
            .filter(|(escaped, _)| *escaped > from)
            .map(|(_, close)| close))
    }

    /// After a destination: the end of the title and `)`, or of `)` alone.
    fn tail(&mut self, end: usize, stream: usize) -> Option<usize> {
        let spaced = self.tab_end(end);
        let at = if self.text.as_bytes().get(spaced) == Some(&b'\n') {
            Some(self.tab_end(spaced + 1))
        } else {
            (spaced > end).then_some(spaced)
        };
        match at.and_then(|at| self.title(at, stream)) {
            Some(close) => Some(close),
            None => self.close_at(end),
        }
    }

    /// The bare run from a candidate's destination start, read once for
    /// every candidate in it.
    fn bare_run(&mut self, solid: usize) -> &BareRun {
        let run = match self.run.take() {
            Some(run) if run.start <= solid && solid <= run.stop => run,
            _ => {
                let bytes = self.text.as_bytes();
                let (mut close, mut previous_close) = (None, None);
                let mut stop = solid;
                while stop < bytes.len() && !matches!(bytes[stop], b' ' | 0..=0x1f) {
                    if bytes[stop] == b')' {
                        previous_close = close;
                        close = Some(stop);
                    }
                    stop += 1;
                }
                read_steps(stop - solid + 1);
                BareRun {
                    start: solid,
                    stop,
                    close,
                    previous_close,
                    tail: None,
                    shapes: Vec::new(),
                    walk: None,
                }
            }
        };
        self.run.insert(run)
    }

    /// One walk over a run: each candidate's first unmatched `)`, skipping a
    /// backslash and the character after it, by a stack of the candidates
    /// still open.
    fn walk(&self, run: &BareRun) -> ParenthesisWalk {
        let bytes = self.text.as_bytes();
        let position = |index: usize| index as u32;
        let mut candidates = vec![(position(run.start), u32::MAX, 0i32)];
        let mut open = vec![0u32];
        let close = run.close.unwrap_or(usize::MAX);
        let (mut depth, mut close_depth) = (0i32, 0i32);
        let mut index = run.start;
        while index < run.stop {
            let step = if bytes[index] == b'\\' { 2 } else { 1 };
            if index <= close && close < index + step {
                close_depth = depth;
            }
            match bytes[index] {
                b'(' => {
                    depth += 1;
                    if index >= 2 && &bytes[index - 2..index] == b"[]" {
                        let solid = self.solid(index + 1);
                        if solid < run.stop {
                            candidates.push((position(solid), u32::MAX, depth));
                            open.push(position(candidates.len() - 1));
                        }
                    }
                }
                b')' => {
                    depth -= 1;
                    while let Some(&at) = open.last() {
                        let candidate = &mut candidates[at as usize];
                        if candidate.2 <= depth {
                            break;
                        }
                        candidate.1 = position(index);
                        open.pop();
                    }
                }
                _ => {}
            }
            index += step;
        }
        read_steps(run.stop - run.start + 1);
        ParenthesisWalk {
            candidates,
            stop_depth: depth,
            close_depth,
            next: 0,
        }
    }

    /// marked's checks on the destination from `from` to `to`: in angles it
    /// ends with an unescaped `>`, and with unbalanced parentheses the link
    /// ends at the first unmatched `)`. marked keeps the link's first
    /// `4 + index` UTF-16 units, counted from `[](` even after leading
    /// whitespace, then trims it.
    fn checked(
        &mut self,
        link: usize,
        solid: usize,
        from: usize,
        to: usize,
        end: usize,
    ) -> Option<usize> {
        if to <= solid {
            return Some(end);
        }
        let text = self.text;
        let bytes = text.as_bytes();
        let known = self.run.as_ref().and_then(|run| {
            run.shapes
                .iter()
                .find(|(at, _)| *at == to)
                .map(|(_, shape)| *shape)
        });
        let (stop, slashes) = match known {
            Some(shape) => shape,
            None => {
                let stop = self.trim_end(to);
                let slashes = bytes[..stop - 1]
                    .iter()
                    .rev()
                    .take_while(|byte| **byte == b'\\')
                    .count();
                read_steps(slashes + 1);
                if let Some(run) = self
                    .run
                    .as_mut()
                    .filter(|run| to == run.stop || Some(to) == run.close)
                {
                    run.shapes.push((to, (stop, slashes)));
                }
                (stop, slashes)
            }
        };
        if bytes[solid] == b'<' {
            let backslashes = slashes.min(stop - 1 - solid);
            return (bytes[stop - 1] == b'>' && backslashes % 2 == 0).then_some(end);
        }
        // A bare destination ends at its run's stop or last `)`.
        let run = self.run.as_ref()?;
        let close = if to == run.stop {
            run.close
        } else {
            run.previous_close
        };
        if close.is_none_or(|close| close < from) {
            return Some(end);
        }
        if run.walk.is_none() {
            let walk = self.walk(run);
            self.run.as_mut()?.walk = Some(walk);
        }
        let run = self.run.as_mut()?;
        let at_stop = to == run.stop;
        let walk = run.walk.as_mut()?;
        while walk
            .candidates
            .get(walk.next)
            .is_some_and(|candidate| (candidate.0 as usize) < solid)
        {
            walk.next += 1;
        }
        let (_, lower, depth) = *walk.candidates.get(walk.next)?;
        let end_depth = if at_stop {
            walk.stop_depth
        } else {
            walk.close_depth
        };
        let lower = lower as usize;
        if lower < to {
            let units = 4 + text[from..lower].encode_utf16().count();
            let mut kept = link;
            let mut counted = 0;
            for character in text[link..].chars() {
                counted += character.len_utf16();
                if counted > units {
                    break;
                }
                kept += character.len_utf8();
            }
            read_steps(lower - from + kept - link);
            return Some(self.trim_end(kept));
        }
        (end_depth <= depth).then_some(end)
    }

    /// The end of the link with no text at `link`, a `[](`.
    fn read(&mut self, link: usize) -> Option<usize> {
        let text = self.text;
        let bytes = text.as_bytes();
        let after = link + 3;
        let solid = self.solid(after);
        // Carried back from the position after each whitespace one: where its
        // bare destination stops and what follows, where spaces and tabs end,
        // and where they end after the nearest newline.
        let (mut stop, mut tailed) = (solid, None);
        let mut tabs = solid;
        let mut newline = None;
        let starts = std::iter::once(solid).chain(
            text[after..solid]
                .char_indices()
                .rev()
                .map(|(at, _)| after + at),
        );
        for from in starts {
            read_steps(1);
            if from == solid {
                if bytes.get(from) == Some(&b'<') {
                    let close = self.angled(from + 1);
                    if close > from + 1 && bytes.get(close) == Some(&b'>') {
                        if let Some(end) = self.tail(close + 1, 2) {
                            return self.checked(link, solid, from, close + 1, end);
                        }
                    }
                }
                let (run_stop, run_tail) = {
                    let run = self.bare_run(solid);
                    (run.stop, run.tail)
                };
                stop = run_stop;
                tailed = match run_tail {
                    Some(tail) => tail,
                    None => {
                        let tail = self.tail(stop, 0);
                        if let Some(run) = self.run.as_mut() {
                            run.tail = Some(tail);
                        }
                        tail
                    }
                };
            } else {
                let following = tabs;
                if !matches!(bytes[from], b' ' | b'\t') {
                    tabs = from;
                }
                if bytes[from] == b'\n' {
                    newline = Some(following);
                }
                if matches!(bytes[from], b' ' | 0..=0x1f) {
                    stop = from;
                    let at = if bytes.get(tabs) == Some(&b'\n') {
                        newline
                    } else {
                        (tabs > from).then_some(tabs)
                    };
                    tailed = match at.and_then(|at| self.title(at, 1)) {
                        Some(close) => Some(close),
                        None => (bytes.get(solid) == Some(&b')')).then_some(solid + 1),
                    };
                }
            }
            if let Some(end) = tailed {
                return self.checked(link, solid, from, stop, end);
            }
            // A shorter bare destination can end where `\s*\)` succeeds.
            // Whitespace that reaches a `)` would already have closed the link
            // at the stop, so that is the run's last `)`.
            let close = if stop >= solid {
                self.run.as_ref().and_then(|run| run.close)
            } else {
                None
            };
            if let Some(close) = close.filter(|close| *close >= from) {
                return self.checked(link, solid, from, close, close + 1);
            }
        }
        None
    }
}

/// Where a `"…"`, `'…'`, or `(…)` definition title at `at` can end, in the
/// order the pattern `open(?:\\close?|[^close\\])*close` tries them.
fn quoted_title_ends(text: &str, at: usize) -> Vec<usize> {
    let close = match text[at..].chars().next() {
        Some('"') => '"',
        Some('\'') => '\'',
        Some('(') => ')',
        _ => return Vec::new(),
    };
    let mut escaped = Vec::new();
    let mut last = None;
    let mut index = at + 1;
    while let Some(character) = text[index..].chars().next() {
        if character == '\\' {
            if text[index + 1..].starts_with(close) {
                escaped.push(index + 2);
                index += 2;
            } else {
                index += 1;
            }
        } else if character == close {
            last = Some(index + 1);
            break;
        } else {
            index += character.len_utf8();
        }
    }
    last.into_iter().chain(escaped.into_iter().rev()).collect()
}

/// The byte length of the link reference definition that `text` starts with,
/// as marked's block `def` rule reads it.
fn definition_len(text: &str) -> Option<usize> {
    let indent = text
        .bytes()
        .take(4)
        .take_while(|byte| *byte == b' ')
        .count();
    if indent > 3 {
        return None;
    }
    let label = text[indent..].strip_prefix('[')?;
    // `(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+` and `\]:`.
    if split_leading_js_whitespace(label).1.starts_with(']') {
        return None;
    }
    let mut at = 0;
    loop {
        match label[at..].chars().next()? {
            '\\' => at += 1 + label[at + 1..].chars().next()?.len_utf8(),
            '[' => return None,
            ']' => break,
            character => at += character.len_utf8(),
        }
    }
    let mut at = indent + 1 + at;
    if !text[at..].starts_with("]:") {
        return None;
    }
    at += 2;
    at += text[at..].len() - text[at..].trim_start_matches(' ').len();
    if text[at..].starts_with('\n') {
        at += 1;
        at += text[at..].len() - text[at..].trim_start_matches([' ', '\t']).len();
    }
    // `[^<\s][^\s]*`, longest first, or `<.*?>`, shortest first, each end
    // tried as it is reached.
    if let Some(inner) = text[at..].strip_prefix('<') {
        return inner
            .char_indices()
            .take_while(|(_, character)| {
                !matches!(character, '\n' | '\r' | '\u{2028}' | '\u{2029}')
            })
            .filter(|(_, character)| *character == '>')
            .find_map(|(index, _)| definition_tail(text, at + 1 + index + 1));
    }
    let first = text[at..]
        .chars()
        .next()
        .filter(|c| !is_js_whitespace(*c))?;
    let start = at + first.len_utf8();
    let end = text[start..]
        .char_indices()
        .find(|(_, character)| is_js_whitespace(*character))
        .map_or(text.len(), |(index, _)| start + index);
    text[start..end]
        .char_indices()
        .map(|(index, _)| start + index)
        .chain([end])
        .rev()
        .find_map(|end| definition_tail(text, end))
}

/// The end of a definition's optional title and line end after its
/// destination.
fn definition_tail(text: &str, destination_end: usize) -> Option<usize> {
    // ` *(?:\n+|$)`.
    let line_end = |at: usize| {
        let after = at + text[at..].len() - text[at..].trim_start_matches(' ').len();
        let newlines = text[after..].len() - text[after..].trim_start_matches('\n').len();
        (newlines > 0 || after == text.len()).then_some(after + newlines)
    };
    // `(?: +(?:\n[ \t]*)?| *\n[ \t]*)` before the title.
    let spaced = destination_end + text[destination_end..].len()
        - text[destination_end..].trim_start_matches(' ').len();
    let title = if text[spaced..].starts_with('\n') {
        let after = spaced + 1;
        Some(after + text[after..].len() - text[after..].trim_start_matches([' ', '\t']).len())
    } else {
        (spaced > destination_end).then_some(spaced)
    };
    let title_ends = match title.and_then(|at| text[at..].chars().next().map(|c| (at, c))) {
        Some((at, '"')) => quoted_title_ends(text, at),
        // `'[^'\n]*(?:\n[^'\n]+)*\n?'`, which can end only one way.
        Some((at, '\'')) => {
            let line =
                |from: usize| from + text[from..].find(['\'', '\n']).unwrap_or(text.len() - from);
            let mut index = line(at + 1);
            while text[index..].starts_with('\n')
                && !text[index + 1..].starts_with(['\'', '\n'])
                && index + 1 < text.len()
            {
                index = line(index + 1);
            }
            if text[index..].starts_with('\n') {
                index += 1;
            }
            text[index..]
                .starts_with('\'')
                .then_some(index + 1)
                .into_iter()
                .collect()
        }
        // `\([^()]*\)`.
        Some((at, '(')) => text[at + 1..]
            .find(['(', ')'])
            .filter(|index| text[at + 1 + index..].starts_with(')'))
            .map(|index| at + 1 + index + 1)
            .into_iter()
            .collect(),
        _ => Vec::new(),
    };
    title_ends
        .into_iter()
        .find_map(line_end)
        .or_else(|| line_end(destination_end))
}

/// The text the importer keeps for a definition: its lines without leading
/// whitespace, and without trailing whitespace.
fn definition_text(raw: &str) -> String {
    trim_js_end(raw)
        .split('\n')
        .map(|line| split_leading_js_whitespace(line).1)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Whether a paragraph's plain text is the one definition marked reads in
/// it, as the importer keeps a definition. It is written as one tag span, or
/// in a table cell with its `[` as `&#91;`; see [`escape_markdown_block_syntax`].
fn definition_paragraph(text: &str) -> bool {
    definition_len(text).is_some_and(|len| definition_text(&text[..len]) == text)
}

/// Whether a link with no text holds a line that would end the paragraph it
/// is in, written as it is: after at most three spaces, a character that can
/// open a block or a table's delimiter row, `1.` or `1)`, or nothing but
/// spaces. A `\r` counts too: marked reads it as a newline, and the `&#13;`
/// that keeps it one would stay a reference in a link written as it is. It
/// errs toward yes, since such a link is written as references, which read
/// back the same. A highlighted link's `=` is written as `\=`, which opens no
/// block. The importer's `opensBlock` decides the same way, after its
/// highlight escape.
fn opens_block(link: &str, highlighted: bool) -> bool {
    link.contains('\r')
        || link.match_indices('\n').any(|(at, _)| {
            let line = link[at + 1..].split('\n').next().unwrap_or_default();
            let rest = line.trim_start_matches(' ');
            rest.is_empty()
                || (line.len() - rest.len() <= 3
                    && (rest
                        .starts_with(['#', '$', '>', '*', '+', '-', '_', '`', '~', '<', '|', ':'])
                        || (!highlighted && rest.starts_with('='))
                        || rest.starts_with("1.")
                        || rest.starts_with("1)")))
        })
}

/// `text[from..to]`, part of a link with no text, written as references as
/// the importer's `writtenDefinition` writes them: each ASCII punctuation
/// character but `!`, `/`, and `?` as a decimal reference, `&`, `<`, and `>`
/// as entities, `\r` and NBSP as references, a space that ends a line and a
/// newline that ends an empty one as references too. A highlight's `=` stays
/// `\=`, which the highlight reads. The importer reads exactly these bytes
/// back as the link's text.
fn written_as_references(
    text: &str,
    from: usize,
    to: usize,
    highlighted: bool,
) -> ProjectionResult<String> {
    let mut written =
        ProjectionBuffer::with_capacity(written_as_references_len(text, from, to, highlighted))?;
    for piece in written_references(text, from, to, highlighted) {
        match piece {
            Written::Text(value) => written.push_str(value)?,
            Written::Reference(code) => {
                written.push_str("&#")?;
                let mut digits = [0u8; 10];
                let mut at = digits.len();
                let mut value = code;
                loop {
                    at -= 1;
                    digits[at] = b'0' + (value % 10) as u8;
                    value /= 10;
                    if value == 0 {
                        break;
                    }
                }
                written.push_str(std::str::from_utf8(&digits[at..]).unwrap_or_default())?;
                written.push(';')?;
            }
            Written::Character(character) => written.push(character)?,
        }
    }
    Ok(written.into_string())
}

fn written_as_references_len(text: &str, from: usize, to: usize, highlighted: bool) -> usize {
    written_references(text, from, to, highlighted)
        .map(|piece| match piece {
            Written::Text(value) => value.len(),
            Written::Reference(code) => code.checked_ilog10().unwrap_or(0) as usize + 4,
            Written::Character(character) => character.len_utf8(),
        })
        .sum()
}

/// What `written_as_references` writes for one character.
enum Written {
    Text(&'static str),
    Reference(u32),
    Character(char),
}

fn written_references(
    text: &str,
    from: usize,
    to: usize,
    highlighted: bool,
) -> impl Iterator<Item = Written> + '_ {
    text[from..to]
        .char_indices()
        .map(move |(index, character)| {
            let at = from + index;
            let next = text[at + character.len_utf8()..].chars().next();
            let previous = text[..at].chars().next_back();
            match character {
                '=' if highlighted => Written::Text("\\="),
                '&' => Written::Text("&amp;"),
                '<' => Written::Text("&lt;"),
                '>' => Written::Text("&gt;"),
                ' ' if next == Some('\n') => Written::Reference(32),
                '\n' if previous == Some('\n') => Written::Reference(10),
                '\r' | '\u{a0}' => Written::Reference(u32::from(character)),
                _ if character.is_ascii_punctuation() && !matches!(character, '!' | '/' | '?') => {
                    Written::Reference(u32::from(character))
                }
                _ => Written::Character(character),
            }
        })
}

/// Where `text` holds a link with no text, as byte ranges.
fn empty_link_ranges(text: &str) -> Vec<(usize, usize)> {
    let Some(first) = text.find("[](") else {
        return Vec::new();
    };
    let mut links = EmptyLinks::new(text);
    let mut ranges = Vec::new();
    let mut at = first;
    loop {
        let next = match links.read(at) {
            Some(end) => {
                ranges.push((at, end));
                end
            }
            None => at + 1,
        };
        match text[next..].find("[](") {
            Some(index) => at = next + index,
            None => return ranges,
        }
    }
}

fn render_nodes(
    nodes: &[MarkdownNode],
    parent_tag: &str,
    parent_attrs: &BTreeMap<String, Value>,
    separator: &str,
    table_cell: bool,
) -> ProjectionResult<String> {
    let mut output = ProjectionBuffer::new();
    for (index, node) in nodes.iter().enumerate() {
        if index != 0 {
            output.push_str(separator)?;
        }
        let rendered = render_node(
            node,
            RenderContext {
                parent_tag,
                parent_attrs,
                previous: index.checked_sub(1).map(|previous| &nodes[previous]),
                index,
                table_cell,
            },
        )?;
        output.push_str(&rendered)?;
    }
    Ok(output.into_string())
}

fn render_node(node: &MarkdownNode, context: RenderContext<'_>) -> ProjectionResult<String> {
    let table_cell = context.table_cell;
    match node {
        MarkdownNode::Text(_) => {
            render_inline(std::slice::from_ref(node), false, false, table_cell)
        }
        MarkdownNode::Fragment(children) => render_nodes(
            children,
            context.parent_tag,
            context.parent_attrs,
            "",
            table_cell,
        ),
        MarkdownNode::Element {
            tag,
            attrs,
            children,
        } => match tag.as_str() {
            "doc" => render_nodes(children, tag, attrs, "\n\n", table_cell),
            "paragraph" => {
                if children.is_empty() {
                    if context.previous.is_some_and(is_empty_paragraph) {
                        Ok("&nbsp;".to_string())
                    } else {
                        Ok(String::new())
                    }
                } else {
                    let rendered = render_inline(children, false, true, table_cell)?;
                    // The TypeScript writer escapes a leading space of text,
                    // not a hard break's two spaces.
                    // A sealed piece is written exactly, as the TypeScript writer does.
                    if matches!(context.parent_tag, "doc" | "listItem" | "taskItem")
                        && rendered.starts_with(' ')
                        && !matches!(
                            children.first(),
                            Some(MarkdownNode::Element { tag, .. }) if tag == "hardBreak" || tag == "rawInline"
                        )
                    {
                        let mut output = ProjectionBuffer::new();
                        output.push_str("&#32;")?;
                        output.push_str(&rendered[1..])?;
                        Ok(output.into_string())
                    } else {
                        Ok(rendered)
                    }
                }
            }
            "heading" => {
                if children.is_empty() {
                    Ok(String::new())
                } else {
                    // StarterKit's heading schema supports levels 1 through 6.
                    // Remote Y.Doc updates bypass that schema, so clamp hostile
                    // values before allocating. The TS serializer repeats raw
                    // out-of-range positive levels and can itself fail; level
                    // six is the closest safe schema-valid projection.
                    let level = attr_i64(attrs, "level").unwrap_or(1).clamp(1, 6) as usize;
                    let inline = render_inline(children, false, false, table_cell)?;
                    let mut output = ProjectionBuffer::with_capacity(level + 1 + inline.len())?;
                    output.push_repeat('#', level)?;
                    output.push(' ')?;
                    output.push_str(&inline)?;
                    Ok(output.into_string())
                }
            }
            "blockquote" => render_prefixed_blocks(children, tag, attrs, ">", None, table_cell),
            "bulletList" | "orderedList" | "taskList" => {
                // A loose list keeps a blank line between its items.
                let separator = if attr_bool(attrs, "loose") == Some(true) {
                    "\n\n"
                } else {
                    "\n"
                };
                render_nodes(children, tag, attrs, separator, table_cell)
            }
            "listItem" => render_list_item(children, &context, None),
            "taskItem" => {
                let checked = attr_bool(attrs, "checked").unwrap_or(false);
                let prefix = if checked { "- [x] " } else { "- [ ] " };
                render_list_item(children, &context, Some(prefix))
            }
            "codeBlock" => render_code_block(attrs, children),
            "horizontalRule" => Ok(if context.parent_tag == "doc" && context.index == 0 {
                "***"
            } else {
                "---"
            }
            .to_string()),
            "hardBreak" => Ok("  \n".to_string()),
            "image" => render_image(attrs),
            "escapedPunctuation" => ensure_projection_string(format!(
                "\\{}",
                escape_markdown_line_breaks(&attr_js_string(attrs, "value"))
            )),
            "wikilink" => render_wikilink(attrs),
            "inlineAtom" => render_inline_atom(attrs),
            "callout" => render_callout(attrs, children, table_cell),
            "mathInline" => ensure_projection_string(format!("${}$", attr_js_string(attrs, "tex"))),
            "mathBlock" => {
                ensure_projection_string(format!("$${}$$", attr_js_string(attrs, "tex")))
            }
            // Sealed pieces: the source the file holds, written back exactly.
            "rawBlock" | "rawInline" => ensure_projection_string(attr_js_string(attrs, "source")),
            "table" => render_table(children),
            "tableRow" | "tableCell" | "tableHeader" => {
                render_nodes(children, tag, attrs, "", table_cell)
            }
            _ if context.parent_tag == "paragraph" => {
                render_inline(children, false, true, table_cell)
            }
            _ => render_nodes(children, tag, attrs, "", table_cell),
        },
    }
}

fn is_empty_paragraph(node: &MarkdownNode) -> bool {
    matches!(
        node,
        MarkdownNode::Element { tag, children, .. }
            if tag == "paragraph" && children.is_empty()
    )
}

fn render_prefixed_blocks(
    children: &[MarkdownNode],
    parent_tag: &str,
    parent_attrs: &BTreeMap<String, Value>,
    prefix: &str,
    header: Option<&str>,
    table_cell: bool,
) -> ProjectionResult<String> {
    let separator = format!("\n{prefix}\n");
    let mut body = ProjectionBuffer::new();
    for (index, child) in children.iter().enumerate() {
        let rendered = render_node(
            child,
            RenderContext {
                parent_tag,
                parent_attrs,
                previous: index.checked_sub(1).map(|previous| &children[previous]),
                index,
                table_cell,
            },
        )?;
        if index != 0 {
            body.push_str(&separator)?;
        }
        body.push_str(&prefix_lines(&rendered, prefix)?)?;
    }
    let body = body.into_string();
    match header {
        Some(header) if body.is_empty() => {
            let mut output = ProjectionBuffer::new();
            output.push_str(prefix)?;
            output.push(' ')?;
            output.push_str(header)?;
            Ok(output.into_string())
        }
        Some(header) => {
            let mut output = ProjectionBuffer::new();
            output.push_str(prefix)?;
            output.push(' ')?;
            output.push_str(header)?;
            output.push('\n')?;
            output.push_str(&body)?;
            Ok(output.into_string())
        }
        None => Ok(body),
    }
}

fn prefix_lines(block: &str, prefix: &str) -> ProjectionResult<String> {
    let mut output = ProjectionBuffer::new();
    for (index, line) in block.split('\n').enumerate() {
        if index != 0 {
            output.push('\n')?;
        }
        output.push_str(prefix)?;
        if !trim_js(line).is_empty() {
            output.push(' ')?;
            output.push_str(line)?;
        }
    }
    Ok(output.into_string())
}

fn render_list_item(
    children: &[MarkdownNode],
    context: &RenderContext<'_>,
    task_prefix: Option<&str>,
) -> ProjectionResult<String> {
    let Some((first, nested)) = children.split_first() else {
        return Ok(String::new());
    };
    let ordered_prefix =
        (task_prefix.is_none() && context.parent_tag == "orderedList").then(|| {
            let start = attr_i64(context.parent_attrs, "start").unwrap_or(1);
            let ordinal = start
                .saturating_add(i64::try_from(context.index).unwrap_or(i64::MAX))
                .min(999_999_999);
            format!("{ordinal}. ")
        });
    let prefix = task_prefix.or(ordered_prefix.as_deref()).unwrap_or("- ");
    let first_rendered = render_node(
        first,
        RenderContext {
            parent_tag: "listItem",
            parent_attrs: &BTreeMap::new(),
            previous: None,
            index: 0,
            table_cell: context.table_cell,
        },
    )?;
    let mut output =
        ProjectionBuffer::with_capacity(prefix.len().saturating_add(first_rendered.len()))?;
    output.push_str(prefix)?;
    if !first_rendered.trim_matches([' ', '\t']).is_empty() {
        for (index, line) in first_rendered.split('\n').enumerate() {
            if index != 0 {
                output.push('\n')?;
                output.push_repeat(
                    ' ',
                    if task_prefix.is_some() {
                        2
                    } else {
                        prefix.len()
                    },
                )?;
            }
            output.push_str(line)?;
        }
    }
    let empty_marker = task_prefix.is_none() && first_rendered.trim_matches([' ', '\t']).is_empty();
    for (index, child) in nested.iter().enumerate() {
        let child_rendered = render_node(
            child,
            RenderContext {
                parent_tag: "listItem",
                parent_attrs: &BTreeMap::new(),
                previous: if index == 0 {
                    Some(first)
                } else {
                    Some(&nested[index - 1])
                },
                index: index + 1,
                table_cell: context.table_cell,
            },
        )?;
        // One line break, as the TypeScript writer strips; a sealed block
        // keeps blank lines of its own.
        let child_rendered = if index == 0 && empty_marker {
            child_rendered.strip_prefix('\n').unwrap_or(&child_rendered)
        } else {
            &child_rendered
        };
        let mut indented = ProjectionBuffer::new();
        for (line_index, line) in child_rendered.split('\n').enumerate() {
            if line_index != 0 {
                indented.push('\n')?;
            }
            indented.push_repeat(
                ' ',
                if task_prefix.is_some() {
                    2
                } else {
                    prefix.len()
                },
            )?;
            indented.push_str(line)?;
        }
        let first_line = child_rendered.split('\n').next().unwrap_or_default();
        let previous = index.checked_sub(1).map_or(first, |i| &nested[i]);
        let list_interrupts = match element_tag(child) {
            Some("orderedList") => first_line
                .strip_prefix("1. ")
                .is_some_and(|text| !text.trim_end_matches([' ', '\t']).is_empty()),
            Some("bulletList") => first_line.trim_end_matches([' ', '\t']) != "-",
            _ => true,
        };
        if index == 0 && empty_marker {
            output.push('\n')?;
        } else if attr_bool(context.parent_attrs, "loose") == Some(true)
            || matches!(
                element_tag(child),
                Some("paragraph" | "horizontalRule" | "mathBlock" | "rawBlock" | "table")
            )
            || (matches!(
                element_tag(previous),
                Some("paragraph" | "mathBlock" | "rawBlock" | "table" | "blockquote" | "callout")
            ) && !list_interrupts)
            || (matches!(element_tag(previous), Some("blockquote" | "callout"))
                && matches!(element_tag(child), Some("blockquote" | "callout")))
            || (element_tag(previous) == element_tag(child)
                && matches!(
                    element_tag(child),
                    Some("bulletList" | "orderedList" | "taskList")
                ))
        {
            output.push_str("\n\n")?;
        } else {
            output.push('\n')?;
        }
        output.push_str(&indented.into_string())?;
    }
    Ok(output.into_string())
}

fn render_code_block(
    attrs: &BTreeMap<String, Value>,
    children: &[MarkdownNode],
) -> ProjectionResult<String> {
    let language = attr_js_string(attrs, "language");
    let content = markdown_text_content(children)?;
    let delimiter = if language.contains('`') { '~' } else { '`' };
    let fence = delimiter_fence(&content, 3, delimiter)?;
    let mut output = ProjectionBuffer::new();
    output.push_str(&fence)?;
    if language.starts_with(delimiter) {
        output.push(' ')?;
    }
    output.push_str(&language)?;
    if children.is_empty() {
        output.push_str("\n\n")?;
        output.push_str(&fence)?;
    } else {
        output.push('\n')?;
        output.push_str(&content)?;
        output.push('\n')?;
        output.push_str(&fence)?;
    }
    Ok(output.into_string())
}

fn markdown_text_content(nodes: &[MarkdownNode]) -> ProjectionResult<String> {
    fn append(nodes: &[MarkdownNode], output: &mut ProjectionBuffer) -> ProjectionResult<()> {
        for node in nodes {
            match node {
                MarkdownNode::Text(runs) => {
                    for run in runs {
                        output.push_str(&run.text)?;
                    }
                }
                MarkdownNode::Element { children, .. } | MarkdownNode::Fragment(children) => {
                    append(children, output)?;
                }
            }
        }
        Ok(())
    }

    let mut output = ProjectionBuffer::new();
    append(nodes, &mut output)?;
    Ok(output.into_string())
}

fn backtick_fence(value: &str, minimum: usize) -> ProjectionResult<String> {
    delimiter_fence(value, minimum, '`')
}

fn delimiter_fence(value: &str, minimum: usize, delimiter: char) -> ProjectionResult<String> {
    let mut longest = 0usize;
    let mut current = 0usize;
    for character in value.chars() {
        if character == delimiter {
            current = current.saturating_add(1);
            longest = longest.max(current);
        } else {
            current = 0;
        }
    }
    let length = minimum.max(longest.saturating_add(1));
    let mut fence = ProjectionBuffer::with_capacity(length)?;
    fence.push_repeat(delimiter, length)?;
    Ok(fence.into_string())
}

fn render_inline_code(value: &str) -> ProjectionResult<String> {
    let fence = backtick_fence(value, 1)?;
    let has_edge_backtick = value.starts_with('`') || value.ends_with('`');
    let has_edge_space = value.starts_with(' ') || value.ends_with(' ');
    let only_spaces = value.chars().all(|character| character == ' ');
    let padding = has_edge_backtick || (has_edge_space && !only_spaces);
    let padding_bytes = usize::from(padding) * 2;
    let capacity = fence
        .len()
        .checked_mul(2)
        .and_then(|length| length.checked_add(value.len()))
        .and_then(|length| length.checked_add(padding_bytes))
        .ok_or_else(|| projection_too_large(usize::MAX))?;
    let mut output = ProjectionBuffer::with_capacity(capacity)?;
    output.push_str(&fence)?;
    if padding {
        output.push(' ')?;
    }
    output.push_str(value)?;
    if padding {
        output.push(' ')?;
    }
    output.push_str(&fence)?;
    Ok(output.into_string())
}

fn render_image(attrs: &BTreeMap<String, Value>) -> ProjectionResult<String> {
    let alt = escape_markdown_line_breaks(
        &attr_js_string(attrs, "alt")
            .replace('\\', "\\\\")
            .replace('[', "\\[")
            .replace(']', "\\]"),
    );
    let sanitized = sanitize_image_src(&attr_js_string(attrs, "src"));
    let src = if sanitized.contains([' ', '\t']) {
        format!(
            "<{}>",
            escape_markdown_line_breaks(
                &sanitized
                    .replace('\\', "\\\\")
                    .replace('<', "\\<")
                    .replace('>', "\\>")
            )
        )
    } else {
        escape_markdown_line_breaks(
            &sanitized
                .replace('\\', "\\\\")
                .replace('(', "\\(")
                .replace(')', "\\)"),
        )
    };
    let title = attrs
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())
        .map(|title| {
            format!(
                " \"{}\"",
                escape_markdown_line_breaks(&title.replace('\\', "\\\\").replace('"', "\\\""))
            )
        })
        .unwrap_or_default();
    let mut output = ProjectionBuffer::new();
    output.push_str("![")?;
    output.push_str(&alt)?;
    output.push_str("](")?;
    output.push_str(&src)?;
    output.push_str(&title)?;
    output.push(')')?;
    Ok(output.into_string())
}

fn sanitize_image_src(src: &str) -> String {
    let trimmed = trim_js(src);
    if trimmed.is_empty() {
        return String::new();
    }
    let compact: String = trimmed
        .chars()
        .filter(|character| {
            !matches!(*character, '\0'..='\u{001f}' | '\u{007f}') && !is_js_whitespace(*character)
        })
        .collect();
    if let Some(protocol) = image_protocol(&compact) {
        if protocol != "http" && protocol != "https" {
            return String::new();
        }
        return trimmed.to_string();
    }
    let for_check = compact.replace('\\', "/");
    if for_check.starts_with('/') {
        return String::new();
    }
    if compact.contains('\\') && for_check.split('/').any(|segment| segment == "..") {
        return String::new();
    }
    trimmed.to_string()
}

fn image_protocol(src: &str) -> Option<String> {
    let mut chars = src.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    let mut protocol = String::from(first);
    for character in chars {
        if character == ':' {
            return Some(protocol.to_ascii_lowercase());
        }
        if !character.is_ascii_alphanumeric() && !matches!(character, '+' | '.' | '-') {
            return None;
        }
        protocol.push(character);
    }
    None
}

fn render_wikilink(attrs: &BTreeMap<String, Value>) -> ProjectionResult<String> {
    let target = escape_wikilink_part(&attr_js_string(attrs, "target"));
    let label = attr_js_string(attrs, "label");
    if label.is_empty() {
        ensure_projection_string(format!("[[{target}]]"))
    } else {
        ensure_projection_string(format!("[[{target}|{}]]", escape_wikilink_part(&label)))
    }
}

fn escape_wikilink_part(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace(']', "\\]")
        .replace('|', "\\|")
}

fn render_inline_atom(attrs: &BTreeMap<String, Value>) -> ProjectionResult<String> {
    let source = attr_js_string(attrs, "source");
    if source.is_empty() {
        ensure_projection_string(format!("{{{{atom:{}}}}}", attr_js_string(attrs, "atomId")))
    } else {
        ensure_projection_string(format!("{{{{{source}}}}}"))
    }
}

fn render_callout(
    attrs: &BTreeMap<String, Value>,
    children: &[MarkdownNode],
    table_cell: bool,
) -> ProjectionResult<String> {
    let callout_type = attrs
        .get("calloutType")
        .and_then(Value::as_str)
        .unwrap_or("note");
    let fold = match attrs.get("fold").and_then(Value::as_str) {
        Some("-") => "-",
        Some("+") => "+",
        _ => "",
    };
    let title = normalize_callout_title(&attr_js_string(attrs, "title"));
    let header = if title.is_empty() {
        format!("[!{callout_type}]{fold}")
    } else {
        format!("[!{callout_type}]{fold} {title}")
    };
    let mut blocks = ProjectionBuffer::new();
    let mut has_body = false;
    for (index, child) in children.iter().enumerate() {
        let rendered = render_node(
            child,
            RenderContext {
                parent_tag: "callout",
                parent_attrs: attrs,
                previous: index.checked_sub(1).map(|previous| &children[previous]),
                index,
                table_cell,
            },
        )?;
        has_body |= !trim_js(&rendered).is_empty();
        if index != 0 {
            blocks.push_str("\n>\n")?;
        }
        blocks.push_str(&prefix_lines(&rendered, ">")?)?;
    }
    if !has_body {
        let mut output = ProjectionBuffer::new();
        output.push_str("> ")?;
        output.push_str(&header)?;
        return Ok(output.into_string());
    }
    let mut output = ProjectionBuffer::new();
    output.push_str("> ")?;
    output.push_str(&header)?;
    output.push('\n')?;
    output.push_str(&blocks.into_string())?;
    Ok(output.into_string())
}

fn normalize_callout_title(value: &str) -> String {
    let mut normalized = String::new();
    let mut in_line_break = false;
    for character in value.chars() {
        if matches!(character, '\r' | '\n') {
            if !in_line_break {
                normalized.push(' ');
                in_line_break = true;
            }
        } else {
            normalized.push(character);
            in_line_break = false;
        }
    }
    trim_js(&normalized).to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TableAlign {
    Left,
    Right,
    Center,
}

struct TableCell {
    text: String,
    align: Option<TableAlign>,
}

const GFM_TABLE_CELL_BLOCK_SEPARATOR: &str = "<br>";

/// A resized row's height: a positive integer the TypeScript projector also
/// accepts (`Number.isSafeInteger`), so both projectors write the same bytes.
fn table_row_height(attrs: &BTreeMap<String, Value>) -> Option<i64> {
    attr_i64(attrs, "height").filter(|height| table_row_height_in_range(*height))
}

fn table_row_height_in_range(height: i64) -> bool {
    const MAX_SAFE_INTEGER: i64 = (1_i64 << 53) - 1;
    (1..=MAX_SAFE_INTEGER).contains(&height)
}

/// A resized row keeps its height in an HTML comment on the line above its
/// table: `<!-- dohc:table row-heights=1:84,2:120 -->`. Row indexes count from
/// the header row. GFM has no row-height syntax, Markdown renderers hide the
/// comment, and the TypeScript projector writes and parses the same bytes, so
/// a local close that prunes the Y.Doc and reseeds from the file keeps the
/// height.
fn render_table_row_heights(row_heights: &[(usize, i64)]) -> ProjectionResult<String> {
    let mut output = ProjectionBuffer::new();
    if row_heights.is_empty() {
        return Ok(output.into_string());
    }
    output.push_str("<!-- dohc:table row-heights=")?;
    for (position, (row, height)) in row_heights.iter().enumerate() {
        if position != 0 {
            output.push(',')?;
        }
        output.push_str(&format!("{row}:{height}"))?;
    }
    output.push_str(" -->")?;
    Ok(output.into_string())
}

fn render_table(children: &[MarkdownNode]) -> ProjectionResult<String> {
    let mut rows = Vec::new();
    let mut row_heights = Vec::new();
    let mut cell_text_bytes = 0usize;
    for row in children {
        let MarkdownNode::Element {
            tag,
            attrs,
            children: cells,
        } = row
        else {
            continue;
        };
        if tag != "tableRow" {
            continue;
        }
        if let Some(height) = table_row_height(attrs) {
            row_heights.push((rows.len(), height));
        }
        let mut rendered_cells = Vec::new();
        for cell in cells {
            let MarkdownNode::Element {
                tag,
                attrs,
                children,
            } = cell
            else {
                continue;
            };
            if tag != "tableCell" && tag != "tableHeader" {
                continue;
            }
            let mut raw = ProjectionBuffer::new();
            for (index, child) in children.iter().enumerate() {
                if index != 0 {
                    raw.push_str(GFM_TABLE_CELL_BLOCK_SEPARATOR)?;
                }
                let rendered = render_table_cell_block(child, tag, attrs, children, index)?;
                raw.push_str(&rendered)?;
            }
            let text = collapse_js_whitespace(&table_cell_line_breaks(
                &prepare_rendered_table_cell(&raw.into_string())?,
            ))?;
            cell_text_bytes = checked_projection_len(cell_text_bytes, text.len())?;
            rendered_cells.push(TableCell {
                text,
                align: match attrs.get("align").and_then(Value::as_str) {
                    Some("left") => Some(TableAlign::Left),
                    Some("right") => Some(TableAlign::Right),
                    Some("center") => Some(TableAlign::Center),
                    _ => None,
                },
            });
        }
        rows.push(rendered_cells);
    }
    let column_count = rows.iter().map(Vec::len).max().unwrap_or(0);
    if column_count == 0 {
        return Ok(String::new());
    }
    let allocation_bytes = column_count
        .checked_mul(std::mem::size_of::<usize>() + std::mem::size_of::<Option<TableAlign>>())
        .ok_or_else(|| projection_too_large(usize::MAX))?;
    if allocation_bytes > MAX_PROJECTION_BYTES {
        return Err(projection_too_large(allocation_bytes));
    }
    let mut widths = vec![3usize; column_count];
    for row in &rows {
        for (index, cell) in row.iter().enumerate() {
            widths[index] = widths[index].max(utf16_len(&cell.text));
        }
    }
    let header_row = &rows[0];
    let mut alignments = vec![None; column_count];
    for row in &rows {
        for (index, cell) in row.iter().enumerate() {
            if alignments[index].is_none() {
                alignments[index] = cell.align;
            }
        }
    }
    let mut output = ProjectionBuffer::new();
    if !row_heights.is_empty() {
        output.push_str(&render_table_row_heights(&row_heights)?)?;
        output.push('\n')?;
    }
    output.push_str("| ")?;
    for (index, width) in widths.iter().enumerate() {
        if index != 0 {
            output.push_str(" | ")?;
        }
        let value = header_row
            .get(index)
            .map(|cell| cell.text.as_str())
            .unwrap_or("");
        pad_utf16_into(&mut output, value, *width)?;
    }
    output.push_str(" |\n| ")?;
    for (index, width) in widths.iter().enumerate() {
        if index != 0 {
            output.push_str(" | ")?;
        }
        match alignments[index] {
            Some(TableAlign::Left) | Some(TableAlign::Center) => output.push(':')?,
            Some(TableAlign::Right) | None => {}
        }
        output.push_repeat('-', *width)?;
        match alignments[index] {
            Some(TableAlign::Right) | Some(TableAlign::Center) => output.push(':')?,
            Some(TableAlign::Left) | None => {}
        }
    }
    output.push_str(" |")?;
    for row in &rows[1..] {
        output.push_str("\n| ")?;
        for (index, width) in widths.iter().enumerate() {
            if index != 0 {
                output.push_str(" | ")?;
            }
            let value = row.get(index).map(|cell| cell.text.as_str()).unwrap_or("");
            pad_utf16_into(&mut output, value, *width)?;
        }
        output.push_str(" |")?;
    }
    Ok(output.into_string())
}

fn render_table_cell_block(
    child: &MarkdownNode,
    parent_tag: &str,
    parent_attrs: &BTreeMap<String, Value>,
    siblings: &[MarkdownNode],
    index: usize,
) -> ProjectionResult<String> {
    if let MarkdownNode::Element { tag, children, .. } = child {
        if tag == "codeBlock" {
            let content = markdown_text_content(children)?;
            let mut output = ProjectionBuffer::new();
            for (line_index, line) in content.split('\n').enumerate() {
                if line_index != 0 {
                    output.push_str(GFM_TABLE_CELL_BLOCK_SEPARATOR)?;
                }
                if !line.is_empty() {
                    output.push_str(&render_inline_code(line)?)?;
                }
            }
            return Ok(output.into_string());
        }
    }

    render_node(
        child,
        RenderContext {
            parent_tag,
            parent_attrs,
            previous: index.checked_sub(1).map(|previous| &siblings[previous]),
            index,
            table_cell: true,
        },
    )
}

fn prepare_rendered_table_cell(markdown: &str) -> ProjectionResult<String> {
    let normalized = markdown
        .replace("&amp;lt;br&amp;gt;", GFM_TABLE_CELL_BLOCK_SEPARATOR)
        .replace("&lt;br&gt;", GFM_TABLE_CELL_BLOCK_SEPARATOR);
    let mut output = ProjectionBuffer::new();
    let mut preceding_backslashes = 0usize;
    for character in normalized.chars() {
        if character == '|' && preceding_backslashes % 2 == 0 {
            output.push('\\')?;
        }
        output.push(character)?;
        preceding_backslashes = if character == '\\' {
            preceding_backslashes.saturating_add(1)
        } else {
            0
        };
    }
    Ok(output.into_string())
}

/// Tiptap's table renderer writes each line break in a cell, a hard break or a
/// block separator, as `<br>` without the spaces or tabs around it.
fn table_cell_line_breaks(markdown: &str) -> String {
    let lines = markdown.replace(GFM_TABLE_CELL_BLOCK_SEPARATOR, "\n");
    let mut output = String::with_capacity(markdown.len());
    let mut lines = lines.split('\n').peekable();
    let mut first = true;
    while let Some(mut line) = lines.next() {
        if !first {
            output.push_str(GFM_TABLE_CELL_BLOCK_SEPARATOR);
            line = line.trim_start_matches([' ', '\t']);
        }
        if lines.peek().is_some() {
            line = line.strip_suffix('\r').unwrap_or(line);
            line = line.trim_end_matches([' ', '\t']);
        }
        output.push_str(line);
        first = false;
    }
    output
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn pad_utf16_into(
    output: &mut ProjectionBuffer,
    value: &str,
    width: usize,
) -> ProjectionResult<()> {
    output.push_str(value)?;
    output.push_repeat(' ', width.saturating_sub(utf16_len(value)))
}

/// Collapses a cell's white space as Tiptap's table renderer does, except in
/// a code span, where white space is the code's content.
fn collapse_js_whitespace(value: &str) -> ProjectionResult<String> {
    let chars: Vec<char> = value.chars().collect();
    let run_at = |index: usize| chars[index..].iter().take_while(|c| **c == '`').count();
    // Where each length of backtick run starts, to find a span's end in one
    // pass. A backslash is literal inside code, so it doesn't stop an end.
    let mut ends: HashMap<usize, std::collections::VecDeque<usize>> = HashMap::new();
    let mut index = 0;
    while index < chars.len() {
        let run = run_at(index).max(1);
        if chars[index] == '`' {
            ends.entry(run).or_default().push_back(index);
        }
        index += run;
    }
    let mut collapsed = ProjectionBuffer::new();
    let mut in_whitespace = false;
    let mut backslashes = 0usize;
    let mut index = 0;
    while index < chars.len() {
        let character = chars[index];
        if character == '`' && backslashes % 2 == 0 {
            let run = run_at(index);
            let starts = ends.entry(run).or_default();
            while starts.front().is_some_and(|start| *start <= index) {
                starts.pop_front();
            }
            // A run with no end is literal backticks.
            let to = starts.front().map_or(index, |start| *start) + run;
            for character in &chars[index..to] {
                collapsed.push(*character)?;
            }
            (index, in_whitespace, backslashes) = (to, false, 0);
            continue;
        }
        backslashes = if character == '\\' {
            backslashes + 1
        } else {
            0
        };
        index += 1;
        if is_js_whitespace(character) {
            if !in_whitespace {
                collapsed.push(' ')?;
                in_whitespace = true;
            }
        } else {
            collapsed.push(character)?;
            in_whitespace = false;
        }
    }
    Ok(trim_js(&collapsed.into_string()).to_string())
}

fn render_inline(
    nodes: &[MarkdownNode],
    code_context: bool,
    escape_block_syntax: bool,
    table_cell: bool,
) -> ProjectionResult<String> {
    enum SourceInlinePart<'a> {
        Text(&'a TextRun),
        Node(&'a MarkdownNode),
    }

    enum InlinePart<'a> {
        Text {
            run: TextRun,
            literal_markdown: bool,
        },
        Node(&'a MarkdownNode),
    }

    fn flatten<'a>(nodes: &'a [MarkdownNode], parts: &mut Vec<SourceInlinePart<'a>>) {
        for node in nodes {
            match node {
                MarkdownNode::Text(runs) => {
                    parts.extend(runs.iter().map(SourceInlinePart::Text));
                }
                MarkdownNode::Fragment(children) => flatten(children, parts),
                MarkdownNode::Element { .. } => parts.push(SourceInlinePart::Node(node)),
            }
        }
    }

    #[derive(Clone)]
    enum ReplacementText {
        /// A literal Markdown part of its own.
        Part(std::borrow::Cow<'static, str>),
        /// The bytes stay in their run, as [`hold_as_written`] holds them.
        AsWritten,
        /// The character stays in its run, held as this decimal reference.
        Reference(u32),
    }

    #[derive(Clone)]
    struct InlineReplacement {
        text: ReplacementText,
        /// Whether a part of its own keeps the run's marks.
        preserve_marks: bool,
        /// The bytes it replaces.
        width: usize,
    }

    type InlineReplacements = BTreeMap<usize, BTreeMap<usize, InlineReplacement>>;

    // The output writes each of these back from `held`, in order. One the
    // text already holds is held as itself. DEL means nothing to Markdown,
    // and as one byte it never makes a text longer than it will be written.
    // Held text stays in its run, as the TypeScript writer keeps its tokens,
    // so block openers and marks read the run as one.
    const HELD: char = '\u{7f}';

    #[derive(Clone, Copy)]
    enum Held {
        Character(char),
        Reference(u32),
    }

    // An empty link the importer keeps as the file holds it reads back only
    // from the same bytes. Its `&`, `<`, `>`, and NBSP, and the first
    // character of each line it starts, are held, as the TypeScript writer
    // holds them, so no later pass writes them differently. A highlight
    // writes a held `=` as the `\=` it reads.
    fn hold_as_written(link: &str, highlighted: bool, text: &mut String, held: &mut Vec<Held>) {
        let mut starts_line = false;
        for character in link.chars() {
            if matches!(character, '&' | '<' | '>' | '\u{a0}' | HELD)
                || (starts_line && !matches!(character, '\n' | '\r'))
            {
                if highlighted && character == '=' {
                    text.push(HELD);
                    held.push(Held::Character('\\'));
                }
                text.push(HELD);
                held.push(Held::Character(character));
            } else {
                text.push(character);
            }
            starts_line = character == '\n';
        }
    }

    // Splits each text part at its replaced bytes, which become literal
    // Markdown parts. A replacement's own text moves into its part. One that
    // stays in its run is held.
    fn apply_inline_replacements<'a>(
        parts: Vec<InlinePart<'a>>,
        mut replacements: InlineReplacements,
        held: &mut Vec<Held>,
    ) -> Vec<InlinePart<'a>> {
        // Each part this makes owns a new string.
        fn materialize<'a>(parts: &mut Vec<InlinePart<'a>>, part: InlinePart<'a>) {
            #[cfg(test)]
            INLINE_PARTS_MATERIALIZED.with(|count| count.set(count.get() + 1));
            parts.push(part);
        }
        let holds = replacements
            .values()
            .flat_map(BTreeMap::values)
            .any(|replacement| !matches!(replacement.text, ReplacementText::Part(_)));
        let keep = |text: &mut String, kept: &str, held: &mut Vec<Held>| {
            text.push_str(kept);
            if holds {
                held.extend(kept.matches(HELD).map(|_| Held::Character(HELD)));
            }
        };
        let mut escaped_parts = Vec::new();
        for (part_index, part) in parts.into_iter().enumerate() {
            let Some(part_replacements) = replacements.remove(&part_index) else {
                if let InlinePart::Text { run, .. } = &part {
                    if holds {
                        held.extend(run.text.matches(HELD).map(|_| Held::Character(HELD)));
                    }
                }
                escaped_parts.push(part);
                continue;
            };
            let InlinePart::Text {
                run,
                literal_markdown,
            } = part
            else {
                unreachable!();
            };
            let highlighted = has_mark(&run.marks, MarkKind::Highlight);
            let mut text = String::new();
            let mut cursor = 0usize;
            for (offset, replacement) in part_replacements {
                keep(&mut text, &run.text[cursor..offset], held);
                cursor = offset + replacement.width;
                let written = match replacement.text {
                    ReplacementText::Part(written) => written,
                    ReplacementText::AsWritten => {
                        hold_as_written(&run.text[offset..cursor], highlighted, &mut text, held);
                        continue;
                    }
                    ReplacementText::Reference(code) => {
                        text.push(HELD);
                        held.push(Held::Reference(code));
                        continue;
                    }
                };
                // Its own part is written after the text before it, so a DEL it
                // holds is held as itself here.
                if holds {
                    held.extend(written.matches(HELD).map(|_| Held::Character(HELD)));
                }
                if !text.is_empty() {
                    materialize(
                        &mut escaped_parts,
                        InlinePart::Text {
                            run: TextRun {
                                text: std::mem::take(&mut text),
                                marks: run.marks.clone(),
                            },
                            literal_markdown,
                        },
                    );
                }
                materialize(
                    &mut escaped_parts,
                    InlinePart::Text {
                        run: TextRun {
                            text: written.into_owned(),
                            marks: if replacement.preserve_marks {
                                run.marks.clone()
                            } else {
                                Vec::new()
                            },
                        },
                        literal_markdown: true,
                    },
                );
            }
            keep(&mut text, &run.text[cursor..], held);
            if !text.is_empty() {
                let mut rest = run;
                rest.text = text;
                materialize(
                    &mut escaped_parts,
                    InlinePart::Text {
                        run: rest,
                        literal_markdown,
                    },
                );
            }
        }
        escaped_parts
    }

    // Raw HTML the document holds as text stays text. The projector writes its
    // `<`, `>`, and `&` as entities, so the syntax between them would read again
    // when the file reopens. In the block's tag span, from its first tag to its
    // last `>` across marks, every other ASCII punctuation character but the
    // `!`, `/`, and `?` that open a tag is written as a decimal reference the
    // importer reads back as that character, and so is a space that ends a line.
    // An empty line would end the paragraph, so its newline is one too. A line
    // of spaces or tabs already starts or ends with one. A highlight's `=` keeps
    // its own `\=` escape. Code is not part of the span, and in a table cell
    // neither is the `<br>` the projector writes as a real tag, which the
    // importer reads as raw HTML.
    //
    // The importer keeps a link with no text as the text the file holds, so
    // its `<` and `>` bound no span. Outside the span the projector writes its
    // `&`, `<`, `>`, and NBSP as they are, and each line its title starts,
    // which no block opener or indent escape then reads. They stay in their
    // run; see [`hold_as_written`]. A part's links, with the text between two
    // of them that holds no newline, `&`, `<`, `>`, or NBSP, are held as one.
    // Inside the span a link's `[` is a reference, so it reads back as the
    // span's other text does.
    //
    // A definition the importer keeps whole holds no link of its own. Outside
    // a table cell all of it is the span, and its NBSP is a reference too, so
    // the importer reads exactly those bytes back as the definition.
    fn raw_html_replacements(
        parts: &[InlinePart<'_>],
        table_cell: bool,
        definition: bool,
    ) -> ProjectionResult<InlineReplacements> {
        let texts: Vec<&str> = parts
            .iter()
            .map(|part| match part {
                InlinePart::Text {
                    run,
                    literal_markdown: false,
                } => run.text.as_str(),
                _ => "",
            })
            .collect();
        let highlighted_part = |part_index: usize| {
            matches!(
                &parts[part_index],
                InlinePart::Text { run, .. } if has_mark(&run.marks, MarkKind::Highlight)
            )
        };
        // A link with a line that would end its paragraph, as it will be
        // written, is written as references, so it holds no syntax and bounds
        // no span.
        type Ranges = Vec<(usize, usize)>;
        let (empty_links, text_links): (Vec<Ranges>, Vec<Ranges>) = texts
            .iter()
            .enumerate()
            .map(|(part_index, text)| {
                if definition {
                    (Vec::new(), Vec::new())
                } else {
                    let highlighted = highlighted_part(part_index);
                    empty_link_ranges(text)
                        .into_iter()
                        .partition(|&(from, to)| !opens_block(&text[from..to], highlighted))
                }
            })
            .unzip();
        let mut joined = texts.concat();
        if table_cell {
            joined = joined.replace(
                GFM_TABLE_CELL_BLOCK_SEPARATOR,
                &"\0".repeat(GFM_TABLE_CELL_BLOCK_SEPARATOR.len()),
            );
        }
        let mut bounds = joined.into_bytes();
        let mut offset = 0usize;
        for (text, (written, as_references)) in
            texts.iter().zip(empty_links.iter().zip(&text_links))
        {
            for &(from, to) in written.iter().chain(as_references) {
                for byte in &mut bounds[offset + from..offset + to] {
                    if matches!(*byte, b'<' | b'>') {
                        *byte = 0;
                    }
                }
            }
            offset += text.len();
        }
        let bytes = bounds.as_slice();
        let opens_tag = |pair: &[u8]| {
            pair[0] == b'<'
                && (pair[1].is_ascii_alphabetic() || matches!(pair[1], b'!' | b'/' | b'?'))
        };
        let whole_definition = definition && !table_cell;
        let span = if whole_definition {
            Some((0, bytes.len()))
        } else {
            let start = bytes.windows(2).position(opens_tag);
            let end = bytes
                .iter()
                .rposition(|byte| *byte == b'>')
                .map(|at| at + 1);
            start.zip(end)
        };
        let in_span =
            |from: usize, to: usize| span.is_some_and(|(start, end)| from < end && start < to);
        // The TypeScript writer keeps these as they are inside an empty link,
        // where the reader keeps them, but writes them differently outside it.
        let written_differently = |bytes: &[u8]| {
            bytes
                .iter()
                .any(|byte| matches!(byte, b'\n' | b'&' | b'<' | b'>'))
                || bytes.windows(2).any(|pair| pair == "\u{a0}".as_bytes())
        };
        let mut stretches = Vec::new();
        let mut offset = 0usize;
        for (part_index, (text, ranges)) in texts.iter().zip(&empty_links).enumerate() {
            let link = text.as_bytes();
            let mut write = |(from, to): (usize, usize)| {
                if written_differently(&link[from..to]) {
                    stretches.push((part_index, from, to));
                }
            };
            // The links written as references are sorted, so a join finds the
            // first one after its end.
            let links = &text_links[part_index];
            let references_between = |end: usize, from: usize| {
                links
                    .get(links.partition_point(|&(at, _)| at < end))
                    .is_some_and(|&(at, _)| at < from)
            };
            let mut stretch: Option<(usize, usize)> = None;
            for &(from, to) in ranges {
                // A link inside the span reads back as the span does.
                if in_span(offset + from, offset + to) {
                    continue;
                }
                // A link written as references between two is a part of its own.
                stretch = match stretch {
                    Some((start, end))
                        if !in_span(offset + end, offset + from)
                            && !written_differently(&link[end..from])
                            && !references_between(end, from) =>
                    {
                        Some((start, to))
                    }
                    Some(done) => {
                        write(done);
                        Some((from, to))
                    }
                    None => Some((from, to)),
                };
            }
            if let Some(done) = stretch {
                write(done);
            }
            offset += text.len();
        }
        let text_links = &text_links;
        let encoded_bytes = |(start, end): (usize, usize)| {
            let mut offset = 0usize;
            parts
                .iter()
                .zip(&texts)
                .enumerate()
                .flat_map(move |(part_index, (part, text))| {
                    let from = start.saturating_sub(offset);
                    let to = end.saturating_sub(offset).min(text.len());
                    let part_start = offset;
                    offset += text.len();
                    let highlighted = matches!(
                        part,
                        InlinePart::Text { run, .. } if has_mark(&run.marks, MarkKind::Highlight)
                    );
                    let text = text.as_bytes();
                    let links = &text_links[part_index];
                    (from..to).filter_map(move |at| {
                        let byte = text[at];
                        let next = links.partition_point(|&(_, to)| to <= at);
                        if links.get(next).is_some_and(|&(from, _)| from <= at) {
                            return None;
                        }
                        if whole_definition && text[at..].starts_with("\u{a0}".as_bytes()) {
                            return Some((part_index, at, 160u32, 2));
                        }
                        let encoded = match byte {
                            b'!' | b'&' | b'/' | b'<' | b'>' | b'?' => false,
                            b'=' => !highlighted,
                            // The space's newline can start the next part.
                            b' ' => {
                                part_start + at + 1 < end && bytes[part_start + at + 1] == b'\n'
                            }
                            b'\n' => part_start + at > 0 && bytes[part_start + at - 1] == b'\n',
                            _ => byte.is_ascii_punctuation(),
                        };
                        encoded.then_some((part_index, at, u32::from(byte), 1))
                    })
                })
        };
        // The output holds every byte of the text, and each reference writes
        // at least the bytes it replaces, so their encoded length is admitted
        // before any of them is written. The span writes no byte of a link
        // written as references.
        let reference_len = |code: u32| if code < 100 { 5 } else { 6 };
        let mut projected = bytes.len();
        for (part_index, (text, ranges)) in texts.iter().zip(text_links).enumerate() {
            let highlighted = highlighted_part(part_index);
            for &(from, to) in ranges {
                let written = written_as_references_len(text, from, to, highlighted);
                projected = checked_projection_len(projected, written - (to - from))?;
            }
        }
        if let Some(span) = span {
            for (_, _, code, width) in encoded_bytes(span) {
                projected = checked_projection_len(projected, reference_len(code) - width)?;
            }
        }
        let mut replacements = InlineReplacements::new();
        for (part_index, from, to) in stretches {
            replacements.entry(part_index).or_default().insert(
                from,
                InlineReplacement {
                    text: ReplacementText::AsWritten,
                    preserve_marks: true,
                    width: to - from,
                },
            );
        }
        // A link written as references is written whole, the way the importer
        // reads it back, so the span writes none of it. Each line it keeps is
        // one part, and the newline between two stays a line break.
        for (part_index, (text, ranges)) in texts.iter().zip(text_links).enumerate() {
            let highlighted = highlighted_part(part_index);
            let link = text.as_bytes();
            for &(from, to) in ranges {
                let mut start = from;
                for at in from..=to {
                    if at < to && !(link[at] == b'\n' && link[at - 1] != b'\n') {
                        continue;
                    }
                    if at > start {
                        #[cfg(test)]
                        LITERAL_LINKS_WRITTEN.with(|count| count.set(count.get() + 1));
                        replacements.entry(part_index).or_default().insert(
                            start,
                            InlineReplacement {
                                text: ReplacementText::Part(
                                    written_as_references(text, start, at, highlighted)?.into(),
                                ),
                                preserve_marks: true,
                                width: at - start,
                            },
                        );
                    }
                    start = at + 1;
                }
            }
        }
        let Some(span) = span else {
            return Ok(replacements);
        };
        for (part_index, at, code, width) in encoded_bytes(span) {
            #[cfg(test)]
            RAW_HTML_REFERENCES_RECORDED.with(|count| count.set(count.get() + 1));
            replacements.entry(part_index).or_default().insert(
                at,
                InlineReplacement {
                    text: ReplacementText::Reference(code),
                    preserve_marks: true,
                    width,
                },
            );
        }
        Ok(replacements)
    }

    fn encoded_block_punctuation(byte: u8) -> &'static str {
        match byte {
            b'#' => "&#35;",
            b'$' => "&#36;",
            b')' => "&#41;",
            b'*' => "&#42;",
            b'+' => "&#43;",
            b'-' => "&#45;",
            b'.' => "&#46;",
            b'=' => "&#61;",
            b'[' => "&#91;",
            b'_' => "&#95;",
            b'`' => "&#96;",
            b'~' => "&#126;",
            _ => unreachable!(),
        }
    }

    fn record_post_newline_block_escapes(
        line: &[u8],
        positions: &[(usize, usize)],
        line_break: Option<(usize, usize)>,
        replacements: &mut InlineReplacements,
    ) {
        let Ok(line_text) = std::str::from_utf8(line) else {
            return;
        };
        let Some((escape_index, escape_next)) = leading_markdown_block_escape_index(line_text)
        else {
            return;
        };
        let count = if escape_next { 2 } else { 1 };
        // The line break keeps its marks, so a mark across it stays one.
        if let Some((part_index, offset)) = line_break {
            replacements.entry(part_index).or_default().insert(
                offset,
                InlineReplacement {
                    text: ReplacementText::Part("\n".into()),
                    preserve_marks: true,
                    width: 1,
                },
            );
        }
        for (index, &byte) in line.iter().enumerate().skip(escape_index).take(count) {
            let Some(&(part_index, offset)) = positions.get(index) else {
                continue;
            };
            replacements.entry(part_index).or_default().insert(
                offset,
                InlineReplacement {
                    text: ReplacementText::Part(encoded_block_punctuation(byte).into()),
                    preserve_marks: true,
                    width: 1,
                },
            );
        }
    }

    let mut source_parts = Vec::new();
    flatten(nodes, &mut source_parts);
    let definition = escape_block_syntax
        && matches!(
            source_parts.first(),
            Some(SourceInlinePart::Text(run)) if run.text.starts_with('[')
        )
        && {
            let mut text = String::new();
            source_parts.iter().all(|part| match part {
                SourceInlinePart::Text(run) if run.marks.is_empty() => {
                    text.push_str(&run.text);
                    true
                }
                _ => false,
            }) && definition_paragraph(&text)
        };
    let mut parts = Vec::with_capacity(source_parts.len());
    let mut held = Vec::new();
    let mut source_index = 0usize;
    while source_index < source_parts.len() {
        let SourceInlinePart::Text(run) = source_parts[source_index] else {
            let SourceInlinePart::Node(node) = source_parts[source_index] else {
                unreachable!();
            };
            parts.push(InlinePart::Node(node));
            source_index += 1;
            continue;
        };
        let Some(code_mark) = active_mark(&run.marks, MarkKind::Code) else {
            parts.push(InlinePart::Text {
                run: run.clone(),
                literal_markdown: false,
            });
            source_index += 1;
            continue;
        };

        let mut value = ProjectionBuffer::new();
        let mut end = source_index;
        while let Some(SourceInlinePart::Text(candidate)) = source_parts.get(end) {
            if active_mark(&candidate.marks, MarkKind::Code)
                .is_none_or(|candidate_code| candidate_code.attrs != code_mark.attrs)
            {
                break;
            }
            if has_mark(&candidate.marks, MarkKind::Highlight) {
                value.push_str(&escape_highlight_equals(&candidate.text)?)?;
            } else {
                value.push_str(&candidate.text)?;
            }
            end += 1;
        }
        let mut prepared = run.clone();
        prepared.text = render_inline_code(&value.into_string())?;
        prepared.marks.retain(|mark| mark.kind != MarkKind::Code);
        parts.push(InlinePart::Text {
            run: prepared,
            literal_markdown: true,
        });
        source_index = end;
    }

    if !code_context {
        let raw_html = raw_html_replacements(&parts, table_cell, definition)?;
        if !raw_html.is_empty() {
            parts = apply_inline_replacements(parts, raw_html, &mut held);
        }
    }

    if escape_block_syntax {
        let mut replacements = InlineReplacements::new();
        let mut captures_line = false;
        let mut line = Vec::new();
        let mut positions = Vec::new();
        let mut line_break = None;
        for (part_index, part) in parts.iter().enumerate() {
            let InlinePart::Text {
                run,
                literal_markdown: false,
            } = part
            else {
                if captures_line {
                    record_post_newline_block_escapes(
                        &line,
                        &positions,
                        line_break,
                        &mut replacements,
                    );
                }
                captures_line = false;
                line.clear();
                positions.clear();
                line_break = None;
                continue;
            };
            for (offset, byte) in run.text.bytes().enumerate() {
                if byte == b'\n' {
                    if captures_line {
                        record_post_newline_block_escapes(
                            &line,
                            &positions,
                            line_break,
                            &mut replacements,
                        );
                    }
                    captures_line = true;
                    line.clear();
                    positions.clear();
                    line_break = Some((part_index, offset));
                    continue;
                }
                if !captures_line {
                    continue;
                }
                line.push(byte);
                positions.push((part_index, offset));
            }
        }
        if captures_line {
            record_post_newline_block_escapes(&line, &positions, line_break, &mut replacements);
        }

        let mut leading_column = Some(0usize);
        let mut leading_whitespace = Vec::new();
        for (part_index, part) in parts.iter().enumerate() {
            match part {
                InlinePart::Text {
                    run,
                    literal_markdown: false,
                } => {
                    for (offset, byte) in run.text.bytes().enumerate() {
                        if byte == b'\n' {
                            leading_column = Some(0);
                            leading_whitespace.clear();
                            continue;
                        }
                        let Some(column) = leading_column else {
                            continue;
                        };
                        if byte != b' ' && byte != b'\t' {
                            leading_column = None;
                            leading_whitespace.clear();
                            continue;
                        }

                        leading_whitespace.push((part_index, offset, byte));
                        let next_column = if byte == b' ' {
                            column + 1
                        } else {
                            column + 4 - (column % 4)
                        };
                        leading_column = Some(next_column);
                        if next_column < 4 {
                            continue;
                        }

                        for (index, &(index_part, index_offset, whitespace)) in
                            leading_whitespace.iter().enumerate()
                        {
                            let replacement = if index == 0 {
                                if whitespace == b' ' {
                                    "&#32;"
                                } else {
                                    "&#9;"
                                }
                            } else if whitespace == b' ' {
                                " "
                            } else {
                                "\t"
                            };
                            replacements.entry(index_part).or_default().insert(
                                index_offset,
                                InlineReplacement {
                                    text: ReplacementText::Part(replacement.into()),
                                    preserve_marks: false,
                                    width: 1,
                                },
                            );
                        }
                        leading_column = None;
                        leading_whitespace.clear();
                    }
                }
                InlinePart::Node(MarkdownNode::Element { tag, .. }) if tag == "hardBreak" => {
                    leading_column = Some(0);
                    leading_whitespace.clear();
                }
                _ => {
                    leading_column = None;
                    leading_whitespace.clear();
                }
            }
        }

        if !replacements.is_empty() {
            parts = apply_inline_replacements(parts, replacements, &mut held);
        }
    }

    // Whether the line after the hard break at `index` shows anything. Breaks
    // that follow it directly start lines of their own, which this answers for
    // in turn. A code span is already written in backticks here, so it shows.
    fn shows_line_after(parts: &[InlinePart<'_>], index: usize) -> bool {
        let is_break = |part: &InlinePart<'_>| matches!(part, InlinePart::Node(MarkdownNode::Element { tag, .. }) if tag == "hardBreak");
        let rest = &parts[index + 1..];
        let first_line = rest
            .iter()
            .position(|part| !is_break(part))
            .unwrap_or(rest.len());
        // Before another line, only spaces and tabs make it blank. On the
        // paragraph's last line any whitespace does, as a backslash followed
        // only by whitespace to the end is literal.
        let mut shows_before_line = false;
        let mut shows_before_end = false;
        for part in &rest[first_line..] {
            let InlinePart::Text { run, .. } = part else {
                return !is_break(part) || shows_before_line;
            };
            let (line, ends) = match run.text.split_once('\n') {
                Some((line, _)) => (line, true),
                None => (run.text.as_str(), false),
            };
            shows_before_line |= line.chars().any(|c| c != ' ' && c != '\t');
            // A `\r` or NBSP is written as a reference, which shows.
            shows_before_end |= line
                .chars()
                .any(|c| !is_js_whitespace(c) || matches!(c, '\r' | '\u{a0}'));
            if ends {
                return shows_before_line;
            }
        }
        shows_before_end
    }

    let mut rendered_nodes = BTreeMap::new();
    let mut starts_line = true;
    // Every break in a run looks ahead to the same line, so keep the answer
    // for the run rather than rescanning it at each break.
    let mut line_after_breaks = None;
    let mut part_index = 0usize;
    while escape_block_syntax && part_index < parts.len() {
        if !matches!(&parts[part_index], InlinePart::Node(MarkdownNode::Element { tag, .. }) if tag == "hardBreak")
        {
            line_after_breaks = None;
        }
        let is_plain_text = matches!(
            &parts[part_index],
            InlinePart::Text {
                run,
                literal_markdown: false,
            } if run.marks.is_empty()
        );
        if is_plain_text {
            let run_start = part_index;
            let mut text = ProjectionBuffer::new();
            while part_index < parts.len()
                && matches!(
                    &parts[part_index],
                    InlinePart::Text {
                        run,
                        literal_markdown: false,
                    } if run.marks.is_empty()
                )
            {
                let InlinePart::Text { run, .. } = &parts[part_index] else {
                    unreachable!();
                };
                text.push_str(&run.text)?;
                part_index += 1;
            }
            let text = text.into_string();
            let encoded = encode_html_entities(&text)?;
            let escaped =
                escape_markdown_block_syntax(&encoded, starts_line, definition && run_start == 0)?;
            let InlinePart::Text {
                run,
                literal_markdown,
            } = &mut parts[run_start]
            else {
                unreachable!();
            };
            run.text = escaped;
            *literal_markdown = true;
            for part in &mut parts[run_start + 1..part_index] {
                let InlinePart::Text { run, .. } = part else {
                    unreachable!();
                };
                run.text.clear();
            }
            starts_line = text.ends_with('\n');
            continue;
        }

        starts_line = match &parts[part_index] {
            // A hard break's two spaces on a line with nothing else read back
            // as a blank line, which ends the paragraph. A backslash keeps the
            // break, but a backslash before a blank line ends the paragraph
            // and is literal. A table cell writes it as <br>.
            InlinePart::Node(MarkdownNode::Element { tag, .. })
                if tag == "hardBreak"
                    && starts_line
                    && !table_cell
                    && *line_after_breaks
                        .get_or_insert_with(|| shows_line_after(&parts, part_index)) =>
            {
                rendered_nodes.insert(part_index, "\\\n".to_string());
                true
            }
            InlinePart::Node(node) => {
                let rendered = render_node(
                    node,
                    RenderContext {
                        parent_tag: "paragraph",
                        parent_attrs: &BTreeMap::new(),
                        previous: None,
                        index: part_index,
                        table_cell,
                    },
                )?;
                let starts_line = rendered.ends_with('\n');
                rendered_nodes.insert(part_index, rendered);
                starts_line
            }
            InlinePart::Text { .. } => false,
        };
        part_index += 1;
    }

    // Markdown reads no delimiter beside only whitespace as a mark, so a mark
    // that opens or closes inside whitespace reads back as literal asterisks.
    // A run of only whitespace keeps a mark that continues through it to text
    // on both sides, or that opens right before a character, where the
    // whitespace is written before the delimiter. It keeps one that closes
    // right after a character, where the whitespace is written after it,
    // unless the run also opens a mark: closing and opening in one run writes
    // them inside the whitespace. It drops the others. Each kept mark is
    // written where the old writer wrote it, whose nesting the reader depends
    // on. The TypeScript writer does the same.
    let mut blank = Vec::with_capacity(parts.len());
    for part in &parts {
        blank.push(match part {
            InlinePart::Text {
                run,
                literal_markdown,
            } => {
                run.text.chars().all(is_js_whitespace)
                    && written_run_text(run, *literal_markdown, code_context, escape_block_syntax)?
                        .chars()
                        .all(is_js_whitespace)
            }
            InlinePart::Node(_) => false,
        });
    }
    if blank.contains(&true) {
        let from_before = marks_reaching_text(&parts, &blank, 0..parts.len());
        let from_after = marks_reaching_text(&parts, &blank, (0..parts.len()).rev());
        // Whether a run beside a blank one starts and ends with text.
        let mut starts_solid = vec![false; parts.len()];
        let mut ends_solid = vec![false; parts.len()];
        for (index, part) in parts.iter().enumerate() {
            let beside_blank =
                (index > 0 && blank[index - 1]) || blank.get(index + 1).copied().unwrap_or(false);
            if let (
                false,
                true,
                InlinePart::Text {
                    run,
                    literal_markdown,
                },
            ) = (blank[index], beside_blank, part)
            {
                let written =
                    written_run_text(run, *literal_markdown, code_context, escape_block_syntax)?;
                starts_solid[index] = written.chars().next().is_some_and(|c| !is_js_whitespace(c));
                ends_solid[index] = written
                    .chars()
                    .next_back()
                    .is_some_and(|c| !is_js_whitespace(c));
            }
        }
        for (index, part) in parts.iter_mut().enumerate() {
            let InlinePart::Text { run, .. } = part else {
                continue;
            };
            if !blank[index] {
                continue;
            }
            let after_text = index > 0 && ends_solid[index - 1];
            let before_text = starts_solid.get(index + 1).copied().unwrap_or(false);
            let back = |mark: &MarkdownMark| contains_same_mark(&from_before[index], mark);
            let ahead = |mark: &MarkdownMark| contains_same_mark(&from_after[index], mark);
            // Code marks are written before this, as code spans.
            let delimits = |mark: &MarkdownMark| mark.kind != MarkKind::Link;
            let opens = run
                .marks
                .iter()
                .any(|mark| delimits(mark) && before_text && ahead(mark) && !back(mark));
            run.marks.retain(|mark| {
                !delimits(mark)
                    || (back(mark) && ahead(mark))
                    || (ahead(mark) && before_text)
                    || (back(mark) && after_text && !opens)
            });
        }
    }

    // For each blank run, the marks it shares with the text the order visits
    // before it, through blank runs that carry them too.
    fn marks_reaching_text(
        parts: &[InlinePart<'_>],
        blank: &[bool],
        order: impl Iterator<Item = usize>,
    ) -> Vec<Vec<MarkdownMark>> {
        let mut reached = vec![Vec::new(); parts.len()];
        let mut before: Option<usize> = None;
        for index in order {
            let InlinePart::Text { run, .. } = &parts[index] else {
                before = None;
                continue;
            };
            if let (true, Some(at)) = (blank[index], before) {
                let carried: &[MarkdownMark] = match &parts[at] {
                    _ if blank[at] => &reached[at],
                    InlinePart::Text { run, .. } => &run.marks,
                    InlinePart::Node(_) => unreachable!("a node ends the reach"),
                };
                let shared = run
                    .marks
                    .iter()
                    .filter(|mark| contains_same_mark(carried, mark))
                    .cloned()
                    .collect();
                reached[index] = shared;
            }
            before = Some(index);
        }
        reached
    }

    let mut output = ProjectionBuffer::new();
    let mut active: Vec<MarkdownMark> = Vec::new();
    let mut modes: BTreeMap<MarkKind, OpeningMode> = BTreeMap::new();
    let mut reopen_html = BTreeSet::new();
    let mut held_characters = held.iter().copied();

    for (index, part) in parts.iter().enumerate() {
        let next_marks = parts.get(index + 1).and_then(|next| match next {
            InlinePart::Text { run, .. } => Some(run.marks.as_slice()),
            InlinePart::Node(_) => None,
        });
        match part {
            InlinePart::Node(node) => {
                let mut before = String::new();
                for mark in active.iter().rev() {
                    before.push_str(&mark_closing(
                        mark,
                        modes
                            .get(&mark.kind)
                            .copied()
                            .unwrap_or(OpeningMode::Markdown),
                    ));
                }
                active.clear();
                modes.clear();
                let rendered = if let Some(rendered) = rendered_nodes.remove(&index) {
                    rendered
                } else {
                    render_node(
                        node,
                        RenderContext {
                            parent_tag: "paragraph",
                            parent_attrs: &BTreeMap::new(),
                            previous: None,
                            index,
                            table_cell,
                        },
                    )?
                };
                output.push_str(&before)?;
                output.push_str(&rendered)?;
            }
            InlinePart::Text {
                run,
                literal_markdown,
            } => {
                if run.text.len() > MAX_PROJECTION_BYTES {
                    return Err(projection_too_large(run.text.len()));
                }
                let mut text =
                    written_run_text(run, *literal_markdown, code_context, escape_block_syntax)?;
                // Nothing held is whitespace at the text's edge, which marks
                // read: a held character is inside an empty link.
                if !held.is_empty() && text.contains(HELD) {
                    let mut written = ProjectionBuffer::with_capacity(text.len())?;
                    for character in text.chars() {
                        if character != HELD {
                            written.push(character)?;
                            continue;
                        }
                        match held_characters.next().expect("one held entry for each") {
                            Held::Character(character) => written.push(character)?,
                            Held::Reference(code) => written.push_str(&format!("&#{code};"))?,
                        }
                    }
                    text = written.into_string();
                }
                let current = &run.marks;
                let mut to_open: Vec<MarkdownMark> = current
                    .iter()
                    .filter(|mark| !contains_same_mark(&active, mark))
                    .cloned()
                    .collect();
                if to_open.len() > 1 {
                    to_open.sort_by(|left, right| {
                        let left_continues =
                            next_marks.is_some_and(|next| contains_same_mark(next, left));
                        let right_continues =
                            next_marks.is_some_and(|next| contains_same_mark(next, right));
                        left_continues
                            .cmp(&right_continues)
                            .then_with(|| right.kind.rank().cmp(&left.kind.rank()))
                    });
                }
                let to_close: Vec<MarkKind> = current
                    .iter()
                    .filter(|mark| next_marks.is_none_or(|next| !contains_same_mark(next, mark)))
                    .map(|mark| mark.kind)
                    .collect();
                let active_closing: Vec<MarkKind> = to_close
                    .iter()
                    .copied()
                    .filter(|kind| active.iter().any(|mark| mark.kind == *kind))
                    .collect();
                let crossed = !active_closing.is_empty() && !to_open.is_empty();
                let mut middle_trailing = String::new();
                if !to_close.is_empty() && !crossed {
                    let (body, trailing) = split_trailing_js_whitespace(&text);
                    let body = body.to_string();
                    middle_trailing = trailing.to_string();
                    text = body;
                }
                if !crossed {
                    for kind in to_close.iter().rev() {
                        if let Some(mark) = active_mark(&active, *kind).cloned() {
                            text.push_str(&mark_closing(
                                &mark,
                                modes.get(kind).copied().unwrap_or(OpeningMode::Markdown),
                            ));
                            remove_active(&mut active, *kind);
                            modes.remove(kind);
                        }
                    }
                }
                let mut leading = String::new();
                if !to_open.is_empty() {
                    let (whitespace, body) = split_leading_js_whitespace(&text);
                    leading = whitespace.to_string();
                    text = body.to_string();
                }
                for mark in &to_open {
                    let mode = if reopen_html.remove(&mark.kind) {
                        OpeningMode::Html
                    } else {
                        OpeningMode::Markdown
                    };
                    let opening = mark_opening(mark, mode);
                    let mut marked = ProjectionBuffer::with_capacity(opening.len() + text.len())?;
                    marked.push_str(&opening)?;
                    marked.push_str(&text)?;
                    text = marked.into_string();
                    modes.insert(mark.kind, mode);
                }
                if !crossed {
                    for mark in to_open.iter().rev() {
                        set_active(&mut active, mark.clone());
                    }
                }
                let mut with_leading = ProjectionBuffer::with_capacity(leading.len() + text.len())?;
                with_leading.push_str(&leading)?;
                with_leading.push_str(&text)?;
                text = with_leading.into_string();
                let close_at_end: Vec<MarkKind> = if crossed {
                    for mark in &to_open {
                        if next_marks.is_some_and(|next| {
                            next.iter().any(|next_mark| next_mark.kind == mark.kind)
                        }) && mark.kind.html_tags().is_some()
                        {
                            reopen_html.insert(mark.kind);
                        }
                    }
                    let mut old = active_closing;
                    old.sort_by_key(|kind| {
                        std::cmp::Reverse(
                            active
                                .iter()
                                .position(|mark| mark.kind == *kind)
                                .unwrap_or(0),
                        )
                    });
                    to_open.iter().map(|mark| mark.kind).chain(old).collect()
                } else {
                    marks_to_close_at_end(&active, current, next_marks)
                };
                let mut trailing = String::new();
                if !close_at_end.is_empty() {
                    let (body, whitespace) = split_trailing_js_whitespace(&text);
                    let body = body.to_string();
                    trailing = whitespace.to_string();
                    text = body;
                }
                for kind in close_at_end {
                    let mark = active_mark(&active, kind)
                        .or_else(|| current.iter().find(|mark| mark.kind == kind));
                    if let Some(mark) = mark {
                        text.push_str(&mark_closing(
                            mark,
                            modes.get(&kind).copied().unwrap_or(OpeningMode::Markdown),
                        ));
                    }
                    remove_active(&mut active, kind);
                    modes.remove(&kind);
                }
                text.push_str(&trailing);
                text.push_str(&middle_trailing);
                output.push_str(&text)?;
            }
        }
    }
    Ok(output.into_string())
}

fn marks_to_close_at_end(
    active: &[MarkdownMark],
    current: &[MarkdownMark],
    next: Option<&[MarkdownMark]>,
) -> Vec<MarkKind> {
    let is_last = next.is_none();
    let next_has_no_marks = next.is_some_and(<[MarkdownMark]>::is_empty);
    let next_differs = next.is_some_and(|marks| marks != current);
    if !(is_last || next_has_no_marks || next_differs) {
        return Vec::new();
    }
    match next {
        Some(next) if !next.is_empty() => active
            .iter()
            .rev()
            .filter(|mark| !contains_same_mark(next, mark))
            .map(|mark| mark.kind)
            .collect(),
        _ => active.iter().rev().map(|mark| mark.kind).collect(),
    }
}

fn has_mark(marks: &[MarkdownMark], kind: MarkKind) -> bool {
    marks.iter().any(|mark| mark.kind == kind)
}

fn contains_same_mark(marks: &[MarkdownMark], expected: &MarkdownMark) -> bool {
    marks
        .iter()
        .any(|mark| mark.kind == expected.kind && mark.attrs == expected.attrs)
}

fn active_mark(marks: &[MarkdownMark], kind: MarkKind) -> Option<&MarkdownMark> {
    marks.iter().find(|mark| mark.kind == kind)
}

fn set_active(active: &mut Vec<MarkdownMark>, mark: MarkdownMark) {
    if let Some(existing) = active.iter_mut().find(|active| active.kind == mark.kind) {
        *existing = mark;
    } else {
        active.push(mark);
    }
}

fn remove_active(active: &mut Vec<MarkdownMark>, kind: MarkKind) {
    active.retain(|mark| mark.kind != kind);
}

fn mark_opening(mark: &MarkdownMark, mode: OpeningMode) -> String {
    if mode == OpeningMode::Html {
        return mark
            .kind
            .html_tags()
            .map(|(opening, _)| opening.to_string())
            .unwrap_or_default();
    }
    match mark.kind {
        MarkKind::Link => "[".to_string(),
        MarkKind::Highlight => "==".to_string(),
        MarkKind::Bold => "**".to_string(),
        MarkKind::Code => unreachable!("inline code marks are rendered before mark serialization"),
        MarkKind::Italic => "*".to_string(),
        MarkKind::Strike => "~~".to_string(),
        MarkKind::Underline => "++".to_string(),
    }
}

fn mark_closing(mark: &MarkdownMark, mode: OpeningMode) -> String {
    if mode == OpeningMode::Html {
        return mark
            .kind
            .html_tags()
            .map(|(_, closing)| closing.to_string())
            .unwrap_or_default();
    }
    match mark.kind {
        MarkKind::Link => {
            let href = mark
                .attrs
                .as_object()
                .and_then(|attrs| attrs.get("href"))
                .map(js_value_string)
                .unwrap_or_default();
            let title = mark
                .attrs
                .as_object()
                .and_then(|attrs| attrs.get("title"))
                .map(js_value_string)
                .unwrap_or_default();
            if title.is_empty() {
                format!("]({href})")
            } else {
                format!("]({href} \"{title}\")")
            }
        }
        MarkKind::Highlight => "==".to_string(),
        MarkKind::Bold => "**".to_string(),
        MarkKind::Code => unreachable!("inline code marks are rendered before mark serialization"),
        MarkKind::Italic => "*".to_string(),
        MarkKind::Strike => "~~".to_string(),
        MarkKind::Underline => "++".to_string(),
    }
}

/// A run's text as it is written, before held characters are written back.
fn written_run_text(
    run: &TextRun,
    literal_markdown: bool,
    code_context: bool,
    escape_block_syntax: bool,
) -> ProjectionResult<String> {
    let mut text = run.text.clone();
    if !literal_markdown && has_mark(&run.marks, MarkKind::Highlight) {
        text = escape_highlight_equals(&text)?;
    }
    if !literal_markdown && !code_context && !has_mark(&run.marks, MarkKind::Code) {
        text = encode_html_entities(&text)?;
        if escape_block_syntax {
            text = encode_paragraph_whitespace(&text);
        }
    }
    Ok(text)
}

fn escape_highlight_equals(value: &str) -> ProjectionResult<String> {
    let mut output = ProjectionBuffer::new();
    for character in value.chars() {
        if character == '=' {
            output.push_str("\\=")?;
        } else {
            output.push(character)?;
        }
    }
    Ok(output.into_string())
}

fn encode_html_entities(value: &str) -> ProjectionResult<String> {
    let mut output = ProjectionBuffer::new();
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;")?,
            '<' => output.push_str("&lt;")?,
            '>' => output.push_str("&gt;")?,
            _ => output.push(character)?,
        }
    }
    Ok(output.into_string())
}

fn escape_markdown_line_breaks(value: &str) -> String {
    value.replace('\n', "\\n").replace('\r', "\\r")
}

fn element_tag(node: &MarkdownNode) -> Option<&str> {
    match node {
        MarkdownNode::Element { tag, .. } => Some(tag),
        _ => None,
    }
}

fn attr_i64(attrs: &BTreeMap<String, Value>, key: &str) -> Option<i64> {
    attrs.get(key).and_then(|value| {
        value.as_i64().or_else(|| {
            value
                .as_str()
                .and_then(|string| string.trim().parse::<i64>().ok())
        })
    })
}

fn attr_bool(attrs: &BTreeMap<String, Value>, key: &str) -> Option<bool> {
    attrs.get(key).and_then(Value::as_bool)
}

fn attr_js_string(attrs: &BTreeMap<String, Value>, key: &str) -> String {
    attrs.get(key).map(js_value_string).unwrap_or_default()
}

fn js_value_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(boolean) => boolean.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(string) => string.clone(),
        Value::Array(_) | Value::Object(_) => value.to_string(),
    }
}

fn split_leading_js_whitespace(value: &str) -> (&str, &str) {
    let split = value
        .char_indices()
        .find_map(|(index, character)| (!is_js_whitespace(character)).then_some(index))
        .unwrap_or(value.len());
    value.split_at(split)
}

fn split_trailing_js_whitespace(value: &str) -> (&str, &str) {
    let split = value
        .char_indices()
        .rev()
        .find_map(|(index, character)| {
            (!is_js_whitespace(character)).then_some(index + character.len_utf8())
        })
        .unwrap_or(0);
    value.split_at(split)
}

fn trim_js(value: &str) -> &str {
    let (_, without_leading) = split_leading_js_whitespace(value);
    let (trimmed, _) = split_trailing_js_whitespace(without_leading);
    trimmed
}

fn trim_js_end(value: &str) -> &str {
    split_trailing_js_whitespace(value).0
}

fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

#[cfg(test)]
mod projection_tests {
    use super::*;

    use crate::limits::MAX_PROJECTION_BYTES;
    use yrs::types::xml::XmlIn;
    use yrs::types::Attrs;

    #[test]
    fn fixed_client_retains_deleted_yjs_payload() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../tests/lossless-fixtures/deleted-history.json"
        ))
        .unwrap();
        let updates: Vec<Vec<u8>> = serde_json::from_value(fixture["updates"].clone()).unwrap();
        let expected: Vec<u8> = serde_json::from_value(fixture["retainedState"].clone()).unwrap();
        let doc = Ydoc::with_client_id(17);
        for update in updates {
            doc.apply(&update).unwrap();
        }
        assert_eq!(doc.encode_full_state(), expected);
    }
    fn scene_map_set(doc: &Ydoc, root: &str, key: &str, value: &str) -> Vec<u8> {
        let map = doc.doc.get_or_insert_map(root);
        doc.with_delta(|txn| {
            map.insert(txn, key, value);
        })
    }

    #[test]
    fn batch_gate_rejects_clock_redefinition_and_continues_with_valid_edits() {
        let source = Ydoc::with_client_id(41);
        let first = source.plaintext_insert(0, "hello");
        let second = source.plaintext_insert(5, " world");
        let poison = Ydoc::with_client_id(41).plaintext_insert(0, "wrong");
        let deletion = source.plaintext_delete(0, 1);
        let crate::ReplayBatch {
            doc: target,
            outcomes: result,
        } = crate::apply_replay_validated_batch(
            &Ydoc::wire().encode_full_state(),
            &[first, poison, second, deletion],
        )
        .unwrap();
        assert!(result[0].is_ok());
        assert!(result[1].is_err());
        assert!(result[2].is_ok());
        assert!(result[3].is_ok());
        assert_eq!(target.plaintext_string(), source.plaintext_string());
        assert_eq!(target.encode_state_vector(), source.encode_state_vector());
        assert_eq!(target.encode_delete_set(), source.encode_delete_set());
    }

    #[test]
    fn delete_set_provenance_is_canonical_across_apply_order_and_gc() {
        let first = Ydoc::with_client_id(1);
        let second = Ydoc::with_client_id(9);
        let a = first.plaintext_insert(0, "first");
        let b = second.plaintext_insert(0, "second");
        let da = first.plaintext_delete(0, 2);
        let db = second.plaintext_delete(1, 2);
        let forward = Ydoc::wire();
        let reverse = Ydoc::wire();
        for update in [&a, &b, &da, &db] {
            forward.apply(update).unwrap();
        }
        for update in [&db, &da, &b, &a] {
            reverse.apply(update).unwrap();
        }
        reverse.doc.transact_mut().gc(None);
        assert_eq!(forward.encode_state_vector(), reverse.encode_state_vector());
        assert_eq!(forward.encode_delete_set(), reverse.encode_delete_set());
        let before = forward.encode_delete_set();
        forward.plaintext_delete(0, 1);
        assert_eq!(forward.encode_state_vector(), reverse.encode_state_vector());
        assert_ne!(before, forward.encode_delete_set());
    }

    #[test]
    fn state_vector_provenance_is_canonical_across_hashmap_insertion_order() {
        // ClientHasher hashes to the raw client id; 1 and 9 collide in the
        // initial table, making opposite insertion order a stable regression
        // case for the old HashMap-iteration encoding.
        let client_one = Ydoc::with_client_id(1);
        let update_one = client_one.plaintext_insert(0, "one");
        let client_nine = Ydoc::with_client_id(9);
        let update_nine = client_nine.plaintext_insert(0, "nine");

        let forward = Ydoc::wire();
        forward.apply(&update_one).expect("client one update");
        forward.apply(&update_nine).expect("client nine update");
        let reverse = Ydoc::wire();
        reverse.apply(&update_nine).expect("client nine update");
        reverse.apply(&update_one).expect("client one update");

        assert_eq!(forward.state_vector(), reverse.state_vector());
        assert_eq!(forward.encode_state_vector(), reverse.encode_state_vector());
        assert_eq!(
            StateVector::decode_v1(&forward.encode_state_vector()).expect("canonical state vector"),
            forward.state_vector(),
        );
        assert_eq!(
            forward
                .project(ContentKind::Plaintext)
                .expect("forward projection")
                .source_state_vector_sha256,
            reverse
                .project(ContentKind::Plaintext)
                .expect("reverse projection")
                .source_state_vector_sha256,
        );
    }

    #[test]
    fn oversized_scene_projection_is_refused_at_the_existing_byte_cap() {
        let doc = Ydoc::wire();
        let oversized_color = serde_json::to_string(&"x".repeat(MAX_PROJECTION_BYTES))
            .expect("encode oversized app state");
        scene_map_set(
            &doc,
            ROOT_SCENE_APP_STATE,
            "viewBackgroundColor",
            &oversized_color,
        );

        assert!(matches!(
            doc.project(ContentKind::Scene),
            Err(CollabError::ProjectionTooLarge {
                actual,
                max: MAX_PROJECTION_BYTES
            }) if actual > MAX_PROJECTION_BYTES
        ));
    }

    #[test]
    fn file_fold_quote_guard_allows_code_and_preserves_the_document_on_overflow() {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, "original")
            .unwrap();
        let before = doc.encode_full_state();
        let deep = format!("{}deep", "> ".repeat(read_markdown::MAX_QUOTES + 1));
        assert!(matches!(
            doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &deep),
            Err(CollabError::MarkdownQuoteDepthExceeded)
        ));
        assert_eq!(doc.encode_full_state(), before);
        let code = format!("```\n{deep}\n```\n");
        doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &code)
            .unwrap();
        assert_eq!(doc.project(ContentKind::Richdoc).unwrap().content, code);
        for depth in [read_markdown::MAX_QUOTES - 1, read_markdown::MAX_QUOTES] {
            let quote = format!("{}deep\n", "> ".repeat(depth));
            doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &quote)
                .unwrap();
            assert_eq!(doc.project(ContentKind::Richdoc).unwrap().content, quote);
        }
    }

    #[test]
    fn oversized_source_preserving_edits_leave_ydoc_byte_identical() {
        let oversized = " ".repeat(dohc_engine_domain::MAX_TEXT_BYTES + 1);

        let frontmatter_doc = Ydoc::wire();
        frontmatter_doc
            .rewrite_content_to_markdown(ContentKind::Richdoc, "body")
            .expect("seed document");
        let before = frontmatter_doc.encode_full_state();

        assert!(matches!(
            frontmatter_doc.frontmatter_set_preserving_markdown_source("id", "record", &oversized),
            Err(CollabError::ProjectionTooLarge { actual, max })
                if actual == dohc_engine_domain::MAX_TEXT_BYTES + 1
                    && max == dohc_engine_domain::MAX_TEXT_BYTES
        ));
        assert_eq!(frontmatter_doc.encode_full_state(), before);

        let rewrite_doc = Ydoc::wire();
        rewrite_doc
            .rewrite_content_to_markdown(ContentKind::Richdoc, "original")
            .expect("seed document");
        let before = rewrite_doc.encode_full_state();

        assert!(matches!(
            rewrite_doc.rewrite_content_to_markdown_preserving_source(
                ContentKind::Richdoc,
                &oversized,
            ),
            Err(CollabError::ProjectionTooLarge { actual, max })
                if actual == dohc_engine_domain::MAX_TEXT_BYTES + 1
                    && max == dohc_engine_domain::MAX_TEXT_BYTES
        ));
        assert_eq!(rewrite_doc.encode_full_state(), before);
    }

    fn xml_text(value: impl Into<String>) -> XmlIn {
        XmlTextPrelim::new(value).into()
    }

    fn xml_element(
        tag: &str,
        attrs: &[(&str, &str)],
        children: impl IntoIterator<Item = XmlIn>,
    ) -> XmlIn {
        let mut element = XmlElementPrelim::new(tag, children);
        element.attributes.extend(
            attrs
                .iter()
                .map(|(key, value)| ((*key).into(), (*value).to_string())),
        );
        element.into()
    }

    fn paragraph(value: impl Into<String>) -> XmlIn {
        xml_element("paragraph", &[], [xml_text(value)])
    }

    fn remote_doc_with_body(children: impl IntoIterator<Item = XmlIn>) -> Ydoc {
        let source = Ydoc::wire();
        let body = source.doc.get_or_insert_xml_fragment(ROOT_BODY);
        {
            let mut txn = source.doc.transact_mut();
            for child in children {
                body.push_back(&mut txn, child);
            }
        }
        let remote = Ydoc::wire();
        remote
            .apply(&source.encode_full_state())
            .expect("test update is valid");
        remote
    }
    #[test]
    fn hostile_remote_heading_level_is_clamped_before_allocation() {
        let doc = remote_doc_with_body([xml_element(
            "heading",
            &[("level", "9223372036854775807")],
            [xml_text("bounded")],
        )]);

        let projection = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            doc.project(ContentKind::Richdoc)
        }));

        assert!(projection.is_ok(), "hostile heading level must not panic");
        assert_eq!(
            projection
                .expect("checked above")
                .expect("clamped projection")
                .content,
            "###### bounded\n",
            "out-of-schema heading levels clamp to level six"
        );
    }

    #[test]
    fn uneven_remote_table_refuses_padding_amplification_at_projection_cap() {
        const WIDE_CELL_BYTES: usize = 1024 * 1024;
        const SHORT_ROWS: usize = 18;

        let mut rows = Vec::with_capacity(SHORT_ROWS + 1);
        rows.push(xml_element(
            "tableRow",
            &[],
            [xml_element(
                "tableHeader",
                &[("colspan", "1"), ("rowspan", "1")],
                [paragraph("x".repeat(WIDE_CELL_BYTES))],
            )],
        ));
        rows.extend((0..SHORT_ROWS).map(|_| {
            xml_element(
                "tableRow",
                &[],
                [xml_element(
                    "tableCell",
                    &[("colspan", "1"), ("rowspan", "1")],
                    [paragraph("x")],
                )],
            )
        }));
        let doc = remote_doc_with_body([xml_element("table", &[], rows)]);

        let error = doc
            .project(ContentKind::Richdoc)
            .expect_err("padding amplification must be refused");
        assert!(
            matches!(
                error,
                CollabError::ProjectionTooLarge {
                    actual,
                    max: MAX_PROJECTION_BYTES
                } if actual > MAX_PROJECTION_BYTES
            ) || matches!(error, CollabError::ProjectionTooComplex { .. }),
            "expected a projection bound to refuse, got {error:?}"
        );
    }

    #[test]
    fn hostile_remote_nesting_refuses_before_recursive_projection() {
        let mut child = paragraph("deep");
        for _ in 0..=MAX_PROJECTION_DEPTH {
            child = xml_element("blockquote", &[], [child]);
        }
        let doc = remote_doc_with_body([child]);

        assert!(matches!(
            doc.project(ContentKind::Richdoc),
            Err(CollabError::ProjectionTooComplex {
                max_depth: MAX_PROJECTION_DEPTH,
                max_nodes: MAX_PROJECTION_NODES
            })
        ));
    }

    #[test]
    fn json_text_and_xml_text_charge_actual_run_nodes() {
        let doc = Doc::new();
        let text = doc.get_or_insert_text("text");
        let fragment = doc.get_or_insert_xml_fragment("xml");
        let body = "é".repeat(128);
        let xml_text;
        {
            let mut txn = doc.transact_mut();
            text.insert(&mut txn, 0, &body);
            xml_text = fragment.push_back(&mut txn, XmlTextPrelim::new(&body));
        }
        let txn = doc.transact();
        for xml in [false, true] {
            for budget in [2, 3] {
                let mut remaining = budget;
                let mut bytes = 0;
                PROJECTION_TEXT_BYTES_COPIED.with(|count| count.set(0));
                let value = if xml {
                    projection_xml_json(
                        &txn,
                        XmlOut::Text(xml_text.clone()),
                        0,
                        &mut remaining,
                        &mut bytes,
                    )
                } else {
                    projection_out_json(
                        &txn,
                        Out::YText(text.clone()),
                        0,
                        &mut remaining,
                        &mut bytes,
                    )
                };
                if budget == 3 {
                    assert_eq!(value.unwrap()["delta"], json!([{ "insert": body }]));
                    assert_eq!(remaining, 0);
                    assert_eq!(bytes, body.len());
                    PROJECTION_TEXT_BYTES_COPIED.with(|count| assert_eq!(count.get(), body.len()));
                } else {
                    assert!(matches!(
                        value,
                        Err(CollabError::ProjectionTooComplex { .. })
                    ));
                    PROJECTION_TEXT_BYTES_COPIED.with(|count| assert_eq!(count.get(), 0));
                }
            }
        }
    }

    #[test]
    fn text_utf8_and_attribute_budgets_refuse_before_copying() {
        let doc = Doc::new();
        let text = doc.get_or_insert_text("text");
        text.insert(&mut doc.transact_mut(), 0, "😀");
        let txn = doc.transact();
        let mut remaining = MAX_PROJECTION_NODES;
        let mut bytes = MAX_PROJECTION_BYTES - 3;
        PROJECTION_TEXT_BYTES_COPIED.with(|count| count.set(0));
        assert!(matches!(
            projection_text_json(&txn, &text, 0, &mut remaining, &mut bytes),
            Err(CollabError::ProjectionTooLarge { actual, .. })
                if actual == MAX_PROJECTION_BYTES + 1
        ));
        PROJECTION_TEXT_BYTES_COPIED.with(|count| assert_eq!(count.get(), 0));

        let mut remaining = 2;
        let mut bytes = MAX_PROJECTION_BYTES - 4;
        assert_eq!(
            projection_text_json(&txn, &text, 0, &mut remaining, &mut bytes).unwrap(),
            json!([{ "insert": "😀" }])
        );
        assert_eq!(bytes, MAX_PROJECTION_BYTES);

        let attrs = Attrs::from([("bold".into(), Any::Bool(true))]);
        for (node_budget, byte_budget) in [(1, 0), (2, MAX_PROJECTION_BYTES - 4)] {
            let mut runs = Vec::new();
            let mut remaining = node_budget;
            let mut bytes = byte_budget;
            PROJECTION_TEXT_BYTES_COPIED.with(|count| count.set(0));
            let result =
                append_markdown_text(&mut runs, "x", &attrs, false, 0, &mut remaining, &mut bytes);
            if node_budget == 1 {
                assert!(matches!(
                    result,
                    Err(CollabError::ProjectionTooComplex { .. })
                ));
            } else {
                assert!(matches!(
                    result,
                    Err(CollabError::ProjectionTooLarge { .. })
                ));
            }
            assert!(runs.is_empty());
            PROJECTION_TEXT_BYTES_COPIED.with(|count| assert_eq!(count.get(), 0));
        }
    }

    #[test]
    fn a_full_body_rewrite_cannot_erase_an_unseen_concurrent_edit() {
        const RESOLVED: &str = "resolved";

        let base = Ydoc::wire();
        base.richdoc_append_paragraph("base");
        let base_state = base.encode_full_state();

        let origin = Ydoc::wire();
        origin.apply(&base_state).expect("origin accepts base");
        let peer = Ydoc::wire();
        peer.apply(&base_state).expect("peer accepts base");
        peer.richdoc_append_paragraph("peer unseen edit");

        let rewrite = origin
            .rewrite_content_to_markdown(ContentKind::Richdoc, RESOLVED)
            .expect("rewrite");
        peer.apply(&rewrite).expect("peer accepts rewrite");
        origin
            .apply(&peer.encode_full_state())
            .expect("origin accepts peer union");
        peer.apply(&origin.encode_full_state())
            .expect("peer accepts origin union");

        let projection = peer
            .project(ContentKind::Richdoc)
            .expect("peer projection")
            .content;
        assert_ne!(projection, RESOLVED);
        assert!(projection.contains("peer unseen edit"));
    }

    #[test]
    fn a_fresh_successor_is_stable_distinct_and_keeps_its_epoch_immutable() {
        let key = crate::DocKey::new("ws", "main", "object-one").expect("valid key");
        let chosen = "# Chosen\n\nExact body\n";
        let chosen_sha = crate::hex_sha256(chosen.as_bytes());
        let predecessor_state_vector_sha = "b".repeat(64);
        let artifact_preimage_sha = "c".repeat(64);
        let predecessor_claim_id = "a".repeat(64);
        let first_identity = SuccessorIdentity::derive(SuccessorIdentityInput {
            key: &key,
            predecessor_claim_id: &predecessor_claim_id,
            predecessor_state_vector_sha256: &predecessor_state_vector_sha,
            artifact_op_kind: "moment.append",
            artifact_id: "moment-one",
            artifact_preimage_sha256: &artifact_preimage_sha,
            content_kind: ContentKind::Richdoc,
            result_sha256: &chosen_sha,
        });
        let same_identity = SuccessorIdentity::derive(SuccessorIdentityInput {
            key: &key,
            predecessor_claim_id: &predecessor_claim_id,
            predecessor_state_vector_sha256: &predecessor_state_vector_sha,
            artifact_op_kind: "moment.append",
            artifact_id: "moment-one",
            artifact_preimage_sha256: &artifact_preimage_sha,
            content_kind: ContentKind::Richdoc,
            result_sha256: &chosen_sha,
        });
        let next_identity = SuccessorIdentity::derive(SuccessorIdentityInput {
            key: &key,
            predecessor_claim_id: &predecessor_claim_id,
            predecessor_state_vector_sha256: &predecessor_state_vector_sha,
            artifact_op_kind: "moment.append",
            artifact_id: "moment-two",
            artifact_preimage_sha256: &artifact_preimage_sha,
            content_kind: ContentKind::Richdoc,
            result_sha256: &chosen_sha,
        });
        let other_vector = "d".repeat(64);
        let other_vector_identity = SuccessorIdentity::derive(SuccessorIdentityInput {
            key: &key,
            predecessor_claim_id: &predecessor_claim_id,
            predecessor_state_vector_sha256: &other_vector,
            artifact_op_kind: "moment.append",
            artifact_id: "moment-one",
            artifact_preimage_sha256: &artifact_preimage_sha,
            content_kind: ContentKind::Richdoc,
            result_sha256: &chosen_sha,
        });
        let other_preimage = "e".repeat(64);
        let other_preimage_identity = SuccessorIdentity::derive(SuccessorIdentityInput {
            key: &key,
            predecessor_claim_id: &predecessor_claim_id,
            predecessor_state_vector_sha256: &predecessor_state_vector_sha,
            artifact_op_kind: "moment.append",
            artifact_id: "moment-one",
            artifact_preimage_sha256: &other_preimage,
            content_kind: ContentKind::Richdoc,
            result_sha256: &chosen_sha,
        });

        let first = fresh_successor_base(&first_identity, chosen).expect("first successor");
        let replay = fresh_successor_base(&same_identity, chosen).expect("same successor");
        let next = fresh_successor_base(&next_identity, chosen).expect("next successor");
        let other_vector =
            fresh_successor_base(&other_vector_identity, chosen).expect("other vector successor");
        let other_preimage = fresh_successor_base(&other_preimage_identity, chosen)
            .expect("other preimage successor");

        assert_eq!(first, replay, "the same identity has one byte-stable base");
        assert_ne!(
            first.lineage_claim_id, next.lineage_claim_id,
            "distinct epochs with equal text have distinct claims"
        );
        assert_ne!(
            first.lineage_claim_id, other_vector.lineage_claim_id,
            "the predecessor state vector is part of successor identity"
        );
        assert_ne!(
            first.lineage_claim_id, other_preimage.lineage_claim_id,
            "the artifact preimage is part of successor identity"
        );
        let loaded = Ydoc::wire();
        loaded.apply(&first.update).expect("load successor base");
        assert_eq!(
            loaded
                .project(ContentKind::Richdoc)
                .expect("projection")
                .content,
            chosen
        );
        assert_eq!(
            loaded.lineage_epoch_tag().as_deref(),
            Some(first.epoch_tag.as_str())
        );

        let plain_predecessor = "c".repeat(64);
        let plain_vector = "d".repeat(64);
        let plain_preimage = "e".repeat(64);
        let plain_result = crate::hex_sha256(b"plain text\nwith an exact second line");
        let plain_identity = SuccessorIdentity::derive(SuccessorIdentityInput {
            key: &key,
            predecessor_claim_id: &plain_predecessor,
            predecessor_state_vector_sha256: &plain_vector,
            artifact_op_kind: "moment.append",
            artifact_id: "moment-plain",
            artifact_preimage_sha256: &plain_preimage,
            content_kind: ContentKind::Plaintext,
            result_sha256: &plain_result,
        });
        let plain_text = "plain text\nwith an exact second line";
        let plain = fresh_successor_base(&plain_identity, plain_text).expect("plain successor");
        let plain_replay =
            fresh_successor_base(&plain_identity, plain_text).expect("plain successor replay");
        assert_eq!(plain, plain_replay);
        let loaded_plain = Ydoc::wire();
        loaded_plain
            .apply(&plain.update)
            .expect("load plain successor base");
        assert_eq!(
            loaded_plain
                .project(ContentKind::Plaintext)
                .expect("plain projection")
                .content,
            plain_text
        );

        let mismatched_result = "0".repeat(64);
        let mismatched_identity = SuccessorIdentity::derive(SuccessorIdentityInput {
            key: &key,
            predecessor_claim_id: &predecessor_claim_id,
            predecessor_state_vector_sha256: &predecessor_state_vector_sha,
            artifact_op_kind: "moment.append",
            artifact_id: "moment-mismatched",
            artifact_preimage_sha256: &artifact_preimage_sha,
            content_kind: ContentKind::Richdoc,
            result_sha256: &mismatched_result,
        });
        let error = fresh_successor_base(&mismatched_identity, chosen)
            .expect_err("the artifact result digest must match the canonical text");
        assert!(matches!(
            error,
            CollabError::SuccessorResultMismatch { expected, observed }
                if expected == "0".repeat(64) && observed == chosen_sha
        ));

        let changer = Ydoc::wire();
        changer.apply(&first.update).expect("load changer base");
        let change_meta = changer.doc.get_or_insert_map(ROOT_META);
        let changed = changer.with_delta(|txn| {
            change_meta.insert(txn, LINEAGE_EPOCH_META_KEY, "forged-epoch");
        });
        let remover = Ydoc::wire();
        remover.apply(&first.update).expect("load remover base");
        let remove_meta = remover.doc.get_or_insert_map(ROOT_META);
        let removed = remover.with_delta(|txn| {
            remove_meta.remove(txn, LINEAGE_EPOCH_META_KEY);
        });

        for update in [changed, removed] {
            let victim = Ydoc::wire();
            victim.apply(&first.update).expect("load victim base");
            let before = victim.encode_full_state();
            let error = victim
                .apply_preserving_lineage_epoch(&update, &first.epoch_tag)
                .expect_err("a delta cannot change or remove the lineage epoch");
            assert_eq!(error.code(), "lineage-epoch-changed");
            assert_eq!(
                victim.encode_full_state(),
                before,
                "the refusal is state-unchanged"
            );
        }
    }

    #[test]
    fn raw_html_text_settles_as_inert_text_the_importer_reopens() {
        const SETTLED: &str = concat!(
            "Lit &lt;span title&#61;&#34;q &#39;é&#39; &amp;&#35;92&#59;&#34;&gt;&#92;&#42; ",
            "&#123;&#123;atom&#58;a&#125;&#125; https&#58;//in&#46;example/a&#95;b ",
            "www&#46;in&#46;example a&#64;b&#46;co &lt;https&#58;//auto&#46;example&gt; ",
            "&amp;&#35;123&#59;**x**&#42; &#32;\nnext&lt;/span&gt; and ",
            "[out](https://out.example) end {{atom:rate 150}} ü.",
            "\n\n",
            "==&lt;b&gt;a\\=b &#92;&#42;c&lt;/b&gt;==",
            "\n\n",
            "code `<b>*x*</b>`",
            "\n\n",
            "&lt;!&#45;&#45; &#36;x&#36; &#61;&#61;y&#61;&#61; &#45;&#45;&gt; $z$.",
            "\n\n",
            "&lt;b&gt;x&lt;/b&gt; &amp;&#35;123&#59; &amp;&#35;92&#59; &lt;i&gt;y&lt;/i&gt;",
            "\n\n",
            "&lt;!&#45;&#45; a&#58; b&#44;\n&#10; \t\n&#123;&#123;atom&#58;a&#125;&#125; ",
            "&#92;&#42; https&#58;//in&#46;example &#42;y&#42; &#45;&#45;&gt; **real**.",
            "\n\n",
            "**&lt;pre&gt;one\n  &#32;**\ntwo&lt;/pre&gt; and **real**.\n",
        );
        fn mark(name: &str, value: Value) -> Attrs {
            Attrs::from([(name.into(), json_to_any(&value))])
        }
        fn push_runs<F: XmlFragment>(
            txn: &mut yrs::TransactionMut<'_>,
            paragraph: &F,
            runs: Vec<(&str, Attrs)>,
        ) {
            let text = paragraph.push_back(txn, XmlTextPrelim::new(""));
            for (value, attrs) in runs {
                let at = text.len(&*txn);
                text.insert_with_attributes(txn, at, value, attrs);
            }
        }

        let source = Ydoc::wire();
        let body = source.doc.get_or_insert_xml_fragment(ROOT_BODY);
        {
            let mut txn = source.doc.transact_mut();
            let [first, second, third, fourth, fifth, sixth, seventh] = std::array::from_fn(|_| {
                body.push_back(
                    &mut txn,
                    XmlElementPrelim::new("paragraph", std::iter::empty::<XmlIn>()),
                )
            });
            push_runs(
                &mut txn,
                &first,
                vec![
                    (
                        "Lit <span title=\"q 'é' &#92;\">\\* {{atom:a}} https://in.example/a_b \
                         www.in.example a@b.co <https://auto.example> &#123;",
                        Attrs::new(),
                    ),
                    ("x", mark("bold", json!({}))),
                    ("*  \nnext</span> and ", Attrs::new()),
                    (
                        "out",
                        mark(
                            "link",
                            json!({
                                "href": "https://out.example",
                                "target": "_blank",
                                "rel": "noopener noreferrer nofollow",
                                "class": null,
                                "title": null,
                            }),
                        ),
                    ),
                    (" end ", Attrs::new()),
                ],
            );
            first.push_back(
                &mut txn,
                xml_element(
                    "inlineAtom",
                    &[
                        ("atomId", "rate"),
                        ("params", "150"),
                        ("source", "atom:rate 150"),
                    ],
                    std::iter::empty::<XmlIn>(),
                ),
            );
            push_runs(&mut txn, &first, vec![(" ü.", Attrs::new())]);
            push_runs(
                &mut txn,
                &second,
                vec![("<b>a=b \\*c</b>", mark("highlight", json!({})))],
            );
            push_runs(
                &mut txn,
                &third,
                vec![
                    ("code ", Attrs::new()),
                    ("<b>*x*</b>", mark("code", json!({}))),
                ],
            );
            push_runs(
                &mut txn,
                &fourth,
                vec![("<!-- $x$ ==y== --> ", Attrs::new())],
            );
            fourth.push_back(
                &mut txn,
                xml_element("mathInline", &[("tex", "z")], std::iter::empty::<XmlIn>()),
            );
            push_runs(&mut txn, &fourth, vec![(".", Attrs::new())]);
            push_runs(
                &mut txn,
                &fifth,
                vec![("<b>x</b> &#123; &#92; <i>y</i>", Attrs::new())],
            );
            push_runs(
                &mut txn,
                &sixth,
                vec![
                    (
                        "<!-- a: b,\n\n \t\n{{atom:a}} \\* https://in.example *y* --> ",
                        Attrs::new(),
                    ),
                    ("real", mark("bold", json!({}))),
                    (".", Attrs::new()),
                ],
            );
            push_runs(
                &mut txn,
                &seventh,
                vec![
                    ("<pre>one\n   ", mark("bold", json!({}))),
                    ("\ntwo</pre> and ", Attrs::new()),
                    ("real", mark("bold", json!({}))),
                    (".", Attrs::new()),
                ],
            );
        }
        let settled = Ydoc::wire();
        settled
            .apply(&source.encode_full_state())
            .expect("test update is valid");
        assert_eq!(
            settled
                .project(ContentKind::Richdoc)
                .expect("projection")
                .content,
            SETTLED
        );
    }

    // Markdown reads no delimiter beside only whitespace as a mark, so it
    // would read back as literal asterisks. The TypeScript writer's tests have
    // the same cases.
    #[test]
    fn a_marked_run_of_only_whitespace_is_written_as_its_text() {
        fn marks(names: &[&str]) -> Attrs {
            names
                .iter()
                .map(|name| ((*name).into(), json_to_any(&json!({}))))
                .collect()
        }
        let bold = || marks(&["bold"]);
        let bold_italic = || marks(&["bold", "italic"]);
        let strike = || marks(&["strike"]);
        let cases: Vec<(Vec<(&str, Attrs)>, &str)> = vec![
            (
                vec![("a", Attrs::new()), (" ", bold()), ("b", Attrs::new())],
                "a b\n",
            ),
            // Unlike the TypeScript writer, this one drops a paragraph's
            // trailing space, marked or not, which Markdown reads as nothing.
            (vec![("a", Attrs::new()), (" ", bold())], "a\n"),
            (
                vec![("x", bold()), (" ", bold_italic()), ("y", bold())],
                "**x y**\n",
            ),
            (
                vec![("x", bold()), (" ", bold_italic()), ("y", Attrs::new())],
                "**x** y\n",
            ),
            (
                vec![("x", Attrs::new()), (" ", bold_italic()), ("y", bold())],
                "x **y**\n",
            ),
            (
                vec![("a", Attrs::new()), (" ", strike()), ("b", Attrs::new())],
                "a b\n",
            ),
            (
                vec![("a", Attrs::new()), ("\t", bold()), ("b", Attrs::new())],
                "a\tb\n",
            ),
            (vec![(" ", bold()), ("b", Attrs::new())], "&#32;b\n"),
            // Written as a reference, it is no longer whitespace, so it keeps
            // its mark.
            (
                vec![("a", Attrs::new()), ("\u{a0}", bold()), ("b", Attrs::new())],
                "a**&#160;**b\n",
            ),
            // The underline opens on the space, outside the italic. Opened
            // with the italic at the text, it would read back as asterisks.
            (
                vec![
                    ("x", bold_italic()),
                    (" ", marks(&["bold", "underline"])),
                    ("y", marks(&["bold", "italic", "underline"])),
                ],
                "***x* ++*y*++**\n",
            ),
            (
                vec![
                    ("x", bold()),
                    (" ", bold()),
                    (" ", bold_italic()),
                    ("y", Attrs::new()),
                ],
                "**x**  y\n",
            ),
            (
                vec![
                    ("x", Attrs::new()),
                    (" ", bold_italic()),
                    (" ", bold()),
                    ("y", bold()),
                ],
                "x  **y**\n",
            ),
            (
                vec![("x ", bold()), (" ", bold_italic()), ("y", Attrs::new())],
                "**x**  y\n",
            ),
            (
                vec![
                    ("a", marks(&["italic"])),
                    (" ", bold_italic()),
                    ("b", bold()),
                ],
                "*a* **b**\n",
            ),
            (
                vec![("x", Attrs::new()), (" ", bold_italic()), (" y", bold())],
                "x  **y**\n",
            ),
        ];
        for (runs, expected) in cases {
            let source = Ydoc::wire();
            let body = source.doc.get_or_insert_xml_fragment(ROOT_BODY);
            {
                let mut txn = source.doc.transact_mut();
                let paragraph = body.push_back(
                    &mut txn,
                    XmlElementPrelim::new("paragraph", std::iter::empty::<XmlIn>()),
                );
                let text = paragraph.push_back(&mut txn, XmlTextPrelim::new(""));
                for (value, attrs) in runs {
                    let at = text.len(&txn);
                    text.insert_with_attributes(&mut txn, at, value, attrs);
                }
            }
            assert_eq!(
                source
                    .project(ContentKind::Richdoc)
                    .expect("projection")
                    .content,
                expected
            );
        }
    }

    #[test]
    fn a_table_cell_keeps_the_white_space_in_its_code() {
        let save = |markdown: &str| {
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, markdown)
                .expect("richdoc rewrite");
            doc.project(ContentKind::Richdoc)
                .expect("projection")
                .content
        };
        // A `\`` opens no span. The writer collapses the spaces around the
        // code, which reads back as other text, so the table keeps its
        // source.
        let source = "| h |\n|---|\n| `  a  `  x \\`  y  ``b  `  c`` |\n";
        assert_eq!(save(source), source);
        let written = save("| h |\n|---|\n| `  a  ` x \\` y ``b  `  c`` |\n");
        assert!(
            written.contains("| `  a  ` x \\` y ``b  `  c`` |"),
            "{written}"
        );
        assert_eq!(save(&written), written);
    }

    #[test]
    fn a_table_cell_br_bounds_no_raw_html_span() {
        let doc = remote_doc_with_body([xml_element(
            "table",
            &[],
            [
                xml_element(
                    "tableRow",
                    &[],
                    [xml_element("tableHeader", &[], [paragraph("H")])],
                ),
                xml_element(
                    "tableRow",
                    &[("height", "84")],
                    [xml_element(
                        "tableCell",
                        &[],
                        [paragraph("a<br>b &#124; <b>*x*</b>")],
                    )],
                ),
            ],
        )]);
        let projected = doc
            .project(ContentKind::Richdoc)
            .expect("projection")
            .content;
        assert!(
            projected.contains("| a<br>b &amp;#124; &lt;b&gt;&#42;x&#42;&lt;/b&gt; |"),
            "{projected}"
        );
        // The fold reads the cell back to the same text, and so the same bytes.
        let folded = Ydoc::wire();
        folded
            .rewrite_content_to_markdown(ContentKind::Richdoc, &projected)
            .expect("richdoc rewrite");
        assert_eq!(
            folded
                .project(ContentKind::Richdoc)
                .expect("projection")
                .content,
            projected
        );
        let body = serde_json::to_string(&folded.canonical_content()["body"]).expect("body json");
        assert!(body.contains("a<br>b &#124; <b>*x*</b>"), "{body}");
    }

    #[test]
    fn an_empty_text_piece_leaves_the_saved_markdown_as_it_was() {
        fn saved(pieces: bool) -> String {
            let doc = Ydoc::wire();
            let body = doc.doc.get_or_insert_xml_fragment(ROOT_BODY);
            {
                let mut txn = doc.doc.transact_mut();
                let first = body.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
                first.push_back(&mut txn, XmlTextPrelim::new("One."));
                // An empty piece beside a line break, on either side of it.
                for (before, after) in [("", ""), ("Two.", ""), ("", "Three.")] {
                    let line = body.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
                    if !before.is_empty() {
                        line.push_back(&mut txn, XmlTextPrelim::new(before));
                    } else if pieces && !after.is_empty() {
                        line.push_back(&mut txn, XmlTextPrelim::new(""));
                    }
                    line.push_back(&mut txn, XmlElementPrelim::empty("hardBreak"));
                    if !after.is_empty() {
                        line.push_back(&mut txn, XmlTextPrelim::new(after));
                    } else if pieces {
                        line.push_back(&mut txn, XmlTextPrelim::new(""));
                    }
                }
                // Lines in a row, an empty heading between them, and empty lines at the end.
                for tag in [
                    "paragraph",
                    "paragraph",
                    "heading",
                    "paragraph",
                    "paragraph",
                ] {
                    let line = body.push_back(&mut txn, XmlElementPrelim::empty(tag));
                    if tag == "heading" {
                        line.insert_attribute(&mut txn, "level", 1i64);
                    }
                    if pieces {
                        line.push_back(&mut txn, XmlTextPrelim::new(""));
                    }
                }
            }
            doc.project_richdoc().unwrap()
        }
        let without = saved(false);
        assert!(without.contains("&nbsp;"), "{without:?}");
        assert_eq!(saved(true), without);
    }

    #[test]
    fn empty_links_stay_in_their_part() {
        const COUNT: usize = 1 << 16;
        let ampersands = "&".repeat(COUNT);
        let mixed = "&a<b>=\u{a0}".repeat(COUNT);
        let adjacent = "[](&)".repeat(COUNT);
        let spaced = "[](<>) ".repeat(COUNT);
        let plain = "[]()".repeat(COUNT);
        for (text, parts, expected) in [
            (
                format!("[](u \"{ampersands}\")"),
                1,
                format!("[](u \"{ampersands}\")"),
            ),
            (
                format!("[](u \"{mixed}\")"),
                1,
                format!("[](u \"{mixed}\")"),
            ),
            (
                format!("x [](u \"{ampersands}\") &"),
                1,
                format!("x [](u \"{ampersands}\") &amp;"),
            ),
            (adjacent.clone(), 1, adjacent.clone()),
            (format!("{spaced}x"), 1, format!("{spaced}x")),
            // A block opener reads the link as part of its line.
            ("-[](a&b)".to_owned(), 1, "-[](a&b)".to_owned()),
            // A DEL in the text is written as itself.
            (
                "\u{7f}[](u \"&\u{7f}\") \u{7f}&".to_owned(),
                1,
                "\u{7f}[](u \"&\u{7f}\") \u{7f}&amp;".to_owned(),
            ),
            (plain.clone(), 0, plain.clone()),
            ("[](u \"&\n&\")".to_owned(), 1, "[](u \"&\n&\")".to_owned()),
            // A `\r` sends the link through written references.
            (
                "[](u \"&\r&\")".to_owned(),
                1,
                "&#91;&#93;&#40;u &#34;&amp;&#13;&amp;&#34;&#41;".to_owned(),
            ),
            (
                "<b>x</b> [](u \"&\")".to_owned(),
                1,
                "&lt;b&gt;x&lt;/b&gt; [](u \"&\")".to_owned(),
            ),
        ] {
            let doc = remote_doc_with_body([paragraph(text.as_str())]);
            TEXT_RUN_BYTES_CLONED.with(|count| count.set(0));
            INLINE_PARTS_MATERIALIZED.with(|count| count.set(0));
            assert_eq!(doc.project_richdoc().unwrap(), format!("{expected}\n"));
            INLINE_PARTS_MATERIALIZED.with(|count| assert_eq!(count.get(), parts, "{text:.40}"));
            TEXT_RUN_BYTES_CLONED.with(|count| assert_eq!(count.get(), text.len()));
        }
    }

    #[test]
    fn empty_link_lines_are_written_as_they_are() {
        for (text, expected) in [
            ("[](u \"a\n2. b\")", "[](u \"a\n2. b\")"),
            (
                "[](u \"&\")[](u \"\r\")[](u \"&\")",
                "[](u \"&\")&#91;&#93;&#40;u &#34;&#13;&#34;&#41;[](u \"&\")",
            ),
            // A DEL in a link written as references is written as itself.
            (
                "[](u \"\u{7f}\n# b\") [](a&b)",
                "&#91;&#93;&#40;u &#34;\u{7f}\n&#35; b&#34;&#41; [](a&b)",
            ),
            ("[](u \"a\n[x] b\")", "[](u \"a\n[x] b\")"),
            ("[](u \"x\n    y\")", "[](u \"x\n    y\")"),
            (
                "x [](u \"a\n2. b\") y\n2. not",
                "x [](u \"a\n2. b\") y\n2&#46; not",
            ),
            // A line that would end the paragraph: the link is written as
            // references, as the importer's `writtenDefinition` writes them,
            // which the importer reads back as the same text.
            (
                "[](u \"a\n# b\")",
                "&#91;&#93;&#40;u &#34;a\n&#35; b&#34;&#41;",
            ),
            (
                "[](u \"a\n- b\")",
                "&#91;&#93;&#40;u &#34;a\n&#45; b&#34;&#41;",
            ),
            (
                "[](u \"a\n> b\")",
                "&#91;&#93;&#40;u &#34;a\n&gt; b&#34;&#41;",
            ),
            // An unhighlighted `=` is written as it is, so it could open a
            // block.
            (
                "[](u \"a\n=b\")",
                "&#91;&#93;&#40;u &#34;a\n&#61;b&#34;&#41;",
            ),
            (
                "x [](u \"a\n# b\") y\n2. not",
                "x &#91;&#93;&#40;u &#34;a\n&#35; b&#34;&#41; y\n2&#46; not",
            ),
            (
                "[](u \"*b*\n# b\")",
                "&#91;&#93;&#40;u &#34;&#42;b&#42;\n&#35; b&#34;&#41;",
            ),
            (
                "[](u \"`b`\n# b\")",
                "&#91;&#93;&#40;u &#34;&#96;b&#96;\n&#35; b&#34;&#41;",
            ),
            (
                "[](u \"&#59;\n# b\")",
                "&#91;&#93;&#40;u &#34;&amp;&#35;59&#59;\n&#35; b&#34;&#41;",
            ),
            (
                "[](https://e.example \"t\n# b\")",
                "&#91;&#93;&#40;https&#58;//e&#46;example &#34;t\n&#35; b&#34;&#41;",
            ),
            (
                "[](u \"a\\\"b \\* c\n# b\")",
                "&#91;&#93;&#40;u &#34;a&#92;&#34;b &#92;&#42; c\n&#35; b&#34;&#41;",
            ),
            (
                "[](u \"a  \n# b\")",
                "&#91;&#93;&#40;u &#34;a &#32;\n&#35; b&#34;&#41;",
            ),
            (
                "[](u \"{{atom:a}} \u{a0}x\n# b\")",
                "&#91;&#93;&#40;u &#34;&#123;&#123;atom&#58;a&#125;&#125; &#160;x\n&#35; b&#34;&#41;",
            ),
            // A closed math line, and a `\r`, which marked reads as a newline.
            (
                "[](u \"a\n$$b$$\nc\")",
                "&#91;&#93;&#40;u &#34;a\n&#36;&#36;b&#36;&#36;\nc&#34;&#41;",
            ),
            (
                "[](u \"a\n$$\nx\n$$\nc\")",
                "&#91;&#93;&#40;u &#34;a\n&#36;&#36;\nx\n&#36;&#36;\nc&#34;&#41;",
            ),
            ("[](u \"a\rb\")", "&#91;&#93;&#40;u &#34;a&#13;b&#34;&#41;"),
            (
                "x [](u \"a\rb\") y\n2. not",
                "x &#91;&#93;&#40;u &#34;a&#13;b&#34;&#41; y\n2&#46; not",
            ),
        ] {
            let doc = remote_doc_with_body([paragraph(text)]);
            assert_eq!(doc.project_richdoc().unwrap(), format!("{expected}\n"));
        }
        // A mark across a line break stays one mark.
        for (runs, expected) in [
            (
                vec![("[](u \"a\n# b\")", "bold")],
                "**&#91;&#93;&#40;u &#34;a\n&#35; b&#34;&#41;**",
            ),
            (
                vec![
                    ("before ", ""),
                    ("[](u \"a\n# b\")", "bold"),
                    (" after\n2. outside", ""),
                ],
                "before **&#91;&#93;&#40;u &#34;a\n&#35; b&#34;&#41;** after\n2&#46; outside",
            ),
            (
                vec![("[](u \"a=b\n# c\")", "highlight")],
                "==&#91;&#93;&#40;u &#34;a\\=b\n&#35; c&#34;&#41;==",
            ),
            // Another mark leaves `=` as it is, so the line still could open
            // a block.
            (
                vec![("[](u \"a\n=b\")", "bold")],
                "**&#91;&#93;&#40;u &#34;a\n&#61;b&#34;&#41;**",
            ),
            (
                vec![("before\n# heading text", "italic")],
                "*before\n&#35; heading text*",
            ),
            (
                vec![("[](u \"a\rb\")", "bold"), (" ", ""), ("y", "italic")],
                "**&#91;&#93;&#40;u &#34;a&#13;b&#34;&#41;** *y*",
            ),
            (
                vec![("[](u \"a\n$$b$$\nc\") ", ""), ("y", "italic")],
                "&#91;&#93;&#40;u &#34;a\n&#36;&#36;b&#36;&#36;\nc&#34;&#41; *y*",
            ),
        ] {
            let source = Ydoc::wire();
            let body = source.doc.get_or_insert_xml_fragment(ROOT_BODY);
            {
                let mut txn = source.doc.transact_mut();
                let paragraph = body.push_back(
                    &mut txn,
                    XmlElementPrelim::new("paragraph", std::iter::empty::<XmlIn>()),
                );
                let text = paragraph.push_back(&mut txn, XmlTextPrelim::new(""));
                for (value, mark) in runs {
                    let attrs = if mark.is_empty() {
                        Attrs::new()
                    } else {
                        Attrs::from([(mark.into(), json_to_any(&json!({})))])
                    };
                    let at = text.len(&txn);
                    text.insert_with_attributes(&mut txn, at, value, attrs);
                }
            }
            let remote = Ydoc::wire();
            remote
                .apply(&source.encode_full_state())
                .expect("valid update");
            assert_eq!(remote.project_richdoc().unwrap(), format!("{expected}\n"));
        }
        // `opens_block` errs toward yes, as the importer's `opensBlock` does.
        for (link, opens) in [
            ("[](u \"a\n# b\")", true),
            ("[](u \"a\n   - b\")", true),
            ("[](u \"a\n1) b\")", true),
            ("[](u \"a\n> [!note] t\")", true),
            ("[](u \"a\n  \nb\")", true),
            ("[](u \"a\n<div>\")", true),
            ("[](u \"a\n:-:\")", true),
            ("[](u \"a\n$$b$$\nc\")", true),
            ("[](u \"a\n   $$b$$\nc\")", true),
            ("[](u \"a\n$$\nx\n$$\nc\")", true),
            ("[](u \"a\rb\")", true),
            ("[](u \"a\n=b\")", true),
            ("[](u \"a\n   ===\")", true),
            ("[](u \"a\n2. b\")", false),
            ("[](u \"a\n    # b\")", false),
            ("[](u \"a\n    = b\")", false),
            ("[](u \"a\n[x] b\")", false),
            ("[](u \"a\na. b\")", false),
            ("[](u \"a\n\tb\")", false),
            ("[](u \"a b\")", false),
        ] {
            assert_eq!(opens_block(link, false), opens, "{link:?}");
        }
        // A highlight writes its `=` as `\=`, which opens no block, but its
        // other openers, empty lines, and `\r` still do.
        for (link, opens) in [
            ("[](u \"a\n=b\")", false),
            ("[](u \"&=\n=\")", false),
            ("[](u \"a\n   ===\")", false),
            ("[](u \"a\n# b\")", true),
            ("[](u \"a=b\n# c\")", true),
            ("[](u \"a\n  \n=\")", true),
            ("[](u \"a=\rb\")", true),
            ("[](u \"a\n    # b\")", false),
        ] {
            assert_eq!(opens_block(link, true), opens, "{link:?}");
        }
        // A link written as references makes one part for each line it keeps,
        // however many characters it writes as references.
        let dense = format!(
            "[](u \"{}\n# {}\")",
            "*".repeat(1 << 16),
            "`".repeat(1 << 16)
        );
        let doc = remote_doc_with_body([paragraph(dense.as_str())]);
        INLINE_PARTS_MATERIALIZED.with(|count| count.set(0));
        assert_eq!(
            doc.project_richdoc().unwrap(),
            format!(
                "&#91;&#93;&#40;u &#34;{}\n&#35; {}&#34;&#41;\n",
                "&#42;".repeat(1 << 16),
                "&#96;".repeat(1 << 16),
            )
        );
        // One part for each line the link keeps, and the newline between.
        INLINE_PARTS_MATERIALIZED.with(|count| assert_eq!(count.get(), 3));
        let source = Ydoc::wire();
        let body = source.doc.get_or_insert_xml_fragment(ROOT_BODY);
        {
            let mut txn = source.doc.transact_mut();
            let paragraph = body.push_back(
                &mut txn,
                XmlElementPrelim::new("paragraph", std::iter::empty::<XmlIn>()),
            );
            let text = paragraph.push_back(&mut txn, XmlTextPrelim::new(""));
            let highlight = Attrs::from([("highlight".into(), json_to_any(&json!({})))]);
            text.insert_with_attributes(&mut txn, 0, "[](u \"&=\n=\")", highlight);
        }
        let remote = Ydoc::wire();
        remote
            .apply(&source.encode_full_state())
            .expect("valid update");
        INLINE_PARTS_MATERIALIZED.with(|count| count.set(0));
        assert_eq!(
            remote.project_richdoc().unwrap(),
            "==[](u \"&\\=\n\\=\")==\n"
        );
        INLINE_PARTS_MATERIALIZED.with(|count| assert_eq!(count.get(), 1));
    }

    // The fixture generator has marked 17.0.6 read a shared corpus of links
    // with no text and definitions, which the importer reads too. Ranges and
    // lengths here are UTF-8 bytes. A text whose marked range ends between the
    // two halves of a UTF-16 surrogate pair has no UTF-8 ranges: no byte
    // boundary holds half a character. The importer checks its UTF-16 ranges;
    // this corpus is every other text.
    #[test]
    fn readers_agree_with_marked_on_the_shared_corpus() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/markedOracle.json"
        );
        let oracle: Value = serde_json::from_slice(&std::fs::read(path).expect("generated oracle"))
            .expect("oracle json");
        let expected = &oracle["expected"];
        assert_eq!(expected["marked"], "17.0.6");
        let links = expected["emptyLinks"].as_array().expect("links");
        let (checked, excluded): (Vec<&Value>, Vec<&Value>) =
            links.iter().partition(|case| !case["utf8"].is_null());
        assert!(checked.len() > 800);
        for case in &excluded {
            assert!(case["utf8Excluded"].is_string(), "{case}");
        }
        for case in checked {
            let text = case["text"].as_str().expect("text");
            let ranges: Vec<(usize, usize)> = case["utf8"]
                .as_array()
                .expect("ranges")
                .iter()
                .map(|range| {
                    let at = |index: usize| range[index].as_u64().expect("offset") as usize;
                    (at(0), at(1))
                })
                .collect();
            assert_eq!(empty_link_ranges(text), ranges, "{text:?}");
        }
        let definitions = expected["definitions"].as_array().expect("definitions");
        assert!(definitions.len() > 400);
        for case in definitions {
            let text = case["text"].as_str().expect("text");
            let length = case["utf8"].as_u64().map(|length| length as usize);
            assert_eq!(definition_len(text), length, "{text:?}");
        }
    }

    /// Whether `source` reads as the projection its own fold writes, which is
    /// the condition for keeping its spelling.
    fn reads_as_its_fold(source: &str) -> bool {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, source)
            .expect("richdoc rewrite");
        markdown_reads_alike(source, &doc.project_richdoc().expect("projection"))
    }

    fn fold(source: &str) -> String {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, source)
            .expect("richdoc rewrite");
        doc.project_richdoc().expect("projection")
    }

    #[test]
    fn a_second_fold_writes_what_the_first_wrote() {
        for (source, first) in [
            // A kept definition is written with references, which read back
            // as its text.
            (
                "- See [docs]\n\n[docs]: https://example.com",
                "- See [docs](https://example.com)\n\n&#91;docs&#93;&#58; https&#58;//example&#46;com\n",
            ),
            // A link with no text keeps its later lines without the item's
            // indentation, which the writer adds back.
            ("- x [](u \"a\n  2. b\")", "- x [](u \"a\n  2. b\")\n"),
            ("3. x [](u \"a\n   2. b\")", "3. x [](u \"a\n   2. b\")\n"),
            // A space reference after a quote marker is the space it spells.
            ("> q\n> &#32;   code", "> q\n> &#32;   code\n"),
        ] {
            assert_eq!(fold(source), first, "{source:?}");
            assert_eq!(fold(first), first, "{source:?}");
        }
    }

    /// A note that starts with blank lines reads them as empty paragraphs.
    /// Frontmatter added above it with its source writes those lines once.
    #[test]
    fn frontmatter_added_above_leading_blank_lines_keeps_its_source() {
        let original =
            "\n\n| Key | Value |\n| --- | --- |\n| generated |  |\n\n\n\n**bold** _italic_";
        {
            let adopted = format!("---\nid: 01j00000000000000000000000\n---\n\n{original}");
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, original)
                .expect("richdoc rewrite");
            doc.frontmatter_set_preserving_markdown_source(
                "id",
                "01j00000000000000000000000",
                &adopted,
            )
            .expect("frontmatter set");
            let canonical = doc.project_richdoc().expect("projection");
            assert_eq!(
                doc.preserved_markdown_source(&canonical).as_deref(),
                Some(adopted.as_str()),
                "{canonical:?}"
            );
        }
    }

    /// A raw tag that closes takes the pieces since it opened into one run,
    /// with any `&lt;` or `[` among them.
    #[test]
    fn a_reference_or_bracket_inside_a_closed_tag_is_part_of_its_run() {
        for source in [
            "<b>&lt;x</b>",
            "<b>&lt;x</b> &lt;y&gt; <i>&gt;</i>",
            "<b>[x</b> y",
            "<b>[&lt;x</b> [y]\n\n[y]: https://example.com",
        ] {
            let first = fold(source);
            assert_eq!(fold(&first), first, "{source:?}");
        }
    }

    #[test]
    fn a_kept_reference_reads_unlike_its_escaped_projection() {
        for (source, alike) in [
            ("&lt;x&gt;&#92;&#123;&#58;&#32;y&lt;/x&gt;", true),
            ("&lt;x&gt;&amp;&#35;123&#59;&lt;/x&gt;", true),
            ("&lt;!&#45;&#45; a\n&#10;b &#45;&#45;&gt;", true),
            ("Map<K, V>", true),
            ("<x>a</x> &#123; <y>b</y>", false),
            ("&#123; and &lt;x&gt;", false),
            ("&#10; and &lt;x&gt;", false),
            ("&lt;x&gt;&#8203;&lt;/x&gt;", false),
            ("Map<K, &#59; V>", false),
            ("a <b, &#59; c> d", false),
            ("&lt;b&gt;x&lt;/b&gt; &#59; 3 > 2", false),
        ] {
            assert_eq!(reads_as_its_fold(source), alike, "{source:?}");
        }
        let folded = Ydoc::wire();
        folded
            .rewrite_content_to_markdown(ContentKind::Richdoc, "Map<K, &#59; V>")
            .expect("richdoc rewrite");
        assert_eq!(
            folded.project_richdoc().expect("projection"),
            "Map&lt;K&#44; &amp;&#35;59&#59; V&gt;\n"
        );
    }

    #[test]
    fn engine_seeded_rewrites_carry_schema_version_in_the_same_update() {
        let mut fixtures = Vec::new();
        for markdown in ["", "Body\n", "---\ntitle: Plan\n---\n\nBody\n"] {
            let doc = Ydoc::wire();
            let update = doc
                .rewrite_content_to_markdown(ContentKind::Richdoc, markdown)
                .expect("rewrite");
            fixtures.push(serde_json::json!({ "markdown": markdown, "update": update }));
        }
        if let Ok(path) = std::env::var("DOHC_SEEDED_REWRITE_FIXTURE") {
            std::fs::write(path, serde_json::to_vec_pretty(&fixtures).unwrap()).unwrap();
        }
        let committed: Vec<Value> =
            serde_json::from_str(include_str!("../tests/seeded-doc-fixtures/rewrites.json"))
                .unwrap();
        assert_eq!(
            fixtures.len(),
            committed.len(),
            "rewrite fixture coverage drift"
        );
        for (fixture, saved) in fixtures.into_iter().zip(committed) {
            assert_eq!(
                fixture.as_object().unwrap().keys().collect::<Vec<_>>(),
                saved.as_object().unwrap().keys().collect::<Vec<_>>(),
                "rewrite fixture keys drift"
            );
            assert_eq!(
                fixture["markdown"], saved["markdown"],
                "rewrite input drift"
            );
            let saved_update: Vec<u8> = serde_json::from_value(saved["update"].clone()).unwrap();
            let saved_doc = Ydoc::wire();
            saved_doc.apply(&saved_update).unwrap();
            saved_doc
                .validate_public_baseline(&saved_update)
                .expect("committed rewrite admission");
            let update: Vec<u8> = serde_json::from_value(fixture["update"].clone()).unwrap();
            let replay = Ydoc::wire();
            replay
                .apply(&update)
                .expect("replay only the returned delta");
            let meta = replay.doc.get_or_insert_map(ROOT_META);
            assert_eq!(
                meta.get(&replay.doc.transact(), "schemaVersion"),
                Some(Out::Any(Any::Number(1.0)))
            );
            replay
                .validate_public_baseline(&update)
                .expect("Rust admission");
            assert_eq!(
                replay.project_richdoc().unwrap(),
                fixture["markdown"].as_str().unwrap()
            );
            // Canonical content includes roots, map keys, version, and body shape,
            // while excluding the random client identity and CRDT clocks.
            assert_eq!(
                replay.canonical_content(),
                saved_doc.canonical_content(),
                "rewrite shape drift"
            );
            assert_eq!(
                replay.project_richdoc().unwrap(),
                saved_doc.project_richdoc().unwrap(),
                "rewrite projection drift"
            );
        }
    }

    #[test]
    fn engine_seeded_rewrite_refuses_unsupported_version_without_mutation() {
        for version in [
            Any::Number(2.0),
            Any::Number(0.0),
            Any::from("1"),
            Any::Null,
            Any::Bool(true),
        ] {
            for preserve_source in [false, true] {
                let doc = Ydoc::wire();
                doc.rewrite_content_to_markdown(
                    ContentKind::Richdoc,
                    "---\ntitle: Keep\n---\n\nOriginal",
                )
                .unwrap();
                let meta = doc.doc.get_or_insert_map(ROOT_META);
                meta.insert(
                    &mut doc.doc.transact_mut(),
                    "schemaVersion",
                    version.clone(),
                );
                let before = doc.encode_full_state();
                let vector = doc.encode_state_vector();
                let result = if preserve_source {
                    doc.rewrite_content_to_markdown_preserving_source(
                        ContentKind::Richdoc,
                        "Changed",
                    )
                } else {
                    doc.rewrite_content_to_markdown(ContentKind::Richdoc, "Changed")
                };
                assert!(result.is_err(), "unsupported {version:?}");
                assert_eq!(doc.encode_full_state(), before);
                assert_eq!(doc.encode_state_vector(), vector);
            }
        }
    }

    /// Binds `source` to the document's current projection, as a crafted
    /// update from any collaborator can.
    fn witness_source(doc: &Ydoc, source: &str) -> String {
        let canonical = doc.project_richdoc().expect("projection");
        let meta = doc.doc.get_or_insert_map(ROOT_META);
        let mut txn = doc.doc.transact_mut();
        meta.insert(&mut txn, "schemaVersion", Any::Number(1.0));
        meta.insert(&mut txn, MARKDOWN_SOURCE_META_KEY, source);
        meta.insert(
            &mut txn,
            MARKDOWN_SOURCE_SHA_META_KEY,
            crate::hex_sha256(source.as_bytes()),
        );
        meta.insert(
            &mut txn,
            MARKDOWN_SOURCE_PROJECTION_SHA_META_KEY,
            crate::hex_sha256(canonical.as_bytes()),
        );
        canonical
    }

    #[test]
    fn a_source_with_content_the_document_lacks_is_not_preserved() {
        for (document, forged) in [
            // A row with more cells than the header keeps its extra cell.
            (
                "| a | b |\n|---|---|\n| c | d |",
                "a | b\n--- | ---\nc | d | hidden\n",
            ),
            ("- one\n- two", "* one\n* two\n* hidden\n"),
            ("Install:\n\n&#32;   npm i foo", "Install:\n\n    npm i foo"),
            ("1. one\n2. two", "1) one\n\n1) two, hidden\n"),
            // Each source below spells, as syntax, text the document holds:
            // a heading in a list item, an HTML comment that ends a table
            // and hides a row, a link reference definition, raw HTML, an
            // autolink, and a character reference the importer decodes.
            ("- \\# Title", "- # Title\n"),
            (
                "- [x]: https://example.com/private",
                "* [x]: https://example.com/private\n",
            ),
            (
                "| a |\n|---|\n| <!-- x |\n| secret |\n| --> |",
                "| a |\n|---|\n<!-- x |\nsecret |\n--> |\n",
            ),
            ("[x]: https://example.com", "[x]: https://example.com\n"),
            ("Hello <b>hidden</b> world", "Hello <b>hidden</b> world\n"),
            ("see <https://example.com>", "see <https://example.com>\n"),
            ("a &quot; b", "a &quot; b\n"),
            // A cell's `<br>` spelled `&lt;br&gt;` cannot pay for a comment
            // or an element elsewhere.
            (
                "| a |\n|---|\n| <br> |\n\n<!-- secret -->",
                "| a |\n|---|\n| &lt;br&gt; |\n\n<!-- secret -->\n",
            ),
            (
                "| a |\n|---|\n| <br> |\n\n<img src=https://evil.example/p>",
                "| a |\n|---|\n| &lt;br&gt; |\n\n<img src=https://evil.example/p>\n",
            ),
        ]
        .into_iter()
        .chain(
            // Raw HTML a renderer hides or acts on, although its name is no
            // HTML element, and references a renderer decodes to characters
            // a reader does not see as written. The document holds each as
            // text.
            [
                "`c`\n\n<x onmouseover=alert(1)>hover</x>",
                "`c`\n\n<!-- secret -->",
                "Approve <?and wire the deposit to 4471?> the invoice",
                "Approve <!note text here> the invoice",
                "Approve <![CDATA[wire the deposit]]> the invoice",
                "a <x hidden>secret</x> b",
                "<x-y style=\"background:url(https://evil.example/p)\">",
                "<x onmouseover=alert(1)>hover</x>",
                "<x hidden>\nsecret",
                "invoice&#x202E;fdp.exe",
                "a&#8203;b",
                "a &LT;b&GT; c",
                "&#49;&#48;&#48;",
                "a&nbsp;b",
            ]
            .map(|text| (text, text)),
        ) {
            let forged = &format!("{forged}\n");
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, document)
                .expect("richdoc rewrite");
            let canonical = witness_source(&doc, forged);
            assert_eq!(
                doc.preserved_markdown_source(&canonical),
                None,
                "{forged:?}"
            );
            // The baseline stays usable; its projection is the document.
            assert!(
                doc.validate_public_baseline(&doc.encode_full_state())
                    .is_ok(),
                "{forged:?}"
            );
            assert_eq!(doc.project_richdoc().unwrap(), canonical, "{forged:?}");
        }
    }

    /// A renderer reads markup inside a tag that the document holds as text:
    /// a reference it decodes, a link, an image. It hides a link reference
    /// definition, which the document shows. None of these sources is kept.
    #[test]
    fn a_source_a_renderer_shows_unlike_its_document_is_not_kept() {
        let kept: Vec<_> = [
            "<x>invoice&#x202E;fdp.exe</x>",
            "<x>\ninvoice&#x202E;fdp.exe",
            "<x>[Pay](https://evil.example)</x>",
            "<x>![](https://tracker.example/p)</x>",
            "<x>https://evil.example</x>",
            "<x>mail pay@evil.example</x>",
            "<x>see www.evil.example</x>",
            "[x]: https://e.example \"Approve wire 4471\"",
            "See [x].\n\n[x]: https://e.example \"Approve wire 4471\"",
        ]
        .into_iter()
        .filter(|source| {
            let source = &format!("{source}\n");
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, source)
                .expect("richdoc rewrite");
            let canonical = witness_source(&doc, source);
            doc.preserved_markdown_source(&canonical).is_some()
        })
        .collect();
        assert!(kept.is_empty(), "{kept:?}");
    }

    /// A renderer decodes these references to characters a reader does not
    /// see as written, so a source that spells one never keeps its spelling.
    #[test]
    fn a_source_with_a_rendered_reference_reads_unlike_its_fold() {
        #[derive(serde::Deserialize)]
        struct Vector {
            text: String,
            references: Vec<String>,
        }
        let vectors: Vec<Vector> = serde_json::from_str(include_str!(
            "../tests/owner-source/rendered-references.json"
        ))
        .expect("vectors");
        for vector in vectors {
            assert_eq!(
                reads_as_its_fold(&vector.text),
                vector.references.is_empty(),
                "{:?}",
                vector.text
            );
        }
    }

    #[test]
    fn a_source_whose_text_reads_as_plain_text_is_preserved() {
        for source in [
            "Tom & Jerry, 5 > 3 and 2 < 4\n\n* one\n* two\n",
            "A setext heading\n================\n\n* first\n* second\n",
            // The projector escapes these, and the importer reads them as
            // the same text.
            "[WIP] fix\n",
            "Vec<T> and cmd <file>\n",
            "a &copy; b\n",
            "1. one\n7. two\n",
            "1. a\n3. b\n",
            "| a |\n|---|\n| x&lt;br&gt;y |\n",
            // A tag without attributes and another name stays text, in
            // the block it opens in and the one it closes in.
            "a <x> b </x-y>\n",
            "<x>Title.\n===\n</x>\n",
            // Its content is raw HTML to the importer, which the projector
            // writes with references that read back as the same text. A
            // renderer links a URL there, so that source is not kept.
            "a <x>{{atom:a}} a_b</x>\n",
        ] {
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, source)
                .expect("richdoc rewrite");
            let canonical = witness_source(&doc, source);
            assert_ne!(canonical, source);
            assert_eq!(
                doc.preserved_markdown_source(&canonical).as_deref(),
                Some(source),
                "{source:?} projects as {canonical:?}"
            );
        }
    }

    #[test]
    fn resolution_fold_reconstructs_rich_structure_and_projection() {
        // The fold must parse the chosen markdown into the projection's own
        // schema: the projection reproduces the chosen bytes and the body
        // holds real nodes, not literal syntax inside paragraphs.
        let doc = Ydoc::wire();
        doc.richdoc_append_paragraph("old content");
        let chosen = "---
title: Chosen
---

# Heading

plain para
second line

> quoted para

- one
- two

1. first
2. second

- [x] done
- [ ] todo

```rust
fn main() {}
```

---

| a   | b   |
| --- | --- |\n";
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, chosen)
            .expect("richdoc rewrite");
        let projected = doc.project(ContentKind::Richdoc).expect("projection");
        assert_eq!(
            projected.content, chosen,
            "the folded document projects the chosen bytes back"
        );
        let body = serde_json::to_string(&doc.canonical_content()["body"]).expect("body json");
        for tag in [
            "heading",
            "blockquote",
            "bulletList",
            "orderedList",
            "taskList",
            "codeBlock",
            "horizontalRule",
            "table",
        ] {
            assert!(
                body.contains(tag),
                "the fold must rebuild {tag} nodes, got {body}"
            );
        }
        let frontmatter =
            serde_json::to_string(&doc.canonical_content()["frontmatter"]).expect("fm json");
        assert!(
            frontmatter.contains("Chosen"),
            "frontmatter scalars are parsed, got {frontmatter}"
        );
    }

    /// A collaborator can write any frontmatter source. One too deep, too
    /// large, or too costly to expand must refuse settlement.
    #[test]
    fn hostile_frontmatter_sources_refuse_settlement() {
        let ladder = (0..6)
            .map(|level| {
                let item = if level == 0 {
                    "x".to_owned()
                } else {
                    format!("*l{}", level - 1)
                };
                format!("l{level}: &l{level} [{}]\n", vec![item; 10].join(", "))
            })
            .collect::<String>();
        let oversized = format!(
            "---\ntitle: Plan\npadding: '{}'\n---\n\n",
            "x".repeat(crate::limits::MAX_PUBLIC_MARKDOWN_BYTES)
        );
        for source in [
            format!("---\ntitle:\n{}Plan\n---\n\n", "- ".repeat(500_000)),
            format!(
                "---\ntitle:\n{}Plan{}\n---\n\n",
                "[".repeat(500_000),
                "]".repeat(500_000)
            ),
            format!(
                "---\n%TAG !e! tag:{}\n--- # x\ntitle: [{}Plan]\n---\n\n",
                "x".repeat(512 * 1024),
                "!e!x a, ".repeat(100_000)
            ),
            format!(
                "---\ns: &s \"{}\"\ntitle: {}{}{}\n---\n\n",
                "x".repeat(1_900_000),
                "&a [".repeat(128),
                vec!["*s"; 256].join(", "),
                "]".repeat(128)
            ),
            format!(
                "---\ns: &s \"{}\"\ntitle: [{}]\n---\n\n",
                "x".repeat(2_000_000),
                vec!["*s"; 256].join(", ")
            ),
            format!("---\n{ladder}title: Plan\n---\n\n"),
            oversized,
        ] {
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, "---\ntitle: Plan\n---\n\nBody")
                .unwrap();
            let meta = doc.doc.get_or_insert_map(ROOT_META);
            meta.insert(
                &mut doc.doc.transact_mut(),
                FRONTMATTER_SOURCE_META_KEY,
                source.as_str(),
            );
            assert!(matches!(
                doc.project_richdoc(),
                Err(CollabError::FrontmatterEditRefused)
            ));
            if source.len() > crate::limits::MAX_PUBLIC_MARKDOWN_BYTES {
                assert!(doc
                    .validate_public_baseline(&doc.encode_full_state())
                    .is_err());
            }
        }
    }

    #[test]
    fn shared_frontmatter_edit_candidates() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../tests/live-bootstrap-fixtures/frontmatter-edits.json"
        ))
        .unwrap();
        for vector in vectors.as_array().unwrap() {
            let doc = Ydoc::wire();
            let markdown = vector["markdown"].as_str().unwrap();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, markdown)
                .unwrap();
            let before = doc.encode_full_state();
            let result =
                doc.frontmatter_set_value(vector["key"].as_str().unwrap(), vector["value"].clone());
            if vector["refused"] == true {
                assert!(
                    matches!(result, Err(CollabError::FrontmatterEditRefused)),
                    "{}: {result:?}",
                    vector["name"]
                );
                assert_eq!(doc.encode_full_state(), before, "{}", vector["name"]);
                assert_eq!(doc.project_richdoc().unwrap(), markdown);
            } else {
                assert!(result.is_ok(), "{}: {result:?}", vector["name"]);
                assert_eq!(
                    doc.project_richdoc().unwrap(),
                    vector["expected"].as_str().unwrap(),
                    "{}",
                    vector["name"]
                );
            }
        }
    }

    #[test]
    fn shared_frontmatter_import_and_edit_refusal_vectors() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../tests/live-bootstrap-fixtures/live-bootstrap.json"
        ))
        .unwrap();
        for row in fixtures.as_array().unwrap() {
            if let Some(markdown) = row["bodyMarkdown"].as_str() {
                // Compare frontmatter loading without the limited test Markdown parser.
                let (values, prefix, body) = split_markdown_frontmatter(markdown);
                assert!(values.is_empty(), "{}", row["name"]);
                assert!(prefix.is_none(), "{}", row["name"]);
                assert_eq!(body, markdown, "{}", row["name"]);
            }
            let Some(source) = row["sourceMarkdown"].as_str() else {
                continue;
            };
            for from_wire in [false, true] {
                let doc = Ydoc::wire();
                if from_wire {
                    doc.apply(&serde_json::from_value::<Vec<u8>>(row["bytes"].clone()).unwrap())
                        .unwrap();
                } else {
                    doc.rewrite_content_to_markdown(ContentKind::Richdoc, source)
                        .unwrap();
                }
                assert_eq!(
                    doc.project_richdoc().unwrap(),
                    row["markdown"].as_str().unwrap(),
                    "{}",
                    row["name"]
                );
                if let Some(kept) = row["keptFrontmatter"].as_str() {
                    assert!(source.starts_with(kept), "{}", row["name"]);
                    assert!(
                        doc.project_richdoc().unwrap().starts_with(kept),
                        "{}",
                        row["name"]
                    );
                }
                if let Some(refused) = row["editsRefused"].as_bool() {
                    assert_eq!(doc.frontmatter_edits_refused(), refused, "{}", row["name"]);
                    if refused {
                        assert_eq!(doc.project_richdoc().unwrap().as_bytes(), source.as_bytes());
                    }
                }
            }
        }
    }

    #[test]
    fn unsplittable_frontmatter_refuses_relation_cleanup_without_changing_bytes() {
        for yaml in [
            "{owner: rec_a, editors: [rec_a, rec_b], score: .nan}",
            "&root {owner: rec_a, editors: [rec_a, rec_b], score: .nan}",
            "!!map &root {owner: rec_a, editors: [rec_a, rec_b], score: .nan}",
            ": note\nowner: rec_a\neditors: [rec_a, rec_b]\nscore: .nan",
        ] {
            let markdown = format!("---\n{yaml}\n---\n\nBody\n");
            for exact_source in [false, true] {
                for (key, many) in [("owner", false), ("editors", true)] {
                    let doc = Ydoc::wire();
                    if exact_source {
                        doc.rewrite_content_to_markdown_preserving_source(
                            ContentKind::Richdoc,
                            &markdown,
                        )
                        .unwrap();
                    } else {
                        doc.rewrite_content_to_markdown(ContentKind::Richdoc, &markdown)
                            .unwrap();
                    }
                    assert!(doc.frontmatter_edits_refused(), "{yaml}");
                    let before = doc.encode_full_state();
                    assert!(doc
                        .frontmatter_drop_relation_target(key, "rec_a", many)
                        .is_none());
                    assert!(doc
                        .frontmatter_drop_relation_target_preserving_markdown_source(
                            key, "rec_a", many
                        )
                        .unwrap()
                        .is_none());
                    assert_eq!(doc.encode_full_state(), before, "{yaml}");
                    let projected = doc.project_richdoc().unwrap();
                    assert_eq!(projected.as_bytes(), markdown.as_bytes());
                    if exact_source {
                        assert_eq!(
                            doc.preserved_markdown_source(&projected).as_deref(),
                            Some(markdown.as_str())
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn forged_frontmatter_source_cannot_inject_body() {
        for prefix in [
            "---\npriority: !custom foreign\n---\n\n",
            "---\npriority: !custom high\n---\n\ninjected body\n",
        ] {
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown(
                ContentKind::Richdoc,
                "---\npriority: high\n---\n\nReal body",
            )
            .unwrap();
            let meta = doc.doc.get_or_insert_map(ROOT_META);
            {
                let mut txn = doc.doc.transact_mut();
                meta.insert(&mut txn, FRONTMATTER_SOURCE_META_KEY, prefix);
            }
            if prefix.contains("injected body") {
                assert!(matches!(
                    doc.project_richdoc(),
                    Err(CollabError::FrontmatterEditRefused)
                ));
            } else {
                assert_eq!(
                    doc.project_richdoc().unwrap(),
                    "---\npriority: high\n---\n\nReal body\n"
                );
            }
        }
    }

    #[test]
    fn richdoc_projection_quotes_strings_that_yaml_would_retype_or_reject() {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, "body text")
            .expect("richdoc rewrite");
        for (key, value) in [
            ("done", "true"),
            ("summary", "TODO: call Bob"),
            ("score", ".nan"),
            ("id", "99999999999999999999"),
            ("hex", "0x_1F"),
        ] {
            doc.frontmatter_set(key, value).unwrap();
        }

        let projected = doc.project(ContentKind::Richdoc).expect("projection");
        assert_eq!(
            projected.content,
            "---\nid: '99999999999999999999'\ndone: 'true'\nhex: 0x_1F\nscore: '.nan'\nsummary: 'TODO: call Bob'\n---\n\nbody text\n"
        );
        let reread = Ydoc::wire();
        reread
            .rewrite_content_to_markdown(ContentKind::Richdoc, &projected.content)
            .expect("richdoc rewrite");
        assert_eq!(reread.frontmatter_json(), doc.frontmatter_json());
    }

    #[test]
    fn a_quote_past_the_depth_budget_changes_nothing() {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, "original")
            .unwrap();
        let before = doc.encode_full_state();
        for depth in [read_markdown::MAX_QUOTES + 1, 1_000] {
            let hostile = format!("{}deep", "> ".repeat(depth));
            assert!(matches!(
                doc.rewrite_content_to_markdown(ContentKind::Richdoc, &hostile),
                Err(CollabError::MarkdownNotRepresentable)
            ));
            assert_eq!(doc.encode_full_state(), before);
        }
    }
}

#[cfg(test)]
mod owner_source_public_limits {
    use super::*;
    #[test]
    fn active_owner_source_obeys_public_output_limit_but_stale_source_remains_historical() {
        let seed: serde_json::Value =
            serde_json::from_str(include_str!("../tests/owner-source/owner-source-seed.json"))
                .unwrap();
        let bytes: Vec<u8> = serde_json::from_value(seed["bytes"].clone()).unwrap();
        for stale in [false, true] {
            let doc = Ydoc::wire();
            doc.apply(&bytes).unwrap();
            let canonical = doc.project(ContentKind::Richdoc).unwrap().content;
            let source = format!(
                "{canonical}{}",
                "\n".repeat(crate::limits::MAX_PUBLIC_MARKDOWN_BYTES)
            );
            {
                let meta = doc.doc.get_or_insert_map(ROOT_META);
                let mut tx = doc.doc.transact_mut();
                meta.insert(&mut tx, MARKDOWN_SOURCE_META_KEY, source.as_str());
                meta.insert(
                    &mut tx,
                    MARKDOWN_SOURCE_SHA_META_KEY,
                    crate::hex_sha256(source.as_bytes()),
                );
                if stale {
                    meta.insert(
                        &mut tx,
                        MARKDOWN_SOURCE_PROJECTION_SHA_META_KEY,
                        crate::hex_sha256(b"old canonical state"),
                    );
                }
            }
            assert_eq!(
                doc.validate_public_baseline(&doc.encode_full_state())
                    .is_ok(),
                stale
            );
            assert_eq!(
                doc.project(ContentKind::Richdoc).unwrap().content,
                canonical
            );
        }
    }
}

#[cfg(test)]
#[path = "ydoc/nested_source_tests.rs"]
mod nested_source_tests;

#[cfg(test)]
#[path = "ydoc/markdown_judge_tests.rs"]
mod markdown_judge_tests;
