use super::*;
use dohc_engine_collab::reader_resolver::{self, PreparedFold};
use dohc_engine_files::materialize::{PublicationTarget, read_publication_target};
use rusqlite::OptionalExtension;
use std::sync::atomic::Ordering;

pub(super) fn stale() -> RuntimeError {
    dohc_engine_sync::SyncError::RetryableState {
        reason: "outside-fold-stale",
    }
    .into()
}

pub(super) fn is_stale<T>(result: &Result<T, RuntimeError>) -> bool {
    matches!(
        result,
        Err(RuntimeError::Sync(
            dohc_engine_sync::SyncError::RetryableState {
                reason: "outside-fold-stale"
            }
        ))
    )
}

pub(super) fn file_matches(root: &std::path::Path, input: &CaptureIngest) -> bool {
    matches!(read_publication_target(root, &input.path), Ok(PublicationTarget::Bytes(bytes))
        if bytes == input.text.as_bytes())
}

pub(super) fn indexing(
    indexing: CaptureIndexing,
    root: PathBuf,
    folds: Arc<Vec<PreparedFold>>,
) -> CaptureIndexing {
    if folds.is_empty() {
        indexing
    } else {
        CaptureIndexing::Reader {
            indexing: Box::new(indexing),
            root,
            folds,
        }
    }
}

// Admit only a subset whose native and editor readings agree. Everything uncertain
// uses the reader; Strict remains the only Markdown parse on the native path.
fn needs_reader(source: &str) -> bool {
    if source.ends_with('\r') {
        return true;
    }
    let mut fenced = false;
    let mut list = false;
    let mut list_gap = false;
    for line in source.as_bytes().split(|byte| *byte == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.starts_with(b"```") {
            if line == b"```" {
                fenced = !fenced;
            } else if !fenced
                && line[3..].iter().all(u8::is_ascii_alphanumeric)
                && !line[3..].is_empty()
            {
                fenced = true;
            } else {
                return true;
            }
            list = false;
            continue;
        }
        if fenced {
            if line.contains(&b'\r') {
                return true;
            }
            continue;
        }
        if line.is_empty() {
            list_gap |= list;
            list = false;
            continue;
        }
        // Indentation includes item bodies and quote overflow. A continuation
        // after a flat item can also be an item body without any indentation.
        if line[0].is_ascii_whitespace() || line.ends_with(b"  ") {
            return true;
        }
        let mut digits = 0;
        let mut item = line.starts_with(b"- ") || line.starts_with(b"+ ");
        for (index, byte) in line.iter().enumerate() {
            if index == digits && byte.is_ascii_digit() {
                digits += 1;
            }
            if index == digits && matches!(byte, b'.' | b')') {
                item = line.get(index + 1) == Some(&b' ');
            }
            // marked's inline grammar plus dohc's wikilinks, atoms, highlight,
            // math and table metadata. Backticks here are inline, not fenced.
            if matches!(
                byte,
                b'*' | b'_'
                    | b'['
                    | b'<'
                    | b'>'
                    | b'~'
                    | b'\\'
                    | b'&'
                    | b':'
                    | b'@'
                    | b'='
                    | b'$'
                    | b'{'
                    | b'|'
                    | b'`'
                    | b'\0'..=b'\x1f'
            ) || (*byte == b'.'
                && index >= 3
                && line[index - 3..index].eq_ignore_ascii_case(b"www"))
                || (*byte == 0xee || *byte == 0xef)
            {
                return true;
            }
        }
        if item
            && line
                .get(if digits == 0 { 2 } else { digits + 2 })
                .is_none_or(|byte| matches!(byte, b' ' | b'#' | b'-' | b'+' | b'0'..=b'9'))
        {
            return true;
        }
        if list && !item || list_gap && item || matches!(line, b"---" | b"-" | b"+") {
            return true;
        }
        list = item;
        list_gap = false;
    }
    fenced
}

