mod support;

#[path = "author_coverage_regressions.rs"]
mod author_coverage_regressions;
#[path = "authored_publication.rs"]
mod authored_publication;
#[path = "automation_claims.rs"]
mod automation_claims;
#[path = "binary_delete_cancel_scope.rs"]
mod binary_delete_cancel_scope;
#[path = "binary_head_fts_exclusion.rs"]
mod binary_head_fts_exclusion;
#[path = "binary_materialize_retry.rs"]
mod binary_materialize_retry;
#[path = "binary_rollback_disk.rs"]
mod binary_rollback_disk;
#[path = "capture_actor.rs"]
mod capture_actor;
#[path = "capture_file_hold_placements.rs"]
mod capture_file_hold_placements;
#[path = "capture_recovery.rs"]
mod capture_recovery;
#[path = "chat_cancellation.rs"]
mod chat_cancellation;
#[path = "fts_mutation_paths.rs"]
mod fts_mutation_paths;
#[path = "fts_sync_and_conflict_paths.rs"]
mod fts_sync_and_conflict_paths;
#[path = "live_settlement.rs"]
mod live_settlement;
#[path = "live_update_application.rs"]
mod live_update_application;
#[path = "merge_case_alias.rs"]
mod merge_case_alias;
#[path = "merge_materialize_drain.rs"]
mod merge_materialize_drain;
#[path = "ordinary_materialization_retry.rs"]
mod ordinary_materialization_retry;
#[path = "outbound_drain.rs"]
mod outbound_drain;
#[path = "owner_publication.rs"]
mod owner_publication;
#[path = "reader_settlement.rs"]
mod reader_settlement;
#[path = "recovery_import.rs"]
mod recovery_import;
#[path = "relay_materialization.rs"]
mod relay_materialization;
#[path = "search.rs"]
mod search;
#[path = "search_performance.rs"]
mod search_performance;
#[path = "soak.rs"]
mod soak;
#[path = "switch_file_holds.rs"]
mod switch_file_holds;
#[path = "sync_refusal_notices.rs"]
mod sync_refusal_notices;
#[path = "unsettled_local_recovery.rs"]
mod unsettled_local_recovery;
#[path = "version_switch_ordering.rs"]
mod version_switch_ordering;
#[path = "ydoc_author_coverage.rs"]
mod ydoc_author_coverage;
#[path = "ydoc_base_conflict_freeze.rs"]
mod ydoc_base_conflict_freeze;
#[path = "ydoc_base_origination.rs"]
mod ydoc_base_origination;
#[path = "ydoc_drain_windows.rs"]
mod ydoc_drain_windows;
#[path = "ydoc_open_drain.rs"]
mod ydoc_open_drain;
#[path = "ydoc_open_unsettled.rs"]
mod ydoc_open_unsettled;
#[path = "ydoc_pristine_settlement.rs"]
mod ydoc_pristine_settlement;
#[path = "ydoc_record_reject.rs"]
mod ydoc_record_reject;
#[path = "ydoc_settle_rebind.rs"]
mod ydoc_settle_rebind;
#[path = "ydoc_successor_settlement.rs"]
mod ydoc_successor_settlement;
