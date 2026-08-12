//! The bundled Excalidraw scene codec.
//!
//! The live schema stores immutable element revisions and small scene metadata
//! as canonical JSON strings. This module owns that format-specific schema and
//! folds it into Excalidraw's portable JSON shape. Asset bytes are hydrated by
//! the runtime after this pure fold; this codec only validates their durable
//! workspace references.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use base64::Engine as _;
use serde::Serialize;
use serde_json::{Map, Value};

const EXPORT_SOURCE: &str = "https://excalidraw.com";
const EXPORT_VERSION: u8 = 2;
const MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const EXPORTED_APP_STATE_KEYS: [&str; 4] = [
    "gridModeEnabled",
    "gridSize",
    "gridStep",
    "viewBackgroundColor",
];

/// One embedded file decoded from a native Excalidraw artifact. The caller
/// chooses its durable workspace path and verifies storage atomically.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedSceneFile {
    pub id: String,
    pub mime_type: String,
    pub created: u64,
    pub last_retrieved: Option<u64>,
    pub version: Option<u64>,
    pub bytes: Vec<u8>,
}

/// A storage-neutral native scene import.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedScene {
    /// A Yjs v1 update for the revision and app-state roots. Every `Ydoc`
    /// declares the asset root too; the seed layer adds asset records after it
    /// externalizes the returned files.
    pub initial_update: Vec<u8>,
    pub files: BTreeMap<String, ImportedSceneFile>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SceneImportError {
    #[error("invalid Excalidraw artifact: {reason}")]
    Invalid { reason: &'static str },
}

/// A validated durable asset reference. The runtime uses these records to
/// hydrate native `BinaryFileData` after the pure scene fold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneAsset {
    pub id: String,
    pub mime_type: String,
    pub created: u64,
    pub path: String,
    pub sha256: String,
    pub last_retrieved: Option<u64>,
    pub version: Option<u64>,
}

/// The deterministic scene fold before asset bytes are hydrated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoldedScene {
    pub elements: Vec<Value>,
    pub app_state: BTreeMap<String, Value>,
    pub assets: BTreeMap<String, SceneAsset>,
}

#[derive(Serialize)]
struct PortableScene<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    version: u8,
    source: &'static str,
    elements: &'a [Value],
    #[serde(rename = "appState")]
    app_state: &'a BTreeMap<String, Value>,
    files: BTreeMap<String, Value>,
}

impl FoldedScene {
    /// Emit native portable Excalidraw JSON without asset bytes. The runtime
    /// replaces `files` after it resolves the validated asset records. The
    /// two-space layout matches Excalidraw's native JSON export; durable map
    /// records and fingerprints remain compact canonical JSON.
    pub fn portable_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(&PortableScene {
            kind: "excalidraw",
            version: EXPORT_VERSION,
            source: EXPORT_SOURCE,
            elements: &self.elements,
            app_state: &self.app_state,
            files: BTreeMap::new(),
        })
    }
}

