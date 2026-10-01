//! Rust twin of `packages/workspace-contracts/src/collectionValues.ts`.
//!
//! The TypeScript implementation is the fixture oracle. The shared vectors
//! hold this port to the same schema recovery, Field value, and Record id
//! outcomes.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::Hash;
use std::rc::Rc;
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use dohc_engine_files::canonical_workspace_path_meets_shared_bounds;
use dohc_engine_storage::StorageError;
use rusqlite::{Connection, OptionalExtension, params};
use saphyr::{LoadableYamlNode, MappingOwned, ScalarStyle, Tag, YamlOwned};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chats::{base32_lowercase_no_padding, is_js_trim_ws};

pub const COLLECTION_SCHEMA_FILENAME: &str = "collection.yaml";
pub const DEFAULT_COLLECTION_QUERY_LIMIT: usize = 100;
pub const MAX_COLLECTION_QUERY_LIMIT: usize = 500;
pub const MAX_COLLECTION_QUERY_SORTS: usize = 8;
const ROOT_COLLECTION_DIAGNOSTIC_PATH: &str = ".";
pub const RECORD_ID_FRONTMATTER_KEY: &str = "id";
pub const RECORD_ID_PREFIX: &str = "rec_";
pub const RECORD_ID_RANDOM_BASE32_LENGTH: usize = 26;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CollectionFieldType {
    Text,
    Number,
    Checkbox,
    Date,
    Select,
    MultiSelect,
    Person,
    Relation,
    Url,
    Button,
}

