//! Rust twin of `packages/workspace-contracts/src/collectionValues.ts`.
//!
//! The TypeScript implementation is the fixture oracle. The shared vectors
//! hold this port to the same schema recovery, Field value, and Record id
//! outcomes.

use std::collections::{HashMap, HashSet};

use dohc_engine_storage::StorageError;
use rusqlite::{Connection, OptionalExtension, params};
use saphyr::{LoadableYamlNode, MappingOwned, ScalarOwned, YamlOwned};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chats::{base32_lowercase_no_padding, is_js_trim_ws};

pub const COLLECTION_SCHEMA_FILENAME: &str = "collection.yaml";
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

    #[must_use]
    pub fn field_type(&self) -> CollectionFieldType {
        match self {
            Self::Text { .. } => CollectionFieldType::Text,
            Self::Number { .. } => CollectionFieldType::Number,
            Self::Checkbox { .. } => CollectionFieldType::Checkbox,
            Self::Date { .. } => CollectionFieldType::Date,
            Self::Select { .. } => CollectionFieldType::Select,
            Self::MultiSelect { .. } => CollectionFieldType::MultiSelect,
            Self::Person { .. } => CollectionFieldType::Person,
            Self::Relation { .. } => CollectionFieldType::Relation,
            Self::Url { .. } => CollectionFieldType::Url,
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CollectionSchemaReasonCode {
    InvalidYaml,
    RootNotMapping,
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
    ReservedFieldName,
    InvalidRelationTarget,
    UnknownFieldReference,
}

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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FieldValueReasonCode {
    ExpectedText,
    ExpectedNumber,
    NumberNotFinite,
    ExpectedBoolean,
    ExpectedSequence,
    InvalidDate,
    UnknownOption,
    DuplicateValue,
    EmptyPersonId,
    InvalidRecordId,
    InvalidUrl,
}

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
    mapping
        .iter()
        .find_map(|(candidate, value)| (candidate.as_str() == Some(key)).then_some(value))
}

fn yaml_key_text(value: &YamlOwned) -> Option<String> {
    if let Some(text) = value.as_str() {
        Some(text.to_owned())
    } else if let Some(integer) = value.as_integer() {
        Some(integer.to_string())
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
    for (key, _) in mapping {
        let Some(key) = yaml_key_text(key) else {
            push_reason(
                reasons,
                CollectionSchemaReasonCode::UnknownProperty,
                property_path(path, "<non-text-key>"),
            );
            continue;
        };
        if !allowed.contains(&key.as_str()) {
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
    !value.is_empty()
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
        if !view_names.insert(name.clone()) {
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
    let fields = parse_fields(mapping_get(root, "fields"), &mut reasons);
    let schema = CollectionSchema {
        name: read_optional_text(root, "name", "", &mut reasons),
        description: read_optional_text(root, "description", "", &mut reasons),
        views: parse_views(mapping_get(root, "views"), &fields, &mut reasons),
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

fn markdown_record_id(markdown: &str) -> Option<String> {
    let mut lines = markdown.split_inclusive('\n');
    let first = lines.next()?;
    if first.trim_end_matches(['\r', '\n']) != "---" {
        return None;
    }
    let yaml_start = first.len();
    let mut yaml_end = yaml_start;
    let mut found_end = false;
    for line in lines {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            found_end = true;
            break;
        }
        yaml_end += line.len();
    }
    if !found_end {
        return None;
    }
    let documents = YamlOwned::load_from_str(&markdown[yaml_start..yaml_end]).ok()?;
    if documents.len() != 1 {
        return None;
    }
    let mapping = documents.first()?.as_mapping()?;
    mapping_get(mapping, RECORD_ID_FRONTMATTER_KEY)
        .and_then(YamlOwned::as_str)
        .map(str::to_owned)
}

fn yaml_to_json(value: &YamlOwned) -> Value {
    match value {
        YamlOwned::Value(ScalarOwned::Null) => Value::Null,
        YamlOwned::Value(ScalarOwned::Boolean(value)) => Value::Bool(*value),
        YamlOwned::Value(ScalarOwned::Integer(value)) => Value::from(*value),
        YamlOwned::Value(ScalarOwned::FloatingPoint(value)) => {
            serde_json::Number::from_f64(value.into_inner()).map_or(Value::Null, Value::Number)
        }
        YamlOwned::Value(ScalarOwned::String(value)) | YamlOwned::Representation(value, _, _) => {
            Value::String(value.clone())
        }
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

fn markdown_frontmatter_json(markdown: &str) -> Option<Value> {
    let mut lines = markdown.split_inclusive('\n');
    let first = lines.next()?;
    if first.trim_end_matches(['\r', '\n']) != "---" {
        return Some(Value::Object(serde_json::Map::new()));
    }
    let yaml_start = first.len();
    let mut yaml_end = yaml_start;
    let mut found_end = false;
    for line in lines {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            found_end = true;
            break;
        }
        yaml_end += line.len();
    }
    if !found_end {
        return None;
    }
    let documents = YamlOwned::load_from_str(&markdown[yaml_start..yaml_end]).ok()?;
    if documents.len() != 1 || documents.first()?.as_mapping().is_none() {
        return None;
    }
    Some(yaml_to_json(documents.first()?))
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
) -> Result<(&'static str, Option<String>), crate::DomainError> {
    let Some(field) = field else {
        return Ok(("untyped", None));
    };
    match validate_field_value(field, &json_field_value(value)) {
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

fn replace_index_for_record(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    record_id: &str,
    schema: &CollectionSchema,
    frontmatter: &Value,
) -> Result<(), crate::DomainError> {
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
    let fields: HashMap<&str, &FieldDefinition> = schema
        .fields
        .iter()
        .map(|field| (field.name(), field))
        .collect();
    if let Some(values) = frontmatter.as_object() {
        for (field_name, value) in values {
            if field_name == RECORD_ID_FRONTMATTER_KEY {
                continue;
            }
            let field = fields.get(field_name.as_str()).copied();
            let (validation_status, validation_reason_json) = validation_columns(field, value)?;
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
            if let Some(field) = field {
                insert_relation_edges(conn, workspace_id, version_id, record_id, field, value)?;
            }
        }
    }
    conn.execute(
        "UPDATE collection_records SET index_initialized=1 \
         WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3",
        params![workspace_id, version_id, record_id],
    )
    .map_err(crate::DomainError::sql_persist)?;
    Ok(())
}

fn bound_record(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<Option<(String, String)>, crate::DomainError> {
    conn.query_row(
        "SELECT record_id,collection_path FROM collection_records \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
           AND record_id IS NOT NULL",
        params![workspace_id, version_id, object_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(crate::DomainError::sql_corrupt)
}

/// Replace one bound record's local projection with its applied Y.Map state.
pub fn synchronize_collection_frontmatter_index_in_tx(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    frontmatter: &Value,
) -> Result<(), crate::DomainError> {
    let Some((record_id, collection_path)) =
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
    )
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
    recorded_at_ms: i64,
) -> Result<(), crate::DomainError> {
    conn.execute(
        "INSERT INTO collection_field_history \
         (workspace_id,version_id,record_id,field_name,previous_value_json, \
          next_value_json,author_origin_id,recorded_at_ms) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            workspace_id,
            version_id,
            record_id,
            field_name,
            history_value(previous)?,
            history_value(next)?,
            author_origin_id,
            recorded_at_ms,
        ],
    )
    .map_err(crate::DomainError::sql_persist)?;
    Ok(())
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
    recorded_at_ms: i64,
) -> Result<(), crate::DomainError> {
    let Some((record_id, collection_path)) =
        bound_record(conn, workspace_id, version_id, object_id)?
    else {
        return Ok(());
    };
    let before = before.as_object();
    let after_object = after.as_object();
    let authored_before = authored_before.as_object();
    let authored_after = authored_after.as_object();
    let mut keys = HashSet::new();
    if let Some(values) = before {
        keys.extend(values.keys().map(String::as_str));
    }
    if let Some(values) = after_object {
        keys.extend(values.keys().map(String::as_str));
    }
    for field_name in keys {
        if field_name == RECORD_ID_FRONTMATTER_KEY {
            continue;
        }
        let previous = before.and_then(|values| values.get(field_name));
        let next = after_object.and_then(|values| values.get(field_name));
        if previous != next {
            insert_field_history(
                conn,
                workspace_id,
                version_id,
                &record_id,
                field_name,
                previous,
                next,
                author_origin_id,
                recorded_at_ms,
            )?;
        }
    }
    let mut authored_keys = HashSet::new();
    if let Some(values) = authored_before {
        authored_keys.extend(values.keys().map(String::as_str));
    }
    if let Some(values) = authored_after {
        authored_keys.extend(values.keys().map(String::as_str));
    }
    for field_name in authored_keys {
        if field_name == RECORD_ID_FRONTMATTER_KEY {
            continue;
        }
        let previous = before.and_then(|values| values.get(field_name));
        let applied = after_object.and_then(|values| values.get(field_name));
        let authored_previous = authored_before.and_then(|values| values.get(field_name));
        let authored_next = authored_after.and_then(|values| values.get(field_name));
        if previous == applied && authored_previous != authored_next {
            insert_field_history(
                conn,
                workspace_id,
                version_id,
                &record_id,
                field_name,
                authored_previous,
                authored_next,
                author_origin_id,
                recorded_at_ms,
            )?;
        }
    }
    let schema = load_collection_schema(conn, workspace_id, version_id, &collection_path)?;
    replace_index_for_record(conn, workspace_id, version_id, &record_id, &schema, after)
}

fn revalidate_collection_index_in_tx(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
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
        let schema = load_collection_schema(conn, workspace_id, version_id, &collection_path)?;
        replace_index_for_record(
            conn,
            workspace_id,
            version_id,
            &record_id,
            &schema,
            &Value::Object(values),
        )?;
    }
    Ok(())
}

fn dangling_relation_cleanups(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
) -> Result<Vec<CollectionRelationCleanupCandidate>, crate::DomainError> {
    let mut statement = conn
        .prepare(
            "SELECT e.source_record_id,r.file_path,r.object_id,e.field_name, \
                    e.target_record_id,e.many \
             FROM collection_relation_edges e \
             JOIN collection_records r ON r.workspace_id=e.workspace_id \
               AND r.version_id=e.version_id AND r.record_id=e.source_record_id \
             WHERE e.workspace_id=?1 AND e.version_id=?2 \
               AND NOT EXISTS (SELECT 1 FROM collection_records target \
                 WHERE target.workspace_id=e.workspace_id \
                   AND target.version_id=e.version_id \
                   AND target.record_id=e.target_record_id) \
             ORDER BY r.file_path,e.field_name,e.target_record_id",
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    statement
        .query_map(params![workspace_id, version_id], |row| {
            Ok(CollectionRelationCleanupCandidate {
                source_record_id: row.get(0)?,
                source_file_path: row.get(1)?,
                source_object_id: row.get(2)?,
                field_name: row.get(3)?,
                target_record_id: row.get(4)?,
                many: row.get(5)?,
            })
        })
        .map_err(crate::DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::DomainError::sql_corrupt)
}

fn load_collection_snapshots(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
) -> Result<Vec<CollectionSnapshot>, crate::DomainError> {
    let mut statement = conn
        .prepare(
            "SELECT s.path, s.object_id, b.text \
             FROM snapshots s JOIN blobs b ON b.sha256 = s.blob_sha256 \
             WHERE s.workspace_id = ?1 AND s.version_id = ?2 \
               AND s.content_kind = 'text' ORDER BY s.path",
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    statement
        .query_map(params![workspace_id, version_id], |row| {
            Ok(CollectionSnapshot {
                path: row.get(0)?,
                object_id: row.get(1)?,
                text: row.get(2)?,
            })
        })
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
            "SELECT record_id, file_path, adoption_state, index_initialized \
             FROM collection_records WHERE workspace_id = ?1 AND version_id = ?2 \
             ORDER BY file_path",
        )
        .map_err(crate::DomainError::sql_corrupt)?;
    statement
        .query_map(params![workspace_id, version_id], |row| {
            Ok(ExistingRecordBinding {
                record_id: row.get(0)?,
                file_path: row.get(1)?,
                adoption_state: row.get(2)?,
                index_initialized: row.get(3)?,
            })
        })
        .map_err(crate::DomainError::sql_corrupt)?
        .collect::<Result<Vec<_>, _>>()
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

    let schema_snapshots: Vec<&CollectionSnapshot> = snapshots
        .iter()
        .filter(|snapshot| path_basename(&snapshot.path) == COLLECTION_SCHEMA_FILENAME)
        .collect();
    let collection_paths: HashSet<String> = schema_snapshots
        .iter()
        .map(|snapshot| parent_path(&snapshot.path).to_owned())
        .collect();
    let records: Vec<&CollectionSnapshot> = snapshots
        .iter()
        .filter(|snapshot| {
            snapshot.path.ends_with(".md") && collection_paths.contains(parent_path(&snapshot.path))
        })
        .collect();
    let current_paths: HashSet<&str> = records.iter().map(|record| record.path.as_str()).collect();
    let current_ids: HashMap<&str, String> = records
        .iter()
        .filter_map(|record| {
            markdown_record_id(&record.text)
                .filter(|record_id| is_record_id(record_id))
                .map(|record_id| (record.path.as_str(), record_id))
        })
        .collect();

    let existing_by_path: HashMap<&str, &ExistingRecordBinding> = existing
        .iter()
        .map(|binding| (binding.file_path.as_str(), binding))
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
    let mut current_owners: HashMap<String, &ExistingRecordBinding> = HashMap::new();
    let mut absent_owners = HashSet::new();
    let mut used_ids = HashSet::new();
    for binding in &existing {
        let Some(record_id) = binding.record_id.as_ref() else {
            continue;
        };
        used_ids.insert(record_id.clone());
        if current_ids.get(binding.file_path.as_str()) == Some(record_id) {
            current_owners.insert(record_id.clone(), binding);
        } else if !current_paths.contains(binding.file_path.as_str())
            && binding.adoption_state == "adopted"
        {
            absent_owners.insert(record_id.clone());
        }
    }

    let mut desired = Vec::with_capacity(records.len());
    let mut claimed_ids: HashMap<String, String> = HashMap::new();
    let mut adoptions = Vec::new();
    for record in records {
        let collection_path = parent_path(&record.path).to_owned();
        let parsed_id = current_ids.get(record.path.as_str()).cloned();
        let existing_at_path = existing_by_path.get(record.path.as_str()).copied();
        let conflicted = has_open_file_conflict(
            tx,
            workspace_id,
            version_id,
            &record.object_id,
            &record.path,
        )?;

        if conflicted {
            let record_id = existing_at_path
                .and_then(|binding| binding.record_id.clone())
                .or_else(|| {
                    parsed_id
                        .as_ref()
                        .filter(|record_id| absent_owners.contains(*record_id))
                        .cloned()
                });
            if let Some(record_id) = record_id.as_ref() {
                claimed_ids.insert(record_id.clone(), record.path.clone());
            }
            desired.push(DesiredRecordBinding {
                record_id,
                collection_path,
                file_path: record.path.clone(),
                object_id: record.object_id.clone(),
                adoption_state: "deferred-conflict",
                index_initialized: existing_at_path
                    .is_some_and(|binding| binding.index_initialized),
            });
            continue;
        }

        if let Some(record_id) = parsed_id {
            let occupied_by_current = current_owners
                .get(&record_id)
                .is_some_and(|owner| owner.file_path != record.path);
            let occupied_in_pass = claimed_ids
                .get(&record_id)
                .is_some_and(|owner_path| owner_path != &record.path);
            if occupied_by_current || occupied_in_pass {
                let fresh_id = mint_unused_record_id(&mut used_ids)?;
                claimed_ids.insert(fresh_id.clone(), record.path.clone());
                desired.push(DesiredRecordBinding {
                    record_id: Some(fresh_id.clone()),
                    collection_path: collection_path.clone(),
                    file_path: record.path.clone(),
                    object_id: record.object_id.clone(),
                    adoption_state: "pending",
                    index_initialized: false,
                });
                adoptions.push(CollectionAdoptionCandidate {
                    record_id: fresh_id,
                    collection_path,
                    file_path: record.path.clone(),
                    object_id: record.object_id.clone(),
                });
            } else {
                used_ids.insert(record_id.clone());
                claimed_ids.insert(record_id.clone(), record.path.clone());
                let index_initialized = existing_at_path
                    .or_else(|| existing_by_record_id.get(record_id.as_str()).copied())
                    .is_some_and(|binding| binding.index_initialized);
                desired.push(DesiredRecordBinding {
                    record_id: Some(record_id),
                    collection_path,
                    file_path: record.path.clone(),
                    object_id: record.object_id.clone(),
                    adoption_state: "adopted",
                    index_initialized,
                });
            }
            continue;
        }

        let pending_id = existing_at_path.and_then(|binding| {
            (binding.adoption_state == "pending" || binding.adoption_state == "deferred-conflict")
                .then(|| binding.record_id.clone())
                .flatten()
        });
        let record_id = match pending_id {
            Some(record_id) if !claimed_ids.contains_key(&record_id) => record_id,
            _ => mint_unused_record_id(&mut used_ids)?,
        };
        claimed_ids.insert(record_id.clone(), record.path.clone());
        desired.push(DesiredRecordBinding {
            record_id: Some(record_id.clone()),
            collection_path: collection_path.clone(),
            file_path: record.path.clone(),
            object_id: record.object_id.clone(),
            adoption_state: "pending",
            index_initialized: existing_at_path.is_some_and(|binding| binding.index_initialized),
        });
        adoptions.push(CollectionAdoptionCandidate {
            record_id,
            collection_path,
            file_path: record.path.clone(),
            object_id: record.object_id.clone(),
        });
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
    for snapshot in &schema_snapshots {
        let parsed = parse_collection_schema(&snapshot.text);
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
                parent_path(&snapshot.path),
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
        if binding.index_initialized {
            continue;
        }
        let Some(snapshot) = snapshots
            .iter()
            .find(|snapshot| snapshot.path == binding.file_path)
        else {
            continue;
        };
        let Some(frontmatter) = markdown_frontmatter_json(&snapshot.text) else {
            continue;
        };
        let schema =
            load_collection_schema(tx, workspace_id, version_id, &binding.collection_path)?;
        replace_index_for_record(
            tx,
            workspace_id,
            version_id,
            record_id,
            &schema,
            &frontmatter,
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
    revalidate_collection_index_in_tx(tx, workspace_id, version_id)?;
    let relation_cleanups = dangling_relation_cleanups(tx, workspace_id, version_id)?;
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
        FieldDefinition::Select { options, .. } => match value {
            CollectionFieldValue::Text(value) if options.contains(value) => {
                FieldValueValidation::Valid
            }
            CollectionFieldValue::Text(_) => flagged(FieldValueReasonCode::UnknownOption, ""),
            _ => flagged(FieldValueReasonCode::ExpectedText, ""),
        },
        FieldDefinition::MultiSelect { options, .. } => match value {
            CollectionFieldValue::Sequence(values) => {
                validate_sequence(values, |value, path| match value {
                    CollectionFieldValue::Text(value) if options.contains(value) => {
                        FieldValueValidation::Valid
                    }
                    CollectionFieldValue::Text(_) => {
                        flagged(FieldValueReasonCode::UnknownOption, path)
                    }
                    _ => flagged(FieldValueReasonCode::ExpectedText, path),
                })
            }
            _ => flagged(FieldValueReasonCode::ExpectedSequence, ""),
        },
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
    use super::{is_record_id, mint_record_id, record_id_from_random};

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