/// Parse a native Excalidraw v2 artifact into the live scene roots and decode
/// its embedded files. This function does not choose workspace paths or write
/// storage.
pub fn import_portable_scene(content: &str) -> Result<ImportedScene, SceneImportError> {
    let value: Value = serde_json::from_str(content).map_err(|_| SceneImportError::Invalid {
        reason: "content must be JSON",
    })?;
    let object = value.as_object().ok_or(SceneImportError::Invalid {
        reason: "top level must be an object",
    })?;
    let expected: BTreeSet<&str> = ["appState", "elements", "files", "source", "type", "version"]
        .into_iter()
        .collect();
    if object.len() != expected.len() || object.keys().any(|key| !expected.contains(key.as_str())) {
        return Err(SceneImportError::Invalid {
            reason:
                "top level must contain only type, version, source, elements, appState, and files",
        });
    }
    if object.get("type").and_then(Value::as_str) != Some("excalidraw")
        || object.get("version").and_then(safe_u64) != Some(u64::from(EXPORT_VERSION))
        || object.get("source").and_then(Value::as_str).is_none()
    {
        return Err(SceneImportError::Invalid {
            reason: "type, version, or source is invalid",
        });
    }

    let element_values =
        object
            .get("elements")
            .and_then(Value::as_array)
            .ok_or(SceneImportError::Invalid {
                reason: "elements must be an array",
            })?;
    let mut revisions = BTreeMap::new();
    let mut image_file_ids = BTreeSet::new();
    for element in element_values {
        let element_object = element.as_object().ok_or(SceneImportError::Invalid {
            reason: "each element must be an object",
        })?;
        let id = element_object
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or(SceneImportError::Invalid {
                reason: "each element needs a non-empty id",
            })?;
        let version =
            element_object
                .get("version")
                .and_then(safe_u64)
                .ok_or(SceneImportError::Invalid {
                    reason: "each element needs a JS-safe nonnegative version",
                })?;
        let nonce = element_object
            .get("versionNonce")
            .and_then(safe_u64)
            .ok_or(SceneImportError::Invalid {
                reason: "each element needs a JS-safe nonnegative versionNonce",
            })?;
        let key = RevisionKey {
            id: id.to_owned(),
            version,
            nonce,
        };
        if !valid_element_snapshot(element, &key) {
            return Err(SceneImportError::Invalid {
                reason: "an element has an invalid native snapshot shape",
            });
        }
        let revision_key = serde_json::to_string(&json_revision_key(&key)).map_err(|_| {
            SceneImportError::Invalid {
                reason: "an element revision key could not be encoded",
            }
        })?;
        let snapshot = serde_json::to_string(element).map_err(|_| SceneImportError::Invalid {
            reason: "an element snapshot could not be encoded",
        })?;
        if revisions.insert(revision_key, snapshot).is_some() {
            return Err(SceneImportError::Invalid {
                reason: "element revision tuples must be unique",
            });
        }
        if element_object.get("type").and_then(Value::as_str) == Some("image")
            && element_object.get("isDeleted").and_then(Value::as_bool) == Some(false)
        {
            if let Some(file_id) = element_object.get("fileId").and_then(Value::as_str) {
                image_file_ids.insert(file_id.to_owned());
            }
        }
    }

    let app_state_object =
        object
            .get("appState")
            .and_then(Value::as_object)
            .ok_or(SceneImportError::Invalid {
                reason: "appState must be an object",
            })?;
    if app_state_object
        .keys()
        .any(|key| !EXPORTED_APP_STATE_KEYS.contains(&key.as_str()))
    {
        return Err(SceneImportError::Invalid {
            reason: "appState contains a property that native export does not preserve",
        });
    }
    validate_app_state(app_state_object)?;
    let app_state: BTreeMap<String, String> = app_state_object
        .iter()
        .map(|(key, value)| {
            serde_json::to_string(value)
                .map(|value| (key.clone(), value))
                .map_err(|_| SceneImportError::Invalid {
                    reason: "an appState property could not be encoded",
                })
        })
        .collect::<Result<_, _>>()?;

    let files_object =
        object
            .get("files")
            .and_then(Value::as_object)
            .ok_or(SceneImportError::Invalid {
                reason: "files must be an object",
            })?;
    let mut files = BTreeMap::new();
    for file_id in image_file_ids {
        let value = files_object
            .get(&file_id)
            .ok_or(SceneImportError::Invalid {
                reason: "a live image references a missing embedded file",
            })?;
        let file = import_file(&file_id, value)?;
        files.insert(file_id, file);
    }

    let doc = crate::Ydoc::wire();
    let initial_update = doc.seed_scene_maps(&revisions, &app_state, &BTreeMap::new());
    Ok(ImportedScene {
        initial_update,
        files,
    })
}

/// Encode validated durable asset records as a Yjs v1 update for the scene
/// asset root. The seed layer calls this after it has chosen refs and hashes.
pub fn encode_scene_asset_records(
    assets: &BTreeMap<String, String>,
) -> Result<Vec<u8>, SceneImportError> {
    if assets
        .iter()
        .any(|(id, value)| parse_asset(id, value).is_none())
    {
        return Err(SceneImportError::Invalid {
            reason: "a durable scene asset record is invalid",
        });
    }
    let doc = crate::Ydoc::wire();
    Ok(doc.seed_scene_maps(&BTreeMap::new(), &BTreeMap::new(), assets))
}

