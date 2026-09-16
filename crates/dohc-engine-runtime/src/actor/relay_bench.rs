use super::*;

#[test]
#[ignore = "manual deferred relay benchmark; run alone with --ignored --nocapture"]
fn deferred_large_blob_batch_benchmark() {
    for body_bytes in [256 * 1024, 1024 * 1024] {
        let mut elapsed_ns = Vec::new();
        let mut moved_bodies = 0;
        for sample in 0..=100 {
            let transport = DeferredRelayTransport::default();
            let request = BlobDownloadBatchRequest {
                workspace_id: "workspace".to_owned(),
                replication_epoch: "epoch".to_owned(),
                stream_identity: "stream".to_owned(),
                blobs: (0..MAX_BLOB_DOWNLOAD_BATCH)
                    .map(|index| dohc_engine_sync::BlobDownloadSpec {
                        sha256: format!("{index:064x}"),
                        limit_bytes: body_bytes,
                    })
                    .collect(),
            };
            let response = BlobDownloadBatchResponse {
                results: (0..MAX_BLOB_DOWNLOAD_BATCH)
                    .map(|index| {
                        Ok(BlobDownloadResponse {
                            bytes: vec![u8::try_from(index).expect("byte"); body_bytes],
                        })
                    })
                    .collect(),
            };
            let original_pointers = response
                .results
                .iter()
                .map(|result| result.as_ref().expect("body").bytes.as_ptr())
                .collect::<Vec<_>>();
            transport.complete(
                RelayIoRequest::DownloadBlobs(request.clone()),
                Ok(RelayIoResponse::DownloadBlobs(response)),
            );

            let started = std::time::Instant::now();
            let received = transport.download_blobs(request).expect("completed batch");
            let elapsed = started.elapsed().as_nanos();

            for (index, (result, original)) in
                received.results.iter().zip(original_pointers).enumerate()
            {
                let bytes = &result.as_ref().expect("body").bytes;
                assert_eq!(bytes.len(), body_bytes);
                assert!(
                    bytes
                        .iter()
                        .all(|byte| *byte == u8::try_from(index).expect("byte"))
                );
                if sample > 0 && bytes.as_ptr() == original {
                    moved_bodies += 1;
                }
            }
            assert!(transport.state.lock().expect("state").completed.is_empty());
            if sample > 0 {
                elapsed_ns.push(elapsed);
            }
        }
        let mut sorted = elapsed_ns.clone();
        sorted.sort_unstable();
        println!(
            "{}",
            serde_json::json!({
                "benchmark": "deferred_large_blob_batch",
                "batch_bodies": MAX_BLOB_DOWNLOAD_BATCH,
                "body_bytes": body_bytes,
                "samples_ns": elapsed_ns,
                "median_ns": sorted[sorted.len() / 2],
                "p95_ns": sorted[(sorted.len() * 95).div_ceil(100) - 1],
                "moved_bodies": moved_bodies,
                "consumed_bodies": MAX_BLOB_DOWNLOAD_BATCH * 100,
            })
        );
    }
}
