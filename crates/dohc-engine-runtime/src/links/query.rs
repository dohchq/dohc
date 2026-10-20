use super::{cache, incoming, resolver::Resolver, sql};
use crate::{ActorHandle, RuntimeError};
use dohc_engine_crypto::{SealedSecret, SecretDataKey, open, seal};
use dohc_engine_domain::{FileResolution, FileResolveTarget, VersionedTextStore};
use dohc_engine_storage::StorageError;
use rusqlite::params;
use serde_json::{Value, json};
use std::sync::OnceLock;
use tokio_util::sync::CancellationToken;

type CursorPosition = (String, usize, bool, bool);
type CursorPayload = (String, String, String, String, usize, bool, bool);

pub(super) fn invalid() -> RuntimeError {
    StorageError::InvalidInput {
        reason: "invalid links cursor or subject",
    }
    .into()
}

pub(crate) fn cursor_key() -> Result<&'static SecretDataKey, RuntimeError> {
    static KEY: OnceLock<Result<SecretDataKey, dohc_engine_crypto::CryptoError>> = OnceLock::new();
    KEY.get_or_init(SecretDataKey::generate)
        .as_ref()
        .map_err(|_| invalid())
}

pub(super) fn encode_cursor(
    ws: &str,
    version: &str,
    subject: &str,
    after: &CursorPosition,
) -> Result<String, RuntimeError> {
    let bytes = json!([version, subject, "in", after.0, after.1, after.2, after.3]).to_string();
    let sealed = seal(cursor_key()?, ws, "links.in", bytes.as_bytes()).map_err(|_| invalid())?;
    Ok(json!([
        sealed.iv_base64(),
        sealed.auth_tag_base64(),
        sealed.ciphertext_base64(),
        sealed.byte_length()
    ])
    .to_string())
}

pub(super) fn decode_cursor(
    ws: &str,
    version: &str,
    subject: &str,
    cursor: Option<String>,
) -> Result<CursorPosition, RuntimeError> {
    let Some(cursor) = cursor else {
        return Ok((String::new(), 0, true, false));
    };
    if cursor.len() > 32768 {
        return Err(invalid());
    }
    let (iv, tag, body, length): (String, String, String, usize) =
        serde_json::from_str(&cursor).map_err(|_| invalid())?;
    let sealed = SealedSecret::from_base64(&iv, &tag, &body, length).map_err(|_| invalid())?;
    let plaintext = open(cursor_key()?, ws, "links.in", &sealed).map_err(|_| invalid())?;
    let decoded: CursorPayload =
        serde_json::from_slice(plaintext.as_bytes()).map_err(|_| invalid())?;
    let (v, s, direction, path, ordinal, complete, building) = decoded;
    if v != version || s != subject || direction != "in" {
        return Err(invalid());
    }
    Ok((path, ordinal, complete, building))
}

pub(super) fn resolve<'a>(
    resolver: &'a Resolver,
    source: &str,
    literal: &str,
    kind: &str,
) -> Option<&'a str> {
    if kind == "markdown" {
        resolver.resolve_markdown(source, literal)
    } else {
        resolver.resolve(source, literal)
    }
}

impl ActorHandle {
    pub async fn resolve_links(
        &self,
        ws: String,
        source: String,
        literals: Vec<(String, String)>,
        token: CancellationToken,
    ) -> Result<Value, RuntimeError> {
        let cache = self.link_resolvers.clone();
        let (version, source, paths) = self
            .run(move |store, _| {
                if token.is_cancelled() {
                    return Err(RuntimeError::Cancelled);
                }
                let (version, results) = VersionedTextStore::new(store).resolve_files(
                    &ws,
                    None,
                    &[FileResolveTarget::Path(source.clone())],
                )?;
                let source = match results.into_iter().next() {
                    Some(FileResolution::Found { path, .. }) => path,
                    Some(FileResolution::Invalid) => return Err(invalid()),
                    _ => source,
                };
                let paths = store.read_with(|c| cache::prepare(c, &cache, &ws, &version))?;
                Ok((version, source, paths))
            })
            .await?;
        tokio::task::spawn_blocking(move || {
            let resolver = paths.build();
            let results: Vec<Value> = literals
                .into_iter()
                .map(|(kind, literal)| {
                    let fragment = literal.split_once('#').map(|(_, fragment)| fragment);
                    if literal.starts_with('#') {
                        return json!({"path":source,"fragment":fragment});
                    }
                    if let Some(path) = resolve(&resolver, &source, &literal, &kind) {
                        json!({"path":path,"fragment":fragment})
                    } else {
                        match super::resolver::creation_path(&source, &literal, &kind) {
                            Some(path) => json!({"path":null,"create":path,"fragment":fragment}),
                            None => Value::Null,
                        }
                    }
                })
                .collect();
            Ok(json!({"versionId":version,"results":results,"mountsCovered":true}))
        })
        .await
        .map_err(|_| invalid())?
    }