fn eligible(inputs: &[CaptureIngest]) -> Vec<CaptureIngest> {
    inputs
        .iter()
        .filter(|input| {
            input.path.rsplit_once('.').is_some_and(|(_, extension)| {
                ["md", "markdown", "mdx"]
                    .iter()
                    .any(|kind| extension.eq_ignore_ascii_case(kind))
            }) && input.text.len() <= reader_resolver::MAX_FOLD_SOURCE_BYTES
                && needs_reader(&input.text)
        })
        .cloned()
        .collect()
}

pub(super) async fn prepare(
    actor: &ActorHandle,
    inputs: Arc<[CaptureIngest]>,
    root: &std::path::Path,
    deadline: &mut Option<std::time::Instant>,
) -> Arc<Vec<PreparedFold>> {
    if !actor.reader_configured.load(Ordering::Acquire) {
        return Arc::new(Vec::new());
    }
    prepare_eligible(actor, eligible(&inputs), root, deadline).await
}

async fn prepare_eligible(
    actor: &ActorHandle,
    eligible: Vec<CaptureIngest>,
    root: &std::path::Path,
    deadline: &mut Option<std::time::Instant>,
) -> Arc<Vec<PreparedFold>> {
    if eligible.is_empty() {
        return Arc::new(Vec::new());
    }
    let deadline = *deadline
        .get_or_insert_with(|| std::time::Instant::now() + std::time::Duration::from_secs(5));
    let Ok((resolver, preparations)) = actor.run(move |store, cache| {
        let resolver = cache.reader_resolver.clone();
        let mut preparations = Vec::new();
        if resolver.is_some() {
            for input in eligible {
                let preparation = store.read_with(|conn| {
                    let version = capture_file_holds::hold_in(conn, &input.workspace_id, &input.path)?
                        .map_or(input.version_id.clone(), |hold| hold.source_version_id);
                    let object: Option<(String, String)> = conn.query_row(
                        "SELECT object_id,blob_sha256 FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND path=?3",
                        params![input.workspace_id, version, input.path], |row| Ok((row.get(0)?, row.get(1)?)))
                        .optional().map_err(StorageError::corrupt_public)?;
                    let Some((object, sha)) = object else { return Ok::<_, RuntimeError>(None) };
                    if sha == dohc_engine_storage::hex_sha256(input.text.as_bytes()) { return Ok(None); }
                    let key = DocKey::new(&input.workspace_id, version, object)?;
                    Ok(reader_resolver::prepare_fold(conn, &key, &input.path, &input.text)?)
                }).ok().flatten();
                if let Some(preparation) = preparation { preparations.push((preparation, input)); }
            }
        }
        Ok((resolver, preparations))
    }).await else { return Arc::new(Vec::new()); };
    let mut folds = Vec::new();
    if let Some(resolver) = resolver {
        for (preparation, input) in preparations {
            if !file_matches(root, &input) {
                continue;
            }
            let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) else {
                break;
            };
            let Ok(fold) = tokio::time::timeout(remaining, preparation.construct(&resolver)).await
            else {
                break;
            };
            if let Some(fold) = fold {
                folds.push(fold);
            }
        }
    }
    #[cfg(test)]
    let _ = tests::after_prepare(actor, root).await;
    Arc::new(folds)
}

pub(super) fn prepare_blocking(
    actor: &ActorHandle,
    inputs: Arc<[CaptureIngest]>,
    root: &std::path::Path,
    deadline: &mut Option<std::time::Instant>,
) -> Arc<Vec<PreparedFold>> {
    if !actor.reader_configured.load(Ordering::Acquire) {
        return Arc::new(Vec::new());
    }
    let eligible = eligible(&inputs);
    if eligible.is_empty() {
        return Arc::new(Vec::new());
    }
    // The capture worker is outside Tokio. The actor's writer never enters this runtime.
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
    else {
        return Arc::new(Vec::new());
    };
    runtime.block_on(prepare_eligible(actor, eligible, root, deadline))
}

#[cfg(test)]
#[path = "capture_reader_tests.rs"]
mod tests;
