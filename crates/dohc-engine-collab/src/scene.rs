//! The bundled Excalidraw scene codec.
//!
//! The live schema stores immutable element revisions and small scene metadata
//! as canonical JSON strings. This module owns that format-specific schema and
//! folds it into Excalidraw's portable JSON shape. Asset bytes are hydrated by
//! the runtime after this pure fold; this codec only validates their durable
//! workspace references.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Write};

use base64::Engine as _;
use serde::ser::{SerializeMap, Serializer};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::canonical_json::canonical_json_string;
use crate::error::CollabError;
use crate::limits::MAX_PROJECTION_BYTES;

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
struct PortableScene<'a, F> {
    #[serde(rename = "type")]
    kind: &'static str,
    version: u8,
    source: &'static str,
    elements: &'a [Value],
    #[serde(rename = "appState")]
    app_state: &'a BTreeMap<String, Value>,
    files: F,
}

struct PortableFileSource<'a> {
    asset: &'a SceneAsset,
    bytes: &'a [u8],
    data_url_len: usize,
}

struct PortableFiles<'a> {
    files: Vec<PortableFileSource<'a>>,
}

#[derive(Serialize)]
struct PortableFile<'a> {
    created: u64,
    #[serde(rename = "dataURL")]
    data_url: String,
    id: &'a str,
    #[serde(rename = "lastRetrieved", skip_serializing_if = "Option::is_none")]
    last_retrieved: Option<u64>,
    #[serde(rename = "mimeType")]
    mime_type: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<u64>,
}

impl Serialize for PortableFiles<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(self.files.len()))?;
        for source in &self.files {
            // Encode one provider file at a time. The bounded output writer
            // owns the aggregate projection; this temporary never exceeds the
            // same projection cap and is dropped before the next file.
            let mut data_url = String::with_capacity(source.data_url_len);
            data_url.push_str("data:");
            data_url.push_str(&source.asset.mime_type);
            data_url.push_str(";base64,");
            base64::engine::general_purpose::STANDARD.encode_string(source.bytes, &mut data_url);
            map.serialize_entry(
                &source.asset.id,
                &PortableFile {
                    created: source.asset.created,
                    data_url,
                    id: &source.asset.id,
                    last_retrieved: source.asset.last_retrieved,
                    mime_type: &source.asset.mime_type,
                    version: source.asset.version,
                },
            )?;
        }
        map.end()
    }
}

struct ProjectionWriter {
    bytes: Vec<u8>,
    overflow: Option<usize>,
}

impl ProjectionWriter {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            overflow: None,
        }
    }
}

