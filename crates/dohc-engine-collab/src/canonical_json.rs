//! Canonical JSON shared with JavaScript `JSON.stringify` writers.

use serde_json::{Number, Value};

/// Serialize JSON with Unicode-scalar key order and ECMAScript number spelling.
pub fn canonical_json_string(value: &Value) -> Option<String> {
    fn write(value: &Value, output: &mut String) -> Option<()> {
        match value {
            Value::Array(values) => {
                output.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    write(value, output)?;
                }
                output.push(']');
            }
            Value::Object(object) => {
                let mut entries = object.iter().collect::<Vec<_>>();
                entries.sort_by_key(|(key, _)| *key);
                output.push('{');
                for (index, (key, value)) in entries.into_iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    output.push_str(&serde_json::to_string(key).ok()?);
                    output.push(':');
                    write(value, output)?;
                }
                output.push('}');
            }
            Value::Number(number) => output.push_str(&javascript_number(number)?),
            scalar => output.push_str(&serde_json::to_string(scalar).ok()?),
        }
        Some(())
    }

    let mut output = String::new();
    write(value, &mut output)?;
    Some(output)
}

fn javascript_number(number: &Number) -> Option<String> {
    let value = number.as_f64()?;
    if !value.is_finite() {
        return None;
    }
    if value == 0.0 {
        return Some("0".to_owned());
    }
    Some(ryu_js::Buffer::new().format(value).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_typescript_canonical_json_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../packages/excalidraw-scene/fixtures/canonical-json.json"
        ))
        .expect("canonical fixture parses");
        for case in fixture["cases"].as_array().expect("fixture cases") {
            let raw = case["raw"].as_str().expect("raw JSON");
            let value: Value = serde_json::from_str(raw).expect("case parses");
            assert_eq!(
                canonical_json_string(&value).as_deref(),
                case["canonical"].as_str(),
                "{}",
                case["name"].as_str().expect("case name")
            );
        }
    }
}
