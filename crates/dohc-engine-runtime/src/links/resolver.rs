use std::collections::{HashMap, HashSet};

/// The desktop graph's wikilink precedence, over the active version's aliases.
pub(crate) struct Resolver {
    exact: HashSet<String>,
    folded: HashMap<String, Option<String>>,
    stems: HashMap<String, Option<String>>,
    extensionless: HashMap<String, Option<String>>,
}

fn unique(map: &mut HashMap<String, Option<String>>, key: String, path: &str) {
    map.entry(key)
        .and_modify(|value| {
            if value.as_deref() != Some(path) {
                *value = None;
            }
        })
        .or_insert_with(|| Some(path.to_owned()));
}

pub(crate) fn without_extension(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rfind('.') {
        Some(i) if i > 0 => &path[..path.len() - name.len() + i],
        _ => path,
    }
}

fn markdown_extension(path: &str) -> bool {
    let name = path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path);
    name.rfind('.').filter(|i| *i > 0).is_some_and(|i| {
        let ext = &name[i + 1..];
        matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdx")
    })
}

fn decode(raw: &str) -> String {
    let mut bytes = Vec::with_capacity(raw.len());
    let input = raw.as_bytes();
    let mut i = 0;
    while i < input.len() {
        if input[i] == b'%' {
            let Some(pair) = input.get(i + 1..i + 3) else {
                return raw.into();
            };
            if !pair.iter().all(u8::is_ascii_hexdigit) {
                return raw.into();
            }
            let hex = |digit: u8| match digit {
                b'0'..=b'9' => digit - b'0',
                b'a'..=b'f' => digit - b'a' + 10,
                _ => digit - b'A' + 10,
            };
            let byte = (hex(pair[0]) << 4) | hex(pair[1]);
            bytes.push(byte);
            i += 3;
        } else {
            bytes.push(input[i]);
            i += 1;
        }
    }
    String::from_utf8(bytes).unwrap_or_else(|_| raw.into())
}

// Rust trim includes U+0085 and excludes U+FEFF; JavaScript trim does the reverse.
pub(super) fn target(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let raw = raw.split('#').next()?;
    let raw = match raw.find('?') {
        Some(i) if i > 0 => &raw[..i],
        _ => raw,
    }
    .trim();
    if raw.is_empty()
        || raw.contains(['\0', '\\'])
        || raw.starts_with("//")
        || raw.split_once(':').is_some_and(|(scheme, _)| {
            scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        })
    {
        return None;
    }
    Some(decode(raw))
}

/// The path a click opens when no unique alias exists.
pub(super) fn creation_path(source: &str, raw: &str, kind: &str) -> Option<String> {
    let target = target(raw)?;
    let relative = target.trim_start_matches('/');
    if target.contains('\\')
        || target.chars().any(char::is_control)
        || target.starts_with("//")
        || relative.as_bytes().get(1) == Some(&b':')
    {
        return None;
    }
    let directory = source.rsplit_once('/').map_or("", |(dir, _)| dir);
    let rooted_wikilink = kind == "wikilink"
        && target.contains('/')
        && !target.starts_with("./")
        && !target.starts_with("../");
    let candidate = if target.starts_with('/') || directory.is_empty() || rooted_wikilink {
        target.trim_start_matches('/').to_owned()
    } else {
        format!("{directory}/{target}")
    };
    let mut prefix = String::new();
    for part in candidate
        .split('/')
        .filter(|part| !matches!(*part, "" | "." | ".."))
    {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(part);
        if !dohc_engine_files::materialize::creation_segment_is_safe(part)
            || dohc_engine_files::policy::classify_engine_file_path(&prefix)
                != dohc_engine_files::policy::PathClassification::Tracked
        {
            return None;
        }
    }
    let mut path = super::normalize_path(&candidate)?;
    if path.is_empty() {
        return None;
    }
    if (kind == "wikilink" || without_extension(&path) == path) && !markdown_extension(&path) {
        path.push_str(".md");
    }
    if !path
        .split('/')
        .all(dohc_engine_files::materialize::creation_segment_is_safe)
        || dohc_engine_files::policy::classify_engine_file_path(&path)
            != dohc_engine_files::policy::PathClassification::Tracked
    {
        return None;
    }
    Some(path)
}