fn json_revision_key(key: &RevisionKey) -> Value {
    Value::Array(vec![
        Value::String(key.id.clone()),
        Value::from(key.version),
        Value::from(key.nonce),
    ])
}

fn validate_app_state(object: &Map<String, Value>) -> Result<(), SceneImportError> {
    for (key, value) in object {
        let valid = match key.as_str() {
            "gridModeEnabled" => value.is_boolean(),
            "gridSize" | "gridStep" => value.is_null() || value.as_f64().is_some(),
            "viewBackgroundColor" => value.as_str().is_some_and(|color| !color.is_empty()),
            _ => false,
        };
        if !valid {
            return Err(SceneImportError::Invalid {
                reason: "an appState property has an invalid native value",
            });
        }
    }
    Ok(())
}

fn import_file(id: &str, value: &Value) -> Result<ImportedSceneFile, SceneImportError> {
    let object = value.as_object().ok_or(SceneImportError::Invalid {
        reason: "each embedded file must be an object",
    })?;
    let allowed: BTreeSet<&str> = [
        "created",
        "dataURL",
        "id",
        "lastRetrieved",
        "mimeType",
        "version",
    ]
    .into_iter()
    .collect();
    if object.keys().any(|field| !allowed.contains(field.as_str()))
        || object.get("id").and_then(Value::as_str) != Some(id)
    {
        return Err(SceneImportError::Invalid {
            reason: "an embedded file has an invalid native shape",
        });
    }
    let mime_type = object
        .get("mimeType")
        .and_then(Value::as_str)
        .filter(|mime| !mime.is_empty())
        .ok_or(SceneImportError::Invalid {
            reason: "an embedded file needs a MIME type",
        })?;
    let data_url =
        object
            .get("dataURL")
            .and_then(Value::as_str)
            .ok_or(SceneImportError::Invalid {
                reason: "an embedded file needs a data URL",
            })?;
    let prefix = format!("data:{mime_type};base64,");
    let encoded = data_url
        .strip_prefix(&prefix)
        .ok_or(SceneImportError::Invalid {
            reason: "an embedded file data URL must match its MIME type",
        })?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| SceneImportError::Invalid {
            reason: "an embedded file data URL must contain standard base64",
        })?;
    Ok(ImportedSceneFile {
        id: id.to_owned(),
        mime_type: mime_type.to_owned(),
        created: object
            .get("created")
            .and_then(safe_u64)
            .ok_or(SceneImportError::Invalid {
                reason: "an embedded file needs a JS-safe nonnegative created timestamp",
            })?,
        last_retrieved: optional_u64(object, "lastRetrieved").ok_or(SceneImportError::Invalid {
            reason: "embedded file lastRetrieved must be a JS-safe nonnegative integer",
        })?,
        version: optional_u64(object, "version").ok_or(SceneImportError::Invalid {
            reason: "embedded file version must be a JS-safe nonnegative integer",
        })?,
        bytes,
    })
}

#[derive(Debug)]
struct RevisionKey {
    id: String,
    version: u64,
    nonce: u64,
}

#[derive(Debug)]
struct Winner {
    version: u64,
    nonce: u64,
    element: Value,
}

