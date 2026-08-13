//! The wire-facing yrs `Doc` wrapper and the shared dohc root schema.
//!
//! Every method here enforces the binding yrs constraints the week-one spike
//! proved (`DECISIONS.md`, `SPIKE_REPORT.md`):
//!
//! 1. **`OffsetKind::Utf16` everywhere.** [`Ydoc::wire`] is the only constructor
//!    a durable/replicated doc may use; it hard-codes `OffsetKind::Utf16`. The
//!    default `OffsetKind::Bytes` is wire-unsafe against Yjs (positional
//!    divergence + a struct-store panic on non-ASCII) and is reachable ONLY
//!    through [`Ydoc::with_mode`] with [`OffsetMode::Bytes`], which the
//!    cross-engine `offsetProbe` test uses solely to PIN the divergence.
//! 2. **Nested `Any::Map` key order is nondeterministic through a yrs re-encode.**
//!    [`Ydoc::canonical_content`] sorts every map (including nested frontmatter
//!    objects) via `BTreeMap`, and [`project_frontmatter`] sorts nested keys, so
//!    neither the semantic convergence surface nor the markdown projection
//!    depends on HashMap iteration order.
//! 3. **Well-formed UTF-16 at the boundary.** Rust `String` cannot hold a lone
//!    surrogate, so every string this module produces is well-formed by
//!    construction. Raw [`Ydoc::apply`] remains the permissive yrs primitive;
//!    durable callers additionally use [`crate::validate_replay_parity`] before
//!    journaling so a wire edit cannot split a multi-unit scalar.
//! 4. **Shared declared root schema; projection is destructive on the TS side.**
//!    Roots are read through the declared dohc schema ([`ROOT_FRONTMATTER`],
//!    [`ROOT_META`], [`ROOT_BODY`], [`ROOT_PLAINTEXT`]) — the Yjs v1 wire carries
//!    no root kinds. The projection records provenance including a
//!    `destructive` flag.
//! 5. **yjs `applyUpdate` is not atomic on malformed input; yrs is.** The durable
//!    layer NEVER journals bytes that failed validation: [`Ydoc::apply`] decodes
//!    the whole update before applying (a truncated update is rejected on decode,
//!    state-unchanged), and the caller only persists bytes an apply accepted.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use yrs::types::text::YChange;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{
    Any, Array, Doc, GetString, Map, Options, Out, ReadTxn, StateVector, Text, Transact, Update,
    Xml, XmlElementPrelim, XmlFragment, XmlOut, XmlTextPrelim,
};

use crate::error::CollabError;
use crate::limits::{MAX_PROJECTION_BYTES, MAX_PROJECTION_DEPTH, MAX_PROJECTION_NODES};

/// The declared dohc root schema. The Yjs v1 wire format does not carry
/// root-type kinds — a root's kind is defined by typed API access — so both
/// engines MUST read roots through this identical declaration (spike finding 4).
pub const ROOT_FRONTMATTER: &str = "frontmatter";
/// Secondary map root (engine metadata).
pub const ROOT_META: &str = "meta";
/// Reserved engine metadata that identifies one immutable lineage epoch.
pub const LINEAGE_EPOCH_META_KEY: &str = "dohcLineageEpoch";
/// The rich-document body: a ProseMirror `XmlFragment`.
pub const ROOT_BODY: &str = "body";
/// The plaintext-document body: a single `Y.Text`.
pub const ROOT_PLAINTEXT: &str = "plainText";

/// Which offset mode a `Doc` is built with. `Utf16` is the ONLY wire-safe mode;
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
}

impl ContentKind {
    /// The stable column string.
    pub fn as_str(self) -> &'static str {
        match self {
            ContentKind::Plaintext => "plaintext",
            ContentKind::Richdoc => "richdoc",
        }
    }

    /// Parse the column string (unknown → richdoc, matching the TS driver).
    pub fn parse(raw: &str) -> Self {
        if raw == "plaintext" {
            ContentKind::Plaintext
        } else {
            ContentKind::Richdoc
        }
    }
}

const SUCCESSOR_EPOCH_DOMAIN: &[u8] = b"dohc:ydoc-successor-epoch:v1";
const SUCCESSOR_CLIENT_DOMAIN: &[u8] = b"dohc:ydoc-successor-client:v1";

/// The deterministic identity of one fresh successor lineage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuccessorIdentity {
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

