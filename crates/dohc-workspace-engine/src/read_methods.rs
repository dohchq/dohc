//! Requests the supervisor answers at their deadline or cancel (#3318). Each handler
//! here only reads its workspace's store. A read left off this list still
//! answers, only after its workspace's actor turns. A write on it would answer
//! before its work lands, so list a method only after reading its handler.

const READS: &[&str] = &[
    "conflicts.list",
    "moments.get",
    "moments.list",
    "sync.ordinary.publicationState",
    "versionedText.list",
    "versions.active",
    "versions.compareFiles",
    "versions.list",
];

pub(crate) fn reads_only(method: &str) -> bool {
    READS.contains(&method)
}

#[cfg(test)]
mod tests {
    use crate::EngineService;
    use dohc_engine_protocol::error::ErrorCode;
    use dohc_engine_protocol::transport::{EngineService as _, RequestContext};
    use dohc_engine_protocol::wire::Request;
    use serde_json::json;

    #[tokio::test]
    async fn every_listed_read_is_a_registered_method() {
        let service = EngineService::new();
        for method in super::READS {
            let request = Request {
                id: 1,
                method: (*method).to_owned(),
                workspace: None,
                deadline_ms: None,
                idempotency_key: None,
                progress: false,
                params: json!({}),
            };
            assert!(service.reads_only(&request), "{method}");
            let answer = service.call(RequestContext::unbounded(), request).await;
            assert!(
                answer
                    .err()
                    .is_none_or(|error| error.code != ErrorCode::MethodNotFound),
                "{method} is not in dispatch"
            );
        }
        let write = Request {
            id: 2,
            method: "versions.setActive".to_owned(),
            workspace: None,
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
            params: json!({}),
        };
        assert!(!service.reads_only(&write));
    }
}
