use dohc_engine_domain::collections::markdown_frontmatter_json;
use dohc_engine_domain::{
    CollectionFieldValue, CollectionSchemaParseResult, CollectionSchemaReasonCode,
    CollectionSchemaStatus, FieldDefinition, FieldValueReasonCode, FieldValueValidation,
    is_record_id, parse_collection_schema, validate_field_value,
};
use saphyr::{LoadableYamlNode, ScalarOwned, YamlOwned};
use serde::Deserialize;

const SCHEMA_FIXTURE: &str = include_str!("fixtures/collection-schemas.json");
const SCHEMA_LIMIT_FIXTURE: &str = include_str!("fixtures/collection-schema-limits.json");
const FIELD_VALUE_FIXTURE: &str = include_str!("fixtures/collection-field-values.json");
const RECORD_ID_FIXTURE: &str = include_str!("fixtures/collection-record-ids.json");
const FRONTMATTER_FIXTURE: &str = include_str!("fixtures/collection-frontmatter.json");
const REASON_CODE_FIXTURE: &str = include_str!("fixtures/collection-reason-codes.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture<T> {
    vectors: Vec<T>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SchemaVector {
    name: String,
    yaml: String,
    expected: CollectionSchemaParseResult,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SchemaLimitVector {
    name: String,
    item_count: usize,
    expected_item_count: usize,
    referenced_field_index: usize,
    expected_reasons: Vec<dohc_engine_domain::CollectionSchemaReason>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SchemaReasonLimitVector {
    name: String,
    item_count: usize,
    expected_reason_count: usize,
    expected_terminal_reason: dohc_engine_domain::CollectionSchemaReason,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SchemaLimitFixture {
    vectors: Vec<SchemaLimitVector>,
    reason_vectors: Vec<SchemaReasonLimitVector>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FieldValueVector {
    name: String,
    field: FieldDefinition,
    value_yaml: String,
    expected: FieldValueValidation,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordIdVector {
    value: String,
    valid: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FrontmatterVector {
    name: String,
    markdown: String,
    expected: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReasonCodeFixture {
    schema_reason_codes: Vec<String>,
    field_value_reason_codes: Vec<String>,
}

#[test]
fn collection_reason_code_enums_accept_the_shared_full_set() {
    let fixture: ReasonCodeFixture =
        serde_json::from_str(REASON_CODE_FIXTURE).expect("reason-code fixture parses");
    let schema_reason_codes = CollectionSchemaReasonCode::ALL
        .iter()
        .map(|code| serde_json::to_value(code).expect("serialize schema reason"))
        .map(|code| code.as_str().expect("schema reason is text").to_owned())
        .collect::<Vec<_>>();
    let field_value_reason_codes = FieldValueReasonCode::ALL
        .iter()
        .map(|code| serde_json::to_value(code).expect("serialize field-value reason"))
        .map(|code| {
            code.as_str()
                .expect("field-value reason is text")
                .to_owned()
        })
        .collect::<Vec<_>>();

    assert_eq!(schema_reason_codes, fixture.schema_reason_codes);
    assert_eq!(field_value_reason_codes, fixture.field_value_reason_codes);
}

fn field_value_from_yaml(raw: &str) -> CollectionFieldValue {
    let documents = YamlOwned::load_from_str(raw).expect("Field value fixture is valid YAML");
    assert_eq!(documents.len(), 1, "Field value fixture has one document");
    yaml_value(documents.first().expect("Field value document exists"))
}

fn yaml_value(value: &YamlOwned) -> CollectionFieldValue {
    match value {
        YamlOwned::Value(ScalarOwned::Null) => CollectionFieldValue::Null,
        YamlOwned::Value(ScalarOwned::Boolean(value)) => CollectionFieldValue::Boolean(*value),
        YamlOwned::Value(ScalarOwned::Integer(value)) => {
            CollectionFieldValue::Number(*value as f64)
        }
        YamlOwned::Value(ScalarOwned::FloatingPoint(value)) => {
            CollectionFieldValue::Number(value.into_inner())
        }
        YamlOwned::Value(ScalarOwned::String(value)) => CollectionFieldValue::Text(value.clone()),
        YamlOwned::Sequence(values) => {
            CollectionFieldValue::Sequence(values.iter().map(yaml_value).collect())
        }
        YamlOwned::Mapping(_) => CollectionFieldValue::Mapping,
        YamlOwned::Tagged(_, value) => yaml_value(value),
        YamlOwned::Representation(value, _, _) => CollectionFieldValue::Text(value.clone()),
        YamlOwned::Alias(_) | YamlOwned::BadValue => CollectionFieldValue::Mapping,
    }
}

#[test]
fn collection_schema_results_match_the_typescript_oracle() {
    let fixture: Fixture<SchemaVector> =
        serde_json::from_str(SCHEMA_FIXTURE).expect("schema fixture parses");
    for vector in fixture.vectors {
        assert_eq!(
            parse_collection_schema(&vector.yaml),
            vector.expected,
            "schema vector {} disagrees with the TypeScript oracle",
            vector.name
        );
    }
}

#[test]
fn collection_schema_reason_cap_matches_the_shared_boundary_vector() {
    let fixture: SchemaLimitFixture =
        serde_json::from_str(SCHEMA_LIMIT_FIXTURE).expect("schema-limit fixture parses");
    for vector in fixture.reason_vectors {
        let mut yaml = String::from("fields:\n");
        for index in 0..vector.item_count {
            yaml.push_str(&format!("  invalid_{index}: value\n"));
        }

        let parsed = parse_collection_schema(&yaml);

        assert_eq!(
            parsed.status,
            CollectionSchemaStatus::Degraded,
            "{}",
            vector.name
        );
        assert!(parsed.schema.fields.is_empty(), "{}", vector.name);
        assert_eq!(
            parsed.reasons.len(),
            vector.expected_reason_count,
            "{}",
            vector.name
        );
        assert_eq!(
            parsed.reasons.last(),
            Some(&vector.expected_terminal_reason),
            "{}",
            vector.name
        );
    }
}

#[test]
fn collection_schema_item_caps_match_the_shared_boundary_vector() {
    let fixture: SchemaLimitFixture =
        serde_json::from_str(SCHEMA_LIMIT_FIXTURE).expect("schema-limit fixture parses");
    for vector in fixture.vectors {
        let mut yaml = String::from("fields:\n");
        for index in 0..vector.item_count {
            yaml.push_str(&format!("  field_{index}:\n    type: text\n"));
        }
        yaml.push_str("views:\n");
        for index in 0..vector.item_count {
            yaml.push_str(&format!("  - name: View {index}\n    kind: table\n"));
            if index == 0 {
                yaml.push_str(&format!(
                    "    groupBy: field_{}\n",
                    vector.referenced_field_index
                ));
            }
        }

        let parsed = parse_collection_schema(&yaml);

        assert_eq!(
            parsed.status,
            CollectionSchemaStatus::Degraded,
            "{}",
            vector.name
        );
        assert_eq!(
            parsed.schema.fields.len(),
            vector.expected_item_count,
            "{}",
            vector.name
        );
        assert_eq!(
            parsed.schema.views.len(),
            vector.expected_item_count,
            "{}",
            vector.name
        );
        assert_eq!(parsed.schema.views[0].group_by, None, "{}", vector.name);
        assert_eq!(parsed.reasons, vector.expected_reasons, "{}", vector.name);
    }
}

#[test]
fn field_value_results_match_the_typescript_oracle() {
    let fixture: Fixture<FieldValueVector> =
        serde_json::from_str(FIELD_VALUE_FIXTURE).expect("Field value fixture parses");
    for vector in fixture.vectors {
        let value = field_value_from_yaml(&vector.value_yaml);
        let original = value.clone();
        assert_eq!(
            validate_field_value(&vector.field, &value),
            vector.expected,
            "Field value vector {} disagrees with the TypeScript oracle",
            vector.name
        );
        assert_eq!(
            format!("{value:?}"),
            format!("{original:?}"),
            "validation mutated vector {}",
            vector.name
        );
    }
}

#[test]
fn record_id_results_match_the_typescript_oracle() {
    let fixture: Fixture<RecordIdVector> =
        serde_json::from_str(RECORD_ID_FIXTURE).expect("Record id fixture parses");
    for vector in fixture.vectors {
        assert_eq!(
            is_record_id(&vector.value),
            vector.valid,
            "Record id {:?} disagrees with the TypeScript oracle",
            vector.value
        );
    }
}

#[test]
fn frontmatter_delimiters_match_the_typescript_oracle() {
    let fixture: Fixture<FrontmatterVector> =
        serde_json::from_str(FRONTMATTER_FIXTURE).expect("frontmatter fixture parses");
    for mut vector in fixture.vectors {
        if let Some(expected) = vector.expected.as_mut() {
            decode_fixture_integers(expected);
        }
        assert_eq!(
            markdown_frontmatter_json(&vector.markdown),
            vector.expected,
            "frontmatter vector {} disagrees with the TypeScript oracle",
            vector.name
        );
    }
}

fn decode_fixture_integers(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                decode_fixture_integers(value);
            }
        }
        serde_json::Value::Object(values) => {
            if values.len() == 1
                && let Some(decimal) = values.get("$dohcInt64").and_then(|value| value.as_str())
            {
                *value = serde_json::Value::Number(
                    decimal
                        .parse::<i64>()
                        .expect("fixture int64 is valid")
                        .into(),
                );
            } else {
                for value in values.values_mut() {
                    decode_fixture_integers(value);
                }
            }
        }
        _ => {}
    }
}

#[test]
fn scalar_and_sequence_frontmatter_documents_are_not_mappings() {
    for markdown in ["---\nnull\n---", "---\ntext\n---", "---\n[]\n---"] {
        assert_eq!(
            markdown_frontmatter_json(markdown),
            None,
            "non-mapping frontmatter must remain inadmissible: {markdown:?}"
        );
    }
}
