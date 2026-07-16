// R11 yrs/Yjs interoperability spike harness.
//
// A line-delimited JSON stdio server the Node driver (scripts/) talks to.
// Each request is one JSON object on one line; each response is one JSON
// object on one line. Binary payloads (Yjs update / state-vector bytes)
// travel base64-encoded.
//
// The harness exposes exactly what the interop criteria need:
//   - apply Yjs v1 updates into a yrs Doc (malformed input must error
//     without corrupting the doc),
//   - re-encode full state / state vectors / diffs (v1),
//   - merge updates (the compaction primitive),
//   - drive yrs-side edits (Y.Text + XmlFragment paragraphs + XmlText
//     formatting) and return the delta yrs encoded for them,
//   - dump a canonical content JSON (maps, text deltas, XML tree) that the
//     JS driver computes identically from Yjs, so convergence is compared at
//     CONTENT level, not just state vectors.

use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, Write};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Map as JsonMap, Value};
use yrs::block::ClientID;
use yrs::types::text::{Diff, YChange};
use yrs::types::Attrs;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{
    Any, Array, Doc, GetString, Map, OffsetKind, Options, Out, ReadTxn, StateVector, Text,
    Transact, Update, Xml, XmlElementPrelim, XmlFragment, XmlOut, XmlTextPrelim,
};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Request {
    /// Create (or replace) a doc under `id`. Optional fixed clientId keeps
    /// fuzz runs reproducible under a fixed seed.
    New { id: String, client_id: Option<u64> },
    /// Apply a base64 Yjs v1 update. Malformed bytes must error cleanly.
    Apply { id: String, update: String },
    /// Full state re-encode + state vector.
    State { id: String },
    /// Diff against a remote state vector (base64, v1).
    Diff { id: String, sv: String },
    /// Canonical content JSON (see `content_json`). `schema` names the
    /// expected kind of each root type: the Yjs v1 wire format does NOT
    /// carry root-type kinds (a root's kind is defined by typed API access),
    /// so both sides must read roots through the same declared schema —
    /// exactly what the TS engine does with its typed getters.
    Content {
        id: String,
        schema: HashMap<String, RootKind>,
    },
    /// Merge independent updates into one (compaction primitive).
    Merge { updates: Vec<String> },
    /// Insert into the root Y.Text `field` at `index`.
    TextInsert {
        id: String,
        field: String,
        index: u32,
        text: String,
    },
    /// Delete `len` chars from the root Y.Text `field` at `index`.
    TextDelete {
        id: String,
        field: String,
        index: u32,
        len: u32,
    },
    /// Insert a `<paragraph>` element holding one XmlText child into the
    /// root XmlFragment `field` at `index`.
    XmlInsertParagraph {
        id: String,
        field: String,
        index: u32,
        text: String,
    },
    /// Insert text into the XmlText child of paragraph `para` (optionally
    /// with formatting attributes, i.e. ProseMirror marks).
    XmlTextInsert {
        id: String,
        field: String,
        para: u32,
        offset: u32,
        text: String,
        attrs: Option<JsonMap<String, Value>>,
    },
    /// Delete a range from the XmlText child of paragraph `para`.
    XmlTextDelete {
        id: String,
        field: String,
        para: u32,
        offset: u32,
        len: u32,
    },
    Free { id: String },
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum RootKind {
    Map,
    Text,
    XmlFragment,
}

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut docs: HashMap<String, Doc> = HashMap::new();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(req) => handle(&mut docs, req),
            Err(e) => Err(format!("bad request: {e}")),
        };
        let body = match response {
            Ok(mut v) => {
                v.as_object_mut()
                    .expect("responses are objects")
                    .insert("ok".into(), json!(true));
                v
            }
            Err(e) => json!({ "ok": false, "error": e }),
        };
        writeln!(out, "{body}").expect("stdout write");
        out.flush().expect("stdout flush");
    }
}

