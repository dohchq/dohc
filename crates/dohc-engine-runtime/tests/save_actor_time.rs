//! #1953 measurement, not a check. Saves a 4 KB, a 50 KB and a 1 MB document
//! 20 times each through the live-document settle. With
//! `DOHC_CAPTURE_PHASE_DIAGNOSTICS=1`, each settle prints one
//! `R16_CAPTURE_PHASE` line on stderr with the time the settle held the actor
//! and the `save_*` totals inside it.
//!
//! `cargo test -p dohc-engine-runtime --test save_actor_time -- --ignored --nocapture`

use dohc_engine_collab::{ContentKind, LeaseRegistry, Ydoc};
use dohc_engine_domain::{ChangeActorKind, ChangeAttribution};
use dohc_engine_runtime::{CancellationToken, CaptureIngest, WorkspaceSupervisor};
use dohc_engine_storage::NoFaults;
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::sync::Arc;

const WS: &str = "save-actor-time";
const PATH: &str = "note.md";
const SAVES: usize = 20;
// Seed in parts, below the size of one accepted live update.
const SEED_PART: usize = 256 * 1024;

fn text_of(bytes: usize) -> String {
    let line = "A line of ordinary note text, long enough to look like prose.\n";
    line.repeat(bytes / line.len() + 1)[..bytes].to_owned()
}

async fn measure(bytes: usize) {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("engine database path");
    let base = text_of(bytes);
    std::fs::write(scratch.path().join(PATH), &base).expect("base file");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    actor
        .capture_ingest(
            CaptureIngest {
                workspace_id: WS.into(),
                version_id: "main".into(),
                path: PATH.into(),
                text: base.clone(),
                metadata_origin: "capture".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1,
                request_id: None,
                claim_foreign_head: false,
            },
            LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture the base file");

    let opened = actor
        .ydoc_open_state(
            WS.into(),
            2,
            true,
            None,
            "main".into(),
            PATH.into(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("open the document");
    let doc = Ydoc::wire();
    doc.apply(&opened.initial_update).expect("load the initial state");
    let seed = opened.seed_content.clone().expect("the open seeds from the captured head");
    let mut at = 0u32;
    for part in seed.as_bytes().chunks(SEED_PART) {
        let part = std::str::from_utf8(part).expect("ASCII seed");
        let update = doc.plaintext_insert(at, part);
        at += part.encode_utf16().count() as u32;
        actor
            .ydoc_record_update(
                opened.key.clone(),
                PATH.into(),
                ContentKind::Plaintext,
                opened.regime,
                update,
                None,
                None,
                opened.lineage_claim_id.clone(),
                false,
                opened.owner_seed_source.clone(),
                None,
                3,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
            )
            .await
            .expect("record the seed");
    }

    let mut wall = Vec::with_capacity(SAVES);
    for save in 0..SAVES {
        let now_ms = 10 + 2 * save as i64;
        let end = doc.plaintext_string().encode_utf16().count() as u32;
        let update = doc.plaintext_insert(end, &format!("Typed line {save}.\n"));
        let append = actor
            .ydoc_record_update(
                opened.key.clone(),
                PATH.into(),
                ContentKind::Plaintext,
                opened.regime,
                update,
                Some("local-person".into()),
                Some(ChangeAttribution {
                    actor_kind: ChangeActorKind::Human,
                    on_behalf_of: None,
                    depth: 0,
                    run: None,
                }),
                opened.lineage_claim_id.clone(),
                false,
                None,
                None,
                now_ms,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
            )
            .await
            .expect("admit the typing");
        let began = std::time::Instant::now();
        actor
            .ydoc_settle(
                scratch.path().to_path_buf(),
                opened.key.clone(),
                PATH.into(),
                ContentKind::Plaintext,
                append.lineage_claim_id.clone(),
                opened.head_blob_sha256.clone(),
                WS.into(),
                Arc::new(()),
                now_ms + 1,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
                None,
            )
            .await
            .expect("settle the typing")
            .settled()
            .expect("the settle lands");
        wall.push(began.elapsed().as_micros() as u64);
    }
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(PATH)).expect("saved file"),
        doc.plaintext_string(),
        "every save reached the file"
    );
    eprintln!("SAVE_ACTOR_TIME {{\"bytes\":{bytes},\"settle_wall_us\":{wall:?}}}");
    supervisor.close(&db).expect("close actor");
}

#[ignore = "measurement for #1953; run with --ignored"]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn save_actor_time() {
    for bytes in [4 * 1024, 50 * 1024, 1024 * 1024] {
        measure(bytes).await;
    }
}
