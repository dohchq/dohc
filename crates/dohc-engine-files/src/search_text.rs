use std::borrow::Cow;
use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct ExcalidrawScene<'a> {
    #[serde(rename = "type", borrow)]
    kind: Cow<'a, str>,
    #[serde(default, borrow)]
    elements: Option<Vec<ExcalidrawElement<'a>>>,
}

#[derive(Deserialize)]
struct ExcalidrawElement<'a> {
    #[serde(rename = "type", default, borrow)]
    kind: Option<Cow<'a, str>>,
    #[serde(rename = "isDeleted", default)]
    is_deleted: Option<Value>,
    #[serde(rename = "originalText", default, borrow)]
    original_text: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    text: Option<Cow<'a, str>>,
}

/// Return the text that file search can index without exposing format data.
///
/// Ordinary text files keep their full body. An Excalidraw drawing contributes
/// only the authored content of live text elements. A drawing that cannot be
/// parsed contributes no body text, so JSON keys and embedded files never
/// become a fallback search corpus.
pub fn extract_search_text<'a>(path: &str, body: &'a str) -> Cow<'a, str> {
    if !is_excalidraw_path(path) {
        return Cow::Borrowed(body);
    }

    Cow::Owned(extract_excalidraw_text(body).unwrap_or_default())
}

fn is_excalidraw_path(path: &str) -> bool {
    let path = Path::new(path);
    path.file_name()
        .and_then(|file_name| file_name.to_str())
        .is_some_and(|file_name| file_name.eq_ignore_ascii_case(".excalidraw"))
        || path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("excalidraw"))
}

fn extract_excalidraw_text(body: &str) -> Option<String> {
    let scene: ExcalidrawScene<'_> = serde_json::from_str(body).ok()?;
    if scene.kind != "excalidraw" {
        return None;
    }

    let mut extracted = String::new();
    for element in scene.elements.unwrap_or_default() {
        if element.kind.as_deref() != Some("text") {
            continue;
        }
        let is_deleted = match element.is_deleted {
            Some(Value::Bool(is_deleted)) => is_deleted,
            None | Some(Value::Null) => false,
            Some(_) => continue,
        };
        if is_deleted {
            continue;
        }
        let authored = element.original_text.or(element.text);
        if let Some(authored) = authored.filter(|authored| !authored.is_empty()) {
            if !extracted.is_empty() {
                extracted.push('\n');
            }
            extracted.push_str(&authored);
        }
    }
    Some(extracted)
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use serde_json::json;

    use super::extract_search_text;

    #[test]
    fn ordinary_text_is_unchanged_and_borrowed() {
        let body = "title: elements\n\nordinary body";
        let extracted = extract_search_text("notes/example.md", body);

        assert!(matches!(extracted, Cow::Borrowed(_)));
        assert_eq!(extracted, body);
    }

    #[test]
    fn drawing_extracts_only_live_authored_text() {
        let body = json!({
            "type": "excalidraw",
            "version": 2,
            "source": "https://example.invalid/private-source",
            "elements": [
                {
                    "id": "private-element-id",
                    "type": "text",
                    "text": "wrapped\nlabel",
                    "originalText": "Useful label",
                    "isDeleted": false
                },
                {
                    "type": "text",
                    "text": "Legacy label",
                    "isDeleted": false
                },
                {
                    "type": "text",
                    "text": "deleted search secret",
                    "originalText": "deleted search secret",
                    "isDeleted": true
                },
                {
                    "type": "text",
                    "text": "malformed deletion secret",
                    "originalText": "malformed deletion secret",
                    "isDeleted": "false"
                },
                { "type": "rectangle", "link": "https://example.invalid/private-link" }
            ],
            "appState": { "name": "private scene name" },
            "files": {
                "private-file-id": {
                    "dataURL": "data:image/png;base64,BASE64SEARCHSECRET"
                }
            }
        })
        .to_string();

        let extracted = extract_search_text("boards/plan.EXCALIDRAW", &body);

        assert_eq!(extracted, "Useful label\nLegacy label");
        for private in [
            "wrapped",
            "deleted search secret",
            "malformed deletion secret",
            "private-element-id",
            "private scene name",
            "BASE64SEARCHSECRET",
            "dataURL",
            "elements",
        ] {
            assert!(!extracted.contains(private), "leaked {private:?}");
        }
    }

    #[test]
    fn malformed_or_non_scene_json_contributes_no_body_text() {
        for body in [
            r#"{"type":"excalidraw","elements":["#,
            r#"{"type":"not-excalidraw","elements":[]}"#,
            r#"{"type":"excalidraw","elements":{}}"#,
        ] {
            assert_eq!(extract_search_text("board.excalidraw", body), "");
        }
    }
}