/// Fold the three live scene maps into a deterministic format-owned value.
/// Invalid records are ignored. A malformed record cannot make a valid scene
/// unavailable.
pub fn fold_scene(
    revisions: &BTreeMap<String, String>,
    app_state: &BTreeMap<String, String>,
    assets: &BTreeMap<String, String>,
) -> FoldedScene {
    let assets = fold_assets(assets);
    let mut winners: BTreeMap<String, Winner> = BTreeMap::new();

    for (raw_key, raw_element) in revisions {
        let Some(key) = parse_revision_key(raw_key) else {
            continue;
        };
        let Some(element) = canonical_json(raw_element) else {
            continue;
        };
        if !valid_element_snapshot(&element, &key) {
            continue;
        }

        let wins = winners.get(&key.id).is_none_or(|winner| {
            key.version > winner.version
                || (key.version == winner.version && key.nonce < winner.nonce)
        });
        if wins {
            winners.insert(
                key.id,
                Winner {
                    version: key.version,
                    nonce: key.nonce,
                    element,
                },
            );
        }
    }

    let mut elements: Vec<Value> = winners
        .into_values()
        .filter_map(|winner| {
            let object = winner.element.as_object()?;
            if object.get("isDeleted").and_then(Value::as_bool) == Some(true) {
                None
            } else {
                Some(winner.element)
            }
        })
        .collect();

    let live_ids: BTreeSet<String> = elements
        .iter()
        .filter_map(|element| element.get("id")?.as_str().map(str::to_owned))
        .collect();
    let asset_ids: BTreeSet<String> = assets.keys().cloned().collect();
    for element in &mut elements {
        repair_element(element, &live_ids, &asset_ids);
    }
    elements.sort_by(compare_elements);

    let app_state = EXPORTED_APP_STATE_KEYS
        .into_iter()
        .filter_map(|key| canonical_json(app_state.get(key)?).map(|value| (key.to_owned(), value)))
        .collect();

    FoldedScene {
        elements,
        app_state,
        assets,
    }
}

fn canonical_json(raw: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(raw).ok()?;
    (serde_json::to_string(&value).ok()?.as_str() == raw).then_some(value)
}

fn parse_revision_key(raw: &str) -> Option<RevisionKey> {
    let value = canonical_json(raw)?;
    let tuple = value.as_array()?;
    if tuple.len() != 3 {
        return None;
    }
    let id = tuple[0].as_str()?.to_owned();
    let version = safe_u64(&tuple[1])?;
    let nonce = safe_u64(&tuple[2])?;
    if id.is_empty() {
        return None;
    }
    Some(RevisionKey { id, version, nonce })
}

fn valid_element_snapshot(element: &Value, key: &RevisionKey) -> bool {
    let Some(object) = element.as_object() else {
        return false;
    };
    object.get("id").and_then(Value::as_str) == Some(key.id.as_str())
        && object.get("version").and_then(safe_u64) == Some(key.version)
        && object.get("versionNonce").and_then(safe_u64) == Some(key.nonce)
        && object.get("isDeleted").and_then(Value::as_bool).is_some()
        && matches!(
            object.get("index"),
            None | Some(Value::Null | Value::String(_))
        )
        && object
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| !kind.is_empty() && kind != "selection")
}

fn fold_assets(assets: &BTreeMap<String, String>) -> BTreeMap<String, SceneAsset> {
    assets
        .iter()
        .filter_map(|(key, raw)| parse_asset(key, raw).map(|asset| (key.clone(), asset)))
        .collect()
}