impl Resolver {
    pub(crate) fn paths_for_version(
        conn: &rusqlite::Connection,
        ws: &str,
        version: &str,
    ) -> Result<Vec<String>, dohc_engine_storage::StorageError> {
        let mut stmt = conn
            .prepare_cached("SELECT path FROM path_aliases WHERE workspace_id=?1 AND version_id=?2")
            .map_err(super::sql)?;
        let paths = stmt
            .query_map(rusqlite::params![ws, version], |r| r.get(0))
            .map_err(super::sql)?
            .collect::<Result<Vec<String>, _>>()
            .map_err(super::sql)?;
        Ok(paths)
    }

    pub(crate) fn new(paths: impl IntoIterator<Item = String>) -> Self {
        let mut index = Self {
            exact: HashSet::new(),
            folded: HashMap::new(),
            stems: HashMap::new(),
            extensionless: HashMap::new(),
        };
        for path in paths {
            unique(&mut index.folded, path.to_lowercase(), &path);
            let bare = without_extension(&path);
            unique(&mut index.extensionless, bare.to_lowercase(), &path);
            unique(
                &mut index.stems,
                bare.rsplit('/').next().unwrap_or(bare).to_lowercase(),
                &path,
            );
            index.exact.insert(path);
        }
        index
    }

    fn lookup(&self, candidate: &str) -> Option<&str> {
        let mut path = super::normalize_path(candidate)?;
        if path.is_empty() {
            return None;
        }
        if candidate.ends_with('/') {
            path.push('/');
        }
        self.exact.get(&path).map(String::as_str).or_else(|| {
            self.folded
                .get(&path.to_lowercase())
                .and_then(|value| value.as_deref())
        })
    }

    fn family(&self, candidate: &str) -> Option<&str> {
        if let Some(path) = self.lookup(candidate) {
            return Some(path);
        }
        if !markdown_extension(candidate) {
            for ext in ["md", "markdown", "mdx"] {
                if let Some(path) = self.lookup(&format!("{candidate}.{ext}")) {
                    return Some(path);
                }
            }
        }
        self.extensionless
            .get(&candidate.to_lowercase())
            .and_then(|value| value.as_deref())
    }

    pub(super) fn resolve_markdown(&self, source: &str, raw: &str) -> Option<&str> {
        let target = target(raw)?;
        let directory = source.rsplit_once('/').map_or("", |(dir, _)| dir);
        let candidate = if target.starts_with('/') || directory.is_empty() {
            target.trim_start_matches('/').to_owned()
        } else {
            format!("{directory}/{target}")
        };
        let mut normalized = super::normalize_path(&candidate)?;
        if target.ends_with('/') {
            normalized.push('/');
        }
        self.family(&normalized)
    }

