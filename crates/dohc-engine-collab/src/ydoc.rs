//! The wire-facing yrs `Doc` wrapper and the shared dohc root schema.
//!
//! Every method here enforces the yrs interop harness's four caveats
//! (`crates/yrs-interop/README.md`) plus the shared root schema:
//!
//! 1. **`OffsetKind::Utf16` everywhere.** [`Ydoc::wire`] is the only constructor
//!    a durable/replicated doc may use; it hard-codes `OffsetKind::Utf16`. The
//!    default `OffsetKind::Bytes` is wire-unsafe against Yjs (positional
//!    divergence + a struct-store panic on non-ASCII) and is reachable only
//!    through [`Ydoc::with_mode`] with [`OffsetMode::Bytes`], which the
//!    cross-engine `offsetProbe` test uses solely to PIN the divergence.
//! 2. **Nested `Any::Map` key order is nondeterministic through a yrs re-encode.**
//!    [`Ydoc::canonical_content`] sorts every map (including nested frontmatter
//!    objects) via `BTreeMap`, and [`project_frontmatter`] sorts nested keys, so
//!    neither the semantic convergence surface nor the content projection
//!    depends on HashMap iteration order.
//! 3. **Well-formed UTF-16 at the boundary.** Rust `String` cannot hold a lone
//!    surrogate, so every string this module produces is well-formed by
//!    construction. Raw [`Ydoc::apply`] remains the permissive yrs primitive;
//!    durable callers additionally use [`crate::validate_replay_parity`] before
//!    journaling so a wire edit cannot split a multi-unit scalar.
//! 4. **Shared declared root schema; projection is destructive on the TS side.**
//!    Roots are read through the declared dohc schema ([`ROOT_FRONTMATTER`],
//!    [`ROOT_META`], [`ROOT_BODY`], [`ROOT_PLAINTEXT`], and the three scene
//!    maps) — the Yjs v1 wire carries no root kinds. The projection records
//!    provenance including a `destructive` flag.
//! 5. **yjs `applyUpdate` is not atomic on malformed input; yrs is.** The durable
//!    layer never journals bytes that failed validation: [`Ydoc::apply`] decodes
//!    the whole update before applying (a truncated update is rejected on decode,
//!    state-unchanged), and the caller only persists bytes an apply accepted.

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
mod reference_links;
mod restore_copy;
mod wikilinks;

/// The declared dohc root schema. The Yjs v1 wire format does not carry
/// root-type kinds — a root's kind is defined by typed API access — so both
/// engines must read roots through this identical declaration (spike finding 4).
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
    let item_blocks = if identity.content_kind == ContentKind::Richdoc {
        outside_markdown_allowlist(artifact).ok_or(CollabError::MarkdownNotRepresentable)?
    } else {
        false
    };
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
        doc.rewrite_content_to_markdown_as(
            identity.content_kind,
            artifact,
            MarkdownReading::Successor,
        )?;
        let projection = doc.project(identity.content_kind)?.content;
        if identity.content_kind == ContentKind::Richdoc && projection != artifact {
            if artifact.len() > crate::limits::MAX_PUBLIC_MARKDOWN_BYTES {
                return Err(CollabError::MarkdownNotRepresentable);
            }
            // Write with the deterministic client, not a staged edit's random
            // client. Installation makes this artifact the settled body.
            doc.record_validated_markdown_source_reference(artifact)?;
            if item_blocks {
                doc.preserved_markdown_source(&projection)
            } else {
                doc.settled_markdown_source(&projection, || {
                    Ok::<_, CollabError>(Some(artifact.to_owned()))
                })?
            }
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
    /// (drops PM-invalid elements), which R11b's live adapter journals as an
    /// ordinary update. Recorded so a cross-engine settle can reconcile.
    pub destructive: bool,
}

/// Digests for exact Markdown source held in the Y.Doc's reserved engine
/// metadata. The source is canonical artifact state, not a pointer into local
/// history; the projection digest invalidates it when the semantic roots move.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownSourceReference {
    pub source_sha256: String,
    pub projection_sha256: String,
}

