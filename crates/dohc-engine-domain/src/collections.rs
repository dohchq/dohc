//! Rust twin of `packages/workspace-contracts/src/collectionValues.ts`.
//!
//! The TypeScript implementation is the fixture oracle. The shared vectors
//! hold this port to the same schema recovery, Field value, and Record id
//! outcomes.

use std::collections::HashSet;

use saphyr::{LoadableYamlNode, MappingOwned, YamlOwned};
use serde::{Deserialize, Serialize};

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
