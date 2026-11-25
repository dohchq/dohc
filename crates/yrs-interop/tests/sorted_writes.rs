use std::collections::HashMap;
use std::sync::Arc;
use yrs::types::text::TextItem;
use yrs::types::Attrs;
use yrs::{Any, Doc, Text, Transact};

const KEYS: [&str; 8] = ["h", "c", "f", "a", "g", "b", "e", "d"];

#[test]
fn a_map_value_is_encoded_with_its_keys_in_order() {
    for _ in 0..20 {
        let map: HashMap<String, Any> = KEYS
            .iter()
            .map(|key| (key.to_string(), Any::Null))
            .collect();
        let mut bytes = Vec::new();
        Any::from(map).encode(&mut bytes);
        let mut expected = vec![118, 8];
        for key in [b'a', b'b', b'c', b'd', b'e', b'f', b'g', b'h'] {
            expected.extend([1, key, 126]);
        }
        assert_eq!(bytes, expected);
    }
}

#[test]
fn letters_with_marks_open_and_close_each_mark_in_the_order_of_its_name() {
    for _ in 0..20 {
        let doc = Doc::new();
        let text = doc.get_or_insert_text("sequence");
        let marks: Attrs = KEYS
            .iter()
            .map(|key| (Arc::from(*key), Any::Bool(true)))
            .collect();
        let mut txn = doc.transact_mut();
        text.insert_with_attributes(&mut txn, 0, "x", marks);
        let mut stored = Vec::new();
        text.try_visit_items(&txn, |item| {
            stored.push(match item {
                TextItem::Format(key, Any::Null) => format!("-{key}"),
                TextItem::Format(key, _) => format!("+{key}"),
                TextItem::Letters(letters) => letters.to_owned(),
                _ => "other".to_owned(),
            });
            Ok::<(), ()>(())
        })
        .unwrap();
        let opened = ["+a", "+b", "+c", "+d", "+e", "+f", "+g", "+h"];
        let closed = ["-a", "-b", "-c", "-d", "-e", "-f", "-g", "-h"];
        let expected: Vec<&str> = opened.into_iter().chain(["x"]).chain(closed).collect();
        assert_eq!(stored, expected);
    }
}