impl Write for ProjectionWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let attempted = self.bytes.len().saturating_add(buffer.len());
        if attempted > MAX_PROJECTION_BYTES {
            self.overflow = Some(attempted);
            return Err(io::Error::other("scene projection exceeded its byte cap"));
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn bounded_portable_json(value: &impl Serialize) -> Result<String, CollabError> {
    let mut writer = ProjectionWriter::new();
    if let Err(error) = serde_json::to_writer_pretty(&mut writer, value) {
        if let Some(actual) = writer.overflow {
            return Err(CollabError::ProjectionTooLarge {
                actual,
                max: MAX_PROJECTION_BYTES,
            });
        }
        return Err(CollabError::Corrupt {
            reason: format!("scene projection serialization failed: {error}"),
        });
    }
    String::from_utf8(writer.bytes).map_err(|error| CollabError::Corrupt {
        reason: format!("scene projection serialization produced invalid UTF-8: {error}"),
    })
}

/// The exact native data-URL length for one hydrated scene asset. This checks
/// arithmetic and the existing projection cap before base64 allocates.
pub fn scene_data_url_len(mime_type: &str, byte_length: usize) -> Result<usize, CollabError> {
    let encoded = byte_length
        .checked_add(2)
        .and_then(|value| value.checked_div(3))
        .and_then(|value| value.checked_mul(4))
        .ok_or(CollabError::ProjectionTooLarge {
            actual: usize::MAX,
            max: MAX_PROJECTION_BYTES,
        })?;
    let actual = "data:"
        .len()
        .checked_add(mime_type.len())
        .and_then(|value| value.checked_add(";base64,".len()))
        .and_then(|value| value.checked_add(encoded))
        .ok_or(CollabError::ProjectionTooLarge {
            actual: usize::MAX,
            max: MAX_PROJECTION_BYTES,
        })?;
    if actual > MAX_PROJECTION_BYTES {
        return Err(CollabError::ProjectionTooLarge {
            actual,
            max: MAX_PROJECTION_BYTES,
        });
    }
    Ok(actual)
}

impl FoldedScene {
    /// Emit native portable Excalidraw JSON without asset bytes. The runtime
    /// replaces `files` after it resolves the validated asset records. The
    /// two-space layout matches Excalidraw's native JSON export; durable map
    /// records and fingerprints remain compact canonical JSON.
    pub fn portable_json(&self) -> Result<String, CollabError> {
        bounded_portable_json(&PortableScene {
            kind: "excalidraw",
            version: EXPORT_VERSION,
            source: EXPORT_SOURCE,
            elements: &self.elements,
            app_state: &self.app_state,
            files: BTreeMap::<String, Value>::new(),
        })
    }

    /// Emit native portable JSON with bytes for exactly the live image assets.
    pub fn portable_json_with_asset_bytes(
        &self,
        bytes_by_id: &BTreeMap<String, Vec<u8>>,
    ) -> Result<String, CollabError> {
        let referenced: BTreeSet<&str> = self
            .elements
            .iter()
            .filter(|element| element.get("type").and_then(Value::as_str) == Some("image"))
            .filter_map(|element| element.get("fileId").and_then(Value::as_str))
            .collect();
        let mut files = Vec::with_capacity(referenced.len());
        for id in referenced {
            let asset = self.assets.get(id).ok_or(CollabError::Corrupt {
                reason: "a live image references a missing asset record".to_owned(),
            })?;
            let bytes = bytes_by_id.get(id).ok_or(CollabError::Corrupt {
                reason: "a live image asset has no resolved bytes".to_owned(),
            })?;
            files.push(PortableFileSource {
                asset,
                bytes,
                data_url_len: scene_data_url_len(&asset.mime_type, bytes.len())?,
            });
        }
        bounded_portable_json(&PortableScene {
            kind: "excalidraw",
            version: EXPORT_VERSION,
            source: EXPORT_SOURCE,
            elements: &self.elements,
            app_state: &self.app_state,
            files: PortableFiles { files },
        })
    }
}

const SCENE_ASSET_FORMATS: [(&str, &str); 10] = [
    ("image/svg+xml", "svg"),
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
    ("image/bmp", "bmp"),
    ("image/x-icon", "ico"),
    ("image/avif", "avif"),
    ("image/jfif", "jfif"),
    ("application/octet-stream", "bin"),
];

pub fn scene_asset_extension(mime_type: &str) -> Result<&'static str, SceneImportError> {
    // BinaryFileData's validated MIME owns the native dataURL and canonical
    // extension; SHA-256 authenticates the exact bytes. The engine does not
    // sniff or transform provider-owned image formats.
    SCENE_ASSET_FORMATS
        .iter()
        .find_map(|(mime, extension)| (*mime == mime_type).then_some(*extension))
        .ok_or(SceneImportError::Invalid {
            reason: "an Excalidraw asset has an unsupported MIME type",
        })
}

pub fn scene_asset_ref_is_owned(owner_directory: &str, path: &str, sha256: &str) -> bool {
    let Some(file_name) = path
        .strip_prefix(owner_directory)
        .and_then(|tail| tail.strip_prefix('/'))
    else {
        return false;
    };
    !file_name.contains('/')
        && SCENE_ASSET_FORMATS
            .iter()
            .any(|(_, extension)| file_name == format!("{sha256}.{extension}"))
}

pub fn scene_asset_ref(
    workspace_id: &str,
    version_id: &str,
    drawing_object_id: &str,
    sha256: &str,
    mime_type: &str,
) -> Result<String, SceneImportError> {
    if workspace_id.is_empty()
        || version_id.is_empty()
        || drawing_object_id.is_empty()
        || sha256.len() != 64
        || !sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(SceneImportError::Invalid {
            reason: "a scene asset SHA-256 is invalid",
        });
    }
    let owner_directory = scene_asset_directory(workspace_id, version_id, drawing_object_id)?;
    Ok(format!(
        "{owner_directory}/{}.{}",
        sha256,
        scene_asset_extension(mime_type)?
    ))
}

