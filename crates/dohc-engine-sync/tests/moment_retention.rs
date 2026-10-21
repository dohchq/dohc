use quote::ToTokens;
use std::path::Path;

const ROLLBACK: &str = "dohc-engine-domain/src/store/rollback.rs";
const CHECKED_DELETE_DISCARD: &str = "dohc-engine-domain/src/store/delete_rename.rs";
const CHECKED_DELETE_DISCARD_SQL: &str =
    "DELETE FROM moments WHERE workspace_id=?1 AND moment_id=?2";
const PROJECTION: &str = "dohc-engine-domain/src/collections/projection.rs";
const RETAINED_TABLES: [&str; 4] = [
    "moments",
    "versions",
    "file_objects",
    "versioned_workspaces",
];

fn destructive_statements(source: &str) -> Vec<String> {
    let source = source
        .replace("\\n", " ")
        .replace("\\r", " ")
        .replace("\\t", " ")
        .replace('=', " = ")
        .replace(';', " ; ");
    let tokens: Vec<_> = source
        .split(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '_' | '=' | ';' | '\''))
        .filter(|word| !word.is_empty())
        .collect();
    let words: Vec<_> = tokens
        .iter()
        .map(|word| word.trim_matches('\'').to_ascii_lowercase())
        .collect();
    let mut found = Vec::new();
    for (index, word) in words.iter().enumerate() {
        let rest = &words[index..];
        if word == "update" {
            let table_index = if rest.get(1).is_some_and(|s| s == "main") {
                2
            } else {
                1
            };
            if rest.get(table_index).is_some_and(|s| s == "moments")
                && rest.get(table_index + 1).is_some_and(|s| s == "set")
                && rest[table_index + 2..]
                    .iter()
                    .take_while(|s| !matches!(s.as_str(), "where" | "returning" | ";"))
                    .collect::<Vec<_>>()
                    .windows(2)
                    .any(|pair| pair[0] == "moment_id" && pair[1] == "=")
            {
                found.push("update moments".to_owned());
            }
            continue;
        }
        if !matches!(
            (word.as_str(), rest.get(1).map(String::as_str)),
            ("delete", Some("from")) | ("drop", Some("table")) | ("replace", Some("into"))
        ) {
            continue;
        }
        if tokens[index].starts_with('\'') {
            continue;
        }
        if let Some(target) = rest.get(2) {
            let target = if target == "main" {
                rest.get(3).unwrap_or(target)
            } else {
                target
            };
            let target = if target == "if" && rest.get(3).is_some_and(|s| s == "exists") {
                rest.get(4).unwrap_or(target)
            } else {
                target
            };
            if RETAINED_TABLES.contains(&target.as_str()) {
                found.push(format!("{word} {target}"));
            }
        }
    }
    let normalized = source
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    for operation in ["delete from", "drop table", "replace into"] {
        for _ in normalized.matches(&format!("{operation} {{")) {
            found.push("dynamic deletion".to_owned());
        }
    }
    found
}

fn production_source(source: &str) -> String {
    fn retain_production(items: &mut Vec<syn::Item>) {
        items.retain_mut(|item| {
            let syn::Item::Mod(module) = item else {
                return true;
            };
            if module.attrs.iter().any(|attr| {
                attr.path().is_ident("cfg")
                    && attr
                        .parse_args::<syn::Path>()
                        .is_ok_and(|path| path.is_ident("test"))
            }) {
                return false;
            }
            if let Some((_, items)) = &mut module.content {
                retain_production(items);
            }
            true
        });
    }
    let mut file = syn::parse_file(source).expect("retention audit must parse the whole Rust file");
    retain_production(&mut file.items);
    file.into_token_stream().to_string()
}

fn audit(directory: &Path, crates: &Path, found: &mut Vec<(String, String)>) {
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            if path.file_name().unwrap() != "tests" {
                audit(&path, crates, found);
            }
        } else if path.extension().is_some_and(|ext| ext == "rs")
            && path.file_stem().is_some_and(|stem| stem != "tests")
            && !path
                .file_stem()
                .unwrap()
                .to_string_lossy()
                .ends_with("_tests")
        {
            let source = std::fs::read_to_string(&path).unwrap();
            let production = production_source(&source);
            let relative = path
                .strip_prefix(crates)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            for statement in destructive_statements(&production) {
                if relative == CHECKED_DELETE_DISCARD && statement == "delete moments" {
                    // Failed disk publication discards its own prepared delete only
                    // when no export or pending conflict shadow references it.
                    assert_checked_delete_discard_site(&source);
                }
                if relative == PROJECTION && statement == "dynamic deletion" {
                    assert!(
                        !RETAINED_TABLES
                            .iter()
                            .any(|table| production.contains(&format!("\"{table}\"")))
                    );
                    continue;
                }
                found.push((relative.clone(), statement));
            }
        }
    }
}