fn handle(docs: &mut HashMap<String, Doc>, req: Request) -> Result<Value, String> {
    match req {
        Request::New { id, client_id } => {
            // INTEROP-CRITICAL: Yjs measures text in UTF-16 code units; yrs
            // defaults to UTF-8 byte offsets, which desyncs item lengths (and
            // therefore CRDT clocks) against Yjs peers on any non-ASCII text.
            // Every doc that will exchange updates with Yjs MUST use Utf16.
            let options = Options {
                offset_kind: OffsetKind::Utf16,
                client_id: client_id.map(ClientID::new).unwrap_or_else(ClientID::random),
                ..Options::default()
            };
            docs.insert(id, Doc::with_options(options));
            Ok(json!({}))
        }
        Request::Apply { id, update } => {
            let doc = get(docs, &id)?;
            let bytes = b64(&update)?;
            let update = Update::decode_v1(&bytes).map_err(|e| format!("decode: {e}"))?;
            let mut txn = doc.transact_mut();
            txn.apply_update(update).map_err(|e| format!("apply: {e}"))?;
            Ok(json!({}))
        }
        Request::State { id } => {
            let doc = get(docs, &id)?;
            let txn = doc.transact();
            Ok(json!({
                "sv": B64.encode(txn.state_vector().encode_v1()),
                "update": B64.encode(txn.encode_state_as_update_v1(&StateVector::default())),
            }))
        }
        Request::Diff { id, sv } => {
            let doc = get(docs, &id)?;
            let sv = StateVector::decode_v1(&b64(&sv)?).map_err(|e| format!("sv decode: {e}"))?;
            let txn = doc.transact();
            Ok(json!({ "update": B64.encode(txn.encode_state_as_update_v1(&sv)) }))
        }
        Request::Content { id, schema } => {
            let doc = get(docs, &id)?;
            Ok(json!({ "content": content_json(doc, &schema) }))
        }
        Request::Merge { updates } => {
            let mut decoded = Vec::with_capacity(updates.len());
            for u in &updates {
                decoded.push(Update::decode_v1(&b64(u)?).map_err(|e| format!("decode: {e}"))?);
            }
            let merged = Update::merge_updates(decoded);
            Ok(json!({ "update": B64.encode(merged.encode_v1()) }))
        }
        // NOTE: every root ref is acquired BEFORE the edit transaction opens —
        // yrs's get_or_insert_* take the doc's store lock, so calling them
        // while a TransactionMut is live deadlocks.
        Request::TextInsert {
            id,
            field,
            index,
            text,
        } => {
            let doc = get(docs, &id)?;
            let t = doc.get_or_insert_text(field.as_str());
            with_delta(doc, |txn| {
                let index = snap_utf16(&t.get_string(txn), index);
                t.insert(txn, index, &text);
                Ok(())
            })
        }
        Request::TextDelete {
            id,
            field,
            index,
            len,
        } => {
            let doc = get(docs, &id)?;
            let t = doc.get_or_insert_text(field.as_str());
            with_delta(doc, |txn| {
                let s = t.get_string(txn);
                let index = snap_utf16(&s, index);
                let len = snap_utf16(&s, index + len) - index;
                if len > 0 {
                    t.remove_range(txn, index, len);
                }
                Ok(())
            })
        }
        Request::XmlInsertParagraph {
            id,
            field,
            index,
            text,
        } => {
            let doc = get(docs, &id)?;
            let frag = doc.get_or_insert_xml_fragment(field.as_str());
            with_delta(doc, |txn| {
                let index = index.min(frag.len(txn));
                let el = frag.insert(txn, index, XmlElementPrelim::empty("paragraph"));
                el.insert(txn, 0, XmlTextPrelim::new(text.as_str()));
                Ok(())
            })
        }
        Request::XmlTextInsert {
            id,
            field,
            para,
            offset,
            text,
            attrs,
        } => {
            let doc = get(docs, &id)?;
            let frag = doc.get_or_insert_xml_fragment(field.as_str());
            with_delta(doc, |txn| {
                let t = paragraph_text(&frag, txn, para)?;
                let offset = snap_utf16(&xml_plain_string(txn, &t), offset);
                match attrs {
                    Some(map) if !map.is_empty() => {
                        let attrs: Attrs = map
                            .iter()
                            .map(|(k, v)| (k.as_str().into(), json_to_any(v)))
                            .collect();
                        t.insert_with_attributes(txn, offset, &text, attrs);
                    }
                    _ => t.insert(txn, offset, &text),
                }
                Ok(())
            })
        }
        Request::XmlTextDelete {
            id,
            field,
            para,
            offset,
            len,
        } => {
            let doc = get(docs, &id)?;
            let frag = doc.get_or_insert_xml_fragment(field.as_str());
            with_delta(doc, |txn| {
                let t = paragraph_text(&frag, txn, para)?;
                let s = xml_plain_string(txn, &t);
                let offset = snap_utf16(&s, offset);
                let len = snap_utf16(&s, offset + len) - offset;
                if len > 0 {
                    t.remove_range(txn, offset, len);
                }
                Ok(())
            })
        }
        Request::Free { id } => {
            docs.remove(&id);
            Ok(json!({}))
        }
    }
}

