//! Rust twin of `packages/workspace-contracts/src/collectionValues.ts`.
//!
//! The TypeScript implementation is the fixture oracle. The shared vectors
//! hold this port to the same schema recovery, Field value, and Record id
//! outcomes.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

use dohc_engine_files::canonical_workspace_path_meets_shared_bounds;
use dohc_engine_storage::StorageError;
use rusqlite::{Connection, OptionalExtension, params};
use saphyr::{
    AnnotatedMappingOwned, AnnotatedNodeOwned, LoadableYamlNode, MappingOwned, MarkedYamlOwned,
    ScalarOwned, ScalarStyle, Tag, Yaml, YamlDataOwned, YamlOwned,
};
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
            | Self::Url { name } => name,
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
    pub status: CollectionSchemaStatus,
    pub reasons: Vec<CollectionSchemaReason>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionDetails {
    pub path: String,
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
    pub recorded_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRecordDetails {
    pub collection: CollectionSummary,
    pub record: CollectionRecord,
    pub history: Vec<CollectionFieldHistoryEntry>,
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

fn is_workspace_relative_collection_path(value: &str) -> bool {
    canonical_workspace_path_meets_shared_bounds(value)
        && !value.is_empty()
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains('\\')
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
                    _ => unreachable!("match arm only admits scalar Field types"),
                });
            }
        }
    }
    fields
}

fn parse_field_reference(
    raw: Option<&YamlOwned>,
    path: &str,
    field_names: &HashSet<&str>,
    reasons: &mut Vec<CollectionSchemaReason>,
) -> Option<String> {
    let raw = raw?;
    let Some(value) = raw.as_str() else {
        push_reason(reasons, CollectionSchemaReasonCode::ExpectedText, path);
        return None;
    };
    if value.is_empty() {
        push_reason(reasons, CollectionSchemaReasonCode::EmptyValue, path);
    } else if field_names.contains(value) {
        return Some(value.to_owned());
    } else {
        push_reason(
            reasons,
            CollectionSchemaReasonCode::UnknownFieldReference,
            path,
        );
    }
    None
}