pub fn scene_asset_directory(
    workspace_id: &str,
    version_id: &str,
    drawing_object_id: &str,
) -> Result<String, SceneImportError> {
    if workspace_id.is_empty() || version_id.is_empty() || drawing_object_id.is_empty() {
        return Err(SceneImportError::Invalid {
            reason: "scene asset ownership coordinates must not be empty",
        });
    }
    let mut owner = b"dohc:excalidraw-asset-owner:v1\0".to_vec();
    for field in [workspace_id, version_id, drawing_object_id] {
        owner.extend_from_slice(&(field.len() as u64).to_be_bytes());
        owner.extend_from_slice(field.as_bytes());
    }
    Ok(format!(
        "assets/excalidraw/{}",
        dohc_engine_storage::hex_sha256(&owner)
    ))
}

/// Parse an Excalidraw artifact into the live scene roots and decode its
/// embedded files. Native export emits the exact v2 shape, but Excalidraw's
/// external-file reader accepts legacy documents with optional metadata and
/// missing/null scene collections. This function matches that import floor;
/// it does not choose workspace paths or write storage.
pub fn import_portable_scene(content: &str) -> Result<ImportedScene, SceneImportError> {
    let value: Value = serde_json::from_str(content).map_err(|_| SceneImportError::Invalid {
        reason: "content must be JSON",
    })?;
    let object = value.as_object().ok_or(SceneImportError::Invalid {
        reason: "top level must be an object",
    })?;
    if object.get("type").and_then(Value::as_str) != Some("excalidraw") {
        return Err(SceneImportError::Invalid {
            reason: "type must be excalidraw",
        });
    }

    let empty_elements = Vec::new();
    let element_values = match object.get("elements") {
        None | Some(Value::Null) => &empty_elements,
        Some(Value::Array(elements)) => elements,
        Some(_) => {
            return Err(SceneImportError::Invalid {
                reason: "elements must be an array or null",
            });
        }
    };
    let mut elements = Vec::with_capacity(element_values.len());
    let mut element_keys = Vec::with_capacity(element_values.len());
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
        elements.push(element.clone());
        element_keys.push(key);
    }
    repair_imported_element_indices(&mut elements)?;

    let mut revisions = BTreeMap::new();
    let mut image_file_ids = BTreeSet::new();
    for (element, key) in elements.iter().zip(element_keys) {
        let revision_key =
            canonical_json_string(&json_revision_key(&key)).ok_or(SceneImportError::Invalid {
                reason: "an element revision key could not be encoded",
            })?;
        let snapshot = canonical_json_string(element).ok_or(SceneImportError::Invalid {
            reason: "an element snapshot could not be encoded",
        })?;
        if revisions.insert(revision_key, snapshot).is_some() {
            return Err(SceneImportError::Invalid {
                reason: "element revision tuples must be unique",
            });
        }
        if element.get("type").and_then(Value::as_str) == Some("image")
            && element.get("isDeleted").and_then(Value::as_bool) == Some(false)
        {
            if let Some(file_id) = element.get("fileId").and_then(Value::as_str) {
                image_file_ids.insert(file_id.to_owned());
            }
        }
    }

    let empty_object = Map::new();
    let app_state_object = match object.get("appState") {
        None | Some(Value::Null) => &empty_object,
        Some(Value::Object(app_state)) => app_state,
        Some(_) => {
            return Err(SceneImportError::Invalid {
                reason: "appState must be an object or null",
            });
        }
    };
    let exported_app_state = app_state_object
        .iter()
        .filter(|(key, _)| EXPORTED_APP_STATE_KEYS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<Map<_, _>>();
    validate_app_state(&exported_app_state)?;
    let app_state: BTreeMap<String, String> = app_state_object
        .iter()
        .filter(|(key, _)| EXPORTED_APP_STATE_KEYS.contains(&key.as_str()))
        .map(|(key, value)| {
            canonical_json_string(value)
                .map(|value| (key.clone(), value))
                .ok_or(SceneImportError::Invalid {
                    reason: "an appState property could not be encoded",
                })
        })
        .collect::<Result<_, _>>()?;

    let files_object = match object.get("files") {
        None | Some(Value::Null) => &empty_object,
        Some(Value::Object(files)) => files,
        Some(_) => {
            return Err(SceneImportError::Invalid {
                reason: "files must be an object or null",
            });
        }
    };
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

fn repair_imported_element_indices(elements: &mut [Value]) -> Result<(), SceneImportError> {
    // Excalidraw v0.18 restores the source array, keeps valid indices as
    // anchors, and repairs each invalid run before any index-based ordering.
    // Do the same while the portable array still exists. The revision Y.Map
    // cannot recover that source order after the seed is encoded. This is seed
    // normalization, not an edit to an existing revision, so the source
    // version and nonce remain its initial identity.
    let indices = elements
        .iter()
        .map(|element| {
            element
                .get("index")
                .and_then(Value::as_str)
                .filter(|index| !index.is_empty())
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    for group in invalid_index_groups(&indices) {
        let lower = group.lower.and_then(|index| indices[index].as_deref());
        let upper = group
            .upper
            .filter(|index| *index < indices.len())
            .and_then(|index| indices[index].as_deref());
        let repaired =
            generate_n_keys_between(lower, upper, group.elements.len()).map_err(|()| {
                SceneImportError::Invalid {
                    reason: "element indices cannot be repaired in source order",
                }
            })?;
        for (element_index, repaired_index) in group.elements.into_iter().zip(repaired) {
            elements[element_index]
                .as_object_mut()
                .ok_or(SceneImportError::Invalid {
                    reason: "each element must be an object",
                })?
                .insert("index".to_owned(), Value::String(repaired_index));
        }
    }
    Ok(())
}

struct InvalidIndexGroup {
    lower: Option<usize>,
    elements: Vec<usize>,
    upper: Option<usize>,
}

fn invalid_index_groups(indices: &[Option<String>]) -> Vec<InvalidIndexGroup> {
    let mut groups = Vec::new();
    let mut lower_bound = None;
    let mut upper_bound = Some(0);
    let mut index = 0;

    while index < indices.len() {
        lower_bound = imported_index_lower_bound(indices, lower_bound, index);
        upper_bound = imported_index_upper_bound(indices, upper_bound, index);
        if imported_index_is_valid(
            indices[index].as_deref(),
            lower_bound.and_then(|bound| indices[bound].as_deref()),
            upper_bound
                .filter(|bound| *bound < indices.len())
                .and_then(|bound| indices[bound].as_deref()),
        ) {
            index += 1;
            continue;
        }

        let mut elements = vec![index];
        index += 1;
        while index < indices.len() {
            let next_lower = imported_index_lower_bound(indices, lower_bound, index);
            let next_upper = imported_index_upper_bound(indices, upper_bound, index);
            if imported_index_is_valid(
                indices[index].as_deref(),
                next_lower.and_then(|bound| indices[bound].as_deref()),
                next_upper
                    .filter(|bound| *bound < indices.len())
                    .and_then(|bound| indices[bound].as_deref()),
            ) {
                break;
            }
            lower_bound = next_lower;
            upper_bound = next_upper;
            elements.push(index);
            index += 1;
        }
        groups.push(InvalidIndexGroup {
            lower: lower_bound,
            elements,
            upper: upper_bound,
        });
    }
    groups
}

fn imported_index_lower_bound(
    indices: &[Option<String>],
    cached: Option<usize>,
    index: usize,
) -> Option<usize> {
    let cached_value = cached.and_then(|bound| indices[bound].as_deref());
    let candidate = index
        .checked_sub(1)
        .and_then(|bound| indices[bound].as_deref());
    match (cached_value, candidate) {
        (None, Some(_)) => index.checked_sub(1),
        (Some(lower), Some(candidate)) if candidate > lower => index.checked_sub(1),
        _ => cached,
    }
}

fn imported_index_upper_bound(
    indices: &[Option<String>],
    cached: Option<usize>,
    index: usize,
) -> Option<usize> {
    let cached_index = cached.unwrap_or(indices.len());
    let cached_value = cached
        .filter(|bound| *bound < indices.len())
        .and_then(|bound| indices[bound].as_deref());
    if cached_value.is_some() && index < cached_index {
        return cached;
    }
    ((cached_index + 1)..indices.len()).find(|candidate_index| {
        let candidate = indices[*candidate_index].as_deref();
        matches!(
            (cached_value, candidate),
            (None, Some(_)) | (Some(_), Some(_))
        ) && cached_value
            .zip(candidate)
            .is_none_or(|(upper, candidate)| candidate > upper)
    })
}

fn imported_index_is_valid(
    current: Option<&str>,
    predecessor: Option<&str>,
    successor: Option<&str>,
) -> bool {
    let Some(current) = current else {
        return false;
    };
    match (predecessor, successor) {
        (Some(predecessor), Some(successor)) => predecessor < current && current < successor,
        (None, Some(successor)) => current < successor,
        (Some(predecessor), None) => predecessor < current,
        (None, None) => true,
    }
}

const FRACTIONAL_INDEX_DIGITS: &[u8] =
    b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Ported from fractional-indexing 3.2.0 at commit 9e55f979 (CC0). Excalidraw
// v0.18 pins that package, so a different fractional key format is not valid.
fn generate_n_keys_between(
    lower: Option<&str>,
    upper: Option<&str>,
    count: usize,
) -> Result<Vec<String>, ()> {
    if count == 0 {
        return Ok(Vec::new());
    }
    if count == 1 {
        return Ok(vec![generate_key_between(lower, upper)?]);
    }
    if upper.is_none() {
        let mut key = generate_key_between(lower, None)?;
        let mut keys = vec![key.clone()];
        for _ in 1..count {
            key = generate_key_between(Some(&key), None)?;
            keys.push(key.clone());
        }
        return Ok(keys);
    }
    if lower.is_none() {
        let mut key = generate_key_between(None, upper)?;
        let mut keys = vec![key.clone()];
        for _ in 1..count {
            key = generate_key_between(None, Some(&key))?;
            keys.push(key.clone());
        }
        keys.reverse();
        return Ok(keys);
    }

    let middle = count / 2;
    let key = generate_key_between(lower, upper)?;
    let mut keys = generate_n_keys_between(lower, Some(&key), middle)?;
    keys.push(key.clone());
    keys.extend(generate_n_keys_between(
        Some(&key),
        upper,
        count - middle - 1,
    )?);
    Ok(keys)
}

fn generate_key_between(lower: Option<&str>, upper: Option<&str>) -> Result<String, ()> {
    if let Some(lower) = lower {
        validate_order_key(lower)?;
    }
    if let Some(upper) = upper {
        validate_order_key(upper)?;
    }
    if lower
        .zip(upper)
        .is_some_and(|(lower, upper)| lower >= upper)
    {
        return Err(());
    }

    let Some(lower) = lower else {
        let Some(upper) = upper else {
            return Ok("a0".to_owned());
        };
        let upper_integer = integer_part(upper)?;
        let upper_fraction = &upper[upper_integer.len()..];
        if upper_integer == format!("A{}", "0".repeat(26)) {
            return Ok(format!(
                "{upper_integer}{}",
                fractional_midpoint("", Some(upper_fraction))?
            ));
        }
        if upper_integer < upper {
            return Ok(upper_integer.to_owned());
        }
        return decrement_integer(upper_integer);
    };

    let Some(upper) = upper else {
        let lower_integer = integer_part(lower)?;
        let lower_fraction = &lower[lower_integer.len()..];
        return match increment_integer(lower_integer)? {
            Some(integer) => Ok(integer),
            None => Ok(format!(
                "{lower_integer}{}",
                fractional_midpoint(lower_fraction, None)?
            )),
        };
    };

    let lower_integer = integer_part(lower)?;
    let lower_fraction = &lower[lower_integer.len()..];
    let upper_integer = integer_part(upper)?;
    let upper_fraction = &upper[upper_integer.len()..];
    if lower_integer == upper_integer {
        return Ok(format!(
            "{lower_integer}{}",
            fractional_midpoint(lower_fraction, Some(upper_fraction))?
        ));
    }
    let incremented = increment_integer(lower_integer)?.ok_or(())?;
    if incremented.as_str() < upper {
        Ok(incremented)
    } else {
        Ok(format!(
            "{lower_integer}{}",
            fractional_midpoint(lower_fraction, None)?
        ))
    }
}

fn fractional_midpoint(lower: &str, upper: Option<&str>) -> Result<String, ()> {
    if upper.is_some_and(|upper| lower >= upper)
        || lower.ends_with('0')
        || upper.is_some_and(|upper| upper.ends_with('0'))
    {
        return Err(());
    }
    if let Some(upper) = upper {
        let lower_bytes = lower.as_bytes();
        let upper_bytes = upper.as_bytes();
        let mut prefix = 0;
        while prefix < upper_bytes.len()
            && lower_bytes.get(prefix).copied().unwrap_or(b'0') == upper_bytes[prefix]
        {
            prefix += 1;
        }
        if prefix > 0 {
            return Ok(format!(
                "{}{}",
                &upper[..prefix],
                fractional_midpoint(&lower[prefix.min(lower.len())..], Some(&upper[prefix..]))?
            ));
        }
    }

    let lower_digit = lower
        .as_bytes()
        .first()
        .map_or(Some(0), |byte| fractional_digit(*byte))
        .ok_or(())?;
    let upper_digit = match upper.and_then(|upper| upper.as_bytes().first().copied()) {
        Some(byte) => fractional_digit(byte).ok_or(())?,
        None => FRACTIONAL_INDEX_DIGITS.len(),
    };
    if upper_digit > lower_digit + 1 {
        let middle = (lower_digit + upper_digit).div_ceil(2);
        return Ok(char::from(FRACTIONAL_INDEX_DIGITS[middle]).to_string());
    }
    if let Some(upper) = upper {
        if upper.len() > 1 {
            return Ok(upper[..1].to_owned());
        }
    }
    let head = char::from(FRACTIONAL_INDEX_DIGITS[lower_digit]);
    Ok(format!(
        "{head}{}",
        fractional_midpoint(lower.get(1..).unwrap_or(""), None)?
    ))
}

fn fractional_digit(byte: u8) -> Option<usize> {
    FRACTIONAL_INDEX_DIGITS
        .iter()
        .position(|candidate| *candidate == byte)
}

fn integer_part(key: &str) -> Result<&str, ()> {
    let length = integer_length(*key.as_bytes().first().ok_or(())?)?;
    key.get(..length).ok_or(())
}

fn integer_length(head: u8) -> Result<usize, ()> {
    match head {
        b'a'..=b'z' => Ok(usize::from(head - b'a') + 2),
        b'A'..=b'Z' => Ok(usize::from(b'Z' - head) + 2),
        _ => Err(()),
    }
}

fn validate_order_key(key: &str) -> Result<(), ()> {
    if key == format!("A{}", "0".repeat(26)) {
        return Err(());
    }
    let integer = integer_part(key)?;
    validate_integer(integer)?;
    if key[integer.len()..].ends_with('0')
        || !key[integer.len()..]
            .bytes()
            .all(|byte| fractional_digit(byte).is_some())
    {
        return Err(());
    }
    Ok(())
}

fn validate_integer(integer: &str) -> Result<(), ()> {
    if integer.len() == integer_length(*integer.as_bytes().first().ok_or(())?)?
        && integer[1..]
            .bytes()
            .all(|byte| fractional_digit(byte).is_some())
    {
        Ok(())
    } else {
        Err(())
    }
}

fn increment_integer(integer: &str) -> Result<Option<String>, ()> {
    validate_integer(integer)?;
    let mut bytes = integer.as_bytes().to_vec();
    let head = bytes[0];
    let mut carry = true;
    for byte in bytes[1..].iter_mut().rev() {
        if !carry {
            break;
        }
        let digit = fractional_digit(*byte).ok_or(())? + 1;
        if digit == FRACTIONAL_INDEX_DIGITS.len() {
            *byte = FRACTIONAL_INDEX_DIGITS[0];
        } else {
            *byte = FRACTIONAL_INDEX_DIGITS[digit];
            carry = false;
        }
    }
    if carry {
        if head == b'Z' {
            return Ok(Some("a0".to_owned()));
        }
        if head == b'z' {
            return Ok(None);
        }
        bytes[0] += 1;
        if bytes[0] > b'a' {
            bytes.push(b'0');
        } else {
            bytes.pop();
        }
    }
    String::from_utf8(bytes).map(Some).map_err(|_| ())
}

fn decrement_integer(integer: &str) -> Result<String, ()> {
    validate_integer(integer)?;
    let mut bytes = integer.as_bytes().to_vec();
    let head = bytes[0];
    let mut borrow = true;
    for byte in bytes[1..].iter_mut().rev() {
        if !borrow {
            break;
        }
        let digit = fractional_digit(*byte).ok_or(())?;
        if digit == 0 {
            *byte = *FRACTIONAL_INDEX_DIGITS.last().ok_or(())?;
        } else {
            *byte = FRACTIONAL_INDEX_DIGITS[digit - 1];
            borrow = false;
        }
    }
    if borrow {
        if head == b'a' {
            return Ok(format!(
                "Z{}",
                char::from(*FRACTIONAL_INDEX_DIGITS.last().ok_or(())?)
            ));
        }
        if head == b'A' {
            return Err(());
        }
        bytes[0] -= 1;
        if bytes[0] < b'Z' {
            bytes.push(*FRACTIONAL_INDEX_DIGITS.last().ok_or(())?);
        } else {
            bytes.pop();
        }
    }
    String::from_utf8(bytes).map_err(|_| ())
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
        if !valid_app_state_property(key, value) {
            return Err(SceneImportError::Invalid {
                reason: "an appState property has an invalid native value",
            });
        }
    }
    Ok(())
}

fn valid_app_state_property(key: &str, value: &Value) -> bool {
    match key {
        "gridModeEnabled" => value.is_boolean(),
        "gridSize" | "gridStep" => value.is_null() || value.as_f64().is_some(),
        "viewBackgroundColor" => value.as_str().is_some_and(|color| !color.is_empty()),
        _ => false,
    }
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
        .filter_map(|key| {
            let value = canonical_json(app_state.get(key)?)?;
            valid_app_state_property(key, &value).then(|| (key.to_owned(), value))
        })
        .collect();

    FoldedScene {
        elements,
        app_state,
        assets,
    }
}

fn canonical_json(raw: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(raw).ok()?;
    (canonical_json_string(&value)?.as_str() == raw).then_some(value)
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
        canonical_json_string(&value).expect("test JSON serializes")
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
    fn scene_roots_match_the_typescript_contract() {
        assert_eq!(crate::ROOT_SCENE_REVISIONS, "excalidraw:revisions");
        assert_eq!(crate::ROOT_SCENE_APP_STATE, "excalidraw:app-state");
        assert_eq!(crate::ROOT_SCENE_ASSETS, "excalidraw:assets");
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
    fn noncanonical_numbers_and_invalid_unicode_are_skipped_per_record() {
        let revisions = BTreeMap::from([
            (
                revision_key("valid", 1, 1),
                revision(
                    "valid",
                    1,
                    1,
                    Map::from_iter([("x".to_owned(), json!(1e20))]),
                ),
            ),
            (
                revision_key("noncanonical", 1, 1),
                r#"{"id":"noncanonical","isDeleted":false,"type":"rectangle","version":1,"versionNonce":1,"x":1e20}"#
                    .to_owned(),
            ),
            (
                revision_key("negative-zero", 1, 1),
                r#"{"id":"negative-zero","isDeleted":false,"type":"rectangle","version":1,"versionNonce":1,"x":-0}"#
                    .to_owned(),
            ),
            (
                revision_key("surrogate", 1, 1),
                r#"{"id":"surrogate","isDeleted":false,"text":"\ud800","type":"text","version":1,"versionNonce":1}"#
                    .to_owned(),
            ),
        ]);

        let folded = fold_scene(&revisions, &BTreeMap::new(), &BTreeMap::new());
        assert_eq!(folded.elements.len(), 1);
        assert_eq!(folded.elements[0]["id"], "valid");
    }

    #[test]
    fn fold_keeps_only_valid_durable_app_state() {
        let app_state = BTreeMap::from([
            ("gridModeEnabled".to_owned(), canonical(json!(false))),
            ("gridSize".to_owned(), canonical(Value::Null)),
            ("gridStep".to_owned(), canonical(json!("five"))),
            ("viewBackgroundColor".to_owned(), canonical(json!(""))),
            ("scrollX".to_owned(), canonical(json!(20))),
        ]);

        assert_eq!(
            fold_scene(&BTreeMap::new(), &app_state, &BTreeMap::new()).app_state,
            BTreeMap::from([
                ("gridModeEnabled".to_owned(), Value::Bool(false)),
                ("gridSize".to_owned(), Value::Null),
            ])
        );
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
    fn native_import_writes_javascript_canonical_numbers() {
        let content = r##"{
          "type":"excalidraw",
          "version":2,
          "source":"https://excalidraw.com",
          "elements":[{
            "id":"shape",
            "type":"rectangle",
            "version":1,
            "versionNonce":2,
            "isDeleted":false,
            "x":1e20,
            "y":-0,
            "angle":1e-7
          }],
          "appState":{"gridSize":1e20},
          "files":{}
        }"##;

        let imported = import_portable_scene(content).expect("native scene imports");
        let doc = crate::Ydoc::wire();
        doc.apply(&imported.initial_update).expect("initial update");
        let folded = doc.fold_scene();
        assert_eq!(folded.elements[0]["x"], json!(1e20));
        assert_eq!(folded.elements[0]["y"], json!(0));
        assert_eq!(folded.elements[0]["angle"], json!(1e-7));
        assert_eq!(folded.app_state["gridSize"], json!(1e20));
    }

    #[test]
    fn native_import_repairs_invalid_indices_in_source_order() {
        let element = |id: &str, index: Option<Value>| {
            let mut element = Map::from_iter([
                ("id".to_owned(), json!(id)),
                ("isDeleted".to_owned(), json!(false)),
                ("type".to_owned(), json!("rectangle")),
                ("version".to_owned(), json!(1)),
                ("versionNonce".to_owned(), json!(1)),
            ]);
            if let Some(index) = index {
                element.insert("index".to_owned(), index);
            }
            Value::Object(element)
        };
        let source_order = [
            "z-missing",
            "z-null",
            "z-duplicate",
            "a-duplicate",
            "later-lower",
            "last",
        ];
        let content = canonical(json!({
            "type":"excalidraw",
            "elements":[
                element(source_order[0], None),
                element(source_order[1], Some(Value::Null)),
                element(source_order[2], Some(json!("a1"))),
                element(source_order[3], Some(json!("a1"))),
                element(source_order[4], Some(json!("a0"))),
                element(source_order[5], Some(json!("a2")))
            ]
        }));

        let imported = import_portable_scene(&content).expect("legacy indices repair");
        let doc = crate::Ydoc::wire();
        doc.apply(&imported.initial_update).expect("initial update");
        let folded = doc.fold_scene();
        assert_eq!(
            folded
                .elements
                .iter()
                .filter_map(|element| element["id"].as_str())
                .collect::<Vec<_>>(),
            source_order
        );
        assert_eq!(
            folded
                .elements
                .iter()
                .filter_map(|element| element["index"].as_str())
                .collect::<Vec<_>>(),
            ["Zz", "a0", "a1", "a1G", "a1V", "a2"]
        );
        assert_eq!(
            generate_n_keys_between(None, Some("a0"), 5).expect("keys before a0"),
            ["Zv", "Zw", "Zx", "Zy", "Zz"]
        );
        assert_eq!(
            generate_n_keys_between(Some("Zz"), Some("a01"), 4)
                .expect("keys across integer boundary"),
            ["ZzG", "ZzV", "a0", "a00V"]
        );
    }

    #[test]
    fn native_import_accepts_the_upstream_external_file_floor() {
        for external in [
            json!({"type":"excalidraw"}),
            json!({"type":"excalidraw","elements":null,"appState":null,"files":null}),
            json!({"type":"excalidraw","version":1,"elements":[],"appState":{}}),
            json!({
                "type":"excalidraw",
                "version":99,
                "scrollToContent":true,
                "libraryItems":[],
                "futureField":{"keptByFutureExcalidraw":true},
                "appState":{"zoom":{"value":2},"viewBackgroundColor":"#abcdef"}
            }),
        ] {
            let imported = import_portable_scene(&canonical(external))
                .expect("upstream-valid external artifact imports");
            let doc = crate::Ydoc::wire();
            doc.apply(&imported.initial_update).expect("initial update");
            let folded = doc.fold_scene();
            assert!(folded.elements.is_empty());
            assert!(!folded.app_state.contains_key("zoom"));
        }
    }

    #[test]
    fn native_import_still_rejects_wrong_type_and_missing_image_bytes() {
        for wrong_type in [json!({}), json!({"type":"other"})] {
            assert!(matches!(
                import_portable_scene(&canonical(wrong_type)),
                Err(SceneImportError::Invalid { .. })
            ));
        }

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

    #[test]
    fn asset_refs_digest_untrusted_identity_into_one_canonical_segment() {
        let sha = "ab".repeat(32);
        let dangerous = "../peer:object/\u{0000}/雪".repeat(40);
        let asset_ref = scene_asset_ref(
            "workspace/../x",
            "version:one",
            &dangerous,
            &sha,
            "image/png",
        )
        .expect("identity is encoded, not interpolated");
        let parts: Vec<&str> = asset_ref.split('/').collect();
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0..2], ["assets", "excalidraw"]);
        assert_eq!(parts[2].len(), 64);
        assert!(parts[2].bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(parts[3], format!("{sha}.png"));
        let owner_directory = asset_ref.rsplit_once('/').expect("owner directory").0;
        assert!(scene_asset_ref_is_owned(owner_directory, &asset_ref, &sha));
        assert!(!scene_asset_ref_is_owned(
            owner_directory,
            &format!("{owner_directory}/{sha}.txt"),
            &sha
        ));
        assert_eq!(
            asset_ref,
            scene_asset_ref(
                "workspace/../x",
                "version:one",
                &dangerous,
                &sha,
                "image/png"
            )
            .expect("deterministic ref")
        );
        assert_ne!(
            asset_ref,
            scene_asset_ref(
                "workspace/../x",
                "version:two",
                &dangerous,
                &sha,
                "image/png"
            )
            .expect("version-scoped ref")
        );
    }
}