    pub async fn incoming_links(
        &self,
        ws: String,
        subject: FileResolveTarget,
        cursor: Option<String>,
        token: CancellationToken,
    ) -> Result<Value, RuntimeError> {
        let workspace = ws.clone();
        let cache = self.link_resolvers.clone();
        let prepared = self
            .run(move |store, _| {
                if token.is_cancelled() {
                    return Err(RuntimeError::Cancelled);
                }
                let (version, subjects) =
                    VersionedTextStore::new(store).resolve_files(&ws, None, &[subject])?;
                let (object, target) = match subjects.into_iter().next() {
                    Some(FileResolution::Found { object_id, path }) => (object_id, path),
                    Some(FileResolution::Invalid) => return Err(invalid()),
                    _ => return Ok(None),
                };
                let after = decode_cursor(&ws, &version, &object, cursor)?;
                store.read_with(|c| {
                    let snapshot = c.unchecked_transaction().map_err(sql)?;
                    let candidates =
                        incoming::candidates(c, &ws, &version, &target, &["wikilink", "markdown"])?;
                    let complete: bool = c.query_row(
                        "SELECT coalesce((SELECT seed_phase='ready' AND parser_generation=?3 FROM link_index_state WHERE workspace_id=?1 AND version_id=?2),0) AND NOT EXISTS(SELECT 1 FROM link_pending WHERE workspace_id=?1 AND version_id=?2)",
                        params![ws, version, super::PARSER_GENERATION], |r| r.get(0),
                    ).map_err(sql)?;
                    let missing: bool = c.query_row(
                        "SELECT EXISTS(SELECT 1 FROM link_aliases a WHERE a.workspace_id=?1 AND a.version_id=?2
                         AND NOT EXISTS(SELECT 1 FROM link_sources s WHERE s.workspace_id=a.workspace_id AND s.version_id=a.version_id AND s.object_id=a.object_id))",
                        params![ws, version], |r| r.get(0),
                    ).map_err(sql)?;
                    let index_building = !complete || missing || after.3;
                    let complete = !index_building && candidates.unchecked.is_empty() && after.2;
                    let subject_paths = {
                        let mut stmt = c
                            .prepare_cached(
                                "SELECT path FROM path_aliases
                                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                            )
                            .map_err(sql)?;
                        stmt.query_map(params![ws, version, object], |r| r.get::<_, String>(0))
                            .map_err(sql)?
                            .collect::<Result<std::collections::HashSet<_>, _>>()
                            .map_err(sql)?
                    };
                    let mut sources: Vec<_> = candidates
                        .sources
                        .into_iter()
                        .filter(|(source, _)| source != &object)
                        .map(|(object, path)| (path, Some(object)))
                        .chain(candidates.unchecked.into_iter().map(|path| (path, None)))
                        .filter(|(path, _)| {
                            path > &after.0 || (path == &after.0 && after.1 != usize::MAX)
                        })
                        .filter(|(path, _)| !subject_paths.contains(path))
                        .collect();
                    sources.sort_by(|a, b| a.0.cmp(&b.0));
                    let more = sources.len() > 100;
                    let mut prepared = Vec::new();
                    for (path, object) in sources.into_iter().take(100) {
                        let source = object
                            .map(|object| incoming::read_source(c, &ws, &version, &object))
                            .transpose()?
                            .flatten();
                        prepared.push((path, source));
                    }
                    let resolver = cache::prepare(c, &cache, &ws, &version)?;
                    snapshot.commit().map_err(sql)?;
                    Ok::<_, StorageError>(Some((
                        version.clone(),
                        object.clone(),
                        target.clone(),
                        after.clone(),
                        resolver,
                        prepared,
                        complete,
                        index_building,
                        more,
                    )))
                }).map_err(RuntimeError::from)
            })
            .await?;
        let Some((version, object, target, after, paths, sources, complete, index_building, more)) =
            prepared
        else {
            return Ok(Value::Null);
        };
        tokio::task::spawn_blocking(move || {
            let resolver = paths.build();
            let mut page = json!({
                "versionId":version,"subject":{"objectId":object,"path":target},
                "entries":[],"unchecked":[],"complete":complete,"indexBuilding":index_building,
                "mountsCovered":true,"nextCursor":null
            });
            // Reserve one maximum-length cursor; serialize each added row only once.
            let longest = sources
                .iter()
                .map(|(path, _)| path)
                .chain(std::iter::once(&after.0))
                .max_by_key(|path| json!(path).to_string().len())
                .expect("cursor path");
            let reserve = json!(encode_cursor(
                &workspace,
                &version,
                &object,
                &(longest.clone(), usize::MAX, false, false),
            )?)
            .to_string()
            .len();
            let mut bytes = page.to_string().len() + reserve + 1;
            let mut last = after.clone();
            let mut complete = complete;
            let mut examined = 0;
            let mut stopped = false;
            'sources: for (path, source) in sources {
                let parsed = source.map(incoming::Source::parse).transpose()?;
                if parsed.as_ref().is_none_or(|p| p.reason.is_some()) {
                    complete = false;
                    let row = json!(path);
                    let size = row.to_string().len() + 1;
                    if bytes + size > 64 * 1024 {
                        stopped = true;
                        break;
                    }
                    bytes += size;
                    page["unchecked"].as_array_mut().expect("array").push(row);
                    // An unchecked source is terminal, even if it was partially read on a prior page.
                    last = (path, usize::MAX, complete, index_building);
                    continue;
                }
                if let Some(parsed) = parsed {
                    for (ordinal, occurrence) in parsed.occurrences.iter().enumerate() {
                        if path == after.0 && ordinal <= after.1 {
                            continue;
                        }
                        if examined == 512
                            || page["entries"].as_array().expect("array").len() == 100
                        {
                            stopped = true;
                            break 'sources;
                        }
                        examined += 1;
                        if resolve(&resolver, &path, &occurrence.literal, occurrence.kind)
                            != Some(target.as_str())
                        {
                            last = (path.clone(), ordinal, complete, index_building);
                            continue;
                        }
                        let entry = json!({
                            "source":path,"title":parsed.title,"ordinal":ordinal,
                            "span":[occurrence.start_utf16,occurrence.end_utf16],
                            "line":occurrence.line,"snippet":occurrence.snippet,
                            "highlightStart":occurrence.highlight_start,
                            "highlightEnd":occurrence.highlight_end
                        });
                        let size = entry.to_string().len() + 1;
                        if bytes + size > 64 * 1024 {
                            stopped = true;
                            break 'sources;
                        }
                        bytes += size;
                        page["entries"].as_array_mut().expect("array").push(entry);
                        last = (path.clone(), ordinal, complete, index_building);
                    }
                }
                last = (path, usize::MAX, complete, index_building);
            }
            page["complete"] = json!(complete);
            last.2 = complete;
            last.3 = index_building;
            page["nextCursor"] = if stopped || more {
                json!(encode_cursor(&workspace, &version, &object, &last)?)
            } else {
                Value::Null
            };
            if page.to_string().len() > 64 * 1024 {
                return Err(invalid());
            }
            Ok(page)
        })
        .await
        .map_err(|_| invalid())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_decryption_is_bound_to_the_workspace() {
        let cursor =
            encode_cursor("ws", "main", "target", &("a.md".into(), 3, true, false)).unwrap();
        assert!(decode_cursor("other", "main", "target", Some(cursor)).is_err());
    }
}