fn parse_asset(key: &str, raw: &str) -> Option<SceneAsset> {
    let value = canonical_json(raw)?;
    let object = value.as_object()?;
    let allowed: BTreeSet<&str> = [
        "created",
        "id",
        "lastRetrieved",
        "mimeType",
        "ref",
        "sha256",
        "version",
    ]
    .into_iter()
    .collect();
    if object.keys().any(|field| !allowed.contains(field.as_str())) {
        return None;
    }
    let id = object.get("id")?.as_str()?;
    let mime_type = object.get("mimeType")?.as_str()?;
    let path = object.get("ref")?.as_str()?;
    let sha256 = object.get("sha256")?.as_str()?;
    if id != key
        || id.is_empty()
        || mime_type.is_empty()
        || !valid_workspace_ref(path)
        || !valid_sha256(sha256)
    {
        return None;
    }
    Some(SceneAsset {
        id: id.to_owned(),
        mime_type: mime_type.to_owned(),
        created: safe_u64(object.get("created")?)?,
        path: path.to_owned(),
        sha256: sha256.to_owned(),
        last_retrieved: optional_u64(object, "lastRetrieved")?,
        version: optional_u64(object, "version")?,
    })
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn optional_u64(object: &Map<String, Value>, key: &str) -> Option<Option<u64>> {
    match object.get(key) {
        None => Some(None),
        Some(value) => safe_u64(value).map(Some),
    }
}

fn safe_u64(value: &Value) -> Option<u64> {
    let value = value.as_u64()?;
    (value <= MAX_JS_SAFE_INTEGER).then_some(value)
}

fn valid_workspace_ref(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn repair_element(element: &mut Value, live_ids: &BTreeSet<String>, asset_ids: &BTreeSet<String>) {
    let Some(object) = element.as_object_mut() else {
        return;
    };

    for field in ["containerId", "frameId"] {
        repair_id_field(object, field, live_ids);
    }

    if let Some(bindings) = object.get_mut("boundElements") {
        if let Value::Array(bindings) = bindings {
            let mut seen = BTreeSet::new();
            bindings.retain(|binding| {
                binding
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| live_ids.contains(id) && seen.insert(id.to_owned()))
            });
        } else {
            *bindings = Value::Null;
        }
    }

    let is_arrow = object.get("type").and_then(Value::as_str) == Some("arrow");
    for field in ["startBinding", "endBinding"] {
        if (!is_arrow || !valid_binding(object.get(field), live_ids)) && object.contains_key(field)
        {
            object.insert(field.to_owned(), Value::Null);
        }
    }

    if matches!(
        object.get("type").and_then(Value::as_str),
        Some("arrow" | "line")
    ) {
        object.insert("lastCommittedPoint".to_owned(), Value::Null);
    }

    if object.get("type").and_then(Value::as_str) == Some("image") {
        let valid_file = object
            .get("fileId")
            .and_then(Value::as_str)
            .is_some_and(|id| asset_ids.contains(id));
        if !valid_file {
            object.insert("fileId".to_owned(), Value::Null);
        }
    }
}

fn repair_id_field(object: &mut Map<String, Value>, field: &str, live_ids: &BTreeSet<String>) {
    if object.contains_key(field)
        && !object
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|id| live_ids.contains(id))
    {
        object.insert(field.to_owned(), Value::Null);
    }
}

fn valid_binding(binding: Option<&Value>, live_ids: &BTreeSet<String>) -> bool {
    binding
        .and_then(|value| value.get("elementId"))
        .and_then(Value::as_str)
        .is_some_and(|id| live_ids.contains(id))
}

fn compare_elements(left: &Value, right: &Value) -> Ordering {
    let left_index = left.get("index");
    let right_index = right.get("index");
    compare_index(left_index, right_index).then_with(|| element_id(left).cmp(element_id(right)))
}

fn compare_index(left: Option<&Value>, right: Option<&Value>) -> Ordering {
    match (index_rank(left), index_rank(right)) {
        ((0, Some(left)), (0, Some(right))) => left.cmp(right),
        ((left, _), (right, _)) => left.cmp(&right),
    }
}

fn index_rank(index: Option<&Value>) -> (u8, Option<&str>) {
    match index {
        Some(Value::String(index)) => (0, Some(index)),
        Some(Value::Null) => (1, None),
        _ => (2, None),
    }
}

