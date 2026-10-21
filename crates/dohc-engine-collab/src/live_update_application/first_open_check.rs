//! The engine's check of a first live version the relay built for an
//! ordinary Markdown file, before the relay publishes it. It reads no store
//! and leaves nothing behind: no files, blobs, lineage, session, or rows.

use crate::limits::{MAX_PUBLIC_MARKDOWN_BYTES, MAX_YDOC_UPDATE_BYTES};
use crate::{ContentKind, Ydoc};
use dohc_engine_storage::hex_sha256;

/// The candidate bytes and the ordinary file they must settle to, as the
/// relay declared them. The relay's maximum full-state encoding bounds the
/// measurement.
pub struct FirstOpenCandidate<'a> {
    pub candidate: &'a [u8],
    pub candidate_sha256: &'a str,
    pub source: &'a [u8],
    pub source_sha256: &'a str,
    pub max_full_state_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FirstOpenCandidateVerdict {
    Checked(FirstOpenCandidateEvidence),
    Refused(FirstOpenCandidateRefusal),
    /// The full-state encoding did not finish within this many bytes.
    TooLarge {
        limit: usize,
    },
}

/// What a checked candidate settles to and its full state as encoded
/// during this check. Later encodings need not repeat these bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirstOpenCandidateEvidence {
    pub settled_source_sha256: String,
    pub settled_source_byte_length: usize,
    pub full_state_sha256: String,
    pub full_state_byte_length: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstOpenCandidateRefusal {
    /// The bytes are not one Yjs v1 update.
    MalformedCandidate,
    /// The update depends on structs or deletions it does not carry.
    IncompleteCandidate,
    /// Its roots or metadata break the public live-document schema.
    InvalidPublicBaseline,
    /// The engine cannot project it as a rich document.
    ProjectionFailed,
    /// It does not settle to the file's exact bytes.
    SettlementMismatch,
}

impl FirstOpenCandidateRefusal {
    /// The stable wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MalformedCandidate => "malformed-candidate",
            Self::IncompleteCandidate => "incomplete-candidate",
            Self::InvalidPublicBaseline => "invalid-public-baseline",
            Self::ProjectionFailed => "projection-failed",
            Self::SettlementMismatch => "settlement-mismatch",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum FirstOpenCheckError {
    #[error("first-open candidate bounds are outside the engine's limits")]
    InvalidBounds,
    #[error("first-open candidate input does not match its declared digest or encoding")]
    Integrity,
    #[error("first-open candidate check was stopped")]
    Stopped,
}

/// Decode the exact candidate on a fresh document, require complete state and
/// the public baseline schema, settle it as imported activation does with the
/// file as its snapshot, require the file's exact bytes, and measure its full
/// state up to the relay's bound. `stopped` is polled between steps and
/// between settlement's readings of the source.
pub fn check_first_open_candidate(
    input: FirstOpenCandidate<'_>,
    stopped: &dyn Fn() -> bool,
) -> Result<FirstOpenCandidateVerdict, FirstOpenCheckError> {
    let proceed = || {
        if stopped() {
            Err(FirstOpenCheckError::Stopped)
        } else {
            Ok(())
        }
    };
    let refused = |cause| Ok(FirstOpenCandidateVerdict::Refused(cause));
    if !(2..=MAX_YDOC_UPDATE_BYTES).contains(&input.candidate.len())
        || input.source.len() > MAX_PUBLIC_MARKDOWN_BYTES
        || !(2..=MAX_YDOC_UPDATE_BYTES).contains(&input.max_full_state_bytes)
    {
        return Err(FirstOpenCheckError::InvalidBounds);
    }
    proceed()?;
    if hex_sha256(input.candidate) != input.candidate_sha256
        || hex_sha256(input.source) != input.source_sha256
    {
        return Err(FirstOpenCheckError::Integrity);
    }
    let source = std::str::from_utf8(input.source).map_err(|_| FirstOpenCheckError::Integrity)?;
    proceed()?;
    let doc = Ydoc::wire();
    if doc.apply(input.candidate).is_err() {
        return refused(FirstOpenCandidateRefusal::MalformedCandidate);
    }
    proceed()?;
    if doc.has_missing_updates() {
        return refused(FirstOpenCandidateRefusal::IncompleteCandidate);
    }
    if doc.validate_public_baseline(input.candidate).is_err() {
        return refused(FirstOpenCandidateRefusal::InvalidPublicBaseline);
    }
    proceed()?;
    let Ok(projection) = doc.project(ContentKind::Richdoc) else {
        return refused(FirstOpenCandidateRefusal::ProjectionFailed);
    };
    let projection = projection.content;
    proceed()?;
    let settled = doc
        .settled_markdown_source_cancellable(
            &projection,
            || Ok(Some(source.to_owned())),
            &mut || proceed(),
        )?
        .unwrap_or(projection);
    proceed()?;
    if settled.as_bytes() != input.source {
        return refused(FirstOpenCandidateRefusal::SettlementMismatch);
    }
    let Some(full_state) = doc.encode_full_state_bounded(input.max_full_state_bytes) else {
        return Ok(FirstOpenCandidateVerdict::TooLarge {
            limit: input.max_full_state_bytes,
        });
    };
    proceed()?;
    Ok(FirstOpenCandidateVerdict::Checked(
        FirstOpenCandidateEvidence {
            settled_source_sha256: hex_sha256(settled.as_bytes()),
            settled_source_byte_length: settled.len(),
            full_state_sha256: hex_sha256(&full_state),
            full_state_byte_length: full_state.len(),
        },
    ))
}

#[cfg(test)]
#[path = "first_open_check_tests.rs"]
mod tests;
