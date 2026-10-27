use crate::{CollabError, DocKey, Ydoc};
use dohc_engine_reader::{CheckMarkdownWitness, Failure, Outcome, Reader};
use std::{collections::VecDeque, sync::{Arc, Mutex}};
use tokio::sync::OnceCell;

pub use crate::ydoc::MarkdownWriteSafety;

#[derive(Debug, Clone)]
pub enum PendingPreparation {
    Reader(Arc<crate::reader_resolver::PendingProof>),
    Witness(Arc<PendingWitnessCheck>),
}

impl PendingPreparation {
    pub async fn resolve(&self) {
        match self {
            Self::Reader(pending) => pending.resolve().await,
            Self::Witness(pending) => pending.resolve().await,
        }
    }
}

pub struct PendingWitnessCheck {
    reader: Arc<Reader>,
    request: CheckMarkdownWitness,
    result: OnceCell<Result<(String, bool), Failure>>,
}

impl std::fmt::Debug for PendingWitnessCheck {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PendingWitnessCheck")
    }
}

impl PendingWitnessCheck {
    pub async fn resolve(&self) {
        self.result.get_or_init(|| async {
            match self.reader.check_markdown_witness(self.request.clone()).await? {
                Outcome::WitnessChecked { source_sha256, projection_sha256,
                    checker_identity, keeps_meaning }
                    if source_sha256 == self.request.source_sha256
                        && projection_sha256 == self.request.projection_sha256
                        && self.reader.checker_identity().as_ref() == Some(&checker_identity) =>
                    Ok((checker_identity, keeps_meaning)),
                _ => Err(Failure::Unavailable),
            }
        }).await;
    }
}

#[derive(Default)]
pub(crate) struct WitnessChecks(Mutex<VecDeque<Arc<PendingWitnessCheck>>>);

impl WitnessChecks {
    pub(crate) fn check(&self, reader: &Arc<Reader>, doc: &Ydoc, key: &DocKey, path: &str)
        -> Result<bool, CollabError>
    {
        if !doc.has_markdown_witness() {
            return Ok(true);
        }
        let Some(reference) = doc.markdown_source_reference() else { return Ok(false); };
        let Some(source) = doc.markdown_source(&reference) else { return Ok(false); };
        if source.len() > 2 * 1024 * 1024 { return Ok(false); }
        let mut entries = self.0.lock().unwrap();
        let identity = reader.checker_identity();
        if let Some(index) = entries.iter().position(|entry| {
            entry.request.source_sha256 == reference.source_sha256
                && entry.request.projection_sha256 == reference.projection_sha256
        }) {
            let entry = entries.remove(index).unwrap();
            match entry.result.get() {
                Some(Ok((build, safe))) if identity.as_ref() == Some(build) => {
                    let safe = *safe;
                    entries.push_back(entry);
                    return Ok(safe);
                }
                Some(Err(_)) => {
                    return Err(CollabError::MarkdownReaderUnavailable);
                }
                None => {
                    entries.push_back(entry.clone());
                    return Err(CollabError::MarkdownWitnessCheckPending {
                        key: key.clone(), path: path.to_owned(), pending: entry,
                    });
                }
                _ => {}
            }
        }
        while entries.len() >= 16 {
            let Some(index) = entries.iter().position(|entry| Arc::strong_count(entry) == 1) else {
                return Err(CollabError::MarkdownReaderUnavailable);
            };
            entries.remove(index);
        }
        let pending = Arc::new(PendingWitnessCheck {
            reader: reader.clone(),
            request: CheckMarkdownWitness {
                source: source.into_bytes(), source_sha256: reference.source_sha256,
                projection_sha256: reference.projection_sha256,
            },
            result: OnceCell::new(),
        });
        entries.push_back(pending.clone());
        Err(CollabError::MarkdownWitnessCheckPending {
            key: key.clone(), path: path.to_owned(), pending,
        })
    }
}

pub fn check_witness(doc: &Ydoc, key: &DocKey, path: &str,
    resolver: Option<&crate::reader_resolver::ReaderResolver>) -> Result<bool, CollabError>
{
    if !doc.has_markdown_witness() { return Ok(true); }
    if doc.markdown_source_reference().and_then(|reference| doc.markdown_source(&reference)).is_none() {
        return Ok(false);
    }
    resolver.ok_or(CollabError::MarkdownReaderUnavailable)?.check_witness(doc, key, path)
}

pub fn holds(safety: &MarkdownWriteSafety, witness_source_sha256: Option<&str>,
    head_sha256: Option<&str>) -> bool
{
    *safety == MarkdownWriteSafety::UnsafeWitness
        && (head_sha256.is_none() || head_sha256 == witness_source_sha256)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsafe_witness_holds_only_an_absent_or_matching_head() {
        let unsafe_witness = MarkdownWriteSafety::UnsafeWitness;
        assert!(holds(&unsafe_witness, Some("source"), None));
        assert!(holds(&unsafe_witness, Some("source"), Some("source")));
        assert!(!holds(&unsafe_witness, Some("source"), Some("converted")));
        for safety in [MarkdownWriteSafety::NotMarkdown, MarkdownWriteSafety::SafeWitness,
            MarkdownWriteSafety::SourcePreserving] {
            assert!(!holds(&safety, Some("source"), None));
            assert!(!holds(&safety, Some("source"), Some("source")));
        }
    }

    #[test]
    fn absent_witness_needs_no_checker_but_a_partial_witness_is_unsafe() {
        use yrs::{Map, ReadTxn, Transact};
        let key = DocKey::new("w", "main", "object").unwrap();
        let doc = Ydoc::wire();
        assert!(check_witness(&doc, &key, "note.md", None).unwrap());
        let wire = yrs::Doc::new();
        wire.get_or_insert_map("meta").insert(&mut wire.transact_mut(), "dohcMarkdownSource", "partial");
        doc.apply(&wire.transact().encode_state_as_update_v1(&yrs::StateVector::default())).unwrap();
        assert!(!check_witness(&doc, &key, "note.md", None).unwrap());
        assert!(doc.has_markdown_witness());
    }

    #[tokio::test]
    async fn checker_failure_never_grants_safety() {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_preserving_source(crate::ContentKind::Richdoc, "plain").unwrap();
        let key = DocKey::new("w", "main", "object").unwrap();
        let resolver = crate::reader_resolver::ReaderResolver::new(Arc::new(Reader::new(None)));
        let Err(CollabError::MarkdownWitnessCheckPending { pending, .. }) =
            check_witness(&doc, &key, "note.md", Some(&resolver)) else { panic!("expected preparation"); };
        pending.resolve().await;
        assert!(matches!(check_witness(&doc, &key, "note.md", Some(&resolver)),
            Err(CollabError::MarkdownReaderUnavailable)));
    }
}