fn get<'a>(docs: &'a mut HashMap<String, Doc>, id: &str) -> Result<&'a Doc, String> {
    docs.get(id).ok_or_else(|| format!("unknown doc {id}"))
}

fn b64(s: &str) -> Result<Vec<u8>, String> {
    B64.decode(s).map_err(|e| format!("base64: {e}"))
}

/// Run a yrs-side edit and return the exact v1 delta it produced (state
/// before the edit -> state after), which the JS driver delivers to Yjs.
fn with_delta(
    doc: &Doc,
    edit: impl FnOnce(&mut yrs::TransactionMut) -> Result<(), String>,
) -> Result<Value, String> {
    let before = doc.transact().state_vector().clone();
    {
        let mut txn = doc.transact_mut();
        edit(&mut txn)?;
    }
    let delta = doc.transact().encode_state_as_update_v1(&before);
    Ok(json!({ "update": B64.encode(delta) }))
}

/// Snap a UTF-16 offset to the nearest code-point boundary at or below it
/// (and clamp to the string's UTF-16 length). Rust strings cannot represent
/// lone surrogates, so an edit landing inside a surrogate pair must move to
/// a boundary — mirroring what ProseMirror-driven edits produce in practice.
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

/// The plain text of an XmlText (concatenated string inserts), WITHOUT the
/// formatting tags XmlTextRef::get_string interleaves.
fn xml_plain_string(txn: &yrs::TransactionMut, t: &yrs::XmlTextRef) -> String {
    let mut out = String::new();
    for d in t.diff(txn, YChange::identity) {
        if let Out::Any(Any::String(s)) = d.insert {
            out.push_str(&s);
        }
    }
    out
}

/// Resolve the XmlText child of the `para`-th element of a root fragment.
fn paragraph_text(
    frag: &yrs::XmlFragmentRef,
    txn: &mut yrs::TransactionMut,
    para: u32,
) -> Result<yrs::XmlTextRef, String> {
    let node = frag
        .get(txn, para)
        .ok_or_else(|| format!("no node at index {para}"))?;
    let el = match node {
        XmlOut::Element(el) => el,
        other => return Err(format!("node {para} is not an element: {other:?}")),
    };
    match el.get(txn, 0) {
        Some(XmlOut::Text(t)) => Ok(t),
        other => Err(format!("paragraph {para} first child is not XmlText: {other:?}")),
    }
}

// ---- canonical content JSON -------------------------------------------------
//
// The JS driver computes the same shape from Yjs (see scripts/canonical.ts):
//   { "<rootName>": <root> } for every root type in the doc, where
//   map        -> {"type":"map","value":{sorted json}}
//   array      -> {"type":"array","value":[json...]}
//   text       -> {"type":"text","delta":[{"insert":..,"attrs":{sorted}}...]}
//   xmlFragment-> {"type":"xmlFragment","children":[node...]}
//   element    -> {"type":"element","tag":..,"attrs":{sorted},"children":[..]}
//   xmltext    -> {"type":"xmlText","delta":[...]}
// Numbers normalize integral floats to JSON integers so f64/bigint encoding
// differences between the two implementations cannot cause false mismatches.