fn assert_checked_delete_discard_site(source: &str) {
    let file = syn::parse_file(source).unwrap();
    let function = file
        .items
        .into_iter()
        .find_map(|item| match item {
            syn::Item::Fn(function) if function.sig.ident == "finish_checked_delete_in_tx" => {
                Some(function)
            }
            _ => None,
        })
        .expect("checked delete discard must stay in its guarded function");
    let body = function.block.into_token_stream().to_string();
    assert_eq!(destructive_statements(&body), ["delete moments"]);
    assert!(
        body.contains(&format!("{CHECKED_DELETE_DISCARD_SQL:?}")),
        "checked delete discard must delete only its named workspace moment"
    );
}

/// A hosted document that leaves the scope parks with its history, so no
/// hosted path deletes a moment.
#[test]
fn production_moment_deleters_preserve_published_and_pinned_history() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut found = Vec::new();
    for entry in std::fs::read_dir(crates).unwrap() {
        let source = entry.unwrap().path().join("src");
        if source.is_dir() {
            audit(&source, crates, &mut found);
        }
    }
    found.sort();
    assert_eq!(
        found,
        [
            (
                CHECKED_DELETE_DISCARD.to_owned(),
                "delete moments".to_owned()
            ),
            (ROLLBACK.to_owned(), "delete file_objects".to_owned()),
            (ROLLBACK.to_owned(), "delete moments".to_owned()),
        ]
    );
}

#[test]
fn checked_delete_inventory_entry_rejects_a_broader_or_moved_discard() {
    for source in [
        "fn finish_checked_delete_in_tx() { execute(\"DELETE FROM moments WHERE workspace_id=?1\"); }",
        "fn another_function() { execute(\"DELETE FROM moments WHERE workspace_id=?1 AND moment_id=?2\"); }",
        "fn finish_checked_delete_in_tx() { execute(\"DELETE FROM moments WHERE workspace_id=?1 AND moment_id=?2\"); execute(\"DELETE FROM moments\"); }",
    ] {
        assert!(std::panic::catch_unwind(|| assert_checked_delete_discard_site(source)).is_err());
    }
}

#[test]
fn retention_audit_recognizes_other_deleters_and_cascading_parents() {
    for sql in [
        "DELETE\nFROM moments",
        "delete from \"moments\"",
        "DELETE FROM main.moments",
        "DELETE FROM versions",
        "DELETE FROM file_objects",
        "DELETE FROM versioned_workspaces",
        "INSERT OR REPLACE INTO moments",
        "DROP TABLE moments",
        "DROP TABLE IF EXISTS moments",
        "DELETE FROM {table}",
        "DELETE FROM {other}",
        "UPDATE moments SET moment_id = ?1",
        "UPDATE main.moments SET path = ?1, moment_id = ?2",
        "UPDATE \"moments\" SET \"moment_id\"=?1 WHERE moment_id=?2",
        r#"fn writer() { let sql = "DELETE FROM moments"; execute(sql); }"#,
        "SELECT EXISTS(SELECT 1 FROM moments c WHERE c.operation='delete')\n FROM moments m; DELETE FROM moments",
    ] {
        assert!(!destructive_statements(sql).is_empty(), "missed {sql}");
    }
    for sql in [
        "UPDATE moments SET path=moment_id WHERE moment_id=?1",
        "UPDATE moments SET path=?1; SELECT moment_id=?2",
        "SELECT EXISTS(SELECT 1 FROM moments c WHERE c.operation='delete')\n FROM moments m",
        "SELECT EXISTS(SELECT 1 FROM moments c WHERE c.operation IN ('delete'))\n FROM moments m",
        "SELECT EXISTS(SELECT 1 FROM moments c WHERE c.operation<>'delete')\n FROM moments m",
        "SELECT EXISTS(SELECT 1 FROM moments c WHERE c.operation IS 'delete')\n FROM moments m",
    ] {
        assert!(
            destructive_statements(sql).is_empty(),
            "misclassified {sql}"
        );
    }
}

#[test]
fn retention_audit_scans_production_after_test_modules() {
    let source = r###"
        fn before() { execute("DELETE FROM versions"); }
        #[cfg(test)]
        mod tests {
            #[test]
            fn corruption() { execute(r#"DELETE FROM moments WHERE id = '}'"#); }
        }
        fn after() { execute("UPDATE moments SET moment_id = ?1"); }
        mod nested {
            #[cfg(test)]
            mod tests { fn corruption() { execute("DELETE FROM file_objects"); } }
            fn after() { execute("DELETE FROM versioned_workspaces"); }
        }
    "###;
    assert_eq!(
        destructive_statements(&production_source(source)),
        [
            "delete versions",
            "update moments",
            "delete versioned_workspaces"
        ]
    );
}