impl CollectionFieldType {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "text" => Some(Self::Text),
            "number" => Some(Self::Number),
            "checkbox" => Some(Self::Checkbox),
            "date" => Some(Self::Date),
            "select" => Some(Self::Select),
            "multi-select" => Some(Self::MultiSelect),
            "person" => Some(Self::Person),
            "relation" => Some(Self::Relation),
            "url" => Some(Self::Url),
            "button" => Some(Self::Button),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum FieldDefinition {
    Text {
        name: String,
    },
    Number {
        name: String,
    },
    Checkbox {
        name: String,
    },
    Date {
        name: String,
    },
    Select {
        name: String,
        options: Vec<String>,
    },
    MultiSelect {
        name: String,
        options: Vec<String>,
    },
    Person {
        name: String,
    },
    Relation {
        name: String,
        collection: String,
        many: bool,
    },
    Url {
        name: String,
    },
    /// Shows a button on each record. It stores no value.
    Button {
        name: String,
    },
}

impl FieldDefinition {
    #[must_use]
    pub fn name(&self) -> &str {
        match self {
            Self::Text { name }
            | Self::Number { name }
            | Self::Checkbox { name }
            | Self::Date { name }
            | Self::Select { name, .. }
            | Self::MultiSelect { name, .. }
            | Self::Person { name }
            | Self::Relation { name, .. }
            | Self::Url { name }
            | Self::Button { name } => name,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewKind {
    Table,
    Board,
    Calendar,
}

impl ViewKind {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "table" => Some(Self::Table),
            "board" => Some(Self::Board),
            "calendar" => Some(Self::Calendar),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewSortDirection {
    Asc,
    Desc,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ViewSort {
    pub field: String,
    pub direction: ViewSortDirection,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewDefinition {
    pub name: String,
    pub kind: ViewKind,
    pub group_by: Option<String>,
    pub sort: Vec<ViewSort>,
    pub visible_fields: Option<Vec<String>>,
    pub date_field: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CollectionSchema {
    pub name: Option<String>,
    pub description: Option<String>,
    pub fields: Vec<FieldDefinition>,
    pub views: Vec<ViewDefinition>,
}

impl CollectionSchema {
    fn empty() -> Self {
        Self {
            name: None,
            description: None,
            fields: Vec::new(),
            views: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CollectionSchemaStatus {
    Valid,
    Degraded,
}

macro_rules! reason_code {
    ($name:ident { $($variant:ident),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
        #[serde(rename_all = "kebab-case")]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];
        }
    };
}

reason_code!(CollectionSchemaReasonCode {
    InvalidYaml,
    RootNotMapping,
    UnsupportedVersion,
    InvalidVersion,
    RootCollectionUnsupported,
    UnknownProperty,
    ExpectedText,
    ExpectedMapping,
    ExpectedSequence,
    ExpectedBoolean,
    MissingProperty,
    UnknownFieldType,
    UnknownViewKind,
    InvalidSortDirection,
    EmptyValue,
    DuplicateValue,
    FieldNameCollision,
    ReservedFieldName,
    InvalidRelationTarget,
    UnknownFieldReference,
    SchemaCollectionLimitExceeded,
    RecordTooLargeForAdoption,
    UnsupportedFieldReference,
});

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CollectionSchemaReason {
    pub code: CollectionSchemaReasonCode,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CollectionSchemaParseResult {
    pub status: CollectionSchemaStatus,
    pub schema: CollectionSchema,
    pub reasons: Vec<CollectionSchemaReason>,
}

/// One record whose Markdown artifact needs an engine-authored id write-back.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollectionAdoptionCandidate {
    pub record_id: String,
    pub collection_path: String,
    pub file_path: String,
    pub object_id: String,
    pub lossless_insertion_required: bool,
}

/// One active-version collection binding waiting for the rich-document
/// importer to establish its canonical Y.Doc lineage.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPendingAdoption {
    pub version_id: String,
    pub record_id: String,
    pub collection_path: String,
    pub file_path: String,
    pub object_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionPendingAdoptionCursor {
    pub file_path: String,
    pub record_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPendingAdoptionPage {
    pub adoptions: Vec<CollectionPendingAdoption>,
    pub next_cursor: Option<CollectionPendingAdoptionCursor>,
}

/// The local collection projection after one active-version reconciliation.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CollectionReconcileResult {
    pub adoptions: Vec<CollectionAdoptionCandidate>,
    pub relation_cleanups: Vec<CollectionRelationCleanupCandidate>,
    /// Records this reconciliation bound into a Collection or unbound from
    /// one. Which of them count as added or removed is the automation
    /// claim's decision.
    pub lifecycle: Vec<CollectionRecordLifecycle>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CollectionRecordLifecycleKind {
    /// The record id is bound in this Collection now and was not before.
    Added,
    /// The record id was bound in this Collection and is not now.
    Removed,
}

/// One record a reconciliation bound into or unbound from a Collection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollectionRecordLifecycle {
    pub kind: CollectionRecordLifecycleKind,
    pub record_id: String,
    pub collection_path: String,
    pub object_id: String,
    /// A removed record's last indexed values, `(field name, value JSON)`
    /// in field-name order, read before the index drops them and only when
    /// an automation wants removed records. An added record's values stay
    /// in the index, so this is empty.
    pub removed_fields: Vec<(String, String)>,
}

/// One dangling relation that needs an engine-authored frontmatter update.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollectionRelationCleanupCandidate {
    pub source_record_id: String,
    pub source_file_path: String,
    pub source_object_id: String,
    pub field_name: String,
    pub target_record_id: String,
    pub many: bool,
}

#[derive(Clone)]
struct CollectionSnapshot {
    path: String,
    object_id: String,
    text: String,
}

#[derive(Clone)]
struct ExistingRecordBinding {
    record_id: Option<String>,
    file_path: String,
    object_id: String,
    adoption_state: String,
    index_initialized: bool,
}

#[derive(Clone)]
struct DesiredRecordBinding {
    record_id: Option<String>,
    collection_path: String,
    file_path: String,
    object_id: String,
    adoption_state: &'static str,
    index_initialized: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CollectionFieldValue {
    Null,
    Boolean(bool),
    Number(f64),
    Text(String),
    Sequence(Vec<Self>),
    Mapping,
}

reason_code!(FieldValueReasonCode {
    ExpectedText,
    ExpectedNumber,
    NumberNotFinite,
    UnsupportedTag,
    ValueDepthExceeded,
    ExpectedBoolean,
    ExpectedSequence,
    InvalidDate,
    UnknownOption,
    DuplicateValue,
    EmptyPersonId,
    InvalidRecordId,
    InvalidUrl,
    ExpectedEmpty,
});

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FieldValueReason {
    pub code: FieldValueReasonCode,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum FieldValueValidation {
    Valid,
    Flagged { reason: FieldValueReason },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSummary {
    pub path: String,
    /// The object id of its schema file. It names the Collection wherever
    /// the Collection moves.
    pub object_id: String,
    pub status: CollectionSchemaStatus,
    pub reasons: Vec<CollectionSchemaReason>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionDetails {
    pub path: String,
    pub object_id: String,
    pub status: CollectionSchemaStatus,
    pub reasons: Vec<CollectionSchemaReason>,
    pub schema: CollectionSchema,
    pub record_count: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CollectionFilterOperator {
    Equals,
    Contains,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionFilter {
    pub field: String,
    pub operator: CollectionFilterOperator,
    pub value: Value,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CollectionSort {
    pub field: String,
    pub direction: ViewSortDirection,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionQuery {
    pub filter: Option<CollectionFilter>,
    pub sort: Vec<CollectionSort>,
    pub group_by: Option<String>,
    pub resolve_relations: bool,
    pub limit: usize,
    pub cursor: Option<CollectionQueryCursor>,
}

impl Default for CollectionQuery {
    fn default() -> Self {
        Self {
            filter: None,
            sort: Vec::new(),
            group_by: None,
            resolve_relations: false,
            limit: DEFAULT_COLLECTION_QUERY_LIMIT,
            cursor: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionQueryCursorValue {
    pub present: bool,
    pub value: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionQueryCursor {
    pub sort_values: Vec<CollectionQueryCursorValue>,
    pub record_path: String,
    pub record_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum CollectionIndexedValueValidation {
    Valid,
    Flagged { reason: FieldValueReason },
    Untyped,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionResolvedRelation {
    pub record_id: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionIndexedValue {
    pub field: String,
    pub value: Value,
    pub validation: CollectionIndexedValueValidation,
    pub resolved_relations: Vec<CollectionResolvedRelation>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRecord {
    pub id: String,
    pub path: String,
    pub conflicted: bool,
    pub values: Vec<CollectionIndexedValue>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRecordGroup {
    pub value: Value,
    pub records: Vec<CollectionRecord>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionQueryResult {
    pub collection: CollectionSummary,
    pub records: Vec<CollectionRecord>,
    pub groups: Option<Vec<CollectionRecordGroup>>,
    pub next_cursor: Option<CollectionQueryCursor>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct CollectionHistoryValue {
    pub present: bool,
    pub value: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionFieldHistoryEntry {
    pub history_id: i64,
    pub field: String,
    pub previous: CollectionHistoryValue,
    pub next: CollectionHistoryValue,
    pub author_origin_id: Option<String>,
    pub actor_kind: Option<ChangeActorKind>,
    pub on_behalf_of: Option<String>,
    pub depth: Option<i64>,
    pub recorded_at_ms: i64,
    /// The automation run that wrote the change, `None` for any other
    /// author and for an automation's write recorded without its run.
    pub automation_run: Option<AutomationRunAttribution>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRecordDetails {
    pub collection: CollectionSummary,
    pub record: CollectionRecord,
    pub history: Vec<CollectionFieldHistoryEntry>,
    /// Exclusive continuation cursor: pass as `before_history_id` to read the
    /// next newest-first page. `None` when this page reached the oldest entry.
    pub next_before_history_id: Option<i64>,
}

pub const MAX_COLLECTION_HISTORY_LIMIT: usize = 500;

// Collection schemas cross the default engine wire as arrays. Capping them
// while parsing prevents those arrays from exceeding the wire collection limit.
const MAX_SCHEMA_COLLECTION_ITEMS: usize = 16_384;
pub const MAX_COLLECTION_FIELD_VALUE_DEPTH: usize = 24;

fn pointer_segment(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn property_path(parent: &str, property: &str) -> String {
    format!("{parent}/{}", pointer_segment(property))
}

fn push_reason(
    reasons: &mut Vec<CollectionSchemaReason>,
    code: CollectionSchemaReasonCode,
    path: impl Into<String>,
) {
    if reasons.len() >= MAX_SCHEMA_COLLECTION_ITEMS {
        reasons.truncate(MAX_SCHEMA_COLLECTION_ITEMS - 1);
        reasons.push(CollectionSchemaReason {
            code: CollectionSchemaReasonCode::SchemaCollectionLimitExceeded,
            path: "/reasons".to_owned(),
        });
        return;
    }
    reasons.push(CollectionSchemaReason {
        code,
        path: path.into(),
    });
}

fn flagged(code: FieldValueReasonCode, path: impl Into<String>) -> FieldValueValidation {
    FieldValueValidation::Flagged {
        reason: FieldValueReason {
            code,
            path: path.into(),
        },
    }
}

fn mapping_get<'a>(mapping: &'a MappingOwned, key: &str) -> Option<&'a YamlOwned> {
    mapping.iter().rev().find_map(|(candidate, value)| {
        (yaml_key_text(candidate).as_deref() == Some(key)).then_some(value)
    })
}

fn yaml_key_text(value: &YamlOwned) -> Option<String> {
    if let Some(text) = value.as_str() {
        Some(text.to_owned())
    } else if let Some(integer) = value.as_integer() {
        Some(integer.to_string())
    } else if let Some(number) = value.as_floating_point() {
        Some(number.to_string())
    } else if let Some(boolean) = value.as_bool() {
        Some(boolean.to_string())
    } else if value.is_null() {
        Some("null".to_owned())
    } else {
        None
    }
}

fn report_unknown_properties(
    mapping: &MappingOwned,
    allowed: &[&str],
    path: &str,
    reasons: &mut Vec<CollectionSchemaReason>,
) {
    let mut reported = HashSet::new();
    for (key, _) in mapping {
        let Some(key) = yaml_key_text(key) else {
            push_reason(
                reasons,
                CollectionSchemaReasonCode::UnknownProperty,
                property_path(path, "<non-text-key>"),
            );
            continue;
        };
        if !allowed.contains(&key.as_str()) && reported.insert(key.clone()) {
            push_reason(
                reasons,
                CollectionSchemaReasonCode::UnknownProperty,
                property_path(path, &key),
            );
        }
    }
}

fn read_optional_text(
    mapping: &MappingOwned,
    key: &str,
    path: &str,
    reasons: &mut Vec<CollectionSchemaReason>,
) -> Option<String> {
    let value = mapping_get(mapping, key)?;
    match value.as_str() {
        Some(text) => Some(text.to_owned()),
        None => {
            push_reason(
                reasons,
                CollectionSchemaReasonCode::ExpectedText,
                property_path(path, key),
            );
            None
        }
    }
}

fn read_required_text(
    mapping: &MappingOwned,
    key: &str,
    path: &str,
    reasons: &mut Vec<CollectionSchemaReason>,
) -> Option<String> {
    let key_path = property_path(path, key);
    let Some(value) = mapping_get(mapping, key) else {
        push_reason(
            reasons,
            CollectionSchemaReasonCode::MissingProperty,
            key_path,
        );
        return None;
    };
    let Some(text) = value.as_str() else {
        push_reason(reasons, CollectionSchemaReasonCode::ExpectedText, key_path);
        return None;
    };
    if text.is_empty() {
        push_reason(reasons, CollectionSchemaReasonCode::EmptyValue, key_path);
        return None;
    }
    Some(text.to_owned())
}

// Mirrors isNormalizedRelativePath in @dohc/workspace-contracts. A colon is
// refused on every host: on Windows, "C:x" names a drive and "a:x" a stream.
fn is_workspace_relative_collection_path(value: &str) -> bool {
    canonical_workspace_path_meets_shared_bounds(value)
        && !value.is_empty()
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains('\\')
        && !value.contains(':')
        && !value.chars().any(|character| character.is_control())
        && value
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn parse_options(
    raw: Option<&YamlOwned>,
    path: &str,
    reasons: &mut Vec<CollectionSchemaReason>,
) -> Vec<String> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    let Some(sequence) = raw.as_vec() else {
        push_reason(reasons, CollectionSchemaReasonCode::ExpectedSequence, path);
        return Vec::new();
    };
    let mut options = Vec::new();
    let mut seen = HashSet::new();
    for (index, option) in sequence.iter().enumerate() {
        let option_path = format!("{path}/{index}");
        let Some(option) = option.as_str() else {
            push_reason(
                reasons,
                CollectionSchemaReasonCode::ExpectedText,
                option_path,
            );
            continue;
        };
        if option.is_empty() {
            push_reason(reasons, CollectionSchemaReasonCode::EmptyValue, option_path);
        } else if !seen.insert(option) {
            push_reason(
                reasons,
                CollectionSchemaReasonCode::DuplicateValue,
                option_path,
            );
        } else {
            options.push(option.to_owned());
        }
    }
    if options.len() > MAX_SCHEMA_COLLECTION_ITEMS {
        options.truncate(MAX_SCHEMA_COLLECTION_ITEMS);
        push_reason(
            reasons,
            CollectionSchemaReasonCode::SchemaCollectionLimitExceeded,
            path,
        );
    }
    options
}

fn parse_fields(
    raw: Option<&YamlOwned>,
    reasons: &mut Vec<CollectionSchemaReason>,
) -> Vec<FieldDefinition> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    let Some(mapping) = raw.as_mapping() else {
        push_reason(
            reasons,
            CollectionSchemaReasonCode::ExpectedMapping,
            "/fields",
        );
        return Vec::new();
    };

    let mut normalized_name_counts = HashMap::<String, usize>::new();
    for (name, _) in mapping {
        if let Some(name) = yaml_key_text(name) {
            *normalized_name_counts.entry(name).or_default() += 1;
        }
    }

    let mut fields = Vec::new();
    for (name, raw_field) in mapping {
        let Some(name) = yaml_key_text(name) else {
            push_reason(
                reasons,
                CollectionSchemaReasonCode::ExpectedText,
                "/fields/<non-text-key>",
            );
            continue;
        };
        let path = property_path("/fields", &name);
        if normalized_name_counts
            .get(&name)
            .copied()
            .unwrap_or_default()
            > 1
        {
            push_reason(
                reasons,
                CollectionSchemaReasonCode::FieldNameCollision,
                &path,
            );
        }
        if name.is_empty() {
            push_reason(reasons, CollectionSchemaReasonCode::EmptyValue, &path);
            continue;
        }
        if name == RECORD_ID_FRONTMATTER_KEY {
            push_reason(
                reasons,
                CollectionSchemaReasonCode::ReservedFieldName,
                &path,
            );
            continue;
        }
        let Some(field) = raw_field.as_mapping() else {
            push_reason(reasons, CollectionSchemaReasonCode::ExpectedMapping, &path);
            continue;
        };
        let Some(raw_type) = mapping_get(field, "type") else {
            push_reason(
                reasons,
                CollectionSchemaReasonCode::MissingProperty,
                format!("{path}/type"),
            );
            continue;
        };
        let Some(raw_type) = raw_type.as_str() else {
            push_reason(
                reasons,
                CollectionSchemaReasonCode::ExpectedText,
                format!("{path}/type"),
            );
            continue;
        };
        let Some(field_type) = CollectionFieldType::parse(raw_type) else {
            push_reason(
                reasons,
                CollectionSchemaReasonCode::UnknownFieldType,
                format!("{path}/type"),
            );
            continue;
        };

        match field_type {
            CollectionFieldType::Select | CollectionFieldType::MultiSelect => {
                report_unknown_properties(field, &["type", "options"], &path, reasons);
                let options = parse_options(
                    mapping_get(field, "options"),
                    &format!("{path}/options"),
                    reasons,
                );
                fields.push(match field_type {
                    CollectionFieldType::Select => FieldDefinition::Select { name, options },
                    CollectionFieldType::MultiSelect => {
                        FieldDefinition::MultiSelect { name, options }
                    }
                    _ => unreachable!("match arm only admits select Field types"),
                });
            }
            CollectionFieldType::Relation => {
                report_unknown_properties(field, &["type", "collection", "many"], &path, reasons);
                let collection = read_required_text(field, "collection", &path, reasons);
                let many_path = format!("{path}/many");
                let many = match mapping_get(field, "many") {
                    None => {
                        push_reason(
                            reasons,
                            CollectionSchemaReasonCode::MissingProperty,
                            many_path,
                        );
                        None
                    }
                    Some(value) => match value.as_bool() {
                        Some(value) => Some(value),
                        None => {
                            push_reason(
                                reasons,
                                CollectionSchemaReasonCode::ExpectedBoolean,
                                many_path,
                            );
                            None
                        }
                    },
                };
                if let Some(collection) = collection {
                    if is_workspace_relative_collection_path(&collection) {
                        if let Some(many) = many {
                            fields.push(FieldDefinition::Relation {
                                name,
                                collection,
                                many,
                            });
                        }
                    } else {
                        push_reason(
                            reasons,
                            CollectionSchemaReasonCode::InvalidRelationTarget,
                            format!("{path}/collection"),
                        );
                    }
                }
            }
            _ => {
                report_unknown_properties(field, &["type"], &path, reasons);
                fields.push(match field_type {
                    CollectionFieldType::Text => FieldDefinition::Text { name },
                    CollectionFieldType::Number => FieldDefinition::Number { name },
                    CollectionFieldType::Checkbox => FieldDefinition::Checkbox { name },
                    CollectionFieldType::Date => FieldDefinition::Date { name },
                    CollectionFieldType::Person => FieldDefinition::Person { name },
                    CollectionFieldType::Url => FieldDefinition::Url { name },
                    CollectionFieldType::Button => FieldDefinition::Button { name },
                    _ => unreachable!("match arm only admits scalar and button Field types"),
                });
            }
        }
    }
    fields
}

// A view sorts, groups, and dates by stored values, and a button stores none.
fn value_field_reason_code(
    name: &str,
    field_names: &HashSet<&str>,
    button_names: &HashSet<&str>,
) -> Option<CollectionSchemaReasonCode> {
    if !field_names.contains(name) {
        Some(CollectionSchemaReasonCode::UnknownFieldReference)
    } else if button_names.contains(name) {
        Some(CollectionSchemaReasonCode::UnsupportedFieldReference)
    } else {
        None
    }
}

fn parse_field_reference(
    raw: Option<&YamlOwned>,
    path: &str,
    field_names: &HashSet<&str>,
    button_names: &HashSet<&str>,
    reasons: &mut Vec<CollectionSchemaReason>,
) -> Option<String> {
    let raw = raw?;
    let Some(value) = raw.as_str() else {
        push_reason(reasons, CollectionSchemaReasonCode::ExpectedText, path);
        return None;
    };
    if value.is_empty() {
        push_reason(reasons, CollectionSchemaReasonCode::EmptyValue, path);
    } else if let Some(code) = value_field_reason_code(value, field_names, button_names) {
        push_reason(reasons, code, path);
    } else {
        return Some(value.to_owned());
    }
    None
}

fn parse_sort(
    raw: Option<&YamlOwned>,
    path: &str,
    field_names: &HashSet<&str>,
    button_names: &HashSet<&str>,
    reasons: &mut Vec<CollectionSchemaReason>,
) -> Vec<ViewSort> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    let Some(sequence) = raw.as_vec() else {
        push_reason(reasons, CollectionSchemaReasonCode::ExpectedSequence, path);
        return Vec::new();
    };
    let mut sort = Vec::new();
    for (index, entry) in sequence.iter().enumerate() {
        let entry_path = format!("{path}/{index}");
        let Some(entry) = entry.as_mapping() else {
            push_reason(
                reasons,
                CollectionSchemaReasonCode::ExpectedMapping,
                entry_path,
            );
            continue;
        };
        report_unknown_properties(entry, &["field", "direction"], &entry_path, reasons);
        let field = read_required_text(entry, "field", &entry_path, reasons);
        let direction_path = format!("{entry_path}/direction");
        let direction = match mapping_get(entry, "direction") {
            None => {
                push_reason(
                    reasons,
                    CollectionSchemaReasonCode::MissingProperty,
                    direction_path,
                );
                None
            }
            Some(value) => match value.as_str() {
                Some("asc") => Some(ViewSortDirection::Asc),
                Some("desc") => Some(ViewSortDirection::Desc),
                _ => {
                    push_reason(
                        reasons,
                        CollectionSchemaReasonCode::InvalidSortDirection,
                        direction_path,
                    );
                    None
                }
            },
        };
        if let Some(field) = field {
            if let Some(code) = value_field_reason_code(&field, field_names, button_names) {
                push_reason(reasons, code, format!("{entry_path}/field"));
            } else if let Some(direction) = direction {
                sort.push(ViewSort { field, direction });
            }
        }
    }
    if sort.len() > MAX_COLLECTION_QUERY_SORTS {
        sort.truncate(MAX_COLLECTION_QUERY_SORTS);
        push_reason(
            reasons,
            CollectionSchemaReasonCode::SchemaCollectionLimitExceeded,
            path,
        );
    }
    sort
}

fn parse_visible_fields(
    raw: Option<&YamlOwned>,
    path: &str,
    field_names: &HashSet<&str>,
    reasons: &mut Vec<CollectionSchemaReason>,
) -> Option<Vec<String>> {
    let raw = raw?;
    let Some(sequence) = raw.as_vec() else {
        push_reason(reasons, CollectionSchemaReasonCode::ExpectedSequence, path);
        return None;
    };
    let mut fields = Vec::new();
    let mut seen = HashSet::new();
    for (index, field) in sequence.iter().enumerate() {
        let field_path = format!("{path}/{index}");
        let Some(field) = field.as_str() else {
            push_reason(
                reasons,
                CollectionSchemaReasonCode::ExpectedText,
                field_path,
            );
            continue;
        };
        if !field_names.contains(field) {
            push_reason(
                reasons,
                CollectionSchemaReasonCode::UnknownFieldReference,
                field_path,
            );
        } else if !seen.insert(field) {
            push_reason(
                reasons,
                CollectionSchemaReasonCode::DuplicateValue,
                field_path,
            );
        } else {
            fields.push(field.to_owned());
        }
    }
    Some(fields)
}

fn parse_views(
    raw: Option<&YamlOwned>,
    fields: &[FieldDefinition],
    reasons: &mut Vec<CollectionSchemaReason>,
) -> Vec<ViewDefinition> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    let Some(sequence) = raw.as_vec() else {
        push_reason(
            reasons,
            CollectionSchemaReasonCode::ExpectedSequence,
            "/views",
        );
        return Vec::new();
    };
    let field_names: HashSet<&str> = fields.iter().map(FieldDefinition::name).collect();
    let button_names: HashSet<&str> = fields
        .iter()
        .filter(|field| matches!(field, FieldDefinition::Button { .. }))
        .map(FieldDefinition::name)
        .collect();
    let mut view_names = HashSet::new();
    let mut views = Vec::new();
    for (index, view) in sequence.iter().enumerate() {
        let path = format!("/views/{index}");
        let Some(view) = view.as_mapping() else {
            push_reason(reasons, CollectionSchemaReasonCode::ExpectedMapping, path);
            continue;
        };
        report_unknown_properties(
            view,
            &[
                "name",
                "kind",
                "groupBy",
                "sort",
                "visibleFields",
                "dateField",
            ],
            &path,
            reasons,
        );
        let name = read_required_text(view, "name", &path, reasons);
        let raw_kind = read_required_text(view, "kind", &path, reasons);
        let kind = raw_kind.and_then(|raw_kind| {
            ViewKind::parse(&raw_kind).or_else(|| {
                push_reason(
                    reasons,
                    CollectionSchemaReasonCode::UnknownViewKind,
                    format!("{path}/kind"),
                );
                None
            })
        });
        let Some(name) = name else {
            continue;
        };
        if view_names.contains(&name) {
            push_reason(
                reasons,
                CollectionSchemaReasonCode::DuplicateValue,
                format!("{path}/name"),
            );
            continue;
        }
        let Some(kind) = kind else {
            continue;
        };
        view_names.insert(name.clone());
        views.push(ViewDefinition {
            name,
            kind,
            group_by: parse_field_reference(
                mapping_get(view, "groupBy"),
                &format!("{path}/groupBy"),
                &field_names,
                &button_names,
                reasons,
            ),
            sort: parse_sort(
                mapping_get(view, "sort"),
                &format!("{path}/sort"),
                &field_names,
                &button_names,
                reasons,
            ),
            visible_fields: parse_visible_fields(
                mapping_get(view, "visibleFields"),
                &format!("{path}/visibleFields"),
                &field_names,
                reasons,
            ),
            date_field: parse_field_reference(
                mapping_get(view, "dateField"),
                &format!("{path}/dateField"),
                &field_names,
                &button_names,
                reasons,
            ),
        });
    }
    views
}

#[must_use]
pub fn parse_collection_schema(yaml_text: &str) -> CollectionSchemaParseResult {
    if yaml_text.trim().is_empty() {
        return CollectionSchemaParseResult {
            status: CollectionSchemaStatus::Valid,
            schema: CollectionSchema::empty(),
            reasons: Vec::new(),
        };
    }
    let Ok(documents) = YamlOwned::load_from_str(yaml_text) else {
        return degraded_document(CollectionSchemaReasonCode::InvalidYaml);
    };
    if documents.is_empty() {
        return CollectionSchemaParseResult {
            status: CollectionSchemaStatus::Valid,
            schema: CollectionSchema::empty(),
            reasons: Vec::new(),
        };
    }
    if documents.len() != 1 {
        return degraded_document(CollectionSchemaReasonCode::InvalidYaml);
    }
    let Some(root) = documents.first().and_then(YamlOwned::as_mapping) else {
        return degraded_document(CollectionSchemaReasonCode::RootNotMapping);
    };

    if let Some(version) = mapping_get(root, "version") {
        let number = version
            .as_integer()
            .map(|value| value as f64)
            .or_else(|| version.as_floating_point());
        if number != Some(1.0) {
            let code = if number.is_some_and(|value| {
                value > 1.0 && value <= 9_007_199_254_740_991.0 && value.fract() == 0.0
            }) {
                CollectionSchemaReasonCode::UnsupportedVersion
            } else {
                CollectionSchemaReasonCode::InvalidVersion
            };
            let mut result = degraded_document(code);
            result.reasons[0].path = "/version".to_owned();
            return result;
        }
    }
    let mut reasons = Vec::new();
    report_unknown_properties(
        root,
        &["version", "name", "description", "fields", "views"],
        "",
        &mut reasons,
    );
    let mut fields = parse_fields(mapping_get(root, "fields"), &mut reasons);
    let name = read_optional_text(root, "name", "", &mut reasons);
    let description = read_optional_text(root, "description", "", &mut reasons);
    if fields.len() > MAX_SCHEMA_COLLECTION_ITEMS {
        fields.truncate(MAX_SCHEMA_COLLECTION_ITEMS);
        push_reason(
            &mut reasons,
            CollectionSchemaReasonCode::SchemaCollectionLimitExceeded,
            "/fields",
        );
    }
    let mut views = parse_views(mapping_get(root, "views"), &fields, &mut reasons);
    if views.len() > MAX_SCHEMA_COLLECTION_ITEMS {
        views.truncate(MAX_SCHEMA_COLLECTION_ITEMS);
        push_reason(
            &mut reasons,
            CollectionSchemaReasonCode::SchemaCollectionLimitExceeded,
            "/views",
        );
    }
    let schema = CollectionSchema {
        name,
        description,
        views,
        fields,
    };
    CollectionSchemaParseResult {
        status: if reasons.is_empty() {
            CollectionSchemaStatus::Valid
        } else {
            CollectionSchemaStatus::Degraded
        },
        schema,
        reasons,
    }
}

fn degraded_document(code: CollectionSchemaReasonCode) -> CollectionSchemaParseResult {
    CollectionSchemaParseResult {
        status: CollectionSchemaStatus::Degraded,
        schema: CollectionSchema::empty(),
        reasons: vec![CollectionSchemaReason {
            code,
            path: String::new(),
        }],
    }
}

pub(crate) fn parent_path(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

fn path_basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Whether `path` carries the Markdown extension (ASCII case-insensitive) —
/// the one extension predicate for collection record membership. Every caller
/// that decides membership or schedules its reconciliation must share it.
pub fn is_collection_markdown_path(path: &str) -> bool {
    path.get(path.len().saturating_sub(3)..)
        .is_some_and(|extension| extension.eq_ignore_ascii_case(".md"))
}

/// Whether a line opens or closes a Markdown frontmatter block: `---`, then
/// only spaces or tabs, then one line break (`\n` or `\r\n`) or the end.
#[must_use]
pub fn is_frontmatter_delimiter(line: &str) -> bool {
    let content = match line.strip_suffix('\n') {
        Some(content) => content.strip_suffix('\r').unwrap_or(content),
        None => line,
    };
    content.strip_prefix("---").is_some_and(|suffix| {
        suffix
            .chars()
            .all(|character| matches!(character, ' ' | '\t'))
    })
}

/// A frontmatter YAML node. An alias shares its anchor's node, so the tree
/// never copies what an alias names.
#[derive(PartialEq)]
enum FrontmatterNode {
    /// `value` and `non_finite` are resolved once, when the scalar is read,
    /// so an alias that repeats a long spelling never resolves it again.
    Scalar {
        text: String,
        tag: Option<Tag>,
        value: Value,
        non_finite: bool,
        is_string: bool,
    },
    Sequence {
        tag: Option<Tag>,
        items: Vec<Rc<FrontmatterNode>>,
    },
    Mapping {
        tag: Option<Tag>,
        entries: Vec<(Rc<FrontmatterNode>, Rc<FrontmatterNode>)>,
    },
}

/// A scalar key as text; `None` for a key that is a collection.
fn frontmatter_node_key(node: &FrontmatterNode) -> Option<String> {
    match node {
        FrontmatterNode::Scalar { value, .. } => Some(frontmatter_key_text(value.clone())),
        _ => None,
    }
}

fn frontmatter_node_has_duplicate_key(node: &FrontmatterNode) -> bool {
    match node {
        FrontmatterNode::Scalar { .. } => false,
        FrontmatterNode::Sequence { items, .. } => items
            .iter()
            .any(|item| frontmatter_node_has_duplicate_key(item)),
        FrontmatterNode::Mapping { entries, .. } => {
            let mut seen = HashSet::new();
            entries.iter().any(|(key, value)| {
                frontmatter_node_key(key).is_some_and(|key| !seen.insert(key))
                    || frontmatter_node_has_duplicate_key(value)
            })
        }
    }
}

fn markdown_record_id(markdown: &str) -> Option<String> {
    let (_, root) = frontmatter_block(markdown).ok()??;
    let FrontmatterNode::Mapping { entries, .. } = root.as_deref()? else {
        return None;
    };
    entries
        .iter()
        .rev()
        .find(|(key, _)| frontmatter_node_key(key).as_deref() == Some(RECORD_ID_FRONTMATTER_KEY))
        .and_then(|(_, value)| match value.as_ref() {
            FrontmatterNode::Scalar { text, .. } => Some(text.clone()),
            _ => None,
        })
}

/// One frontmatter scalar as the value model reads it. The rules follow the
/// desktop's loader in `packages/ydoc-projection/src/import-export.ts`:
/// js-yaml's core schema, with `_` allowed between integer digits. A scalar
/// the model cannot hold keeps its text: a non-finite float, an integer
/// outside int64, or a value its explicit tag cannot resolve.
struct FrontmatterScalar {
    value: Value,
    non_finite: bool,
}

enum ResolvedScalar {
    Value(Value),
    /// A number the value model cannot hold.
    Unrepresentable {
        non_finite: bool,
    },
    NotResolved,
}

fn frontmatter_scalar(text: &str, style: ScalarStyle, tag: Option<&Tag>) -> FrontmatterScalar {
    let resolved = match tag {
        Some(tag) if !yaml_tag_is_supported(tag) => ResolvedScalar::NotResolved,
        Some(tag) => match core_tag_suffix(tag).unwrap_or_default() {
            "null" => resolve_yaml_null(text),
            "bool" => resolve_yaml_bool(text),
            "int" => resolve_yaml_int(text, true),
            "float" => resolve_yaml_float(text),
            _ => ResolvedScalar::NotResolved,
        },
        None if style == ScalarStyle::Plain => resolve_plain_yaml_scalar(text),
        None => ResolvedScalar::NotResolved,
    };
    let (value, non_finite) = match resolved {
        ResolvedScalar::Value(value) => (value, false),
        ResolvedScalar::Unrepresentable { non_finite } => {
            (Value::String(text.to_owned()), non_finite)
        }
        ResolvedScalar::NotResolved => (Value::String(text.to_owned()), false),
    };
    FrontmatterScalar { value, non_finite }
}

/// Whether a plain scalar reads back as the same string. A presenter must
/// quote any other string, including one that names a number the value model
/// keeps as text, such as `.nan` or an integer outside int64.
#[must_use]
pub fn plain_yaml_scalar_is_string(text: &str) -> bool {
    matches!(resolve_plain_yaml_scalar(text), ResolvedScalar::NotResolved)
}

fn resolve_plain_yaml_scalar(text: &str) -> ResolvedScalar {
    for resolve in [
        resolve_yaml_null,
        resolve_yaml_bool,
        |text: &str| resolve_yaml_int(text, false),
        resolve_yaml_float,
    ] {
        let resolved = resolve(text);
        if !matches!(resolved, ResolvedScalar::NotResolved) {
            return resolved;
        }
    }
    ResolvedScalar::NotResolved
}

/// The suffix of a core schema tag, written `!!int` or `!<tag:yaml.org,2002:int>`.
fn core_tag_suffix(tag: &Tag) -> Option<&str> {
    if tag.is_yaml_core_schema() {
        Some(&tag.suffix)
    } else if tag.handle.is_empty() {
        tag.suffix.strip_prefix("tag:yaml.org,2002:")
    } else {
        None
    }
}

fn yaml_tag_is_supported(tag: &Tag) -> bool {
    core_tag_suffix(tag).is_some_and(|suffix| {
        matches!(
            suffix,
            "str" | "seq" | "map" | "null" | "bool" | "int" | "float"
        )
    })
}

fn resolve_yaml_null(text: &str) -> ResolvedScalar {
    if matches!(text, "" | "~" | "null" | "Null" | "NULL") {
        ResolvedScalar::Value(Value::Null)
    } else {
        ResolvedScalar::NotResolved
    }
}

fn resolve_yaml_bool(text: &str) -> ResolvedScalar {
    match text {
        "true" | "True" | "TRUE" => ResolvedScalar::Value(Value::Bool(true)),
        "false" | "False" | "FALSE" => ResolvedScalar::Value(Value::Bool(false)),
        _ => ResolvedScalar::NotResolved,
    }
}

/// js-yaml's core integer: decimal with an optional sign, or `0o`/`0x`. An
/// explicit `!!int` also reads `0b` and a sign before a radix prefix. A `_`
/// may separate two digits.
fn resolve_yaml_int(text: &str, explicit: bool) -> ResolvedScalar {
    let bytes = text.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'_'
            && !(index > 0
                && bytes[index - 1].is_ascii_hexdigit()
                && bytes.get(index + 1).is_some_and(u8::is_ascii_hexdigit))
        {
            return ResolvedScalar::NotResolved;
        }
    }
    let normalized = text.replace('_', "");
    let unsigned = normalized.strip_prefix(['-', '+']).unwrap_or(&normalized);
    let signed = unsigned.len() != normalized.len();
    let (radix, digits) = [("0b", 2), ("0o", 8), ("0x", 16)]
        .into_iter()
        .find_map(|(prefix, radix)| unsigned.strip_prefix(prefix).map(|digits| (radix, digits)))
        .unwrap_or((10, unsigned));
    if radix != 10 && !explicit && (radix == 2 || signed) {
        return ResolvedScalar::NotResolved;
    }
    if digits.is_empty() || !digits.chars().all(|digit| digit.is_digit(radix)) {
        return ResolvedScalar::NotResolved;
    }
    // js-yaml refuses an integer whose float value overflows.
    let approximate = digits.chars().fold(0_f64, |value, digit| {
        value * f64::from(radix) + f64::from(digit.to_digit(radix).unwrap_or(0))
    });
    if !approximate.is_finite() {
        return ResolvedScalar::NotResolved;
    }
    let negative = normalized.starts_with('-');
    match i128::from_str_radix(digits, radix)
        .ok()
        .and_then(|magnitude| i64::try_from(if negative { -magnitude } else { magnitude }).ok())
    {
        Some(integer) => ResolvedScalar::Value(Value::from(integer)),
        None => ResolvedScalar::Unrepresentable { non_finite: false },
    }
}

/// js-yaml's core float. `.inf` and `.nan` name numbers the value model
/// cannot hold; a finite form that overflows is not a float.
fn resolve_yaml_float(text: &str) -> ResolvedScalar {
    if matches!(text, ".nan" | ".NaN" | ".NAN") {
        return ResolvedScalar::Unrepresentable { non_finite: true };
    }
    let unsigned = text.strip_prefix(['-', '+']).unwrap_or(text);
    if matches!(unsigned, ".inf" | ".Inf" | ".INF") {
        return ResolvedScalar::Unrepresentable { non_finite: true };
    }
    let digits = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    let (mantissa, exponent) = unsigned
        .split_once(['e', 'E'])
        .map_or((unsigned, None), |(mantissa, exponent)| {
            (mantissa, Some(exponent))
        });
    let exponent_is_valid = exponent.is_none_or(|exponent| {
        let exponent = exponent.strip_prefix(['-', '+']).unwrap_or(exponent);
        !exponent.is_empty() && digits(exponent)
    });
    let mantissa_is_valid = match mantissa.split_once('.') {
        None => !mantissa.is_empty() && digits(mantissa),
        Some((whole, fraction)) => {
            digits(whole) && digits(fraction) && !(whole.is_empty() && fraction.is_empty())
        }
    };
    if !exponent_is_valid || !mantissa_is_valid {
        return ResolvedScalar::NotResolved;
    }
    match unsigned.parse::<f64>() {
        Ok(value) if value.is_finite() => {
            ResolvedScalar::Value(Value::from(if text.starts_with('-') {
                -value
            } else {
                value
            }))
        }
        _ => ResolvedScalar::NotResolved,
    }
}

/// A mapping key as text, spelled the way JavaScript's `String` spells it.
fn frontmatter_key_text(value: Value) -> String {
    match value {
        Value::String(text) => text,
        Value::Number(number) => number.as_i64().map_or_else(
            || {
                ryu_js::Buffer::new()
                    .format(number.as_f64().unwrap_or_default())
                    .to_owned()
            },
            |integer| integer.to_string(),
        ),
        other => other.to_string(),
    }
}

fn frontmatter_node_json(node: &FrontmatterNode) -> Value {
    match node {
        FrontmatterNode::Scalar { value, .. } => value.clone(),
        FrontmatterNode::Sequence { items, .. } => Value::Array(
            items
                .iter()
                .map(|item| frontmatter_node_json(item))
                .collect(),
        ),
        FrontmatterNode::Mapping { entries, .. } => Value::Object(
            entries
                .iter()
                .filter_map(|(key, value)| {
                    frontmatter_node_key(key).map(|key| (key, frontmatter_node_json(value)))
                })
                .collect(),
        ),
    }
}

fn frontmatter_node_is_non_finite(node: &FrontmatterNode) -> bool {
    match node {
        FrontmatterNode::Scalar { non_finite, .. } => *non_finite,
        _ => false,
    }
}

fn frontmatter_node_has_unsupported_tag(node: &FrontmatterNode) -> bool {
    let unsupported =
        |tag: &Option<Tag>| tag.as_ref().is_some_and(|tag| !yaml_tag_is_supported(tag));
    match node {
        FrontmatterNode::Scalar { tag, .. } => unsupported(tag),
        FrontmatterNode::Sequence { tag, items } => {
            unsupported(tag)
                || items
                    .iter()
                    .any(|item| frontmatter_node_has_unsupported_tag(item))
        }
        FrontmatterNode::Mapping { tag, entries } => {
            unsupported(tag)
                || entries.iter().any(|(key, value)| {
                    frontmatter_node_has_unsupported_tag(key)
                        || frontmatter_node_has_unsupported_tag(value)
                })
        }
    }
}

/// Collection nesting a frontmatter block may reach, the root mapping
/// included: the root and the 129 levels (0 to 128) a public value may hold.
/// The desktop's loader applies the same limits.
const MAX_FRONTMATTER_DEPTH: usize = 130;
/// Value nodes a frontmatter block may hold once aliases are expanded.
const MAX_FRONTMATTER_NODES: usize = 262_144;
/// UTF-8 bytes of string values and mapping keys once aliases are expanded.
/// Above the largest text file, so only aliases can reach it.
const MAX_FRONTMATTER_STRING_BYTES: usize = 16 * 1024 * 1024;
const MAX_FRONTMATTER_ALIASES: usize = 256;

/// Text both loaders refuse before parsing: a `%TAG` directive, which would
/// copy its prefix into every tagged node, a second document's start marker,
/// or a carriage return that does not end a line.
fn frontmatter_yaml_is_refused(yaml: &str) -> bool {
    has_lone_carriage_return(yaml)
        || yaml.split_inclusive('\n').any(|line| {
            ["%TAG", "---"].iter().any(|marker| {
                line.strip_prefix(marker).is_some_and(|rest| {
                    rest.is_empty() || rest.starts_with([' ', '\t', '\r', '\n'])
                })
            })
        })
}

fn has_lone_carriage_return(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes
        .iter()
        .enumerate()
        .any(|(index, byte)| *byte == b'\r' && bytes.get(index + 1) != Some(&b'\n'))
}

/// One top-level entry of a frontmatter block.
pub struct FrontmatterEntryPosition {
    pub key: String,
    /// Byte offset in the YAML of the line the key starts on.
    pub line: usize,
    /// Blank lines after the entry's last line that belong to its value:
    /// the line breaks a keep-chomped block scalar (`|+`) keeps.
    pub kept_blank_lines: usize,
}

struct LoadedFrontmatterYaml {
    document: Option<Rc<FrontmatterNode>>,
    /// The line and kept blank lines of each top-level key, in document
    /// order. `None` unless the root is a block mapping with one written key
    /// per line.
    root_keys: Option<Vec<(usize, usize)>>,
}

struct LoadFrame {
    flow: bool,
    column: usize,
    line: usize,
    anchor: usize,
    nodes_before: usize,
    bytes_before: usize,
    height: usize,
    tag: Option<Tag>,
    mapping: bool,
    items: Vec<Rc<FrontmatterNode>>,
    entries: Vec<(Rc<FrontmatterNode>, Rc<FrontmatterNode>)>,
    key: Option<Rc<FrontmatterNode>>,
}

struct Anchored {
    node: Rc<FrontmatterNode>,
    nodes: usize,
    bytes: usize,
    height: usize,
}

/// Load frontmatter YAML with every scalar left unresolved, so
/// [`frontmatter_scalar`] reads it instead of saphyr's own schema. The load
/// walks parser events and builds its own tree, because saphyr's loader
/// recurses once per nesting level and copies every anchored node. An alias
/// shares its anchor's node, and the walk refuses YAML past the depth, node,
/// string byte, and alias budgets before anything expands it. It also refuses
/// what the desktop's js-yaml loader refuses: a key that is a collection, an
/// alias to an unknown or unfinished anchor, a second document, and a quoted,
/// plain, or flow value continued at or left of its block's column.
fn load_frontmatter_yaml(source: &str) -> Option<LoadedFrontmatterYaml> {
    use saphyr_parser::Event;

    let line_starts: Vec<usize> = std::iter::once(0)
        .chain(source.match_indices('\n').map(|(index, _)| index + 1))
        .collect();
    // Continuation lines of a multi-line value must be indented past the
    // column of the block collection that holds it.
    let indented_past = |first_line: usize, last_line: usize, column: usize| {
        (first_line + 1..=last_line).all(|line| {
            let start = line_starts.get(line - 1).copied().unwrap_or(source.len());
            let end = line_starts.get(line).copied().unwrap_or(source.len());
            let text = source[start..end].trim_end_matches(['\r', '\n']);
            text.trim().is_empty() || text.len() - text.trim_start_matches(' ').len() > column
        })
    };
    // saphyr starts a block sequence at its first entry's content; the
    // sequence's column is the dash before it.
    let dash_column = |line: usize, column: usize| {
        let start = line_starts.get(line - 1).copied().unwrap_or(source.len());
        let before: Vec<char> = source[start..].chars().take(column).collect();
        before
            .iter()
            .rposition(|character| *character != ' ')
            .filter(|at| before[*at] == '-')
            .unwrap_or(column)
    };
    let string_bytes = |value: &Value| value.as_str().map_or(0, str::len);
    let mut frames: Vec<LoadFrame> = Vec::new();
    let mut anchors: HashMap<usize, Anchored> = HashMap::new();
    let mut document: Option<Rc<FrontmatterNode>> = None;
    let mut nodes = 0usize;
    let mut bytes = 0usize;
    let mut aliases = 0usize;
    let mut root_keys: Option<Vec<(usize, usize)>> = Some(Vec::new());
    for event in saphyr_parser::Parser::new_from_str(source) {
        let (event, span) = event.ok()?;
        // Whether a node this event starts is a mapping key, and whether it is
        // a key of the root mapping.
        let is_key = frames
            .last()
            .is_some_and(|frame| frame.mapping && frame.key.is_none());
        let block_column = frames
            .last()
            .filter(|frame| !frame.flow)
            .map(|frame| frame.column);
        let mut root_key = false;
        let mapping = matches!(event, Event::MappingStart(..));
        let node = match event {
            Event::Scalar(text, style, anchor, tag) => {
                let tag = tag.map(std::borrow::Cow::into_owned);
                let FrontmatterScalar {
                    value: resolved,
                    non_finite,
                } = frontmatter_scalar(&text, style, tag.as_ref());
                if matches!(
                    style,
                    ScalarStyle::Plain | ScalarStyle::SingleQuoted | ScalarStyle::DoubleQuoted
                ) && let Some(column) = block_column
                    && !indented_past(span.start.line(), span.end.line(), column)
                {
                    return None;
                }
                let value_bytes = string_bytes(&resolved);
                if is_key {
                    bytes += frontmatter_key_text(resolved.clone()).len();
                } else {
                    nodes += 1;
                    bytes += value_bytes;
                }
                root_key = is_key && frames.len() == 1;
                // saphyr writes an empty node as `~` with an empty span.
                if root_key
                    && span.start.index() == span.end.index()
                    && style == ScalarStyle::Plain
                    && tag.is_none()
                    && anchor == 0
                {
                    // js-yaml gives an empty key no position to split at.
                    root_keys = None;
                }
                if !is_key
                    && let Some(keys) = root_keys.as_mut()
                    && let Some(last) = keys.last_mut()
                {
                    // A keep-chomped block scalar owns the blank lines after it.
                    last.1 = if matches!(style, ScalarStyle::Literal | ScalarStyle::Folded) {
                        (text.len() - text.trim_end_matches('\n').len()).saturating_sub(1)
                    } else {
                        0
                    };
                }
                let node = Rc::new(FrontmatterNode::Scalar {
                    is_string: resolved.is_string()
                        && match tag.as_ref() {
                            Some(tag) => core_tag_suffix(tag) == Some("str"),
                            None => {
                                style != ScalarStyle::Plain || plain_yaml_scalar_is_string(&text)
                            }
                        },
                    text: text.into_owned(),
                    tag,
                    value: resolved,
                    non_finite,
                });
                if anchor > 0 {
                    anchors.insert(
                        anchor,
                        Anchored {
                            node: node.clone(),
                            nodes: 1,
                            bytes: value_bytes,
                            height: 0,
                        },
                    );
                }
                node
            }
            Event::SequenceStart(anchor, tag) | Event::MappingStart(anchor, tag) => {
                if is_key {
                    return None;
                }
                let flow = span.start.index() != span.end.index();
                if frames.is_empty() && flow {
                    root_keys = None;
                }
                frames.push(LoadFrame {
                    flow,
                    column: if mapping || flow {
                        span.start.col()
                    } else {
                        dash_column(span.start.line(), span.start.col())
                    },
                    line: span.start.line(),
                    anchor,
                    nodes_before: nodes,
                    bytes_before: bytes,
                    height: 0,
                    tag: tag.map(std::borrow::Cow::into_owned),
                    mapping,
                    items: Vec::new(),
                    entries: Vec::new(),
                    key: None,
                });
                nodes += 1;
                if frames.len() > MAX_FRONTMATTER_DEPTH || nodes > MAX_FRONTMATTER_NODES {
                    return None;
                }
                continue;
            }
            Event::SequenceEnd | Event::MappingEnd => {
                let frame = frames.pop()?;
                if frame.flow
                    && let Some(parent) = frames.last()
                    && !parent.flow
                    && !indented_past(frame.line, span.end.line(), parent.column)
                {
                    return None;
                }
                let height = frame.height + 1;
                let node = Rc::new(if frame.mapping {
                    FrontmatterNode::Mapping {
                        tag: frame.tag,
                        entries: frame.entries,
                    }
                } else {
                    FrontmatterNode::Sequence {
                        tag: frame.tag,
                        items: frame.items,
                    }
                });
                if frame.anchor > 0 {
                    anchors.insert(
                        frame.anchor,
                        Anchored {
                            node: node.clone(),
                            nodes: nodes - frame.nodes_before,
                            bytes: bytes - frame.bytes_before,
                            height,
                        },
                    );
                }
                if let Some(parent) = frames.last_mut() {
                    parent.height = parent.height.max(height);
                }
                node
            }
            Event::Alias(anchor) => {
                root_key = is_key && frames.len() == 1;
                aliases += 1;
                let anchored = anchors.get(&anchor)?;
                if aliases > MAX_FRONTMATTER_ALIASES || (is_key && anchored.height > 0) {
                    return None;
                }
                if is_key {
                    bytes += frontmatter_node_key(&anchored.node)?.len();
                } else {
                    nodes += anchored.nodes;
                    bytes += anchored.bytes;
                    if frames.len() + anchored.height > MAX_FRONTMATTER_DEPTH {
                        return None;
                    }
                    if let Some(parent) = frames.last_mut() {
                        parent.height = parent.height.max(anchored.height);
                    }
                    if let Some(keys) = root_keys.as_mut()
                        && let Some(last) = keys.last_mut()
                    {
                        last.1 = 0;
                    }
                }
                anchored.node.clone()
            }
            _ => continue,
        };
        if nodes > MAX_FRONTMATTER_NODES || bytes > MAX_FRONTMATTER_STRING_BYTES {
            return None;
        }
        if root_key {
            let line = line_starts.get(span.start.line() - 1).copied()?;
            if frames[0].flow
                || root_keys
                    .as_ref()
                    .and_then(|keys| keys.last())
                    .is_some_and(|(last, _)| *last >= line)
            {
                root_keys = None;
            }
            if let Some(keys) = root_keys.as_mut() {
                keys.push((line, 0));
            }
        }
        match frames.last_mut() {
            Some(frame) if frame.mapping => match frame.key.take() {
                Some(key) => frame.entries.push((key, node)),
                None => frame.key = Some(node),
            },
            Some(frame) => frame.items.push(node),
            // A second root node is a second document.
            None if document.is_some() => return None,
            None => document = Some(node),
        }
    }
    Some(LoadedFrontmatterYaml {
        document,
        root_keys,
    })
}

/// A Markdown document's frontmatter block as both loaders read it.
pub struct MarkdownFrontmatterBlock<'a> {
    pub value: serde_json::Map<String, Value>,
    /// Everything up to and including the opening delimiter line.
    pub open: &'a str,
    /// The lines between the delimiters, each with its line break.
    pub yaml: &'a str,
    /// The closing delimiter line and everything after it.
    pub closing: &'a str,
    pub body: &'a str,
    /// Each top-level entry in document order. `None` unless the root is a
    /// block mapping with one written key per line.
    pub entries: Option<Vec<FrontmatterEntryPosition>>,
    non_finite_fields: HashSet<String>,
    unsupported_tag_fields: HashSet<String>,
}

/// The document's frontmatter block and its root node. `Ok(None)` when the
/// document has none; `Err(())` when its block does not read as a mapping.
#[allow(clippy::type_complexity)]
fn frontmatter_block(
    markdown: &str,
) -> Result<Option<(MarkdownFrontmatterBlock<'_>, Option<Rc<FrontmatterNode>>)>, ()> {
    let mut lines = markdown.split_inclusive('\n');
    let Some(first) = lines
        .next()
        .filter(|line| line.ends_with('\n') && is_frontmatter_delimiter(line))
    else {
        return Ok(None);
    };
    let yaml_start = first.len();
    let mut yaml_end = yaml_start;
    let mut body_start = None;
    for line in lines {
        if is_frontmatter_delimiter(line) {
            body_start = Some(yaml_end + line.len());
            break;
        }
        yaml_end += line.len();
    }
    let body_start = body_start.ok_or(())?;
    let yaml = &markdown[yaml_start..yaml_end];
    if frontmatter_yaml_is_refused(yaml) {
        return Err(());
    }
    let mut block = MarkdownFrontmatterBlock {
        value: serde_json::Map::new(),
        open: &markdown[..yaml_start],
        yaml,
        closing: &markdown[yaml_end..],
        body: &markdown[body_start..],
        entries: Some(Vec::new()),
        non_finite_fields: HashSet::new(),
        unsupported_tag_fields: HashSet::new(),
    };
    let yaml_is_empty = yaml.lines().all(|line| {
        let content = line.trim_start_matches([' ', '\t', '\r']);
        content.is_empty() || content.starts_with('#')
    });
    if yaml_is_empty {
        return Ok(Some((block, None)));
    }
    let loaded = load_frontmatter_yaml(yaml).ok_or(())?;
    let document = loaded.document.ok_or(())?;
    if frontmatter_node_has_duplicate_key(&document) {
        return Err(());
    }
    let FrontmatterNode::Mapping { entries, .. } = document.as_ref() else {
        return Err(());
    };
    let mut keys = Vec::with_capacity(entries.len());
    for (key, value) in entries {
        let key = frontmatter_node_key(key).ok_or(())?;
        if frontmatter_node_is_non_finite(value) {
            block.non_finite_fields.insert(key.clone());
        }
        if frontmatter_node_has_unsupported_tag(value) {
            block.unsupported_tag_fields.insert(key.clone());
        }
        keys.push(key);
    }
    block.entries = loaded
        .root_keys
        .filter(|lines| lines.len() == keys.len())
        .map(|lines| {
            keys.into_iter()
                .zip(lines)
                .map(|(key, (line, kept_blank_lines))| FrontmatterEntryPosition {
                    key,
                    line,
                    kept_blank_lines,
                })
                .collect()
        });
    let Value::Object(value) = frontmatter_node_json(&document) else {
        return Err(());
    };
    block.value = value;
    Ok(Some((block, Some(document))))
}

/// A frontmatter block that neither loader reads, up to and including its
/// closing delimiter line, when its first entry looks like a mapping key: `key:`
/// or `?` at the start of a line, or the block contains a lone carriage return.
/// A settle keeps such a block byte for byte instead of reading it as body
/// Markdown. The desktop applies the same rule
/// (`unreadableFrontmatterPrefix` in packages/ydoc-projection/src/frontmatter.ts).
#[must_use]
pub fn unreadable_frontmatter_prefix(markdown: &str) -> Option<&str> {
    if frontmatter_block(markdown).is_ok() {
        return None;
    }
    let mut lines = markdown.split_inclusive('\n');
    let first = lines
        .next()
        .filter(|line| line.ends_with('\n') && is_frontmatter_delimiter(line))?;
    let mut end = first.len();
    let mut entry = None;
    for line in lines {
        end += line.len();
        if is_frontmatter_delimiter(line) {
            let prefix = &markdown[..end];
            return (entry.is_some_and(looks_like_mapping_entry)
                || has_lone_carriage_return(prefix))
            .then_some(prefix);
        }
        let content = line
            .strip_suffix("\r\n")
            .or_else(|| line.strip_suffix('\n'))
            .unwrap_or(line);
        let trimmed = content.trim_start_matches([' ', '\t']);
        if entry.is_none() && !trimmed.is_empty() && !trimmed.starts_with('#') {
            entry = Some(content);
        }
    }
    None
}

/// Whether a frontmatter line looks like a mapping entry: `?` then a space,
/// tab, or the end; or a first character other than space, tab, `#`, `%`, or
/// `-`, then a colon followed by a space, tab, or the end. The desktop uses
/// the same rule (`looksLikeMappingEntry` in packages/ydoc-projection/src/frontmatter.ts).
fn looks_like_mapping_entry(line: &str) -> bool {
    let separator = |rest: &str| rest.is_empty() || rest.starts_with([' ', '\t']);
    if line.strip_prefix('?').is_some_and(separator) {
        return true;
    }
    let Some(first) = line.chars().next() else {
        return false;
    };
    if matches!(first, ' ' | '\t' | '#' | '%' | '-') {
        return false;
    }
    let rest = &line[first.len_utf8()..];
    rest.match_indices(':')
        .any(|(index, _)| separator(&rest[index + 1..]))
}

/// Whether the entry splitter cannot preserve this block through property edits.
/// The desktop uses `markdownFrontmatterEditsRefused` for the same decision.
#[must_use]
pub fn markdown_frontmatter_edits_refused(markdown: &str) -> bool {
    markdown_frontmatter_block(markdown).is_some_and(|block| block.entries.is_none())
}

/// The document's frontmatter block, or `None` when it has none or the block
/// does not read as a mapping.
#[must_use]
pub fn markdown_frontmatter_block(markdown: &str) -> Option<MarkdownFrontmatterBlock<'_>> {
    frontmatter_block(markdown)
        .ok()
        .flatten()
        .map(|(block, _)| block)
}

/// Untouched entries must keep their resolved YAML nodes, including types
/// the JSON projection cannot represent and aliases nested inside values.
pub fn frontmatter_preserves_yaml_values(source: &str, candidate: &str, keys: &[&str]) -> bool {
    let values = |text: &str| {
        let (_, root) = frontmatter_block(text).ok()??;
        let Some(root) = root else {
            return Some(BTreeMap::new());
        };
        let FrontmatterNode::Mapping { entries, .. } = root.as_ref() else {
            return None;
        };
        entries
            .iter()
            .map(|(key, value)| Some((frontmatter_node_key(key)?, value.clone())))
            .collect::<Option<BTreeMap<_, _>>>()
    };
    let (Some(before), Some(after)) = (values(source), values(candidate)) else {
        return false;
    };
    keys.iter().all(|key| before.get(*key) == after.get(*key))
}

struct ParsedMarkdownFrontmatter<'a> {
    value: Value,
    body: &'a str,
    non_finite_fields: HashSet<String>,
    unsupported_tag_fields: HashSet<String>,
}

fn parse_markdown_frontmatter(markdown: &str) -> Option<ParsedMarkdownFrontmatter<'_>> {
    Some(match frontmatter_block(markdown).ok()? {
        None => ParsedMarkdownFrontmatter {
            value: Value::Object(serde_json::Map::new()),
            body: markdown,
            non_finite_fields: HashSet::new(),
            unsupported_tag_fields: HashSet::new(),
        },
        Some((block, _)) => ParsedMarkdownFrontmatter {
            value: Value::Object(block.value),
            body: block.body,
            non_finite_fields: block.non_finite_fields,
            unsupported_tag_fields: block.unsupported_tag_fields,
        },
    })
}

pub fn markdown_frontmatter_json(markdown: &str) -> Option<Value> {
    parse_markdown_frontmatter(markdown).map(|frontmatter| frontmatter.value)
}

/// Parse-time field provenance the coerced JSON cannot carry: an unquoted
/// `.nan` and the quoted string `".nan"` both coerce to the string `".nan"`,
/// so only the parse knows which top-level fields held a non-finite YAML
/// number or an unsupported tag.
#[derive(Debug, Default)]
pub struct FrontmatterProvenance {
    pub non_finite_fields: HashSet<String>,
    pub unsupported_tag_fields: HashSet<String>,
}

pub fn markdown_frontmatter_json_with_provenance(
    markdown: &str,
) -> Option<(Value, FrontmatterProvenance)> {
    parse_markdown_frontmatter(markdown).map(|frontmatter| {
        (
            frontmatter.value,
            FrontmatterProvenance {
                non_finite_fields: frontmatter.non_finite_fields,
                unsupported_tag_fields: frontmatter.unsupported_tag_fields,
            },
        )
    })
}

pub fn markdown_frontmatter_json_with_body(markdown: &str) -> Option<(Value, &str)> {
    parse_markdown_frontmatter(markdown).map(|frontmatter| (frontmatter.value, frontmatter.body))
}

fn engine_authored_record_id_range(
    markdown: &str,
    existing_id: &str,
) -> Option<std::ops::Range<usize>> {
    let first_line = markdown.split_inclusive('\n').next()?;
    if !first_line.ends_with('\n') || !is_frontmatter_delimiter(first_line) {
        return None;
    }
    if let Some(open) = frontmatter_flow_mapping_start(markdown) {
        let prefix = format!("{{\"{RECORD_ID_FRONTMATTER_KEY}\":\"");
        let value_start = open + prefix.len();
        if markdown[open..].starts_with(&prefix)
            && markdown[value_start..].starts_with(&format!("{existing_id}\""))
        {
            return Some(value_start..value_start + existing_id.len());
        }
    }
    let id_line_start = first_line.len();
    let id_line = markdown[id_line_start..].split_inclusive('\n').next()?;
    let id_line_content = id_line
        .strip_suffix("\r\n")
        .or_else(|| id_line.strip_suffix('\n'))?;
    let prefix = format!("{RECORD_ID_FRONTMATTER_KEY}: ");
    if id_line_content.strip_prefix(&prefix) != Some(existing_id) {
        return None;
    }
    let value_start = id_line_start + prefix.len();
    Some(value_start..value_start + existing_id.len())
}

fn frontmatter_flow_mapping_start(markdown: &str) -> Option<usize> {
    let mut lines = markdown.split_inclusive('\n');
    let mut offset = lines.next()?.len();
    for line in lines {
        if is_frontmatter_delimiter(line) {
            return None;
        }
        let content = line.trim_start();
        if !content.is_empty() && !content.starts_with('#') {
            return content
                .starts_with('{')
                .then_some(offset + line.len() - content.len());
        }
        offset += line.len();
    }
    None
}

fn validate_record_id_insertion(
    original: &Value,
    adopted: String,
    record_id: &str,
) -> Option<String> {
    let (parsed, _) = markdown_frontmatter_json_with_body(&adopted)?;
    let mut expected = original.as_object()?.clone();
    expected.insert(
        RECORD_ID_FRONTMATTER_KEY.to_owned(),
        Value::String(record_id.to_owned()),
    );
    (parsed == Value::Object(expected)).then_some(adopted)
}

/// Set a collection record id without reserializing the user's Markdown.
///
/// A malformed frontmatter block is not adoptable. Valid frontmatter keeps
/// every existing byte; a document without frontmatter receives the smallest
/// id-only block while its body remains byte-identical. A copied adopted record
/// keeps every byte around its engine-authored id scalar when the id is re-minted.
pub fn collection_record_markdown_with_id(markdown: &str, record_id: &str) -> Option<String> {
    if !is_record_id(record_id) {
        return None;
    }

    let (frontmatter, _) = if markdown.is_empty() {
        (Value::Object(serde_json::Map::new()), markdown)
    } else {
        markdown_frontmatter_json_with_body(markdown)?
    };
    if let Some(existing_id) = frontmatter.get(RECORD_ID_FRONTMATTER_KEY) {
        let existing_id = existing_id.as_str()?;
        if existing_id == record_id {
            return Some(markdown.to_owned());
        }
        let range = engine_authored_record_id_range(markdown, existing_id)?;
        let mut reminted = markdown.to_owned();
        reminted.replace_range(range, record_id);
        return validate_record_id_insertion(&frontmatter, reminted, record_id);
    }

    let first_line = markdown.split_inclusive('\n').next();
    if let Some(first_line) = first_line
        && first_line.ends_with('\n')
        && is_frontmatter_delimiter(first_line)
    {
        let line_ending = if first_line.ends_with("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        if let Some(open) = frontmatter_flow_mapping_start(markdown) {
            let separator = if frontmatter.as_object()?.is_empty() {
                ""
            } else {
                ","
            };
            let mut adopted = markdown.to_owned();
            adopted.insert_str(
                open + 1,
                &format!("\"{RECORD_ID_FRONTMATTER_KEY}\":\"{record_id}\"{separator}"),
            );
            return validate_record_id_insertion(&frontmatter, adopted, record_id);
        }
        let mut adopted = String::with_capacity(
            markdown.len() + RECORD_ID_FRONTMATTER_KEY.len() + record_id.len() + 3,
        );
        adopted.push_str(first_line);
        adopted.push_str(RECORD_ID_FRONTMATTER_KEY);
        adopted.push_str(": ");
        adopted.push_str(record_id);
        adopted.push_str(line_ending);
        adopted.push_str(&markdown[first_line.len()..]);
        return validate_record_id_insertion(&frontmatter, adopted, record_id);
    }

    let line_ending = markdown
        .find('\n')
        .map(|index| {
            if markdown.as_bytes().get(index.wrapping_sub(1)) == Some(&b'\r') {
                "\r\n"
            } else {
                "\n"
            }
        })
        .unwrap_or("\n");
    let mut adopted = String::with_capacity(
        markdown.len() + RECORD_ID_FRONTMATTER_KEY.len() + record_id.len() + 12,
    );
    adopted.push_str("---");
    adopted.push_str(line_ending);
    adopted.push_str(RECORD_ID_FRONTMATTER_KEY);
    adopted.push_str(": ");
    adopted.push_str(record_id);
    adopted.push_str(line_ending);
    adopted.push_str("---");
    if !markdown.is_empty() {
        adopted.push_str(line_ending);
        adopted.push_str(line_ending);
        adopted.push_str(markdown);
    }
    Some(adopted)
}

fn json_field_value(value: &Value) -> CollectionFieldValue {
    match value {
        Value::Null => CollectionFieldValue::Null,
        Value::Bool(value) => CollectionFieldValue::Boolean(*value),
        Value::Number(value) => CollectionFieldValue::Number(value.as_f64().unwrap_or(f64::NAN)),
        Value::String(value) => CollectionFieldValue::Text(value.clone()),
        Value::Array(values) => {
            CollectionFieldValue::Sequence(values.iter().map(json_field_value).collect())
        }
        Value::Object(_) => CollectionFieldValue::Mapping,
    }
}

pub fn collection_value_exceeds_depth(value: &Value, maximum: usize) -> bool {
    let mut pending = vec![(value, 1_usize)];
    while let Some((value, depth)) = pending.pop() {
        if depth > maximum {
            return true;
        }
        match value {
            Value::Array(values) => {
                pending.extend(values.iter().map(|value| (value, depth + 1)));
            }
            Value::Object(values) => {
                pending.extend(values.values().map(|value| (value, depth + 1)));
            }
            _ => {}
        }
    }
    false
}

/// A changed field's value travels whole, on `record.*` events and on
/// automation claims, up to this many bytes of stored JSON.
pub const MAX_FIELD_FACT_VALUE_BYTES: usize = 8 * 1024;

/// A traveling value nests inside its envelope, so it may use only the
/// depth the wire's frame limit leaves for it.
pub const MAX_FIELD_FACT_VALUE_DEPTH: usize = 16;

/// One stored field value parsed to travel whole, or `None` when it is
/// larger or deeper than the bounds above. History keeps every value whole;
/// the bounds cover the transport, not the data.
pub fn field_fact_value(json: &str) -> Option<Value> {
    if json.len() > MAX_FIELD_FACT_VALUE_BYTES {
        return None;
    }
    let value: Value = serde_json::from_str(json).unwrap_or(Value::Null);
    (!collection_value_exceeds_depth(&value, MAX_FIELD_FACT_VALUE_DEPTH)).then_some(value)
}

fn json_text(value: &Value) -> Result<String, crate::DomainError> {
    serde_json::to_string(value)
        .map_err(|error| crate::DomainError::Storage(StorageError::persist_public(error)))
}

fn load_collection_schema(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    collection_path: &str,
) -> Result<CollectionSchema, crate::DomainError> {
    let text: String = conn
        .query_row(
            "SELECT b.text FROM collections c \
             JOIN snapshots s ON s.workspace_id=c.workspace_id \
               AND s.version_id=c.version_id AND s.path=c.schema_path \
             JOIN blobs b ON b.sha256=s.blob_sha256 \
             WHERE c.workspace_id=?1 AND c.version_id=?2 AND c.collection_path=?3",
            params![workspace_id, version_id, collection_path],
            |row| row.get(0),
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    Ok(parse_collection_schema(&text).schema)
}

fn validation_columns(
    field: Option<&FieldDefinition>,
    value: &Value,
    non_finite_number: bool,
    unsupported_tag: bool,
) -> Result<(&'static str, Option<String>), crate::DomainError> {
    if collection_value_exceeds_depth(value, MAX_COLLECTION_FIELD_VALUE_DEPTH) {
        let reason = FieldValueReason {
            code: FieldValueReasonCode::ValueDepthExceeded,
            path: String::new(),
        };
        return Ok((
            "flagged",
            Some(serde_json::to_string(&reason).map_err(|error| {
                crate::DomainError::Storage(StorageError::persist_public(error))
            })?),
        ));
    }
    if unsupported_tag {
        let reason = FieldValueReason {
            code: FieldValueReasonCode::UnsupportedTag,
            path: String::new(),
        };
        return Ok((
            "flagged",
            Some(serde_json::to_string(&reason).map_err(|error| {
                crate::DomainError::Storage(StorageError::persist_public(error))
            })?),
        ));
    }
    let Some(field) = field else {
        return Ok(("untyped", None));
    };
    let value = if non_finite_number {
        CollectionFieldValue::Number(f64::NAN)
    } else {
        json_field_value(value)
    };
    match validate_field_value(field, &value) {
        FieldValueValidation::Valid => Ok(("valid", None)),
        FieldValueValidation::Flagged { reason } => Ok((
            "flagged",
            Some(serde_json::to_string(&reason).map_err(|error| {
                crate::DomainError::Storage(StorageError::persist_public(error))
            })?),
        )),
    }
}

fn insert_relation_edges(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    source_record_id: &str,
    field: &FieldDefinition,
    value: &Value,
) -> Result<(), crate::DomainError> {
    let FieldDefinition::Relation {
        name,
        collection,
        many,
    } = field
    else {
        return Ok(());
    };
    let targets: Vec<&str> = if *many {
        value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|target| is_record_id(target))
            .collect()
    } else {
        value
            .as_str()
            .filter(|target| is_record_id(target))
            .into_iter()
            .collect()
    };
    for target in targets {
        conn.execute(
            "INSERT OR IGNORE INTO collection_relation_edges \
             (workspace_id,version_id,source_record_id,field_name,target_record_id, \
              target_collection_path,many) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                workspace_id,
                version_id,
                source_record_id,
                name,
                target,
                collection,
                many
            ],
        )
        .map_err(crate::DomainError::sql_persist)?;
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum FieldProvenance<'a> {
    Parsed {
        non_finite_fields: &'a HashSet<String>,
        unsupported_tag_fields: &'a HashSet<String>,
    },
    PreserveStored,
}

fn replace_index_for_record(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    record_id: &str,
    schema: &CollectionSchema,
    frontmatter: &Value,
    field_provenance: FieldProvenance<'_>,
) -> Result<(), crate::DomainError> {
    let index_initialized = frontmatter.as_object().is_some_and(|values| {
        values
            .keys()
            .any(|field_name| field_name != RECORD_ID_FRONTMATTER_KEY)
    });
    let (mut non_finite_fields, mut unsupported_tag_fields) = match field_provenance {
        FieldProvenance::Parsed {
            non_finite_fields,
            unsupported_tag_fields,
        } => (non_finite_fields.clone(), unsupported_tag_fields.clone()),
        FieldProvenance::PreserveStored => (HashSet::new(), HashSet::new()),
    };
    if matches!(field_provenance, FieldProvenance::PreserveStored) {
        let mut statement = conn
            .prepare(
                "SELECT field_name,value_json,validation_reason_json \
                 FROM collection_record_fields \
                 WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3 \
                   AND validation_status='flagged'",
            )
            .map_err(crate::DomainError::sql_corrupt)?;
        let previous_fields = statement
            .query_map(params![workspace_id, version_id, record_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(crate::DomainError::sql_corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(crate::DomainError::sql_corrupt)?;
        drop(statement);
        for (field_name, previous_value_json, reason_json) in previous_fields {
            let Some(value) = frontmatter.get(field_name.as_str()) else {
                continue;
            };
            let previous_value: Value =
                serde_json::from_str(&previous_value_json).map_err(|error| {
                    crate::DomainError::Storage(StorageError::corrupt_public(error))
                })?;
            if !collection_values_equal(value, &previous_value) {
                continue;
            }
            let Some(reason_json) = reason_json else {
                continue;
            };
            let reason: FieldValueReason = serde_json::from_str(&reason_json).map_err(|error| {
                crate::DomainError::Storage(StorageError::corrupt_public(error))
            })?;
            if reason.code == FieldValueReasonCode::NumberNotFinite {
                non_finite_fields.insert(field_name);
            } else if reason.code == FieldValueReasonCode::UnsupportedTag {
                unsupported_tag_fields.insert(field_name);
            }
        }
    }
    conn.execute(
        "DELETE FROM collection_record_fields \
         WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3",
        params![workspace_id, version_id, record_id],
    )
    .map_err(crate::DomainError::sql_persist)?;
    conn.execute(
        "DELETE FROM collection_relation_edges \
         WHERE workspace_id=?1 AND version_id=?2 AND source_record_id=?3",
        params![workspace_id, version_id, record_id],
    )
    .map_err(crate::DomainError::sql_persist)?;
    let mut fields = HashMap::<&str, &FieldDefinition>::new();
    let mut colliding_fields = HashSet::<&str>::new();
    for field in &schema.fields {
        if colliding_fields.contains(field.name()) {
            continue;
        }
        if fields.insert(field.name(), field).is_some() {
            fields.remove(field.name());
            colliding_fields.insert(field.name());
        }
    }
    if let Some(values) = frontmatter.as_object() {
        for (field_name, value) in values {
            if field_name == RECORD_ID_FRONTMATTER_KEY {
                continue;
            }
            let field = fields.get(field_name.as_str()).copied();
            let (validation_status, validation_reason_json) = validation_columns(
                field,
                value,
                non_finite_fields.contains(field_name),
                unsupported_tag_fields.contains(field_name),
            )?;
            conn.execute(
                "INSERT INTO collection_record_fields \
                 (workspace_id,version_id,record_id,field_name,value_json, \
                  validation_status,validation_reason_json) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    workspace_id,
                    version_id,
                    record_id,
                    field_name,
                    json_text(value)?,
                    validation_status,
                    validation_reason_json,
                ],
            )
            .map_err(crate::DomainError::sql_persist)?;
            if let Some(field) = field
                && !unsupported_tag_fields.contains(field_name)
            {
                insert_relation_edges(conn, workspace_id, version_id, record_id, field, value)?;
            }
        }
    }
    // Latched: a record that has announced itself (any field ever indexed)
    // stays initialized when its fields are cleared, so the next edit reads
    // as changed, never as a second creation.
    conn.execute(
        "UPDATE collection_records SET index_initialized=index_initialized OR ?4 \
         WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3",
        params![workspace_id, version_id, record_id, index_initialized],
    )
    .map_err(crate::DomainError::sql_persist)?;
    Ok(())
}

fn record_has_unsupported_tag_flag(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    record_id: &str,
) -> Result<bool, crate::DomainError> {
    let reason = serde_json::to_string(&FieldValueReason {
        code: FieldValueReasonCode::UnsupportedTag,
        path: String::new(),
    })
    .map_err(|error| crate::DomainError::Storage(StorageError::persist_public(error)))?;
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM collection_record_fields \
         WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3 \
           AND validation_status='flagged' AND validation_reason_json=?4)",
        params![workspace_id, version_id, record_id, reason],
        |row| row.get(0),
    )
    .map_err(crate::DomainError::sql_corrupt)
}

fn bound_record(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<Option<(String, String, bool)>, crate::DomainError> {
    conn.query_row(
        "SELECT record_id,collection_path,index_initialized FROM collection_records \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
           AND record_id IS NOT NULL",
        params![workspace_id, version_id, object_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .optional()
    .map_err(crate::DomainError::sql_corrupt)
}

/// Whether an object is the bound file for a collection record.
pub fn is_collection_record_bound_in_tx(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<bool, crate::DomainError> {
    Ok(bound_record(conn, workspace_id, version_id, object_id)?.is_some())
}

/// Whether any changed collection record's canonical `id` key differs from
/// the record id already bound to that path. Capture calls this after the
/// changed bytes are durable and before deciding whether reconciliation is
/// necessary, so ordinary field/body edits stay on the indexing fast path.
pub fn collection_record_id_mismatch_in_tx(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    paths: &[String],
) -> Result<bool, crate::DomainError> {
    let mut statement = conn
        .prepare(
            "SELECT r.record_id,b.text FROM collection_records r \
             LEFT JOIN snapshots s ON s.workspace_id=r.workspace_id \
               AND s.version_id=r.version_id AND s.path=r.file_path \
               AND s.object_id=r.object_id \
             LEFT JOIN blobs b ON b.sha256=s.blob_sha256 \
             WHERE r.workspace_id=?1 AND r.version_id=?2 AND r.file_path=?3 \
               AND r.record_id IS NOT NULL",
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    for path in paths {
        let binding = statement
            .query_row(params![workspace_id, version_id, path], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .optional()
            .map_err(crate::DomainError::sql_corrupt)?;
        let Some((record_id, text)) = binding else {
            return Ok(true);
        };
        let canonical_id = text.as_deref().and_then(markdown_record_id);
        if canonical_id.as_deref() != Some(record_id.as_str()) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Replace one bound record's local projection with its applied Y.Map state.
pub fn synchronize_collection_frontmatter_index_in_tx(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    frontmatter: &Value,
) -> Result<(), crate::DomainError> {
    let Some((record_id, collection_path, _)) =
        bound_record(conn, workspace_id, version_id, object_id)?
    else {
        return Ok(());
    };
    let schema = load_collection_schema(conn, workspace_id, version_id, &collection_path)?;
    replace_index_for_record(
        conn,
        workspace_id,
        version_id,
        &record_id,
        &schema,
        frontmatter,
        FieldProvenance::PreserveStored,
    )
}

/// The kind of actor a write declared on the seam it took.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeActorKind {
    Human,
    Agent,
    Automation,
}

impl ChangeActorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeActorKind::Human => "human",
            ChangeActorKind::Agent => "agent",
            ChangeActorKind::Automation => "automation",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "human" => Some(ChangeActorKind::Human),
            "agent" => Some(ChangeActorKind::Agent),
            "automation" => Some(ChangeActorKind::Automation),
            _ => None,
        }
    }
}

/// Declared write provenance beside `author_origin_id`: the actor kind, the
/// person it acted for, its automation-chain depth, and for an automation
/// the run that wrote it. The person is an account id, or a signed-out
/// computer's installation id: the person typing, the person an agent works
/// for, or the person whose change started an automation. Optional
/// provenance, never a second authority — the storage and permission
/// boundaries stay identical with or without it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeAttribution {
    pub actor_kind: ChangeActorKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_behalf_of: Option<String>,
    #[serde(default)]
    pub depth: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<AutomationRunAttribution>,
}

/// A person the owner shared with, or an Edit share link, whose change the
/// relay accepted from its own authentication: never a claim a client made.
/// It names who changed a record on the computer that claims the change, so
/// a run can say who started it. A link is its grant and generation, with
/// the server-minted principal that tells its browser sessions apart; it is
/// never a person's account. Provenance only, never authority: the run still
/// acts as the automation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum SharedChangeAuthor {
    #[serde(rename = "named")]
    Named {
        #[serde(rename = "userId")]
        user_id: String,
        #[serde(rename = "grantId")]
        grant_id: String,
        #[serde(rename = "grantGeneration")]
        grant_generation: i64,
    },
    #[serde(rename = "link")]
    Link {
        #[serde(rename = "grantId")]
        grant_id: String,
        #[serde(rename = "grantGeneration")]
        grant_generation: i64,
        #[serde(rename = "principalId")]
        principal_id: String,
    },
}

impl SharedChangeAuthor {
    /// Every id is present and bounded, and the generation is a real one.
    pub fn is_valid(&self) -> bool {
        let (ids, generation) = match self {
            Self::Named {
                user_id,
                grant_id,
                grant_generation,
            } => ([user_id, grant_id], *grant_generation),
            Self::Link {
                grant_id,
                grant_generation,
                principal_id,
            } => ([grant_id, principal_id], *grant_generation),
        };
        ids.iter().all(|id| !id.is_empty() && id.len() <= 512)
            && (1..=9_007_199_254_740_991).contains(&generation)
    }
}

/// The automation run a write came from: the claim it ran for, and the
/// automation's name when it ran. Record history names the automation by
/// it after the definition changes or goes, and opens the run by its claim
/// on the computer that ran it. Another computer keeps the name; its claim
/// names a run that computer does not have.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationRunAttribution {
    pub claim_id: String,
    pub automation_name: String,
}

/// The longest automation name a run attribution carries, in bytes.
pub const MAX_AUTOMATION_RUN_NAME_BYTES: usize = 1024;

/// The most automation hops any declared chain may report. Bounds the wire,
/// not the loop guard: the executor's stop-at-depth rule owns the product
/// limit.
pub const MAX_CHANGE_ATTRIBUTION_DEPTH: u32 = 64;

/// The chain depth an agent author names: 1 to
/// [`MAX_CHANGE_ATTRIBUTION_DEPTH`], in a run an automation started. A run a
/// person started names none. Older builds stored an agent author without
/// checking a depth, so any other value, 0 included, reads as none.
pub fn agent_author_depth(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(Value::as_u64)
        .and_then(|depth| u32::try_from(depth).ok())
        .filter(|depth| (1..=MAX_CHANGE_ATTRIBUTION_DEPTH).contains(depth))
}

/// The entries of a moment's recorded authors. `author_json` is a list with
/// one entry per author the moment covers, or NULL when it names none. A
/// value that is not a list names none.
pub fn moment_author_entries(author_json: Option<&str>) -> Vec<Value> {
    match author_json.and_then(|json| serde_json::from_str::<Value>(json).ok()) {
        Some(Value::Array(entries)) => entries,
        _ => Vec::new(),
    }
}

/// The actor and attribution a moment's recorded authors declare, when they
/// name exactly one author. An agent (`{kind: "agent", agentId, onBehalfOf,
/// depth?}`) writes as itself at its run's depth ([`agent_author_depth`]), 0
/// when it names none; an automation (`{kind: "automation", automationId,
/// onBehalfOf, depth}`) writes as itself at its depth; a person (`{kind:
/// "human", humanId, onBehalfOf?}`) writes as themself at depth 0. Several
/// authors, any other author, or none declare neither. The chain depth of
/// several authors is [`moment_author_depth`].
pub fn moment_author_attribution(
    author_json: Option<&str>,
) -> (Option<String>, Option<ChangeAttribution>) {
    match moment_author_entries(author_json).as_slice() {
        [author] => author_entry_attribution(author),
        _ => (None, None),
    }
}

/// The deepest automation chain any of a moment's authors declares, so a
/// change several authors made still stops at the chain cap.
pub fn moment_author_depth(author_json: Option<&str>) -> u32 {
    moment_author_entries(author_json)
        .iter()
        .filter_map(|author| author_entry_attribution(author).1)
        .map(|attribution| attribution.depth)
        .max()
        .unwrap_or(0)
}

fn author_entry_attribution(author: &Value) -> (Option<String>, Option<ChangeAttribution>) {
    let text = |key: &str| {
        author
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let (actor, actor_kind, depth) = match author.get("kind").and_then(Value::as_str) {
        Some("agent") => (
            text("agentId"),
            ChangeActorKind::Agent,
            agent_author_depth(author.get("depth")).unwrap_or(0),
        ),
        Some("automation") => (
            text("automationId"),
            ChangeActorKind::Automation,
            author
                .get("depth")
                .and_then(Value::as_u64)
                .map_or(0, |depth| {
                    u32::try_from(depth)
                        .unwrap_or(MAX_CHANGE_ATTRIBUTION_DEPTH)
                        .min(MAX_CHANGE_ATTRIBUTION_DEPTH)
                }),
        ),
        Some("human") => (text("humanId"), ChangeActorKind::Human, 0),
        _ => return (None, None),
    };
    let Some(actor) = actor else {
        return (None, None);
    };
    let attribution = ChangeAttribution {
        actor_kind,
        on_behalf_of: if actor_kind == ChangeActorKind::Human {
            Some(actor.clone())
        } else {
            text("onBehalfOf")
        },
        depth,
        run: None,
    };
    (Some(actor), Some(attribution))
}

/// The authors a moment records for a write made by `actor` with
/// `attribution`: a list of one, the inverse of
/// [`moment_author_attribution`]. A write that names no actor or no
/// attribution records none.
pub fn moment_author_json(
    actor_origin_id: Option<&str>,
    attribution: Option<&ChangeAttribution>,
) -> Option<String> {
    let actor = actor_origin_id?;
    let attribution = attribution?;
    let mut author = match attribution.actor_kind {
        // An agent run a person started writes at depth 0 and names none.
        ChangeActorKind::Agent if attribution.depth == 0 => serde_json::json!({
            "kind": "agent",
            "agentId": actor,
        }),
        ChangeActorKind::Agent => serde_json::json!({
            "kind": "agent",
            "agentId": actor,
            "depth": attribution.depth,
        }),
        ChangeActorKind::Automation => serde_json::json!({
            "kind": "automation",
            "automationId": actor,
            "depth": attribution.depth,
        }),
        ChangeActorKind::Human => serde_json::json!({
            "kind": "human",
            "humanId": actor,
        }),
    };
    if let Some(on_behalf_of) = &attribution.on_behalf_of {
        author["onBehalfOf"] = serde_json::json!(on_behalf_of);
    }
    Some(Value::Array(vec![author]).to_string())
}

/// A single declared author as the list a moment records.
pub fn moment_author_list_json(author: &Value) -> String {
    Value::Array(vec![author.clone()]).to_string()
}

impl ChangeAttribution {
    /// Bounds every declared field. Both wire entry points (the engine's
    /// `ydoc.recordUpdate` params and the replicated `ydoc.update` payload)
    /// refuse an attribution that fails this, so storage only ever holds
    /// bounded values.
    pub fn validate(&self) -> Result<(), &'static str> {
        if let Some(on_behalf_of) = &self.on_behalf_of
            && (on_behalf_of.is_empty()
                || on_behalf_of.len() > dohc_engine_storage::MAX_IDENTIFIER_BYTES
                || on_behalf_of.chars().any(char::is_control))
        {
            return Err("attribution onBehalfOf must be non-empty and bounded");
        }
        if self.depth > MAX_CHANGE_ATTRIBUTION_DEPTH {
            return Err("attribution depth exceeds the supported chain bound");
        }
        if let Some(run) = &self.run {
            if self.actor_kind != ChangeActorKind::Automation {
                return Err("only an automation's attribution names a run");
            }
            if run.claim_id.is_empty()
                || run.claim_id.len() > dohc_engine_storage::MAX_IDENTIFIER_BYTES
                || run.claim_id.chars().any(char::is_control)
            {
                return Err("attribution run claim id must be non-empty and bounded");
            }
            if run.automation_name.trim().is_empty()
                || run.automation_name.len() > MAX_AUTOMATION_RUN_NAME_BYTES
                || run.automation_name.chars().any(char::is_control)
            {
                return Err("attribution run automation name must be non-empty and bounded");
            }
        }
        Ok(())
    }
}

/// One applied field difference, exactly as its history row was recorded.
/// Values stay as the stored JSON text; the event layer decides parsing and
/// size bounds. Serialized device-locally onto a parked update's deferred
/// coordinate so a drain retry can surface facts an earlier failed drain
/// already committed — never a wire shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionFieldChangeFact {
    pub field_name: String,
    pub previous_json: Option<String>,
    pub next_json: Option<String>,
    /// The device-local `collection_field_history` rowid. A subscriber that
    /// misses events reads history past its last seen id.
    pub history_id: i64,
}

/// What one applied Y.Doc update did to a bound collection record. `created`
/// is true when this apply indexed field content for a binding reconciliation
/// inserted without any (a fresh record file carries only the engine-owned
/// id until its first field write).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionRecordApplyFacts {
    pub collection_path: String,
    pub record_id: String,
    pub created: bool,
    pub author_origin_id: Option<String>,
    pub attribution: Option<ChangeAttribution>,
    /// Who the relay accepted a live-shared record's change from, when that
    /// was a person the owner shared with or an Edit share link. Set only by
    /// the session host, from the relay's authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_author: Option<SharedChangeAuthor>,
    /// The relay's live journal cursor of the frame this change came in,
    /// set only by the session host that accepted it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_cursor: Option<i64>,
    /// The replication coordinate of the op this apply came from:
    /// `(origin_id, origin_seq)`. A replicated apply carries the envelope's
    /// coordinate; a local apply carries its own journaled coordinate, set by
    /// the runtime after the outbound journal assigns it. `None` for a
    /// never-synced lineage, whose only durable per-change key is the history
    /// row id.
    pub source: Option<(String, i64)>,
    pub recorded_at_ms: i64,
    pub fields: Vec<CollectionFieldChangeFact>,
}

fn history_value(value: Option<&Value>) -> Result<Option<String>, crate::DomainError> {
    value.map(json_text).transpose()
}

#[allow(clippy::too_many_arguments)]
fn insert_field_history(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    record_id: &str,
    field_name: &str,
    previous: Option<&Value>,
    next: Option<&Value>,
    author_origin_id: Option<&str>,
    attribution: Option<&ChangeAttribution>,
    source_update: Option<(&str, i64)>,
    recorded_at_ms: i64,
) -> Result<Option<i64>, crate::DomainError> {
    let (source_origin_id, source_origin_seq) = source_update
        .map(|(origin_id, origin_seq)| (Some(origin_id), Some(origin_seq)))
        .unwrap_or((None, None));
    let run = attribution.and_then(|attribution| attribution.run.as_ref());
    let inserted = conn
        .execute(
            "INSERT INTO collection_field_history \
         (workspace_id,version_id,record_id,field_name,previous_value_json, \
          next_value_json,author_origin_id,source_origin_id,source_origin_seq, \
          actor_kind,on_behalf_of,chain_depth,recorded_at_ms, \
          automation_claim_id,automation_name) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15) \
         ON CONFLICT(workspace_id,version_id,record_id,field_name, \
                     source_origin_id,source_origin_seq) \
         WHERE source_origin_id IS NOT NULL DO NOTHING",
            params![
                workspace_id,
                version_id,
                record_id,
                field_name,
                history_value(previous)?,
                history_value(next)?,
                author_origin_id,
                source_origin_id,
                source_origin_seq,
                attribution.map(|attribution| attribution.actor_kind.as_str()),
                attribution.and_then(|attribution| attribution.on_behalf_of.as_deref()),
                attribution.map(|attribution| i64::from(attribution.depth)),
                recorded_at_ms,
                run.map(|run| run.claim_id.as_str()),
                run.map(|run| run.automation_name.as_str()),
            ],
        )
        .map_err(crate::DomainError::sql_persist)?;
    // A conflict-skipped insert (an already-recorded source coordinate) is a
    // replay: no new row, no new fact.
    Ok((inserted == 1).then(|| conn.last_insert_rowid()))
}

/// Diff the applied frontmatter state, append attributed field history, and
/// replace the current index in the same transaction as the Y.Doc append.
/// `authored_before` and `authored_after` are the update applied to the
/// lineage's seq-0 base. They preserve an independent concurrent map write
/// that Yjs resolves away in the final map.
#[allow(clippy::too_many_arguments)]
pub fn index_collection_frontmatter_apply_in_tx(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    before: &Value,
    after: &Value,
    authored_before: &Value,
    authored_after: &Value,
    after_provenance: Option<&FrontmatterProvenance>,
    author_origin_id: Option<&str>,
    attribution: Option<&ChangeAttribution>,
    source_update: Option<(&str, i64)>,
    recorded_at_ms: i64,
) -> Result<Option<CollectionRecordApplyFacts>, crate::DomainError> {
    let Some((record_id, collection_path, index_initialized)) =
        bound_record(conn, workspace_id, version_id, object_id)?
    else {
        return Ok(None);
    };
    let mut field_facts = Vec::new();
    let before = before.as_object();
    let after_object = after.as_object();
    let authored_before = authored_before.as_object();
    let authored_after = authored_after.as_object();
    let applied_frontmatter_unchanged = collection_mappings_equal(before, after_object);
    let authored_frontmatter_unchanged = collection_mappings_equal(authored_before, authored_after);
    let mut keys = HashSet::new();
    if let Some(values) = before {
        keys.extend(values.keys().map(String::as_str));
    }
    if let Some(values) = after_object {
        keys.extend(values.keys().map(String::as_str));
    }
    let mut keys = keys.into_iter().collect::<Vec<_>>();
    keys.sort_unstable();
    for field_name in keys {
        if field_name == RECORD_ID_FRONTMATTER_KEY {
            continue;
        }
        let previous = before.and_then(|values| values.get(field_name));
        let next = after_object.and_then(|values| values.get(field_name));
        if !optional_collection_values_equal(previous, next) {
            let history_id = insert_field_history(
                conn,
                workspace_id,
                version_id,
                &record_id,
                field_name,
                previous,
                next,
                author_origin_id,
                attribution,
                source_update,
                recorded_at_ms,
            )?;
            if let Some(history_id) = history_id {
                field_facts.push(CollectionFieldChangeFact {
                    field_name: field_name.to_owned(),
                    previous_json: history_value(previous)?,
                    next_json: history_value(next)?,
                    history_id,
                });
            }
        }
    }
    let mut authored_keys = HashSet::new();
    if let Some(values) = authored_before {
        authored_keys.extend(values.keys().map(String::as_str));
    }
    if let Some(values) = authored_after {
        authored_keys.extend(values.keys().map(String::as_str));
    }
    let mut authored_keys = authored_keys.into_iter().collect::<Vec<_>>();
    authored_keys.sort_unstable();
    for field_name in authored_keys {
        if field_name == RECORD_ID_FRONTMATTER_KEY {
            continue;
        }
        let previous = before.and_then(|values| values.get(field_name));
        let applied = after_object.and_then(|values| values.get(field_name));
        let authored_previous = authored_before.and_then(|values| values.get(field_name));
        let authored_next = authored_after.and_then(|values| values.get(field_name));
        // A delta update carries the author's full delete set, so replaying it
        // on the lineage base deletes items earlier updates already replaced
        // and reads as a removal the author never made. Inserts come only
        // from the author, so an authored change with a present next value is
        // genuine; an authored `-> absent` cannot be told apart from that
        // replay artifact and is never journaled.
        if optional_collection_values_equal(previous, applied)
            && !optional_collection_values_equal(authored_previous, authored_next)
            && authored_next.is_some()
        {
            let history_id = insert_field_history(
                conn,
                workspace_id,
                version_id,
                &record_id,
                field_name,
                authored_previous,
                authored_next,
                author_origin_id,
                attribution,
                source_update,
                recorded_at_ms,
            )?;
            if let Some(history_id) = history_id {
                field_facts.push(CollectionFieldChangeFact {
                    field_name: field_name.to_owned(),
                    previous_json: history_value(authored_previous)?,
                    next_json: history_value(authored_next)?,
                    history_id,
                });
            }
        }
    }
    // Parsed provenance can change a field's validation without changing its
    // coerced value: `estimate: .nan` and `estimate: ".nan"` both index as
    // the string ".nan" but flag for different reasons, so a caller that
    // supplied provenance always reindexes.
    if applied_frontmatter_unchanged && authored_frontmatter_unchanged && after_provenance.is_none()
    {
        return Ok(None);
    }
    let schema = load_collection_schema(conn, workspace_id, version_id, &collection_path)?;
    replace_index_for_record(
        conn,
        workspace_id,
        version_id,
        &record_id,
        &schema,
        after,
        // A caller that parsed the after state from Markdown knows which
        // fields held a non-finite number before coercion; without it, keep
        // the stored reasons.
        match after_provenance {
            Some(provenance) => FieldProvenance::Parsed {
                non_finite_fields: &provenance.non_finite_fields,
                unsupported_tag_fields: &provenance.unsupported_tag_fields,
            },
            None => FieldProvenance::PreserveStored,
        },
    )?;
    // An apply whose every history insert deduped is a replay of facts this
    // device already surfaced once.
    if field_facts.is_empty() {
        return Ok(None);
    }
    // The applied and authored loops are each field-name sorted and mutually
    // exclusive per field; one sort restores the settled emission order.
    field_facts.sort_by(|a, b| a.field_name.cmp(&b.field_name));
    Ok(Some(CollectionRecordApplyFacts {
        collection_path,
        record_id,
        created: !index_initialized,
        author_origin_id: author_origin_id.map(str::to_owned),
        attribution: attribution.cloned(),
        shared_author: None,
        live_cursor: None,
        source: source_update.map(|(origin_id, origin_seq)| (origin_id.to_owned(), origin_seq)),
        recorded_at_ms,
        fields: field_facts,
    }))
}

/// Index a bound record's frontmatter from a file written on this computer,
/// for a record whose Y.Doc lineage holds no content to fold the write into:
/// the file is then the only record of the write. The record's current
/// index is the before side, so the diff also carries any earlier write the
/// index missed. Writes field history, replaces the index, and returns the
/// facts, exactly as a Y.Doc apply does. A body-only write reads the index
/// and changes nothing.
#[allow(clippy::too_many_arguments)]
pub fn index_collection_record_text_in_tx(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    path: &str,
    text: &str,
    author_origin_id: Option<&str>,
    attribution: Option<&ChangeAttribution>,
    recorded_at_ms: i64,
) -> Result<Option<CollectionRecordApplyFacts>, crate::DomainError> {
    if !is_collection_markdown_path(path) {
        return Ok(None);
    }
    let Some((record_id, _, _)) = bound_record(conn, workspace_id, version_id, object_id)? else {
        return Ok(None);
    };
    // Frontmatter that does not parse leaves the record to reconcile.
    let Some((after, provenance)) = markdown_frontmatter_json_with_provenance(text) else {
        return Ok(None);
    };
    let mut before = serde_json::Map::new();
    for (field_name, value_json) in
        indexed_record_fields(conn, workspace_id, version_id, &record_id)?
    {
        let value = serde_json::from_str(&value_json)
            .map_err(|error| crate::DomainError::Storage(StorageError::corrupt_public(error)))?;
        before.insert(field_name, value);
    }
    let after_fields = after.as_object().map(|values| {
        values
            .iter()
            .filter(|(field_name, _)| *field_name != RECORD_ID_FRONTMATTER_KEY)
            .map(|(field_name, value)| (field_name.clone(), value.clone()))
            .collect::<serde_json::Map<_, _>>()
    });
    if collection_mappings_equal(Some(&before), after_fields.as_ref()) {
        // Equal values can still validate differently (`estimate: .nan`
        // against `estimate: ".nan"`). Reindex, without a change, when the
        // file or the index flags a value.
        let flagged_before: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM collection_record_fields \
                 WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3 \
                   AND validation_status='flagged')",
                params![workspace_id, version_id, record_id],
                |row| row.get(0),
            )
            .map_err(crate::DomainError::sql_corrupt)?;
        if !flagged_before
            && provenance.non_finite_fields.is_empty()
            && provenance.unsupported_tag_fields.is_empty()
        {
            return Ok(None);
        }
    }
    let before = Value::Object(before);
    index_collection_frontmatter_apply_in_tx(
        conn,
        workspace_id,
        version_id,
        object_id,
        &before,
        &after,
        &before,
        &after,
        Some(&provenance),
        author_origin_id,
        attribution,
        None,
        recorded_at_ms,
    )
}

fn revalidate_collection_index_in_tx(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    collection_schemas: &HashMap<&str, &CollectionSchema>,
) -> Result<(), crate::DomainError> {
    let mut statement = conn
        .prepare(
            "SELECT r.record_id,r.collection_path,f.field_name,f.value_json \
             FROM collection_records r \
             LEFT JOIN collection_record_fields f \
               ON f.workspace_id=r.workspace_id AND f.version_id=r.version_id \
              AND f.record_id=r.record_id \
             WHERE r.workspace_id=?1 AND r.version_id=?2 AND r.record_id IS NOT NULL \
             ORDER BY r.record_id,f.field_name",
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    let rows = statement
        .query_map(params![workspace_id, version_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(crate::DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::DomainError::sql_corrupt)?;
    drop(statement);
    let mut records: HashMap<(String, String), serde_json::Map<String, Value>> = HashMap::new();
    for (record_id, collection_path, field_name, value_json) in rows {
        let values = records.entry((record_id, collection_path)).or_default();
        if let (Some(field_name), Some(value_json)) = (field_name, value_json) {
            let value = serde_json::from_str(&value_json).map_err(|error| {
                crate::DomainError::Storage(StorageError::corrupt_public(error))
            })?;
            values.insert(field_name, value);
        }
    }
    for ((record_id, collection_path), values) in records {
        let Some(schema) = collection_schemas.get(collection_path.as_str()).copied() else {
            continue;
        };
        replace_index_for_record(
            conn,
            workspace_id,
            version_id,
            &record_id,
            schema,
            &Value::Object(values),
            FieldProvenance::PreserveStored,
        )?;
    }
    Ok(())
}

fn dangling_relation_cleanups(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    present_malformed_record_ids: &HashSet<String>,
) -> Result<Vec<CollectionRelationCleanupCandidate>, crate::DomainError> {
    let mut statement = conn
        .prepare(
            "SELECT e.source_record_id,r.file_path,r.object_id,e.field_name, \
                    e.target_record_id,e.many,e.target_collection_path \
             FROM collection_relation_edges e \
             JOIN collection_records r ON r.workspace_id=e.workspace_id \
               AND r.version_id=e.version_id AND r.record_id=e.source_record_id \
             WHERE e.workspace_id=?1 AND e.version_id=?2 \
               AND NOT EXISTS (SELECT 1 FROM collection_records target \
                 WHERE target.workspace_id=e.workspace_id \
                   AND target.version_id=e.version_id \
                   AND target.record_id=e.target_record_id \
                   AND target.collection_path=e.target_collection_path) \
             ORDER BY r.file_path,e.field_name,e.target_record_id",
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    let cleanups = statement
        .query_map(params![workspace_id, version_id], |row| {
            Ok((
                CollectionRelationCleanupCandidate {
                    source_record_id: row.get(0)?,
                    source_file_path: row.get(1)?,
                    source_object_id: row.get(2)?,
                    field_name: row.get(3)?,
                    target_record_id: row.get(4)?,
                    many: row.get(5)?,
                },
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(crate::DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::DomainError::sql_corrupt)?;
    let unindexed_or_conflicted_targets = unindexed_or_conflicted_relation_targets_still_present(
        conn,
        workspace_id,
        version_id,
        cleanups
            .iter()
            .filter(|(cleanup, _)| {
                !present_malformed_record_ids.contains(&cleanup.target_record_id)
            })
            .map(|(cleanup, collection_path)| {
                (cleanup.target_record_id.clone(), collection_path.clone())
            })
            .collect(),
    )?;
    Ok(cleanups
        .into_iter()
        .filter_map(|(cleanup, collection_path)| {
            (!present_malformed_record_ids.contains(&cleanup.target_record_id)
                && !unindexed_or_conflicted_targets
                    .contains(&(cleanup.target_record_id.clone(), collection_path)))
            .then_some(cleanup)
        })
        .collect())
}

fn unindexed_or_conflicted_relation_targets_still_present(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    targets: HashSet<(String, String)>,
) -> Result<HashSet<(String, String)>, crate::DomainError> {
    let mut targets_by_collection: HashMap<String, HashSet<String>> = HashMap::new();
    for (record_id, collection_path) in targets {
        targets_by_collection
            .entry(collection_path)
            .or_default()
            .insert(record_id);
    }
    if targets_by_collection.is_empty() {
        return Ok(HashSet::new());
    }

    let mut statement = conn
        .prepare(
            "SELECT witness.text FROM (\
               SELECT s.path,b.text,0 AS moment_order FROM snapshots s \
               JOIN blobs b ON b.sha256=s.blob_sha256 \
               WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.content_kind='text' \
                 AND lower(substr(s.path,-3))='.md' \
                 AND substr(s.path,1,length(?3))=?3 \
                 AND substr(s.path,length(?3)+1,1)='/' \
                 AND instr(substr(s.path,length(?3)+2),'/')=0 \
               UNION ALL \
               SELECT s.path,b.text,m.moment_order FROM snapshots s \
               JOIN moments m ON m.workspace_id=s.workspace_id AND m.version_id=s.version_id \
                 AND m.object_id=s.object_id \
               JOIN blobs b ON b.sha256=m.after_blob_sha256 \
               WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.content_kind='text' \
                 AND m.after_content_kind='text' AND lower(substr(s.path,-3))='.md' \
                 AND substr(s.path,1,length(?3))=?3 \
                 AND substr(s.path,length(?3)+1,1)='/' \
                 AND instr(substr(s.path,length(?3)+2),'/')=0 \
                 AND EXISTS (SELECT 1 FROM conflicts c \
                   WHERE c.workspace_id=s.workspace_id \
                     AND c.target_version_id=s.version_id AND c.status='open' \
                     AND (c.current_object_id=s.object_id \
                       OR c.incoming_object_id=s.object_id OR c.path=s.path))\
             ) witness ORDER BY witness.path,witness.moment_order DESC",
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    let mut present = HashSet::new();
    for (collection_path, wanted_ids) in targets_by_collection {
        let mut matched_count = 0_usize;
        let rows = statement
            .query_map(params![workspace_id, version_id, collection_path], |row| {
                row.get::<_, String>(0)
            })
            .map_err(crate::DomainError::sql_corrupt)?;
        for text in rows {
            let text = text.map_err(crate::DomainError::sql_corrupt)?;
            let Some(record_id) = markdown_record_id(&text).filter(|id| wanted_ids.contains(id))
            else {
                continue;
            };
            if present.insert((record_id, collection_path.clone())) {
                matched_count += 1;
            }
            if matched_count == wanted_ids.len() {
                break;
            }
        }
    }
    Ok(present)
}

fn load_collection_snapshots(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
) -> Result<Vec<CollectionSnapshot>, crate::DomainError> {
    let mut statement = conn
        .prepare(
            "WITH collection_prefixes(prefix) AS MATERIALIZED (\
               SELECT substr(schema.path,1,length(schema.path)-length(?3)-1) \
               FROM snapshots schema \
               WHERE schema.workspace_id=?1 AND schema.version_id=?2 \
                 AND schema.content_kind='text' AND schema.path<>?3 \
                 AND length(schema.path)>length(?3)+1 \
                 AND substr(schema.path,-(length(?3)+1))='/'||?3\
             ), collection_snapshots(path,object_id,blob_sha256) AS MATERIALIZED (\
               SELECT s.path,s.object_id,s.blob_sha256 FROM snapshots s \
               WHERE s.workspace_id=?1 AND s.version_id=?2 \
                 AND s.content_kind='text' \
                 AND (s.path=?3 \
                   OR substr(s.path,-(length(?3)+1))='/'||?3 \
                   OR (lower(substr(s.path,-3))='.md' AND EXISTS (\
                     SELECT 1 FROM collection_prefixes c \
                     WHERE substr(s.path,1,length(c.prefix))=c.prefix \
                       AND substr(s.path,length(c.prefix)+1,1)='/' \
                       AND instr(substr(s.path,length(c.prefix)+2),'/')=0\
                   )))\
             ) \
             SELECT s.path,s.object_id,b.text FROM collection_snapshots s \
             JOIN blobs b ON b.sha256=s.blob_sha256 \
             ORDER BY s.path",
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    statement
        .query_map(
            params![workspace_id, version_id, COLLECTION_SCHEMA_FILENAME],
            |row| {
                Ok(CollectionSnapshot {
                    path: row.get(0)?,
                    object_id: row.get(1)?,
                    text: row.get(2)?,
                })
            },
        )
        .map_err(crate::DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::DomainError::sql_corrupt)
}

fn load_record_bindings(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
) -> Result<Vec<ExistingRecordBinding>, crate::DomainError> {
    let mut statement = conn
        .prepare(
            "SELECT record_id, file_path, object_id, adoption_state, index_initialized \
             FROM collection_records WHERE workspace_id = ?1 AND version_id = ?2 \
             ORDER BY file_path",
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    statement
        .query_map(params![workspace_id, version_id], |row| {
            Ok(ExistingRecordBinding {
                record_id: row.get(0)?,
                file_path: row.get(1)?,
                object_id: row.get(2)?,
                adoption_state: row.get(3)?,
                index_initialized: row.get(4)?,
            })
        })
        .map_err(crate::DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::DomainError::sql_corrupt)
}

/// Append the record identity observed by one newly inserted text moment. The
/// caller owns the transaction that inserted the moment, so the maintenance row
/// commits or rolls back with history itself.
#[doc(hidden)]
pub fn index_historical_record_owner_moment_in_tx(
    tx: &Connection,
    workspace_id: &str,
    moment_order: i64,
) -> Result<(), StorageError> {
    let moment = tx
        .query_row(
            "SELECT m.version_id,m.object_id,m.path,b.text FROM moments m \
             JOIN blobs b ON b.sha256=m.after_blob_sha256 \
             WHERE m.workspace_id=?1 AND m.moment_order=?2 \
               AND m.after_content_kind='text'",
            params![workspace_id, moment_order],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::corrupt_public)?;
    let Some((version_id, object_id, path, text)) = moment else {
        return Ok(());
    };
    if !is_collection_markdown_path(&path) {
        return Ok(());
    }
    let Some(record_id) = markdown_record_id(&text).filter(|value| is_record_id(value)) else {
        return Ok(());
    };
    tx.execute(
        "INSERT OR IGNORE INTO collection_historical_record_owners \
         (workspace_id,version_id,object_id,moment_order,record_id,collection_path) \
         VALUES (?1,?2,?3,?4,?5,?6)",
        params![
            workspace_id,
            version_id,
            object_id,
            moment_order,
            record_id,
            parent_path(&path),
        ],
    )
    .map_err(StorageError::persist_public)?;
    Ok(())
}

fn ensure_historical_record_owners_backfilled(
    tx: &Connection,
    workspace_id: &str,
    version_id: &str,
) -> Result<(), crate::DomainError> {
    let complete = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM collection_historical_record_owner_backfills \
             WHERE workspace_id=?1 AND version_id=?2 AND index_version=1)",
            params![workspace_id, version_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    if complete {
        return Ok(());
    }
    // A workspace can reconcile before its versioning bootstrap has run. The
    // marker row references `versions`, and a version that does not exist has
    // no moments to index, so defer the backfill until the row exists.
    let version_exists = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM versions WHERE workspace_id=?1 AND version_id=?2)",
            params![workspace_id, version_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    if !version_exists {
        return Ok(());
    }

    let mut statement = tx
        .prepare(
            "SELECT m.moment_order,m.object_id,m.path,b.text FROM moments m \
             JOIN blobs b ON b.sha256=m.after_blob_sha256 \
             WHERE m.workspace_id=?1 AND m.version_id=?2 \
               AND m.after_content_kind='text' AND lower(substr(m.path,-3))='.md' \
             ORDER BY m.moment_order",
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    let moments = statement
        .query_map(params![workspace_id, version_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(crate::DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::DomainError::sql_corrupt)?;
    drop(statement);
    for (moment_order, object_id, path, text) in moments {
        let Some(record_id) = markdown_record_id(&text).filter(|value| is_record_id(value)) else {
            continue;
        };
        tx.execute(
            "INSERT OR IGNORE INTO collection_historical_record_owners \
             (workspace_id,version_id,object_id,moment_order,record_id,collection_path) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                workspace_id,
                version_id,
                object_id,
                moment_order,
                record_id,
                parent_path(&path),
            ],
        )
        .map_err(crate::DomainError::sql_persist)?;
    }
    tx.execute(
        "INSERT INTO collection_historical_record_owner_backfills \
         (workspace_id,version_id,index_version) VALUES (?1,?2,1)",
        params![workspace_id, version_id],
    )
    .map_err(crate::DomainError::sql_persist)?;
    Ok(())
}

fn load_historical_record_owners(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
) -> Result<HashMap<String, HashSet<String>>, crate::DomainError> {
    let mut statement = conn
        .prepare(
            "SELECT record_id,object_id FROM collection_historical_record_owners \
             WHERE workspace_id=?1 AND version_id=?2",
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    let rows = statement
        .query_map(params![workspace_id, version_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(crate::DomainError::sql_corrupt)?;
    let mut owners_by_record_id: HashMap<String, HashSet<String>> = HashMap::new();
    for row in rows {
        let (record_id, object_id) = row.map_err(crate::DomainError::sql_corrupt)?;
        owners_by_record_id
            .entry(record_id)
            .or_default()
            .insert(object_id);
    }
    Ok(owners_by_record_id)
}

fn latest_historical_record_id(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<Option<(String, String)>, crate::DomainError> {
    conn.query_row(
        "SELECT record_id,collection_path FROM collection_historical_record_owners \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
         ORDER BY moment_order DESC LIMIT 1",
        params![workspace_id, version_id, object_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )
    .optional()
    .map_err(crate::DomainError::sql_corrupt)
}

fn has_open_file_conflict(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    path: &str,
) -> Result<bool, crate::DomainError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM conflicts \
         WHERE workspace_id = ?1 AND target_version_id = ?2 AND status = 'open' \
           AND (current_object_id = ?3 OR incoming_object_id = ?3 OR path = ?4))",
        params![workspace_id, version_id, object_id, path],
        |row| row.get(0),
    )
    .map_err(crate::DomainError::sql_corrupt)
}

fn mint_unused_record_id(used: &mut HashSet<String>) -> Result<String, crate::DomainError> {
    loop {
        let record_id = mint_record_id().map_err(|error| {
            crate::DomainError::Storage(StorageError::persist_public(std::io::Error::other(error)))
        })?;
        if used.insert(record_id.clone()) {
            return Ok(record_id);
        }
    }
}

/// Refresh collection detection and record bindings from active-version text
/// heads. The caller runs this on the engine's single writer inside one
/// transaction after capture has applied the settled filesystem scan.
pub fn reconcile_collections_in_tx(
    tx: &Connection,
    workspace_id: &str,
    version_id: &str,
) -> Result<CollectionReconcileResult, crate::DomainError> {
    let snapshots = load_collection_snapshots(tx, workspace_id, version_id)?;
    let existing = load_record_bindings(tx, workspace_id, version_id)?;
    ensure_historical_record_owners_backfilled(tx, workspace_id, version_id)?;
    let historical_record_owners = load_historical_record_owners(tx, workspace_id, version_id)?;
    let mut existing_by_object_id = HashMap::with_capacity(existing.len());
    for binding in &existing {
        existing_by_object_id
            .entry(binding.object_id.as_str())
            .or_insert(binding);
    }
    let mut declined_adoption_paths = Vec::new();
    {
        let mut statement = tx
            .prepare(
                "SELECT degradation_reasons_json FROM collections \
                 WHERE workspace_id=?1 AND version_id=?2",
            )
            .map_err(crate::DomainError::sql_corrupt)?;
        let stored = statement
            .query_map(params![workspace_id, version_id], |row| {
                row.get::<_, String>(0)
            })
            .map_err(crate::DomainError::sql_corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(crate::DomainError::sql_corrupt)?;
        for reasons in stored {
            let reasons: Vec<CollectionSchemaReason> =
                serde_json::from_str(&reasons).map_err(|error| {
                    crate::DomainError::Storage(StorageError::corrupt_public(error))
                })?;
            declined_adoption_paths.extend(reasons.into_iter().filter_map(|reason| {
                (reason.code == CollectionSchemaReasonCode::RecordTooLargeForAdoption)
                    .then_some(reason.path)
            }));
        }
    }
    declined_adoption_paths.sort();
    declined_adoption_paths.dedup();

    let snapshots_by_path: HashMap<&str, &CollectionSnapshot> = snapshots
        .iter()
        .map(|snapshot| (snapshot.path.as_str(), snapshot))
        .collect();
    let mut parsed_schemas: Vec<(&CollectionSnapshot, String, CollectionSchemaParseResult)> =
        snapshots
            .iter()
            .filter(|snapshot| path_basename(&snapshot.path) == COLLECTION_SCHEMA_FILENAME)
            .map(|snapshot| {
                let collection_path = parent_path(&snapshot.path).to_owned();
                let parsed = if collection_path.is_empty() {
                    degraded_document(CollectionSchemaReasonCode::RootCollectionUnsupported)
                } else {
                    parse_collection_schema(&snapshot.text)
                };
                (snapshot, collection_path, parsed)
            })
            .collect();
    declined_adoption_paths.retain(|path| {
        let Some(record) = snapshots_by_path.get(path.as_str()) else {
            return false;
        };
        if !is_collection_markdown_path(&record.path)
            || (!record.text.is_empty()
                && markdown_frontmatter_json_with_body(&record.text).is_none())
            || markdown_record_id(&record.text).is_some_and(|record_id| is_record_id(&record_id))
        {
            return false;
        }
        let line_ending_bytes = record
            .text
            .split_inclusive('\n')
            .next()
            .map_or(1, |first_line| {
                usize::from(first_line.ends_with("\r\n")) + 1
            });
        let adopted_bytes = record.text.len().saturating_add(
            RECORD_ID_FRONTMATTER_KEY.len()
                + ": ".len()
                + RECORD_ID_PREFIX.len()
                + RECORD_ID_RANDOM_BASE32_LENGTH
                + line_ending_bytes,
        );
        if record.text.is_empty() || adopted_bytes <= crate::MAX_TEXT_BYTES {
            return false;
        }
        let collection_path = parent_path(path);
        let Some((_, _, parsed)) = parsed_schemas
            .iter_mut()
            .find(|(_, candidate_path, _)| candidate_path == collection_path)
        else {
            return false;
        };
        parsed.status = CollectionSchemaStatus::Degraded;
        push_reason(
            &mut parsed.reasons,
            CollectionSchemaReasonCode::RecordTooLargeForAdoption,
            path.clone(),
        );
        true
    });
    let declined_adoption_paths: HashSet<&str> =
        declined_adoption_paths.iter().map(String::as_str).collect();
    let collection_schemas: HashMap<&str, &CollectionSchema> = parsed_schemas
        .iter()
        .filter(|(_, collection_path, _)| !collection_path.is_empty())
        .filter(|(_, _, parsed)| {
            !parsed
                .reasons
                .iter()
                .any(|reason| reason.code == CollectionSchemaReasonCode::UnsupportedVersion)
        })
        .map(|(_, collection_path, parsed)| (collection_path.as_str(), &parsed.schema))
        .collect();
    let records: Vec<&CollectionSnapshot> = snapshots
        .iter()
        .filter(|snapshot| {
            is_collection_markdown_path(&snapshot.path)
                && collection_schemas.contains_key(parent_path(&snapshot.path))
                && (snapshot.text.is_empty()
                    || markdown_frontmatter_json_with_body(&snapshot.text).is_some())
        })
        .collect();
    let current_paths: HashSet<&str> = records.iter().map(|record| record.path.as_str()).collect();
    let present_malformed_records: Vec<&CollectionSnapshot> = snapshots
        .iter()
        .filter(|snapshot| {
            is_collection_markdown_path(&snapshot.path)
                && collection_schemas.contains_key(parent_path(&snapshot.path))
                && !current_paths.contains(snapshot.path.as_str())
        })
        .collect();
    let mut present_malformed_owners = HashMap::new();
    for snapshot in &present_malformed_records {
        let existing_owner = existing_by_object_id
            .get(snapshot.object_id.as_str())
            .and_then(|binding| {
                binding.record_id.as_ref().map(|record_id| {
                    (
                        record_id.clone(),
                        parent_path(&binding.file_path).to_owned(),
                    )
                })
            });
        let historical_owner =
            latest_historical_record_id(tx, workspace_id, version_id, &snapshot.object_id)?
                .or(existing_owner);
        let Some((record_id, prior_collection_path)) = historical_owner else {
            continue;
        };
        present_malformed_owners.insert(
            snapshot.object_id.clone(),
            (
                record_id,
                prior_collection_path == parent_path(&snapshot.path),
            ),
        );
    }
    let present_malformed_record_ids: HashSet<String> = present_malformed_owners
        .values()
        .filter(|(_, remains_in_collection)| *remains_in_collection)
        .map(|(record_id, _)| record_id.clone())
        .collect();
    let current_object_ids: HashSet<&str> = snapshots
        .iter()
        .filter(|snapshot| {
            is_collection_markdown_path(&snapshot.path)
                && collection_schemas.contains_key(parent_path(&snapshot.path))
        })
        .map(|snapshot| snapshot.object_id.as_str())
        .collect();
    let current_ids: HashMap<&str, String> = records
        .iter()
        .filter_map(|record| {
            markdown_record_id(&record.text)
                .filter(|record_id| is_record_id(record_id))
                .map(|record_id| (record.path.as_str(), record_id))
        })
        .collect();

    let existing_by_record_id: HashMap<&str, &ExistingRecordBinding> = existing
        .iter()
        .filter_map(|binding| {
            binding
                .record_id
                .as_deref()
                .map(|record_id| (record_id, binding))
        })
        .collect();
    let mut current_owners: HashMap<String, String> = HashMap::new();
    let mut absent_owners = HashSet::new();
    let mut used_ids: HashSet<String> = historical_record_owners.keys().cloned().collect();
    for binding in &existing {
        let Some(record_id) = binding.record_id.as_ref() else {
            continue;
        };
        used_ids.insert(record_id.clone());
        if current_object_ids.contains(binding.object_id.as_str()) {
            current_owners.insert(record_id.clone(), binding.object_id.clone());
        } else if !current_paths.contains(binding.file_path.as_str())
            && binding.adoption_state == "adopted"
        {
            absent_owners.insert(record_id.clone());
        }
    }
    for (object_id, (record_id, _)) in &present_malformed_owners {
        used_ids.insert(record_id.clone());
        current_owners
            .entry(record_id.clone())
            .or_insert_with(|| object_id.clone());
    }
    let mut current_id_counts = HashMap::new();
    for record_id in current_ids.values() {
        *current_id_counts
            .entry(record_id.as_str())
            .or_insert(0_usize) += 1;
    }
    for record in &records {
        let Some(record_id) = current_ids.get(record.path.as_str()) else {
            continue;
        };
        let established_owner = existing_by_object_id
            .get(record.object_id.as_str())
            .is_some_and(|binding| {
                binding.record_id.is_some()
                    && (binding.adoption_state == "adopted"
                        || binding.adoption_state.starts_with("deferred-conflict"))
            });
        if current_id_counts.get(record_id.as_str()) == Some(&1)
            || current_owners.contains_key(record_id)
            || !established_owner
        {
            continue;
        }
        used_ids.insert(record_id.clone());
        current_owners.insert(record_id.clone(), record.object_id.clone());
    }
    for record in &records {
        let Some(record_id) = current_ids.get(record.path.as_str()) else {
            continue;
        };
        if current_id_counts.get(record_id.as_str()) == Some(&1)
            || current_owners.contains_key(record_id)
            || existing_by_object_id.contains_key(record.object_id.as_str())
        {
            continue;
        }
        let Some((historical_record_id, _)) =
            latest_historical_record_id(tx, workspace_id, version_id, &record.object_id)?
        else {
            continue;
        };
        if historical_record_id == *record_id {
            used_ids.insert(record_id.clone());
            current_owners.insert(record_id.clone(), record.object_id.clone());
        }
    }

    let mut desired = Vec::with_capacity(records.len());
    let mut claimed_ids: HashMap<String, String> = HashMap::new();
    let mut adoptions = Vec::new();
    for record in records {
        let collection_path = parent_path(&record.path).to_owned();
        let parsed_id = current_ids.get(record.path.as_str()).cloned();
        if parsed_id.is_none() && declined_adoption_paths.contains(record.path.as_str()) {
            continue;
        }
        let existing_same_object = existing_by_object_id
            .get(record.object_id.as_str())
            .copied();
        let lossless_insertion_required = parsed_id.is_none()
            && existing_same_object.is_none_or(|binding| {
                matches!(
                    binding.adoption_state.as_str(),
                    "pending-lossless" | "deferred-conflict-lossless"
                )
            });
        let conflicted = has_open_file_conflict(
            tx,
            workspace_id,
            version_id,
            &record.object_id,
            &record.path,
        )?;

        if conflicted {
            let record_id = existing_same_object
                .and_then(|binding| binding.record_id.clone())
                .or_else(|| {
                    parsed_id
                        .as_ref()
                        .filter(|record_id| {
                            current_owners.get(*record_id).map_or_else(
                                || {
                                    historical_record_owners
                                        .get(*record_id)
                                        .is_none_or(|owners| {
                                            owners.iter().all(|owner| owner == &record.object_id)
                                                || (existing_same_object.is_none()
                                                    && absent_owners.contains(*record_id))
                                        })
                                        && (absent_owners.contains(*record_id)
                                            || !existing_by_record_id
                                                .contains_key(record_id.as_str()))
                                },
                                |owner| owner == &record.object_id,
                            ) && !claimed_ids.contains_key(record_id.as_str())
                        })
                        .cloned()
                });
            if let Some(record_id) = record_id.as_ref() {
                claimed_ids.insert(record_id.clone(), record.path.clone());
            }
            let index_initialized = existing_same_object
                .filter(|binding| binding.record_id.as_ref() == record_id.as_ref())
                .is_some_and(|binding| binding.index_initialized);
            desired.push(DesiredRecordBinding {
                record_id,
                collection_path,
                file_path: record.path.clone(),
                object_id: record.object_id.clone(),
                adoption_state: if lossless_insertion_required {
                    "deferred-conflict-lossless"
                } else {
                    "deferred-conflict"
                },
                index_initialized,
            });
            continue;
        }

        // The id is engine-owned. Once this object has a binding, rewriting the
        // canonical frontmatter to another valid id keeps the established
        // identity and schedules an engine-authored write-back, exactly like
        // the id-removal repair below. In particular, do not let a Y.Doc
        // settlement rebind field history to the user-supplied replacement.
        // A missing or invalid id falls through to that existing repair path,
        // which owns the lossless/deferred adoption semantics.
        if let Some(bound_id) = existing_same_object
            .and_then(|binding| binding.record_id.as_ref())
            .filter(|bound_id| parsed_id.as_ref().is_some_and(|parsed| parsed != *bound_id))
        {
            claimed_ids.insert(bound_id.clone(), record.path.clone());
            desired.push(DesiredRecordBinding {
                record_id: Some(bound_id.clone()),
                collection_path: collection_path.clone(),
                file_path: record.path.clone(),
                object_id: record.object_id.clone(),
                adoption_state: "pending",
                index_initialized: existing_same_object
                    .is_some_and(|binding| binding.index_initialized),
            });
            adoptions.push(CollectionAdoptionCandidate {
                record_id: bound_id.clone(),
                collection_path,
                file_path: record.path.clone(),
                object_id: record.object_id.clone(),
                lossless_insertion_required: false,
            });
            continue;
        }

        if let Some(record_id) = parsed_id {
            let occupied_by_current = current_owners
                .get(&record_id)
                .is_some_and(|owner| owner != &record.object_id);
            let rebinds_absent_owner =
                existing_same_object.is_none() && absent_owners.contains(&record_id);
            let occupied_by_history = historical_record_owners
                .get(&record_id)
                .is_some_and(|owners| owners.iter().any(|owner| owner != &record.object_id))
                && current_owners.get(&record_id) != Some(&record.object_id)
                && !rebinds_absent_owner;
            let occupied_in_pass = claimed_ids
                .get(&record_id)
                .is_some_and(|owner_path| owner_path != &record.path);
            if occupied_by_current || occupied_by_history || occupied_in_pass {
                let fresh_id = mint_unused_record_id(&mut used_ids)?;
                let lossless_remint_required =
                    engine_authored_record_id_range(&record.text, &record_id).is_some();
                claimed_ids.insert(fresh_id.clone(), record.path.clone());
                desired.push(DesiredRecordBinding {
                    record_id: Some(fresh_id.clone()),
                    collection_path: collection_path.clone(),
                    file_path: record.path.clone(),
                    object_id: record.object_id.clone(),
                    adoption_state: if lossless_remint_required {
                        "pending-lossless"
                    } else {
                        "pending"
                    },
                    index_initialized: false,
                });
                adoptions.push(CollectionAdoptionCandidate {
                    record_id: fresh_id,
                    collection_path,
                    file_path: record.path.clone(),
                    object_id: record.object_id.clone(),
                    lossless_insertion_required: lossless_remint_required,
                });
            } else {
                used_ids.insert(record_id.clone());
                claimed_ids.insert(record_id.clone(), record.path.clone());
                let needs_adoption =
                    existing_same_object.is_none_or(|binding| binding.adoption_state != "adopted");
                let index_initialized = existing_same_object
                    .filter(|binding| binding.record_id.as_deref() == Some(record_id.as_str()))
                    .or_else(|| existing_by_record_id.get(record_id.as_str()).copied())
                    .is_some_and(|binding| binding.index_initialized);
                desired.push(DesiredRecordBinding {
                    record_id: Some(record_id.clone()),
                    collection_path: collection_path.clone(),
                    file_path: record.path.clone(),
                    object_id: record.object_id.clone(),
                    adoption_state: if needs_adoption { "pending" } else { "adopted" },
                    index_initialized,
                });
                if needs_adoption {
                    adoptions.push(CollectionAdoptionCandidate {
                        record_id,
                        collection_path,
                        file_path: record.path.clone(),
                        object_id: record.object_id.clone(),
                        lossless_insertion_required: false,
                    });
                }
            }
            continue;
        }

        let bound_id = existing_same_object.and_then(|binding| binding.record_id.clone());
        let record_id = match bound_id {
            Some(record_id) if !claimed_ids.contains_key(&record_id) => record_id,
            _ => mint_unused_record_id(&mut used_ids)?,
        };
        claimed_ids.insert(record_id.clone(), record.path.clone());
        desired.push(DesiredRecordBinding {
            record_id: Some(record_id.clone()),
            collection_path: collection_path.clone(),
            file_path: record.path.clone(),
            object_id: record.object_id.clone(),
            adoption_state: if lossless_insertion_required {
                "pending-lossless"
            } else {
                "pending"
            },
            index_initialized: existing_same_object
                .is_some_and(|binding| binding.index_initialized),
        });
        adoptions.push(CollectionAdoptionCandidate {
            record_id,
            collection_path,
            file_path: record.path.clone(),
            object_id: record.object_id.clone(),
            lossless_insertion_required,
        });
    }

    // Record ids bound per Collection before and after this pass. A record
    // that leaves one Collection for another is removed from the first and
    // added to the second. Removed values are read now, while the index
    // still holds them.
    let bound_before: HashSet<(&str, &str)> = existing
        .iter()
        .filter_map(|binding| {
            let record_id = binding.record_id.as_deref()?;
            Some((record_id, parent_path(&binding.file_path)))
        })
        .collect();
    let bound_after: HashSet<(&str, &str)> = desired
        .iter()
        .filter_map(|binding| {
            let record_id = binding.record_id.as_deref()?;
            Some((record_id, binding.collection_path.as_str()))
        })
        .collect();
    let mut lifecycle = Vec::new();
    let removed_values_wanted = crate::automations::removed_records_wanted_in_tx(tx, workspace_id)?;
    for binding in &existing {
        let Some(record_id) = binding.record_id.as_deref() else {
            continue;
        };
        let collection_path = parent_path(&binding.file_path);
        if !bound_after.contains(&(record_id, collection_path)) {
            lifecycle.push(CollectionRecordLifecycle {
                kind: CollectionRecordLifecycleKind::Removed,
                record_id: record_id.to_owned(),
                collection_path: collection_path.to_owned(),
                object_id: binding.object_id.clone(),
                removed_fields: if removed_values_wanted {
                    indexed_record_fields(tx, workspace_id, version_id, record_id)?
                } else {
                    Vec::new()
                },
            });
        }
    }

    for binding in &desired {
        let Some(existing_binding) = existing_by_object_id.get(binding.object_id.as_str()) else {
            continue;
        };
        let (Some(previous_record_id), Some(record_id)) = (
            existing_binding.record_id.as_deref(),
            binding.record_id.as_deref(),
        ) else {
            continue;
        };
        if previous_record_id == record_id {
            continue;
        }
        tx.execute(
            "UPDATE collection_field_history SET record_id=?4 \
             WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3",
            params![workspace_id, version_id, previous_record_id, record_id],
        )
        .map_err(crate::DomainError::sql_persist)?;
    }

    tx.execute(
        "DELETE FROM collection_records WHERE workspace_id = ?1 AND version_id = ?2",
        params![workspace_id, version_id],
    )
    .map_err(crate::DomainError::sql_persist)?;
    tx.execute(
        "DELETE FROM collections WHERE workspace_id = ?1 AND version_id = ?2",
        params![workspace_id, version_id],
    )
    .map_err(crate::DomainError::sql_persist)?;
    for (snapshot, collection_path, parsed) in &parsed_schemas {
        let status = match parsed.status {
            CollectionSchemaStatus::Valid => "valid",
            CollectionSchemaStatus::Degraded => "degraded",
        };
        let reasons = serde_json::to_string(&parsed.reasons)
            .map_err(|error| crate::DomainError::Storage(StorageError::persist_public(error)))?;
        tx.execute(
            "INSERT INTO collections \
             (workspace_id, version_id, collection_path, schema_path, schema_status, \
              degradation_reasons_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                workspace_id,
                version_id,
                if collection_path.is_empty() {
                    ROOT_COLLECTION_DIAGNOSTIC_PATH
                } else {
                    collection_path
                },
                snapshot.path,
                status,
                reasons
            ],
        )
        .map_err(crate::DomainError::sql_persist)?;
    }
    for binding in &desired {
        tx.execute(
            "INSERT INTO collection_records \
             (workspace_id, version_id, record_id, collection_path, file_path, object_id, \
              adoption_state, index_initialized) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                workspace_id,
                version_id,
                binding.record_id,
                binding.collection_path,
                binding.file_path,
                binding.object_id,
                binding.adoption_state,
                binding.index_initialized,
            ],
        )
        .map_err(crate::DomainError::sql_persist)?;
    }
    for binding in &desired {
        let Some(record_id) = binding.record_id.as_deref() else {
            continue;
        };
        if binding.index_initialized
            && !record_has_unsupported_tag_flag(tx, workspace_id, version_id, record_id)?
        {
            continue;
        }
        let Some(snapshot) = snapshots_by_path.get(binding.file_path.as_str()).copied() else {
            continue;
        };
        let Some(frontmatter) = parse_markdown_frontmatter(&snapshot.text) else {
            continue;
        };
        let Some(schema) = collection_schemas
            .get(binding.collection_path.as_str())
            .copied()
        else {
            continue;
        };
        replace_index_for_record(
            tx,
            workspace_id,
            version_id,
            record_id,
            schema,
            &frontmatter.value,
            FieldProvenance::Parsed {
                non_finite_fields: &frontmatter.non_finite_fields,
                unsupported_tag_fields: &frontmatter.unsupported_tag_fields,
            },
        )?;
    }
    tx.execute(
        "DELETE FROM collection_record_fields \
         WHERE workspace_id=?1 AND version_id=?2 \
           AND NOT EXISTS (SELECT 1 FROM collection_records r \
             WHERE r.workspace_id=collection_record_fields.workspace_id \
               AND r.version_id=collection_record_fields.version_id \
               AND r.record_id=collection_record_fields.record_id)",
        params![workspace_id, version_id],
    )
    .map_err(crate::DomainError::sql_persist)?;
    tx.execute(
        "DELETE FROM collection_relation_edges \
         WHERE workspace_id=?1 AND version_id=?2 \
           AND NOT EXISTS (SELECT 1 FROM collection_records r \
             WHERE r.workspace_id=collection_relation_edges.workspace_id \
               AND r.version_id=collection_relation_edges.version_id \
               AND r.record_id=collection_relation_edges.source_record_id)",
        params![workspace_id, version_id],
    )
    .map_err(crate::DomainError::sql_persist)?;
    revalidate_collection_index_in_tx(tx, workspace_id, version_id, &collection_schemas)?;
    for binding in &desired {
        let Some(record_id) = binding.record_id.as_deref() else {
            continue;
        };
        if !bound_before.contains(&(record_id, binding.collection_path.as_str())) {
            lifecycle.push(CollectionRecordLifecycle {
                kind: CollectionRecordLifecycleKind::Added,
                record_id: record_id.to_owned(),
                collection_path: binding.collection_path.clone(),
                object_id: binding.object_id.clone(),
                removed_fields: Vec::new(),
            });
        }
    }
    let relation_cleanups =
        dangling_relation_cleanups(tx, workspace_id, version_id, &present_malformed_record_ids)?;
    Ok(CollectionReconcileResult {
        adoptions,
        relation_cleanups,
        lifecycle,
    })
}

/// One record's indexed field values, `(field name, value JSON)` in
/// field-name order.
pub(crate) fn indexed_record_fields(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    record_id: &str,
) -> Result<Vec<(String, String)>, crate::DomainError> {
    let mut statement = conn
        .prepare(
            "SELECT field_name, value_json FROM collection_record_fields \
             WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3 ORDER BY field_name",
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    statement
        .query_map(params![workspace_id, version_id, record_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(crate::DomainError::sql_corrupt)?
        .collect::<Result<_, _>>()
        .map_err(crate::DomainError::sql_corrupt)
}

pub fn set_collection_adoption_state_in_tx(
    tx: &Connection,
    workspace_id: &str,
    version_id: &str,
    file_path: &str,
    record_id: &str,
    state: &str,
) -> Result<(), crate::DomainError> {
    let changed = tx
        .execute(
            "UPDATE collection_records SET adoption_state = ?5 \
             WHERE workspace_id = ?1 AND version_id = ?2 AND file_path = ?3 \
               AND record_id = ?4",
            params![workspace_id, version_id, file_path, record_id, state],
        )
        .map_err(crate::DomainError::sql_persist)?;
    if changed != 1 {
        return Err(crate::DomainError::StateCorrupt {
            reason: "collection adoption binding disappeared",
        });
    }
    Ok(())
}

pub fn delete_collection_adoption_binding_in_tx(
    tx: &Connection,
    workspace_id: &str,
    version_id: &str,
    file_path: &str,
    record_id: &str,
) -> Result<(), crate::DomainError> {
    let changed = tx
        .execute(
            "DELETE FROM collection_records \
             WHERE workspace_id = ?1 AND version_id = ?2 AND file_path = ?3 \
               AND record_id = ?4 AND adoption_state IN ('pending', 'pending-lossless')",
            params![workspace_id, version_id, file_path, record_id],
        )
        .map_err(crate::DomainError::sql_persist)?;
    if changed != 1 {
        return Err(crate::DomainError::StateCorrupt {
            reason: "pending collection adoption binding disappeared",
        });
    }
    Ok(())
}

pub fn decline_oversized_collection_adoption_in_tx(
    tx: &Connection,
    workspace_id: &str,
    version_id: &str,
    collection_path: &str,
    file_path: &str,
    record_id: &str,
) -> Result<(), crate::DomainError> {
    delete_collection_adoption_binding_in_tx(tx, workspace_id, version_id, file_path, record_id)?;
    let reasons = tx
        .query_row(
            "SELECT degradation_reasons_json FROM collections \
             WHERE workspace_id=?1 AND version_id=?2 AND collection_path=?3",
            params![workspace_id, version_id, collection_path],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(crate::DomainError::sql_corrupt)?
        .ok_or(crate::DomainError::StateCorrupt {
            reason: "collection disappeared during adoption decline",
        })?;
    let mut reasons: Vec<CollectionSchemaReason> = serde_json::from_str(&reasons)
        .map_err(|error| crate::DomainError::Storage(StorageError::corrupt_public(error)))?;
    let reason = CollectionSchemaReason {
        code: CollectionSchemaReasonCode::RecordTooLargeForAdoption,
        path: file_path.to_owned(),
    };
    if !reasons.contains(&reason) {
        push_reason(&mut reasons, reason.code, reason.path);
    }
    let reasons = serde_json::to_string(&reasons)
        .map_err(|error| crate::DomainError::Storage(StorageError::persist_public(error)))?;
    tx.execute(
        "UPDATE collections SET schema_status='degraded', degradation_reasons_json=?4 \
         WHERE workspace_id=?1 AND version_id=?2 AND collection_path=?3",
        params![workspace_id, version_id, collection_path, reasons],
    )
    .map_err(crate::DomainError::sql_persist)?;
    Ok(())
}

fn active_version_id(conn: &Connection, workspace_id: &str) -> Result<String, crate::DomainError> {
    conn.query_row(
        "SELECT COALESCE(\
           (SELECT version_id FROM active_versions WHERE workspace_id=?1),\
           (SELECT main_version_id FROM versioned_workspaces WHERE workspace_id=?1))",
        [workspace_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .map_err(crate::DomainError::sql_corrupt)?
    .ok_or(crate::DomainError::WorkspaceNotFound)
}

/// Active-version collection bindings whose artifact still needs the shared
/// rich-document importer to establish canonical Y.Doc state.
pub fn list_pending_collection_adoptions(
    conn: &Connection,
    workspace_id: &str,
    limit: usize,
    cursor: Option<&CollectionPendingAdoptionCursor>,
) -> Result<CollectionPendingAdoptionPage, crate::DomainError> {
    if limit == 0 || limit > MAX_COLLECTION_QUERY_LIMIT {
        return Err(crate::DomainError::InvalidInput {
            reason: "collection pending-adoption limit is invalid",
        });
    }
    if cursor.is_some_and(|cursor| cursor.file_path.is_empty() || cursor.record_id.is_empty()) {
        return Err(crate::DomainError::InvalidInput {
            reason: "collection pending-adoption cursor is invalid",
        });
    }
    let version_id = active_version_id(conn, workspace_id)?;
    let mut statement = conn
        .prepare(
            "SELECT r.record_id,r.collection_path,r.file_path,r.object_id \
             FROM collection_records r \
             JOIN snapshots s ON s.workspace_id=r.workspace_id \
               AND s.version_id=r.version_id AND s.path=r.file_path \
               AND s.object_id=r.object_id \
             WHERE r.workspace_id=?1 AND r.version_id=?2 \
               AND r.adoption_state IN ('pending', 'pending-lossless') \
               AND r.record_id IS NOT NULL \
               AND (?3 IS NULL OR r.file_path>?3 OR (r.file_path=?3 AND r.record_id>?4)) \
             ORDER BY r.file_path,r.record_id LIMIT ?5",
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    let cursor_file_path = cursor.map(|cursor| cursor.file_path.as_str());
    let cursor_record_id = cursor.map(|cursor| cursor.record_id.as_str());
    let mut adoptions = statement
        .query_map(
            params![
                workspace_id,
                version_id,
                cursor_file_path,
                cursor_record_id,
                i64::try_from(limit + 1).expect("bounded collection adoption page limit")
            ],
            |row| {
                Ok(CollectionPendingAdoption {
                    version_id: version_id.clone(),
                    record_id: row.get(0)?,
                    collection_path: row.get(1)?,
                    file_path: row.get(2)?,
                    object_id: row.get(3)?,
                })
            },
        )
        .map_err(crate::DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::DomainError::sql_corrupt)?;
    let next_cursor = (adoptions.len() > limit).then(|| {
        let last = &adoptions[limit - 1];
        CollectionPendingAdoptionCursor {
            file_path: last.file_path.clone(),
            record_id: last.record_id.clone(),
        }
    });
    adoptions.truncate(limit);
    Ok(CollectionPendingAdoptionPage {
        adoptions,
        next_cursor,
    })
}

fn stored_schema_status(value: &str) -> Result<CollectionSchemaStatus, crate::DomainError> {
    match value {
        "valid" => Ok(CollectionSchemaStatus::Valid),
        "degraded" => Ok(CollectionSchemaStatus::Degraded),
        _ => Err(crate::DomainError::StateCorrupt {
            reason: "invalid collection schema status",
        }),
    }
}

fn stored_schema_reasons(value: &str) -> Result<Vec<CollectionSchemaReason>, crate::DomainError> {
    serde_json::from_str(value)
        .map_err(|error| crate::DomainError::Storage(StorageError::corrupt_public(error)))
}

fn collection_summary_for_version(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    collection_path: &str,
) -> Result<Option<CollectionSummary>, crate::DomainError> {
    if !is_workspace_relative_collection_path(collection_path) {
        return Ok(None);
    }
    let stored = conn
        .query_row(
            "SELECT c.schema_status,c.degradation_reasons_json,s.object_id FROM collections c \
             JOIN snapshots s ON s.workspace_id=c.workspace_id \
               AND s.version_id=c.version_id AND s.path=c.schema_path \
             WHERE c.workspace_id=?1 AND c.version_id=?2 AND c.collection_path=?3",
            params![workspace_id, version_id, collection_path],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(crate::DomainError::sql_corrupt)?;
    stored
        .map(|(status, reasons, object_id)| {
            Ok(CollectionSummary {
                path: collection_path.to_owned(),
                object_id,
                status: stored_schema_status(&status)?,
                reasons: stored_schema_reasons(&reasons)?,
            })
        })
        .transpose()
}

/// One `list_collections` page: path-ordered summaries and the exclusive
/// continuation cursor (the last returned path), `None` on the final page.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionListPage {
    pub collections: Vec<CollectionSummary>,
    pub next_cursor: Option<String>,
}

/// One page of the active workspace version's collections, ordered by path
/// with the same exclusive-cursor keyset pattern as the pending-adoptions
/// listing, so discovery never outgrows the protocol collection limit.
pub fn list_collections(
    conn: &Connection,
    workspace_id: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<CollectionListPage, crate::DomainError> {
    if limit == 0 || limit > MAX_COLLECTION_QUERY_LIMIT {
        return Err(crate::DomainError::InvalidInput {
            reason: "collection list limit is invalid",
        });
    }
    if cursor.is_some_and(str::is_empty) {
        return Err(crate::DomainError::InvalidInput {
            reason: "collection list cursor is invalid",
        });
    }
    let version_id = active_version_id(conn, workspace_id)?;
    let mut statement = conn
        .prepare(
            "SELECT c.collection_path,c.schema_status,c.degradation_reasons_json,s.object_id \
             FROM collections c JOIN snapshots s ON s.workspace_id=c.workspace_id \
               AND s.version_id=c.version_id AND s.path=c.schema_path \
             WHERE c.workspace_id=?1 AND c.version_id=?2 \
               AND (?3 IS NULL OR c.collection_path>?3) \
             ORDER BY c.collection_path LIMIT ?4",
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    let rows = statement
        .query_map(
            params![
                workspace_id,
                version_id,
                cursor,
                i64::try_from(limit + 1).expect("bounded collection list page limit")
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(crate::DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::DomainError::sql_corrupt)?;
    let mut collections = rows
        .into_iter()
        .map(|(path, status, reasons, object_id)| {
            Ok(CollectionSummary {
                path,
                object_id,
                status: stored_schema_status(&status)?,
                reasons: stored_schema_reasons(&reasons)?,
            })
        })
        .collect::<Result<Vec<_>, crate::DomainError>>()?;
    let next_cursor = (collections.len() > limit).then(|| collections[limit - 1].path.clone());
    collections.truncate(limit);
    Ok(CollectionListPage {
        collections,
        next_cursor,
    })
}

/// The parsed schema and record count for one active-version collection.
pub fn get_collection(
    conn: &Connection,
    workspace_id: &str,
    collection_path: &str,
) -> Result<Option<CollectionDetails>, crate::DomainError> {
    let version_id = active_version_id(conn, workspace_id)?;
    let Some(summary) =
        collection_summary_for_version(conn, workspace_id, &version_id, collection_path)?
    else {
        return Ok(None);
    };
    let schema = load_collection_schema(conn, workspace_id, &version_id, collection_path)?;
    let record_count = conn
        .query_row(
            "SELECT COUNT(*) FROM collection_records \
             WHERE workspace_id=?1 AND version_id=?2 AND collection_path=?3 \
               AND record_id IS NOT NULL",
            params![workspace_id, version_id, collection_path],
            |row| row.get::<_, i64>(0),
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    let record_count =
        usize::try_from(record_count).map_err(|_| crate::DomainError::StateCorrupt {
            reason: "negative collection record count",
        })?;
    Ok(Some(CollectionDetails {
        path: summary.path,
        object_id: summary.object_id,
        status: summary.status,
        reasons: summary.reasons,
        schema,
        record_count,
    }))
}

fn indexed_validation(
    status: &str,
    reason: Option<&str>,
) -> Result<CollectionIndexedValueValidation, crate::DomainError> {
    match status {
        "valid" if reason.is_none() => Ok(CollectionIndexedValueValidation::Valid),
        "untyped" if reason.is_none() => Ok(CollectionIndexedValueValidation::Untyped),
        "flagged" => {
            let reason = reason.ok_or(crate::DomainError::StateCorrupt {
                reason: "flagged collection value has no reason",
            })?;
            Ok(CollectionIndexedValueValidation::Flagged {
                reason: serde_json::from_str(reason).map_err(|error| {
                    crate::DomainError::Storage(StorageError::corrupt_public(error))
                })?,
            })
        }
        _ => Err(crate::DomainError::StateCorrupt {
            reason: "invalid indexed collection validation",
        }),
    }
}

type CollectionRecordRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn collection_record_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CollectionRecordRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
    ))
}

fn load_collection_records(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    collection_path: &str,
    record_id: Option<&str>,
) -> Result<Vec<CollectionRecord>, crate::DomainError> {
    let record_ids = record_id.map(|record_id| vec![record_id.to_owned()]);
    load_collection_records_selected(
        conn,
        workspace_id,
        version_id,
        collection_path,
        record_ids.as_deref(),
        None,
    )
}

fn load_collection_records_selected(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    collection_path: &str,
    record_ids: Option<&[String]>,
    field_names: Option<&[String]>,
) -> Result<Vec<CollectionRecord>, crate::DomainError> {
    if record_ids.is_some_and(|record_ids| record_ids.is_empty()) {
        return Ok(Vec::new());
    }
    let mut parameters = vec![
        rusqlite::types::Value::Text(workspace_id.to_owned()),
        rusqlite::types::Value::Text(version_id.to_owned()),
        rusqlite::types::Value::Text(collection_path.to_owned()),
    ];
    let field_predicate = match field_names {
        None => String::new(),
        Some([]) => " AND 0".to_owned(),
        Some(field_names) => {
            let placeholders = field_names
                .iter()
                .map(|field| {
                    parameters.push(rusqlite::types::Value::Text(field.clone()));
                    format!("?{}", parameters.len())
                })
                .collect::<Vec<_>>()
                .join(",");
            format!(" AND f.field_name IN ({placeholders})")
        }
    };
    let record_predicate = record_ids.map_or_else(String::new, |record_ids| {
        let placeholders = record_ids
            .iter()
            .map(|record_id| {
                parameters.push(rusqlite::types::Value::Text(record_id.clone()));
                format!("?{}", parameters.len())
            })
            .collect::<Vec<_>>()
            .join(",");
        format!(" AND r.record_id IN ({placeholders})")
    });
    let mut statement = conn
        .prepare(&format!(
            "SELECT r.record_id,r.file_path,r.adoption_state,f.field_name,f.value_json,\
                    f.validation_status,f.validation_reason_json \
             FROM collection_records r \
             LEFT JOIN collection_record_fields f \
               ON f.workspace_id=r.workspace_id AND f.version_id=r.version_id \
              AND f.record_id=r.record_id{field_predicate} \
             WHERE r.workspace_id=?1 AND r.version_id=?2 AND r.collection_path=?3 \
               AND r.record_id IS NOT NULL{record_predicate} \
             ORDER BY r.file_path,r.record_id,f.field_name"
        ))
        .map_err(crate::DomainError::sql_corrupt)?;
    let rows = statement
        .query_map(
            rusqlite::params_from_iter(parameters.iter()),
            collection_record_row,
        )
        .map_err(crate::DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::DomainError::sql_corrupt)?;
    let mut records = Vec::<CollectionRecord>::new();
    let mut record_indexes = HashMap::<String, usize>::new();
    for (record_id, file_path, adoption_state, field, value, validation, reason) in rows {
        let index = match record_indexes.get(&record_id).copied() {
            Some(index) => index,
            None => {
                let index = records.len();
                records.push(CollectionRecord {
                    id: record_id.clone(),
                    path: file_path,
                    conflicted: matches!(
                        adoption_state.as_str(),
                        "deferred-conflict" | "deferred-conflict-lossless"
                    ),
                    values: Vec::new(),
                });
                record_indexes.insert(record_id, index);
                index
            }
        };
        let (Some(field), Some(value), Some(validation)) = (field, value, validation) else {
            continue;
        };
        records[index].values.push(CollectionIndexedValue {
            field,
            value: serde_json::from_str(&value).map_err(|error| {
                crate::DomainError::Storage(StorageError::corrupt_public(error))
            })?,
            validation: indexed_validation(&validation, reason.as_deref())?,
            resolved_relations: Vec::new(),
        });
    }
    Ok(records)
}

fn filename_label(path: &str) -> String {
    let basename = path_basename(path);
    basename
        .get(..basename.len().saturating_sub(3))
        .filter(|_| is_collection_markdown_path(basename))
        .unwrap_or(basename)
        .to_owned()
}

fn relation_target_label(file_path: &str, fields: &HashMap<String, String>) -> String {
    let mut label_fields: Vec<&str> = Vec::new();
    for preferred in ["title", "name"] {
        if let Some(field) = fields
            .get_key_value(preferred)
            .map(|(field, _)| field)
            .or_else(|| {
                fields
                    .keys()
                    .filter(|field| field.eq_ignore_ascii_case(preferred))
                    .min()
            })
        {
            label_fields.push(field);
        }
    }
    for field in label_fields {
        if let Some(label) = fields
            .get(field)
            .and_then(|value| serde_json::from_str::<Value>(value).ok())
            .and_then(|value| value.as_str().map(str::trim).map(str::to_owned))
            .filter(|value| !value.is_empty())
        {
            return label;
        }
    }
    filename_label(file_path)
}

fn resolve_record_relations(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    collection_path: &str,
    records: &mut [CollectionRecord],
) -> Result<(), crate::DomainError> {
    if records.is_empty() {
        return Ok(());
    }
    let mut parameters = vec![
        rusqlite::types::Value::Text(workspace_id.to_owned()),
        rusqlite::types::Value::Text(version_id.to_owned()),
        rusqlite::types::Value::Text(collection_path.to_owned()),
    ];
    let source_placeholders = records
        .iter()
        .map(|record| {
            parameters.push(rusqlite::types::Value::Text(record.id.clone()));
            format!("?{}", parameters.len())
        })
        .collect::<Vec<_>>()
        .join(",");
    let source_predicate = format!(" AND e.source_record_id IN ({source_placeholders})");
    let edge_sql = format!(
        "SELECT e.source_record_id,e.field_name,e.target_record_id,\
                e.target_collection_path \
         FROM collection_relation_edges e \
         JOIN collection_records r ON r.workspace_id=e.workspace_id \
           AND r.version_id=e.version_id AND r.record_id=e.source_record_id \
         WHERE e.workspace_id=?1 AND e.version_id=?2 AND r.collection_path=?3\
         {source_predicate} \
         ORDER BY e.source_record_id,e.field_name,e.target_record_id"
    );
    let mut statement = conn
        .prepare(&edge_sql)
        .map_err(crate::DomainError::sql_corrupt)?;
    let edges = statement
        .query_map(rusqlite::params_from_iter(parameters.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(crate::DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::DomainError::sql_corrupt)?;
    drop(statement);
    let target_sql = format!(
        "SELECT DISTINCT e.target_collection_path,e.target_record_id,target.file_path,\
                f.field_name,f.value_json \
         FROM collection_relation_edges e \
         JOIN collection_records source ON source.workspace_id=e.workspace_id \
           AND source.version_id=e.version_id AND source.record_id=e.source_record_id \
         JOIN collection_records target ON target.workspace_id=e.workspace_id \
           AND target.version_id=e.version_id AND target.record_id=e.target_record_id \
           AND target.collection_path=e.target_collection_path \
         LEFT JOIN collection_record_fields f ON f.workspace_id=target.workspace_id \
           AND f.version_id=target.version_id AND f.record_id=target.record_id \
           AND (f.field_name='title' COLLATE NOCASE \
                OR f.field_name='name' COLLATE NOCASE) \
         WHERE e.workspace_id=?1 AND e.version_id=?2 AND source.collection_path=?3\
         {source_predicate}"
    );
    let mut statement = conn
        .prepare(&target_sql)
        .map_err(crate::DomainError::sql_corrupt)?;
    let target_rows = statement
        .query_map(rusqlite::params_from_iter(parameters.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(crate::DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::DomainError::sql_corrupt)?;
    let mut target_fields = HashMap::<(String, String), (String, HashMap<String, String>)>::new();
    for (target_collection, target_record_id, file_path, field, value) in target_rows {
        let (_, fields) = target_fields
            .entry((target_collection, target_record_id))
            .or_insert_with(|| (file_path, HashMap::new()));
        if let (Some(field), Some(value)) = (field, value) {
            fields.insert(field, value);
        }
    }
    let labels: HashMap<(String, String), String> = target_fields
        .into_iter()
        .map(|(target, (file_path, fields))| (target, relation_target_label(&file_path, &fields)))
        .collect();
    let mut resolved = HashMap::<(String, String, String), String>::new();
    for (source, field, target, target_collection) in edges {
        let label = labels
            .get(&(target_collection, target.clone()))
            .cloned()
            .unwrap_or_else(|| target.clone());
        resolved.insert((source, field, target), label);
    }
    for record in records {
        for value in &mut record.values {
            let targets: Vec<&str> = match &value.value {
                Value::String(target) => vec![target],
                Value::Array(targets) => targets.iter().filter_map(Value::as_str).collect(),
                _ => Vec::new(),
            };
            value.resolved_relations = targets
                .into_iter()
                .filter_map(|target| {
                    resolved
                        .get(&(record.id.clone(), value.field.clone(), target.to_owned()))
                        .map(|label| CollectionResolvedRelation {
                            record_id: target.to_owned(),
                            label: label.clone(),
                        })
                })
                .collect();
        }
    }
    Ok(())
}

fn value_for_field<'a>(record: &'a CollectionRecord, field: &str) -> Option<&'a Value> {
    record
        .values
        .iter()
        .find(|value| value.field == field)
        .map(|value| &value.value)
}

fn sortable_value_for_field<'a>(record: &'a CollectionRecord, field: &str) -> Option<&'a Value> {
    record
        .values
        .iter()
        .find(|value| value.field == field)
        .filter(|value| {
            !matches!(
                &value.validation,
                CollectionIndexedValueValidation::Flagged { reason }
                    if reason.code == FieldValueReasonCode::ValueDepthExceeded
            )
        })
        .map(|value| &value.value)
}

fn value_contains(value: &Value, needle: &Value) -> bool {
    match (value, needle) {
        (Value::String(value), Value::String(needle)) => value.contains(needle),
        (Value::Array(values), needle) => values
            .iter()
            .any(|value| collection_values_equal(value, needle) || value_contains(value, needle)),
        _ => false,
    }
}

fn collection_filter_value_matches(
    value: &Value,
    operator: CollectionFilterOperator,
    needle: &Value,
) -> bool {
    match operator {
        CollectionFilterOperator::Equals => collection_values_equal(value, needle),
        CollectionFilterOperator::Contains => value_contains(value, needle),
    }
}

#[cfg(test)]
fn matches_collection_filter(record: &CollectionRecord, filter: &CollectionFilter) -> bool {
    value_for_field(record, &filter.field)
        .is_some_and(|value| collection_filter_value_matches(value, filter.operator, &filter.value))
}

fn json_kind(value: &Value) -> u8 {
    match value {
        Value::Null => 0,
        Value::Bool(_) => 1,
        Value::Number(_) => 2,
        Value::String(_) => 3,
        Value::Array(_) => 4,
        Value::Object(_) => 5,
    }
}

enum CollectionNumber {
    Signed(i64),
    Unsigned(u64),
    Float(f64),
}

fn collection_number(value: &serde_json::Number) -> CollectionNumber {
    if value.is_f64() {
        CollectionNumber::Float(value.as_f64().expect("f64 number"))
    } else if let Some(value) = value.as_i64() {
        CollectionNumber::Signed(value)
    } else {
        CollectionNumber::Unsigned(value.as_u64().expect("u64 number"))
    }
}

fn compare_signed_to_float(integer: i64, float: f64) -> Ordering {
    const I64_UPPER_EXCLUSIVE: f64 = 9_223_372_036_854_775_808.0;
    if float < i64::MIN as f64 {
        return Ordering::Greater;
    }
    if float >= I64_UPPER_EXCLUSIVE {
        return Ordering::Less;
    }
    let truncated = float.trunc() as i64;
    integer.cmp(&truncated).then_with(|| {
        0.0_f64
            .partial_cmp(&float.fract())
            .unwrap_or(Ordering::Equal)
    })
}

fn compare_unsigned_to_float(integer: u64, float: f64) -> Ordering {
    const U64_UPPER_EXCLUSIVE: f64 = 18_446_744_073_709_551_616.0;
    if float < 0.0 {
        return Ordering::Greater;
    }
    if float >= U64_UPPER_EXCLUSIVE {
        return Ordering::Less;
    }
    let truncated = float.trunc() as u64;
    integer.cmp(&truncated).then_with(|| {
        0.0_f64
            .partial_cmp(&float.fract())
            .unwrap_or(Ordering::Equal)
    })
}

fn compare_collection_numbers(left: &serde_json::Number, right: &serde_json::Number) -> Ordering {
    match (collection_number(left), collection_number(right)) {
        (CollectionNumber::Signed(left), CollectionNumber::Signed(right)) => left.cmp(&right),
        (CollectionNumber::Unsigned(left), CollectionNumber::Unsigned(right)) => left.cmp(&right),
        (CollectionNumber::Signed(left), CollectionNumber::Unsigned(right)) => {
            if left < 0 {
                Ordering::Less
            } else {
                (left as u64).cmp(&right)
            }
        }
        (CollectionNumber::Unsigned(left), CollectionNumber::Signed(right)) => {
            if right < 0 {
                Ordering::Greater
            } else {
                left.cmp(&(right as u64))
            }
        }
        (CollectionNumber::Signed(left), CollectionNumber::Float(right)) => {
            compare_signed_to_float(left, right)
        }
        (CollectionNumber::Float(left), CollectionNumber::Signed(right)) => {
            compare_signed_to_float(right, left).reverse()
        }
        (CollectionNumber::Unsigned(left), CollectionNumber::Float(right)) => {
            compare_unsigned_to_float(left, right)
        }
        (CollectionNumber::Float(left), CollectionNumber::Unsigned(right)) => {
            compare_unsigned_to_float(right, left).reverse()
        }
        (CollectionNumber::Float(left), CollectionNumber::Float(right)) => {
            left.partial_cmp(&right).unwrap_or(Ordering::Equal)
        }
    }
}

fn collection_values_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => {
            compare_collection_numbers(left, right) == Ordering::Equal
        }
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| collection_values_equal(left, right))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, left)| {
                    right
                        .get(key)
                        .is_some_and(|right| collection_values_equal(left, right))
                })
        }
        _ => left == right,
    }
}

#[derive(Debug, Eq, Hash, PartialEq)]
enum CollectionNumberKey {
    Integer(i128),
    Float(u64),
}

fn collection_number_key(value: &serde_json::Number) -> CollectionNumberKey {
    const U64_UPPER_EXCLUSIVE: f64 = 18_446_744_073_709_551_616.0;
    match collection_number(value) {
        CollectionNumber::Signed(value) => CollectionNumberKey::Integer(i128::from(value)),
        CollectionNumber::Unsigned(value) => CollectionNumberKey::Integer(i128::from(value)),
        CollectionNumber::Float(value)
            if value.fract() == 0.0 && value >= i64::MIN as f64 && value < U64_UPPER_EXCLUSIVE =>
        {
            let integer = if value < 0.0 {
                i128::from(value as i64)
            } else {
                i128::from(value as u64)
            };
            CollectionNumberKey::Integer(integer)
        }
        CollectionNumber::Float(value) => CollectionNumberKey::Float(value.to_bits()),
    }
}

#[derive(Debug, Eq, Hash, PartialEq)]
enum CollectionValueKey {
    Null,
    Bool(bool),
    Number(CollectionNumberKey),
    String(String),
    Array(Vec<CollectionValueKey>),
    Object(Vec<(String, CollectionValueKey)>),
}

fn collection_value_key(value: &Value) -> CollectionValueKey {
    match value {
        Value::Null => CollectionValueKey::Null,
        Value::Bool(value) => CollectionValueKey::Bool(*value),
        Value::Number(value) => CollectionValueKey::Number(collection_number_key(value)),
        Value::String(value) => CollectionValueKey::String(value.clone()),
        Value::Array(values) => {
            CollectionValueKey::Array(values.iter().map(collection_value_key).collect())
        }
        Value::Object(values) => {
            let mut entries = values
                .iter()
                .map(|(key, value)| (key.clone(), collection_value_key(value)))
                .collect::<Vec<_>>();
            entries.sort_unstable_by(|(left, _), (right, _)| left.cmp(right));
            CollectionValueKey::Object(entries)
        }
    }
}

fn optional_collection_values_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => collection_values_equal(left, right),
        _ => false,
    }
}

fn collection_mappings_equal(
    left: Option<&serde_json::Map<String, Value>>,
    right: Option<&serde_json::Map<String, Value>>,
) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, left)| {
                    right
                        .get(key)
                        .is_some_and(|right| collection_values_equal(left, right))
                })
        }
        _ => false,
    }
}

fn compare_json(left: &Value, right: &Value) -> Ordering {
    let kind = json_kind(left).cmp(&json_kind(right));
    if kind != Ordering::Equal {
        return kind;
    }
    match (left, right) {
        (Value::Null, Value::Null) => Ordering::Equal,
        (Value::Bool(left), Value::Bool(right)) => left.cmp(right),
        (Value::Number(left), Value::Number(right)) => compare_collection_numbers(left, right),
        (Value::String(left), Value::String(right)) => left.cmp(right),
        _ => left.to_string().cmp(&right.to_string()),
    }
}

#[cfg(test)]
fn compare_optional_json(left: Option<&Value>, right: Option<&Value>) -> Ordering {
    match (left, right) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some(left), Some(right)) => compare_json(left, right),
    }
}

#[cfg(test)]
fn compare_collection_records(
    left: &CollectionRecord,
    right: &CollectionRecord,
    sort: &[CollectionSort],
) -> Ordering {
    for sort in sort {
        let ordering = compare_optional_json(
            sortable_value_for_field(left, &sort.field),
            sortable_value_for_field(right, &sort.field),
        );
        let ordering = match sort.direction {
            ViewSortDirection::Asc => ordering,
            ViewSortDirection::Desc => ordering.reverse(),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    left.path
        .cmp(&right.path)
        .then_with(|| left.id.cmp(&right.id))
}

fn query_cursor_value(
    value: &CollectionQueryCursorValue,
) -> Result<Option<&Value>, crate::DomainError> {
    match value.present {
        true => Ok(Some(&value.value)),
        false if value.value.is_null() => Ok(None),
        false => Err(crate::DomainError::InvalidInput {
            reason: "collection query cursor is invalid",
        }),
    }
}

#[cfg(test)]
fn compare_record_to_cursor(
    record: &CollectionRecord,
    cursor: &CollectionQueryCursor,
    sort: &[CollectionSort],
) -> Result<Ordering, crate::DomainError> {
    if cursor.sort_values.len() != sort.len()
        || cursor.record_path.is_empty()
        || cursor.record_id.is_empty()
    {
        return Err(crate::DomainError::InvalidInput {
            reason: "collection query cursor is invalid",
        });
    }
    for (sort, cursor_value) in sort.iter().zip(&cursor.sort_values) {
        let ordering = compare_optional_json(
            sortable_value_for_field(record, &sort.field),
            query_cursor_value(cursor_value)?,
        );
        let ordering = match sort.direction {
            ViewSortDirection::Asc => ordering,
            ViewSortDirection::Desc => ordering.reverse(),
        };
        if ordering != Ordering::Equal {
            return Ok(ordering);
        }
    }
    Ok(record
        .path
        .cmp(&cursor.record_path)
        .then_with(|| record.id.cmp(&cursor.record_id)))
}

fn query_cursor_for_record(
    record: &CollectionRecord,
    sort: &[CollectionSort],
) -> CollectionQueryCursor {
    CollectionQueryCursor {
        sort_values: sort
            .iter()
            .map(|sort| match sortable_value_for_field(record, &sort.field) {
                Some(value) => CollectionQueryCursorValue {
                    present: true,
                    value: value.clone(),
                },
                None => CollectionQueryCursorValue {
                    present: false,
                    value: Value::Null,
                },
            })
            .collect(),
        record_path: record.path.clone(),
        record_id: record.id.clone(),
    }
}

fn group_collection_records(
    records: &[CollectionRecord],
    field: &str,
) -> Result<Vec<CollectionRecordGroup>, crate::DomainError> {
    let mut groups = Vec::<CollectionRecordGroup>::new();
    let mut group_indexes = HashMap::<CollectionValueKey, usize>::new();
    for record in records {
        let value = value_for_field(record, field)
            .cloned()
            .unwrap_or(Value::Null);
        let key = collection_value_key(&value);
        let index = match group_indexes.get(&key).copied() {
            Some(index) => index,
            None => {
                let index = groups.len();
                group_indexes.insert(key, index);
                groups.push(CollectionRecordGroup {
                    value,
                    records: Vec::new(),
                });
                index
            }
        };
        groups[index].records.push(record.clone());
    }
    Ok(groups)
}

/// Registers the connection-scoped SQL pieces the collection query pushdown
/// needs: a collation reproducing `compare_json` over stored `value_json`
/// text, and the filter matcher. Registration replaces any previous copy, so
/// repeating it per query is cheap and idempotent.
///
/// Cost: the collation parses both JSON operands on every comparison, about
/// n log(page) parses per query, where the old in-memory sort parsed each
/// value once. That trades CPU for memory bounded by the page instead of
/// the collection; a 100k-record sort on string-heavy fields is the
/// case to benchmark before relying on it.
fn register_collection_query_sql(conn: &Connection) -> Result<(), crate::DomainError> {
    conn.create_collation("DOHC_COLLECTION_JSON", |left, right| {
        match (
            serde_json::from_str::<Value>(left),
            serde_json::from_str::<Value>(right),
        ) {
            (Ok(left), Ok(right)) => compare_json(&left, &right),
            // value_json is CHECK json_valid; an unparsable operand still
            // needs a total order, so fall back to byte order.
            _ => left.cmp(right),
        }
    })
    .map_err(crate::DomainError::sql_corrupt)?;
    conn.create_scalar_function(
        "dohc_collection_filter_match",
        3,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let value: String = ctx.get(0)?;
            let operator: String = ctx.get(1)?;
            let needle: String = ctx.get(2)?;
            let (Ok(value), Ok(needle)) = (
                serde_json::from_str::<Value>(&value),
                serde_json::from_str::<Value>(&needle),
            ) else {
                return Ok(false);
            };
            Ok(match operator.as_str() {
                "equals" => collection_filter_value_matches(
                    &value,
                    CollectionFilterOperator::Equals,
                    &needle,
                ),
                "contains" => collection_filter_value_matches(
                    &value,
                    CollectionFilterOperator::Contains,
                    &needle,
                ),
                _ => false,
            })
        },
    )
    .map_err(crate::DomainError::sql_corrupt)?;
    Ok(())
}

/// The SQL expression for one sort field's value: the indexed `value_json`,
/// with depth-flagged values treated as missing exactly like
/// `sortable_value_for_field`.
fn sort_value_expression(join: &str) -> String {
    format!(
        "CASE WHEN {join}.validation_status='flagged' \
               AND json_extract({join}.validation_reason_json,'$.code')='value-depth-exceeded' \
          THEN NULL ELSE {join}.value_json END"
    )
}

/// One keyset level of the cursor predicate: the SQL expression, whether the
/// scan ascends through it, the serialized cursor value (`None` = the cursor
/// row had no value), and whether comparisons need the JSON collation.
struct CursorLevel {
    expression: String,
    ascending: bool,
    cursor_text: Option<String>,
    json_collation: bool,
}

/// Builds the strictly-after-the-cursor predicate as the standard keyset
/// expansion `OR_k (eq_0 AND .. AND eq_{k-1} AND after_k)`. NULL semantics
/// mirror `compare_optional_json`: a missing value sorts before every present
/// value ascending and after every present value descending, which is also
/// SQLite's NULL placement for ASC/DESC.
fn cursor_after_predicate(
    parameters: &mut Vec<rusqlite::types::Value>,
    levels: &[CursorLevel],
) -> String {
    let mut level_parts = Vec::new();
    for level in levels {
        let collate = if level.json_collation {
            " COLLATE DOHC_COLLECTION_JSON"
        } else {
            ""
        };
        let expression = &level.expression;
        let (after, equal) = match &level.cursor_text {
            Some(text) => {
                parameters.push(rusqlite::types::Value::Text(text.clone()));
                let parameter = parameters.len();
                let after = if level.ascending {
                    format!("({expression}{collate} > ?{parameter})")
                } else {
                    format!("({expression} IS NULL OR {expression}{collate} < ?{parameter})")
                };
                (after, format!("({expression}{collate} = ?{parameter})"))
            }
            None => {
                let after = if level.ascending {
                    format!("({expression} IS NOT NULL)")
                } else {
                    "(0)".to_owned()
                };
                (after, format!("({expression} IS NULL)"))
            }
        };
        level_parts.push((after, equal));
    }
    let mut branches = Vec::new();
    for (index, (after, _)) in level_parts.iter().enumerate() {
        let mut branch = level_parts[..index]
            .iter()
            .map(|(_, equal)| equal.clone())
            .collect::<Vec<_>>();
        branch.push(after.clone());
        branches.push(format!("({})", branch.join(" AND ")));
    }
    format!("({})", branches.join(" OR "))
}

// A schema blob never changes, so its button names never go stale. The cache
// starts over when it holds this many schemas.
const MAX_CACHED_SCHEMA_BUTTONS: usize = 64;
static SCHEMA_BUTTONS: LazyLock<Mutex<HashMap<String, Arc<HashSet<String>>>>> =
    LazyLock::new(Mutex::default);

/// The collection's button field names. A filtered, sorted, or grouped page
/// asks for them, so they are parsed once per schema blob, not once per page.
fn collection_button_fields(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    collection_path: &str,
) -> Result<Arc<HashSet<String>>, crate::DomainError> {
    let schema_sha256: String = conn
        .query_row(
            "SELECT s.blob_sha256 FROM collections c \
             JOIN snapshots s ON s.workspace_id=c.workspace_id \
               AND s.version_id=c.version_id AND s.path=c.schema_path \
             WHERE c.workspace_id=?1 AND c.version_id=?2 AND c.collection_path=?3",
            params![workspace_id, version_id, collection_path],
            |row| row.get(0),
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    let cache = || {
        SCHEMA_BUTTONS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    };
    if let Some(buttons) = cache().get(&schema_sha256) {
        return Ok(Arc::clone(buttons));
    }
    let text: String = conn
        .query_row(
            "SELECT text FROM blobs WHERE sha256=?1",
            params![schema_sha256],
            |row| row.get(0),
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    let buttons = Arc::new(
        parse_collection_schema(&text)
            .schema
            .fields
            .into_iter()
            .filter_map(|field| match field {
                FieldDefinition::Button { name } => Some(name),
                _ => None,
            })
            .collect::<HashSet<_>>(),
    );
    let mut cached = cache();
    if cached.len() >= MAX_CACHED_SCHEMA_BUTTONS {
        cached.clear();
    }
    cached.insert(schema_sha256, Arc::clone(&buttons));
    Ok(buttons)
}

/// A button stores no value, so a query cannot filter, sort, or group by one.
fn reject_button_field_references(
    buttons: &HashSet<String>,
    query: &CollectionQuery,
) -> Result<(), crate::DomainError> {
    let is_button = |name: &str| buttons.contains(name);
    let reason = if query
        .filter
        .as_ref()
        .is_some_and(|filter| is_button(&filter.field))
    {
        "collection query cannot filter by a button field"
    } else if query.sort.iter().any(|sort| is_button(&sort.field)) {
        "collection query cannot sort by a button field"
    } else if query.group_by.as_deref().is_some_and(is_button) {
        "collection query cannot group by a button field"
    } else {
        return Ok(());
    };
    Err(crate::DomainError::InvalidInput { reason })
}

/// Filter, sort, group, and optionally resolve relation labels from the active
/// version's persisted collection index. Raw indexed values are never reparsed
/// from record files, including when the schema is degraded.
///
/// The filter, sort, and cursor run in SQL over the indexed values (#986,
/// #991): a registered collation reproduces the cross-type `compare_json`
/// order over stored `value_json`, so a page reads and hydrates only the
/// records it returns instead of materializing the collection.
pub fn query_collection_records(
    conn: &Connection,
    workspace_id: &str,
    collection_path: &str,
    query: &CollectionQuery,
) -> Result<Option<CollectionQueryResult>, crate::DomainError> {
    if query.limit == 0 || query.limit > MAX_COLLECTION_QUERY_LIMIT {
        return Err(crate::DomainError::InvalidInput {
            reason: "collection query limit is invalid",
        });
    }
    if query.sort.len() > MAX_COLLECTION_QUERY_SORTS {
        return Err(crate::DomainError::InvalidInput {
            reason: "collection query sort limit is exceeded",
        });
    }
    if let Some(cursor) = &query.cursor
        && (cursor.sort_values.len() != query.sort.len()
            || cursor.record_path.is_empty()
            || cursor.record_id.is_empty())
    {
        return Err(crate::DomainError::InvalidInput {
            reason: "collection query cursor is invalid",
        });
    }
    let version_id = active_version_id(conn, workspace_id)?;
    let Some(collection) =
        collection_summary_for_version(conn, workspace_id, &version_id, collection_path)?
    else {
        return Ok(None);
    };
    if query.filter.is_some() || !query.sort.is_empty() || query.group_by.is_some() {
        let buttons = collection_button_fields(conn, workspace_id, &version_id, collection_path)?;
        reject_button_field_references(&buttons, query)?;
    }
    register_collection_query_sql(conn)?;
    let mut parameters = vec![
        rusqlite::types::Value::Text(workspace_id.to_owned()),
        rusqlite::types::Value::Text(version_id.clone()),
        rusqlite::types::Value::Text(collection_path.to_owned()),
    ];
    let mut joins = String::new();
    let mut sort_expressions = Vec::new();
    for (index, sort) in query.sort.iter().enumerate() {
        parameters.push(rusqlite::types::Value::Text(sort.field.clone()));
        let parameter = parameters.len();
        joins.push_str(&format!(
            " LEFT JOIN collection_record_fields s{index} \
               ON s{index}.workspace_id=r.workspace_id AND s{index}.version_id=r.version_id \
              AND s{index}.record_id=r.record_id AND s{index}.field_name=?{parameter}"
        ));
        sort_expressions.push(format!("({})", sort_value_expression(&format!("s{index}"))));
    }
    let mut predicates = vec![
        "r.workspace_id=?1 AND r.version_id=?2 AND r.collection_path=?3 \
         AND r.record_id IS NOT NULL"
            .to_owned(),
    ];
    if let Some(filter) = &query.filter {
        parameters.push(rusqlite::types::Value::Text(filter.field.clone()));
        let field_parameter = parameters.len();
        joins.push_str(&format!(
            " LEFT JOIN collection_record_fields f0 \
               ON f0.workspace_id=r.workspace_id AND f0.version_id=r.version_id \
              AND f0.record_id=r.record_id AND f0.field_name=?{field_parameter}"
        ));
        let operator = match filter.operator {
            CollectionFilterOperator::Equals => "equals",
            CollectionFilterOperator::Contains => "contains",
        };
        parameters.push(rusqlite::types::Value::Text(operator.to_owned()));
        let operator_parameter = parameters.len();
        parameters.push(rusqlite::types::Value::Text(
            serde_json::to_string(&filter.value).map_err(|_| crate::DomainError::StateCorrupt {
                reason: "collection filter value does not serialize",
            })?,
        ));
        let needle_parameter = parameters.len();
        predicates.push(format!(
            "f0.value_json IS NOT NULL \
             AND dohc_collection_filter_match(f0.value_json, ?{operator_parameter}, ?{needle_parameter})"
        ));
    }
    if let Some(cursor) = &query.cursor {
        let mut levels = Vec::new();
        for ((expression, sort), value) in sort_expressions
            .iter()
            .zip(&query.sort)
            .zip(&cursor.sort_values)
        {
            let cursor_text = query_cursor_value(value)?
                .map(|value| {
                    serde_json::to_string(value).map_err(|_| crate::DomainError::InvalidInput {
                        reason: "collection query cursor is invalid",
                    })
                })
                .transpose()?;
            levels.push(CursorLevel {
                expression: expression.clone(),
                ascending: sort.direction == ViewSortDirection::Asc,
                cursor_text,
                json_collation: true,
            });
        }
        levels.push(CursorLevel {
            expression: "r.file_path".to_owned(),
            ascending: true,
            cursor_text: Some(cursor.record_path.clone()),
            json_collation: false,
        });
        levels.push(CursorLevel {
            expression: "r.record_id".to_owned(),
            ascending: true,
            cursor_text: Some(cursor.record_id.clone()),
            json_collation: false,
        });
        predicates.push(cursor_after_predicate(&mut parameters, &levels));
    }
    let mut order_by = sort_expressions
        .iter()
        .zip(&query.sort)
        .map(|(expression, sort)| {
            let direction = match sort.direction {
                ViewSortDirection::Asc => "ASC",
                ViewSortDirection::Desc => "DESC",
            };
            format!("{expression} COLLATE DOHC_COLLECTION_JSON {direction}")
        })
        .collect::<Vec<_>>();
    order_by.push("r.file_path".to_owned());
    order_by.push("r.record_id".to_owned());
    parameters.push(rusqlite::types::Value::Integer(
        i64::try_from(query.limit + 1).expect("bounded collection query page limit"),
    ));
    let limit_parameter = parameters.len();
    let sql = format!(
        "SELECT r.record_id FROM collection_records r{joins} WHERE {} \
         ORDER BY {} LIMIT ?{limit_parameter}",
        predicates.join(" AND "),
        order_by.join(",")
    );
    let mut statement = conn
        .prepare(&sql)
        .map_err(crate::DomainError::sql_corrupt)?;
    let mut selected_ids = statement
        .query_map(rusqlite::params_from_iter(parameters.iter()), |row| {
            row.get::<_, String>(0)
        })
        .map_err(crate::DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::DomainError::sql_corrupt)?;
    let has_more = selected_ids.len() > query.limit;
    selected_ids.truncate(query.limit);
    let selected_order = selected_ids
        .iter()
        .enumerate()
        .map(|(index, record_id)| (record_id.as_str(), index))
        .collect::<HashMap<_, _>>();
    let mut records = load_collection_records_selected(
        conn,
        workspace_id,
        &version_id,
        collection_path,
        Some(&selected_ids),
        None,
    )?;
    records.sort_by_key(|record| {
        selected_order
            .get(record.id.as_str())
            .copied()
            .unwrap_or(usize::MAX)
    });
    let next_cursor = if has_more {
        records
            .last()
            .map(|record| query_cursor_for_record(record, &query.sort))
    } else {
        None
    };
    if query.resolve_relations {
        resolve_record_relations(
            conn,
            workspace_id,
            &version_id,
            collection_path,
            &mut records,
        )?;
    }
    let groups = query
        .group_by
        .as_deref()
        .map(|field| group_collection_records(&records, field))
        .transpose()?;
    Ok(Some(CollectionQueryResult {
        collection,
        records,
        groups,
        next_cursor,
    }))
}

fn history_value_from_json(
    value: Option<String>,
) -> Result<CollectionHistoryValue, crate::DomainError> {
    match value {
        Some(value) => Ok(CollectionHistoryValue {
            present: true,
            value: Some(serde_json::from_str(&value).map_err(|error| {
                crate::DomainError::Storage(StorageError::corrupt_public(error))
            })?),
        }),
        None => Ok(CollectionHistoryValue {
            present: false,
            value: None,
        }),
    }
}

/// One active-version record with its current indexed fields and a bounded,
/// newest-first history page.
pub fn get_collection_record(
    conn: &Connection,
    workspace_id: &str,
    collection_path: &str,
    record_id: &str,
    history_limit: usize,
    before_history_id: Option<i64>,
) -> Result<Option<CollectionRecordDetails>, crate::DomainError> {
    let version_id = active_version_id(conn, workspace_id)?;
    let Some(collection) =
        collection_summary_for_version(conn, workspace_id, &version_id, collection_path)?
    else {
        return Ok(None);
    };
    if collection
        .reasons
        .iter()
        .any(|reason| reason.code == CollectionSchemaReasonCode::UnsupportedVersion)
    {
        return Err(crate::DomainError::InvalidInput {
            reason: "collection.yaml uses a newer version. Update dohc to read this file.",
        });
    }
    let record = load_collection_records(
        conn,
        workspace_id,
        &version_id,
        collection_path,
        Some(record_id),
    )?
    .into_iter()
    .next();
    let Some(record) = record else {
        return Ok(None);
    };
    let before = before_history_id
        .map(|history_id| {
            conn.query_row(
                "SELECT recorded_at_ms,history_id FROM collection_field_history \
                 WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3 AND history_id=?4",
                params![workspace_id, version_id, record_id, history_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(crate::DomainError::sql_corrupt)?
            .ok_or(crate::DomainError::InvalidInput {
                reason: "collection history cursor is invalid",
            })
        })
        .transpose()?;
    let mut sql = String::from(
        "SELECT history_id,field_name,previous_value_json,next_value_json,author_origin_id,\
                actor_kind,on_behalf_of,chain_depth,recorded_at_ms,\
                automation_claim_id,automation_name \
         FROM collection_field_history \
         WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3",
    );
    let mut values = vec![
        rusqlite::types::Value::Text(workspace_id.to_owned()),
        rusqlite::types::Value::Text(version_id.clone()),
        rusqlite::types::Value::Text(record_id.to_owned()),
    ];
    if let Some((recorded_at_ms, history_id)) = before {
        values.push(rusqlite::types::Value::Integer(recorded_at_ms));
        let recorded_at_parameter = values.len();
        values.push(rusqlite::types::Value::Integer(history_id));
        let history_id_parameter = values.len();
        sql.push_str(&format!(
            " AND (recorded_at_ms,history_id) < (?{recorded_at_parameter},?{history_id_parameter})"
        ));
    }
    let history_limit = history_limit.min(MAX_COLLECTION_HISTORY_LIMIT);
    // One extra row makes "more pages exist" exact instead of inferred from a
    // full page, so the returned cursor is never a dead end or a false stop.
    values.push(rusqlite::types::Value::Integer(history_limit as i64 + 1));
    let limit_parameter = values.len();
    sql.push_str(&format!(
        " ORDER BY recorded_at_ms DESC,history_id DESC LIMIT ?{limit_parameter}"
    ));
    let mut statement = conn
        .prepare(&sql)
        .map_err(crate::DomainError::sql_corrupt)?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(values), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<String>>(10)?,
            ))
        })
        .map_err(crate::DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::DomainError::sql_corrupt)?;
    let mut history = rows
        .into_iter()
        .map(
            |(
                history_id,
                field,
                previous,
                next,
                author_origin_id,
                actor_kind,
                on_behalf_of,
                depth,
                recorded_at_ms,
                automation_claim_id,
                automation_name,
            )| {
                Ok(CollectionFieldHistoryEntry {
                    history_id,
                    field,
                    previous: history_value_from_json(previous)?,
                    next: history_value_from_json(next)?,
                    author_origin_id,
                    actor_kind: actor_kind
                        .as_deref()
                        .map(|value| {
                            ChangeActorKind::parse(value).ok_or(crate::DomainError::StateCorrupt {
                                reason: "collection history actor kind is unknown",
                            })
                        })
                        .transpose()?,
                    on_behalf_of,
                    depth,
                    recorded_at_ms,
                    automation_run: automation_claim_id.zip(automation_name).map(
                        |(claim_id, automation_name)| AutomationRunAttribution {
                            claim_id,
                            automation_name,
                        },
                    ),
                })
            },
        )
        .collect::<Result<Vec<_>, crate::DomainError>>()?;
    let has_more = history.len() > history_limit;
    history.truncate(history_limit);
    let next_before_history_id = has_more
        .then(|| history.last().map(|entry| entry.history_id))
        .flatten();
    Ok(Some(CollectionRecordDetails {
        collection,
        record,
        history,
        next_before_history_id,
    }))
}

fn is_calendar_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
    {
        return false;
    }
    let year = u32::from(bytes[0] - b'0') * 1_000
        + u32::from(bytes[1] - b'0') * 100
        + u32::from(bytes[2] - b'0') * 10
        + u32::from(bytes[3] - b'0');
    let month = usize::from(bytes[5] - b'0') * 10 + usize::from(bytes[6] - b'0');
    let day = u32::from(bytes[8] - b'0') * 10 + u32::from(bytes[9] - b'0');
    if !(1..=12).contains(&month) || day == 0 {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    day <= days[month - 1]
}

fn valid_url(value: &str) -> bool {
    let Some((scheme, remainder)) = value.split_once(':') else {
        return false;
    };
    let Some(first) = scheme.chars().next() else {
        return false;
    };
    !scheme.is_empty()
        && first.is_ascii_alphabetic()
        && scheme.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
        })
        && !remainder.is_empty()
        && !value.chars().any(is_js_trim_ws)
}

fn validate_sequence<F>(values: &[CollectionFieldValue], mut validate: F) -> FieldValueValidation
where
    F: FnMut(&CollectionFieldValue, &str) -> FieldValueValidation,
{
    let mut seen = HashSet::new();
    for (index, value) in values.iter().enumerate() {
        let path = format!("/{index}");
        let verdict = validate(value, &path);
        if !matches!(verdict, FieldValueValidation::Valid) {
            return verdict;
        }
        let key = match value {
            CollectionFieldValue::Text(value) => value,
            _ => continue,
        };
        if !seen.insert(key) {
            return flagged(FieldValueReasonCode::DuplicateValue, path);
        }
    }
    FieldValueValidation::Valid
}

#[must_use]
pub fn validate_field_value(
    field: &FieldDefinition,
    value: &CollectionFieldValue,
) -> FieldValueValidation {
    if matches!(value, CollectionFieldValue::Null) {
        return FieldValueValidation::Valid;
    }
    match field {
        FieldDefinition::Text { .. } => match value {
            CollectionFieldValue::Text(_) => FieldValueValidation::Valid,
            _ => flagged(FieldValueReasonCode::ExpectedText, ""),
        },
        FieldDefinition::Number { .. } => match value {
            CollectionFieldValue::Number(value) if value.is_finite() => FieldValueValidation::Valid,
            CollectionFieldValue::Number(_) => flagged(FieldValueReasonCode::NumberNotFinite, ""),
            _ => flagged(FieldValueReasonCode::ExpectedNumber, ""),
        },
        FieldDefinition::Checkbox { .. } => match value {
            CollectionFieldValue::Boolean(_) => FieldValueValidation::Valid,
            _ => flagged(FieldValueReasonCode::ExpectedBoolean, ""),
        },
        FieldDefinition::Date { .. } => match value {
            CollectionFieldValue::Text(value) if is_calendar_date(value) => {
                FieldValueValidation::Valid
            }
            CollectionFieldValue::Text(_) => flagged(FieldValueReasonCode::InvalidDate, ""),
            _ => flagged(FieldValueReasonCode::ExpectedText, ""),
        },
        FieldDefinition::Person { .. } => match value {
            CollectionFieldValue::Text(value) if !value.trim_matches(is_js_trim_ws).is_empty() => {
                FieldValueValidation::Valid
            }
            CollectionFieldValue::Text(_) => flagged(FieldValueReasonCode::EmptyPersonId, ""),
            _ => flagged(FieldValueReasonCode::ExpectedText, ""),
        },
        FieldDefinition::Url { .. } => match value {
            CollectionFieldValue::Text(value) if valid_url(value) => FieldValueValidation::Valid,
            CollectionFieldValue::Text(_) => flagged(FieldValueReasonCode::InvalidUrl, ""),
            _ => flagged(FieldValueReasonCode::ExpectedText, ""),
        },
        FieldDefinition::Select { options, .. } => {
            let options = options.iter().map(String::as_str).collect::<HashSet<_>>();
            match value {
                CollectionFieldValue::Text(value) if options.contains(value.as_str()) => {
                    FieldValueValidation::Valid
                }
                CollectionFieldValue::Text(_) => flagged(FieldValueReasonCode::UnknownOption, ""),
                _ => flagged(FieldValueReasonCode::ExpectedText, ""),
            }
        }
        FieldDefinition::MultiSelect { options, .. } => {
            let options = options.iter().map(String::as_str).collect::<HashSet<_>>();
            match value {
                CollectionFieldValue::Sequence(values) => {
                    validate_sequence(values, |value, path| match value {
                        CollectionFieldValue::Text(value) if options.contains(value.as_str()) => {
                            FieldValueValidation::Valid
                        }
                        CollectionFieldValue::Text(_) => {
                            flagged(FieldValueReasonCode::UnknownOption, path)
                        }
                        _ => flagged(FieldValueReasonCode::ExpectedText, path),
                    })
                }
                _ => flagged(FieldValueReasonCode::ExpectedSequence, ""),
            }
        }
        FieldDefinition::Relation { many, .. } => {
            let validate_record_id = |value: &CollectionFieldValue, path: &str| match value {
                CollectionFieldValue::Text(value) if is_record_id(value) => {
                    FieldValueValidation::Valid
                }
                CollectionFieldValue::Text(_) => {
                    flagged(FieldValueReasonCode::InvalidRecordId, path)
                }
                _ => flagged(FieldValueReasonCode::ExpectedText, path),
            };
            if *many {
                match value {
                    CollectionFieldValue::Sequence(values) => {
                        validate_sequence(values, validate_record_id)
                    }
                    _ => flagged(FieldValueReasonCode::ExpectedSequence, ""),
                }
            } else {
                validate_record_id(value, "")
            }
        }
        FieldDefinition::Button { .. } => flagged(FieldValueReasonCode::ExpectedEmpty, ""),
    }
}

#[must_use]
pub fn is_record_id(value: &str) -> bool {
    value.len() == RECORD_ID_PREFIX.len() + RECORD_ID_RANDOM_BASE32_LENGTH
        && value.starts_with(RECORD_ID_PREFIX)
        && value[RECORD_ID_PREFIX.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || matches!(byte, b'2'..=b'7'))
}

pub fn mint_record_id() -> Result<String, getrandom::Error> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random)?;
    Ok(record_id_from_random(random))
}

fn record_id_from_random(random: [u8; 16]) -> String {
    format!("{RECORD_ID_PREFIX}{}", base32_lowercase_no_padding(&random))
}

#[cfg(test)]
mod attribution_tests {
    use serde_json::json;

    use super::{AutomationRunAttribution, ChangeActorKind, ChangeAttribution};

    #[test]
    fn attribution_ids_and_names_refuse_control_characters() {
        let valid = ChangeAttribution {
            actor_kind: ChangeActorKind::Automation,
            on_behalf_of: Some("person".into()),
            depth: 0,
            run: Some(AutomationRunAttribution {
                claim_id: "claim".into(),
                automation_name: "Build".into(),
            }),
        };
        assert!(valid.validate().is_ok());
        for field in ["scope", "claim", "name"] {
            let mut invalid = valid.clone();
            match field {
                "scope" => invalid.on_behalf_of = Some("person\n".into()),
                "claim" => invalid.run.as_mut().expect("run").claim_id = "claim\u{0085}".into(),
                _ => invalid.run.as_mut().expect("run").automation_name = "Build\t".into(),
            }
            assert!(invalid.validate().is_err(), "{field}");
        }
    }

    /// The run rides the replicated update beside the attribution, so a peer
    /// records it too; a write that names none sends what it sent before.
    #[test]
    fn an_automation_run_round_trips_on_the_wire_and_only_when_named() {
        let named = ChangeAttribution {
            actor_kind: ChangeActorKind::Automation,
            on_behalf_of: Some("local".to_owned()),
            depth: 1,
            run: Some(AutomationRunAttribution {
                claim_id: "atc_1".to_owned(),
                automation_name: "Stamp the finish date".to_owned(),
            }),
        };
        let wire = serde_json::to_value(&named).expect("encode");
        assert_eq!(
            wire,
            json!({
                "actorKind": "automation",
                "onBehalfOf": "local",
                "depth": 1,
                "run": { "claimId": "atc_1", "automationName": "Stamp the finish date" },
            })
        );
        assert_eq!(
            serde_json::from_value::<ChangeAttribution>(wire).expect("decode"),
            named
        );
        let unnamed = ChangeAttribution { run: None, ..named };
        assert_eq!(
            serde_json::to_value(&unnamed).expect("encode"),
            json!({ "actorKind": "automation", "onBehalfOf": "local", "depth": 1 })
        );
    }

    #[test]
    fn only_a_bounded_automation_attribution_names_a_run() {
        let run = |claim_id: &str, automation_name: &str| {
            Some(AutomationRunAttribution {
                claim_id: claim_id.to_owned(),
                automation_name: automation_name.to_owned(),
            })
        };
        let attribution = |actor_kind, run| ChangeAttribution {
            actor_kind,
            on_behalf_of: None,
            depth: 1,
            run,
        };
        assert!(
            attribution(ChangeActorKind::Automation, run("atc_1", "Stamp"))
                .validate()
                .is_ok()
        );
        for refused in [
            attribution(ChangeActorKind::Agent, run("atc_1", "Stamp")),
            attribution(ChangeActorKind::Human, run("atc_1", "Stamp")),
            attribution(ChangeActorKind::Automation, run("", "Stamp")),
            attribution(ChangeActorKind::Automation, run("atc_1", " ")),
            attribution(
                ChangeActorKind::Automation,
                run(
                    "atc_1",
                    &"n".repeat(super::MAX_AUTOMATION_RUN_NAME_BYTES + 1),
                ),
            ),
        ] {
            assert!(refused.validate().is_err(), "{refused:?}");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cmp::Ordering;
    use std::collections::HashSet;
    use std::time::{Duration, Instant};

    use rusqlite::Connection;
    use serde_json::json;

    use super::{
        CollectionFieldValue, CollectionIndexedValue, CollectionIndexedValueValidation,
        CollectionRecord, CollectionSort, FieldDefinition, FieldValueReason, FieldValueReasonCode,
        FieldValueValidation, MAX_COLLECTION_FIELD_VALUE_DEPTH, ViewSortDirection,
        collection_value_key, collection_values_equal, compare_collection_records, compare_json,
        compare_record_to_cursor, ensure_historical_record_owners_backfilled,
        group_collection_records, index_historical_record_owner_moment_in_tx, is_record_id,
        latest_historical_record_id, load_historical_record_owners, markdown_record_id,
        mint_record_id, parse_markdown_frontmatter, query_cursor_for_record, record_id_from_random,
        unindexed_or_conflicted_relation_targets_still_present, validate_field_value,
    };
    use super::{
        CollectionFilter, CollectionFilterOperator, CollectionQuery, matches_collection_filter,
        query_collection_records,
    };
    use serde_json::Value;

    #[test]
    fn integer_json_comparison_preserves_precision_beyond_f64() {
        assert_eq!(
            compare_json(
                &json!(9_007_199_254_740_992_u64),
                &json!(9_007_199_254_740_993_u64)
            ),
            Ordering::Less
        );
        assert_eq!(compare_json(&json!(1), &json!(1.0)), Ordering::Equal);
        assert_eq!(
            compare_json(
                &json!(9_007_199_254_740_993_i64),
                &json!(9_007_199_254_740_992_f64)
            ),
            Ordering::Greater
        );
    }

    #[test]
    fn collection_group_keys_match_collection_value_equality() {
        let values = [
            json!(null),
            json!(false),
            json!(true),
            json!(0),
            json!(0.0),
            json!(-0.0),
            json!(-1),
            json!(-1.0),
            json!(i64::MIN),
            json!(i64::MIN as f64),
            json!(i64::MAX),
            json!(i64::MAX as f64),
            json!(u64::MAX),
            json!(u64::MAX as f64),
            json!(9_007_199_254_740_993_i64),
            json!(9_007_199_254_740_992_f64),
            json!("0"),
            json!([1, { "nested": 2.0 }]),
            serde_json::from_str(r#"{"b":2,"a":[1.0]}"#).expect("first object"),
            serde_json::from_str(r#"{"a":[1],"b":2.0}"#).expect("second object"),
        ];

        for left in &values {
            for right in &values {
                assert_eq!(
                    collection_value_key(left) == collection_value_key(right),
                    collection_values_equal(left, right),
                    "canonical grouping key disagrees for {left} and {right}"
                );
            }
        }
    }

    #[test]
    fn collection_scale_sweeps_stay_linear() {
        const SCALE_ITEMS: usize = 100_000;
        const SCALE_BUDGET: Duration = Duration::from_secs(30);

        let records = (0..SCALE_ITEMS)
            .map(|index| CollectionRecord {
                id: String::new(),
                path: String::new(),
                conflicted: false,
                values: vec![CollectionIndexedValue {
                    field: "group".to_owned(),
                    value: json!(format!("group_{index}")),
                    validation: CollectionIndexedValueValidation::Valid,
                    resolved_relations: Vec::new(),
                }],
            })
            .collect::<Vec<_>>();
        let started = Instant::now();
        let groups = group_collection_records(&records, "group").expect("group scale records");
        let group_elapsed = started.elapsed();
        assert_eq!(groups.len(), SCALE_ITEMS);
        drop(groups);
        drop(records);

        let options = (0..SCALE_ITEMS)
            .map(|index| format!("option_{index}"))
            .collect::<Vec<_>>();
        let values = CollectionFieldValue::Sequence(
            options
                .iter()
                .cloned()
                .map(CollectionFieldValue::Text)
                .collect(),
        );
        let field = FieldDefinition::MultiSelect {
            name: "labels".to_owned(),
            options,
        };
        let started = Instant::now();
        let validation = validate_field_value(&field, &values);
        let options_elapsed = started.elapsed();
        assert_eq!(validation, FieldValueValidation::Valid);
        drop(field);
        drop(values);

        let mut connection = Connection::open_in_memory().expect("open scale database");
        connection
            .execute_batch(
                "CREATE TABLE blobs(sha256 TEXT PRIMARY KEY,text TEXT NOT NULL);\
                 CREATE TABLE snapshots(\
                   workspace_id TEXT NOT NULL,version_id TEXT NOT NULL,path TEXT NOT NULL,\
                   object_id TEXT NOT NULL,blob_sha256 TEXT NOT NULL,content_kind TEXT NOT NULL\
                 );\
                 CREATE INDEX snapshots_relation_presence \
                   ON snapshots(workspace_id,version_id,path);\
                 CREATE TABLE moments(\
                   workspace_id TEXT NOT NULL,version_id TEXT NOT NULL,object_id TEXT NOT NULL,\
                   after_blob_sha256 TEXT NOT NULL,after_content_kind TEXT NOT NULL,\
                   moment_order INTEGER NOT NULL\
                 );\
                 CREATE TABLE conflicts(\
                   workspace_id TEXT NOT NULL,target_version_id TEXT NOT NULL,status TEXT NOT NULL,\
                   current_object_id TEXT,incoming_object_id TEXT,path TEXT NOT NULL\
                 );",
            )
            .expect("create scale tables");
        let collection_path = "scale";
        let relation_targets = (0..SCALE_ITEMS)
            .map(|index| (format!("record_{index}"), collection_path.to_owned()))
            .collect::<HashSet<_>>();
        let transaction = connection.transaction().expect("begin scale seed");
        {
            let mut insert_blob = transaction
                .prepare("INSERT INTO blobs(sha256,text) VALUES (?1,?2)")
                .expect("prepare scale blobs");
            let mut insert_snapshot = transaction
                .prepare(
                    "INSERT INTO snapshots(\
                       workspace_id,version_id,path,object_id,blob_sha256,content_kind\
                     ) VALUES ('workspace','version',?1,?2,?3,'text')",
                )
                .expect("prepare scale snapshots");
            for index in 0..SCALE_ITEMS {
                let record_id = format!("record_{index}");
                let blob_sha = format!("blob_{index}");
                insert_blob
                    .execute((&blob_sha, format!("---\nid: {record_id}\n---\n")))
                    .expect("insert scale blob");
                insert_snapshot
                    .execute((
                        format!("{collection_path}/{index:06}.md"),
                        format!("object_{index}"),
                        blob_sha,
                    ))
                    .expect("insert scale snapshot");
            }
        }
        transaction.commit().expect("commit scale seed");
        let started = Instant::now();
        let present = unindexed_or_conflicted_relation_targets_still_present(
            &connection,
            "workspace",
            "version",
            relation_targets,
        )
        .expect("scan scale relation targets");
        let relations_elapsed = started.elapsed();
        assert_eq!(present.len(), SCALE_ITEMS);

        let elapsed = group_elapsed + options_elapsed + relations_elapsed;
        assert!(
            elapsed <= SCALE_BUDGET,
            "linear collection sweeps took {elapsed:?} (group {group_elapsed:?}, options {options_elapsed:?}, relations {relations_elapsed:?}); budget {SCALE_BUDGET:?}"
        );
    }

    #[test]
    fn historical_record_owner_backfill_runs_once_then_moments_append_incrementally() {
        const FIRST_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
        const RAW_AFTER_MARKER_ID: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
        const APPENDED_ID: &str = "rec_cccccccccccccccccccccccccc";
        let connection = Connection::open_in_memory().expect("open owner index database");
        connection
            .execute_batch(
                "CREATE TABLE blobs(sha256 TEXT PRIMARY KEY,text TEXT NOT NULL);\
                 CREATE TABLE versions(\
                   workspace_id TEXT NOT NULL,version_id TEXT NOT NULL,\
                   PRIMARY KEY(workspace_id,version_id)\
                 );\
                 CREATE TABLE moments(\
                   workspace_id TEXT NOT NULL,version_id TEXT NOT NULL,object_id TEXT NOT NULL,\
                   path TEXT NOT NULL,after_blob_sha256 TEXT,after_content_kind TEXT NOT NULL,\
                   moment_order INTEGER NOT NULL,PRIMARY KEY(workspace_id,moment_order)\
                 );\
                 CREATE TABLE collection_historical_record_owners(\
                   workspace_id TEXT NOT NULL,version_id TEXT NOT NULL,object_id TEXT NOT NULL,\
                   moment_order INTEGER NOT NULL,record_id TEXT NOT NULL,\
                   collection_path TEXT NOT NULL,PRIMARY KEY(workspace_id,moment_order)\
                 );\
                 CREATE TABLE collection_historical_record_owner_backfills(\
                   workspace_id TEXT NOT NULL,version_id TEXT NOT NULL,index_version INTEGER NOT NULL,\
                   PRIMARY KEY(workspace_id,version_id)\
                 );\
                 INSERT INTO versions(workspace_id,version_id) VALUES('workspace','version');\
                 INSERT INTO blobs(sha256,text) VALUES\
                   ('first','---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n'),\
                   ('raw','---\nid: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n---\n'),\
                   ('appended','---\nid: rec_cccccccccccccccccccccccccc\n---\n');\
                 INSERT INTO moments(\
                   workspace_id,version_id,object_id,path,after_blob_sha256,\
                   after_content_kind,moment_order\
                 ) VALUES ('workspace','version','first-object','tasks/first.md','first','text',1);",
            )
            .expect("create and seed owner index database");

        ensure_historical_record_owners_backfilled(&connection, "workspace", "version")
            .expect("backfill historical owners");
        let first = load_historical_record_owners(&connection, "workspace", "version")
            .expect("read first backfill");
        assert!(first[FIRST_ID].contains("first-object"));

        connection
            .execute(
                "INSERT INTO moments(\
                   workspace_id,version_id,object_id,path,after_blob_sha256,\
                   after_content_kind,moment_order\
                 ) VALUES ('workspace','version','raw-object','tasks/raw.md','raw','text',2)",
                [],
            )
            .expect("seed an unindexed moment after the marker");
        ensure_historical_record_owners_backfilled(&connection, "workspace", "version")
            .expect("observe completed backfill marker");
        let after_marker = load_historical_record_owners(&connection, "workspace", "version")
            .expect("read marker-protected owners");
        assert!(
            !after_marker.contains_key(RAW_AFTER_MARKER_ID),
            "a completed version marker must prevent another full moment scan"
        );
        assert_eq!(
            latest_historical_record_id(&connection, "workspace", "version", "raw-object")
                .expect("read the unindexed object identity"),
            None,
            "latest_historical_record_id must read the index, not rescan moments"
        );

        connection
            .execute(
                "INSERT INTO moments(\
                   workspace_id,version_id,object_id,path,after_blob_sha256,\
                   after_content_kind,moment_order\
                 ) VALUES ('workspace','version','appended-object','tasks/appended.md',\
                           'appended','text',3)",
                [],
            )
            .expect("append a new text moment");
        index_historical_record_owner_moment_in_tx(&connection, "workspace", 3)
            .expect("index the appended text moment");
        let appended = load_historical_record_owners(&connection, "workspace", "version")
            .expect("read incrementally maintained owners");
        assert!(appended[APPENDED_ID].contains("appended-object"));
        assert_eq!(
            latest_historical_record_id(&connection, "workspace", "version", "appended-object",)
                .expect("read latest indexed identity"),
            Some((APPENDED_ID.to_owned(), "tasks".to_owned()))
        );
    }

    #[test]
    fn overdepth_sort_coordinates_use_record_tiebreakers() {
        let record = |path: &str, id: &str, leaf: &str| {
            let value =
                (0..MAX_COLLECTION_FIELD_VALUE_DEPTH).fold(json!(leaf), |value, _| json!([value]));
            CollectionRecord {
                id: id.to_owned(),
                path: path.to_owned(),
                conflicted: false,
                values: vec![CollectionIndexedValue {
                    field: "deep".to_owned(),
                    value,
                    validation: CollectionIndexedValueValidation::Flagged {
                        reason: FieldValueReason {
                            code: FieldValueReasonCode::ValueDepthExceeded,
                            path: String::new(),
                        },
                    },
                    resolved_relations: Vec::new(),
                }],
            }
        };
        let first = record("depth/alpha.md", "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa", "zulu");
        let second = record("depth/beta.md", "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb", "alpha");
        let sort = [CollectionSort {
            field: "deep".to_owned(),
            direction: ViewSortDirection::Asc,
        }];

        assert_eq!(
            compare_collection_records(&first, &second, &sort),
            Ordering::Less,
            "an unusable sort value must leave record path/id as the page order"
        );
        let cursor = query_cursor_for_record(&first, &sort);
        assert_eq!(cursor.sort_values.len(), 1);
        assert!(!cursor.sort_values[0].present);
        assert!(cursor.sort_values[0].value.is_null());
        assert_eq!(cursor.record_path, first.path.as_str());
        assert_eq!(cursor.record_id, first.id.as_str());
        assert_eq!(
            compare_record_to_cursor(&second, &cursor, &sort).expect("valid cursor"),
            Ordering::Greater
        );
    }

    /// The shared fixture cannot hold JSON nested past serde_json's own
    /// limit, so the depth boundary is pinned here and in the desktop's
    /// import-export tests.
    #[test]
    fn frontmatter_reads_up_to_the_depth_limit_and_refuses_deeper_or_hostile_yaml() {
        let flow = |depth: usize| {
            format!(
                "---\nvalue: {}x{}\n---\n",
                "[".repeat(depth),
                "]".repeat(depth)
            )
        };
        let mut serializer = serde_json::Serializer::new(Vec::new());
        let read = parse_markdown_frontmatter(&flow(super::MAX_FRONTMATTER_DEPTH - 1))
            .expect("nesting at the limit reads")
            .value;
        // Compare through serialization: `Value` equality recurses per level.
        serde::Serialize::serialize(&read["value"], &mut serializer).unwrap();
        assert_eq!(
            String::from_utf8(serializer.into_inner()).unwrap(),
            format!(
                "{}\"x\"{}",
                "[".repeat(super::MAX_FRONTMATTER_DEPTH - 1),
                "]".repeat(super::MAX_FRONTMATTER_DEPTH - 1)
            )
        );
        for markdown in [
            flow(super::MAX_FRONTMATTER_DEPTH),
            format!("---\ntitle:\n{}x\n---\n", "- ".repeat(500_000)),
            flow(500_000),
        ] {
            assert!(super::markdown_frontmatter_json(&markdown).is_none());
            assert_eq!(markdown_record_id(&markdown), None);
        }
    }

    /// Frontmatter a peer can sync in a file up to 10 MiB. Each input would
    /// copy gigabytes if the loader expanded it; the loader refuses each one
    /// before building anything that large.
    #[test]
    fn frontmatter_that_would_expand_past_its_budgets_is_refused() {
        let aliases = |count: usize| vec!["*s"; count].join(", ");
        for markdown in [
            format!(
                "---\n%TAG !e! tag:{}\n--- # x\na: [{}a]\n---\n",
                "x".repeat(1 << 20),
                "!e!x a, ".repeat(140_000)
            ),
            format!(
                "---\ns: &s \"{}\"\nv: {}{}{}\n---\n",
                "x".repeat(1_900_000),
                "&a [".repeat(128),
                aliases(256),
                "]".repeat(128)
            ),
            format!(
                "---\ns: &s \"{}\"\nv: [{}]\n---\n",
                "x".repeat(2_000_000),
                aliases(256)
            ),
            "---\na: \"x\ry\"\n---\n".to_owned(),
        ] {
            assert!(super::markdown_frontmatter_json(&markdown).is_none());
            assert_eq!(markdown_record_id(&markdown), None);
        }
    }

    /// An anchored integer spelled with 500,000 leading zeros, repeated by a
    /// ladder of aliases 32,768 times, stays within every budget. The loader
    /// resolves the spelling once, so reading it costs one scan, not one per
    /// repetition. The bound is far above one scan and far below 32,768.
    #[test]
    fn an_aliased_long_scalar_is_resolved_once() {
        let mut yaml = format!(
            "l0: &l0 {}7
",
            "0".repeat(500_000)
        );
        for level in 1..=15 {
            yaml.push_str(&format!(
                "l{level}: &l{level} [*l{}, *l{}]
",
                level - 1,
                level - 1
            ));
        }
        let markdown = format!(
            "---
{yaml}---
"
        );
        let started = std::time::Instant::now();
        let value = super::markdown_frontmatter_json(&markdown).expect("the ladder reads");
        assert_eq!(value["l0"], 7);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(60),
            "reading took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn duplicate_and_escaped_frontmatter_keys_are_rejected_by_both_rust_parsers() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/collection-frontmatter.json"
        ))
        .expect("frontmatter fixture parses");
        let vectors = fixture["vectors"].as_array().expect("frontmatter vectors");
        let mut checked = 0;
        for vector in vectors {
            if !vector["name"]
                .as_str()
                .is_some_and(|name| name.starts_with("duplicate-"))
            {
                continue;
            }
            let markdown = vector["markdown"].as_str().expect("duplicate markdown");
            assert_eq!(vector["expected"], serde_json::Value::Null);
            assert_eq!(markdown_record_id(markdown), None, "{}", vector["name"]);
            assert!(
                parse_markdown_frontmatter(markdown).is_none(),
                "{}",
                vector["name"]
            );
            checked += 1;
        }
        assert!(checked > 1, "the duplicate-key matrix must stay plural");
    }

    #[test]
    fn record_id_encoding_uses_all_sixteen_random_bytes() {
        assert_eq!(
            record_id_from_random([0; 16]),
            "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert_eq!(
            record_id_from_random([u8::MAX; 16]),
            "rec_77777777777777777777777774"
        );
    }

    #[test]
    fn minted_record_id_matches_the_contract() {
        let id = mint_record_id().expect("the operating system provides randomness");
        assert!(is_record_id(&id));
    }

    /// Deterministic xorshift64* generator: the differential below must be
    /// reproducible from its printed seed.
    struct DifferentialRng(u64);

    impl DifferentialRng {
        fn next(&mut self) -> u64 {
            let mut state = self.0;
            state ^= state >> 12;
            state ^= state << 25;
            state ^= state >> 27;
            self.0 = state;
            state.wrapping_mul(0x2545_f491_4f6c_dd1d)
        }

        fn pick(&mut self, bound: usize) -> usize {
            (self.next() % bound as u64) as usize
        }
    }

    fn differential_value_pool() -> Vec<Value> {
        vec![
            Value::Null,
            json!(true),
            json!(false),
            json!(-1),
            json!(0),
            json!(1),
            json!(i64::MIN),
            json!(i64::MAX),
            json!(u64::MAX),
            json!(9_007_199_254_740_993_u64),
            json!(-0.5),
            json!(2.5),
            json!(1e300),
            json!(-1e300),
            json!(9_007_199_254_740_992.0),
            json!(""),
            json!("a"),
            json!("b"),
            json!("aa"),
            json!([1, "a"]),
            json!([[2], {"k": 1}]),
            json!({"k": 1}),
            json!({"a": 1, "b": 2}),
        ]
    }

    /// The pre-pushdown in-memory pipeline, kept as the differential oracle:
    /// filter, total sort, then fixed-size pages.
    fn reference_page_ids(
        records: &[CollectionRecord],
        query: &CollectionQuery,
    ) -> Vec<Vec<String>> {
        let mut records = records.to_vec();
        if let Some(filter) = &query.filter {
            records.retain(|record| matches_collection_filter(record, filter));
        }
        records.sort_by(|left, right| compare_collection_records(left, right, &query.sort));
        let mut pages = records
            .chunks(query.limit)
            .map(|page| page.iter().map(|record| record.id.clone()).collect())
            .collect::<Vec<Vec<String>>>();
        if pages.is_empty() {
            pages.push(Vec::new());
        }
        pages
    }

    #[test]
    fn sql_query_pushdown_matches_the_in_memory_reference() {
        const WORKSPACE: &str = "differential-workspace";
        const COLLECTION: &str = "c";
        const FIELDS: [&str; 3] = ["alpha", "beta", "gamma"];
        let connection = Connection::open_in_memory().expect("open differential database");
        connection
            .execute_batch(
                "CREATE TABLE versioned_workspaces(\
                   workspace_id TEXT PRIMARY KEY, main_version_id TEXT NOT NULL);\
                 CREATE TABLE active_versions(\
                   workspace_id TEXT PRIMARY KEY, version_id TEXT NOT NULL);\
                 CREATE TABLE collections(\
                   workspace_id TEXT, version_id TEXT, collection_path TEXT,\
                   schema_status TEXT NOT NULL, degradation_reasons_json TEXT NOT NULL,\
                   schema_path TEXT NOT NULL,\
                   PRIMARY KEY (workspace_id, version_id, collection_path));\
                 CREATE TABLE snapshots(\
                   workspace_id TEXT, version_id TEXT, path TEXT, blob_sha256 TEXT NOT NULL,\
                   object_id TEXT NOT NULL, PRIMARY KEY (workspace_id, version_id, path));\
                 CREATE TABLE blobs(sha256 TEXT PRIMARY KEY, text TEXT NOT NULL);\
                 CREATE TABLE collection_records(\
                   workspace_id TEXT, version_id TEXT, record_id TEXT,\
                   collection_path TEXT, file_path TEXT, adoption_state TEXT NOT NULL,\
                   PRIMARY KEY (workspace_id, version_id, file_path));\
                 CREATE TABLE collection_record_fields(\
                   workspace_id TEXT, version_id TEXT, record_id TEXT,\
                   field_name TEXT, value_json TEXT NOT NULL,\
                   validation_status TEXT NOT NULL, validation_reason_json TEXT,\
                   PRIMARY KEY (workspace_id, version_id, record_id, field_name));\
                 INSERT INTO blobs VALUES ('differential-schema', 'fields: []');",
            )
            .expect("differential schema");
        connection
            .execute(
                "INSERT INTO versioned_workspaces VALUES (?1, 'main')",
                [WORKSPACE],
            )
            .expect("workspace row");
        connection
            .execute(
                "INSERT INTO collections VALUES (?1, 'main', ?2, 'valid', '[]', 'schema.yaml')",
                [WORKSPACE, COLLECTION],
            )
            .expect("collection row");
        // A filtered or sorted page reads the schema for its button fields.
        connection
            .execute(
                "INSERT INTO snapshots VALUES (?1, 'main', 'schema.yaml', 'differential-schema', 'schema-object')",
                [WORKSPACE],
            )
            .expect("schema snapshot");
        let pool = differential_value_pool();
        let depth_reason = serde_json::to_string(&FieldValueReason {
            code: FieldValueReasonCode::ValueDepthExceeded,
            path: String::new(),
        })
        .expect("depth reason");
        let flagged_reason = serde_json::to_string(&FieldValueReason {
            code: FieldValueReasonCode::ExpectedText,
            path: String::new(),
        })
        .expect("flagged reason");

        for seed in 1_u64..=60 {
            let mut rng = DifferentialRng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15));
            connection
                .execute("DELETE FROM collection_records", [])
                .expect("clear records");
            connection
                .execute("DELETE FROM collection_record_fields", [])
                .expect("clear fields");
            let record_count = rng.pick(12);
            let mut records = Vec::new();
            for index in 0..record_count {
                let record_id = format!("rec_{seed}_{index}");
                let file_path = format!("{COLLECTION}/r{index}.md");
                connection
                    .execute(
                        "INSERT INTO collection_records VALUES (?1,'main',?2,?3,?4,'adopted')",
                        rusqlite::params![WORKSPACE, record_id, COLLECTION, file_path],
                    )
                    .expect("record row");
                let mut values = Vec::new();
                for field in FIELDS {
                    // A quarter of fields are missing entirely.
                    if rng.pick(4) == 0 {
                        continue;
                    }
                    let value = pool[rng.pick(pool.len())].clone();
                    let (status, reason, validation) = match rng.pick(6) {
                        0 => (
                            "flagged",
                            Some(depth_reason.as_str()),
                            CollectionIndexedValueValidation::Flagged {
                                reason: FieldValueReason {
                                    code: FieldValueReasonCode::ValueDepthExceeded,
                                    path: String::new(),
                                },
                            },
                        ),
                        1 => (
                            "flagged",
                            Some(flagged_reason.as_str()),
                            CollectionIndexedValueValidation::Flagged {
                                reason: FieldValueReason {
                                    code: FieldValueReasonCode::ExpectedText,
                                    path: String::new(),
                                },
                            },
                        ),
                        2 => ("untyped", None, CollectionIndexedValueValidation::Untyped),
                        _ => ("valid", None, CollectionIndexedValueValidation::Valid),
                    };
                    connection
                        .execute(
                            "INSERT INTO collection_record_fields \
                             VALUES (?1,'main',?2,?3,?4,?5,?6)",
                            rusqlite::params![
                                WORKSPACE,
                                record_id,
                                field,
                                serde_json::to_string(&value).expect("value json"),
                                status,
                                reason,
                            ],
                        )
                        .expect("field row");
                    values.push(CollectionIndexedValue {
                        field: field.to_owned(),
                        value,
                        validation,
                        resolved_relations: Vec::new(),
                    });
                }
                records.push(CollectionRecord {
                    id: record_id,
                    path: file_path,
                    conflicted: false,
                    values,
                });
            }
            let sort = (0..rng.pick(4))
                .map(|_| CollectionSort {
                    field: FIELDS[rng.pick(FIELDS.len())].to_owned(),
                    direction: if rng.pick(2) == 0 {
                        ViewSortDirection::Asc
                    } else {
                        ViewSortDirection::Desc
                    },
                })
                .collect::<Vec<_>>();
            let filter = (rng.pick(2) == 0).then(|| CollectionFilter {
                field: FIELDS[rng.pick(FIELDS.len())].to_owned(),
                operator: if rng.pick(2) == 0 {
                    CollectionFilterOperator::Equals
                } else {
                    CollectionFilterOperator::Contains
                },
                value: pool[rng.pick(pool.len())].clone(),
            });
            let query = CollectionQuery {
                filter,
                sort,
                group_by: None,
                resolve_relations: false,
                limit: 1 + rng.pick(3),
                cursor: None,
            };
            let expected_pages = reference_page_ids(&records, &query);

            let mut actual_pages = Vec::new();
            let mut cursor = None;
            loop {
                let page = query_collection_records(
                    &connection,
                    WORKSPACE,
                    COLLECTION,
                    &CollectionQuery {
                        cursor: cursor.clone(),
                        ..query.clone()
                    },
                )
                .expect("differential query")
                .expect("differential collection");
                actual_pages.push(
                    page.records
                        .iter()
                        .map(|record| record.id.clone())
                        .collect::<Vec<_>>(),
                );
                match page.next_cursor {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
                assert!(
                    actual_pages.len() <= records.len() + 1,
                    "seed {seed}: the cursor loop must terminate"
                );
            }
            assert_eq!(
                actual_pages, expected_pages,
                "seed {seed}: the SQL pushdown must page exactly like the \
                 in-memory reference (sort {:?}, filter {:?}, limit {})",
                query.sort, query.filter, query.limit
            );
        }
    }
}
