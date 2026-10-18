use std::collections::HashMap;

/// The desktop graph's wikilink precedence, over the active version's aliases.
pub(super) struct Resolver {
    exact: HashMap<String, String>,
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

fn without_extension(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rfind('.') {
        Some(i) if i > 0 => &path[..path.len() - name.len() + i],
        _ => path,
    }
}

fn markdown_extension(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, ext)| {
        matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdx")
    })
}

pub(super) fn decode(raw: &str) -> String {
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
            let Some(byte) = std::str::from_utf8(pair)
                .ok()
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
            else {
                return raw.into();
            };
            bytes.push(byte);
            i += 3;
        } else {
            bytes.push(input[i]);
            i += 1;
        }
    }
    String::from_utf8(bytes).unwrap_or_else(|_| raw.into())
}

impl Resolver {
    pub(super) fn for_version(
        conn: &rusqlite::Connection,
        ws: &str,
        version: &str,
    ) -> Result<Self, dohc_engine_storage::StorageError> {
        let mut stmt = conn.prepare_cached(
            "SELECT path FROM link_aliases WHERE workspace_id=?1 AND version_id=?2 ORDER BY path",
        ).map_err(super::sql)?;
        let paths = stmt
            .query_map(rusqlite::params![ws, version], |r| r.get(0))
            .map_err(super::sql)?
            .collect::<Result<Vec<String>, _>>()
            .map_err(super::sql)?;
        Ok(Self::new(paths))
    }

    pub(super) fn new(paths: impl IntoIterator<Item = String>) -> Self {
        let mut index = Self {
            exact: HashMap::new(),
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
            index.exact.insert(path.clone(), path);
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

    pub(super) fn resolve(&self, source: &str, raw: &str) -> Option<&str> {
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
        let target = decode(raw);
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
    fn shared_resolver_cases() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("parity.json")).unwrap();
        for case in fixture["resolve"].as_array().unwrap() {
            if case["kind"].as_str() != Some("wikilink") {
                continue;
            }
            let paths = case["paths"]
                .as_array()
                .map(|paths| {
                    paths
                        .iter()
                        .map(|path| path.as_str().unwrap().to_owned())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_else(|| vec![case["target"].as_str().unwrap().to_owned()]);
            let index = Resolver::new(paths);
            assert_eq!(
                index.resolve(
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