fn parse_sort(
    raw: Option<&YamlOwned>,
    path: &str,
    field_names: &HashSet<&str>,
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
            if field_names.contains(field.as_str()) {
                if let Some(direction) = direction {
                    sort.push(ViewSort { field, direction });
                }
            } else {
                push_reason(
                    reasons,
                    CollectionSchemaReasonCode::UnknownFieldReference,
                    format!("{entry_path}/field"),
                );
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
                reasons,
            ),
            sort: parse_sort(
                mapping_get(view, "sort"),
                &format!("{path}/sort"),
                &field_names,
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

    let mut reasons = Vec::new();
    report_unknown_properties(
        root,
        &["name", "description", "fields", "views"],
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

fn parent_path(path: &str) -> &str {
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

fn is_frontmatter_delimiter(line: &str) -> bool {
    line.trim_end_matches(['\r', '\n'])
        .strip_prefix("---")
        .is_some_and(|suffix| {
            suffix
                .chars()
                .all(|character| matches!(character, ' ' | '\t'))
        })
}

static DUPLICATE_YAML_NODE_ID: AtomicUsize = AtomicUsize::new(1);

#[derive(Debug)]
struct DuplicateYamlNode {
    id: usize,
    data: YamlDataOwned<Self>,
}

impl DuplicateYamlNode {
    fn new(data: YamlDataOwned<Self>) -> Self {
        Self {
            id: DUPLICATE_YAML_NODE_ID.fetch_add(1, AtomicOrdering::Relaxed),
            data,
        }
    }
}

impl Clone for DuplicateYamlNode {
    fn clone(&self) -> Self {
        Self::new(self.data.clone())
    }
}

impl PartialEq for DuplicateYamlNode {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl Eq for DuplicateYamlNode {}

impl Hash for DuplicateYamlNode {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.id.hash(state);
    }
}

impl AnnotatedNodeOwned for DuplicateYamlNode {
    type HashKey = Self;

    fn parse_representation_recursive(&mut self) -> bool {
        self.data.parse_representation_recursive()
    }
}

impl From<YamlDataOwned<DuplicateYamlNode>> for DuplicateYamlNode {
    fn from(data: YamlDataOwned<Self>) -> Self {
        Self::new(data)
    }
}

impl<'input> LoadableYamlNode<'input> for DuplicateYamlNode {
    type HashKey = Self;

    fn from_bare_yaml(yaml: Yaml<'input>) -> Self {
        Self::new(match yaml {
            Yaml::Sequence(_) => YamlDataOwned::Sequence(Vec::new()),
            Yaml::Mapping(_) => YamlDataOwned::Mapping(AnnotatedMappingOwned::new()),
            Yaml::Alias(alias) => YamlDataOwned::Alias(alias),
            Yaml::BadValue => YamlDataOwned::BadValue,
            Yaml::Representation(value, style, tag) => {
                YamlDataOwned::Representation(value.into_owned(), style, tag.map(Cow::into_owned))
            }
            Yaml::Tagged(tag, value) => {
                YamlDataOwned::Tagged(tag.into_owned(), Box::new(Self::from_bare_yaml(*value)))
            }
            Yaml::Value(value) => YamlDataOwned::Value(value.into_owned()),
        })
    }

    fn is_sequence(&self) -> bool {
        self.data.is_sequence()
    }

    fn is_mapping(&self) -> bool {
        self.data.is_mapping()
    }

    fn is_badvalue(&self) -> bool {
        self.data.is_badvalue()
    }

    fn sequence_mut(&mut self) -> &mut Vec<Self> {
        self.data.as_vec_mut().expect("sequence node")
    }

    fn mapping_mut(&mut self) -> &mut AnnotatedMappingOwned<Self> {
        self.data.as_mapping_mut().expect("mapping node")
    }

    fn into_tagged(self, tag: Cow<'input, Tag>) -> Self {
        Self::new(YamlDataOwned::Tagged(tag.into_owned(), Box::new(self)))
    }

    fn take(&mut self) -> Self {
        std::mem::replace(self, Self::new(YamlDataOwned::BadValue))
    }
}

fn duplicate_yaml_key_text(value: &DuplicateYamlNode) -> Option<String> {
    match &value.data {
        YamlDataOwned::Value(ScalarOwned::String(value))
        | YamlDataOwned::Representation(value, _, _) => Some(value.clone()),
        YamlDataOwned::Value(ScalarOwned::Integer(value)) => Some(value.to_string()),
        YamlDataOwned::Value(ScalarOwned::FloatingPoint(value)) => Some(value.to_string()),
        YamlDataOwned::Value(ScalarOwned::Boolean(value)) => Some(value.to_string()),
        YamlDataOwned::Value(ScalarOwned::Null) => Some("null".to_owned()),
        YamlDataOwned::Tagged(_, value) => duplicate_yaml_key_text(value),
        _ => None,
    }
}

fn duplicate_yaml_string(value: &DuplicateYamlNode) -> Option<&str> {
    match &value.data {
        YamlDataOwned::Value(ScalarOwned::String(value))
        | YamlDataOwned::Representation(value, _, _) => Some(value),
        YamlDataOwned::Tagged(_, value) => duplicate_yaml_string(value),
        _ => None,
    }
}

fn duplicate_yaml_mapping(
    value: &DuplicateYamlNode,
) -> Option<&AnnotatedMappingOwned<DuplicateYamlNode>> {
    match &value.data {
        YamlDataOwned::Mapping(mapping) => Some(mapping),
        YamlDataOwned::Tagged(_, value) => duplicate_yaml_mapping(value),
        _ => None,
    }
}

fn duplicate_yaml_value_has_duplicate_mapping_key(value: &DuplicateYamlNode) -> bool {
    match &value.data {
        YamlDataOwned::Sequence(values) => values
            .iter()
            .any(duplicate_yaml_value_has_duplicate_mapping_key),
        YamlDataOwned::Mapping(mapping) => {
            let mut seen = HashSet::new();
            for (key, value) in mapping {
                if duplicate_yaml_key_text(key).is_some_and(|key| !seen.insert(key))
                    || duplicate_yaml_value_has_duplicate_mapping_key(key)
                    || duplicate_yaml_value_has_duplicate_mapping_key(value)
                {
                    return true;
                }
            }
            false
        }
        YamlDataOwned::Tagged(_, value) => duplicate_yaml_value_has_duplicate_mapping_key(value),
        _ => false,
    }
}

fn markdown_record_id(markdown: &str) -> Option<String> {
    let mut lines = markdown.split_inclusive('\n');
    let first = lines.next()?;
    if !first.ends_with('\n') || !is_frontmatter_delimiter(first) {
        return None;
    }
    let yaml_start = first.len();
    let mut yaml_end = yaml_start;
    let mut found_end = false;
    for line in lines {
        if is_frontmatter_delimiter(line) {
            found_end = true;
            break;
        }
        yaml_end += line.len();
    }
    if !found_end {
        return None;
    }
    let yaml_source = &markdown[yaml_start..yaml_end];
    let documents = DuplicateYamlNode::load_from_str(yaml_source).ok()?;
    if documents.len() != 1 {
        return None;
    }
    let document = documents.first()?;
    if duplicate_yaml_value_has_duplicate_mapping_key(document) {
        return None;
    }
    let mapping = duplicate_yaml_mapping(document)?;
    mapping
        .iter()
        .rev()
        .find_map(|(key, value)| {
            (duplicate_yaml_key_text(key).as_deref() == Some(RECORD_ID_FRONTMATTER_KEY))
                .then_some(value)
        })
        .and_then(duplicate_yaml_string)
        .map(str::to_owned)
}

fn non_finite_yaml_number(value: f64) -> Option<&'static str> {
    if value.is_nan() {
        Some(".nan")
    } else if value == f64::INFINITY {
        Some(".inf")
    } else if value == f64::NEG_INFINITY {
        Some("-.inf")
    } else {
        None
    }
}

fn yaml_value_is_non_finite_number(value: &YamlOwned) -> bool {
    match value {
        YamlOwned::Value(ScalarOwned::FloatingPoint(value)) => !value.into_inner().is_finite(),
        YamlOwned::Tagged(_, value) => yaml_value_is_non_finite_number(value),
        _ => false,
    }
}

fn yaml_value_has_unsupported_tag(value: &YamlOwned) -> bool {
    match value {
        YamlOwned::Tagged(tag, value) => {
            !(tag.is_yaml_core_schema()
                && matches!(
                    tag.suffix.as_str(),
                    "str" | "seq" | "map" | "null" | "bool" | "int" | "float"
                ))
                || yaml_value_has_unsupported_tag(value)
        }
        YamlOwned::Sequence(values) => values.iter().any(yaml_value_has_unsupported_tag),
        YamlOwned::Mapping(mapping) => mapping.iter().any(|(key, value)| {
            yaml_value_has_unsupported_tag(key) || yaml_value_has_unsupported_tag(value)
        }),
        _ => false,
    }
}

fn yaml_to_json(value: &YamlOwned) -> Value {
    match value {
        YamlOwned::Value(ScalarOwned::Null) => Value::Null,
        YamlOwned::Value(ScalarOwned::Boolean(value)) => Value::Bool(*value),
        YamlOwned::Value(ScalarOwned::Integer(value)) => Value::from(*value),
        YamlOwned::Value(ScalarOwned::FloatingPoint(value)) => {
            non_finite_yaml_number(value.into_inner()).map_or_else(
                || {
                    Value::Number(
                        serde_json::Number::from_f64(value.into_inner())
                            .expect("finite YAML float is a JSON number"),
                    )
                },
                |value| Value::String(value.to_owned()),
            )
        }
        YamlOwned::Value(ScalarOwned::String(value)) => Value::String(value.clone()),
        YamlOwned::Representation(value, ScalarStyle::Plain, None) if value.contains('_') => {
            separated_integer(value).map_or_else(|| Value::String(value.clone()), Value::from)
        }
        YamlOwned::Representation(value, _, _) => Value::String(value.clone()),
        YamlOwned::Sequence(values) => Value::Array(values.iter().map(yaml_to_json).collect()),
        YamlOwned::Mapping(mapping) => {
            let mut object = serde_json::Map::new();
            for (key, value) in mapping {
                if let Some(key) = yaml_key_text(key) {
                    object.insert(key, yaml_to_json(value));
                }
            }
            Value::Object(object)
        }
        YamlOwned::Tagged(_, value) => yaml_to_json(value),
        YamlOwned::Alias(_) | YamlOwned::BadValue => Value::Null,
    }
}

fn separated_integer(value: &str) -> Option<i64> {
    if !value.contains('_') {
        return None;
    }
    for (index, byte) in value.bytes().enumerate() {
        if byte != b'_' {
            continue;
        }
        if index == 0
            || index + 1 == value.len()
            || !value.as_bytes()[index - 1].is_ascii_hexdigit()
            || !value.as_bytes()[index + 1].is_ascii_hexdigit()
        {
            return None;
        }
    }
    let normalized = value.replace('_', "");
    let (sign, magnitude) = normalized.strip_prefix('-').map_or_else(
        || (1_i128, normalized.strip_prefix('+').unwrap_or(&normalized)),
        |magnitude| (-1_i128, magnitude),
    );
    let (radix, digits) = magnitude
        .strip_prefix("0b")
        .map(|digits| (2, digits))
        .or_else(|| magnitude.strip_prefix("0o").map(|digits| (8, digits)))
        .or_else(|| magnitude.strip_prefix("0x").map(|digits| (16, digits)))
        .unwrap_or((10, magnitude));
    let magnitude = i128::from_str_radix(digits, radix).ok()?;
    i64::try_from(sign * magnitude).ok()
}

fn marked_yaml_key_text(value: &MarkedYamlOwned) -> Option<String> {
    match &value.data {
        YamlDataOwned::Value(ScalarOwned::String(value))
        | YamlDataOwned::Representation(value, _, _) => Some(value.clone()),
        YamlDataOwned::Value(ScalarOwned::Integer(value)) => Some(value.to_string()),
        YamlDataOwned::Value(ScalarOwned::Boolean(value)) => Some(value.to_string()),
        YamlDataOwned::Value(ScalarOwned::Null) => Some("null".to_owned()),
        YamlDataOwned::Tagged(_, value) => marked_yaml_key_text(value),
        _ => None,
    }
}

fn normalize_separated_yaml_integers(value: &mut Value, marked: &MarkedYamlOwned, source: &str) {
    if let (Value::String(current), YamlDataOwned::Value(ScalarOwned::String(marked_value))) =
        (&*value, &marked.data)
        && current == marked_value
    {
        let start = marked.span.start.index();
        let end = marked.span.end.index();
        if let Some(representation) = source.get(start..end)
            && representation == marked_value
            && let Some(integer) = separated_integer(representation)
        {
            *value = Value::from(integer);
        }
        return;
    }

    match (value, &marked.data) {
        (Value::Array(values), YamlDataOwned::Sequence(marked_values)) => {
            for (value, marked) in values.iter_mut().zip(marked_values) {
                normalize_separated_yaml_integers(value, marked, source);
            }
        }
        (Value::Object(values), YamlDataOwned::Mapping(marked_values)) => {
            for (key, marked_value) in marked_values {
                let Some(key) = marked_yaml_key_text(key) else {
                    continue;
                };
                if let Some(value) = values.get_mut(&key) {
                    normalize_separated_yaml_integers(value, marked_value, source);
                }
            }
        }
        (value, YamlDataOwned::Tagged(_, marked)) => {
            normalize_separated_yaml_integers(value, marked, source);
        }
        _ => {}
    }
}

struct ParsedMarkdownFrontmatter<'a> {
    value: Value,
    body: &'a str,
    non_finite_fields: HashSet<String>,
    unsupported_tag_fields: HashSet<String>,
}

fn parse_markdown_frontmatter(markdown: &str) -> Option<ParsedMarkdownFrontmatter<'_>> {
    let mut lines = markdown.split_inclusive('\n');
    let first = lines.next()?;
    if !first.ends_with('\n') || !is_frontmatter_delimiter(first) {
        return Some(ParsedMarkdownFrontmatter {
            value: Value::Object(serde_json::Map::new()),
            body: markdown,
            non_finite_fields: HashSet::new(),
            unsupported_tag_fields: HashSet::new(),
        });
    }
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
    let body_start = body_start?;
    let yaml_source = &markdown[yaml_start..yaml_end];
    let duplicate_documents = DuplicateYamlNode::load_from_str(yaml_source).ok()?;
    if duplicate_documents
        .iter()
        .any(duplicate_yaml_value_has_duplicate_mapping_key)
    {
        return None;
    }
    let documents = YamlOwned::load_from_str(yaml_source).ok()?;
    let marked_documents = yaml_source
        .contains('_')
        .then(|| MarkedYamlOwned::load_from_str(yaml_source))
        .transpose()
        .ok()?;
    let yaml_is_empty = yaml_source.lines().all(|line| {
        let content = line.trim_start_matches([' ', '\t', '\r']);
        content.is_empty() || content.starts_with('#')
    });
    let document = match documents.as_slice() {
        [] if yaml_is_empty => None,
        [document] => Some(document),
        _ => return None,
    };
    let marked_document = match marked_documents.as_deref() {
        None | Some([]) if yaml_is_empty => None,
        None => None,
        Some([document]) => Some(document),
        Some(_) => return None,
    };
    let (value, non_finite_fields, unsupported_tag_fields) = if let Some(document) = document {
        if let Some(mapping) = document.as_mapping() {
            let non_finite_fields = mapping
                .iter()
                .filter_map(|(key, value)| {
                    yaml_value_is_non_finite_number(value)
                        .then(|| yaml_key_text(key))
                        .flatten()
                })
                .collect();
            let unsupported_tag_fields = mapping
                .iter()
                .filter_map(|(key, value)| {
                    yaml_value_has_unsupported_tag(value)
                        .then(|| yaml_key_text(key))
                        .flatten()
                })
                .collect();
            let mut value = yaml_to_json(document);
            if let Some(marked_document) = marked_document {
                normalize_separated_yaml_integers(&mut value, marked_document, yaml_source);
            }
            (value, non_finite_fields, unsupported_tag_fields)
        } else if document.is_null() && yaml_is_empty {
            (
                Value::Object(serde_json::Map::new()),
                HashSet::new(),
                HashSet::new(),
            )
        } else {
            return None;
        }
    } else {
        (
            Value::Object(serde_json::Map::new()),
            HashSet::new(),
            HashSet::new(),
        )
    };
    Some(ParsedMarkdownFrontmatter {
        value,
        body: &markdown[body_start..],
        non_finite_fields,
        unsupported_tag_fields,
    })
}

pub fn markdown_frontmatter_json(markdown: &str) -> Option<Value> {
    parse_markdown_frontmatter(markdown).map(|frontmatter| frontmatter.value)
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
        return Some(reminted);
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
        let mut adopted = String::with_capacity(
            markdown.len() + RECORD_ID_FRONTMATTER_KEY.len() + record_id.len() + 3,
        );
        adopted.push_str(first_line);
        adopted.push_str(RECORD_ID_FRONTMATTER_KEY);
        adopted.push_str(": ");
        adopted.push_str(record_id);
        adopted.push_str(line_ending);
        adopted.push_str(&markdown[first_line.len()..]);
        return Some(adopted);
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
    conn.execute(
        "UPDATE collection_records SET index_initialized=?4 \
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

/// One applied field difference, exactly as its history row was recorded.
/// Values stay as the stored JSON text; the event layer decides parsing and
/// size bounds.
#[derive(Debug, Clone, PartialEq, Eq)]
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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionRecordApplyFacts {
    pub collection_path: String,
    pub record_id: String,
    pub created: bool,
    pub author_origin_id: Option<String>,
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
    source_update: Option<(&str, i64)>,
    recorded_at_ms: i64,
) -> Result<Option<i64>, crate::DomainError> {
    let (source_origin_id, source_origin_seq) = source_update
        .map(|(origin_id, origin_seq)| (Some(origin_id), Some(origin_seq)))
        .unwrap_or((None, None));
    let inserted = conn
        .execute(
            "INSERT INTO collection_field_history \
         (workspace_id,version_id,record_id,field_name,previous_value_json, \
          next_value_json,author_origin_id,source_origin_id,source_origin_seq,recorded_at_ms) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) \
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
                recorded_at_ms,
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
    author_origin_id: Option<&str>,
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
        if optional_collection_values_equal(previous, applied)
            && !optional_collection_values_equal(authored_previous, authored_next)
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
    if applied_frontmatter_unchanged && authored_frontmatter_unchanged {
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
        FieldProvenance::PreserveStored,
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
        recorded_at_ms,
        fields: field_facts,
    }))
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
    let relation_cleanups =
        dangling_relation_cleanups(tx, workspace_id, version_id, &present_malformed_record_ids)?;
    Ok(CollectionReconcileResult {
        adoptions,
        relation_cleanups,
    })
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
            "SELECT schema_status,degradation_reasons_json FROM collections \
             WHERE workspace_id=?1 AND version_id=?2 AND collection_path=?3",
            params![workspace_id, version_id, collection_path],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(crate::DomainError::sql_corrupt)?;
    stored
        .map(|(status, reasons)| {
            Ok(CollectionSummary {
                path: collection_path.to_owned(),
                status: stored_schema_status(&status)?,
                reasons: stored_schema_reasons(&reasons)?,
            })
        })
        .transpose()
}

/// Every collection in the active workspace version, ordered by path.
pub fn list_collections(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Vec<CollectionSummary>, crate::DomainError> {
    let version_id = active_version_id(conn, workspace_id)?;
    let mut statement = conn
        .prepare(
            "SELECT collection_path,schema_status,degradation_reasons_json FROM collections \
             WHERE workspace_id=?1 AND version_id=?2 ORDER BY collection_path",
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    let rows = statement
        .query_map(params![workspace_id, version_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(crate::DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::DomainError::sql_corrupt)?;
    rows.into_iter()
        .map(|(path, status, reasons)| {
            Ok(CollectionSummary {
                path,
                status: stored_schema_status(&status)?,
                reasons: stored_schema_reasons(&reasons)?,
            })
        })
        .collect()
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

fn matches_collection_filter(record: &CollectionRecord, filter: &CollectionFilter) -> bool {
    let Some(value) = value_for_field(record, &filter.field) else {
        return false;
    };
    match filter.operator {
        CollectionFilterOperator::Equals => collection_values_equal(value, &filter.value),
        CollectionFilterOperator::Contains => value_contains(value, &filter.value),
    }
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

fn compare_optional_json(left: Option<&Value>, right: Option<&Value>) -> Ordering {
    match (left, right) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some(left), Some(right)) => compare_json(left, right),
    }
}

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

/// Filter, sort, group, and optionally resolve relation labels from the active
/// version's persisted collection index. Raw indexed values are never reparsed
/// from record files, including when the schema is degraded.
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
    let version_id = active_version_id(conn, workspace_id)?;
    let Some(collection) =
        collection_summary_for_version(conn, workspace_id, &version_id, collection_path)?
    else {
        return Ok(None);
    };
    let candidate_fields = query.filter.as_ref().map(|filter| {
        let mut fields = vec![filter.field.clone()];
        for sort in &query.sort {
            if !fields.contains(&sort.field) {
                fields.push(sort.field.clone());
            }
        }
        fields
    });
    let mut records = load_collection_records_selected(
        conn,
        workspace_id,
        &version_id,
        collection_path,
        None,
        candidate_fields.as_deref(),
    )?;
    if let Some(filter) = &query.filter {
        records.retain(|record| matches_collection_filter(record, filter));
    }
    records.sort_by(|left, right| compare_collection_records(left, right, &query.sort));
    if let Some(cursor) = &query.cursor {
        let mut page_start = 0;
        while page_start < records.len()
            && compare_record_to_cursor(&records[page_start], cursor, &query.sort)?
                != Ordering::Greater
        {
            page_start += 1;
        }
        records.drain(..page_start);
    }
    let has_more = records.len() > query.limit;
    records.truncate(query.limit);
    let next_cursor = if has_more {
        records
            .last()
            .map(|record| query_cursor_for_record(record, &query.sort))
    } else {
        None
    };
    if query.filter.is_some() {
        let selected_ids = records
            .iter()
            .map(|record| record.id.clone())
            .collect::<Vec<_>>();
        let selected_order = selected_ids
            .iter()
            .enumerate()
            .map(|(index, record_id)| (record_id.as_str(), index))
            .collect::<HashMap<_, _>>();
        records = load_collection_records_selected(
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
    }
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
                recorded_at_ms \
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
    values.push(rusqlite::types::Value::Integer(
        history_limit.min(MAX_COLLECTION_HISTORY_LIMIT) as i64,
    ));
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
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(crate::DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::DomainError::sql_corrupt)?;
    let history = rows
        .into_iter()
        .map(
            |(history_id, field, previous, next, author_origin_id, recorded_at_ms)| {
                Ok(CollectionFieldHistoryEntry {
                    history_id,
                    field,
                    previous: history_value_from_json(previous)?,
                    next: history_value_from_json(next)?,
                    author_origin_id,
                    recorded_at_ms,
                })
            },
        )
        .collect::<Result<Vec<_>, crate::DomainError>>()?;
    Ok(Some(CollectionRecordDetails {
        collection,
        record,
        history,
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
}