    pub(super) fn resolve(&self, source: &str, raw: &str) -> Option<&str> {
        let target = target(raw)?;
        let directory = source.rsplit_once('/').map_or("", |(dir, _)| dir);
        let relative = if directory.is_empty() {
            target.clone()
        } else {
            format!("{directory}/{target}")
        };
        if target.starts_with('/') {
            self.family(target.trim_start_matches('/'))
        } else if target.starts_with("./") || target.starts_with("../") {
            let mut path = super::normalize_path(&relative)?;
            if target.ends_with('/') {
                path.push('/');
            }
            self.family(&path)
        } else if target.contains('/') {
            self.family(&target)
        } else {
            let relative = super::normalize_path(&relative)?;
            if let Some(path) = self.family(&relative) {
                return Some(path);
            }
            if let Some(stem) = self.stems.get(&target.to_lowercase()) {
                return stem.as_deref();
            }
            markdown_extension(&target)
                .then(|| self.family(&target))
                .flatten()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creation_rejects_decoded_wikilink_drive() {
        assert_eq!(
            creation_path("source.md", "C%3A/Windows/x", "wikilink"),
            None
        );
    }

    #[test]
    fn creation_rejects_decoded_markdown_drive() {
        assert_eq!(
            creation_path("source.md", "/C%3A/Windows/run.bat", "markdown"),
            None
        );
    }

    #[test]
    fn creation_rejects_decoded_unc_backslashes() {
        assert_eq!(
            creation_path("source.md", "%5C%5Chost%5Cshare%5Cx.bat", "markdown"),
            None
        );
    }

    #[test]
    fn creation_rejects_decoded_nul() {
        assert_eq!(creation_path("source.md", "x%00y", "wikilink"), None);
    }

    #[test]
    fn creation_rejects_decoded_control() {
        assert_eq!(creation_path("source.md", "x%01y", "wikilink"), None);
    }

    #[test]
    fn creation_rejects_decoded_delete_control() {
        assert_eq!(creation_path("source.md", "x%7Fy", "markdown"), None);
    }

    #[test]
    fn creation_rejects_decoded_unc_slashes() {
        assert_eq!(
            creation_path("source.md", "%2F%2Fhost/share/x", "wikilink"),
            None
        );
    }

    #[test]
    fn creation_rejects_reserved_directory() {
        assert_eq!(
            creation_path("source.md", ".dohc/engine/x", "wikilink"),
            None
        );
    }

    #[test]
    fn creation_rejects_decoded_reserved_segment() {
        assert_eq!(
            creation_path("source.md", "notes/%2Edohc/engine/x", "markdown"),
            None
        );
    }

    #[test]
    fn creation_rejects_secret_segment() {
        assert_eq!(creation_path("source.md", "notes/.env/x", "wikilink"), None);
    }

    #[test]
    fn creation_rejects_decoded_secret_segment() {
        assert_eq!(
            creation_path("source.md", "notes/%2Eenv/x", "markdown"),
            None
        );
    }

    #[test]
    fn creation_rejects_colon_segments() {
        assert_eq!(creation_path("source.md", "x.md:evil", "wikilink"), None);
        assert_eq!(
            creation_path("source.md", "notes/x.md%3Aevil", "markdown"),
            None
        );
    }

    #[cfg(windows)]
    #[test]
    fn creation_rejects_windows_device_and_short_names() {
        for literal in [
            "CON.txt",
            "NUL .txt",
            "COM¹.md",
            "report~1.pdf",
            "ab~1.x~y",
            "ab~x~1.md",
            "😀😀😀😀~1.md",
            "notes/LPT9/new.md",
        ] {
            assert_eq!(
                creation_path("source.md", literal, "markdown"),
                None,
                "{literal}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn creation_allows_names_outside_the_desktop_short_name_pattern() {
        for literal in [
            "abcdefghi~1.md",
            "ab~1.long",
            "ab~1.x.y",
            "ab~x.md",
            "😀😀😀😀a~1.md",
            "ab~1.x\u{feff}y",
        ] {
            assert_eq!(
                creation_path("source.md", literal, "markdown"),
                Some(literal.into()),
                "{literal}"
            );
        }
    }

    #[test]
    fn creation_allows_nested_shared_with_me() {
        assert_eq!(
            creation_path("source.md", "notes/shared-with-me/new", "wikilink"),
            Some("notes/shared-with-me/new.md".into())
        );
        assert_eq!(
            creation_path("notes/source.md", "./shared-with-me/new", "markdown"),
            Some("notes/shared-with-me/new.md".into())
        );
        assert_eq!(
            creation_path("source.md", "shared-with-me/new", "wikilink"),
            None
        );
    }

    #[test]
    fn shared_resolver_cases() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("parity.json")).unwrap();
        for case in fixture["resolve"].as_array().unwrap() {
            let paths = case["paths"]
                .as_array()
                .map(|paths| {
                    paths
                        .iter()
                        .map(|path| path.as_str().unwrap().to_owned())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_else(|| {
                    let mut paths = vec![case["source"].as_str().unwrap().to_owned()];
                    if let Some(target) = case["target"].as_str() {
                        paths.push(target.to_owned());
                    }
                    paths
                });
            let index = Resolver::new(paths);
            let resolve = if case["kind"] == "markdown" {
                Resolver::resolve_markdown
            } else {
                Resolver::resolve
            };
            assert_eq!(
                resolve(
                    &index,
                    case["source"].as_str().unwrap(),
                    case["literal"].as_str().unwrap()
                ),
                case["target"].as_str(),
                "{}",
                case["name"]
            );
        }
    }
}
