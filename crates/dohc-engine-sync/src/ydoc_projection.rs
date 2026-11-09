use dohc_engine_collab::{CollabError, ContentKind};

/// Why [`project_ydoc_updates`] derived no file. Each message names the input
/// or the limit that refused it.
#[derive(Debug, thiserror::Error)]
pub enum UpdateProjectionError {
    /// The updates, or the document they build, cannot be projected.
    #[error("{0}")]
    Invalid(&'static str),
    /// The document is past a projection budget or the live-editing limit.
    #[error("{0}")]
    TooLarge(String),
}

/// Project the validated source or canonical content without a file snapshot.
pub fn project_ydoc_updates<'a>(
    updates: impl IntoIterator<Item = &'a [u8]>,
    content_kind: ContentKind,
) -> Result<dohc_engine_collab::Projection, UpdateProjectionError> {
    use UpdateProjectionError::{Invalid, TooLarge};
    if content_kind == ContentKind::Scene {
        return Err(Invalid(
            "a scene projection reads its images from the workspace store",
        ));
    }
    let doc = dohc_engine_collab::Ydoc::wire();
    let mut empty = true;
    let mut bytes = 0usize;
    let mut count = 0usize;
    for update in updates {
        count += 1;
        bytes = bytes.saturating_add(update.len());
        if count > 16_384 || bytes > dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES {
            return Err(TooLarge(
                "updates exceed the count or MAX_YDOC_UPDATE_BYTES budget".to_owned(),
            ));
        }
        doc.apply(update)
            .map_err(|_| Invalid("a ydoc update is malformed"))?;
        empty = false;
    }
    if empty {
        return Err(Invalid("there are no ydoc updates to project"));
    }
    if doc.has_pending_dependencies() {
        return Err(Invalid("the ydoc updates are missing a dependency"));
    }
    let mut projection = doc
        .project(content_kind)
        .map_err(|error| match error {
            CollabError::ProjectionTooLarge { max, .. } => TooLarge(format!(
                "the projection exceeds MAX_PROJECTION_BYTES ({max} bytes)"
            )),
            CollabError::ProjectionTooComplex {
                max_depth,
                max_nodes,
            } => TooLarge(format!(
                "the document nests deeper than MAX_PROJECTION_DEPTH ({max_depth}) or holds more than MAX_PROJECTION_NODES ({max_nodes}) nodes"
            )),
            _ => Invalid("the ydoc projection is invalid"),
        })?;
    if content_kind == ContentKind::Richdoc && doc.has_reader_source() {
        return Err(Invalid(
            "Markdown reader output requires an authoritative snapshot",
        ));
    }
    if content_kind == ContentKind::Richdoc
        && let Some(source) = doc.preserved_markdown_source(&projection.content)
    {
        projection.content = source;
        projection.markdown_write_safety =
            dohc_engine_collab::ydoc::MarkdownWriteSafety::SourcePreserving;
    }
    let limit = dohc_engine_collab::limits::MAX_PUBLIC_MARKDOWN_BYTES;
    if projection.content.len() > limit {
        return Err(TooLarge(format!(
            "the file is {} bytes, above MAX_PUBLIC_MARKDOWN_BYTES ({limit} bytes), the live-editing limit",
            projection.content.len()
        )));
    }
    Ok(projection)
}