fn content_json(doc: &Doc, schema: &HashMap<String, RootKind>) -> Value {
    let mut roots = BTreeMap::new();
    // Read each declared root through its typed accessor (defining the root
    // kind locally, exactly like the TS engine's typed getters). Empty roots
    // are omitted: whether an empty root exists at all depends on local API
    // access, not replicated state, so both sides skip them.
    for (name, kind) in schema {
        let value = match kind {
            RootKind::Map => {
                let m = doc.get_or_insert_map(name.as_str());
                let txn = doc.transact();
                if m.len(&txn) == 0 {
                    continue;
                }
                out_json(&txn, Out::YMap(m))
            }
            RootKind::Text => {
                let t = doc.get_or_insert_text(name.as_str());
                let txn = doc.transact();
                if t.len(&txn) == 0 {
                    continue;
                }
                out_json(&txn, Out::YText(t))
            }
            RootKind::XmlFragment => {
                let f = doc.get_or_insert_xml_fragment(name.as_str());
                let txn = doc.transact();
                if f.len(&txn) == 0 {
                    continue;
                }
                out_json(&txn, Out::YXmlFragment(f))
            }
        };
        roots.insert(name.clone(), value);
    }
    // Surface any replicated root the schema did NOT declare so a mismatch in
    // root enumeration cannot pass silently.
    let txn = doc.transact();
    for (name, _) in txn.root_refs() {
        if !schema.contains_key(name) {
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
        Out::YText(t) => json!({ "type": "text", "delta": text_delta(txn, &t) }),
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
        XmlOut::Text(t) => json!({ "type": "xmlText", "delta": xml_text_delta(txn, &t) }),
        XmlOut::Fragment(f) => {
            let children: Vec<Value> = f.children(txn).map(|c| xml_json(txn, c)).collect();
            json!({ "type": "xmlFragment", "children": children })
        }
    }
}

/// Attribute values arrive as `Out`; scalars are the norm (y-prosemirror
/// writes node attrs as plain values).
fn out_json_attr<T: ReadTxn>(txn: &T, out: Out) -> Value {
    match out {
        Out::Any(any) => any_to_json(&any),
        other => out_json(txn, other),
    }
}

fn text_delta<T: ReadTxn>(txn: &T, t: &yrs::TextRef) -> Value {
    diffs_json(t.diff(txn, YChange::identity))
}

fn xml_text_delta<T: ReadTxn>(txn: &T, t: &yrs::XmlTextRef) -> Value {
    diffs_json(t.diff(txn, YChange::identity))
}

fn diffs_json(diffs: Vec<Diff<YChange>>) -> Value {
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

fn any_to_json(any: &Any) -> Value {
    match any {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(b) => json!(b),
        // Yjs encodes integral JS numbers as varint integers and everything
        // else as f64; JSON.stringify(1) === "1" on the JS side, so integral
        // floats normalize to JSON integers here.
        Any::Number(n) => {
            if n.fract() == 0.0 && n.is_finite() && n.abs() < 9.007_199_254_740_992e15 {
                json!(*n as i64)
            } else {
                json!(n)
            }
        }
        Any::BigInt(i) => json!(i),
        Any::String(s) => json!(s.as_ref()),
        Any::Buffer(b) => json!({ "__bytes__": B64.encode(b.as_ref()) }),
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
        Value::Bool(b) => Any::Bool(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Any::BigInt(i)
            } else {
                Any::Number(n.as_f64().unwrap_or(f64::NAN))
            }
        }
        Value::String(s) => Any::from(s.as_str()),
        Value::Array(items) => Any::from(items.iter().map(json_to_any).collect::<Vec<_>>()),
        Value::Object(map) => Any::from(
            map.iter()
                .map(|(k, v)| (k.clone(), json_to_any(v)))
                .collect::<HashMap<String, Any>>(),
        ),
    }
}
