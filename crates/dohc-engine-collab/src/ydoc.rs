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
use yrs::types::text::YChange;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{
    Any, Array, Doc, GetString, Map, Options, Out, ReadTxn, StateVector, Text, Transact, Update,
    Xml, XmlElementPrelim, XmlFragment, XmlOut, XmlTextPrelim,
};

use crate::error::CollabError;

/// The declared dohc root schema. The Yjs v1 wire format does not carry
/// root-type kinds — a root's kind is defined by typed API access — so both
/// engines MUST read roots through this identical declaration (spike finding 4).
pub const ROOT_FRONTMATTER: &str = "frontmatter";
/// Secondary map root (engine metadata).
pub const ROOT_META: &str = "meta";
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
    pub fn project(&self, content_kind: ContentKind) -> Projection {
        let markdown = match content_kind {
            ContentKind::Plaintext => self.project_plaintext(),
            ContentKind::Richdoc => self.project_richdoc(),
        };
        Projection {
            markdown,
            content_kind,
            source_state_vector_sha256: crate::hex_sha256(&self.encode_state_vector()),
            destructive: false,
        }
    }

    fn project_plaintext(&self) -> String {
        self.plaintext_string()
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

    fn project_richdoc(&self) -> String {
        let mut out = String::new();
        // Acquire BOTH roots before opening the read txn: yrs `get_or_insert_*`
        // takes the store lock, so calling one while a transaction is live
        // deadlocks (spike harness note).
        let frontmatter = self.doc.get_or_insert_map(ROOT_FRONTMATTER);
        let body = self.doc.get_or_insert_xml_fragment(ROOT_BODY);
        let txn = self.doc.transact();
        let mut has_frontmatter = false;
        if frontmatter.len(&txn) > 0 {
            has_frontmatter = true;
            let mut entries: BTreeMap<String, Value> = BTreeMap::new();
            for (k, v) in frontmatter.iter(&txn) {
                entries.insert(k.to_string(), out_json(&txn, v));
            }
            out.push_str("---\n");
            for (k, v) in &entries {
                out.push_str(&project_frontmatter(k, v));
            }
            out.push_str("---");
        }
        let children: Vec<MarkdownNode> = body
            .children(&txn)
            .map(|child| markdown_node(&txn, child))
            .collect();
        let body_markdown = markdown_document(&children);
        if has_frontmatter {
            out.push_str(if body_markdown.starts_with('\n') {
                "\n"
            } else {
                "\n\n"
            });
        }
        out.push_str(&body_markdown);
        out
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

fn project_frontmatter(key: &str, value: &Value) -> String {
    match value {
        Value::Object(map) if map.get("type") == Some(&json!("any")) => {
            scalar_line(key, map.get("value").unwrap_or(&Value::Null))
        }
        other => scalar_line(key, other),
    }
}

fn scalar_line(key: &str, value: &Value) -> String {
    match value {
        Value::String(s) => format!("{key}: {s}\n"),
        Value::Object(map) => {
            // Nested map: emit sorted `key:` block (constraint 2 — keys already
            // sorted by `any_to_json`'s BTreeMap).
            let mut out = format!("{key}:\n");
            for (k, v) in map {
                out.push_str(&format!("  {}\n", scalar_line(k, v).trim_end()));
            }
            out
        }
        Value::Null => format!("{key}: null\n"),
        other => format!("{key}: {other}\n"),
    }
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

fn markdown_node<T: ReadTxn>(txn: &T, node: XmlOut) -> MarkdownNode {
    match node {
        XmlOut::Text(text) => MarkdownNode::Text(
            text.diff(txn, YChange::identity)
                .into_iter()
                .filter_map(|diff| {
                    let text = match diff.insert {
                        Out::Any(Any::String(text)) => text.to_string(),
                        _ => return None,
                    };
                    let mut marks = Vec::new();
                    if let Some(attrs) = diff.attributes {
                        push_mark(&mut marks, MarkKind::Link, attrs.get("link"));
                        push_mark(&mut marks, MarkKind::Highlight, attrs.get("highlight"));
                        push_mark(
                            &mut marks,
                            MarkKind::Bold,
                            attrs.get("bold").or_else(|| attrs.get("strong")),
                        );
                        push_mark(&mut marks, MarkKind::Code, attrs.get("code"));
                        push_mark(
                            &mut marks,
                            MarkKind::Italic,
                            attrs.get("italic").or_else(|| attrs.get("em")),
                        );
                        push_mark(
                            &mut marks,
                            MarkKind::Strike,
                            attrs.get("strike").or_else(|| attrs.get("strikethrough")),
                        );
                        push_mark(&mut marks, MarkKind::Underline, attrs.get("underline"));
                    }
                    Some(TextRun { text, marks })
                })
                .collect(),
        ),
        XmlOut::Element(element) => {
            let attrs = element
                .attributes(txn)
                .map(|(key, value)| (key.to_string(), out_json_attr(txn, value)))
                .collect();
            let children = element
                .children(txn)
                .map(|child| markdown_node(txn, child))
                .collect();
            MarkdownNode::Element {
                tag: element.tag().to_string(),
                attrs,
                children,
            }
        }
        XmlOut::Fragment(fragment) => MarkdownNode::Fragment(
            fragment
                .children(txn)
                .map(|child| markdown_node(txn, child))
                .collect(),
        ),
    }
}

fn push_mark(marks: &mut Vec<MarkdownMark>, kind: MarkKind, attrs: Option<&Any>) {
    if let Some(attrs) = attrs {
        marks.push(MarkdownMark {
            kind,
            attrs: any_to_json(attrs),
        });
    }
}

fn markdown_document(children: &[MarkdownNode]) -> String {
    let attrs = BTreeMap::new();
    let rendered = render_nodes(children, "doc", &attrs, "\n\n");
    if markdown_output_is_empty(&rendered) {
        String::new()
    } else {
        trim_js_end(&rendered).to_string()
    }
}

fn markdown_output_is_empty(markdown: &str) -> bool {
    let without_entities = markdown.replace("&nbsp;", "").replace('\u{00a0}', "");
    trim_js(&without_entities).is_empty()
}

fn render_nodes(
    nodes: &[MarkdownNode],
    parent_tag: &str,
    parent_attrs: &BTreeMap<String, Value>,
    separator: &str,
) -> String {
    nodes
        .iter()
        .enumerate()
        .map(|(index, node)| {
            render_node(
                node,
                RenderContext {
                    parent_tag,
                    parent_attrs,
                    previous: index.checked_sub(1).map(|previous| &nodes[previous]),
                    index,
                },
            )
        })
        .collect::<Vec<_>>()
        .join(separator)
}

fn render_node(node: &MarkdownNode, context: RenderContext<'_>) -> String {
    match node {
        MarkdownNode::Text(_) => render_inline(std::slice::from_ref(node), false),
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
                        "&nbsp;".to_string()
                    } else {
                        String::new()
                    }
                } else {
                    render_inline(children, false)
                }
            }
            "heading" => {
                if children.is_empty() {
                    String::new()
                } else {
                    let level = attr_i64(attrs, "level").unwrap_or(1).max(0) as usize;
                    format!("{} {}", "#".repeat(level), render_inline(children, false))
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
            "horizontalRule" => "---".to_string(),
            "hardBreak" => "  \n".to_string(),
            "image" => render_image(attrs),
            "escapedPunctuation" => {
                format!(
                    "\\{}",
                    escape_markdown_line_breaks(&attr_js_string(attrs, "value"))
                )
            }
            "wikilink" => render_wikilink(attrs),
            "inlineAtom" => render_inline_atom(attrs),
            "callout" => render_callout(attrs, children),
            "mathInline" => format!("${}$", attr_js_string(attrs, "tex")),
            "mathBlock" => format!("$${}$$", attr_js_string(attrs, "tex")),
            "table" => render_table(children),
            "tableRow" | "tableCell" | "tableHeader" => render_nodes(children, tag, attrs, ""),
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
) -> String {
    let blocks: Vec<String> = children
        .iter()
        .enumerate()
        .map(|(index, child)| {
            let rendered = render_node(
                child,
                RenderContext {
                    parent_tag,
                    parent_attrs,
                    previous: index.checked_sub(1).map(|previous| &children[previous]),
                    index,
                },
            );
            prefix_lines(&rendered, prefix)
        })
        .collect();
    let body = blocks.join(&format!("\n{prefix}\n"));
    match header {
        Some(header) if body.is_empty() => format!("{prefix} {header}"),
        Some(header) => format!("{prefix} {header}\n{body}"),
        None => body,
    }
}

fn prefix_lines(block: &str, prefix: &str) -> String {
    block
        .split('\n')
        .map(|line| {
            if trim_js(line).is_empty() {
                prefix.to_string()
            } else {
                format!("{prefix} {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_list_item(
    children: &[MarkdownNode],
    context: &RenderContext<'_>,
    task_prefix: Option<&str>,
) -> String {
    let Some((first, nested)) = children.split_first() else {
        return String::new();
    };
    let prefix = task_prefix.map_or_else(
        || match context.parent_tag {
            "orderedList" => {
                let start = attr_i64(context.parent_attrs, "start")
                    .filter(|start| *start != 0)
                    .unwrap_or(1);
                format!("{}. ", start + context.index as i64)
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
    );
    let mut output = format!("{prefix}{first_rendered}");
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
        );
        let indented = child_rendered
            .split('\n')
            .map(|line| format!("  {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        if element_tag(child) == Some("paragraph") {
            output.push_str("\n\n");
        } else {
            output.push('\n');
        }
        output.push_str(&indented);
    }
    output
}

fn render_code_block(attrs: &BTreeMap<String, Value>, children: &[MarkdownNode]) -> String {
    let language = attr_js_string(attrs, "language");
    // Match TS: fixed triple-backtick fences can collide with code content.
    if children.is_empty() {
        format!("```{language}\n\n```")
    } else {
        format!("```{language}\n{}\n```", render_inline(children, true))
    }
}

fn render_image(attrs: &BTreeMap<String, Value>) -> String {
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
    format!("![{alt}]({src}{title})")
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

fn render_wikilink(attrs: &BTreeMap<String, Value>) -> String {
    let target = escape_wikilink_part(&attr_js_string(attrs, "target"));
    let label = attr_js_string(attrs, "label");
    if label.is_empty() {
        format!("[[{target}]]")
    } else {
        format!("[[{target}|{}]]", escape_wikilink_part(&label))
    }
}

fn escape_wikilink_part(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace(']', "\\]")
        .replace('|', "\\|")
}

fn render_inline_atom(attrs: &BTreeMap<String, Value>) -> String {
    let source = attr_js_string(attrs, "source");
    if source.is_empty() {
        format!("{{{{atom:{}}}}}", attr_js_string(attrs, "atomId"))
    } else {
        format!("{{{{{source}}}}}")
    }
}

fn render_callout(attrs: &BTreeMap<String, Value>, children: &[MarkdownNode]) -> String {
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
    let rendered: Vec<String> = children
        .iter()
        .enumerate()
        .map(|(index, child)| {
            render_node(
                child,
                RenderContext {
                    parent_tag: "callout",
                    parent_attrs: attrs,
                    previous: index.checked_sub(1).map(|previous| &children[previous]),
                    index,
                },
            )
        })
        .collect();
    if !rendered.iter().any(|block| !trim_js(block).is_empty()) {
        return format!("> {header}");
    }
    let blocks = rendered
        .iter()
        .map(|block| prefix_lines(block, ">"))
        .collect::<Vec<_>>()
        .join("\n>\n");
    format!("> {header}\n{blocks}")
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
    header: bool,
    align: Option<TableAlign>,
}

fn render_table(children: &[MarkdownNode]) -> String {
    let rows: Vec<Vec<TableCell>> = children
        .iter()
        .filter_map(|row| {
            let MarkdownNode::Element {
                tag,
                attrs: _,
                children: cells,
            } = row
            else {
                return None;
            };
            if tag != "tableRow" {
                return None;
            }
            Some(
                cells
                    .iter()
                    .filter_map(|cell| {
                        let MarkdownNode::Element {
                            tag,
                            attrs,
                            children,
                        } = cell
                        else {
                            return None;
                        };
                        if tag != "tableCell" && tag != "tableHeader" {
                            return None;
                        }
                        let raw = if children.len() > 1 {
                            children
                                .iter()
                                .enumerate()
                                .map(|(index, child)| {
                                    render_node(
                                        child,
                                        RenderContext {
                                            parent_tag: tag,
                                            parent_attrs: attrs,
                                            previous: index
                                                .checked_sub(1)
                                                .map(|previous| &children[previous]),
                                            index,
                                        },
                                    )
                                })
                                .collect::<Vec<_>>()
                                .join("\u{001f}")
                        } else {
                            render_nodes(children, tag, attrs, "")
                        };
                        Some(TableCell {
                            // Match TS: literal pipes are emitted unescaped in table cells.
                            text: collapse_js_whitespace(&raw),
                            header: tag == "tableHeader",
                            align: match attrs.get("align").and_then(Value::as_str) {
                                Some("left") => Some(TableAlign::Left),
                                Some("right") => Some(TableAlign::Right),
                                Some("center") => Some(TableAlign::Center),
                                _ => None,
                            },
                        })
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    let column_count = rows.iter().map(Vec::len).max().unwrap_or(0);
    if column_count == 0 {
        return String::new();
    }
    let mut widths = vec![3usize; column_count];
    for row in &rows {
        for (index, cell) in row.iter().enumerate() {
            widths[index] = widths[index].max(utf16_len(&cell.text));
        }
    }
    let header_row = &rows[0];
    let has_header = header_row.iter().any(|cell| cell.header);
    let mut alignments = vec![None; column_count];
    for row in &rows {
        for (index, cell) in row.iter().enumerate() {
            if alignments[index].is_none() {
                alignments[index] = cell.align;
            }
        }
    }
    let header_cells = (0..column_count)
        .map(|index| {
            if has_header {
                pad_utf16(
                    header_row
                        .get(index)
                        .map(|cell| cell.text.as_str())
                        .unwrap_or(""),
                    widths[index],
                )
            } else {
                // Match TS: headerless tables gain a blank synthetic header.
                pad_utf16("", widths[index])
            }
        })
        .collect::<Vec<_>>()
        .join(" | ");
    let separators = widths
        .iter()
        .enumerate()
        .map(|(index, width)| {
            let dashes = "-".repeat(*width);
            match alignments[index] {
                Some(TableAlign::Left) => format!(":{dashes}"),
                Some(TableAlign::Right) => format!("{dashes}:"),
                Some(TableAlign::Center) => format!(":{dashes}:"),
                None => dashes,
            }
        })
        .collect::<Vec<_>>()
        .join(" | ");
    let mut output = format!("\n| {header_cells} |\n| {separators} |\n");
    let body = if has_header { &rows[1..] } else { &rows[..] };
    for row in body {
        let cells = (0..column_count)
            .map(|index| {
                pad_utf16(
                    row.get(index).map(|cell| cell.text.as_str()).unwrap_or(""),
                    widths[index],
                )
            })
            .collect::<Vec<_>>()
            .join(" | ");
        output.push_str(&format!("| {cells} |\n"));
    }
    output
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn pad_utf16(value: &str, width: usize) -> String {
    format!(
        "{value}{}",
        " ".repeat(width.saturating_sub(utf16_len(value)))
    )
}

fn collapse_js_whitespace(value: &str) -> String {
    let mut collapsed = String::new();
    let mut in_whitespace = false;
    for character in value.chars() {
        if is_js_whitespace(character) {
            if !in_whitespace {
                collapsed.push(' ');
                in_whitespace = true;
            }
        } else {
            collapsed.push(character);
            in_whitespace = false;
        }
    }
    trim_js(&collapsed).to_string()
}

fn render_inline(nodes: &[MarkdownNode], code_context: bool) -> String {
    enum InlinePart<'a> {
        Text(&'a TextRun),
        Node(&'a MarkdownNode),
    }

    fn flatten<'a>(nodes: &'a [MarkdownNode], parts: &mut Vec<InlinePart<'a>>) {
        for node in nodes {
            match node {
                MarkdownNode::Text(runs) => {
                    parts.extend(runs.iter().map(InlinePart::Text));
                }
                MarkdownNode::Fragment(children) => flatten(children, parts),
                MarkdownNode::Element { .. } => parts.push(InlinePart::Node(node)),
            }
        }
    }

    let mut parts = Vec::new();
    flatten(nodes, &mut parts);
    let mut output = Vec::new();
    let mut active: Vec<MarkdownMark> = Vec::new();
    let mut modes: BTreeMap<MarkKind, OpeningMode> = BTreeMap::new();
    let mut reopen_html = BTreeSet::new();

    for (index, part) in parts.iter().enumerate() {
        let next_marks = parts.get(index + 1).and_then(|next| match next {
            InlinePart::Text(run) => Some(run.marks.as_slice()),
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
                let rendered = render_node(
                    node,
                    RenderContext {
                        parent_tag: "paragraph",
                        parent_attrs: &BTreeMap::new(),
                        previous: None,
                        index,
                    },
                );
                output.push(format!("{before}{rendered}"));
            }
            InlinePart::Text(run) => {
                let mut text = run.text.clone();
                if has_mark(&run.marks, MarkKind::Highlight) {
                    text = text.replace('=', "\\=");
                }
                if !code_context && !has_mark(&run.marks, MarkKind::Code) {
                    text = encode_html_entities(&text);
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
                    text = format!("{}{text}", mark_opening(mark, mode));
                    modes.insert(mark.kind, mode);
                }
                if !crossed {
                    for mark in to_open.iter().rev() {
                        set_active(&mut active, mark.clone());
                    }
                }
                text = format!("{leading}{text}");
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
                output.push(text);
            }
        }
    }
    output.concat()
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
        // Match TS: inline code always uses a single backtick delimiter.
        MarkKind::Code => "`".to_string(),
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
        // Match TS: inline code always uses a single backtick delimiter.
        MarkKind::Code => "`".to_string(),
        MarkKind::Italic => "*".to_string(),
        MarkKind::Strike => "~~".to_string(),
        MarkKind::Underline => "++".to_string(),
    }
}

fn encode_html_entities(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
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

        assert_eq!(markdown_document(&nodes), "content survives");
    }
}