/// Build a fresh Y.Doc from canonical text without merging predecessor items.
pub fn fresh_successor_base(
    identity: &SuccessorIdentity,
    markdown: &str,
) -> Result<SuccessorBase, CollabError> {
    let observed_result = crate::hex_sha256(markdown.as_bytes());
    if observed_result != identity.result_sha256 {
        return Err(CollabError::SuccessorResultMismatch {
            expected: identity.result_sha256.clone(),
            observed: observed_result,
        });
    }
    let doc = Ydoc {
        doc: Doc::with_options(Options {
            client_id: yrs::ClientID::new(identity.client_id),
            offset_kind: yrs::OffsetKind::Utf16,
            ..Options::default()
        }),
    };
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
    doc.rewrite_content_to_markdown(identity.content_kind, markdown);
    let projected = doc.project(identity.content_kind)?.markdown;
    if projected != markdown {
        return Err(CollabError::SuccessorProjectionMismatch {
            expected_sha256: crate::hex_sha256(markdown.as_bytes()),
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

/// A markdown projection of a durable Y.Doc with its provenance. Constraint 4:
/// the TS `yDocToMarkdown` is destructive (y-prosemirror drops PM-invalid
/// elements), so provenance must record what state produced the markdown and
/// whether the projection mutated the source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Projection {
    /// The projected markdown (UTF-8; well-formed by Rust's `String` invariant).
    pub markdown: String,
    /// The content kind that drove the projection.
    pub content_kind: ContentKind,
    /// Lowercase-hex sha-256 of the doc's state vector at projection time — the
    /// durable provenance link from a settled markdown blob back to the exact
    /// CRDT state it came from.
    pub source_state_vector_sha256: String,
    /// Whether producing this projection mutated the live doc. The Rust
    /// projection is read-only (`false`); the TS `yDocToMarkdown` can mutate
    /// (drops PM-invalid elements), which R11b's live adapter journals as an
    /// ordinary update. Recorded so a cross-engine settle can reconcile.
    pub destructive: bool,
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
        Ydoc {
            doc: Doc::with_options(Options {
                offset_kind: yrs::OffsetKind::Utf16,
                ..Options::default()
            }),
        }
    }

    /// Construct a doc in the requested offset mode. `Bytes` is wire-unsafe and
    /// exists ONLY for the pinned divergence probe (a `Bytes` doc fed the same
    /// non-ASCII lineage diverges from / panics against a `Utf16` doc).
    pub fn with_mode(mode: OffsetMode) -> Self {
        let offset_kind = match mode {
            OffsetMode::Utf16 => yrs::OffsetKind::Utf16,
            OffsetMode::Bytes => yrs::OffsetKind::Bytes,
        };
        Ydoc {
            doc: Doc::with_options(Options {
                offset_kind,
                ..Options::default()
            }),
        }
    }

    /// Validate an update WITHOUT mutating any doc: decode the whole v1 update.
    /// A truncated/malformed update fails here (yrs decodes the full update
    /// before applying — constraint 5), so the durable layer can refuse to
    /// journal bytes that would fail an apply.
    ///
    /// Pre-validates the raw wire bytes FIRST via
    /// [`crate::replay_parity::prevalidate_update_bytes`], before the real
    /// `Update::decode_v1` below: yrs 0.27.3's `decode_v1` can HARD-ABORT the
    /// whole process on adversarial bytes (uncatchable UB —
    /// `std::panic::catch_unwind` cannot intercept it; see
    /// `replay_parity::safe_read_string`'s doc comment for the root cause).
    /// This method, [`Ydoc::apply`] below, and [`merge_updates`] are the
    /// crate's `Update::decode_v1` call sites, and each pre-validates first, so
    /// guarding here — not merely at the durable layer's `validate_update_bytes`
    /// choke point — is what makes EVERY caller of the raw primitive (durable,
    /// replication, tests, and any future caller) intrinsically safe, not just
    /// the ones that remember to pre-validate first.
    pub fn validate_update(bytes: &[u8]) -> Result<(), CollabError> {
        crate::replay_parity::prevalidate_update_bytes(bytes)?;
        Update::decode_v1(bytes).map_err(|e| CollabError::MalformedUpdate {
            reason: e.to_string(),
        })?;
        Ok(())
    }

    /// Apply a Yjs v1 update. Decodes the WHOLE update first (constraint 5): a
    /// truncated update is rejected on decode with the doc state-unchanged, and
    /// no bytes that fail here are ever journaled by the caller.
    ///
    /// Pre-validates the raw wire bytes FIRST — see [`Ydoc::validate_update`]'s
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

    pub(crate) fn has_missing_updates(&self) -> bool {
        self.doc.transact().has_missing_updates()
    }

    /// Whether the doc holds updates it could not integrate yet (a
    /// cross-origin missing dependency durably parked in the log). A
    /// projection taken in this state omits pending remote content.
    pub fn has_pending_dependencies(&self) -> bool {
        self.pending_update_v1().is_some()
    }

    pub(crate) fn pending_update_v1(&self) -> Option<Vec<u8>> {
        let txn = self.doc.transact();
        txn.store()
            .pending_update()
            .map(|pending| pending.update.encode_v1())
    }

    pub(crate) fn state_vector(&self) -> StateVector {
        self.doc.transact().state_vector()
    }

    /// The full state re-encoded as a single v1 update — the snapshot primitive.
    pub fn encode_full_state(&self) -> Vec<u8> {
        let txn = self.doc.transact();
        txn.encode_state_as_update_v1(&StateVector::default())
    }

    /// The state vector, v1-encoded — the provenance/diff primitive.
    pub fn encode_state_vector(&self) -> Vec<u8> {
        let txn = self.doc.transact();
        txn.state_vector().encode_v1()
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

    /// Project to markdown with provenance (constraint 4). Plaintext projects the
    /// exact `Y.Text`; richdoc projects sorted frontmatter + paragraph text.
    pub fn project(&self, content_kind: ContentKind) -> Result<Projection, CollabError> {
        let markdown = match content_kind {
            ContentKind::Plaintext => self.project_plaintext(),
            ContentKind::Richdoc => self.project_richdoc(),
        }?;
        Ok(Projection {
            markdown,
            content_kind,
            source_state_vector_sha256: crate::hex_sha256(&self.encode_state_vector()),
            destructive: false,
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
        let mut out = ProjectionBuffer::new();
        // Acquire BOTH roots before opening the read txn: yrs `get_or_insert_*`
        // takes the store lock, so calling one while a transaction is live
        // deadlocks (spike harness note).
        let frontmatter = self.doc.get_or_insert_map(ROOT_FRONTMATTER);
        let body = self.doc.get_or_insert_xml_fragment(ROOT_BODY);
        let txn = self.doc.transact();
        let mut has_frontmatter = false;
        let mut remaining_nodes = projection_node_budget;
        let mut source_text_bytes = 0usize;
        if frontmatter.len(&txn) > 0 {
            has_frontmatter = true;
            let mut entries: BTreeMap<String, Value> = BTreeMap::new();
            for (k, v) in frontmatter.iter(&txn) {
                source_text_bytes = checked_projection_len(source_text_bytes, k.len())?;
                entries.insert(
                    k.to_string(),
                    projection_out_json(&txn, v, 0, &mut remaining_nodes, &mut source_text_bytes)?,
                );
            }
            out.push_str("---\n")?;
            for (k, v) in &entries {
                out.push_str(&project_frontmatter(k, v)?)?;
            }
            out.push_str("---")?;
        }
        let children: Vec<MarkdownNode> = body
            .children(&txn)
            .map(|child| {
                markdown_node(&txn, child, 0, &mut remaining_nodes, &mut source_text_bytes)
            })
            .collect::<ProjectionResult<_>>()?;
        let body_markdown = markdown_document(&children)?;
        if has_frontmatter {
            out.push_str(if body_markdown.starts_with('\n') {
                "\n"
            } else {
                "\n\n"
            })?;
        }
        out.push_str(&body_markdown)?;
        Ok(out.into_string())
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
    /// [`ROOT_PLAINTEXT`] text (NOT snapped to a code-point boundary — used to
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
    /// chosen markdown SOURCE into the projection's own block schema —
    /// frontmatter scalars, headings, blockquotes, bullet/ordered/task
    /// lists, fenced code blocks, horizontal rules, and paragraphs — so the
    /// folded document projects the chosen bytes back AND renders as structure,
    /// not literal syntax. The production caller reprojects this rewrite and
    /// refuses the resolution when the parser cannot reproduce the chosen bytes.
    pub fn rewrite_content_to_markdown(
        &self,
        content_kind: ContentKind,
        markdown: &str,
    ) -> Vec<u8> {
        match content_kind {
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
                let frag = self.doc.get_or_insert_xml_fragment(ROOT_BODY);
                let map = self.doc.get_or_insert_map(ROOT_FRONTMATTER);
                let (frontmatter, body) = split_markdown_frontmatter(markdown);
                let blocks = parse_markdown_blocks(body);
                self.with_delta(|txn| {
                    let keys: Vec<String> = map.iter(txn).map(|(key, _)| key.to_string()).collect();
                    for key in keys {
                        map.remove(txn, &key);
                    }
                    for (key, value) in &frontmatter {
                        match value {
                            MdFrontmatter::Scalar(value) => {
                                map.insert(txn, key.as_str(), value.as_str());
                            }
                            MdFrontmatter::Map(children) => {
                                let nested: std::collections::HashMap<String, Any> = children
                                    .iter()
                                    .map(|(k, v)| (k.clone(), Any::from(v.as_str())))
                                    .collect();
                                map.insert(txn, key.as_str(), Any::from(nested));
                            }
                        }
                    }
                    let len = frag.len(txn);
                    if len > 0 {
                        frag.remove_range(txn, 0, len);
                    }
                    for (index, block) in blocks.iter().enumerate() {
                        insert_md_block(txn, &frag, index as u32, block);
                    }
                })
            }
        }
    }

    /// Set a top-level [`ROOT_FRONTMATTER`] scalar and return the encoded delta.
    pub fn frontmatter_set(&self, key: &str, value: &str) -> Vec<u8> {
        let map = self.doc.get_or_insert_map(ROOT_FRONTMATTER);
        self.with_delta(|txn| {
            map.insert(txn, key, value);
        })
    }

    /// Set a top-level [`ROOT_FRONTMATTER`] nested map and return the encoded
    /// delta. Used to exercise constraint 2 (nested key-order nondeterminism).
    pub fn frontmatter_set_nested(&self, key: &str, entries: &[(&str, &str)]) -> Vec<u8> {
        let map = self.doc.get_or_insert_map(ROOT_FRONTMATTER);
        let nested: std::collections::HashMap<String, Any> = entries
            .iter()
            .map(|(k, v)| ((*k).to_string(), Any::from(*v)))
            .collect();
        self.with_delta(|txn| {
            map.insert(txn, key, Any::from(nested.clone()));
        })
    }

    fn with_delta(&self, edit: impl FnOnce(&mut yrs::TransactionMut)) -> Vec<u8> {
        let before = self.doc.transact().state_vector();
        {
            let mut txn = self.doc.transact_mut();
            edit(&mut txn);
        }
        self.doc.transact().encode_state_as_update_v1(&before)
    }
}

/// One block of the conflict-resolution fold's markdown parse — the subset
/// of the projection schema the fold reconstructs. Anything else stays a
/// [`MdBlock::Paragraph`]; the production fold re-projects that result and
/// refuses the resolution if it cannot reproduce the chosen bytes exactly.
#[derive(Debug, Clone, PartialEq, Eq)]
enum MdBlock {
    Heading { level: i64, text: String },
    Paragraph(String),
    Quote(Vec<MdBlock>),
    BulletList(Vec<String>),
    OrderedList { start: i64, items: Vec<String> },
    TaskList(Vec<(bool, String)>),
    CodeBlock { language: String, content: String },
    Rule,
}

/// Split a leading `---` frontmatter block of flat `key: value` scalars off
/// the chosen markdown. Only the exact shape the projector emits is claimed;
/// anything else stays in the body and parses as blocks.
/// A parsed frontmatter entry: the scalar and one-level-map shapes the
/// projector itself emits (`scalar_line`). Anything else bails to the body
/// parser rather than guessing at YAML.
enum MdFrontmatter {
    Scalar(String),
    Map(Vec<(String, String)>),
}

fn split_markdown_frontmatter(markdown: &str) -> (Vec<(String, MdFrontmatter)>, &str) {
    let Some(rest) = markdown.strip_prefix("---\n") else {
        return (Vec::new(), markdown);
    };
    let Some(end) = rest.find("\n---") else {
        return (Vec::new(), markdown);
    };
    let after = &rest[end + "\n---".len()..];
    let body = after
        .strip_prefix("\n\n")
        .or_else(|| after.strip_prefix('\n'))
        .unwrap_or(after);
    if !after.is_empty() && !after.starts_with('\n') {
        return (Vec::new(), markdown);
    }
    let lines: Vec<&str> = rest[..end].lines().collect();
    let mut entries: Vec<(String, MdFrontmatter)> = Vec::new();
    let mut index = 0usize;
    while index < lines.len() {
        let line = lines[index];
        if line.starts_with(' ') || line.trim().is_empty() {
            return (Vec::new(), markdown);
        }
        if let Some((key, value)) = line.split_once(": ") {
            if key.trim().is_empty() {
                return (Vec::new(), markdown);
            }
            entries.push((key.to_string(), MdFrontmatter::Scalar(value.to_string())));
            index += 1;
            continue;
        }
        // `key:` alone opens the projector's one-level nested map: two-space
        // indented `child: value` scalars, sorted on projection.
        let Some(key) = line.strip_suffix(':') else {
            return (Vec::new(), markdown);
        };
        if key.trim().is_empty() || key.contains(':') {
            return (Vec::new(), markdown);
        }
        index += 1;
        let mut children = Vec::new();
        while index < lines.len() {
            let Some(child) = lines[index].strip_prefix("  ") else {
                break;
            };
            // Deeper nesting than the projector emits: bail to the body
            // parser rather than mangling metadata.
            if child.starts_with(' ') {
                return (Vec::new(), markdown);
            }
            let Some((child_key, child_value)) = child.split_once(": ") else {
                return (Vec::new(), markdown);
            };
            if child_key.trim().is_empty() {
                return (Vec::new(), markdown);
            }
            children.push((child_key.to_string(), child_value.to_string()));
            index += 1;
        }
        entries.push((key.to_string(), MdFrontmatter::Map(children)));
    }
    (entries, body)
}

fn parse_markdown_blocks(body: &str) -> Vec<MdBlock> {
    parse_markdown_blocks_at(body, 0)
}

/// How many nested blockquote levels the fold will build before it stops
/// recursing and keeps the remaining quoted lines as verbatim paragraph text.
///
/// This is a RECURSION BUDGET against hostile input, not a fidelity ceiling —
/// the earlier comment here claimed the latter and was wrong on both counts.
/// `markdown_node` increments projection depth by one per level, not two, and
/// the projector renders far deeper than 60: measured in-tree, a fold
/// round-trips byte-exactly at 40, 100 and 120 levels.
///
/// The overflow is also NOT lossless, which the old comment asserted and the
/// fold relied on: a paragraph holding `> > …` re-projects with its leading
/// markers escaped as `&gt;`. That is why the caller
/// (`fold_resolution_into_ydoc_in_tx`) re-projects and compares before it
/// commits anything — past this bound a resolution is REFUSED, never silently
/// stored as bytes the user did not choose.
///
/// 120 sits under the projector's own `MAX_PROJECTION_DEPTH`, so a document
/// the projection can render is one the fold can rebuild, and the refusal
/// above it costs no representable content. Real prose nests single digits
/// deep; the budget exists so a megabyte of `> ` prefixes inside one resolve
/// frame cannot exhaust the parser stack or the actor thread.
const QUOTE_FOLD_MAX_DEPTH: usize = 120;

/// `depth` bounds blockquote recursion at [`QUOTE_FOLD_MAX_DEPTH`].
fn parse_markdown_blocks_at(body: &str, depth: usize) -> Vec<MdBlock> {
    let lines: Vec<&str> = body.split('\n').collect();
    let mut blocks = Vec::new();
    let mut index = 0usize;
    while index < lines.len() {
        let line = lines[index];
        if line.is_empty() {
            index += 1;
            continue;
        }
        if let Some(fence_language) = line.strip_prefix("```") {
            let mut content = Vec::new();
            let mut cursor = index + 1;
            let mut closed = false;
            while cursor < lines.len() {
                if lines[cursor] == "```" {
                    closed = true;
                    break;
                }
                content.push(lines[cursor]);
                cursor += 1;
            }
            if closed {
                blocks.push(MdBlock::CodeBlock {
                    language: fence_language.to_string(),
                    content: content.join("\n"),
                });
                index = cursor + 1;
                continue;
            }
            // An unclosed fence is not a code block: fall through to text.
        }
        if line == "---" {
            blocks.push(MdBlock::Rule);
            index += 1;
            continue;
        }
        if let Some((level, text)) = parse_heading(line) {
            blocks.push(MdBlock::Heading { level, text });
            index += 1;
            continue;
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
            if depth >= QUOTE_FOLD_MAX_DEPTH {
                blocks.push(MdBlock::Paragraph(lines[start..index].join("\n")));
            } else {
                blocks.push(MdBlock::Quote(parse_markdown_blocks_at(
                    &inner.join("\n"),
                    depth + 1,
                )));
            }
            continue;
        }
        if parse_task_item(line).is_some() {
            let mut items = Vec::new();
            while let Some(item) = lines.get(index).and_then(|line| parse_task_item(line)) {
                items.push(item);
                index += 1;
            }
            blocks.push(MdBlock::TaskList(items));
            continue;
        }
        if let Some(item) = line.strip_prefix("- ") {
            let mut items = vec![item.to_string()];
            index += 1;
            while let Some(next) = lines.get(index).and_then(|line| {
                (parse_task_item(line).is_none())
                    .then(|| line.strip_prefix("- "))
                    .flatten()
            }) {
                items.push(next.to_string());
                index += 1;
            }
            blocks.push(MdBlock::BulletList(items));
            continue;
        }
        if let Some((start, item)) = parse_ordered_item(line) {
            let mut items = vec![item];
            // A parsed ordinal can be i64::MAX, and the successor it implies
            // cannot be represented: unchecked `+ 1` panics the workspace
            // actor in debug and test builds and wraps in release, where the
            // wrapped value then mis-parses every following line. The list
            // simply ends when no successor exists.
            let mut expected = start.checked_add(1);
            index += 1;
            while let Some(next_expected) = expected {
                let Some((ordinal, next)) =
                    lines.get(index).and_then(|line| parse_ordered_item(line))
                else {
                    break;
                };
                if ordinal != next_expected {
                    break;
                }
                items.push(next);
                expected = next_expected.checked_add(1);
                index += 1;
            }
            blocks.push(MdBlock::OrderedList { start, items });
            continue;
        }
        // Paragraph: consecutive lines until a blank line or a structural
        // line. Interior single newlines stay inside one text run, which the
        // projector re-emits verbatim.
        let mut para = vec![line];
        index += 1;
        while index < lines.len() {
            let next = lines[index];
            if next.is_empty()
                || next == "---"
                || next.starts_with("```")
                || next == ">"
                || next.starts_with("> ")
                || next.starts_with("- ")
                || parse_heading(next).is_some()
                || parse_ordered_item(next).is_some()
            {
                break;
            }
            para.push(next);
            index += 1;
        }
        blocks.push(MdBlock::Paragraph(para.join("\n")));
    }
    blocks
}

fn parse_heading(line: &str) -> Option<(i64, String)> {
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

fn parse_task_item(line: &str) -> Option<(bool, String)> {
    line.strip_prefix("- [x] ")
        .map(|text| (true, text.to_string()))
        .or_else(|| {
            line.strip_prefix("- [ ] ")
                .map(|text| (false, text.to_string()))
        })
}

fn parse_ordered_item(line: &str) -> Option<(i64, String)> {
    let (ordinal, rest) = line.split_once(". ")?;
    let ordinal = ordinal.parse::<i64>().ok()?;
    if ordinal < 0 || rest.is_empty() {
        return None;
    }
    Some((ordinal, rest.to_string()))
}

fn insert_md_paragraph<F: XmlFragment>(
    txn: &mut yrs::TransactionMut<'_>,
    parent: &F,
    index: u32,
    text: &str,
) {
    let el = parent.insert(txn, index, XmlElementPrelim::empty("paragraph"));
    if !text.is_empty() {
        el.insert(txn, 0, XmlTextPrelim::new(text));
    }
}

fn insert_md_block<F: XmlFragment>(
    txn: &mut yrs::TransactionMut<'_>,
    parent: &F,
    index: u32,
    block: &MdBlock,
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
            for (child_index, child) in children.iter().enumerate() {
                insert_md_block(txn, &el, child_index as u32, child);
            }
        }
        MdBlock::BulletList(items) => {
            let el = parent.insert(txn, index, XmlElementPrelim::empty("bulletList"));
            for (item_index, item) in items.iter().enumerate() {
                let li = el.insert(txn, item_index as u32, XmlElementPrelim::empty("listItem"));
                insert_md_paragraph(txn, &li, 0, item);
            }
        }
        MdBlock::OrderedList { start, items } => {
            let el = parent.insert(txn, index, XmlElementPrelim::empty("orderedList"));
            if *start != 1 {
                el.insert_attribute(txn, "start", *start);
            }
            for (item_index, item) in items.iter().enumerate() {
                let li = el.insert(txn, item_index as u32, XmlElementPrelim::empty("listItem"));
                insert_md_paragraph(txn, &li, 0, item);
            }
        }
        MdBlock::TaskList(items) => {
            let el = parent.insert(txn, index, XmlElementPrelim::empty("taskList"));
            for (item_index, (checked, item)) in items.iter().enumerate() {
                let li = el.insert(txn, item_index as u32, XmlElementPrelim::empty("taskItem"));
                li.insert_attribute(txn, "checked", *checked);
                insert_md_paragraph(txn, &li, 0, item);
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
    let map_roots = [ROOT_FRONTMATTER, ROOT_META];
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
    // Surface any replicated root the schema did NOT declare so a mismatch in
    // root enumeration cannot pass silently.
    let txn = doc.transact();
    let declared = [ROOT_FRONTMATTER, ROOT_META, ROOT_BODY, ROOT_PLAINTEXT];
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
            "delta": projection_diffs_json(
                txn,
                materialize_projection_diffs(&text, txn, *remaining_nodes)?,
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

fn materialize_projection_diffs<T, R>(
    text: &R,
    txn: &T,
    remaining_nodes: usize,
) -> ProjectionResult<Vec<yrs::types::text::Diff<YChange>>>
where
    T: ReadTxn,
    R: Text,
{
    // `Text::diff` has no public incremental alternative in yrs 0.27.3: it
    // always finishes a complete Vec<Diff>. Every emitted run contains at
    // least one visible text unit or embed, so visible length is a conservative
    // upper bound on run count. Refuse before calling `diff` when that bound
    // cannot fit the remaining projection budget.
    if text.len(txn) as usize > remaining_nodes {
        return Err(CollabError::ProjectionTooComplex {
            max_depth: MAX_PROJECTION_DEPTH,
            max_nodes: MAX_PROJECTION_NODES,
        });
    }
    #[cfg(test)]
    PROJECTION_DIFF_MATERIALIZATIONS.with(|count| count.set(count.get() + 1));
    Ok(text.diff(txn, YChange::identity))
}

#[cfg(test)]
thread_local! {
    static PROJECTION_DIFF_MATERIALIZATIONS: std::cell::Cell<usize> =
        const { std::cell::Cell::new(0) };
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
            "delta": projection_diffs_json(
                txn,
                materialize_projection_diffs(&text, txn, *remaining_nodes)?,
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

fn projection_diffs_json<T: ReadTxn, D>(
    _txn: &T,
    diffs: Vec<yrs::types::text::Diff<D>>,
    depth: usize,
    remaining_nodes: &mut usize,
    source_bytes: &mut usize,
) -> ProjectionResult<Value> {
    let mut items = Vec::new();
    for diff in diffs {
        consume_projection_value_node(depth, remaining_nodes)?;
        let insert = match diff.insert {
            Out::Any(any) => {
                projection_any_to_json(&any, depth + 1, remaining_nodes, source_bytes)?
            }
            other => {
                consume_projection_value_node(depth + 1, remaining_nodes)?;
                json!(ensure_projection_string(format!("{other:?}"))?)
            }
        };
        let attrs = if let Some(attrs) = diff.attributes {
            let mut sorted = BTreeMap::new();
            for (key, value) in attrs.iter() {
                *source_bytes = checked_projection_len(*source_bytes, key.len())?;
                sorted.insert(
                    key.to_string(),
                    projection_any_to_json(value, depth + 1, remaining_nodes, source_bytes)?,
                );
            }
            Some(Value::Object(sorted.into_iter().collect()))
        } else {
            None
        };
        items.push(match attrs {
            Some(attrs) => json!({ "insert": insert, "attrs": attrs }),
            None => json!({ "insert": insert }),
        });
    }
    Ok(Value::Array(items))
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

fn project_frontmatter(key: &str, value: &Value) -> ProjectionResult<String> {
    match value {
        Value::Object(map) if map.get("type") == Some(&json!("any")) => {
            scalar_line(key, map.get("value").unwrap_or(&Value::Null))
        }
        other => scalar_line(key, other),
    }
}

fn scalar_line(key: &str, value: &Value) -> ProjectionResult<String> {
    let mut output = ProjectionBuffer::new();
    match value {
        Value::String(value) => {
            output.push_str(key)?;
            output.push_str(": ")?;
            output.push_str(value)?;
            output.push('\n')?;
        }
        Value::Object(map) => {
            // Nested map: emit sorted `key:` block (constraint 2 — keys already
            // sorted by `any_to_json`'s BTreeMap).
            output.push_str(key)?;
            output.push_str(":\n")?;
            for (k, v) in map {
                let child = scalar_line(k, v)?;
                output.push_str("  ")?;
                output.push_str(child.trim_end())?;
                output.push('\n')?;
            }
        }
        Value::Null => {
            output.push_str(key)?;
            output.push_str(": null\n")?;
        }
        other => {
            output.push_str(key)?;
            output.push_str(": ")?;
            let value = ensure_projection_string(serde_json::to_string(other).unwrap_or_default())?;
            output.push_str(&value)?;
            output.push('\n')?;
        }
    }
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

#[derive(Debug, Clone)]
struct TextRun {
    text: String,
    marks: Vec<MarkdownMark>,
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
            for diff in materialize_projection_diffs(&text, txn, *remaining_nodes)? {
                let text = match diff.insert {
                    Out::Any(Any::String(text)) => {
                        *source_text_bytes =
                            checked_projection_len(*source_text_bytes, text.len())?;
                        text.to_string()
                    }
                    _ => continue,
                };
                if *remaining_nodes == 0 {
                    return Err(CollabError::ProjectionTooComplex {
                        max_depth: MAX_PROJECTION_DEPTH,
                        max_nodes: MAX_PROJECTION_NODES,
                    });
                }
                *remaining_nodes -= 1;
                let mut marks = Vec::new();
                if let Some(attrs) = diff.attributes {
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
                }
                runs.push(TextRun { text, marks });
            }
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
    let rendered = render_nodes(children, "doc", &attrs, "\n\n")?;
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

fn escape_markdown_block_syntax(markdown: &str, mut starts_line: bool) -> ProjectionResult<String> {
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
                output.push('\\')?;
                if escape_next {
                    output.push_str(&body[index..index + 1])?;
                    output.push('\\')?;
                    output.push_str(&body[index + 1..])?;
                } else {
                    output.push_str(&body[index..])?;
                }
            } else {
                output.push_str(body)?;
            }
        } else {
            output.push_str(body)?;
        }
        if line.ends_with('\n') {
            output.push('\n')?;
            starts_line = true;
        } else {
            starts_line = false;
        }
    }
    Ok(output.into_string())
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
    if rest.starts_with(b"[") {
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

fn render_nodes(
    nodes: &[MarkdownNode],
    parent_tag: &str,
    parent_attrs: &BTreeMap<String, Value>,
    separator: &str,
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
            },
        )?;
        output.push_str(&rendered)?;
    }
    Ok(output.into_string())
}

fn render_node(node: &MarkdownNode, context: RenderContext<'_>) -> ProjectionResult<String> {
    match node {
        MarkdownNode::Text(_) => render_inline(std::slice::from_ref(node), false, false),
        MarkdownNode::Fragment(children) => {
            render_nodes(children, context.parent_tag, context.parent_attrs, "")
        }
        MarkdownNode::Element {
            tag,
            attrs,
            children,
        } => match tag.as_str() {
            "doc" => render_nodes(children, tag, attrs, "\n\n"),
            "paragraph" => {
                if children.is_empty() {
                    if context.previous.is_some_and(is_empty_paragraph) {
                        Ok("&nbsp;".to_string())
                    } else {
                        Ok(String::new())
                    }
                } else {
                    render_inline(children, false, true)
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
                    let inline = render_inline(children, false, false)?;
                    let mut output = ProjectionBuffer::with_capacity(level + 1 + inline.len())?;
                    output.push_repeat('#', level)?;
                    output.push(' ')?;
                    output.push_str(&inline)?;
                    Ok(output.into_string())
                }
            }
            "blockquote" => render_prefixed_blocks(children, tag, attrs, ">", None),
            "bulletList" | "orderedList" | "taskList" => render_nodes(children, tag, attrs, "\n"),
            "listItem" => render_list_item(children, &context, None),
            "taskItem" => {
                let checked = attr_bool(attrs, "checked").unwrap_or(false);
                let prefix = if checked { "- [x] " } else { "- [ ] " };
                render_list_item(children, &context, Some(prefix))
            }
            "codeBlock" => render_code_block(attrs, children),
            "horizontalRule" => Ok("---".to_string()),
            "hardBreak" => Ok("  \n".to_string()),
            "image" => render_image(attrs),
            "escapedPunctuation" => ensure_projection_string(format!(
                "\\{}",
                escape_markdown_line_breaks(&attr_js_string(attrs, "value"))
            )),
            "wikilink" => render_wikilink(attrs),
            "inlineAtom" => render_inline_atom(attrs),
            "callout" => render_callout(attrs, children),
            "mathInline" => ensure_projection_string(format!("${}$", attr_js_string(attrs, "tex"))),
            "mathBlock" => {
                ensure_projection_string(format!("$${}$$", attr_js_string(attrs, "tex")))
            }
            "table" => render_table(children),
            "tableRow" | "tableCell" | "tableHeader" => render_nodes(children, tag, attrs, ""),
            _ if context.parent_tag == "paragraph" => render_inline(children, false, true),
            _ => render_nodes(children, tag, attrs, ""),
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
    let prefix = task_prefix.map_or_else(
        || match context.parent_tag {
            "orderedList" => {
                let start = attr_i64(context.parent_attrs, "start")
                    .filter(|start| *start != 0)
                    .unwrap_or(1);
                let ordinal =
                    start.saturating_add(i64::try_from(context.index).unwrap_or(i64::MAX));
                format!("{ordinal}. ")
            }
            _ => "- ".to_string(),
        },
        str::to_string,
    );
    let first_rendered = render_node(
        first,
        RenderContext {
            parent_tag: "listItem",
            parent_attrs: &BTreeMap::new(),
            previous: None,
            index: 0,
        },
    )?;
    let mut output = ProjectionBuffer::new();
    output.push_str(&prefix)?;
    output.push_str(&first_rendered)?;
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
            },
        )?;
        let mut indented = ProjectionBuffer::new();
        for (line_index, line) in child_rendered.split('\n').enumerate() {
            if line_index != 0 {
                indented.push('\n')?;
            }
            indented.push_str("  ")?;
            indented.push_str(line)?;
        }
        if element_tag(child) == Some("paragraph") {
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
    let fence = backtick_fence(&content, 3)?;
    let mut output = ProjectionBuffer::new();
    output.push_str(&fence)?;
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
    let mut longest = 0usize;
    let mut current = 0usize;
    for character in value.chars() {
        if character == '`' {
            current = current.saturating_add(1);
            longest = longest.max(current);
        } else {
            current = 0;
        }
    }
    let length = minimum.max(longest.saturating_add(1));
    let mut fence = ProjectionBuffer::with_capacity(length)?;
    fence.push_repeat('`', length)?;
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

#[derive(Clone, Copy, PartialEq, Eq)]
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

fn render_table(children: &[MarkdownNode]) -> ProjectionResult<String> {
    let mut rows = Vec::new();
    let mut cell_text_bytes = 0usize;
    for row in children {
        let MarkdownNode::Element {
            tag,
            attrs: _,
            children: cells,
        } = row
        else {
            continue;
        };
        if tag != "tableRow" {
            continue;
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
    output.push_str(" |\n")?;
    for row in &rows[1..] {
        output.push_str("| ")?;
        for (index, width) in widths.iter().enumerate() {
            if index != 0 {
                output.push_str(" | ")?;
            }
            let value = row.get(index).map(|cell| cell.text.as_str()).unwrap_or("");
            pad_utf16_into(&mut output, value, *width)?;
        }
        output.push_str(" |\n")?;
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

    #[derive(Clone, Copy)]
    struct InlineReplacement {
        text: &'static str,
        preserve_marks: bool,
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
        replacements: &mut BTreeMap<usize, BTreeMap<usize, InlineReplacement>>,
    ) {
        let Ok(line_text) = std::str::from_utf8(line) else {
            return;
        };
        let Some((escape_index, escape_next)) = leading_markdown_block_escape_index(line_text)
        else {
            return;
        };
        let count = if escape_next { 2 } else { 1 };
        if let Some((part_index, offset)) = line_break {
            replacements.entry(part_index).or_default().insert(
                offset,
                InlineReplacement {
                    text: "\n",
                    preserve_marks: false,
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
                    text: encoded_block_punctuation(byte),
                    preserve_marks: true,
                },
            );
        }
    }

    let mut source_parts = Vec::new();
    flatten(nodes, &mut source_parts);
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

    if escape_block_syntax {
        let mut replacements: BTreeMap<usize, BTreeMap<usize, InlineReplacement>> = BTreeMap::new();
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
                            text: "&#13;",
                            preserve_marks: true,
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
                                    text: replacement,
                                    preserve_marks: false,
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
            let mut escaped_parts = Vec::new();
            for (part_index, part) in std::mem::take(&mut parts).into_iter().enumerate() {
                let Some(part_replacements) = replacements.get(&part_index) else {
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
                for (&offset, &replacement) in part_replacements {
                    if offset > cursor {
                        let mut text = run.clone();
                        text.text = run.text[cursor..offset].to_string();
                        escaped_parts.push(InlinePart::Text {
                            run: text,
                            literal_markdown,
                        });
                    }
                    escaped_parts.push(InlinePart::Text {
                        run: TextRun {
                            text: replacement.text.to_string(),
                            marks: if replacement.preserve_marks {
                                run.marks.clone()
                            } else {
                                Vec::new()
                            },
                        },
                        literal_markdown: true,
                    });
                    cursor = offset + 1;
                }
                if cursor < run.text.len() {
                    let mut text = run;
                    text.text = text.text[cursor..].to_string();
                    escaped_parts.push(InlinePart::Text {
                        run: text,
                        literal_markdown,
                    });
                }
            }
            parts = escaped_parts;
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
            let escaped = escape_markdown_block_syntax(&encoded, starts_line)?;
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
            escape_markdown_block_syntax("before\r---\rnext", true).expect("small projection"),
            "before&#13;---&#13;next"
        );
        assert_eq!(
            escape_markdown_block_syntax("before\r\n---\r\nnext", true).expect("small projection"),
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
                .markdown,
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
                .markdown,
            "\n| first  | row |\n| ------ | --- |\n| second | row |"
        );
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
                .markdown,
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

        // The property under test is that the projection REFUSES before the
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
            .markdown;
        assert_eq!(
            markdown,
            "\n| H               |\n| --------------- |\n| first<br>second |"
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
            .markdown;
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
    fn alternating_format_runs_are_refused_before_diff_materialization() {
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

        PROJECTION_DIFF_MATERIALIZATIONS.with(|count| count.set(0));
        assert!(matches!(
            remote.project_richdoc_with_node_budget(TEST_NODE_BUDGET),
            Err(CollabError::ProjectionTooComplex { .. })
        ));
        PROJECTION_DIFF_MATERIALIZATIONS.with(|count| {
            assert_eq!(
                count.get(),
                0,
                "yrs diff must not eagerly materialize runs after the preflight refuses them"
            );
        });
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

        let rewrite = origin.rewrite_content_to_markdown(ContentKind::Richdoc, RESOLVED);
        peer.apply(&rewrite).expect("peer accepts rewrite");
        origin
            .apply(&peer.encode_full_state())
            .expect("origin accepts peer union");
        peer.apply(&origin.encode_full_state())
            .expect("peer accepts origin union");

        let projection = peer
            .project(ContentKind::Richdoc)
            .expect("peer projection")
            .markdown;
        assert_ne!(projection, RESOLVED);
        assert!(projection.contains("peer unseen edit"));
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
                .markdown,
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
                .markdown,
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
    fn resolution_fold_reconstructs_rich_structure_and_projection() {
        // The fold must parse the chosen markdown into the projection's own
        // schema: the projection reproduces the chosen bytes AND the body
        // holds real nodes, not literal syntax inside paragraphs. MUTATION:
        // flattening the fold back to plain paragraphs keeps the projection
        // equal for most constructs but fails every structure assertion.
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
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, chosen);
        let projected = doc.project(ContentKind::Richdoc).expect("projection");
        assert_eq!(
            projected.markdown, chosen,
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
        // Codex #596 round 4: the projector itself emits one-level nested
        // maps (`scalar_line`), and the fold must accept its own output.
        // MUTATION: bail on `key:` lines again - the delimiters parse as
        // horizontal rules, the projection diverges, and this fails.
        let doc = Ydoc::wire();
        doc.richdoc_append_paragraph("old");
        let chosen = "---\nmeta:\n  owner: ice\n  team: dohc\ntitle: Chosen\n---\n\nbody text";
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, chosen);
        let projected = doc.project(ContentKind::Richdoc).expect("projection");
        assert_eq!(
            projected.markdown, chosen,
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
    fn resolution_fold_bounds_blockquote_depth() {
        // An adversarial run of `> ` prefixes must not recurse without bound
        // inside the resolve frame. MUTATION: drop the depth bound — the
        // adversarial arm builds one blockquote per prefix and this count
        // assertion fails.
        let adversarial = Ydoc::wire();
        let hostile = format!("{}deep", "> ".repeat(1_000));
        adversarial.rewrite_content_to_markdown(ContentKind::Richdoc, &hostile);
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
        // The overflow is NOT lossless: the leftover `> ` markers become
        // paragraph text, which the projector escapes to `&gt;`. The previous
        // comment asserted losslessness and the fold trusted it, so a
        // resolution past the budget would have been stored as bytes the user
        // never chose. This pins the real behaviour — the divergence is
        // OBSERVABLE — which is what `fold_resolution_into_ydoc_in_tx`
        // re-projects to catch before it commits anything.
        let overflowed = Ydoc::wire();
        let hostile = format!("{}deep", "> ".repeat(QUOTE_FOLD_MAX_DEPTH + 5));
        overflowed.rewrite_content_to_markdown(ContentKind::Richdoc, &hostile);
        let projected = overflowed
            .project(ContentKind::Richdoc)
            .expect("projection");
        assert_ne!(
            projected.markdown, hostile,
            "past the budget the fold cannot reproduce the chosen bytes"
        );
        assert!(
            projected.markdown.contains("&gt;"),
            "and the loss is the projector's escaping"
        );
    }

    #[test]
    fn an_ordered_list_ordinal_at_the_integer_ceiling_does_not_overflow() {
        // A parsed ordinal can be i64::MAX, and the successor it implies
        // cannot be represented: unchecked `+ 1` panics the workspace actor
        // in debug and test builds, and wraps in release, where the wrapped
        // value then mis-parses every following line. A resolution body is
        // user-supplied text, so this is reachable from a tiny input.
        //
        // MUTATION: restore `Some(start + 1)` — this test panics with
        // 'attempt to add with overflow'.
        let doc = Ydoc::wire();
        let chosen = format!("{}. item\n\nafter", i64::MAX);
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, &chosen);
        let projected = doc.project(ContentKind::Richdoc).expect("projection");
        assert!(
            projected.markdown.contains("item") && projected.markdown.contains("after"),
            "the list ends where no successor exists and the rest still parses: {}",
            projected.markdown
        );
    }

    #[test]
    fn a_fold_within_the_quote_budget_roundtrips_byte_exactly() {
        // MUTATION: lower QUOTE_FOLD_MAX_DEPTH below 100 — the 100-level arm
        // overflows into escaped paragraph text and this fails. The bound's
        // previous derivation claimed 60 was the projector's ceiling; it is
        // not, and a budget set from that false reading would refuse
        // documents the projection renders happily.
        for levels in [1_usize, 40, 100, QUOTE_FOLD_MAX_DEPTH] {
            let doc = Ydoc::wire();
            let chosen = format!("{}deep", "> ".repeat(levels));
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, &chosen);
            let projected = doc.project(ContentKind::Richdoc).expect("projection");
            assert_eq!(
                projected.markdown, chosen,
                "a {levels}-level quote must roundtrip byte-identically"
            );
        }
    }
}
