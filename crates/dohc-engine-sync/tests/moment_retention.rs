use std::path::Path;

const ROLLBACK: &str = "dohc-engine-domain/src/store/rollback.rs";
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
        .replace("\\t", " ");
    let words: Vec<_> = source
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|word| !word.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();
    let mut found = Vec::new();
    for (index, word) in words.iter().enumerate() {
        let rest = &words[index..];
        if !matches!(
            (word.as_str(), rest.get(1).map(String::as_str)),
            ("delete", Some("from")) | ("drop", Some("table")) | ("replace", Some("into"))
        ) {
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

fn audit(directory: &Path, crates: &Path, found: &mut Vec<(String, String)>) {
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            if path.file_name().unwrap() != "tests" {
                audit(&path, crates, found);
            }
        } else if path.extension().is_some_and(|ext| ext == "rs")
            && !path
                .file_stem()
                .unwrap()
                .to_string_lossy()
                .ends_with("_tests")
        {
            let source = std::fs::read_to_string(&path).unwrap();
            let production = source.split("#[cfg(test)]").next().unwrap();
            let relative = path
                .strip_prefix(crates)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            for statement in destructive_statements(production) {
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

#[test]
fn rollback_is_the_only_production_moment_deleter_including_cascades() {
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
            (ROLLBACK.to_owned(), "delete file_objects".to_owned()),
            (ROLLBACK.to_owned(), "delete moments".to_owned())
        ]
    );
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
    ] {
        assert!(!destructive_statements(sql).is_empty(), "missed {sql}");
    }
}
