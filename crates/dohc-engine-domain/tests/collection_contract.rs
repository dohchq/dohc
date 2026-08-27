use dohc_engine_domain::{
    CollectionFieldValue, CollectionSchemaParseResult, FieldDefinition, FieldValueValidation,
    is_record_id, parse_collection_schema, validate_field_value,
};
use saphyr::{LoadableYamlNode, ScalarOwned, YamlOwned};
use serde::Deserialize;

const SCHEMA_FIXTURE: &str = include_str!("fixtures/collection-schemas.json");
const FIELD_VALUE_FIXTURE: &str = include_str!("fixtures/collection-field-values.json");
const RECORD_ID_FIXTURE: &str = include_str!("fixtures/collection-record-ids.json");

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