fn element_id(element: &Value) -> &str {
    element.get("id").and_then(Value::as_str).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn canonical(value: Value) -> String {
        serde_json::to_string(&value).expect("test JSON serializes")
    }

    fn revision(id: &str, version: u64, nonce: u64, mut extra: Map<String, Value>) -> String {
        extra.insert("id".to_owned(), json!(id));
        extra
            .entry("isDeleted".to_owned())
            .or_insert(Value::Bool(false));
        extra.insert("type".to_owned(), json!("rectangle"));
        extra.insert("version".to_owned(), json!(version));
        extra.insert("versionNonce".to_owned(), json!(nonce));
        canonical(Value::Object(extra))
    }

    fn revision_key(id: &str, version: u64, nonce: u64) -> String {
        canonical(json!([id, version, nonce]))
    }

    #[test]
    fn portable_scene_matches_the_typescript_schema_fixture() {
        let mut revisions = BTreeMap::new();
        revisions.insert(
            revision_key("box", 1, 8),
            revision(
                "box",
                1,
                8,
                Map::from_iter([
                    ("index".to_owned(), Value::Null),
                    ("isDeleted".to_owned(), Value::Bool(false)),
                ]),
            ),
        );
        let app_state = BTreeMap::from([
            (
                "viewBackgroundColor".to_owned(),
                canonical(json!("#ffffff")),
            ),
            ("theme".to_owned(), canonical(json!("dark"))),
        ]);
        let folded = fold_scene(&revisions, &app_state, &BTreeMap::new());

        assert_eq!(
            folded.portable_json().expect("scene serializes"),
            concat!(
                "{\n",
                "  \"type\": \"excalidraw\",\n",
                "  \"version\": 2,\n",
                "  \"source\": \"https://excalidraw.com\",\n",
                "  \"elements\": [\n",
                "    {\n",
                "      \"id\": \"box\",\n",
                "      \"index\": null,\n",
                "      \"isDeleted\": false,\n",
                "      \"type\": \"rectangle\",\n",
                "      \"version\": 1,\n",
                "      \"versionNonce\": 8\n",
                "    }\n",
                "  ],\n",
                "  \"appState\": {\n",
                "    \"viewBackgroundColor\": \"#ffffff\"\n",
                "  },\n",
                "  \"files\": {}\n",
                "}"
            )
        );
    }

    #[test]
    fn fold_is_order_independent_and_uses_version_then_lowest_nonce() {
        let entries = [
            (revision_key("a", 2, 9), revision("a", 2, 9, Map::new())),
            (revision_key("a", 1, 1), revision("a", 1, 1, Map::new())),
            (
                revision_key("a", 2, 3),
                revision(
                    "a",
                    2,
                    3,
                    Map::from_iter([("winner".to_owned(), Value::Bool(true))]),
                ),
            ),
        ];
        let forward = BTreeMap::from(entries.clone());
        let reverse = BTreeMap::from_iter(entries.into_iter().rev());

        let left = fold_scene(&forward, &BTreeMap::new(), &BTreeMap::new());
        let right = fold_scene(&reverse, &BTreeMap::new(), &BTreeMap::new());
        assert_eq!(left, right);
        assert_eq!(left.elements.len(), 1);
        assert_eq!(left.elements[0]["versionNonce"], 3);
        assert_eq!(left.elements[0]["winner"], true);
    }

    #[test]
    fn invalid_and_noncanonical_revision_records_do_not_compete() {
        let valid_key = revision_key("a", 1, 2);
        let valid = revision("a", 1, 2, Map::new());
        let revisions = BTreeMap::from([
            (valid_key, valid),
            ("[ \"a\",2,1]".to_owned(), revision("a", 2, 1, Map::new())),
            (
                revision_key("b", 4, 5),
                revision("other-id", 4, 5, Map::new()),
            ),
            (revision_key("c", 1, 1), "not JSON".to_owned()),
        ]);

        let folded = fold_scene(&revisions, &BTreeMap::new(), &BTreeMap::new());
        assert_eq!(folded.elements.len(), 1);
        assert_eq!(folded.elements[0]["id"], "a");
        assert_eq!(folded.elements[0]["version"], 1);
    }

    #[test]
    fn records_require_native_shapes_and_js_safe_nonnegative_integers() {
        let too_large = MAX_JS_SAFE_INTEGER + 1;
        let revisions = BTreeMap::from([
            (
                canonical(json!(["too-large", too_large, 1])),
                canonical(json!({
                    "id":"too-large",
                    "isDeleted":false,
                    "type":"rectangle",
                    "version":too_large,
                    "versionNonce":1
                })),
            ),
            (
                "[\"negative\",1,-1]".to_owned(),
                canonical(json!({
                    "id":"negative",
                    "isDeleted":false,
                    "type":"rectangle",
                    "version":1,
                    "versionNonce":-1
                })),
            ),
            (
                revision_key("missing-tombstone", 1, 1),
                canonical(json!({
                    "id":"missing-tombstone",
                    "type":"rectangle",
                    "version":1,
                    "versionNonce":1
                })),
            ),
            (
                revision_key("bad-index", 1, 1),
                canonical(json!({
                    "id":"bad-index",
                    "index":42,
                    "isDeleted":false,
                    "type":"rectangle",
                    "version":1,
                    "versionNonce":1
                })),
            ),
        ]);
        let assets = BTreeMap::from([(
            "asset".to_owned(),
            canonical(json!({
                "created": too_large,
                "id":"asset",
                "mimeType":"image/png",
                "ref":"assets/image.png",
                "sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            })),
        )]);

        let folded = fold_scene(&revisions, &BTreeMap::new(), &assets);
        assert!(folded.elements.is_empty());
        assert!(folded.assets.is_empty());
    }

    #[test]
    fn tombstones_and_dangling_references_are_repaired() {
        let live = revision(
            "live",
            1,
            1,
            Map::from_iter([(
                "boundElements".to_owned(),
                json!([
                    {"id":"image","type":"image"},
                    {"id":"gone","type":"arrow"},
                    {"id":"image","type":"image"}
                ]),
            )]),
        );
        let image = canonical(json!({
            "containerId": "gone",
            "fileId": "asset",
            "frameId": "gone",
            "id": "image",
            "isDeleted": false,
            "type": "image",
            "version": 1,
            "versionNonce": 1
        }));
        let arrow = canonical(json!({
            "endBinding": {"elementId":"gone"},
            "id": "arrow",
            "isDeleted": false,
            "startBinding": {"elementId":"live"},
            "type": "arrow",
            "version": 1,
            "versionNonce": 1
        }));
        let gone = canonical(json!({
            "id": "gone",
            "isDeleted": true,
            "type": "rectangle",
            "version": 2,
            "versionNonce": 1
        }));
        let revisions = BTreeMap::from([
            (revision_key("live", 1, 1), live),
            (revision_key("image", 1, 1), image),
            (revision_key("arrow", 1, 1), arrow),
            (revision_key("gone", 2, 1), gone),
        ]);
        let assets = BTreeMap::from([(
            "asset".to_owned(),
            canonical(json!({
                "created": 10,
                "id": "asset",
                "mimeType": "image/png",
                "ref": "assets/image.png",
                "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            })),
        )]);

        let folded = fold_scene(&revisions, &BTreeMap::new(), &assets);
        assert_eq!(folded.elements.len(), 3);
        let live = folded.elements.iter().find(|e| e["id"] == "live").unwrap();
        assert_eq!(
            live["boundElements"],
            json!([{"id":"image","type":"image"}])
        );
        let image = folded.elements.iter().find(|e| e["id"] == "image").unwrap();
        assert_eq!(image["fileId"], "asset");
        assert_eq!(image["containerId"], Value::Null);
        assert_eq!(image["frameId"], Value::Null);
        let arrow = folded.elements.iter().find(|e| e["id"] == "arrow").unwrap();
        assert_eq!(arrow["startBinding"]["elementId"], "live");
        assert_eq!(arrow["endBinding"], Value::Null);
        assert_eq!(arrow["lastCommittedPoint"], Value::Null);
    }

    #[test]
    fn invalid_assets_are_omitted_and_image_file_ids_are_cleared() {
        let revisions = BTreeMap::from([(
            revision_key("image", 1, 1),
            canonical(json!({
                "fileId": "asset",
                "id": "image",
                "isDeleted": false,
                "type": "image",
                "version": 1,
                "versionNonce": 1
            })),
        )]);
        let assets = BTreeMap::from([(
            "asset".to_owned(),
            canonical(json!({
                "created": 10,
                "dataURL": "data:image/png;base64,AA==",
                "id": "asset",
                "mimeType": "image/png",
                "ref": "../outside.png",
                "sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            })),
        )]);

        let folded = fold_scene(&revisions, &BTreeMap::new(), &assets);
        assert!(folded.assets.is_empty());
        assert_eq!(folded.elements[0]["fileId"], Value::Null);
        assert_eq!(
            folded.portable_json().unwrap().matches("\"files\"").count(),
            1
        );
    }

    #[test]
    fn element_order_uses_unicode_scalar_values_not_utf16_code_units() {
        let bmp = "\u{e000}";
        let astral = "\u{10000}";
        let revisions = BTreeMap::from([
            (
                revision_key("astral", 1, 1),
                revision(
                    "astral",
                    1,
                    1,
                    Map::from_iter([("index".to_owned(), json!(astral))]),
                ),
            ),
            (
                revision_key("bmp", 1, 1),
                revision(
                    "bmp",
                    1,
                    1,
                    Map::from_iter([("index".to_owned(), json!(bmp))]),
                ),
            ),
        ]);

        let folded = fold_scene(&revisions, &BTreeMap::new(), &BTreeMap::new());
        assert_eq!(folded.elements[0]["id"], "bmp");
        assert_eq!(folded.elements[1]["id"], "astral");
    }

    #[test]
    fn native_import_returns_a_declared_root_update_and_embedded_file() {
        let bytes = vec![0x5a; 49 * 1024];
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        );
        let content = serde_json::to_string_pretty(&json!({
            "appState": {
                "gridModeEnabled": false,
                "gridSize": 20,
                "gridStep": 5,
                "viewBackgroundColor": "#ffffff"
            },
            "elements": [{
                "fileId": "file",
                "id": "image",
                "index": "a0",
                "isDeleted": false,
                "type": "image",
                "version": 1,
                "versionNonce": 2
            }],
            "files": {
                "file": {
                    "created": 100,
                    "dataURL": data_url,
                    "id": "file",
                    "lastRetrieved": 200,
                    "mimeType": "image/png",
                    "version": 3
                }
            },
            "source": "https://excalidraw.com",
            "type": "excalidraw",
            "version": 2
        }))
        .expect("native scene JSON");

        let imported = import_portable_scene(&content).expect("native scene imports");
        assert_eq!(imported.files["file"].bytes, bytes);
        assert_eq!(imported.files["file"].mime_type, "image/png");
        assert_eq!(imported.files["file"].last_retrieved, Some(200));

        let doc = crate::Ydoc::wire();
        doc.apply(&imported.initial_update).expect("initial update");
        let canonical = doc.canonical_content();
        assert_eq!(canonical[crate::ROOT_SCENE_REVISIONS]["type"], "map");
        assert_eq!(canonical[crate::ROOT_SCENE_APP_STATE]["type"], "map");
        assert_eq!(doc.fold_scene().elements[0]["id"], "image");
    }

    #[test]
    fn native_import_rejects_non_native_top_level_and_missing_image_bytes() {
        let extra = json!({
            "appState": {},
            "elements": [],
            "extra": true,
            "files": {},
            "source": "https://excalidraw.com",
            "type": "excalidraw",
            "version": 2
        });
        assert!(matches!(
            import_portable_scene(&canonical(extra)),
            Err(SceneImportError::Invalid { .. })
        ));

        let missing = json!({
            "appState": {},
            "elements": [{
                "fileId":"missing",
                "id":"image",
                "isDeleted":false,
                "type":"image",
                "version":1,
                "versionNonce":1
            }],
            "files": {},
            "source": "https://excalidraw.com",
            "type": "excalidraw",
            "version": 2
        });
        assert!(matches!(
            import_portable_scene(&canonical(missing)),
            Err(SceneImportError::Invalid { .. })
        ));
    }

    #[test]
    fn durable_asset_encoder_requires_ref_and_sha_authority() {
        let records = BTreeMap::from([(
            "file".to_owned(),
            canonical(json!({
                "created":100,
                "id":"file",
                "mimeType":"image/png",
                "ref":"assets/file.png",
                "sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            })),
        )]);
        let update = encode_scene_asset_records(&records).expect("valid asset record");
        let doc = crate::Ydoc::wire();
        doc.apply(&update).expect("asset update");
        assert_eq!(doc.fold_scene().assets["file"].path, "assets/file.png");

        let invalid = BTreeMap::from([(
            "file".to_owned(),
            canonical(json!({
                "created":100,
                "id":"file",
                "mimeType":"image/png",
                "ref":"assets/file.png"
            })),
        )]);
        assert!(encode_scene_asset_records(&invalid).is_err());
    }
}