#[cfg(test)]
pub(crate) fn main_era_flattened_list_for_test(source: &str) -> Ydoc {
    let doc = Ydoc::wire();
    let body = doc.doc.get_or_insert_xml_fragment(ROOT_BODY);
    doc.with_delta(|txn| {
        let list = body.insert(txn, 0, XmlElementPrelim::empty("bulletList"));
        let item = list.insert(txn, 0, XmlElementPrelim::empty("listItem"));
        insert_md_paragraph(txn, &item, 0, "parent");
        insert_md_paragraph(txn, &body, 1, "  - nested");
    });
    let canonical = "- parent\n\n  \\- nested";
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
    drop(txn);
    doc
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

    /// Whether `source` rebuilds `canonical_projection` under the source or
    /// projection reading. Without `reads_alike`, also try the successor
    /// reading and full reference links as desktop link marks. With it, each
    /// text block must read as its projection does; see [`markdown_reads_alike`].
    fn source_reproduces(
        &self,
        source: &str,
        canonical_projection: &str,
        reads_alike: bool,
    ) -> bool {
        [MarkdownReading::Source, MarkdownReading::Projection]
            .into_iter()
            .chain((!reads_alike).then_some(MarkdownReading::Successor))
            .any(|reading| {
                let staged = Ydoc::wire();
                if staged
                    .rewrite_content_to_markdown_checked::<false>(
                        ContentKind::Richdoc,
                        source,
                        reading,
                        FileFold::No,
                    )
                    .is_err()
                {
                    return false;
                }
                let projects_alike = || {
                    staged
                        .project_richdoc()
                        .is_ok_and(|projection| projection == canonical_projection)
                };
                (projects_alike()
                    || (!reads_alike
                        && reading == MarkdownReading::Source
                        && staged.resolve_reference_links(source)
                        && projects_alike()))
                    && (!reads_alike || markdown_reads_alike(source, canonical_projection, reading))
            })
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
            return Err(invalid());
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
                let mut preserved = ProjectionBuffer::new();
                preserved.push_str(&kept)?;
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
        self.rewrite_content_to_markdown_as(content_kind, markdown, MarkdownReading::Projection)
    }

    fn rewrite_content_to_markdown_as(
        &self,
        content_kind: ContentKind,
        markdown: &str,
        reading: MarkdownReading,
    ) -> Result<Vec<u8>, CollabError> {
        self.rewrite_content_to_markdown_checked::<true>(
            content_kind,
            markdown,
            reading,
            FileFold::No,
        )
    }

    /// Rewrite a file fold, refusing nested items and quote-depth overflow
    /// before mutation. A new fold invalidates the previous exact-source witness.
    pub fn rewrite_content_to_markdown_for_fold(
        &self,
        content_kind: ContentKind,
        markdown: &str,
    ) -> Result<Vec<u8>, CollabError> {
        self.rewrite_content_to_markdown_checked::<true>(
            content_kind,
            markdown,
            MarkdownReading::Projection,
            FileFold::Strict,
        )
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

    /// Seed a never-opened Collection relation referrer through the outside
    /// grammar and exact-source proof before it can enter a lineage.
    pub fn seed_collection_relation_markdown(&self, markdown: &str) -> Result<(), CollabError> {
        if !outside_markdown_is_allowlisted(markdown) {
            return Err(CollabError::MarkdownNotRepresentable);
        }
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
        reading: MarkdownReading,
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
                let normalized_body =
                    normalize_list_tabs(normalized_body.as_deref().unwrap_or(body), reading);
                let (blocks, refused) = parse_markdown_blocks_checked(&normalized_body, reading);
                if refused || (fold == FileFold::Strict && refused_fold_item_bodies(&blocks)) {
                    return Err(CollabError::MarkdownNotRepresentable);
                }
                if file_fold && quote_fold_overflows(&blocks, 0) {
                    return Err(CollabError::MarkdownQuoteDepthExceeded);
                }
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
                    let len = frag.len(txn);
                    if len > 0 {
                        frag.remove_range(txn, 0, len);
                    }
                    for block in blocks.iter().rev() {
                        insert_md_block::<_, WIRE_SEED>(txn, &frag, 0, block);
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

/// One block of the conflict-resolution fold's markdown parse — the subset
/// of the projection schema the fold reconstructs. Anything else stays a
/// [`MdBlock::Paragraph`]; the production fold re-projects that result and
/// refuses the resolution if it cannot reproduce the chosen bytes exactly.
#[derive(Debug, Clone, PartialEq, Eq)]
enum MdBlock<'src> {
    Heading {
        level: i64,
        text: String,
    },
    Paragraph(String),
    Quote(Vec<MdBlock<'src>>),
    BulletList(MdBulletItems<'src>),
    OrderedList {
        start: i64,
        items: Vec<MdListItem<'src>>,
    },
    TaskList(Vec<(bool, MdListItem<'src>)>),
    CodeBlock {
        language: String,
        content: String,
    },
    Rule,
    /// A GFM table. An annotated table cannot stay paragraph text, because
    /// the projector entity-encodes `<` in text, so the fold rebuilds the
    /// table the projector wrote.
    Table {
        rows: Vec<Vec<String>>,
        alignments: Vec<Option<TableAlign>>,
        row_heights: BTreeMap<usize, i64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MdListItem<'src> {
    paragraph: Box<str>,
    #[allow(
        clippy::box_collection,
        reason = "Keep flat items the size of the previous String representation"
    )]
    blocks: Option<Box<Vec<MdBlock<'src>>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum MdBulletItems<'src> {
    Plain(Vec<&'src str>),
    Blocks(Vec<MdListItem<'src>>),
}

impl<'src> MdBulletItems<'src> {
    fn len(&self) -> usize {
        match self {
            Self::Plain(items) => items.len(),
            Self::Blocks(items) => items.len(),
        }
    }

    fn iter(&self) -> impl Iterator<Item = (&str, &[MdBlock<'src>])> {
        let (plain, blocks) = match self {
            Self::Plain(items) => (Some(items), None),
            Self::Blocks(items) => (None, Some(items)),
        };
        plain
            .into_iter()
            .flatten()
            .map(|text| (*text, &[][..]))
            .chain(
                blocks
                    .into_iter()
                    .flatten()
                    .map(|item| (item.paragraph.as_ref(), item.blocks())),
            )
    }
}

impl<'src> MdListItem<'src> {
    fn blocks(&self) -> &[MdBlock<'src>] {
        self.blocks.as_deref().map_or(&[], Vec::as_slice)
    }
}

/// How [`parse_markdown_blocks`] reads Markdown that the projector may not
/// have written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarkdownReading {
    /// Rebuild an explicitly chosen conflict artifact; strict witnesses still use file readings.
    Successor,
    /// Rebuild what the projector wrote, so the result projects the same
    /// bytes back. A table without a row-height annotation stays paragraph
    /// text, which the projector reproduces verbatim, and a blank line ends a
    /// list, as it does between two lists the projector wrote.
    Projection,
    /// Read a file as the desktop's importer reads it. Every GFM table is a
    /// table, and a list continues across blank lines.
    Source,
    /// Read the projection of a document built with `Source`, to compare the
    /// two. Every GFM table is a table, and a blank line ends a list, since
    /// the projector writes one only between two lists.
    ProjectedSource,
}

/// Whether `source` reads, block by block, as `projection` does. Both are
/// parsed with `reading` and must have the same blocks. Each pair of texts
/// the engine keeps as written must then resolve to the same text and hold
/// the same syntax in the same order. See [`read_text`].
fn markdown_reads_alike(source: &str, projection: &str, reading: MarkdownReading) -> bool {
    let normalize = |markdown: &str, reading| {
        let (_, _, body) = split_markdown_frontmatter(markdown);
        let body = body.replace("\r\n", "\n");
        if reading == MarkdownReading::ProjectedSource || !body.contains('\t') {
            body
        } else {
            normalize_list_tabs(&body, reading).into_owned()
        }
    };
    let projected = match reading {
        MarkdownReading::Source => MarkdownReading::ProjectedSource,
        reading => reading,
    };
    let source_body = normalize(source, reading);
    let projected_body = normalize(projection, projected);
    let syntax_changed = encoded_tag_span(&projected_body).is_some()
        && read_text(&source_body, TextPlace::Inline).1
            != read_text(&projected_body, TextPlace::Inline).1;
    if syntax_changed {
        return false;
    }
    let (source, source_refused) = parse_markdown_blocks_checked(&source_body, reading);
    let (projection, projection_refused) =
        parse_markdown_blocks_checked(&projected_body, projected);
    !source_refused && !projection_refused && blocks_read_alike(&source, &projection)
}

fn blocks_read_alike(source: &[MdBlock<'_>], projection: &[MdBlock<'_>]) -> bool {
    let item_alike = |source: &MdListItem<'_>, projection: &MdListItem<'_>| {
        texts_read_alike(&source.paragraph, &projection.paragraph, TextPlace::Item)
            && blocks_read_alike(source.blocks(), projection.blocks())
    };
    let items_alike = |source: &[MdListItem<'_>], projection: &[MdListItem<'_>]| {
        source.len() == projection.len()
            && source
                .iter()
                .zip(projection)
                .all(|(source, projection)| item_alike(source, projection))
    };
    source.len() == projection.len()
        && source.iter().zip(projection).all(|pair| match pair {
            (MdBlock::Paragraph(source), MdBlock::Paragraph(projection)) => {
                texts_read_alike(source, projection, TextPlace::Block)
            }
            (
                MdBlock::Heading { level, text },
                MdBlock::Heading {
                    level: projected_level,
                    text: projected_text,
                },
            ) => {
                level == projected_level
                    && texts_read_alike(text, projected_text, TextPlace::Inline)
            }
            (MdBlock::Quote(source), MdBlock::Quote(projection)) => {
                blocks_read_alike(source, projection)
            }
            (MdBlock::BulletList(source), MdBlock::BulletList(projection)) => {
                source.len() == projection.len()
                    && source.iter().zip(projection.iter()).all(
                        |((source, blocks), (projected, projected_blocks))| {
                            texts_read_alike(source, projected, TextPlace::Item)
                                && blocks_read_alike(blocks, projected_blocks)
                        },
                    )
            }
            (
                MdBlock::OrderedList { start, items },
                MdBlock::OrderedList {
                    start: projected_start,
                    items: projected_items,
                },
            ) => start == projected_start && items_alike(items, projected_items),
            (MdBlock::TaskList(source), MdBlock::TaskList(projection)) => {
                source.len() == projection.len()
                    && source.iter().zip(projection).all(
                        |((checked, source), (projected, projection))| {
                            checked == projected && item_alike(source, projection)
                        },
                    )
            }
            (
                MdBlock::Table {
                    rows,
                    alignments,
                    row_heights,
                },
                MdBlock::Table {
                    rows: projected_rows,
                    alignments: projected_alignments,
                    row_heights: projected_heights,
                },
            ) => {
                alignments == projected_alignments
                    && row_heights == projected_heights
                    && rows.len() == projected_rows.len()
                    && rows.iter().zip(projected_rows).all(|(row, projected)| {
                        row.len() == projected.len()
                            && row.iter().zip(projected).all(|(cell, projected)| {
                                texts_read_alike(cell, projected, TextPlace::Cell)
                            })
                    })
            }
            (source @ (MdBlock::CodeBlock { .. } | MdBlock::Rule), projection) => {
                source == projection
            }
            _ => false,
        })
}

/// Where a run of text the engine keeps as written sits in its block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextPlace {
    /// A paragraph. Each of its lines can start a block for a reader.
    Block,
    /// A list item's text, which starts a block and then continues it.
    Item,
    /// Heading text, read inline.
    Inline,
    /// A table cell, read inline. A `<br>` here separates the cell's blocks,
    /// and the projector writes it raw however the source spelled it.
    Cell,
}

fn texts_read_alike(source: &str, projection: &str, place: TextPlace) -> bool {
    source == projection || read_text(source, place) == read_text(projection, place)
}

/// Stands for a table cell's `<br>`, however it is spelled.
const CELL_BREAK: char = '\u{E000}';

/// A character reference the desktop importer decodes. Others stay text.
fn decoded_reference(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        _ => {
            let code = name.strip_prefix('#')?.parse::<u32>().ok()?;
            matches!(
                code,
                9 | 13 | 32 | 35 | 36 | 41 | 42 | 43 | 45 | 46 | 61 | 91 | 95 | 96 | 126 | 160
            )
            .then(|| char::from_u32(code))
            .flatten()
        }
    }
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
const HTML_ELEMENTS: &str =
    "a abbr address applet area article aside audio b base basefont bdi bdo big blink \
     blockquote body br button canvas caption center cite code col colgroup data datalist dd \
     del details dfn dialog dir div dl dt em embed fieldset figcaption figure font footer \
     form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe image img \
     input ins kbd label legend li link main map mark marquee math menu meta meter nav nobr \
     noembed noframes noscript object ol optgroup option output p param picture plaintext pre \
     progress q rp rt ruby s samp script search section select slot small source span strike \
     strong style sub summary sup svg table tbody td template textarea tfoot th thead time \
     title tr track tt u ul var video wbr xmp";

/// A run of text as the importer, or a renderer, reads it: the text with
/// backslash escapes and decoded character references resolved, and, in
/// order, the syntax that makes it more than text. That syntax is a block
/// start at the start of a line, an HTML comment or element, and an
/// autolink. The projector escapes each of them where the document holds
/// text, so a source that spells one where its projection escapes it means
/// something else. A plain `&`, `<` or `>` resolves to itself, as the
/// projector's `&amp;`, `&lt;` and `&gt;` do, and inside raw HTML the
/// projector wrote as text, a decimal reference it writes there resolves to
/// its character, as the importer reads it. See [`encoded_tag_span`].
fn read_text(text: &str, place: TextPlace) -> (String, Vec<String>) {
    let mut resolved = String::with_capacity(text.len());
    let mut syntax = Vec::new();
    let tag = encoded_tag_span(text);
    if matches!(place, TextPlace::Block | TextPlace::Item) {
        // A list item's text starts a paragraph too, so a link reference
        // definition can open it.
        for (index, line) in text.split('\n').enumerate() {
            let starts = index == 0;
            if !starts
                && !line.trim_start().starts_with('-')
                && list_marker(line.trim_start(), MarkdownReading::ProjectedSource).is_some_and(
                    |m| m.text.trim().is_empty() && !matches!(m.kind, ListKind::Task(_)),
                )
            {
                continue;
            }
            if let Some(kind) = block_start(line, starts, starts) {
                syntax.push(format!("line {index}: {kind}"));
            }
        }
    }
    let mut rest = text;
    while let Some(character) = rest.chars().next() {
        if place == TextPlace::Cell {
            if let Some(spelling) = ["<br>", "&lt;br&gt;", "&amp;lt;br&amp;gt;"]
                .into_iter()
                .find(|spelling| rest.starts_with(spelling))
            {
                resolved.push(CELL_BREAK);
                rest = &rest[spelling.len()..];
                continue;
            }
        }
        match character {
            '\\' if rest[1..].starts_with(|next: char| next.is_ascii_punctuation()) => {
                resolved.push_str(&rest[1..2]);
                rest = &rest[2..];
                continue;
            }
            '&' => {
                let at = text.len() - rest.len();
                let in_tag = tag.is_some_and(|(start, end)| start <= at && at < end);
                if let Some((decoded, length)) = in_tag.then(|| projected_reference(rest)).flatten()
                {
                    resolved.push(decoded);
                    rest = &rest[length..];
                    continue;
                }
                let name_end = rest[1..]
                    .find(|c: char| !(c.is_ascii_alphanumeric() || c == '#'))
                    .map_or(rest.len(), |end| end + 1);
                if rest[name_end..].starts_with(';') {
                    let name = &rest[1..name_end];
                    if let Some(decoded) = decoded_reference(name) {
                        resolved.push(decoded);
                        rest = &rest[name_end + 1..];
                        continue;
                    }
                    if rendered_reference(name) {
                        syntax.push(format!("at {}: reference {name}", resolved.len()));
                    }
                }
            }
            '<' => {
                if let Some(kind) = inline_syntax(rest) {
                    syntax.push(format!("at {}: {kind}", resolved.len()));
                }
            }
            _ => {}
        }
        resolved.push(character);
        rest = &rest[character.len_utf8()..];
    }
    (resolved, syntax)
}

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
    let name = tag[..name_end].to_ascii_lowercase();
    let element = HTML_ELEMENTS
        .split_ascii_whitespace()
        .any(|element| element == name)
        && tag[name_end..]
            .chars()
            .next()
            .is_none_or(|next| next.is_whitespace() || next == '>' || next == '/');
    if element || html_tag_end(text, true).is_some() {
        return Some(format!("element {name}"));
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

/// The block a Markdown reader starts on one line of a text run: a heading,
/// quote, list item, fence, thematic break, math block, or indented code
/// where a block starts, a link reference definition where a paragraph
/// starts, or a setext underline under a paragraph line. A continuing
/// paragraph line starts a numbered list only at `1`. The projector escapes
/// each of these where the document holds text.
fn block_start(line: &str, starts_block: bool, starts_paragraph: bool) -> Option<&'static str> {
    let indent = line.bytes().take_while(|byte| *byte == b' ').count();
    if indent >= 4 {
        return starts_block.then_some("code");
    }
    let rest = &line[indent..];
    let hashes = rest.bytes().take_while(|byte| *byte == b'#').count();
    if (1..=6).contains(&hashes)
        && rest[hashes..]
            .chars()
            .next()
            .is_none_or(char::is_whitespace)
    {
        return Some("heading");
    }
    if rest.starts_with('>') {
        return Some("quote");
    }
    if rest.starts_with("```") || rest.starts_with("~~~") {
        return Some("fence");
    }
    if rest.starts_with("$$") {
        return Some("math");
    }
    if thematic_break(rest) {
        return Some("rule");
    }
    let bullet = rest.starts_with(['-', '*', '+']);
    if bullet && rest[1..].chars().next().is_none_or(char::is_whitespace) {
        return Some("list");
    }
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if (1..=9).contains(&digits)
        && (starts_block || &rest[..digits] == "1")
        && matches!(rest.as_bytes().get(digits), Some(b'.' | b')'))
        && rest[digits + 1..]
            .chars()
            .next()
            .is_none_or(char::is_whitespace)
    {
        return Some("list");
    }
    if !starts_block
        && !rest.is_empty()
        && rest
            .trim_end_matches([' ', '\t'])
            .bytes()
            .all(|byte| byte == b'=')
    {
        return Some("setext");
    }
    if starts_paragraph {
        let label = rest.strip_prefix('[')?;
        let close = label.find(']')?;
        if close > 0 && label[close + 1..].starts_with(':') {
            return Some("definition");
        }
    }
    None
}

#[inline(always)]
fn thematic_break(line: &str) -> bool {
    let bytes = line.as_bytes();
    matches!(bytes.first(), Some(b' ' | b'-' | b'*' | b'_'))
        && bytes
            .get(2)
            .is_none_or(|byte| matches!(byte, b' ' | b'\t' | b'-' | b'*' | b'_'))
        && thematic_break_body(line)
}

/// The heading level of a setext underline as marked reads one: up to three
/// spaces, a run of `=` or `-`, then spaces. A thematic break such as `---`
/// stays a rule.
fn setext_underline(line: &str) -> Option<i64> {
    let rest = line.trim_start_matches(' ');
    let level = match rest.as_bytes().first()? {
        b'=' => 1,
        b'-' => 2,
        _ => return None,
    };
    let run = rest.trim_end_matches(' ');
    (line.len() - rest.len() <= 3
        && run.bytes().all(|byte| byte == run.as_bytes()[0])
        && !thematic_break(line))
    .then_some(level)
}

/// How marked reads the line above a setext underline: as heading text, or
/// as text when the line could start another block. This reader does not
/// follow an empty heading (`None`).
fn setext_text(line: &str) -> Option<bool> {
    if setext_heading_text(line).is_empty() {
        return None;
    }
    let rest = line.trim_start_matches(' ');
    // marked keeps block HTML, and a `<...>` that ends the line, out of a
    // heading. Any other tag stays in its text. Its `<!` block needs a
    // letter, a comment or CDATA after it.
    let html = rest.strip_prefix('<').is_some_and(|tag| {
        let block = match tag.strip_prefix('!') {
            Some(bang) => {
                bang.starts_with(|c: char| c.is_ascii_alphabetic())
                    || bang.starts_with("--")
                    || bang
                        .get(..7)
                        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("[CDATA["))
            }
            None => html_block(rest),
        };
        block
            || tag
                .find('>')
                .is_some_and(|end| end > 0 && end + 1 == tag.len())
    });
    let divider = rest.contains('|')
        && rest
            .bytes()
            .all(|byte| matches!(byte, b'|' | b':' | b'-' | b' '));
    Some(
        !(html
            || divider
            || rest.starts_with(['\t', '#'])
            || block_start(line, true, true).is_some()),
    )
}

/// The heading text marked keeps: the line without the whitespace it trims.
/// The importer protects a list item's tabs, so they stay.
fn setext_heading_text(line: &str) -> &str {
    line.trim_matches(|character| character != '\t' && is_js_whitespace(character))
}

#[inline(never)]
fn thematic_break_body(line: &str) -> bool {
    let indent = line.bytes().take_while(|byte| *byte == b' ').count();
    if indent > 3 {
        return false;
    }
    let line = &line[indent..];
    let Some(marker @ (b'-' | b'*' | b'_')) = line.as_bytes().first().copied() else {
        return false;
    };
    let mut count = 0;
    for byte in line.bytes() {
        if byte == marker {
            count += 1;
        } else if !matches!(byte, b' ' | b'\t') {
            return false;
        }
    }
    count >= 3
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

#[cfg(test)]
fn parse_markdown_blocks(body: &str, reading: MarkdownReading) -> Vec<MdBlock<'_>> {
    parse_markdown_blocks_checked(body, reading).0
}

fn parse_markdown_blocks_checked(body: &str, reading: MarkdownReading) -> (Vec<MdBlock<'_>>, bool) {
    let mut refused = false;
    let lines: Vec<_> = if body.contains('\r') {
        body.lines().collect()
    } else {
        body.split('\n').collect()
    };
    let blocks = parse_markdown_blocks_at(&lines, 0, 0, reading, false, &mut refused);
    (blocks, refused)
}

// Marker tabs use tab stops; continuation indentation uses four spaces per tab.
// Tabs after the syntax prefix remain content in every reading.
fn normalize_list_tabs(body: &str, reading: MarkdownReading) -> std::borrow::Cow<'_, str> {
    // Projected indentation is spaces; its literal tabs belong to content.
    if reading == MarkdownReading::ProjectedSource || !body.contains('\t') {
        return body.into();
    }
    let mut output = String::with_capacity(body.len());
    let mut in_list = false;
    let mut blank = false;
    let mut empty = false;
    let mut fence: Option<(u8, usize, bool)> = None;
    let mut quote_depth = 0;
    let mut list_indent = 0;
    let mut list_column = 0;
    // Only the file reading reads indented code. The other readings must
    // still rebuild the documents they built, so they normalize these tabs.
    let opaque_code = reading == MarkdownReading::Source;
    for line in body.split_inclusive('\n') {
        let mut quoted = line;
        let mut quotes = 0;
        while fence.is_none() || quotes < quote_depth {
            let text = quoted.trim_start_matches(' ');
            if opaque_code && fence.is_none() && !in_list && quoted.len() - text.len() >= 4 {
                break;
            }
            let Some(rest) = text.strip_prefix('>') else {
                break;
            };
            quoted = rest.strip_prefix(' ').unwrap_or(rest);
            quotes += 1;
        }
        let quote_prefix = line.len() - quoted.len();
        if quotes != quote_depth {
            in_list = false;
            fence = None;
            quote_depth = quotes;
        }
        // Outside a list, a line indented four columns is indented code or
        // a lazy line, so its quote markers and tabs are its text.
        if opaque_code
            && fence.is_none()
            && !in_list
            && !quoted.trim().is_empty()
            && indented_code_line(quoted.trim_end_matches('\n'))
        {
            output.push_str(line);
            blank = false;
            continue;
        }
        if let Some((character, width, list)) = fence {
            let rest = quoted.trim_start_matches([' ', '\t']);
            let run = rest.bytes().take_while(|byte| *byte == character).count();
            let closes = if !list && reading == MarkdownReading::Source {
                quoted.trim_end_matches('\n') == "```"
            } else {
                run >= width && rest[run..].trim().is_empty()
            };
            if closes {
                fence = None;
            }
            if list {
                let indent = quoted
                    .bytes()
                    .take_while(|b| matches!(b, b' ' | b'\t'))
                    .count();
                output.push_str(&line[..quote_prefix]);
                output.push_str(&quoted[..indent].replace('\t', "    "));
                output.push_str(&quoted[indent..]);
            } else {
                output.push_str(line);
            }
            continue;
        }
        let indent = quoted
            .bytes()
            .take_while(|byte| matches!(byte, b' ' | b'\t'))
            .count();
        let rest = &quoted[indent..];
        let columns = quoted[..indent].bytes().fold(0, |column, byte| {
            if byte == b'\t' {
                column + 4 - column % 4
            } else {
                column + 1
            }
        });
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        let marker_width = if rest.starts_with(['-', '+', '*']) {
            1
        } else if (1..=9).contains(&digits) && rest[digits..].starts_with(['.', ')']) {
            digits + 1
        } else {
            0
        };
        let marker = marker_width > 0
            && rest
                .as_bytes()
                .get(marker_width)
                .is_some_and(|byte| matches!(byte, b' ' | b'\t' | b'\n'))
            && !thematic_break(rest.trim_end_matches('\n'));
        let continuation_columns = quoted[..indent]
            .bytes()
            .map(|byte| if byte == b'\t' { 4 } else { 1 })
            .sum::<usize>();
        let continuation = in_list && continuation_columns >= list_column;
        if marker && (columns < 4 || in_list) {
            if !in_list || columns <= list_indent {
                list_indent = columns;
                let column = columns + marker_width;
                let padded = rest[marker_width..]
                    .bytes()
                    .take_while(|byte| matches!(byte, b' ' | b'\t'))
                    .fold(column, |column, byte| {
                        column + if byte == b'\t' { 4 - column % 4 } else { 1 }
                    });
                let padding = padded - column;
                list_column = column
                    + if (1..=4).contains(&padding) && !rest[marker_width..].trim().is_empty() {
                        padding
                    } else {
                        1
                    };
            }
            in_list = true;
        } else if !rest.trim().is_empty()
            && !continuation
            && (blank
                || empty
                || block_start(quoted.trim_end_matches('\n'), false, false).is_some())
        {
            in_list = false;
        }
        blank = line.trim().is_empty();
        if !in_list {
            fence = markdown_fence(
                quoted.trim_end_matches('\n'),
                reading == MarkdownReading::Source,
            )
            .map(|(character, width, _)| (character, width, false));
            output.push_str(line);
            continue;
        }
        let item = if marker { &rest[marker_width..] } else { rest };
        fence = markdown_fence(
            item.trim_start_matches([' ', '\t']).trim_end_matches('\n'),
            false,
        )
        .map(|(character, width, _)| (character, width, true));
        if !marker && !continuation {
            output.push_str(line);
            continue;
        }
        // Include checkboxes and compact child markers in the syntax prefix.
        let mut prefix = indent;
        if marker {
            let mut width = marker_width;
            loop {
                let bullet = quoted[prefix..].starts_with(['-', '+', '*']);
                prefix += width;
                prefix += quoted[prefix..]
                    .bytes()
                    .take_while(|b| matches!(b, b' ' | b'\t'))
                    .count();
                if bullet
                    && matches!(quoted.get(prefix..prefix + 3), Some("[ ]" | "[x]" | "[X]"))
                    && quoted
                        .as_bytes()
                        .get(prefix + 3)
                        .is_some_and(|b| matches!(b, b' ' | b'\t'))
                {
                    prefix += 3;
                    prefix += quoted[prefix..]
                        .bytes()
                        .take_while(|b| matches!(b, b' ' | b'\t'))
                        .count();
                }
                let rest = &quoted[prefix..];
                let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
                width = if rest.starts_with(['-', '+', '*']) {
                    1
                } else if (1..=9).contains(&digits) && rest[digits..].starts_with(['.', ')']) {
                    digits + 1
                } else {
                    break;
                };
                if !rest
                    .as_bytes()
                    .get(width)
                    .is_some_and(|b| matches!(b, b' ' | b'\t'))
                {
                    break;
                }
            }
        }
        output.push_str(&line[..quote_prefix]);
        let mut column = 0;
        for (at, character) in quoted.char_indices() {
            if character == '\t' && at < prefix {
                let width = if continuation { 4 } else { 4 - column % 4 };
                output.extend(std::iter::repeat_n(' ', width));
                column += width;
            } else {
                output.push(character);
                column += 1;
            }
        }
        empty = marker && item.trim().is_empty();
    }
    output.into()
}

fn unsupported_markdown_line(line: &str) -> bool {
    let rest = line.trim_start_matches(' ');
    if rest.starts_with("~~~") {
        return true;
    }
    if rest.starts_with(['*', '_']) && thematic_break(rest) {
        return true;
    }
    let after_marker = rest.strip_prefix(['-', '*', '+']).or_else(|| {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        (1..=9)
            .contains(&digits)
            .then(|| rest[digits..].strip_prefix(['.', ')']))
            .flatten()
    });
    if after_marker.is_some_and(|after| {
        after
            .bytes()
            .take_while(|byte| matches!(byte, b' ' | b'\t'))
            .any(|byte| byte == b'\t')
    }) {
        return true;
    }
    false
}

/// Maximum quote nesting before the parser keeps the rest as paragraph text.
/// A file fold refuses that overflow because projection escapes its `>` markers.
/// This budget is below the projector's depth limit.
const QUOTE_FOLD_MAX_DEPTH: usize = 120;
const MARKDOWN_XML_MAX_DEPTH: usize = 128;

fn blank_line(line: &str) -> bool {
    line.bytes().all(|byte| matches!(byte, b' ' | b'\t'))
}

/// Whether a rewrite applies the outside-file fold restrictions.
#[derive(Clone, Copy, PartialEq, Eq)]
enum FileFold {
    No,
    Strict,
}

/// Whether marked's block tokenizer starts block HTML at this line.
fn html_block(line: &str) -> bool {
    let Some(tag) = line.strip_prefix('<') else {
        return false;
    };
    let line = line.trim_end_matches([' ', '\t']);
    let tag = tag.trim_end_matches([' ', '\t']);
    if tag.starts_with(['!', '?']) {
        return true;
    }
    let tag = tag.strip_prefix('/').unwrap_or(tag);
    let name = tag
        .split(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '-' | '_'))
        .next()
        .unwrap_or("");
    let tail = &tag[name.len()..];
    let named_block = TABLE_ENDING_HTML
        .split_ascii_whitespace()
        .any(|block| name.eq_ignore_ascii_case(block));
    if named_block && (tail.is_empty() || tail.starts_with([' ', '>']) || tail.starts_with("/>")) {
        return true;
    }
    for raw in ["script", "pre", "style", "textarea"] {
        if !line.starts_with("</")
            && name.eq_ignore_ascii_case(raw)
            && (tail.is_empty()
                || tail
                    .chars()
                    .next()
                    .is_some_and(|c| c == '>' || is_js_whitespace(c)))
        {
            return true;
        }
        // Marked excludes these prefixes from standalone custom tags.
        if name
            .get(..raw.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(raw))
        {
            return false;
        }
    }
    // Marked permits underscores in custom tag names. Keep this local:
    // the existing inline reader has its own spelling contract.
    let opening: std::borrow::Cow<'_, str> = if name.contains('_')
        && name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && !line.starts_with("</")
    {
        std::borrow::Cow::Owned(format!("<x{tail}"))
    } else {
        std::borrow::Cow::Borrowed(line)
    };
    html_tag_end(&opening, false).is_some_and(|end| opening[end..].trim().is_empty())
        || line
            .strip_prefix("</")
            .and_then(|tag| tag.strip_suffix('>'))
            .is_some_and(|tag| {
                let name = tag.trim_end_matches(is_js_whitespace);
                name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                    && name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
            })
}

/// Whether outside Markdown's additional item blocks belong to the proved
/// subset. This does not enable strict-fold admission or authorize a witness.
pub fn outside_markdown_is_allowlisted(markdown: &str) -> bool {
    outside_markdown_allowlist(markdown).is_some()
}

// Inline text the desktop reader reads as the engine does: no autolinks, hard breaks or other
// inline syntax.
fn allowlisted_inline(text: &str) -> bool {
    !text.contains("://")
        && !text
            .as_bytes()
            .windows(4)
            .any(|part| part.eq_ignore_ascii_case(b"www."))
        && !text.split_inclusive('\n').any(|line| {
            line.strip_suffix('\n')
                .is_some_and(|content| content.ends_with("  "))
        })
        && text.chars().all(|character| {
            character.is_alphanumeric()
                || (character != '\r' && character.is_whitespace())
                || matches!(
                    character,
                    '.' | ',' | ';' | ':' | '!' | '?' | '\'' | '"' | '(' | ')' | '-' | '/'
                )
        })
}

// Some(true) denotes an agreed item-block body; flat successors keep their
// existing permissive proof, except for the desktop's quote depth limit.
fn outside_markdown_allowlist(markdown: &str) -> Option<bool> {
    fn tree(blocks: &[MdBlock<'_>], in_item: bool) -> bool {
        blocks.iter().all(|block| match block {
            MdBlock::Paragraph(text) => allowlisted_inline(text),
            MdBlock::Heading { text, .. } => !in_item && allowlisted_inline(text),
            MdBlock::CodeBlock { language, .. } => language
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "_+.#-".contains(character)),
            MdBlock::BulletList(items) => items.iter().all(|(text, blocks)| {
                !text.trim().is_empty() && allowlisted_inline(text) && tree(blocks, true)
            }),
            MdBlock::OrderedList { items, .. } => items.iter().all(|item| {
                !item.paragraph.trim().is_empty()
                    && allowlisted_inline(&item.paragraph)
                    && tree(item.blocks(), true)
            }),
            MdBlock::TaskList(items) => items.iter().all(|(_, item)| {
                !item.paragraph.trim().is_empty()
                    && allowlisted_inline(&item.paragraph)
                    && tree(item.blocks(), true)
            }),
            MdBlock::Quote(children) => {
                !in_item && !refused_fold_item_bodies(children) && tree(children, false)
            }
            MdBlock::Table { rows, .. } => {
                !in_item && rows.iter().flatten().all(|cell| allowlisted_inline(cell))
            }
            _ => !in_item,
        })
    }

    // The source parser retains some blocks as text. Line shapes close
    // those block-start gaps after the tree checks.
    fn list_lines(lines: &[&str]) -> bool {
        let mut stack: Vec<(usize, usize)> = Vec::new();
        let mut fence: Option<usize> = None;
        let mut after_blank = false;
        for line in lines {
            let indent = line.bytes().take_while(|b| *b == b' ').count();
            if line[indent..].starts_with('\t') {
                return false;
            }
            if blank_line(line) {
                after_blank = true;
                continue;
            }
            if let Some(column) = fence {
                if indent < column {
                    return false;
                }
                let text = &line[column..];
                if markdown_fence(text, false)
                    .is_some_and(|(delimiter, _, rest)| delimiter == b'`' && rest.trim().is_empty())
                {
                    if text != "```" {
                        return false;
                    }
                    fence = None;
                }
                continue;
            }
            let text = &line[indent..];
            let separated = std::mem::replace(&mut after_blank, false);
            if let Some(marker) = list_marker(text, MarkdownReading::Source) {
                while stack.last().is_some_and(|(at, _)| *at > indent) {
                    stack.pop();
                }
                if let Some(&(at, column)) = stack.last() {
                    if indent > at {
                        if !matches!(indent - at, 2 | 4) || indent < column {
                            return false;
                        }
                    } else {
                        stack.pop();
                    }
                }
                if stack.is_empty() && indent > 3 {
                    return false;
                }
                let column = indent + marker.width;
                stack.push((indent, column));
                if text[..text.len() - marker.text.len()].contains('\t')
                    || marker.text.trim_start_matches(' ').starts_with('\t')
                    || marker.text.trim().is_empty()
                    || html_block(marker.text)
                    || marker.text.trim_start_matches(' ').starts_with("$$")
                {
                    return false;
                }
                continue;
            }
            if separated {
                while stack.len() > 1 && stack.last().is_some_and(|(_, column)| indent < *column) {
                    stack.pop();
                }
            }
            let Some(&(_, column)) = stack.last() else {
                return false;
            };
            if indent < column {
                return false;
            }
            let text = &line[column..];
            if let Some(info) = text.strip_prefix("```") {
                if info.contains('`') {
                    return false;
                }
                fence = Some(column);
            } else if (indent - column <= 3 && text.trim().bytes().all(|byte| byte == b'-'))
                || html_block(text.trim_start_matches(' '))
                || block_start(text, false, false) == Some("setext")
                || matches!(
                    block_start(text, true, true),
                    Some("code" | "fence" | "heading" | "quote" | "rule" | "math")
                )
            {
                return false;
            }
        }
        fence.is_none()
    }

    let (_, _, body) = split_markdown_frontmatter(markdown);
    let body = body.replace("\r\n", "\n");
    let normalized = normalize_list_tabs(&body, MarkdownReading::Source);
    let (blocks, mut refused) = parse_markdown_blocks_checked(&normalized, MarkdownReading::Source);
    let mut item_blocks = refused_fold_item_bodies(&blocks);
    let mut readings_agree = true;
    for reading in [MarkdownReading::Projection, MarkdownReading::Successor] {
        let normalized = normalize_list_tabs(&body, reading);
        let (other, other_refused) = parse_markdown_blocks_checked(&normalized, reading);
        item_blocks |= refused_fold_item_bodies(&other);
        refused |= other_refused;
        readings_agree &= other == blocks;
    }
    if !item_blocks {
        return (!quote_fold_overflows(&blocks, 0)).then_some(false);
    }
    if refused
        || !readings_agree
        || markdown.len() > crate::limits::MAX_PUBLIC_MARKDOWN_BYTES
        || !tree(&blocks, false)
    {
        return None;
    }
    let lines: Vec<_> = body.lines().collect();
    let mut at = 0;
    while at < lines.len() {
        // A top-level fence may contain marker-looking text.
        if let Some((_, _, info)) = markdown_fence(lines[at], true) {
            if info.contains('`') {
                return None;
            }
            let close = lines[at + 1..].iter().position(|line| *line == "```");
            if let Some(close) = close {
                at += close + 2;
                continue;
            }
        }
        let text = lines[at].trim_start_matches(' ');
        let digits = text.bytes().take_while(u8::is_ascii_digit).count();
        if text
            .strip_prefix(['-', '+', '*'])
            .is_some_and(|rest| rest.starts_with('\t'))
            || (digits > 0
                && text[digits..]
                    .strip_prefix(['.', ')'])
                    .is_some_and(|rest| rest.starts_with('\t')))
        {
            return None;
        }
        if let Some(marker) = list_marker(lines[at], MarkdownReading::Source) {
            let mut refused = false;
            if let Some((_, end)) = parse_list(
                &lines,
                at,
                marker,
                0,
                0,
                MarkdownReading::Source,
                &mut refused,
            ) {
                if refused || !list_lines(&lines[at..end]) {
                    return None;
                }
                at = end;
                continue;
            }
            return None;
        }
        at += 1;
    }
    Some(true)
}

fn refused_fold_item_bodies(blocks: &[MdBlock<'_>]) -> bool {
    blocks.iter().any(|block| match block {
        MdBlock::Quote(inner) => refused_fold_item_bodies(inner),
        MdBlock::BulletList(items) => items.iter().any(|(_, body)| !body.is_empty()),
        MdBlock::OrderedList { items, .. } => items.iter().any(|item| !item.blocks().is_empty()),
        MdBlock::TaskList(items) => items.iter().any(|(_, item)| !item.blocks().is_empty()),
        _ => false,
    })
}

fn quote_fold_overflows(blocks: &[MdBlock<'_>], depth: usize) -> bool {
    blocks.iter().any(|block| match block {
        MdBlock::Quote(inner) => quote_fold_overflows(inner, depth + 1),
        MdBlock::BulletList(items) => items
            .iter()
            .any(|(_, blocks)| quote_fold_overflows(blocks, depth + 2)),
        MdBlock::OrderedList { items, .. } => items
            .iter()
            .any(|item| quote_fold_overflows(item.blocks(), depth + 2)),
        MdBlock::TaskList(items) => items
            .iter()
            .any(|(_, item)| quote_fold_overflows(item.blocks(), depth + 2)),
        MdBlock::Paragraph(text) if depth >= QUOTE_FOLD_MAX_DEPTH => {
            text == ">" || text.starts_with("> ") || text.starts_with(">\n")
        }
        _ => false,
    })
}

#[inline(always)]
fn markdown_fence(line: &str, source: bool) -> Option<(u8, usize, &str)> {
    if source {
        return line.strip_prefix("```").map(|language| (b'`', 3, language));
    }
    let indent = line.bytes().take_while(|byte| *byte == b' ').count();
    let line = if indent <= 3 { &line[indent..] } else { line };
    let delimiter = *line.as_bytes().first()?;
    if !matches!(delimiter, b'`' | b'~') {
        return None;
    }
    let width = line.bytes().take_while(|byte| *byte == delimiter).count();
    (width >= 3).then(|| (delimiter, width, &line[width..]))
}

fn inline_code_spans(text: &str) -> Vec<std::ops::Range<usize>> {
    let bytes = text.as_bytes();
    let mut runs = HashMap::<usize, Vec<usize>>::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'`' {
            let width = bytes[at..].iter().take_while(|&&b| b == b'`').count();
            runs.entry(width).or_default().push(at);
            at += width;
        } else {
            at += 1;
        }
    }
    for positions in runs.values_mut() {
        positions.reverse();
    }
    let mut spans = Vec::new();
    at = 0;
    while at < bytes.len() {
        if bytes[at] == b'\\' {
            at += 2;
        } else if bytes[at] == b'`' {
            let width = bytes[at..].iter().take_while(|&&b| b == b'`').count();
            if let Some(positions) = runs.get_mut(&width) {
                while positions.last().is_some_and(|&close| close <= at) {
                    positions.pop();
                }
                if let Some(&close) = positions.last() {
                    spans.push(at..close + width);
                    at = close + width;
                    continue;
                }
            }
            at += width;
        } else {
            at += 1;
        }
    }
    spans
}

/// `depth` counts XML levels; `quote_depth` enforces the separate quote cap.
fn parse_markdown_blocks_at<'src>(
    lines: &[&'src str],
    depth: usize,
    quote_depth: usize,
    reading: MarkdownReading,
    in_list: bool,
    refused: &mut bool,
) -> Vec<MdBlock<'src>> {
    let tables = in_list
        || !matches!(
            reading,
            MarkdownReading::Projection | MarkdownReading::Successor
        );
    let source_fences = reading == MarkdownReading::Source && !in_list;
    let mut blocks = Vec::new();
    let mut index = 0usize;
    // Find fence closers once; repeated unclosed openers must not rescan the body.
    let mut closers = None;
    let mut next_closer = 0;
    while index < lines.len() {
        let line = lines[index];
        if blank_line(line) {
            index += 1;
            continue;
        }
        if let Some((delimiter, width, fence_language)) = markdown_fence(line, source_fences) {
            let (closers, longest) = closers.get_or_insert_with(|| {
                let found: Vec<_> = lines
                    .iter()
                    .enumerate()
                    .filter_map(|(at, line)| {
                        if source_fences {
                            return (*line == "```").then_some((at, b'`', 3));
                        }
                        let (delimiter, width, rest) = markdown_fence(line, false)?;
                        rest.trim().is_empty().then_some((at, delimiter, width))
                    })
                    .collect();
                let mut longest = vec![[0; 2]; found.len() + 1];
                for (at, &(_, character, length)) in found.iter().enumerate().rev() {
                    longest[at] = longest[at + 1];
                    let kind = &mut longest[at][usize::from(character == b'~')];
                    *kind = (*kind).max(length);
                }
                (found, longest)
            });
            while closers
                .get(next_closer)
                .is_some_and(|&(at, _, _)| at <= index)
            {
                next_closer += 1;
            }
            let closer = (longest[next_closer][usize::from(delimiter == b'~')] >= width)
                .then(|| {
                    closers[next_closer..]
                        .iter()
                        .find(|&&(_, c, l)| c == delimiter && l >= width)
                })
                .flatten();
            if let Some(&(closer, _, _)) = closer {
                blocks.push(MdBlock::CodeBlock {
                    language: if source_fences {
                        fence_language
                    } else {
                        fence_language.trim_start()
                    }
                    .to_string(),
                    content: {
                        let indent = if source_fences {
                            0
                        } else {
                            line.bytes().take_while(|byte| *byte == b' ').count().min(3)
                        };
                        lines[index + 1..closer]
                            .iter()
                            .map(|line| {
                                &line[line
                                    .bytes()
                                    .take_while(|byte| *byte == b' ')
                                    .count()
                                    .min(indent)..]
                            })
                            .collect::<Vec<_>>()
                            .join("\n")
                    },
                });
                index = closer + 1;
                continue;
            }
            // An unclosed fence is not a code block: fall through to text.
        }
        // Indented code cannot interrupt a paragraph, and a quote or list
        // item right before it takes it as a lazy line. Inside an item, and
        // in other readings, it stays refused below.
        if reading == MarkdownReading::Source
            && !in_list
            && indented_code_line(line)
            && (index == 0
                || blank_line(lines[index - 1])
                || matches!(
                    blocks.last(),
                    Some(
                        MdBlock::Heading { .. }
                            | MdBlock::Rule
                            | MdBlock::CodeBlock { .. }
                            | MdBlock::Table { .. }
                    )
                ))
        {
            let start = index;
            index += 1;
            loop {
                while lines.get(index).is_some_and(|line| blank_line(line)) {
                    index += 1;
                }
                if !lines
                    .get(index)
                    .is_some_and(|line| indented_code_line(line))
                {
                    break;
                }
                index += 1;
            }
            // marked also ends a line at a lone carriage return.
            *refused |= lines[start..index].iter().any(|line| line.contains('\r'));
            let mut content = lines[start..index]
                .iter()
                .map(|line| {
                    let spaces = line.bytes().take_while(|byte| *byte == b' ').count();
                    match spaces {
                        0 => line.strip_prefix('\t').unwrap_or(line),
                        _ => &line[spaces.min(4)..],
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            content.truncate(content.trim_end_matches('\n').len());
            blocks.push(MdBlock::CodeBlock {
                language: String::new(),
                content,
            });
            continue;
        }
        *refused |= (in_list
            || matches!(
                line.trim_start_matches(' ').as_bytes(),
                [b'-' | b'+' | b'*', b'\t', ..]
            ))
            && unsupported_markdown_line(line)
            && (in_list || !thematic_break(line));
        if thematic_break(line) {
            blocks.push(MdBlock::Rule);
            index += 1;
            continue;
        }
        if let Some((level, text)) = parse_heading(line) {
            blocks.push(MdBlock::Heading { level, text });
            index += 1;
            continue;
        }
        if reading == MarkdownReading::Source && !in_list && block_start(line, true, true).is_none()
        {
            if let Some(underline) = lines
                .get(index + 1)
                .map(|line| line.trim_end_matches([' ', '\t']))
            {
                if !underline.is_empty() && underline.bytes().all(|byte| byte == b'=') {
                    blocks.push(MdBlock::Heading {
                        level: 1,
                        text: line.to_owned(),
                    });
                    index += 2;
                    continue;
                }
            }
        }
        if line == ">" || line.starts_with("> ") {
            let mut inner = Vec::new();
            let start = index;
            while index < lines.len() {
                let quoted = lines[index];
                if quoted == ">" {
                    inner.push("");
                } else if let Some(stripped) = quoted.strip_prefix("> ") {
                    inner.push(stripped);
                } else {
                    break;
                }
                index += 1;
            }
            if quote_depth >= QUOTE_FOLD_MAX_DEPTH || depth + 2 > MARKDOWN_XML_MAX_DEPTH {
                *refused |=
                    depth + 2 > MARKDOWN_XML_MAX_DEPTH || reading == MarkdownReading::Source;
                blocks.push(MdBlock::Paragraph(lines[start..index].join("\n")));
            } else {
                blocks.push(MdBlock::Quote(parse_markdown_blocks_at(
                    &inner,
                    depth + 1,
                    quote_depth + 1,
                    reading,
                    in_list,
                    refused,
                )));
            }
            continue;
        }
        let list_reading = MarkdownReading::ProjectedSource;
        // Only the first marker needs the override; source_reproduces also tries Projection.
        if let Some(first) = list_marker(line, list_reading) {
            if let Some((list, next)) =
                parse_list(lines, index, first, depth, quote_depth, reading, refused)
            {
                blocks.push(list);
                index = next;
                continue;
            }
        }
        let table = match parse_annotated_table(&lines[index..]) {
            None if tables => parse_table(&lines[index..], Vec::new()),
            annotated => annotated,
        };
        if let Some((block, consumed)) = table {
            *refused |= depth + 4 > MARKDOWN_XML_MAX_DEPTH;
            blocks.push(block);
            index += consumed;
            continue;
        }
        *refused |= matches!(
            reading,
            MarkdownReading::Source | MarkdownReading::Projection
        ) && indented_code_leading_entity(line).is_some();
        let paragraph_reading = if in_list {
            reading
        } else {
            MarkdownReading::Source
        };
        let mut para = vec![line];
        let mut heading = None;
        index += 1;
        while index < lines.len() {
            let next = lines[index];
            if in_list && next.trim_end_matches([' ', '\t']) == "-" {
                heading = Some((2, para.join("\n")));
                break;
            }
            // The file reading also takes marked's other underlines. Every
            // other reading keeps them as text, so a document it built still
            // proves its file.
            if let Some(level) =
                setext_underline(next).filter(|_| in_list && reading == MarkdownReading::Source)
            {
                // marked reads every line above the underline as one heading,
                // which the projector cannot write back as one.
                match setext_text(para[0]) {
                    Some(true) if para.len() == 1 => {
                        heading = Some((level, setext_heading_text(line).to_owned()));
                        break;
                    }
                    Some(false) => {}
                    _ => *refused = true,
                }
            }
            if blank_line(next)
                || thematic_break(next)
                || markdown_fence(next, source_fences).is_some()
                || next == ">"
                || next.starts_with("> ")
                || list_marker(next, paragraph_reading).is_some_and(|marker| {
                    (!marker.text.trim().is_empty() || matches!(marker.kind, ListKind::Task(_)))
                        && (!matches!(marker.kind, ListKind::Ordered(_))
                            || matches!(marker.spelling, "1." | "1)"))
                })
                || parse_heading(next).is_some()
                || (tables && table_starts(&lines[index..]))
            {
                break;
            }
            *refused |= in_list && unsupported_markdown_line(next);
            para.push(next);
            index += 1;
        }
        if let Some((level, text)) = heading {
            blocks.push(MdBlock::Heading { level, text });
            index += 1;
            continue;
        }
        let mut paragraph = para.join("\n");
        if reading != MarkdownReading::Source
            && paragraph.contains("&#")
            && !paragraph.as_bytes().windows(2).any(|pair| {
                pair[0] == b'<'
                    && (pair[1].is_ascii_alphabetic() || matches!(pair[1], b'/' | b'!' | b'?'))
            })
            && !paragraph.contains("]:")
        {
            let mut spans = inline_code_spans(&paragraph);
            spans.extend(
                empty_link_ranges(&paragraph)
                    .into_iter()
                    .map(|(from, to)| from..to),
            );
            spans.sort_unstable_by_key(|span| span.start);
            let mut spans = spans.into_iter().peekable();
            let mut covered = 0;
            paragraph = paragraph
                .split('\n')
                .scan(0, |offset, line| {
                    let at = *offset;
                    *offset += line.len() + 1;
                    Some((at, line))
                })
                .map(|(index, line)| {
                    while let Some(span) = spans.next_if(|span| span.start <= index) {
                        covered = covered.max(span.end);
                    }
                    if index < covered {
                        return line.to_owned();
                    }
                    if let Some(rest) = line.strip_prefix("&#9;") {
                        return format!("\t{rest}");
                    }
                    if let Some(rest) = line.strip_prefix("&#32;") {
                        return format!(" {rest}");
                    }
                    if index > 0 && line == "&#42;" {
                        return "*".to_owned();
                    }
                    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
                    let marker = line[digits..]
                        .strip_prefix("&#46;")
                        .map(|rest| ('.', rest))
                        .or_else(|| line[digits..].strip_prefix("&#41;").map(|rest| (')', rest)));
                    match marker {
                        Some((marker, rest))
                            if index > 0
                                && (1..=9).contains(&digits)
                                && (rest.is_empty() || rest.starts_with([' ', '\t'])) =>
                        {
                            format!("{}{marker}{rest}", &line[..digits])
                        }
                        _ => line.to_owned(),
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
        }
        if paragraph.contains("&#") {
            for span in inline_code_spans(&paragraph).into_iter().rev() {
                let normalized = paragraph[span.clone()].replace('\n', " ");
                paragraph.replace_range(span, &normalized);
            }
        }
        blocks.push(MdBlock::Paragraph(paragraph));
    }
    blocks
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

/// Undoes one layer of the projector's entity encoding in one pass, so the
/// text the projector wrote as `&amp;lt;` comes back as `&lt;`, never `<`.
/// Inside an encoded tag, from the first `&lt;` that opens one to the last
/// `&gt;`, that layer includes the decimal references the projector writes
/// for punctuation and whitespace, which the importer reads there as their
/// characters. Elsewhere a reference stays the text it spells.
fn decode_html_entities_once(value: &str) -> String {
    let tag = encoded_tag_span(value);
    let in_tag = |at: usize| tag.is_some_and(|(start, end)| start <= at && at < end);
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(ampersand) = rest.find('&') {
        output.push_str(&rest[..ampersand]);
        rest = &rest[ampersand..];
        let at = value.len() - rest.len();
        let (decoded, encoded_len) = if rest.starts_with("&amp;") {
            ('&', "&amp;".len())
        } else if rest.starts_with("&lt;") {
            ('<', "&lt;".len())
        } else if rest.starts_with("&gt;") {
            ('>', "&gt;".len())
        } else {
            in_tag(at)
                .then(|| projected_reference(rest))
                .flatten()
                .unwrap_or(('&', 1))
        };
        output.push(decoded);
        rest = &rest[encoded_len..];
    }
    output.push_str(rest);
    output
}

/// Where `value` holds raw HTML the projector wrote as text: from the first
/// `&lt;` that opens a tag to the end of the last `&gt;`. The projector writes
/// decimal references inside it, and the importer reads them there as their
/// characters. A real tag, as raw HTML in a source, bounds no such span.
fn encoded_tag_span(value: &str) -> Option<(usize, usize)> {
    let opens_tag = |next: char| next.is_ascii_alphabetic() || matches!(next, '!' | '/' | '?');
    let start = value
        .match_indices("&lt;")
        .map(|(at, _)| at)
        .find(|at| value[at + "&lt;".len()..].starts_with(opens_tag))?;
    let end = value.rfind("&gt;").map(|at| at + "&gt;".len())?;
    (start < end).then_some((start, end))
}

/// The character and length of a decimal reference the projector writes at
/// the start of `value`: one to ASCII punctuation, a tab, a newline, a carriage
/// return, a space, or a no-break space, spelled without leading zeros.
fn projected_reference(value: &str) -> Option<(char, usize)> {
    let digits = value.strip_prefix("&#")?;
    let length = digits.bytes().take_while(u8::is_ascii_digit).count();
    if !(1..=3).contains(&length) || digits.starts_with('0') || !digits[length..].starts_with(';') {
        return None;
    }
    let code: u32 = digits[..length].parse().ok()?;
    let character = char::from_u32(code)?;
    (character.is_ascii_punctuation() || matches!(code, 9 | 10 | 13 | 32 | 160))
        .then_some((character, length + 3))
}

/// Splits one GFM table row, such as `| a | b |` or `a | b`, into trimmed
/// cells as written. A line without an unescaped pipe is not a row.
fn parse_table_row(line: &str) -> Option<Vec<String>> {
    if !line.contains('|') {
        return None;
    }
    let line = trim_js(line);
    let mut cells = Vec::new();
    let mut start = 0usize;
    let mut backslashes = 0usize;
    for (at, character) in line.char_indices() {
        if character == '|' && backslashes % 2 == 0 {
            cells.push(&line[start..at]);
            start = at + 1;
        }
        backslashes = if character == '\\' {
            backslashes + 1
        } else {
            0
        };
    }
    if cells.is_empty() {
        return None;
    }
    let closed = start == line.len();
    cells.push(&line[start..]);
    // A leading or trailing pipe bounds the row; it holds no cell.
    if line.starts_with('|') {
        cells.remove(0);
    }
    if closed {
        cells.pop();
    }
    if cells.is_empty() {
        return None;
    }
    Some(
        cells
            .into_iter()
            .map(|cell| trim_js(cell).to_string())
            .collect(),
    )
}

fn parse_table_delimiter(line: &str) -> Option<Vec<Option<TableAlign>>> {
    parse_table_row(line)?
        .into_iter()
        .map(|cell| {
            let left = cell.starts_with(':');
            let right = cell.ends_with(':');
            let dashes = cell.trim_matches(':');
            if dashes.is_empty() || !dashes.bytes().all(|byte| byte == b'-') {
                return None;
            }
            Some(match (left, right) {
                (true, true) => Some(TableAlign::Center),
                (true, false) => Some(TableAlign::Left),
                (false, true) => Some(TableAlign::Right),
                (false, false) => None,
            })
        })
        .collect()
}

/// An annotation line followed by a GFM table, with the number of lines the
/// table took. An annotation with no table under it stays ordinary text.
fn parse_annotated_table<'src>(lines: &[&'src str]) -> Option<(MdBlock<'src>, usize)> {
    let row_heights = parse_table_row_heights(lines.first()?)?;
    let (table, consumed) = parse_table(&lines[1..], row_heights)?;
    Some((table, consumed + 1))
}

/// Whether a GFM table starts here: a header row, then a delimiter row with
/// as many cells. It reads the second line first, so prose costs one byte
/// scan.
fn table_starts(lines: &[&str]) -> bool {
    lines.get(1).is_some_and(|line| {
        line.contains('-')
            && line
                .bytes()
                .all(|byte| matches!(byte, b'|' | b':' | b'-' | b' ' | b'\t'))
    }) && parse_table(&lines[..2], Vec::new()).is_some()
}

/// A GFM table with the number of lines it took: a header row, a delimiter
/// row with as many cells, then each following line up to a blank line or
/// the start of another block, as marked reads it. A line without a pipe is
/// a one-cell row. A short row gains empty cells, and empty cells past the
/// header are dropped. A row whose cells past the header hold text ends the
/// table instead of losing that text, as the desktop importer does.
fn parse_table<'src>(
    lines: &[&'src str],
    row_heights: Vec<(usize, i64)>,
) -> Option<(MdBlock<'src>, usize)> {
    let first = lines.first()?;
    // marked reads a list item or HTML before a table, and so does this.
    let rest = first.trim_start_matches(' ');
    if ends_table(first) || rest.starts_with('<') || parse_ordered_item(rest, false).is_some() {
        return None;
    }
    let header = parse_table_row(first)?;
    let alignments = parse_table_delimiter(lines.get(1)?)?;
    if alignments.len() != header.len() {
        return None;
    }
    let mut rows = vec![header];
    let mut consumed = 2;
    while let Some(mut row) = lines.get(consumed).and_then(|line| {
        (!trim_js(line).is_empty() && !ends_table(line))
            .then(|| parse_table_row(line).unwrap_or_else(|| vec![trim_js(line).to_string()]))
    }) {
        if row[alignments.len().min(row.len())..]
            .iter()
            .any(|cell| !cell.is_empty())
        {
            break;
        }
        row.resize(alignments.len(), String::new());
        rows.push(row);
        consumed += 1;
    }
    let row_heights: BTreeMap<usize, i64> = row_heights
        .into_iter()
        .filter(|(row, _)| *row < rows.len())
        .collect();
    Some((
        MdBlock::Table {
            rows,
            alignments,
            row_heights,
        },
        consumed,
    ))
}

/// Block HTML that ends a table row in marked, besides `<script`, `<pre`,
/// `<style`, `<textarea` and `<!--`.
const TABLE_ENDING_HTML: &str =
    "address article aside base basefont blockquote body caption center col colgroup dd \
     details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 \
     h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav \
     noframes ol optgroup option p param search section summary table tbody td tfoot th thead \
     title tr track ul";

/// Whether marked ends a table before this line: indented code, an ATX
/// heading, a quote, a fence, a thematic break, a bullet or a `1.` or `1)`
/// item, or block HTML at the start of the line, in lowercase.
fn ends_table(line: &str) -> bool {
    let indent = line.bytes().take_while(|byte| *byte == b' ').count();
    let rest = &line[indent..];
    if indent >= 4 || rest.starts_with('\t') {
        return true;
    }
    let hashes = rest.bytes().take_while(|byte| *byte == b'#').count();
    let heading = (1..=6).contains(&hashes)
        && rest[hashes..]
            .chars()
            .next()
            .is_none_or(char::is_whitespace);
    let item = rest
        .strip_prefix(['-', '*', '+'])
        .or_else(|| rest.strip_prefix("1."))
        .or_else(|| rest.strip_prefix("1)"))
        .is_some_and(|after| after.starts_with([' ', '\t']));
    rest.starts_with('>')
        || rest.starts_with("```")
        || rest.starts_with("~~~")
        || heading
        || thematic_break(rest)
        || item
        || paragraph_ending_html(line)
}

fn paragraph_ending_html(line: &str) -> bool {
    line.strip_prefix('<').is_some_and(|tag| {
        ["script", "pre", "style", "textarea", "!--"]
            .iter()
            .any(|start| tag.starts_with(start))
            || {
                let tag = tag.strip_prefix('/').unwrap_or(tag);
                let end = tag
                    .find(|c: char| !c.is_ascii_alphanumeric())
                    .unwrap_or(tag.len());
                TABLE_ENDING_HTML
                    .split_ascii_whitespace()
                    .any(|element| element == &tag[..end])
                    && (tag[end..].is_empty()
                        || tag[end..].starts_with([' ', '>'])
                        || tag[end..].starts_with("/>"))
            }
    })
}

fn parse_heading(line: &str) -> Option<(i64, String)> {
    let indent = line.bytes().take_while(|byte| *byte == b' ').count();
    if indent > 3 {
        return None;
    }
    let line = &line[indent..];
    let hashes = line.bytes().take_while(|byte| *byte == b'#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = line[hashes..].strip_prefix(' ')?;
    if rest.is_empty() {
        return None;
    }
    Some((hashes as i64, rest.to_string()))
}

/// A bullet item's marker and text: `-`, `*` or `+`, then one space.
fn parse_bullet_item(line: &str) -> Option<(char, &str)> {
    let marker = line
        .chars()
        .next()
        .filter(|c| matches!(c, '-' | '*' | '+'))?;
    Some((marker, line[1..].strip_prefix(' ')?))
}

/// A numbered item: one to nine digits, then `.` or `)` and one space.
fn parse_ordered_item(line: &str, bare: bool) -> Option<(i64, &str)> {
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 9 {
        return None;
    }
    let rest = line[digits..].strip_prefix(['.', ')'])?;
    let rest = rest
        .strip_prefix(' ')
        .or_else(|| (bare && rest.is_empty()).then_some(rest))?;
    let ordinal = line[..digits].parse::<i64>().ok()?;
    Some((ordinal, rest))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ListKind {
    Bullet(char),
    Ordered(char),
    Task(char),
}

#[derive(Clone, Copy)]
struct ListMarker<'a> {
    kind: ListKind,
    spelling: &'a str,
    indent: usize,
    start: i64,
    width: usize,
    checked: bool,
    text: &'a str,
}

#[inline(always)]
fn list_marker(line: &str, reading: MarkdownReading) -> Option<ListMarker<'_>> {
    if !matches!(
        *line.as_bytes().first()?,
        b' ' | b'-' | b'+' | b'*' | b'0'..=b'9'
    ) {
        return None;
    }
    let indent = line.bytes().take_while(|byte| *byte == b' ').count();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    if thematic_break(rest) {
        return None;
    }
    let bullet = parse_bullet_item(rest).or_else(|| {
        (reading != MarkdownReading::Source && matches!(rest, "-" | "*" | "+"))
            .then(|| (rest.chars().next().unwrap(), &rest[rest.len()..]))
    });
    if let Some((bullet, text)) = bullet {
        let padding = text.bytes().take_while(|byte| *byte == b' ').count();
        let padding = if padding < 4 && padding < text.len() {
            padding
        } else {
            0
        };
        let text = &text[padding..];
        let task = if text.starts_with('[')
            && (text.len() == 3
                || text
                    .as_bytes()
                    .get(3)
                    .is_some_and(|byte| matches!(byte, b' ' | b'\t')))
        {
            match text.get(..3) {
                Some("[ ]") => Some(false),
                Some("[x]" | "[X]") => Some(true),
                _ => None,
            }
        } else {
            None
        };
        return Some(ListMarker {
            spelling: &rest[..1],
            kind: if task.is_some() {
                ListKind::Task(bullet)
            } else {
                ListKind::Bullet(bullet)
            },
            indent,
            start: 1,
            width: 2 + padding,
            checked: task.unwrap_or(false),
            text: if task.is_some() {
                text[3..].trim_start_matches([' ', '\t'])
            } else {
                text
            },
        });
    }
    let (start, text) = parse_ordered_item(rest, reading != MarkdownReading::Source)?;
    let width = rest.bytes().take_while(u8::is_ascii_digit).count() + 2;
    let padding = text.bytes().take_while(|byte| *byte == b' ').count();
    let padding = if padding < 4 && padding < text.len() {
        padding
    } else {
        0
    };
    Some(ListMarker {
        spelling: &rest[..width - 1],
        kind: ListKind::Ordered(rest.as_bytes()[width - 2] as char),
        indent,
        start,
        width: width + padding,
        checked: false,
        text: &text[padding..],
    })
}

#[inline(always)]
fn structural_item_start(text: &str) -> bool {
    text.as_bytes().first().is_some_and(|byte| {
        matches!(
            byte,
            b' ' | b'\t'
                | b'&'
                | b'#'
                | b'>'
                | b'`'
                | b'~'
                | b'-'
                | b'*'
                | b'_'
                | b'+'
                | b'$'
                | b'<'
                | b'['
                | b'0'..=b'9'
        )
    })
}

fn plain_bullet_prefix<'src>(
    lines: &[&'src str],
    start: usize,
    marker: ListMarker<'_>,
) -> (Vec<&'src str>, usize) {
    let ListKind::Bullet(bullet) = marker.kind else {
        return (Vec::new(), start);
    };
    if marker.indent != 0 {
        return (Vec::new(), start);
    }
    let prefix = match bullet {
        '*' => "* ",
        '+' => "+ ",
        _ => "- ",
    };
    let mut items = Vec::new();
    let mut end = start;
    while let Some(text) = lines
        .get(end)
        .and_then(|line| line.strip_prefix(prefix))
        .filter(|text| !structural_item_start(text))
    {
        items.push(text);
        end += 1;
    }
    (items, end)
}

fn empty_list_child(mut text: &str, mut reading: MarkdownReading) -> bool {
    for _ in 0..MARKDOWN_XML_MAX_DEPTH {
        let Some(child) = list_marker(text, reading) else {
            break;
        };
        if matches!(child.kind, ListKind::Task(_)) {
            return false;
        }
        if child.text.trim().is_empty() {
            return true;
        }
        text = child.text;
        reading = MarkdownReading::ProjectedSource;
    }
    false
}

// Marked keeps bullet/task switches and blank-separated items in one list.
fn marked_list_continues(lines: &[&str], at: usize, first: ListMarker<'_>) -> bool {
    lines[at..]
        .iter()
        .find(|line| !blank_line(line))
        .is_some_and(|line| {
            list_marker(line, MarkdownReading::ProjectedSource).is_some_and(|next| {
                match (first.kind, next.kind) {
                    (ListKind::Ordered(a), ListKind::Ordered(b)) => a == b,
                    (
                        ListKind::Bullet(a) | ListKind::Task(a),
                        ListKind::Bullet(b) | ListKind::Task(b),
                    ) => a == b,
                    _ => false,
                }
            })
        })
}

fn trim_list_item_end(text: &str) -> &str {
    text.trim_end_matches(|character| character != '\t' && is_js_whitespace(character))
}

// Marked's list scan uses a narrower boundary than its block tokenizer.
fn list_lazy_end(line: &str, max_indent: usize, html: bool) -> bool {
    let indent = line.bytes().take_while(|byte| *byte == b' ').count();
    if indent > max_indent {
        return false;
    }
    let rest = &line[indent..];
    rest.starts_with('#')
        || rest.starts_with("```")
        || rest.starts_with("~~~")
        || thematic_break(rest)
        || (html
            && (rest.starts_with("<!--")
                || rest.strip_prefix('<').is_some_and(|tag| {
                    tag.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) && tag.contains('>')
                })))
}

fn parse_list<'src>(
    lines: &[&'src str],
    start: usize,
    first: ListMarker<'src>,
    depth: usize,
    quote_depth: usize,
    reading: MarkdownReading,
    refused: &mut bool,
) -> Option<(MdBlock<'src>, usize)> {
    if depth + 3 > MARKDOWN_XML_MAX_DEPTH {
        *refused = true;
        return None;
    }
    *refused |= first.text.trim_start_matches(' ').starts_with('\t');
    let (mut plain_items, prefix_end) = plain_bullet_prefix(lines, start, first);
    let after_blank = (prefix_end..lines.len()).find(|&at| !blank_line(lines[at]));
    let ends_before_block = prefix_end > start
        && lines.get(prefix_end).is_some_and(|line| blank_line(line))
        && after_blank.is_none_or(|at| {
            !lines[at].starts_with([' ', '\t'])
                && list_marker(lines[at], reading).is_none_or(|next| next.kind != first.kind)
        });
    if prefix_end == lines.len() || ends_before_block {
        if !marked_list_continues(lines, prefix_end, first) {
            if let Some(last) = plain_items.last_mut() {
                *last = trim_list_item_end(last);
            }
        }
        return Some((
            MdBlock::BulletList(MdBulletItems::Plain(plain_items)),
            prefix_end,
        ));
    }
    let mut items = Vec::with_capacity(prefix_end - start);
    let mut checks = Vec::new();
    let mut at = start;
    let mut next_marker = Some(first);
    let mut last_body_ends_bare_quote = false;
    if prefix_end > start + 1 {
        plain_items.pop();
        items.extend(plain_items.into_iter().map(|text| MdListItem {
            paragraph: text.into(),
            blocks: None,
        }));
        at = prefix_end - 1;
        next_marker = Some(ListMarker {
            text: &lines[at][2..],
            ..first
        });
    }
    while let Some(marker) = next_marker.take() {
        if marker.kind != first.kind {
            break;
        }
        // The checkbox is content after the bullet marker, not part of its width.
        let content_indent = marker.indent + marker.width;
        let lazy_limit = 3.min(content_indent - 1);
        let after_marker = &lines[at][marker.indent..]
            .trim_start_matches(|character: char| character.is_ascii_digit())[1..];
        let mut previous_ends_lazy = after_marker
            .bytes()
            .take_while(|byte| *byte == b' ')
            .count()
            >= 4
            || list_lazy_end(after_marker, lazy_limit, false);
        at += 1;
        let mut continued = Vec::new();
        while let Some(line) = lines.get(at) {
            if let Some(next) =
                list_marker(line, reading).filter(|next| next.indent < content_indent)
            {
                *refused |= next.indent > marker.indent;
                next_marker = Some(next);
                break;
            }
            if continued.is_empty()
                && marker.text.trim().is_empty()
                && !matches!(marker.kind, ListKind::Task(_))
                && (blank_line(line)
                    || line.bytes().take_while(|byte| *byte == b' ').count() < content_indent)
            {
                *refused |= if blank_line(line) {
                    lines[at..]
                        .iter()
                        .find(|line| !blank_line(line))
                        .is_some_and(|line| {
                            let indent = line.bytes().take_while(|byte| *byte == b' ').count();
                            (indent > marker.indent && indent < content_indent)
                                || (matches!(
                                    reading,
                                    MarkdownReading::Source | MarkdownReading::Projection
                                ) && lines[at..]
                                    .iter()
                                    .skip_while(|line| blank_line(line))
                                    .map_while(|line| list_marker(line, reading))
                                    .take_while(|next| next.indent > marker.indent)
                                    .any(|next| next.indent < content_indent))
                        })
                } else {
                    line.trim_start_matches(' ').starts_with('\t')
                };
                break;
            }
            if blank_line(line) {
                let next = (at..lines.len()).find(|&index| !blank_line(lines[index]));
                if let Some(next) = next.filter(|&index| {
                    lines[index]
                        .bytes()
                        .take_while(|byte| *byte == b' ')
                        .count()
                        >= content_indent
                }) {
                    continued.resize(continued.len() + next - at, "");
                    at = next;
                    previous_ends_lazy = false;
                    continue;
                }
                if let Some(next) = next {
                    let indent = lines[next].bytes().take_while(|byte| *byte == b' ').count();
                    *refused |= indent > marker.indent
                        && indent < content_indent
                        && (list_marker(lines[next], reading).is_some()
                            || continued
                                .iter()
                                .rposition(|line| !blank_line(line))
                                .map_or_else(
                                    || {
                                        empty_list_child(
                                            marker.text,
                                            MarkdownReading::ProjectedSource,
                                        )
                                    },
                                    |at| {
                                        empty_list_child(
                                            continued[at],
                                            if at > 0 && blank_line(continued[at - 1]) {
                                                MarkdownReading::ProjectedSource
                                            } else {
                                                MarkdownReading::Source
                                            },
                                        )
                                    },
                                ));
                }
                break;
            }
            let indent = line.bytes().take_while(|byte| *byte == b' ').count();
            if indent >= content_indent {
                continued.push(&line[content_indent..]);
            } else if !previous_ends_lazy
                && !list_lazy_end(line, lazy_limit, true)
                && block_start(line, false, false).is_none()
            {
                continued.push(line);
            } else {
                break;
            }
            previous_ends_lazy = indent >= content_indent + 4
                || list_lazy_end(continued.last().unwrap(), lazy_limit, false);
            at += 1;
        }
        last_body_ends_bare_quote = continued
            .last()
            .copied()
            .unwrap_or(marker.text)
            .trim_start_matches(' ')
            .strip_prefix('>')
            .is_some_and(|tail| tail.trim().is_empty());
        let item = if continued.is_empty() && !structural_item_start(marker.text) {
            MdListItem {
                paragraph: marker.text.into(),
                blocks: None,
            }
        } else {
            let mut body = Vec::with_capacity(continued.len() + 1);
            body.push(marker.text);
            body.extend(continued);
            let blocks =
                parse_markdown_blocks_at(&body, depth + 2, quote_depth, reading, true, refused);
            let mut blocks = blocks.into_iter();
            let first_block = blocks.next();
            match first_block {
                Some(MdBlock::Paragraph(paragraph))
                    if !marker.text.trim().is_empty()
                        || (matches!(marker.kind, ListKind::Task(_))
                            && body.get(1).is_some_and(|line| !blank_line(line))) =>
                {
                    let following: Vec<_> = blocks.collect();
                    MdListItem {
                        paragraph: paragraph.into_boxed_str(),
                        blocks: (!following.is_empty()).then(|| Box::new(following)),
                    }
                }
                other => MdListItem {
                    paragraph: Box::default(),
                    blocks: Some(Box::new(other.into_iter().chain(blocks).collect())),
                },
            }
        };
        items.push(item);
        if matches!(first.kind, ListKind::Task(_)) {
            checks.push(marker.checked);
        }
        if reading == MarkdownReading::Source {
            while lines.get(at).is_some_and(|line| blank_line(line)) {
                at += 1;
            }
        }
        if next_marker.is_none() {
            next_marker = lines.get(at).and_then(|line| list_marker(line, reading));
        }
    }
    if !marked_list_continues(lines, at, first) {
        if let Some(last) = items.last_mut() {
            if let Some(blocks) = &mut last.blocks {
                let mut tail = blocks.last_mut();
                if !last_body_ends_bare_quote {
                    while let Some(MdBlock::Quote(inner)) = tail {
                        tail = inner.last_mut();
                    }
                }
                if let Some(MdBlock::Paragraph(text)) = tail {
                    text.truncate(trim_list_item_end(text).len());
                }
            } else {
                let trimmed = trim_list_item_end(&last.paragraph);
                if trimmed.len() != last.paragraph.len() {
                    last.paragraph = trimmed.into();
                }
            }
        }
    }
    let block = match first.kind {
        ListKind::Bullet(_) => MdBlock::BulletList(MdBulletItems::Blocks(items)),
        ListKind::Ordered(_) => MdBlock::OrderedList {
            start: first.start,
            items,
        },
        ListKind::Task(_) => MdBlock::TaskList(checks.into_iter().zip(items).collect()),
    };
    Some((block, at))
}

fn insert_md_paragraph<F: XmlFragment>(
    txn: &mut yrs::TransactionMut<'_>,
    parent: &F,
    index: u32,
    text: &str,
) {
    let el = parent.insert(txn, index, XmlElementPrelim::empty("paragraph"));
    let spans = if text.contains("&#") {
        inline_code_spans(text)
    } else {
        Vec::new()
    };
    if spans.is_empty() {
        if !text.is_empty() {
            el.insert(txn, 0, XmlTextPrelim::new(text));
        }
        return;
    }
    let target = el.insert(txn, 0, XmlTextPrelim::new(""));
    use yrs::types::{Attrs, Delta};
    let code: Attrs = [("code".into(), Any::Map(Default::default()))].into();
    let mut cursor = 0;
    let mut runs = Vec::new();
    for span in spans {
        let content = &text[span.clone()];
        let width = content.bytes().take_while(|b| *b == b'`').count();
        let mut value = &text[span.start + width..span.end - width];
        if value.starts_with(' ') && value.ends_with(' ') && !value.bytes().all(|b| b == b' ') {
            value = &value[1..value.len() - 1];
        }
        if !render_inline_code(value).is_ok_and(|rendered| rendered == content) {
            continue;
        }
        runs.push(Delta::Inserted(text[cursor..span.start].to_owned(), None));
        let value = value.to_owned();
        runs.push(Delta::Inserted(value, Some(Box::new(code.clone()))));
        cursor = span.end;
    }
    runs.push(Delta::Inserted(text[cursor..].to_owned(), None));
    target.apply_delta(txn, runs);
}

fn insert_md_list_item<F: XmlFragment, const WIRE_DEFAULTS: bool>(
    txn: &mut yrs::TransactionMut<'_>,
    parent: &F,
    item: &MdListItem<'_>,
) {
    for block in item.blocks().iter().rev() {
        insert_md_block::<_, WIRE_DEFAULTS>(txn, parent, 0, block);
    }
    insert_md_paragraph(txn, parent, 0, &item.paragraph);
}

fn insert_md_block<F: XmlFragment, const WIRE_DEFAULTS: bool>(
    txn: &mut yrs::TransactionMut<'_>,
    parent: &F,
    index: u32,
    block: &MdBlock<'_>,
) {
    match block {
        MdBlock::Paragraph(text) => insert_md_paragraph(txn, parent, index, text),
        MdBlock::Heading { level, text } => {
            let el = parent.insert(txn, index, XmlElementPrelim::empty("heading"));
            el.insert_attribute(txn, "level", *level);
            el.insert(txn, 0, XmlTextPrelim::new(text.as_str()));
        }
        MdBlock::Quote(children) => {
            let el = parent.insert(txn, index, XmlElementPrelim::empty("blockquote"));
            for child in children.iter().rev() {
                insert_md_block::<_, WIRE_DEFAULTS>(txn, &el, 0, child);
            }
        }
        MdBlock::BulletList(items) => {
            let el = parent.insert(txn, index, XmlElementPrelim::empty("bulletList"));
            match items {
                MdBulletItems::Plain(items) => {
                    for text in items.iter().rev() {
                        let li = el.insert(txn, 0, XmlElementPrelim::empty("listItem"));
                        insert_md_paragraph(txn, &li, 0, text);
                    }
                }
                MdBulletItems::Blocks(items) => {
                    for item in items.iter().rev() {
                        let li = el.insert(txn, 0, XmlElementPrelim::empty("listItem"));
                        insert_md_list_item::<_, WIRE_DEFAULTS>(txn, &li, item);
                    }
                }
            }
        }
        MdBlock::OrderedList { start, items } => {
            let el = parent.insert(txn, index, XmlElementPrelim::empty("orderedList"));
            el.insert_attribute(txn, "start", *start);
            for item in items.iter().rev() {
                let li = el.insert(txn, 0, XmlElementPrelim::empty("listItem"));
                insert_md_list_item::<_, WIRE_DEFAULTS>(txn, &li, item);
            }
        }
        MdBlock::TaskList(items) => {
            let el = parent.insert(txn, index, XmlElementPrelim::empty("taskList"));
            for (checked, item) in items.iter().rev() {
                let li = el.insert(txn, 0, XmlElementPrelim::empty("taskItem"));
                li.insert_attribute(txn, "checked", *checked);
                insert_md_list_item::<_, WIRE_DEFAULTS>(txn, &li, item);
            }
        }
        MdBlock::CodeBlock { language, content } => {
            let el = parent.insert(txn, index, XmlElementPrelim::empty("codeBlock"));
            if !language.is_empty() {
                el.insert_attribute(txn, "language", language.as_str());
            }
            if !content.is_empty() {
                el.insert(txn, 0, XmlTextPrelim::new(content.as_str()));
            }
        }
        MdBlock::Rule => {
            parent.insert(txn, index, XmlElementPrelim::empty("horizontalRule"));
        }
        MdBlock::Table {
            rows,
            alignments,
            row_heights,
        } => {
            let table = parent.insert(txn, index, XmlElementPrelim::empty("table"));
            for (row_index, cells) in rows.iter().enumerate().rev() {
                let row = table.insert(txn, 0, XmlElementPrelim::empty("tableRow"));
                if let Some(height) = row_heights.get(&row_index) {
                    row.insert_attribute(txn, "height", *height);
                }
                let tag = if row_index == 0 {
                    "tableHeader"
                } else {
                    "tableCell"
                };
                for (cell_index, text) in cells.iter().enumerate().rev() {
                    let cell = row.insert(txn, 0, XmlElementPrelim::empty(tag));
                    if WIRE_DEFAULTS {
                        cell.insert_attribute(txn, "colspan", 1_i64);
                        cell.insert_attribute(txn, "rowspan", 1_i64);
                    }
                    if let Some(Some(align)) = alignments.get(cell_index) {
                        cell.insert_attribute(txn, "align", align.attribute());
                    }
                    // A cell keeps its text as written; the document holds it
                    // with pipe escaping and the projector's one layer of
                    // entity encoding undone.
                    let text = decode_html_entities_once(&text.replace("\\|", "|"));
                    insert_md_paragraph(txn, &cell, 0, &text);
                }
            }
        }
    }
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

// ---- canonical content JSON (ported from the spike harness `main.rs`) -------

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

fn xml_json<T: ReadTxn>(txn: &T, node: XmlOut) -> Value {
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

// ---- markdown projection helpers -------------------------------------------

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
            let children = element
                .children(txn)
                .map(|child| {
                    markdown_node(txn, child, depth + 1, remaining_nodes, source_text_bytes)
                })
                .collect::<ProjectionResult<_>>()?;
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
    if markdown_output_is_empty(&rendered) {
        Ok(String::new())
    } else {
        Ok(trim_js_end(&rendered).to_string())
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
    let markdown = markdown.replace('\r', "&#13;");
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

/// Whether marked reads this line as indented code: four spaces, or a tab
/// after fewer, then text. It strips up to four spaces or that one tab.
fn indented_code_line(line: &str) -> bool {
    let spaces = line.bytes().take_while(|byte| *byte == b' ').count();
    let rest = &line[spaces.min(4)..];
    match spaces {
        4.. => !rest.is_empty(),
        _ => rest.strip_prefix('\t').is_some_and(|text| !text.is_empty()),
    }
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

/// The bytes `written_as_references` writes for `text[from..to]`.
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
                    if matches!(context.parent_tag, "doc" | "listItem" | "taskItem")
                        && rendered.starts_with(' ')
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
                render_nodes(children, tag, attrs, "\n", table_cell)
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
        let child_rendered = if index == 0 && empty_marker {
            child_rendered.trim_start_matches('\n')
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
        } else if matches!(
            element_tag(child),
            Some("paragraph" | "horizontalRule" | "mathBlock")
        ) || (matches!(
            element_tag(previous),
            Some("paragraph" | "mathBlock" | "table" | "blockquote" | "callout")
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

impl TableAlign {
    fn attribute(self) -> &'static str {
        match self {
            TableAlign::Left => "left",
            TableAlign::Right => "right",
            TableAlign::Center => "center",
        }
    }
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
            let text = prepare_rendered_table_cell(&collapse_js_whitespace(&raw.into_string())?)?;
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
    output.push_str(&render_table_row_heights(&row_heights)?)?;
    output.push_str("\n| ")?;
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

fn collapse_js_whitespace(value: &str) -> ProjectionResult<String> {
    let mut collapsed = ProjectionBuffer::new();
    let mut in_whitespace = false;
    for character in value.chars() {
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
    struct InlineReplacement {
        text: std::borrow::Cow<'static, str>,
        preserve_marks: bool,
        /// The bytes it replaces.
        width: usize,
    }

    type InlineReplacements = BTreeMap<usize, BTreeMap<usize, InlineReplacement>>;

    // Splits each text part at its replaced bytes, which become literal
    // Markdown parts. A replacement's own text moves into its part.
    fn apply_inline_replacements<'a>(
        parts: Vec<InlinePart<'a>>,
        mut replacements: InlineReplacements,
    ) -> Vec<InlinePart<'a>> {
        // Each part this makes owns a new string.
        fn materialize<'a>(parts: &mut Vec<InlinePart<'a>>, part: InlinePart<'a>) {
            #[cfg(test)]
            INLINE_PARTS_MATERIALIZED.with(|count| count.set(count.get() + 1));
            parts.push(part);
        }
        let mut escaped_parts = Vec::new();
        for (part_index, part) in parts.into_iter().enumerate() {
            let Some(part_replacements) = replacements.remove(&part_index) else {
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
            let mut cursor = 0usize;
            for (offset, replacement) in part_replacements {
                if offset > cursor {
                    materialize(
                        &mut escaped_parts,
                        InlinePart::Text {
                            run: TextRun {
                                text: run.text[cursor..offset].to_string(),
                                marks: run.marks.clone(),
                            },
                            literal_markdown,
                        },
                    );
                }
                cursor = offset + replacement.width;
                materialize(
                    &mut escaped_parts,
                    InlinePart::Text {
                        run: TextRun {
                            text: replacement.text.into_owned(),
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
            if cursor < run.text.len() {
                let mut text = run;
                text.text = text.text[cursor..].to_string();
                materialize(
                    &mut escaped_parts,
                    InlinePart::Text {
                        run: text,
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
    // `&`, `<`, and `>` as they are, and each line its title starts, which no
    // block opener or indent escape then reads. A part's links, with the text
    // between two of them that holds no newline, `&`, `<`, or `>`, are one
    // literal part, written as the later passes write the rest: a `\r` as a
    // reference where they escape block syntax, a highlight's `=` as `\=`.
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
        escape_block_syntax: bool,
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
        // The stretches written as literal parts: those that hold a newline,
        // `&`, `<`, or `>`.
        let mut stretches = Vec::new();
        let mut offset = 0usize;
        for (part_index, (text, ranges)) in texts.iter().zip(&empty_links).enumerate() {
            let link = text.as_bytes();
            let mut write = |(from, to): (usize, usize)| {
                if link[from..to]
                    .iter()
                    .any(|byte| matches!(byte, b'\n' | b'&' | b'<' | b'>'))
                {
                    stretches.push((part_index, from, to));
                }
            };
            let mut stretch: Option<(usize, usize)> = None;
            for &(from, to) in ranges {
                // A link inside the span reads back as the span does.
                if in_span(offset + from, offset + to) {
                    continue;
                }
                stretch = match stretch {
                    Some((start, end))
                        if !in_span(offset + end, offset + from)
                            && !link[end..from]
                                .iter()
                                .any(|byte| matches!(byte, b'\n' | b'&' | b'<' | b'>')) =>
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
        // The output holds every byte of the text, and each literal link and
        // reference writes at least the bytes it replaces, so their encoded
        // length is admitted before any of them is written. The span writes
        // no byte of a link written as references.
        let reference_len = |code: u32| if code < 100 { 5 } else { 6 };
        let mut projected = bytes.len();
        for &(part_index, from, to) in &stretches {
            let link = &texts[part_index].as_bytes()[from..to];
            let count = |wanted: u8| link.iter().filter(|&&byte| byte == wanted).count();
            let returns = if escape_block_syntax {
                count(b'\r') * 4
            } else {
                0
            };
            let equals = if highlighted_part(part_index) {
                count(b'=')
            } else {
                0
            };
            projected = checked_projection_len(projected, returns + equals)?;
        }
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
            let text = texts[part_index];
            let highlighted = highlighted_part(part_index);
            let mut written = ProjectionBuffer::with_capacity(to - from)?;
            for character in text[from..to].chars() {
                match character {
                    '\r' if escape_block_syntax => written.push_str("&#13;")?,
                    '=' if highlighted => written.push_str("\\=")?,
                    _ => written.push(character)?,
                }
            }
            #[cfg(test)]
            LITERAL_LINKS_WRITTEN.with(|count| count.set(count.get() + 1));
            replacements.entry(part_index).or_default().insert(
                from,
                InlineReplacement {
                    text: written.into_string().into(),
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
                                text: written_as_references(text, start, at, highlighted)?.into(),
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
                    text: format!("&#{code};").into(),
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
                    text: "\n".into(),
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
                    text: encoded_block_punctuation(byte).into(),
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
        let raw_html = raw_html_replacements(&parts, table_cell, definition, escape_block_syntax)?;
        if !raw_html.is_empty() {
            parts = apply_inline_replacements(parts, raw_html);
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
                if byte == b'\r' {
                    replacements.entry(part_index).or_default().insert(
                        offset,
                        InlineReplacement {
                            text: "&#13;".into(),
                            preserve_marks: true,
                            width: 1,
                        },
                    );
                    if captures_line {
                        line.push(byte);
                        positions.push((part_index, offset));
                    }
                    continue;
                }
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
                                    text: replacement.into(),
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
            parts = apply_inline_replacements(parts, replacements);
        }
    }

    let mut rendered_nodes = BTreeMap::new();
    let mut starts_line = true;
    let mut part_index = 0usize;
    while escape_block_syntax && part_index < parts.len() {
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

    let mut output = ProjectionBuffer::new();
    let mut active: Vec<MarkdownMark> = Vec::new();
    let mut modes: BTreeMap<MarkKind, OpeningMode> = BTreeMap::new();
    let mut reopen_html = BTreeSet::new();

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
                let mut text = run.text.clone();
                if !literal_markdown && has_mark(&run.marks, MarkKind::Highlight) {
                    text = escape_highlight_equals(&text)?;
                }
                if !literal_markdown && !code_context && !has_mark(&run.marks, MarkKind::Code) {
                    text = encode_html_entities(&text)?;
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
    use std::sync::Arc;

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
    fn scene_roots_apply_in_any_order_and_project_identically() {
        let revisions = Ydoc::wire();
        let revision_update = scene_map_set(
            &revisions,
            ROOT_SCENE_REVISIONS,
            "[\"box\",1,1]",
            "{\"id\":\"box\",\"isDeleted\":false,\"type\":\"rectangle\",\"version\":1,\"versionNonce\":1}",
        );
        let state = Ydoc::wire();
        let state_update = scene_map_set(&state, ROOT_SCENE_APP_STATE, "theme", "\"dark\"");

        let forward = Ydoc::wire();
        forward.apply(&revision_update).expect("revision update");
        forward.apply(&state_update).expect("state update");
        let reverse = Ydoc::wire();
        reverse.apply(&state_update).expect("state update");
        reverse.apply(&revision_update).expect("revision update");

        assert_eq!(forward.canonical_content(), reverse.canonical_content());
        assert_eq!(
            forward
                .project(ContentKind::Scene)
                .expect("scene projection")
                .content,
            reverse
                .project(ContentKind::Scene)
                .expect("scene projection")
                .content
        );
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
    fn canonical_fingerprint_includes_scene_root_values() {
        let first = Ydoc::wire();
        scene_map_set(&first, ROOT_SCENE_APP_STATE, "theme", "\"dark\"");
        let second = Ydoc::wire();
        scene_map_set(&second, ROOT_SCENE_APP_STATE, "theme", "\"light\"");

        assert_ne!(first.canonical_content(), second.canonical_content());
        assert_ne!(
            first.canonical_content_sha256(),
            second.canonical_content_sha256()
        );
        assert_eq!(
            first.canonical_content()[ROOT_SCENE_APP_STATE]["type"],
            "map"
        );
        assert_ne!(
            first.canonical_content()[ROOT_SCENE_APP_STATE]["type"],
            "undeclaredRoot"
        );
    }

    #[test]
    fn file_fold_quote_guard_allows_code_and_preserves_the_document_on_overflow() {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, "original")
            .unwrap();
        let before = doc.encode_full_state();
        let deep = format!("{}deep", "> ".repeat(QUOTE_FOLD_MAX_DEPTH + 1));
        assert!(matches!(
            doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &deep),
            Err(CollabError::MarkdownQuoteDepthExceeded)
        ));
        assert_eq!(doc.encode_full_state(), before);
        let code = format!("```\n{deep}\n```");
        doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &code)
            .unwrap();
        assert_eq!(doc.project(ContentKind::Richdoc).unwrap().content, code);
        for depth in [QUOTE_FOLD_MAX_DEPTH - 1, QUOTE_FOLD_MAX_DEPTH] {
            let quote = format!("{}deep", "> ".repeat(depth));
            doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &quote)
                .unwrap();
            assert_eq!(doc.project(ContentKind::Richdoc).unwrap().content, quote);
        }
    }

    #[test]
    fn a_canonical_file_fold_clears_the_old_source_witness_without_storing_a_copy() {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "old\n")
            .unwrap();
        assert!(doc.markdown_source_reference().is_some());
        doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, "old")
            .unwrap();
        assert!(doc.markdown_source_reference().is_none());
        assert_eq!(doc.project(ContentKind::Richdoc).unwrap().content, "old");
    }

    #[test]
    fn scene_rejects_markdown_replacement() {
        let doc = Ydoc::wire();
        let error = doc
            .rewrite_content_to_markdown(ContentKind::Scene, "not a scene")
            .expect_err("scene replacement must use a scene operation");
        assert_eq!(error.code(), "markdown-rewrite-unsupported");
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

    fn nested_any_array(depth: usize, leaf: Any) -> Any {
        (0..depth).fold(leaf, |value, _| Any::Array(Arc::from([value])))
    }

    fn remote_doc_with_element_attribute(tag: &str, key: &str, value: Any) -> Ydoc {
        let source = Ydoc::wire();
        let body = source.doc.get_or_insert_xml_fragment(ROOT_BODY);
        {
            let mut txn = source.doc.transact_mut();
            let element = body.push_back(
                &mut txn,
                XmlElementPrelim::new(tag, std::iter::empty::<XmlIn>()),
            );
            element.insert_attribute(&mut txn, key, value);
        }
        let remote = Ydoc::wire();
        remote
            .apply(&source.encode_full_state())
            .expect("hostile test update is valid");
        remote
    }

    fn remote_doc_with_nested_mark_attribute(depth: usize) -> Ydoc {
        let source = Ydoc::wire();
        let body = source.doc.get_or_insert_xml_fragment(ROOT_BODY);
        {
            let mut txn = source.doc.transact_mut();
            let outer = body.push_back(
                &mut txn,
                XmlElementPrelim::new("blockquote", std::iter::empty::<XmlIn>()),
            );
            let paragraph = outer.push_back(
                &mut txn,
                XmlElementPrelim::new("paragraph", std::iter::empty::<XmlIn>()),
            );
            let text = paragraph.push_back(&mut txn, XmlTextPrelim::new("x"));
            text.format(
                &mut txn,
                0,
                1,
                Attrs::from([("link".into(), nested_any_array(depth, Any::Null))]),
            );
        }
        let remote = Ydoc::wire();
        remote
            .apply(&source.encode_full_state())
            .expect("hostile test update is valid");
        remote
    }

    fn text_run(value: &str, marks: Vec<MarkdownMark>) -> MarkdownNode {
        MarkdownNode::Text(vec![TextRun {
            text: value.to_string(),
            marks,
        }])
    }

    fn code_mark() -> MarkdownMark {
        MarkdownMark {
            kind: MarkKind::Code,
            attrs: Value::Object(serde_json::Map::new()),
        }
    }

    #[test]
    fn unknown_xml_elements_preserve_descendant_text() {
        let nodes = vec![MarkdownNode::Element {
            tag: "futureNode".to_string(),
            attrs: BTreeMap::new(),
            children: vec![MarkdownNode::Text(vec![TextRun {
                text: "content survives".to_string(),
                marks: Vec::new(),
            }])],
        }];

        assert_eq!(
            markdown_document(&nodes).expect("small projection"),
            "content survives"
        );
    }

    #[test]
    fn inline_node_line_endings_preserve_text_and_protect_following_block_openers() {
        for (line_ending, expected) in [
            ("\n", "before\n\\- still paragraph text"),
            ("\r", "before&#13;- still paragraph text"),
            ("\r\n", "before&#13;\n\\- still paragraph text"),
        ] {
            let nodes = vec![MarkdownNode::Element {
                tag: "paragraph".to_string(),
                attrs: BTreeMap::new(),
                children: vec![
                    MarkdownNode::Element {
                        tag: "futureInline".to_string(),
                        attrs: BTreeMap::new(),
                        children: vec![text_run(&format!("before{line_ending}"), Vec::new())],
                    },
                    text_run("- still paragraph text", Vec::new()),
                ],
            }];

            assert_eq!(
                markdown_document(&nodes).expect("small projection"),
                expected
            );
        }
    }

    #[test]
    fn inline_node_raw_attributes_preserve_carriage_returns() {
        for nested in [false, true] {
            let math = MarkdownNode::Element {
                tag: "mathInline".to_string(),
                attrs: BTreeMap::from([("tex".to_string(), Value::String("x\ry".to_string()))]),
                children: Vec::new(),
            };
            let child = if nested {
                MarkdownNode::Element {
                    tag: "futureInline".to_string(),
                    attrs: BTreeMap::new(),
                    children: vec![math],
                }
            } else {
                math
            };
            let nodes = vec![MarkdownNode::Element {
                tag: "paragraph".to_string(),
                attrs: BTreeMap::new(),
                children: vec![child],
            }];

            assert_eq!(
                markdown_document(&nodes).expect("small projection"),
                "$x\ry$"
            );
        }
    }

    #[test]
    fn unknown_inline_nodes_protect_internal_block_openers() {
        let nodes = vec![MarkdownNode::Element {
            tag: "paragraph".to_string(),
            attrs: BTreeMap::new(),
            children: vec![MarkdownNode::Element {
                tag: "futureInline".to_string(),
                attrs: BTreeMap::new(),
                children: vec![text_run("before\n- still paragraph text", Vec::new())],
            }],
        }];

        assert_eq!(
            markdown_document(&nodes).expect("small projection"),
            "before\n&#45; still paragraph text"
        );
    }

    #[test]
    fn block_opener_escaping_encodes_cr_and_starts_lines_only_after_lf() {
        assert_eq!(
            escape_markdown_block_syntax("before\r---\rnext", true, false)
                .expect("small projection"),
            "before&#13;---&#13;next"
        );
        assert_eq!(
            escape_markdown_block_syntax("before\r\n---\r\nnext", true, false)
                .expect("small projection"),
            "before&#13;\n---&#13;\nnext"
        );
    }

    #[test]
    fn code_block_uses_collision_free_backtick_fence() {
        let nodes = vec![MarkdownNode::Element {
            tag: "codeBlock".to_string(),
            attrs: BTreeMap::from([("language".to_string(), Value::String("js".to_string()))]),
            children: vec![text_run("before\n```\nafter", Vec::new())],
        }];

        assert_eq!(
            markdown_document(&nodes).expect("small projection"),
            "````js\nbefore\n```\nafter\n````"
        );
    }

    #[test]
    fn code_block_language_with_backticks_uses_collision_free_tilde_fence() {
        for language in ["lang`tick", "`leading", "```leading", "~lang`tick"] {
            for content in ["", "code", "before\n~~~\n```\nafter"] {
                let children = if content.is_empty() {
                    Vec::new()
                } else {
                    vec![text_run(content, Vec::new())]
                };
                let attrs =
                    BTreeMap::from([("language".to_string(), Value::String(language.into()))]);
                let fence = if content.contains("~~~") {
                    "~~~~"
                } else {
                    "~~~"
                };
                let padding = if language.starts_with('~') { " " } else { "" };
                assert_eq!(
                    render_code_block(&attrs, &children).expect("small projection"),
                    format!("{fence}{padding}{language}\n{content}\n{fence}")
                );
            }
        }
    }

    #[test]
    fn inline_code_uses_collision_free_commonmark_delimiters() {
        let nodes = vec![MarkdownNode::Element {
            tag: "paragraph".to_string(),
            attrs: BTreeMap::new(),
            children: vec![
                text_run("a`b", vec![code_mark()]),
                text_run(" / ", Vec::new()),
                text_run("`edge`", vec![code_mark()]),
                text_run(" / ", Vec::new()),
                text_run(" spaced ", vec![code_mark()]),
                text_run(" / ", Vec::new()),
                text_run("   ", vec![code_mark()]),
            ],
        }];

        assert_eq!(
            markdown_document(&nodes).expect("small projection"),
            "``a`b`` / `` `edge` `` / `  spaced  ` / `   `"
        );
    }

    #[test]
    fn adjacent_inline_code_runs_with_same_mark_share_one_fence() {
        let nodes = vec![MarkdownNode::Element {
            tag: "paragraph".to_string(),
            attrs: BTreeMap::new(),
            children: vec![
                text_run("a`", vec![code_mark()]),
                text_run("b", vec![code_mark()]),
            ],
        }];

        assert_eq!(
            markdown_document(&nodes).expect("small projection"),
            "``a`b``"
        );
    }

    #[test]
    fn table_pipe_escaping_respects_existing_backslashes_and_break_entities() {
        assert_eq!(
            prepare_rendered_table_cell(r"plain | odd \| even \\| &lt;br&gt; &amp;lt;br&amp;gt;")
                .expect("small projection"),
            r"plain \| odd \| even \\\| <br> <br>"
        );
    }

    #[test]
    fn table_literal_pipes_are_escaped_before_width_measurement() {
        let doc = remote_doc_with_body([xml_element(
            "table",
            &[],
            [
                xml_element(
                    "tableRow",
                    &[],
                    [
                        xml_element("tableHeader", &[], [paragraph("Value")]),
                        xml_element("tableHeader", &[], [paragraph("Other")]),
                    ],
                ),
                xml_element(
                    "tableRow",
                    &[],
                    [
                        xml_element("tableCell", &[], [paragraph("left | right")]),
                        xml_element("tableCell", &[], [paragraph("stable")]),
                    ],
                ),
            ],
        )]);

        assert_eq!(
            doc.project(ContentKind::Richdoc)
                .expect("small projection")
                .content,
            "\n| Value         | Other  |\n| ------------- | ------ |\n| left \\| right | stable |"
        );
    }

    #[test]
    fn headerless_table_promotes_first_row_to_header() {
        let doc = remote_doc_with_body([xml_element(
            "table",
            &[],
            [
                xml_element(
                    "tableRow",
                    &[],
                    [
                        xml_element("tableCell", &[], [paragraph("first")]),
                        xml_element("tableCell", &[], [paragraph("row")]),
                    ],
                ),
                xml_element(
                    "tableRow",
                    &[],
                    [
                        xml_element("tableCell", &[], [paragraph("second")]),
                        xml_element("tableCell", &[], [paragraph("row")]),
                    ],
                ),
            ],
        )]);

        assert_eq!(
            doc.project(ContentKind::Richdoc)
                .expect("small projection")
                .content,
            "\n| first  | row |\n| ------ | --- |\n| second | row |"
        );
    }

    fn remote_table_with_row_heights(heights: &[(u32, Any)]) -> Ydoc {
        let source = Ydoc::wire();
        let body = source.doc.get_or_insert_xml_fragment(ROOT_BODY);
        {
            let mut txn = source.doc.transact_mut();
            let table = body.push_back(
                &mut txn,
                XmlElementPrelim::new(
                    "table",
                    (0..4).map(|row| {
                        xml_element(
                            "tableRow",
                            &[],
                            [xml_element(
                                "tableCell",
                                &[],
                                [paragraph(format!("row {row}"))],
                            )],
                        )
                    }),
                ),
            );
            for (index, height) in heights {
                let XmlOut::Element(row) = table.get(&txn, *index).expect("row exists") else {
                    panic!("row {index} is an element");
                };
                row.insert_attribute(&mut txn, "height", height.clone());
            }
        }
        let remote = Ydoc::wire();
        remote
            .apply(&source.encode_full_state())
            .expect("test update is valid");
        remote
    }

    #[test]
    fn resized_table_rows_project_their_heights_above_the_table() {
        let doc = remote_table_with_row_heights(&[
            (1, Any::BigInt(84)),
            (2, Any::String("120".into())),
            (3, Any::Number(0.5)),
        ]);

        assert_eq!(
            doc.project(ContentKind::Richdoc)
                .expect("small projection")
                .content,
            "<!-- dohc:table row-heights=1:84,2:120 -->\n| row 0 |\n| ----- |\n| row 1 |\n| row 2 |\n| row 3 |"
        );
    }

    #[test]
    fn hostile_table_row_heights_are_omitted() {
        for hostile in [
            Any::BigInt(0),
            Any::BigInt(-84),
            Any::BigInt(1 << 53),
            Any::Bool(true),
            Any::String("84px".into()),
        ] {
            let doc = remote_table_with_row_heights(&[(1, hostile.clone())]);
            assert_eq!(
                doc.project(ContentKind::Richdoc)
                    .expect("small projection")
                    .content,
                "\n| row 0 |\n| ----- |\n| row 1 |\n| row 2 |\n| row 3 |",
                "{hostile:?} is not a row height"
            );
        }
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
            "###### bounded",
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

        // The property under test is that the projection refuses before the
        // amplifying allocation — 18 short rows padded to a 1 MiB column width
        // would materialize ~18 MB. Either bound refusing is correct: the byte
        // cap catches the padding, and the node/complexity budget catches the
        // 1 MiB text run that produces the width. Pinning one variant made this
        // test fail when the budget accounting tightened, even though the
        // protection held.
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
    fn multi_block_remote_table_cell_uses_gfm_inline_break() {
        let doc = remote_doc_with_body([xml_element(
            "table",
            &[],
            [
                xml_element(
                    "tableRow",
                    &[],
                    [xml_element(
                        "tableHeader",
                        &[("colspan", "1"), ("rowspan", "1")],
                        [paragraph("H")],
                    )],
                ),
                xml_element(
                    "tableRow",
                    &[],
                    [xml_element(
                        "tableCell",
                        &[("colspan", "1"), ("rowspan", "1")],
                        [paragraph("first"), paragraph("second")],
                    )],
                ),
            ],
        )]);

        let markdown = doc
            .project(ContentKind::Richdoc)
            .expect("small projection")
            .content;
        assert_eq!(
            markdown,
            "\n| H               |\n| --------------- |\n| first<br>second |"
        );
    }

    #[test]
    fn table_followed_by_nested_list_has_one_markdown_block_separator() {
        let doc = remote_doc_with_body([
            xml_element(
                "table",
                &[],
                [
                    xml_element(
                        "tableRow",
                        &[],
                        [
                            xml_element("tableHeader", &[], [paragraph("Metric")]),
                            xml_element("tableHeader", &[], [paragraph("Value")]),
                        ],
                    ),
                    xml_element(
                        "tableRow",
                        &[],
                        [
                            xml_element("tableCell", &[], [paragraph("apples")]),
                            xml_element("tableCell", &[], [paragraph("10")]),
                        ],
                    ),
                ],
            ),
            xml_element(
                "bulletList",
                &[],
                [xml_element(
                    "listItem",
                    &[],
                    [
                        paragraph("parent"),
                        xml_element(
                            "bulletList",
                            &[],
                            [xml_element("listItem", &[], [paragraph("nested")])],
                        ),
                    ],
                )],
            ),
        ]);

        assert_eq!(
            doc.project(ContentKind::Richdoc)
                .expect("small projection")
                .content,
            "\n| Metric | Value |\n| ------ | ----- |\n| apples | 10    |\n\n- parent\n  - nested"
        );
    }

    #[test]
    fn multiline_code_block_in_table_cell_uses_inline_code_and_breaks() {
        let doc = remote_doc_with_body([xml_element(
            "table",
            &[],
            [
                xml_element(
                    "tableRow",
                    &[],
                    [xml_element("tableHeader", &[], [paragraph("Code")])],
                ),
                xml_element(
                    "tableRow",
                    &[],
                    [xml_element(
                        "tableCell",
                        &[],
                        [xml_element(
                            "codeBlock",
                            &[("language", "mermaid")],
                            [xml_text("const fence = ```;\nleft | right <&>")],
                        )],
                    )],
                ),
            ],
        )]);

        let markdown = doc
            .project(ContentKind::Richdoc)
            .expect("small projection")
            .content;
        assert!(
            markdown.contains("````const fence = ```;````<br>`left \\| right <&>`"),
            "unexpected projection: {markdown}"
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
    fn alternating_format_runs_stop_before_copying_the_rejected_run() {
        const TEST_NODE_BUDGET: usize = 16;
        const RUNS: usize = TEST_NODE_BUDGET * 2;

        let source = Ydoc::wire();
        let body = source.doc.get_or_insert_xml_fragment(ROOT_BODY);
        {
            let mut txn = source.doc.transact_mut();
            let paragraph = body.push_back(
                &mut txn,
                XmlElementPrelim::new("paragraph", std::iter::empty::<XmlIn>()),
            );
            let text = paragraph.push_back(&mut txn, XmlTextPrelim::new("x".repeat(RUNS)));
            for index in 0..RUNS {
                text.format(
                    &mut txn,
                    index as u32,
                    1,
                    Attrs::from([("bold".into(), Any::Bool(index % 2 == 0))]),
                );
            }
        }
        let remote = Ydoc::wire();
        remote
            .apply(&source.encode_full_state())
            .expect("hostile alternating-format update is valid");

        PROJECTION_TEXT_BYTES_COPIED.with(|count| count.set(0));
        assert!(matches!(
            remote.project_richdoc_with_node_budget(TEST_NODE_BUDGET),
            Err(CollabError::ProjectionTooComplex { .. })
        ));
        PROJECTION_TEXT_BYTES_COPIED.with(|count| {
            assert_eq!(
                count.get(),
                (TEST_NODE_BUDGET - 2) / 2,
                "only admitted runs are copied: paragraph and text cost two nodes, each run and mark cost two"
            );
        });
    }

    #[test]
    fn two_mib_plain_body_uses_one_run_node() {
        let body = "x".repeat(2 * 1024 * 1024);
        let doc = remote_doc_with_body([paragraph(&body)]);
        PROJECTION_TEXT_BYTES_COPIED.with(|count| count.set(0));
        assert_eq!(doc.project_richdoc_with_node_budget(3).unwrap(), body);
        PROJECTION_TEXT_BYTES_COPIED.with(|count| assert_eq!(count.get(), body.len()));
        PROJECTION_TEXT_BYTES_COPIED.with(|count| count.set(0));
        assert!(matches!(
            doc.project_richdoc_with_node_budget(2),
            Err(CollabError::ProjectionTooComplex { .. })
        ));
        PROJECTION_TEXT_BYTES_COPIED.with(|count| assert_eq!(count.get(), 0));
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
    fn markdown_continuations_charge_bytes_without_recharging_run_or_marks() {
        let attrs = Attrs::from([("bold".into(), Any::Bool(true))]);
        let mut runs = Vec::new();
        let mut remaining = 2;
        let mut bytes = MAX_PROJECTION_BYTES - 7;
        PROJECTION_TEXT_BYTES_COPIED.with(|count| count.set(0));
        append_markdown_text(&mut runs, "x", &attrs, false, 0, &mut remaining, &mut bytes).unwrap();
        assert_eq!(remaining, 0);
        append_markdown_text(&mut runs, "é", &attrs, true, 0, &mut remaining, &mut bytes).unwrap();
        assert_eq!(bytes, MAX_PROJECTION_BYTES);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].text, "xé");
        assert_eq!(runs[0].marks.len(), 1);
        assert!(matches!(
            append_markdown_text(&mut runs, "!", &attrs, true, 0, &mut remaining, &mut bytes),
            Err(CollabError::ProjectionTooLarge { .. })
        ));
        assert_eq!(runs[0].text, "xé");
        PROJECTION_TEXT_BYTES_COPIED.with(|count| assert_eq!(count.get(), 3));
    }

    #[test]
    fn oversized_remote_element_attribute_is_refused_at_projection_cap() {
        let encoded_bytes = MAX_PROJECTION_BYTES + 1;
        let raw_bytes = (encoded_bytes / 4) * 3 + 1;
        let doc = remote_doc_with_element_attribute(
            "paragraph",
            "hostile",
            Any::Buffer(Arc::from(vec![0_u8; raw_bytes])),
        );

        assert!(matches!(
            doc.project(ContentKind::Richdoc),
            Err(CollabError::ProjectionTooLarge {
                actual,
                max: MAX_PROJECTION_BYTES
            }) if actual > MAX_PROJECTION_BYTES
        ));
    }

    #[test]
    fn deeply_nested_remote_mark_attribute_is_refused_at_projection_depth_cap() {
        let doc = remote_doc_with_nested_mark_attribute(MAX_PROJECTION_DEPTH - 1);

        assert!(matches!(
            doc.project(ContentKind::Richdoc),
            Err(CollabError::ProjectionTooComplex {
                max_depth: MAX_PROJECTION_DEPTH,
                max_nodes: MAX_PROJECTION_NODES
            })
        ));
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
    fn a_scene_successor_is_byte_stable_and_reproduces_embedded_assets() {
        let key = crate::DocKey::new("ws", "main", "drawing-object").expect("valid key");
        let external = serde_json::to_string(&json!({
            "type": "excalidraw",
            "version": 2,
            "source": "https://excalidraw.com",
            "elements": [{
                "id": "image",
                "type": "image",
                "version": 1,
                "versionNonce": 7,
                "isDeleted": false,
                "index": "a0",
                "fileId": "image-file"
            }],
            "appState": { "viewBackgroundColor": "#ffffff" },
            "files": {
                "image-file": {
                    "id": "image-file",
                    "mimeType": "image/png",
                    "created": 10,
                    "dataURL": "data:image/png;base64,AQID"
                }
            }
        }))
        .expect("external scene");
        let canonical_doc = Ydoc::wire();
        let asset_bytes = crate::scene::seed_portable_scene(&canonical_doc, &key, &external)
            .expect("seed canonical scene");
        let canonical = canonical_doc
            .fold_scene()
            .portable_json_with_asset_bytes(&asset_bytes)
            .expect("canonical portable scene");
        let result_sha = crate::hex_sha256(canonical.as_bytes());
        let identity = SuccessorIdentity::derive(SuccessorIdentityInput {
            key: &key,
            predecessor_claim_id: &"a".repeat(64),
            predecessor_state_vector_sha256: &"b".repeat(64),
            artifact_op_kind: "conflict.resolve",
            artifact_id: "scene-conflict",
            artifact_preimage_sha256: &"c".repeat(64),
            content_kind: ContentKind::Scene,
            result_sha256: &result_sha,
        });

        let first = fresh_successor_base(&identity, &canonical).expect("scene successor");
        let replay = fresh_successor_base(&identity, &canonical).expect("scene replay");
        assert_eq!(first, replay, "one scene identity has one exact base");

        let loaded = Ydoc::wire();
        loaded.apply(&first.update).expect("load scene successor");
        assert_eq!(
            loaded.lineage_epoch_tag().as_deref(),
            Some(first.epoch_tag.as_str())
        );
        assert_eq!(
            loaded
                .fold_scene()
                .portable_json_with_asset_bytes(&asset_bytes)
                .expect("project scene successor"),
            canonical,
        );
    }

    #[test]
    fn a_fresh_successor_is_stable_distinct_and_keeps_its_epoch_immutable() {
        let key = crate::DocKey::new("ws", "main", "object-one").expect("valid key");
        let chosen = "# Chosen\n\nExact body";
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
    fn resolution_fold_reconstructs_an_annotated_table() {
        // The projector writes this for a table whose two body rows were
        // resized and whose second column is right-aligned.
        let chosen = "# Sizes\n\n<!-- dohc:table row-heights=1:84,2:120 -->\n| Metric | Value |\n| ------ | -----: |\n| apples | 10    |\n| pears  | 4     |\n\nAfter.";
        let doc = Ydoc::wire();
        doc.richdoc_append_paragraph("old content");
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, chosen)
            .expect("richdoc rewrite");
        assert_eq!(
            doc.project(ContentKind::Richdoc)
                .expect("projection")
                .content,
            chosen,
            "the folded document projects the chosen bytes back"
        );
        let body = doc.canonical_content()["body"].clone();
        let table = &body["children"][1];
        assert_eq!(table["tag"], "table");
        let rows = table["children"].as_array().expect("table rows");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["children"][0]["tag"], "tableHeader");
        assert_eq!(rows[1]["children"][0]["tag"], "tableCell");
        assert_eq!(rows[1]["attrs"]["height"], 84);
        assert_eq!(rows[2]["attrs"]["height"], 120);
        assert_eq!(rows[2]["children"][1]["attrs"]["align"], "right");
        assert!(
            rows[0]["attrs"].get("height").is_none(),
            "an unannotated row has no height"
        );
    }

    #[test]
    fn resolution_fold_decodes_one_entity_layer_in_table_cells() {
        let doc = remote_doc_with_body([xml_element(
            "table",
            &[],
            [
                xml_element(
                    "tableRow",
                    &[],
                    [xml_element("tableHeader", &[], [paragraph("Text")])],
                ),
                xml_element(
                    "tableRow",
                    &[("height", "84")],
                    [xml_element("tableCell", &[], [paragraph("a & b | c")])],
                ),
                xml_element(
                    "tableRow",
                    &[],
                    [xml_element(
                        "tableCell",
                        &[],
                        [paragraph("<tag> &amp; x<br>y")],
                    )],
                ),
            ],
        )]);
        let chosen = doc
            .project(ContentKind::Richdoc)
            .expect("projection")
            .content;
        assert!(
            chosen.contains("a &amp; b \\| c") && chosen.contains("&lt;tag&gt; &amp;amp; x<br>y"),
            "{chosen}"
        );
        let folded = Ydoc::wire();
        folded
            .rewrite_content_to_markdown(ContentKind::Richdoc, &chosen)
            .expect("richdoc rewrite");
        assert_eq!(
            folded
                .project(ContentKind::Richdoc)
                .expect("projection")
                .content,
            chosen
        );
        let body = serde_json::to_string(&folded.canonical_content()["body"]).expect("body json");
        assert!(
            body.contains("a & b | c") && body.contains("<tag> &amp; x<br>y"),
            "{body}"
        );
    }

    // Raw HTML the live document holds as text settles as inert text. The
    // importer's test of the same document (RAW_HTML_SETTLED in
    // packages/ydoc-projection/src/import-export.test.ts) reads these bytes
    // back as the same document, and the cross-engine fixture
    // richdocProjection-raw-html-literal-text pins them against the
    // TypeScript projector.
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
            "**&lt;pre&gt;one\n  &#32;**\ntwo&lt;/pre&gt; and **real**.",
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
            // A line of spaces whose newline starts the next, unmarked run.
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

    // The fold reads a cell's references as the importer does: inside an
    // encoded tag, where the projector writes them, as their characters, and
    // elsewhere, between two real tags too, as the text they spell.
    #[test]
    fn table_cell_fold_reads_references_only_inside_an_encoded_tag() {
        assert_eq!(
            decode_html_entities_once("&#123; &#92; &amp;#123;"),
            "&#123; &#92; &#123;"
        );
        assert_eq!(
            decode_html_entities_once("<b>x</b> &#123; &#92; <i>y</i>"),
            "<b>x</b> &#123; &#92; <i>y</i>"
        );
        assert_eq!(
            decode_html_entities_once("a<br>&#123;<br>b"),
            "a<br>&#123;<br>b"
        );
        assert_eq!(
            decode_html_entities_once("&#123; &lt;b&gt;&#123;&#92;&#59;&lt;/b&gt; &#92;"),
            "&#123; <b>{\\;</b> &#92;"
        );
    }

    // A table cell's `<br>` is a real tag in the file, which the importer reads
    // as raw HTML, so it bounds no raw HTML span: the cell's literal reference
    // before the `<b>` stays the text it spells. The importer's test of the same
    // cell is "saves a table cell holding a real <br> beside raw HTML as the
    // same document" in packages/ydoc-projection/src/import-export.test.ts.
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

    // A nested block in a table cell is still in the cell, so its real `<br>`
    // bounds no raw HTML span either.
    #[test]
    fn a_nested_block_in_a_table_cell_keeps_the_cell_context() {
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
                    &[],
                    [xml_element(
                        "tableCell",
                        &[],
                        [xml_element(
                            "callout",
                            &[("calloutType", "note"), ("fold", ""), ("title", "")],
                            [paragraph("a<br>b &#124; <b>*x*</b>")],
                        )],
                    )],
                ),
            ],
        )]);
        let projected = doc
            .project(ContentKind::Richdoc)
            .expect("projection")
            .content;
        assert!(
            projected.contains("a<br>b &amp;#124; &lt;b&gt;&#42;x&#42;&lt;/b&gt;"),
            "{projected}"
        );
    }

    // Each punctuation character in a raw HTML span becomes its own reference,
    // and the text between two references is copied alone, not with the run.
    #[test]
    fn dense_raw_html_punctuation_copies_the_run_once() {
        const PAIRS: usize = 4096;
        let text = format!("<b>{}</b>", "x*".repeat(PAIRS));
        let doc = remote_doc_with_body([paragraph(text.as_str())]);
        TEXT_RUN_BYTES_CLONED.with(|count| count.set(0));
        RAW_HTML_REFERENCES_RECORDED.with(|count| count.set(0));
        assert_eq!(
            doc.project_richdoc().unwrap(),
            format!("&lt;b&gt;{}&lt;/b&gt;", "x&#42;".repeat(PAIRS))
        );
        RAW_HTML_REFERENCES_RECORDED.with(|count| assert_eq!(count.get(), PAIRS));
        TEXT_RUN_BYTES_CLONED.with(|count| assert_eq!(count.get(), text.len()));
    }

    // A part's links with no text, and the text between them that holds no
    // newline, `&`, `<`, or `>`, become one literal part when they hold a
    // byte a later pass would rewrite. So a dense link, or a run of links,
    // makes one part and one string, not one for each character or link.
    // The counter counts the parts the projector actually makes.
    #[test]
    fn empty_links_become_one_literal_part() {
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
                3,
                format!("x [](u \"{ampersands}\") &amp;"),
            ),
            (adjacent.clone(), 1, adjacent.clone()),
            (format!("{spaced}x"), 2, format!("{spaced}x")),
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
                2,
                "&lt;b&gt;x&lt;/b&gt; [](u \"&\")".to_owned(),
            ),
        ] {
            let doc = remote_doc_with_body([paragraph(text.as_str())]);
            TEXT_RUN_BYTES_CLONED.with(|count| count.set(0));
            INLINE_PARTS_MATERIALIZED.with(|count| count.set(0));
            assert_eq!(doc.project_richdoc().unwrap(), expected);
            INLINE_PARTS_MATERIALIZED.with(|count| assert_eq!(count.get(), parts, "{text:.40}"));
            TEXT_RUN_BYTES_CLONED.with(|count| assert_eq!(count.get(), text.len()));
        }
    }

    // A link with no text keeps each line its title starts: no block opener,
    // indent, or reference escape reads it. The Markdown after it still
    // reads as Markdown, and a highlight's `=` keeps its escape.
    #[test]
    fn empty_link_lines_are_written_as_they_are() {
        for (text, expected) in [
            ("[](u \"a\n2. b\")", "[](u \"a\n2. b\")"),
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
            assert_eq!(doc.project_richdoc().unwrap(), expected);
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
            assert_eq!(remote.project_richdoc().unwrap(), expected);
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
                "&#91;&#93;&#40;u &#34;{}\n&#35; {}&#34;&#41;",
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
        // A highlighted link whose line starts with `=` keeps its source
        // spelling, `&` too, with each `=` written as `\=`, in one part.
        INLINE_PARTS_MATERIALIZED.with(|count| count.set(0));
        assert_eq!(remote.project_richdoc().unwrap(), "==[](u \"&\\=\n\\=\")==");
        INLINE_PARTS_MATERIALIZED.with(|count| assert_eq!(count.get(), 1));
    }

    // The reader of links with no text examines each byte a bounded number of
    // times, whether its candidates fail or succeed, with no close after them,
    // one, or two.
    #[test]
    fn empty_link_reader_work_is_linear() {
        let steps = |text: &str| {
            EMPTY_LINK_READER_STEPS.with(|count| count.set(0));
            empty_link_ranges(text);
            EMPTY_LINK_READER_STEPS.with(std::cell::Cell::get)
        };
        for unit in [
            "[](",
            "[](<",
            "[](u \"",
            "[](a)",
            "[](u \"t\") ",
            "[](a)b)",
            "[](a b c",
        ] {
            for close in ["", ")", "))"] {
                let small = steps(&format!("{}{close}", unit.repeat(1024)));
                let large = steps(&format!("{}{close}", unit.repeat(2048)));
                assert!(small > 0, "{unit:?}{close:?}");
                assert!(
                    large * 10 < small * 22,
                    "{unit:?}{close:?}: {small} -> {large}"
                );
            }
        }
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

    // A definition's NBSP and `\r` are references like its punctuation, as
    // the importer requires, and other Unicode is written as it is.
    #[test]
    fn definition_whitespace_is_written_as_references() {
        for (text, expected) in [
            (
                "[x]: u \"a\u{a0}b\"",
                "&#91;x&#93;&#58; u &#34;a&#160;b&#34;",
            ),
            ("[x]: u \"a\rb\"", "&#91;x&#93;&#58; u &#34;a&#13;b&#34;"),
            (
                "[x]: https://e.example/日本 \"😀 é\"",
                "&#91;x&#93;&#58; https&#58;//e&#46;example/日本 &#34;😀 é&#34;",
            ),
        ] {
            let doc = remote_doc_with_body([paragraph(text)]);
            assert_eq!(doc.project_richdoc().unwrap(), expected);
        }
    }

    // Text the reader admits can still encode past the output limit. The
    // projector refuses it before it records any of the span's references.
    #[test]
    fn raw_html_punctuation_past_the_output_limit_is_refused_before_recording() {
        let text = format!("<b>{}</b>", "*".repeat(MAX_PROJECTION_BYTES / 4));
        let doc = remote_doc_with_body([paragraph(text.as_str())]);
        RAW_HTML_REFERENCES_RECORDED.with(|count| count.set(0));
        assert!(matches!(
            doc.project_richdoc(),
            Err(CollabError::ProjectionTooLarge {
                actual,
                max: MAX_PROJECTION_BYTES
            }) if actual > MAX_PROJECTION_BYTES
        ));
        RAW_HTML_REFERENCES_RECORDED.with(|count| assert_eq!(count.get(), 0));
    }

    // A link with no text written as references can encode past the output
    // limit across its lines while each line stays under it. The projector
    // refuses it before it writes any line. One that encodes to exactly the
    // limit is written whole.
    #[test]
    fn literal_links_past_the_output_limit_are_refused_before_writing() {
        let lines = |count: usize, length: usize, tail: usize| {
            format!(
                "[](u \"{}# {}\")",
                format!("{}\n", "*".repeat(length)).repeat(count),
                "b".repeat(tail)
            )
        };
        let refused = |text: &str| {
            let doc = remote_doc_with_body([paragraph(text)]);
            LITERAL_LINKS_WRITTEN.with(|count| count.set(0));
            RAW_HTML_REFERENCES_RECORDED.with(|count| count.set(0));
            assert!(matches!(
                doc.project_richdoc(),
                Err(CollabError::ProjectionTooLarge {
                    actual,
                    max: MAX_PROJECTION_BYTES
                }) if actual > MAX_PROJECTION_BYTES
            ));
            LITERAL_LINKS_WRITTEN.with(|count| assert_eq!(count.get(), 0));
            RAW_HTML_REFERENCES_RECORDED.with(|count| assert_eq!(count.get(), 0));
        };
        // Four lines of 2^20 `*`, each about 5 MiB written.
        refused(&lines(4, 1 << 20, 1));
        // Four lines of `length` `*` write 20 bytes for each `*` they hold
        // and 43 bytes besides, and each further `b` writes one byte more.
        let length = (MAX_PROJECTION_BYTES - 43) / 20;
        let tail = 1 + MAX_PROJECTION_BYTES - 43 - 20 * length;
        let doc = remote_doc_with_body([paragraph(lines(4, length, tail).as_str())]);
        LITERAL_LINKS_WRITTEN.with(|count| count.set(0));
        let projected = doc.project_richdoc().unwrap();
        assert_eq!(projected.len(), MAX_PROJECTION_BYTES);
        assert_eq!(
            projected,
            format!(
                "&#91;&#93;&#40;u &#34;{}&#35; {}&#34;&#41;",
                format!("{}\n", "&#42;".repeat(length)).repeat(4),
                "b".repeat(tail)
            )
        );
        // Each line the link keeps.
        LITERAL_LINKS_WRITTEN.with(|count| assert_eq!(count.get(), 5));
        refused(&lines(4, length, tail + 1));
    }

    // The engine's reader resolves the references the projector writes inside
    // raw HTML it wrote as text, as the importer reads them. A literal
    // reference elsewhere, between two raw tags too, still reads as the text
    // it spells, and a reference to a character a reader may not see is still
    // syntax, inside raw HTML too.
    #[test]
    fn the_reader_resolves_projected_references_only_inside_raw_html_text() {
        let read = |text: &str| read_text(text, TextPlace::Inline);
        let resolved = |text: &str, syntax: &[&str]| {
            (
                text.to_owned(),
                syntax
                    .iter()
                    .map(|entry| (*entry).to_owned())
                    .collect::<Vec<_>>(),
            )
        };
        assert_eq!(
            read("&lt;x&gt;&#92;&#123;&#58;&#32;y&lt;/x&gt;"),
            resolved("<x>\\{: y</x>", &[])
        );
        assert_eq!(
            read("&lt;x&gt;&amp;&#35;123&#59;&lt;/x&gt;"),
            resolved("<x>&#123;</x>", &[])
        );
        assert_eq!(
            read("<x>a</x> &#123; <y>b</y>"),
            resolved("<x>a</x> &#123; <y>b</y>", &["at 9: reference #123"])
        );
        assert_eq!(
            read("&lt;!&#45;&#45; a\n&#10;b &#45;&#45;&gt;"),
            resolved("<!-- a\n\nb -->", &[])
        );
        assert_eq!(
            read("&#123; and &lt;x&gt;"),
            resolved("&#123; and <x>", &["at 0: reference #123"])
        );
        assert_eq!(
            read("&#10; and &lt;x&gt;"),
            resolved("&#10; and <x>", &["at 0: reference #10"])
        );
        assert_eq!(
            read("&lt;x&gt;&#8203;&lt;/x&gt;"),
            resolved("<x>&#8203;</x>", &["at 3: reference #8203"])
        );
    }

    // A `<` or `>` a file holds as text opens and closes no encoded tag span,
    // so a reference beside it reads as the text it spells, as the importer
    // reads it (import-export.test.ts, "keeps the spelling of a reference").
    // The fold keeps that text, which projects as the importer's save of it.
    // A renderer decodes the source's reference, so the source still does not
    // read as its projection, while the same text without one does.
    #[test]
    fn a_reference_beside_text_angles_keeps_its_spelling() {
        let read = |text: &str| read_text(text, TextPlace::Block);
        let resolved = |text: &str, syntax: &[&str]| {
            (
                text.to_owned(),
                syntax
                    .iter()
                    .map(|entry| (*entry).to_owned())
                    .collect::<Vec<_>>(),
            )
        };
        for (source, projection, text, at) in [
            (
                "Map<K, &#59; V>",
                "Map&lt;K&#44; &amp;&#35;59&#59; V&gt;",
                "Map<K, &#59; V>",
                7,
            ),
            (
                "a <b, &#59; c> d",
                "a &lt;b&#44; &amp;&#35;59&#59; c&gt; d",
                "a <b, &#59; c> d",
                6,
            ),
            (
                "&lt;b&gt;x&lt;/b&gt; &#59; 3 > 2",
                "&lt;b&gt;x&lt;/b&gt; &amp;&#35;59&#59; 3 &gt; 2",
                "<b>x</b> &#59; 3 > 2",
                9,
            ),
        ] {
            let reference = format!("at {at}: reference #59");
            assert_eq!(read(source), resolved(text, &[reference.as_str()]));
            assert_eq!(read(projection), resolved(text, &[]));
            assert!(!markdown_reads_alike(
                source,
                projection,
                MarkdownReading::Source
            ));
        }

        let folded = Ydoc::wire();
        folded
            .rewrite_content_to_markdown(ContentKind::Richdoc, "Map<K, &#59; V>")
            .expect("richdoc rewrite");
        assert_eq!(
            folded
                .project(ContentKind::Richdoc)
                .expect("projection")
                .content,
            "Map&lt;K&#44; &amp;&#35;59&#59; V&gt;"
        );
        assert!(markdown_reads_alike(
            "Map<K, V>",
            "Map&lt;K&#44; V&gt;",
            MarkdownReading::Source
        ));
    }

    /// marked 17's readings of links with no text and of definitions, which
    /// `markedReadings` in packages/ydoc-projection/src/import-export.test.ts
    /// pins against marked itself.
    #[test]
    fn marked_literal_source_readings() {
        for (source, raw) in [
            (
                "[](https://e.example \"Map<K, &#59; V>\") tail",
                Some("[](https://e.example \"Map<K, &#59; V>\")"),
            ),
            (
                "[](<https://e.example/&#59;>) tail",
                Some("[](<https://e.example/&#59;>)"),
            ),
            ("[](u \"a)b\") tail", Some("[](u \"a)b\")")),
            ("[](a(b)c) tail", Some("[](a(b)c)")),
            ("[](a)b)", Some("[](a)")),
            ("[](a b)", None),
            ("[](<a b> 't')", Some("[](<a b> 't')")),
            ("[](<a) x>)", Some("[](<a) x>)")),
            ("[](  u \n  \"t\"  ) tail", Some("[](  u \n  \"t\"  )")),
            ("[](u (t)) tail", Some("[](u (t))")),
            ("[](u \"a\\\"b\" \"c\")", None),
            ("[](u \"a\\\"b)", None),
            ("[](u \"a\\\" ) \"x\")", Some("[](u \"a\\\" )")),
            ("[]()", Some("[]()")),
            ("[](\\)) tail", Some("[](\\))")),
            ("[](a\\)b)", Some("[](a\\)b)")),
            ("[](<a\\>)", None),
            ("[](<a\\\\>)", Some("[](<a\\\\>)")),
            ("[](u 'a\\'b')", Some("[](u 'a\\'b')")),
            ("[](u\n\"t\"\n)", Some("[](u\n\"t\"\n)")),
            ("[](u \"t\"x)", None),
            ("[](a\u{a0}b)", Some("[](a\u{a0}b)")),
            ("[](\u{a0}u)", Some("[](\u{a0}u)")),
            ("[](\u{a0}a)b)", Some("[](\u{a0}a")),
            ("[](a)b) \"t\")", Some("[](a)")),
            ("[](a(b)", Some("[](a(b)")),
            ("[](<>)", Some("[](<>)")),
            ("[](u (a(b)) x", Some("[](u (a(b))")),
            ("[](u\t\n\t\"t\")", Some("[](u\t\n\t\"t\")")),
            ("[](u\n\n\"t\")", None),
            ("[]((a)", Some("[]((a)")),
            ("[]( (a)b)", Some("[]( (a)b)")),
            ("[](a\\(b\\)c \"x\\\"y\")", Some("[](a\\(b\\)c \"x\\\"y\")")),
            ("[](<a(b)> \"title\")", Some("[](<a(b)> \"title\")")),
            (
                "[](u (title with ( characters))",
                Some("[](u (title with ( characters))"),
            ),
            ("[](u \"a\\\")\\\")", Some("[](u \"a\\\")\\\")")),
        ] {
            assert_eq!(
                EmptyLinks::new(source).read(0).map(|end| &source[..end]),
                raw,
                "{source:?}"
            );
        }
        for (source, raw) in [
            (
                "[a]: <https://e.example/?q=&#59;>",
                Some("[a]: <https://e.example/?q=&#59;>"),
            ),
            (
                "[x]: https://h.example \"kept\"",
                Some("[x]: https://h.example \"kept\""),
            ),
            (
                "[x]:\nhttps://e.example\n\"t\"",
                Some("[x]:\nhttps://e.example\n\"t\""),
            ),
            ("[x]: u\nmore", Some("[x]: u\n")),
            ("[label]: not a definition", None),
            ("[^1]: Footnote body.", None),
            ("[x]: u 'a\nb'", Some("[x]: u 'a\nb'")),
            ("[x]: u (t)", Some("[x]: u (t)")),
            ("   [x]: u", Some("   [x]: u")),
            ("    [x]: u", None),
            ("[ ]: u", None),
            ("[x\\]]: u", Some("[x\\]]: u")),
            ("[x]: <a b> \"t\"", Some("[x]: <a b> \"t\"")),
            (
                "[x]: <https://e.example/a b> \"t\"",
                Some("[x]: <https://e.example/a b> \"t\""),
            ),
            ("[x]: u \"a\\\"b\"", Some("[x]: u \"a\\\"b\"")),
            ("[x]: <a>b>", Some("[x]: <a>b>")),
            ("[x]: u \"t\" x", None),
            ("[x]: u\n\n", Some("[x]: u\n\n")),
            ("[x]:", None),
            ("[x]: u 't'\n\nnext", Some("[x]: u 't'\n\n")),
            ("[x]: u \"t\"   ", Some("[x]: u \"t\"   ")),
            ("[x]: u 'a\n\nb'", None),
            ("[x]:\n  \tu", Some("[x]:\n  \tu")),
            ("[x [y]]: u", None),
            ("[x]: u  \n  \"t\"", Some("[x]: u  \n  \"t\"")),
        ] {
            assert_eq!(
                definition_len(source).map(|len| &source[..len]),
                raw,
                "{source:?}"
            );
        }
    }

    /// The importer keeps a link with no text and a definition as the text
    /// the file holds. The projector writes an empty link as it is, and
    /// starts a definition with `&#91;`, so a destination in angles is
    /// tag-span text. Inside a tag span an empty link reads as the span's
    /// other text does. Any other `[` keeps its `\[` escape. The importer's
    /// tests expect these bytes.
    #[test]
    fn literal_link_source_projects_as_written() {
        assert_eq!(
            leading_markdown_block_escape_index("[](https://h.example)"),
            None
        );
        assert_eq!(
            leading_markdown_block_escape_index("[x]: https://h.example"),
            Some((0, false))
        );
        assert_eq!(
            empty_link_ranges("a [](x) b [](y \"z\") c [](<w>)"),
            vec![(2, 7), (10, 19), (22, 29)]
        );
        for (source, ranges) in [
            ("[](".repeat(4000), 0),
            ("[](<".repeat(4000), 0),
            (format!("{})", "[](".repeat(4000)), 1),
            (format!("{}))", "[](".repeat(4000)), 1),
            (format!("[](u \"{}", "[](u \"".repeat(4000)), 0),
            ("[](a)".repeat(4000), 4000),
            ("[](u \"t\") ".repeat(4000), 4000),
            (format!("[](u {}", "x".repeat(16000)), 0),
            (format!("[](a){}", " x".repeat(8000)), 1),
        ] {
            assert_eq!(empty_link_ranges(&source).len(), ranges);
        }
        for (text, projection) in [
            (
                "[](https://e.example \"Map<K, &#59; V>\")",
                "[](https://e.example \"Map<K, &#59; V>\")",
            ),
            (
                "[](<https://e.example/&#59;>)",
                "[](<https://e.example/&#59;>)",
            ),
            (
                "See [](https://e.example \"a &amp; b &lt;i&gt; &quot;q&quot;\")",
                "See [](https://e.example \"a &amp; b &lt;i&gt; &quot;q&quot;\")",
            ),
            (
                "before\n[](https://h.example \"kept\")",
                "before\n[](https://h.example \"kept\")",
            ),
            (
                "<b> [](https://e.example \"Map<K, &#59; V>\") x</b>",
                "&lt;b&gt; &#91;&#93;&#40;https&#58;//e&#46;example &#34;Map&lt;K&#44; \
                 &amp;&#35;59&#59; V&gt;&#34;&#41; x&lt;/b&gt;",
            ),
            (
                "[a]: <https://e.example/?q=&#59;>",
                "&#91;a&#93;&#58; &lt;https&#58;//e&#46;example/?q&#61;&amp;&#35;59&#59;&gt;",
            ),
            (
                "[x]: <a b> \"t\"",
                "&#91;x&#93;&#58; &lt;a b&gt; &#34;t&#34;",
            ),
            (
                "[x]: <https://e.example/a b> \"t\"",
                "&#91;x&#93;&#58; &lt;https&#58;//e&#46;example/a b&gt; &#34;t&#34;",
            ),
            (
                "[x]: https://h.example \"kept\"",
                "&#91;x&#93;&#58; https&#58;//h&#46;example &#34;kept&#34;",
            ),
            (
                "[x]: https://e.example \"Map<K, &#59; V>\"",
                "&#91;x&#93;&#58; https&#58;//e&#46;example &#34;Map&lt;K&#44; \
                 &amp;&#35;59&#59; V&gt;&#34;",
            ),
            (
                "[x]: u \"[](v '&amp; <b>')\"",
                "&#91;x&#93;&#58; u &#34;&#91;&#93;&#40;v &#39;&amp;amp&#59; \
                 &lt;b&gt;&#39;&#41;&#34;",
            ),
            (
                "[x]:\nhttps://e.example\n\"t\"",
                "&#91;x&#93;&#58;\nhttps&#58;//e&#46;example\n&#34;t&#34;",
            ),
            ("[label]: not a definition", "\\[label]: not a definition"),
            ("[^1]: Footnote body.", "\\[^1]: Footnote body."),
        ] {
            let folded = Ydoc::wire();
            folded
                .rewrite_content_to_markdown(ContentKind::Richdoc, text)
                .expect("richdoc rewrite");
            assert_eq!(
                folded
                    .project(ContentKind::Richdoc)
                    .expect("projection")
                    .content,
                projection
            );
        }
    }

    #[test]
    fn resolution_fold_keeps_other_tables_and_comments_as_text() {
        for chosen in [
            // A plain table reproduces as text, as before.
            "| a | b |\n|---|---|\n| c | d |",
            // An annotation with nothing under it is an ordinary comment.
            "<!-- dohc:table row-heights=1:84 -->\n\nNot a table.",
            // A malformed annotation is an ordinary comment.
            "<!-- dohc:table row-heights=1:84px -->\n| a |\n| --- |\n| b |",
        ] {
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, chosen)
                .expect("richdoc rewrite");
            let body = serde_json::to_string(&doc.canonical_content()["body"]).expect("body json");
            assert!(
                !body.contains("\"table\""),
                "{chosen:?} folded a table: {body}"
            );
        }
    }

    #[test]
    fn resolution_fold_keeps_lists_the_projector_separated() {
        let chosen = "- one\n\n- two\n\n1. first\n\n1. again";
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, chosen)
            .expect("richdoc rewrite");
        assert_eq!(doc.project_richdoc().expect("projection"), chosen);
    }

    #[test]
    fn engine_seeded_rewrites_carry_schema_version_in_the_same_update() {
        let mut fixtures = Vec::new();
        for markdown in ["", "Body", "---\ntitle: Plan\n---\n\nBody"] {
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
    fn engine_seeded_rewrite_preserves_supported_version_and_other_metadata() {
        let doc = Ydoc::wire();
        let meta = doc.doc.get_or_insert_map(ROOT_META);
        {
            let mut txn = doc.doc.transact_mut();
            meta.insert(&mut txn, "schemaVersion", Any::Number(1.0));
            meta.insert(&mut txn, "unrelated", "keep");
        }
        let before = doc.encode_full_state();
        assert_eq!(
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, "")
                .unwrap(),
            [0, 0],
            "a supported version must not be rewritten"
        );
        assert_eq!(doc.encode_full_state(), before);
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, "Body")
            .unwrap();
        assert_eq!(
            meta.get(&doc.doc.transact(), "unrelated"),
            Some(Out::Any(Any::from("keep")))
        );
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

    #[test]
    fn engine_seeded_cleanup_fixture_passes_rust_admission() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/seeded-doc-fixtures/cleanup.json"))
                .unwrap();
        for field in ["seed", "checkpoint", "afterRestart"] {
            let bytes: Vec<u8> = serde_json::from_value(fixture[field].clone()).unwrap();
            let doc = Ydoc::wire();
            doc.apply(&bytes).unwrap();
            doc.validate_public_baseline(&bytes)
                .expect("cleanup checkpoint passes Rust admission");
            let expected = if field == "seed" {
                serde_json::json!({ "id": fixture["sourceId"], "related": fixture["targetId"] })
            } else {
                serde_json::json!({ "id": fixture["sourceId"] })
            };
            assert_eq!(doc.frontmatter_json(), expected);
        }
    }

    #[test]
    fn engine_seeded_fix_keeps_inbound_missing_version_invalid() {
        let incoming = Ydoc::wire();
        let bytes = incoming.richdoc_append_paragraph("Incoming without schema metadata");
        assert!(incoming.validate_public_baseline(&bytes).is_err());
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
                "see [r] <x>.</x>\n>[r]: https://evil.example",
                "<x>Title.\n===\n</x>",
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
            doc.rewrite_content_to_markdown_as(
                ContentKind::Richdoc,
                document,
                if document == "<x>Title.\n===\n</x>" || document.starts_with("Install:") {
                    MarkdownReading::Projection
                } else {
                    MarkdownReading::Source
                },
            )
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

    /// The relay's `renderedReferences` checks the same vectors.
    #[test]
    fn references_read_by_the_rule_the_relay_shares() {
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
            let references: Vec<String> = read_text(&vector.text, TextPlace::Inline)
                .1
                .iter()
                .filter_map(|syntax| {
                    syntax
                        .split_once(": reference ")
                        .map(|(_, name)| name.to_owned())
                })
                .collect();
            assert_eq!(references, vector.references, "{:?}", vector.text);
        }
    }

    #[test]
    fn local_settle_drops_flattened_lists_but_keeps_literal_fence_witness() {
        let file = "- parent\n  - nested\n";
        let doc = main_era_flattened_list_for_test(file);
        let canonical = doc.project_richdoc().unwrap();
        assert_eq!(doc.preserved_markdown_source(&canonical), None);
        assert_eq!(settled(&doc, &canonical, file), None);
        let source = "~~~\ncode\n~~~\n";
        let doc = Ydoc::wire();
        let body = doc.doc.get_or_insert_xml_fragment(ROOT_BODY);
        doc.with_delta(|txn| insert_md_paragraph(txn, &body, 0, source.trim_end()));
        let canonical = witness_source(&doc, source);
        assert_eq!(settled(&doc, &canonical, source).as_deref(), Some(source));
    }

    #[test]
    fn local_settle_escapes_main_era_rule_text() {
        let source = "***";
        let doc = Ydoc::wire();
        let body = doc.doc.get_or_insert_xml_fragment(ROOT_BODY);
        doc.with_delta(|txn| insert_md_paragraph(txn, &body, 0, source));
        let canonical = witness_source(&doc, source);
        assert_eq!(canonical, "\\***");
        assert_eq!(settled(&doc, &canonical, source), None);
    }

    #[test]
    fn a_local_settle_keeps_a_source_whose_body_is_the_files_body() {
        let file = "---\nid: rec\n---\n\nHello <b>hidden</b> world\n";
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, file)
            .expect("richdoc rewrite");
        let canonical = witness_source(&doc, file);
        assert_eq!(doc.preserved_markdown_source(&canonical), None);
        // The file on disk holds that body, so a local settle keeps it, also
        // under other frontmatter.
        for local in [
            file,
            "---\nid: rec\nrelated: old\n---\n\nHello <b>hidden</b> world\n",
        ] {
            assert_eq!(
                settled(&doc, &canonical, local).as_deref(),
                Some(file),
                "{local:?}"
            );
        }
        // Any other body, or no snapshot, is dropped.
        for local in ["---\nid: rec\n---\n\nHello world\n", "Hello\n"] {
            assert_eq!(settled(&doc, &canonical, local), None, "{local:?}");
        }
        assert_eq!(
            doc.settled_markdown_source(&canonical, || Ok::<_, ()>(None)),
            Ok(None)
        );
        // A source that does not rebuild the document is dropped, even when
        // the file holds it.
        let forged = "---\nid: rec\n---\n\nHidden\n";
        witness_source(&doc, forged);
        assert_eq!(settled(&doc, &canonical, forged), None);
    }

    #[test]
    fn a_local_settle_keeps_desktop_reference_links() {
        use yrs::types::Attrs;

        let source = "<details>\n<summary>Extras</summary>\n\nSunscreen and a spare charger.\n</details>\n\nSee [the airline's bag rules][bags].\n\n[bags]: https://example.com/bags\n";
        let doc = Ydoc::wire();
        let body = doc.doc.get_or_insert_xml_fragment(ROOT_BODY);
        doc.with_delta(|txn| {
            insert_md_paragraph(txn, &body, 0, "<details>\n<summary>Extras</summary>");
            insert_md_paragraph(txn, &body, 1, "Sunscreen and a spare charger.");
            insert_md_paragraph(txn, &body, 2, "</details>");
            // The desktop seeds one XmlText with a link mark, then a plain
            // paragraph for the definition (MarkdownDefinition).
            let paragraph = body.push_back(txn, XmlElementPrelim::empty("paragraph"));
            let text = paragraph.push_back(txn, XmlTextPrelim::new("See "));
            text.insert_with_attributes(
                txn,
                4,
                "the airline's bag rules",
                reference_links::link_attributes("https://example.com/bags"),
            );
            let at = text.len(&*txn);
            text.insert_with_attributes(txn, at, ".", Attrs::new());
            insert_md_paragraph(txn, &body, 4, "[bags]: https://example.com/bags");
        });
        let canonical = witness_source(&doc, source);
        assert_eq!(
            canonical,
            "&lt;details&gt;\n&lt;summary&gt;Extras&lt;/summary&gt;\n\n\
             Sunscreen and a spare charger.\n\n&lt;/details&gt;\n\n\
             See [the airline's bag rules](https://example.com/bags).\n\n\
             &#91;bags&#93;&#58; https&#58;//example&#46;com/bags"
        );
        assert_eq!(doc.preserved_markdown_source(&canonical), None);
        assert_eq!(settled(&doc, &canonical, source).as_deref(), Some(source));
        assert_eq!(settled(&doc, &canonical, "A different file body"), None);

        // A witnessed source must rebuild this destination and this label.
        for forged in [
            source.replace("example.com/bags", "other.example/bags"),
            source.replace("the airline's bag rules", "different rules"),
            source.replace("[bags].", "[missing]."),
        ] {
            witness_source(&doc, &forged);
            assert_eq!(settled(&doc, &canonical, &forged), None, "{forged}");
        }
    }

    #[test]
    fn a_local_settle_keeps_undefined_reference_links_as_plain_text() {
        let source = "See [the airline's bag rules][bags].\n";
        // Base-path guard: this source needs no reference-link pass.
        // marked emits plain text when no definition resolves the label.
        let desktop = Ydoc::wire();
        let body = desktop.doc.get_or_insert_xml_fragment(ROOT_BODY);
        desktop.with_delta(|txn| {
            insert_md_paragraph(txn, &body, 0, source.trim_end());
        });
        let canonical = witness_source(&desktop, source);
        let native = Ydoc::wire();
        native
            .rewrite_content_to_markdown_as(ContentKind::Richdoc, source, MarkdownReading::Source)
            .unwrap();
        assert_eq!(native.project_richdoc().unwrap(), canonical);
        assert_eq!(canonical, source.trim_end());
        assert_eq!(
            settled(&desktop, &canonical, source).as_deref(),
            Some(source)
        );
    }

    fn assert_reference_link_pass_refused(source: &str) {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_as(ContentKind::Richdoc, source, MarkdownReading::Source)
            .unwrap();
        let before = doc.encode_full_state();
        assert!(!doc.resolve_reference_links(source), "{source:?}");
        assert_eq!(
            doc.encode_full_state(),
            before,
            "a refused pass must not edit"
        );
    }

    #[test]
    fn reference_link_pass_refuses_formatted_html_split() {
        let source = "Sunscreen and a **spare** charger.\n</details>\n\n[bags]: https://e.com";
        let doc = Ydoc::wire();
        let body = doc.doc.get_or_insert_xml_fragment(ROOT_BODY);
        doc.with_delta(|txn| {
            let paragraph = body.push_back(txn, XmlElementPrelim::empty("paragraph"));
            let text = paragraph.push_back(txn, XmlTextPrelim::new("Sunscreen and a "));
            text.insert_with_attributes(
                txn,
                16,
                "spare",
                yrs::types::Attrs::from([("bold".into(), json_to_any(&json!({})))]),
            );
            text.insert_with_attributes(txn, 21, " charger.\n</details>", yrs::types::Attrs::new());
            insert_md_paragraph(txn, &body, 1, "[bags]: https://e.com");
        });
        assert!(doc
            .body_paragraph_runs()
            .iter()
            .flatten()
            .any(|(_, bold, _)| *bold));
        let before = doc.encode_full_state();
        assert!(!doc.resolve_reference_links(source));
        assert_eq!(doc.encode_full_state(), before);
    }

    #[test]
    fn reference_link_pass_refuses_math_definitions() {
        assert_reference_link_pass_refused(
            "$$\n\n[bags]: https://evil.example\n\n$$\n\nSee [x][bags].",
        );
    }

    #[test]
    fn reference_link_pass_refuses_unexplained_brackets() {
        for unsupported in [
            "# See [r][bags]",
            "- See [r][bags]",
            "| item |\n|---|\n| [r][bags] |",
            "See [bags].",
            "See [bags][].",
            "See [[r]][bags].",
            "See [][bags].",
            "See [r\nr][bags].",
            "See [a][b][bags].",
            "See [r][bags] and [bags].",
            "See *[r][bags]*.",
            "See _[r][bags]_.",
            "See ![r][bags].",
            "See https://x.com/[r][bags].",
            "See WWW.x.com/[r][bags].",
            "See [==r==][bags].",
            "See ==[r][bags]==.",
            "See ++[r][bags]++.",
            "See [++r++][bags].",
            "Mail a@b.co about [r][bags].",
        ] {
            for source in [
                format!("{unsupported}\n\nSee [r][bags].\n\n[bags]: https://e.com"),
                format!("See [r][bags].\n\n{unsupported}\n\n[bags]: https://e.com"),
            ] {
                assert_reference_link_pass_refused(&source);
            }
        }
    }

    #[test]
    fn reference_link_pass_refuses_false_html_interrupts() {
        for tag in ["<br>", "</span>", "<DIV>", "</DETAILS>"] {
            assert!(!paragraph_ending_html(tag));
            let source = format!("word\n{tag}\n\nSee [r][bags].\n\n[bags]: https://e.com");
            // Forge the split the old pass accepted, with a real link mark.
            let doc = Ydoc::wire();
            let body = doc.doc.get_or_insert_xml_fragment(ROOT_BODY);
            doc.with_delta(|txn| {
                insert_md_paragraph(txn, &body, 0, "word");
                insert_md_paragraph(txn, &body, 1, tag);
                let paragraph = body.push_back(txn, XmlElementPrelim::empty("paragraph"));
                let text = paragraph.push_back(txn, XmlTextPrelim::new("See "));
                text.insert_with_attributes(
                    txn,
                    4,
                    "r",
                    reference_links::link_attributes("https://e.com"),
                );
                text.insert_with_attributes(txn, 5, ".", yrs::types::Attrs::new());
                insert_md_paragraph(txn, &body, 3, "[bags]: https://e.com");
            });
            let canonical = witness_source(&doc, &source);
            assert_eq!(settled(&doc, &canonical, &source), None, "{tag}");
        }
    }

    #[test]
    fn reference_link_pass_refuses_padded_labels() {
        for (definition, reference) in [
            ("bags ", "bags"),
            (" bags", "bags"),
            ("bags", "bags "),
            ("bags", " bags"),
            ("bags\t", "bags"),
            ("bags", "\tbags"),
        ] {
            assert_reference_link_pass_refused(&format!(
                "See [x][{reference}].\n\n[{definition}]: https://e.com"
            ));
        }
    }

    fn settled(doc: &Ydoc, canonical: &str, snapshot: &str) -> Option<String> {
        doc.settled_markdown_source(canonical, || Ok::<_, ()>(Some(snapshot.to_owned())))
            .expect("snapshot read")
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
            // Later numbers do not change a list.
            "1. one\n7. two\n",
            "1. a\n3. b\n",
            // A cell's `<br>`, however it is spelled.
            "| a |\n|---|\n| x &lt;br&gt; y |\n",
            // A tag without attributes and another name stays text.
            "a <x> b </x-y>\n",
            // Its content is raw HTML to the importer, which the projector
            // writes with references that read back as the same text.
            "a <x>{{atom:a}} https://e.example/a_b www.e.example a@b.co</x>\n",
            // Two lists, which the projector separates with a blank line,
            // then a table.
            "* a\n\n- b\n\n| x |\n|---|\n| y |\n",
        ] {
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown_as(
                ContentKind::Richdoc,
                source,
                MarkdownReading::Source,
            )
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
    fn a_table_ends_where_marked_starts_another_block() {
        fn blocks(body: &str) -> Vec<MdBlock<'_>> {
            parse_markdown_blocks(body, MarkdownReading::Source)
        }
        let table = |rows: &[&[&str]]| MdBlock::Table {
            rows: rows
                .iter()
                .map(|row| row.iter().map(|cell| cell.to_string()).collect())
                .collect(),
            alignments: vec![None],
            row_heights: BTreeMap::new(),
        };
        assert_eq!(
            blocks("| a |\n|---|\nplain\n# h"),
            [
                table(&[&["a"], &["plain"]]),
                MdBlock::Heading {
                    level: 1,
                    text: "h".into()
                }
            ]
        );
        for next in [
            "> q", "- x", "-\tx", "1. x", "1) x", "***", "```", "    code", "\tcode", "<div> |",
            "</p>", "<!-- c",
        ] {
            assert_eq!(
                blocks(&format!("| a |\n|---|\n{next}"))[0],
                table(&[&["a"]]),
                "{next:?}"
            );
        }
        // marked keeps inline HTML, block HTML it does not match, and other
        // numbers as rows.
        for next in ["<b>x</b>", "<DIV>", " <div>", "2. x", "Vec<T>"] {
            assert_eq!(
                blocks(&format!("| a |\n|---|\n{next}"))[0],
                table(&[&["a"], &[next.trim()]]),
                "{next:?}"
            );
        }
        for header in ["    a | b", "\ta | b", "> a | b", "- a | b", "<b> | c"] {
            assert!(
                !blocks(&format!("{header}\n--- | ---"))
                    .iter()
                    .any(|block| matches!(block, MdBlock::Table { .. })),
                "{header:?}"
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

| a | b |
|---|---|";
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

    #[test]
    fn resolution_fold_parses_the_projectors_nested_frontmatter() {
        // The projector itself emits one-level nested
        // maps (`scalar_line`), and the fold must accept its own output.
        let doc = Ydoc::wire();
        doc.richdoc_append_paragraph("old");
        let chosen = "---\ntitle: Chosen\nmeta:\n  owner: ice\n  team: dohc\n---\n\nbody text";
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, chosen)
            .expect("richdoc rewrite");
        let projected = doc.project(ContentKind::Richdoc).expect("projection");
        assert_eq!(
            projected.content, chosen,
            "the nested frontmatter roundtrips byte-identically"
        );
        let frontmatter =
            serde_json::to_string(&doc.canonical_content()["frontmatter"]).expect("fm json");
        assert!(
            frontmatter.contains("owner") && frontmatter.contains("ice"),
            "the nested map is real metadata, not body text: {frontmatter}"
        );
    }

    #[test]
    fn empty_frontmatter_mappings_settle_and_roundtrip_as_mappings() {
        let chosen = "---\ntop: {}\nnested:\n  child: {}\n---\n\nbody text";
        let canonical = "---\nnested:\n  child: {}\ntop: {}\n---\n\nbody text";
        let expected_frontmatter = json!({
            "top": {},
            "nested": { "child": {} },
        });
        for markdown in [chosen, canonical] {
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, markdown)
                .expect("seed empty frontmatter mappings");

            assert_eq!(doc.frontmatter_json(), expected_frontmatter);
            assert_eq!(
                doc.project(ContentKind::Richdoc)
                    .expect("settle empty frontmatter mappings")
                    .content,
                markdown
            );
        }
    }

    #[test]
    fn floating_point_frontmatter_key_survives_settlement_roundtrip() {
        let chosen = "---\n1.5: value\n---\n\nbody text";
        let canonical = "---\n'1.5': value\n---\n\nbody text";
        for markdown in [chosen, canonical] {
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, markdown)
                .expect("seed floating-point frontmatter key");

            assert_eq!(doc.frontmatter_json(), json!({ "1.5": "value" }));
            assert_eq!(
                doc.project(ContentKind::Richdoc)
                    .expect("settle floating-point frontmatter key")
                    .content,
                markdown
            );
        }
        let edited = Ydoc::wire();
        edited
            .rewrite_content_to_markdown(ContentKind::Richdoc, chosen)
            .expect("seed floating-point frontmatter key");
        edited.frontmatter_set("1.5", "changed").unwrap();
        assert_eq!(
            edited.project(ContentKind::Richdoc).unwrap().content,
            "---\n'1.5': changed\n---\n\nbody text"
        );
    }

    #[test]
    fn fresh_successor_preserves_frontmatter_integers_outside_the_javascript_safe_range() {
        let key = crate::DocKey::new("ws", "main", "large-integer").expect("valid key");
        let artifact = "---\ndebt: -9007199254740993\nestimate: 9007199254740993\n---\n\nbody text";
        let result_sha256 = crate::hex_sha256(artifact.as_bytes());
        let identity = SuccessorIdentity::derive(SuccessorIdentityInput {
            key: &key,
            predecessor_claim_id: &"a".repeat(64),
            predecessor_state_vector_sha256: &"b".repeat(64),
            artifact_op_kind: "conflict.resolve",
            artifact_id: "large-integer-choice",
            artifact_preimage_sha256: &"c".repeat(64),
            content_kind: ContentKind::Richdoc,
            result_sha256: &result_sha256,
        });

        let successor = fresh_successor_base(&identity, artifact)
            .expect("large frontmatter integers remain representable");
        let loaded = Ydoc::wire();
        loaded.apply(&successor.update).expect("load successor");

        assert_eq!(
            loaded
                .project(ContentKind::Richdoc)
                .expect("project successor")
                .content,
            artifact
        );
        assert_eq!(
            loaded.frontmatter_json()["estimate"],
            json!(9_007_199_254_740_993_i64)
        );
        assert_eq!(
            loaded.frontmatter_json()["debt"],
            json!(-9_007_199_254_740_993_i64)
        );
    }

    #[test]
    fn conflict_fold_preserves_selected_tagged_prefix() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../tests/live-bootstrap-fixtures/live-bootstrap.json"
        ))
        .unwrap();
        for row in fixtures.as_array().unwrap().iter().filter(|row| {
            row["name"].as_str().unwrap().starts_with("tagged")
                && row["registrationAccepted"] == true
        }) {
            let doc = Ydoc::wire();
            doc.apply(&serde_json::from_value::<Vec<u8>>(row["bytes"].clone()).unwrap())
                .unwrap();
            let selected = format!("{} edited", row["markdown"].as_str().unwrap());
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, &selected)
                .unwrap();
            assert_eq!(
                doc.project(ContentKind::Richdoc).unwrap().content,
                selected,
                "{}",
                row["name"]
            );
        }
    }

    #[test]
    fn source_preserving_rewrite_replaces_the_previous_frontmatter_source() {
        let doc = Ydoc::wire();
        let selected = "---\npriority: high\n---\n\nRestored body";
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, selected)
            .unwrap();
        let meta = doc.doc.get_or_insert_map(ROOT_META);
        let frontmatter = doc.doc.get_or_insert_map(ROOT_FRONTMATTER);
        {
            let mut txn = doc.doc.transact_mut();
            keep_frontmatter_source(
                &frontmatter,
                &meta,
                &mut txn,
                Some("---\npriority: !custom high\n---\n\n"),
            );
        }
        assert!(doc.project_richdoc().unwrap().contains("!custom"));
        doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, selected)
            .unwrap();
        let projection = doc.project_richdoc().unwrap();
        assert_eq!(projection, selected);
        assert_eq!(
            doc.preserved_markdown_source(&projection).as_deref(),
            Some(selected)
        );
        let txn = doc.doc.transact();
        assert!(!meta.contains_key(&txn, FRONTMATTER_SOURCE_META_KEY));
        assert!(meta
            .keys(&txn)
            .all(|key| !key.starts_with(FRONTMATTER_SOURCE_ITEM_META_PREFIX)));
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

    /// Writes a frontmatter key the way a client with no knowledge of the
    /// kept text does: a plain map write.
    fn write_key_directly(doc: &Ydoc, key: &str, value: Option<&str>) {
        let frontmatter = doc.doc.get_or_insert_map(ROOT_FRONTMATTER);
        let mut txn = doc.doc.transact_mut();
        match value {
            Some(value) => {
                frontmatter.insert(&mut txn, key, value);
            }
            None => {
                frontmatter.remove(&mut txn, key);
            }
        }
    }

    const WIFI: &str = "---\n# Wi-Fi password\nwifi: hunter2\n# Monthly\nbudget: 100\n---\n\nBody";

    /// A key deleted and written again, by any writer and in any number of
    /// updates, no longer holds the item its kept text was written for, so
    /// its old comment never comes back.
    #[test]
    fn a_deleted_key_written_again_never_brings_back_its_comment() {
        let expected = "---\nwifi: new\n# Monthly\nbudget: 100\n---\n\nBody";
        // A plain writer, in two updates and then in one.
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, WIFI)
            .unwrap();
        write_key_directly(&doc, "wifi", None);
        write_key_directly(&doc, "wifi", Some("new"));
        assert_eq!(doc.project_richdoc().unwrap(), expected);
        let together = Ydoc::wire();
        together
            .rewrite_content_to_markdown(ContentKind::Richdoc, WIFI)
            .unwrap();
        let frontmatter = together.doc.get_or_insert_map(ROOT_FRONTMATTER);
        {
            let mut txn = together.doc.transact_mut();
            frontmatter.remove(&mut txn, "wifi");
            frontmatter.insert(&mut txn, "wifi", "new");
        }
        assert_eq!(together.project_richdoc().unwrap(), expected);
        // The engine's own writers.
        let engine = Ydoc::wire();
        engine
            .rewrite_content_to_markdown(ContentKind::Richdoc, WIFI)
            .unwrap();
        write_key_directly(&engine, "wifi", None);
        engine.frontmatter_set("wifi", "new").unwrap();
        assert_eq!(engine.project_richdoc().unwrap(), expected);
    }

    /// The engine's edits keep an edited key's comment; a plain writer's edit
    /// keeps the key's place but not its comment.
    #[test]
    fn an_edited_key_keeps_its_comment_only_through_the_engine_edit() {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, WIFI)
            .unwrap();
        doc.frontmatter_set("budget", "200").unwrap();
        assert_eq!(
            doc.project_richdoc().unwrap(),
            "---\n# Wi-Fi password\nwifi: hunter2\n# Monthly\nbudget: '200'\n---\n\nBody"
        );
        write_key_directly(&doc, "wifi", Some("changed"));
        assert_eq!(
            doc.project_richdoc().unwrap(),
            "---\nwifi: changed\n# Monthly\nbudget: '200'\n---\n\nBody"
        );
    }

    /// Two devices drop different relations offline, and one sets both keys
    /// again. Neither key holds the item the kept text was written for, so
    /// neither comment comes back.
    #[test]
    fn a_key_dropped_on_another_device_returns_without_its_comment() {
        let base = Ydoc::wire();
        base.rewrite_content_to_markdown(
            ContentKind::Richdoc,
            "---\n# owner note\nowner: rec_a\n# editor note\neditor: rec_b\nstatus:   open\n---\n\nBody",
        )
        .unwrap();
        let (a, b) = (Ydoc::wire(), Ydoc::wire());
        a.apply(&base.encode_full_state()).unwrap();
        b.apply(&base.encode_full_state()).unwrap();
        a.frontmatter_drop_relation_target("owner", "rec_a", false)
            .expect("owner dropped");
        b.frontmatter_drop_relation_target("editor", "rec_b", false)
            .expect("editor dropped");
        a.apply(&b.encode_full_state()).unwrap();
        assert_eq!(
            a.project_richdoc().unwrap(),
            "---\nstatus:   open\n---\n\nBody"
        );
        a.frontmatter_set("owner", "rec_c").unwrap();
        a.frontmatter_set("editor", "rec_d").unwrap();
        assert_eq!(
            a.project_richdoc().unwrap(),
            "---\nowner: rec_c\neditor: rec_d\nstatus:   open\n---\n\nBody"
        );
    }

    /// Settling reads each key's item once. Prints the time to settle a
    /// document with 2,000 written frontmatter keys, with and without kept text.
    #[test]
    fn settling_a_large_kept_frontmatter_stays_fast() {
        let keys: String = (0..2_000)
            .map(|index| format!("# note {index}\nkey{index}:   {index}\n"))
            .collect();
        let written = format!("---\n{keys}---\n\nBody");
        let canonical: String = (0..2_000)
            .map(|index| format!("key{index}: {index}\n"))
            .collect();
        for (name, markdown) in [
            ("kept", written),
            ("canonical", format!("---\n{canonical}---\n\nBody")),
        ] {
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, &markdown)
                .unwrap();
            doc.frontmatter_set("key1000", "edited").unwrap();
            let started = std::time::Instant::now();
            let settled = doc.project_richdoc().unwrap();
            println!("settle with {name} frontmatter: {:?}", started.elapsed());
            assert!(settled.contains("key1000: edited"));
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
    fn supplied_frontmatter_candidate_preserves_values_before_mutation() {
        let original = "---\n{score: .nan, title: Plan}\n---\n\nBody";
        for (candidate, accepted) in [
            (
                "---\n{score: .nan, title: Plan, id: \"record\"}\n---\n\nBody",
                true,
            ),
            (
                "---\n{score: '.nan', title: Plan, id: record}\n---\n\nBody",
                false,
            ),
            (
                "---\n{score: .nan, title: Plan, id: different}\n---\n\nBody",
                false,
            ),
        ] {
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, original)
                .unwrap();
            let before = doc.encode_full_state();
            let result = doc.frontmatter_set_preserving_markdown_source("id", "record", candidate);
            if accepted {
                result.unwrap();
                assert_eq!(doc.project_richdoc().unwrap(), candidate);
            } else {
                assert!(matches!(result, Err(CollabError::FrontmatterEditRefused)));
                assert_eq!(doc.encode_full_state(), before);
            }
        }
    }

    #[test]
    fn relation_cleanup_refuses_alias_dependencies_before_mutation() {
        for yaml in [
            "owner: &v rec_a\ncopy: *v",
            "owner: &v [rec_a, rec_b]\ncopy: {nested: *v}",
        ] {
            let doc = Ydoc::wire();
            let markdown = format!("---\n{yaml}\n---\n\nBody");
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, &markdown)
                .unwrap();
            let before = doc.encode_full_state();
            assert!(doc
                .frontmatter_drop_relation_target("owner", "rec_a", yaml.contains('['))
                .is_none());
            assert_eq!(doc.encode_full_state(), before);
            assert_eq!(doc.project_richdoc().unwrap(), markdown);
        }
    }

    #[test]
    fn requested_string_cannot_keep_a_yaml_number_with_the_same_projection() {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(
            ContentKind::Richdoc,
            "---\na: &v .nan\nb: *v\n---\n\nBody",
        )
        .unwrap();
        let before = doc.encode_full_state();
        assert!(matches!(
            doc.frontmatter_set("b", ".nan"),
            Err(CollabError::FrontmatterEditRefused)
        ));
        assert_eq!(doc.encode_full_state(), before);
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
            let markdown = format!("---\n{yaml}\n---\n\nBody");
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
    fn relation_cleanup_keeps_untouched_nested_flow_entries() {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_preserving_source(
            ContentKind::Richdoc,
            "---\nowner: rec_a\neditors: [rec_a, rec_b]\nscore: {value: .nan}\n---\n\nBody",
        )
        .unwrap();
        assert!(!doc.frontmatter_edits_refused());
        doc.frontmatter_drop_relation_target_preserving_markdown_source("owner", "rec_a", false)
            .unwrap()
            .unwrap();
        assert_eq!(
            doc.project_richdoc().unwrap(),
            "---\neditors: [rec_a, rec_b]\nscore: {value: .nan}\n---\n\nBody"
        );
    }

    #[test]
    fn empty_frontmatter_blocks_stay_until_a_key_arrives() {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, "---\n---\n\nBody")
            .unwrap();
        assert_eq!(doc.project_richdoc().unwrap(), "---\n---\n\nBody");
        doc.frontmatter_set("title", "Plan").unwrap();
        assert_eq!(
            doc.project_richdoc().unwrap(),
            "---\ntitle: Plan\n---\n\nBody"
        );

        let removed = Ydoc::wire();
        removed
            .rewrite_content_to_markdown(
                ContentKind::Richdoc,
                "---\nz: 1\ntitle: Plan\n---\n\nBody",
            )
            .unwrap();
        let frontmatter = removed.doc.get_or_insert_map(ROOT_FRONTMATTER);
        {
            let mut txn = removed.doc.transact_mut();
            frontmatter.remove(&mut txn, "z");
            frontmatter.remove(&mut txn, "title");
        }
        assert_eq!(removed.project_richdoc().unwrap(), "Body");
    }

    #[test]
    fn documents_without_frontmatter_or_with_canonical_frontmatter_keep_no_source() {
        for markdown in ["\n\n# Title\n", "---\npadding: xxx\n---\n\n"] {
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, markdown)
                .unwrap();
            let meta = doc.doc.get_or_insert_map(ROOT_META);
            let txn = doc.doc.transact();
            assert!(!meta.contains_key(&txn, FRONTMATTER_SOURCE_META_KEY));
            assert!(!meta
                .keys(&txn)
                .any(|key| key.starts_with(FRONTMATTER_SOURCE_ITEM_META_PREFIX)));
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
                    "---\npriority: high\n---\n\nReal body"
                );
            }
        }
    }

    #[test]
    fn preserved_frontmatter_cannot_replace_zero_with_negative_zero() {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, "---\nvalue: 0\n---\n\nBody")
            .unwrap();
        let meta = doc.doc.get_or_insert_map(ROOT_META);
        {
            let mut txn = doc.doc.transact_mut();
            meta.insert(
                &mut txn,
                FRONTMATTER_SOURCE_META_KEY,
                "---\nvalue: -0.0\n---\n\n",
            );
        }
        assert_eq!(doc.project_richdoc().unwrap(), "---\nvalue: 0\n---\n\nBody");
    }

    fn decode_fixture_int64_markers(value: &mut Value) {
        match value {
            Value::Array(values) => values.iter_mut().for_each(decode_fixture_int64_markers),
            Value::Object(values) => {
                let decoded = if values.len() == 1 {
                    values
                        .get("$dohcInt64")
                        .and_then(Value::as_str)
                        .map(|decimal| decimal.parse::<i64>().expect("fixture int64 is valid"))
                } else {
                    None
                };
                if let Some(integer) = decoded {
                    *value = json!(integer);
                } else {
                    values.values_mut().for_each(decode_fixture_int64_markers);
                }
            }
            _ => {}
        }
    }

    fn frontmatter_fixture_expectation(name: &str) -> Value {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../dohc-engine-domain/tests/fixtures/collection-frontmatter.json"
        ))
        .expect("frontmatter fixture parses");
        let mut expected = fixture["vectors"]
            .as_array()
            .expect("frontmatter vectors")
            .iter()
            .find(|vector| vector["name"] == name)
            .unwrap_or_else(|| panic!("fixture vector {name} exists"))["expected"]
            .clone();
        decode_fixture_int64_markers(&mut expected);
        expected
    }

    /// The yjs shared-type frontmatter branch for the fixture markdown
    /// `sequence: [{constructor: hostile-constructor}, <second item>]`: a
    /// `Y.Array` holding real `Y.Map`s, with the second map carrying one
    /// bigint under the chosen key.
    fn shared_branch_sequence_doc(second_item_key: &str) -> Ydoc {
        let doc = Ydoc::wire();
        let frontmatter = doc.doc.get_or_insert_map(ROOT_FRONTMATTER);
        let mut txn = doc.doc.transact_mut();
        frontmatter.insert(
            &mut txn,
            "sequence",
            yrs::ArrayPrelim::from([
                yrs::In::from(yrs::MapPrelim::from_iter([(
                    "constructor",
                    Any::from("hostile-constructor"),
                )])),
                yrs::In::from(yrs::MapPrelim::from_iter([(
                    second_item_key,
                    Any::BigInt(9_007_199_254_740_993),
                )])),
            ]),
        );
        drop(txn);
        doc
    }

    #[test]
    fn shared_branch_bigint_sentinel_projects_as_the_plain_branch_scalar() {
        let plain = Ydoc::wire();
        let frontmatter = plain.doc.get_or_insert_map(ROOT_FRONTMATTER);
        {
            let mut txn = plain.doc.transact_mut();
            frontmatter.insert(
                &mut txn,
                "sequence",
                Any::from(vec![
                    Any::from(HashMap::from([(
                        "constructor".to_string(),
                        Any::from("hostile-constructor"),
                    )])),
                    Any::BigInt(9_007_199_254_740_993),
                ]),
            );
        }
        let expected = plain
            .project(ContentKind::Richdoc)
            .expect("plain-branch projection")
            .content;

        let shared = shared_branch_sequence_doc(FRONTMATTER_SHARED_BIGINT_KEY);
        let projected = shared
            .project(ContentKind::Richdoc)
            .expect("shared-branch projection")
            .content;

        assert!(
            projected.contains("9007199254740993"),
            "the sentinel decodes to its integer: {projected}"
        );
        assert_eq!(
            projected, expected,
            "both frontmatter branches settle identically"
        );
        assert_eq!(
            dohc_engine_domain::collections::markdown_frontmatter_json(&projected),
            Some(frontmatter_fixture_expectation(
                "constructor-map-and-unsafe-integer-share-array"
            )),
            "the settled artifact parses to the shared vector expectation"
        );
    }

    #[test]
    fn escaped_shared_bigint_key_unescapes_and_projects_as_a_map() {
        let plain = Ydoc::wire();
        let frontmatter = plain.doc.get_or_insert_map(ROOT_FRONTMATTER);
        {
            let mut txn = plain.doc.transact_mut();
            frontmatter.insert(
                &mut txn,
                "sequence",
                Any::from(vec![
                    Any::from(HashMap::from([(
                        "constructor".to_string(),
                        Any::from("hostile-constructor"),
                    )])),
                    Any::from(HashMap::from([(
                        FRONTMATTER_SHARED_BIGINT_KEY.to_string(),
                        Any::BigInt(9_007_199_254_740_993),
                    )])),
                ]),
            );
        }
        let expected = plain
            .project(ContentKind::Richdoc)
            .expect("plain-branch projection")
            .content;

        let shared = shared_branch_sequence_doc("$$dohcBigInt");
        let projected = shared
            .project(ContentKind::Richdoc)
            .expect("shared-branch projection")
            .content;

        assert!(
            projected.contains("$dohcBigInt:"),
            "the escaped key loses exactly one `$`: {projected}"
        );
        assert!(
            !projected.contains("$$dohcBigInt"),
            "no escape depth survives projection: {projected}"
        );
        assert_eq!(
            projected, expected,
            "the literal collision map survives both branches as a map"
        );
        assert_eq!(
            dohc_engine_domain::collections::markdown_frontmatter_json(&projected),
            Some(frontmatter_fixture_expectation(
                "literal-shared-bigint-key-map-survives-the-shared-branch"
            )),
            "the settled artifact parses to the shared vector expectation"
        );
    }

    #[test]
    fn richdoc_rewrite_adopts_crlf_frontmatter_as_typed_fields() {
        let doc = Ydoc::wire();
        let chosen = "---\r\ndone: false\r\npriority: 3\r\nstatus: open\r\n---\r\n\r\nbody text";

        doc.rewrite_content_to_markdown(ContentKind::Richdoc, chosen)
            .expect("richdoc rewrite");

        assert_eq!(doc.frontmatter_json()["status"], json!("open"));
        assert_eq!(doc.frontmatter_json()["priority"], json!(3));
        assert_eq!(doc.frontmatter_json()["done"], json!(false));
        let body =
            serde_json::to_string(&doc.canonical_content()["body"]).expect("canonical body json");
        assert_eq!(body.matches("body text").count(), 1);
        assert!(
            !body.contains("status"),
            "frontmatter must not become body: {body}"
        );
        assert_eq!(
            doc.project(ContentKind::Richdoc)
                .expect("richdoc projection")
                .content,
            chosen,
            "the fold must retain the source's CRLF byte shape"
        );
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
            "---\nid: '99999999999999999999'\ndone: 'true'\nhex: 0x_1F\nscore: '.nan'\nsummary: 'TODO: call Bob'\n---\n\nbody text"
        );
        let reread = Ydoc::wire();
        reread
            .rewrite_content_to_markdown(ContentKind::Richdoc, &projected.content)
            .expect("richdoc rewrite");
        assert_eq!(reread.frontmatter_json(), doc.frontmatter_json());
    }

    #[test]
    fn resolution_fold_bounds_blockquote_depth() {
        // An adversarial run of `> ` prefixes must not recurse without bound
        // inside the resolve frame.
        let adversarial = Ydoc::wire();
        let hostile = format!("{}deep", "> ".repeat(1_000));
        adversarial
            .rewrite_content_to_markdown_as(
                ContentKind::Richdoc,
                &hostile,
                MarkdownReading::Projection,
            )
            .expect("richdoc rewrite");
        let body =
            serde_json::to_string(&adversarial.canonical_content()["body"]).expect("body json");
        let blockquotes = body.matches("\"blockquote\"").count();
        assert_eq!(
            blockquotes, QUOTE_FOLD_MAX_DEPTH,
            "nesting stops at the recursion budget: {blockquotes}"
        );
    }

    #[test]
    fn a_fold_past_the_quote_budget_is_detectably_lossy_not_silently_wrong() {
        // The overflow is not lossless: the leftover `> ` markers become
        // paragraph text, which the projector escapes to `&gt;`. The previous
        // comment asserted losslessness and the fold trusted it, so a
        // resolution past the budget would have been stored as bytes the user
        // never chose. This pins the real behaviour — the divergence is
        // observable — which is what `fold_resolution_into_ydoc_in_tx`
        // re-projects to catch before it commits anything.
        let overflowed = Ydoc::wire();
        let hostile = format!("{}deep", "> ".repeat(QUOTE_FOLD_MAX_DEPTH + 5));
        overflowed
            .rewrite_content_to_markdown_as(
                ContentKind::Richdoc,
                &hostile,
                MarkdownReading::Projection,
            )
            .expect("richdoc rewrite");
        let projected = overflowed
            .project(ContentKind::Richdoc)
            .expect("projection");
        assert_ne!(
            projected.content, hostile,
            "past the budget the fold cannot reproduce the chosen bytes"
        );
        assert!(
            projected.content.contains("&gt;"),
            "and the loss is the projector's escaping"
        );
    }

    #[test]
    fn an_ordered_list_ordinal_at_the_integer_ceiling_does_not_overflow() {
        // A parsed ordinal can be i64::MAX. A resolution body is
        // user-supplied text, so this is reachable from a tiny input, and
        // the parse must neither overflow nor lose the text after the list.
        let doc = Ydoc::wire();
        let chosen = format!("{}. item\n\nafter", i64::MAX);
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, &chosen)
            .expect("richdoc rewrite");
        let projected = doc.project(ContentKind::Richdoc).expect("projection");
        assert!(
            projected.content.contains("item") && projected.content.contains("after"),
            "the list and the text after it both parse: {}",
            projected.content
        );
    }

    #[test]
    fn a_fold_within_the_quote_budget_roundtrips_byte_exactly() {
        for levels in [1_usize, 40, 100, QUOTE_FOLD_MAX_DEPTH] {
            let doc = Ydoc::wire();
            let chosen = format!("{}deep", "> ".repeat(levels));
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, &chosen)
                .expect("richdoc rewrite");
            let projected = doc.project(ContentKind::Richdoc).expect("projection");
            assert_eq!(
                projected.content, chosen,
                "a {levels}-level quote must roundtrip byte-identically"
            );
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
mod fence_projection_tests {
    use super::*;
    /// The fold before fences were found in one pass, reduced to the lines
    /// the test alphabet holds: blanks, paragraphs and fences.
    fn forward_scan_blocks<'src>(lines: &[&'src str]) -> Vec<MdBlock<'src>> {
        let mut blocks = Vec::new();
        let mut index = 0;
        while index < lines.len() {
            let line = lines[index];
            if line.is_empty() {
                index += 1;
                continue;
            }
            if let Some(language) = line.strip_prefix("```") {
                if let Some(offset) = lines[index + 1..].iter().position(|next| *next == "```") {
                    let closer = index + 1 + offset;
                    blocks.push(MdBlock::CodeBlock {
                        language: language.to_owned(),
                        content: lines[index + 1..closer].join("\n"),
                    });
                    index = closer + 1;
                    continue;
                }
            }
            let start = index;
            index += 1;
            while index < lines.len()
                && !lines[index].is_empty()
                && !lines[index].starts_with("```")
            {
                index += 1;
            }
            blocks.push(MdBlock::Paragraph(lines[start..index].join("\n")));
        }
        blocks
    }

    #[test]
    fn fences_close_where_a_forward_scan_closes_them() {
        const ALPHABET: [&str; 4] = ["```", "```x", "a", ""];
        for length in 1..=7_u32 {
            for mut code in 0..ALPHABET.len().pow(length) {
                let mut lines = Vec::new();
                for _ in 0..length {
                    lines.push(ALPHABET[code % ALPHABET.len()]);
                    code /= ALPHABET.len();
                }
                let body = lines.join("\n");
                for reading in [MarkdownReading::Projection, MarkdownReading::Source] {
                    assert_eq!(
                        parse_markdown_blocks(&body, reading),
                        forward_scan_blocks(&lines),
                        "{body:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn unclosed_fences_remain_paragraphs() {
        let openers = 16_000;
        let body = "```x\n".repeat(openers);
        let blocks = parse_markdown_blocks(&body, MarkdownReading::Projection);
        assert_eq!(blocks.len(), openers);
        assert!(blocks
            .iter()
            .all(|block| *block == MdBlock::Paragraph("```x".to_owned())));
    }
}

#[cfg(test)]
#[path = "ydoc/nested1b_allowlist_tests.rs"]
mod nested1b_allowlist_tests;
