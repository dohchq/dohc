mod common;

#[path = "busy_retry.rs"]
mod busy_retry;
#[path = "capture_differential.rs"]
mod capture_differential;
#[path = "capture_driver.rs"]
mod capture_driver;
#[path = "capture_file_holds.rs"]
mod capture_file_holds;
#[path = "configured_live_host.rs"]
mod configured_live_host;
#[path = "history_metadata_page.rs"]
mod history_metadata_page;
#[path = "history_object_page.rs"]
mod history_object_page;
#[path = "history_operations_round2.rs"]
mod history_operations_round2;
#[path = "history_operations_round3.rs"]
mod history_operations_round3;
#[path = "history_page_benchmark.rs"]
mod history_page_benchmark;
#[path = "history_sync_page.rs"]
mod history_sync_page;
#[path = "open_close_interruption.rs"]
mod open_close_interruption;
#[path = "public_collection_recovery.rs"]
mod public_collection_recovery;
#[path = "replica_mode.rs"]
mod replica_mode;
#[path = "rpc_authorship.rs"]
mod rpc_authorship;
#[path = "rpc_automations.rs"]
mod rpc_automations;
#[path = "rpc_capture_hold.rs"]
mod rpc_capture_hold;
#[path = "rpc_chats.rs"]
mod rpc_chats;
#[path = "rpc_collections.rs"]
mod rpc_collections;
#[path = "rpc_conflicts.rs"]
mod rpc_conflicts;
#[path = "rpc_files_replace.rs"]
mod rpc_files_replace;
#[path = "rpc_hosted.rs"]
mod rpc_hosted;
#[path = "rpc_live_changes.rs"]
mod rpc_live_changes;
#[path = "rpc_read_attach.rs"]
mod rpc_read_attach;
#[path = "rpc_read_surface.rs"]
mod rpc_read_surface;
#[path = "rpc_received_ydoc.rs"]
mod rpc_received_ydoc;
#[path = "rpc_relay.rs"]
mod rpc_relay;
#[path = "rpc_search_page.rs"]
mod rpc_search_page;
#[path = "rpc_source_capture.rs"]
mod rpc_source_capture;
#[path = "rpc_switch_barriers.rs"]
mod rpc_switch_barriers;
#[path = "rpc_version_switch_materialization.rs"]
mod rpc_version_switch_materialization;
#[path = "rpc_write_surface.rs"]
mod rpc_write_surface;
#[path = "rpc_ydoc.rs"]
mod rpc_ydoc;
#[path = "shadow_replay.rs"]
mod shadow_replay;
#[path = "ydoc_replay_parity.rs"]
mod ydoc_replay_parity;
