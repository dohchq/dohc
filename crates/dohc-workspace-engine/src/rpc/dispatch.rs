use crate::EngineService;
use crate::capture_driver;
use crate::lock;
use crate::rpc::error::initial_capture_updating;
use crate::rpc::workspace::WorkspaceOpenMode;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::transport::ServiceResponse;
use dohc_engine_protocol::wire::Request;
use dohc_engine_protocol::wire::Response;
use dohc_engine_protocol::wire::WorkspaceHandle;
use serde_json::Value;
use serde_json::json;

fn method_requires_initial_capture_ready(method: &str) -> bool {
    (method.starts_with("sync.") && method != "sync.remoteChanges")
        || method.starts_with("share.")
        || method.starts_with("search.")
        || method.starts_with("collections.")
        || method.starts_with("liveApplication.")
        || method.starts_with("ydoc.ownerDelivery.")
        || (method.starts_with("versions.") && method != "versions.ensureMain")
        || method.starts_with("conflicts.")
        || (method.starts_with("secrets.") && method != "secrets.write")
        || matches!(
            method,
            "capture.reconcile"
                | "versionedText.list"
                | "versionedText.captureSources"
                | "versionedText.read"
                | "versionedText.readBlob"
                | "versionedText.compare"
                | "versionedText.rename"
                | "versionedText.checkMove"
                | "versionedText.delete"
                | "versionedText.rollback"
                | "versionedText.merge"
                | "versionedBinary.read"
                | "versionedBinary.readBlob"
                | "moments.list"
                | "moments.get"
                | "history.page"
        )
}

pub(super) fn initial_capture_phase_requires_fence(phase: capture_driver::CapturePhase) -> bool {
    matches!(
        phase,
        capture_driver::CapturePhase::Starting | capture_driver::CapturePhase::Importing
    )
}

/// Liveness probe. It takes no workspace, reads no store, and touches no
/// filesystem, so it can neither block nor fail. An answer therefore proves
/// the transport reader, the request supervisor, and the writer are all still
/// turning — which is the whole claim a client-side wedge detector needs.
/// It says nothing about any single workspace actor, which runs on its own
/// thread and can stall alone.
fn engine_ping() -> Value {
    json!({ "ok": true })
}

impl EngineService {
    fn ensure_configured_host_method(
        &self,
        ctx: &RequestContext,
        request: &Request,
    ) -> Result<(), WireError> {
        let method = request.method.as_str();
        if matches!(
            method,
            "sync.claim"
                | "sync.adoptJoinIdentity"
                | "sync.pull"
                | "sync.refusalDocuments"
                | "liveApplication.captureOwnerActivation"
                | "liveApplication.releaseOwnerActivation"
                | "liveApplication.ownerState"
                | "liveApplication.adoptOwner"
                | "ydoc.ownerOutbox.readPending"
                | "ydoc.ownerOutbox.acknowledge"
                | "sync.materializePendingCursor"
                | "sync.commitCursor"
                | "sync.push"
        ) && self.configured_ordinary_request(ctx, request)
        {
            return Ok(());
        }
        if self.configured_live_host.get().is_some()
            && !matches!(
                method,
                "liveApplication.hosts"
                    | "liveApplication.register"
                    | "liveApplication.bootstrap"
                    | "liveApplication.apply"
                    | "liveApplication.ack"
                    | "liveApplication.syncOpen"
                    | "liveApplication.appliedRead"
                    | "liveApplication.settle"
                    | "liveApplication.fenceRestore"
                    | "liveApplication.prepareRestore"
                    | "liveApplication.applyRestore"
                    | "liveApplication.settleRestore"
                    | "liveApplication.resumeRestore"
            )
        {
            return Err(WireError::new(
                ErrorCode::Forbidden,
                "configured host method is unavailable",
            ));
        }
        Ok(())
    }

    pub(crate) async fn dispatch_input(
        &self,
        ctx: RequestContext,
        request: Request,
        input: crate::LiveApplicationInput,
    ) -> Result<ServiceResponse, WireError> {
        self.ensure_configured_host_method(&ctx, &request)?;
        self.ensure_handle_allows_method(request.workspace.as_ref(), &request.method)?;
        self.require_initial_capture_ready(request.workspace.as_ref(), &request.method)?;
        match input {
            crate::LiveApplicationInput::Admitted(input) => {
                self.live_application_apply(ctx, request, *input).await
            }
            crate::LiveApplicationInput::Restore(input) => {
                self.live_application_restore(ctx, request, *input).await
            }
            crate::LiveApplicationInput::Owner(input) => {
                self.owner_delivery_apply(ctx, request, *input).await
            }
        }
    }

    pub(crate) async fn dispatch(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> Result<ServiceResponse, WireError> {
        let id = request.id;
        self.ensure_configured_host_method(&ctx, &request)?;
        self.ensure_handle_allows_method(request.workspace.as_ref(), &request.method)?;
        self.require_initial_capture_ready(request.workspace.as_ref(), &request.method)?;
        if request.method == "ydoc.ownerDelivery.prepareEnrollment" {
            return self.owner_delivery_prepare_enrollment(ctx, request).await;
        }
        if request.method == "ydoc.ownerDelivery.listDrafts" {
            return self.owner_delivery_list_drafts(ctx, request).await;
        }
        if request.method == "ydoc.ownerDelivery.openDraft" {
            return self.owner_delivery_open_draft(ctx, request).await;
        }
        if matches!(
            request.method.as_str(),
            "ydoc.ownerDelivery.readState" | "ydoc.ownerDelivery.isReceiptApplied"
        ) {
            return self.owner_delivery_read(ctx, request).await;
        }
        if request.method == "liveApplication.settle" {
            return self.live_application_settle(ctx, request).await;
        }
        if request.method == "liveApplication.appliedRead" {
            return self.live_application_applied_read(ctx, request).await;
        }
        if request.method == "liveApplication.ack" {
            return self.live_application_ack(ctx, request).await;
        }
        if request.method == "liveApplication.fenceRestore" {
            return self.live_application_fence_restore(ctx, request).await;
        }
        if request.method == "versionedBinary.readBlob" {
            let (result, blob_egress) = self
                .versioned_binary_read_blob(&ctx, request.workspace, request.params, id)
                .await?;
            return Ok(ServiceResponse {
                output_guard: None,
                response: Response { id, result },
                blob_egress,
            });
        }
        if request.method == "versionedText.readBlob" {
            let (result, blob_egress) = self
                .versioned_text_read_blob(&ctx, request.workspace, request.params, id)
                .await?;
            return Ok(ServiceResponse {
                output_guard: None,
                response: Response { id, result },
                blob_egress,
            });
        }
        if request.method == "liveApplication.captureOwnerActivation" {
            return self.capture_owner_activation(ctx, request).await;
        }
        if request.method == "liveApplication.releaseOwnerActivation" {
            return self.release_owner_activation(ctx, request).await;
        }
        if request.method == "ydoc.open" {
            let (result, blob_egress) = self
                .ydoc_open(&ctx, request.workspace, request.params, id)
                .await?;
            return Ok(ServiceResponse {
                output_guard: None,
                response: Response { id, result },
                blob_egress: Some(blob_egress),
            });
        }
        if request.method == "ydoc.resync" {
            let (result, blob_egress) = self
                .ydoc_resync(&ctx, request.workspace, request.params, id)
                .await?;
            return Ok(ServiceResponse {
                output_guard: None,
                response: Response { id, result },
                blob_egress: Some(blob_egress),
            });
        }
        if request.method == "collections.get" {
            let (result, blob_egress) = self
                .collections_get(&ctx, request.workspace, request.params, id)
                .await?;
            return Ok(ServiceResponse {
                output_guard: None,
                response: Response { id, result },
                blob_egress,
            });
        }
        if request.method == "collections.query" {
            let (result, blob_egress) = self
                .collections_query(&ctx, request.workspace, request.params, id)
                .await?;
            return Ok(ServiceResponse {
                output_guard: None,
                response: Response { id, result },
                blob_egress,
            });
        }
        if request.method == "collections.getRecord" {
            let (result, blob_egress) = self
                .collections_get_record(&ctx, request.workspace, request.params, id)
                .await?;
            return Ok(ServiceResponse {
                output_guard: None,
                response: Response { id, result },
                blob_egress,
            });
        }
        let result = match request.method.as_str() {
            "liveApplication.provisionOwner" => {
                self.ordinary_live_provision(&ctx, request.workspace, request.params)
                    .await?
            }
            "liveApplication.ownerState" => {
                self.live_owner_state(&ctx, request.workspace, request.params)
                    .await?
            }
            "liveApplication.hosts" => self.configured_live_hosts(&ctx, &request)?,
            "liveApplication.register" => {
                self.live_application_register(&ctx, request.workspace, request.params)
                    .await?
            }
            "engine.ping" => engine_ping(),
            "workspace.open" => self.workspace_open(&ctx, request.params).await?,
            "workspace.close" => self.workspace_close(request.workspace).await?,
            "sync.push" => {
                Box::pin(self.sync_push(&ctx, request.workspace, request.params)).await?
            }
            "sync.pull" => {
                Box::pin(self.sync_pull(&ctx, request.workspace, request.params)).await?
            }
            "sync.materializePendingCursor" => {
                Box::pin(self.sync_materialize_pending_cursor(
                    &ctx,
                    request.workspace,
                    request.params,
                ))
                .await?
            }
            "sync.commitCursor" => {
                Box::pin(self.sync_commit_cursor(&ctx, request.workspace, request.params)).await?
            }
            "sync.probe" => {
                Box::pin(self.sync_probe(&ctx, request.workspace, request.params)).await?
            }
            "sync.remoteChanges" => self.sync_remote_changes(&ctx, request.workspace).await?,
            "sync.refusalDocuments" => {
                self.sync_refusal_documents(&ctx, request.workspace, request.params)
                    .await?
            }
            "sync.claim" => {
                Box::pin(self.sync_claim(&ctx, request.workspace, request.params)).await?
            }
            "sync.adoptJoinIdentity" => {
                Box::pin(self.sync_adopt_join_identity(&ctx, request.workspace, request.params))
                    .await?
            }
            "sync.recoverOrigin" => {
                Box::pin(self.sync_recover_origin(&ctx, request.workspace, request.params)).await?
            }
            "keys.upload" => {
                Box::pin(self.keys_upload(&ctx, request.workspace, request.params)).await?
            }
            "keys.download" => {
                Box::pin(self.keys_download(&ctx, request.workspace, request.params)).await?
            }
            "share.channel.pull" => {
                Box::pin(self.share_channel_pull(&ctx, request.workspace, request.params)).await?
            }
            "share.channel.push" => {
                Box::pin(self.share_channel_push(&ctx, request.workspace, request.params)).await?
            }
            "share.view.pull" => {
                Box::pin(self.share_view_pull(&ctx, request.workspace, request.params)).await?
            }
            "share.view.recordIdentity" => {
                Box::pin(self.share_view_record_identity(&ctx, request.workspace, request.params))
                    .await?
            }
            "share.proposal.submit" => {
                Box::pin(self.share_proposal_submit(&ctx, request.workspace, request.params))
                    .await?
            }
            "share.direct.push" => {
                Box::pin(self.share_direct_push(&ctx, request.workspace, request.params)).await?
            }
            "versionedText.write" => {
                self.versioned_text_write(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedBinary.write" => {
                self.versioned_binary_write(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedBinary.writeBlob" => {
                self.versioned_binary_write_blob(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedText.rename" => {
                self.versioned_text_rename(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedText.checkMove" => {
                self.versioned_text_check_move(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedText.delete" => {
                self.versioned_text_delete(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedText.rollback" => {
                self.versioned_text_rollback(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedText.merge" => {
                self.versioned_text_merge(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedText.compare" => {
                self.versioned_text_compare(&ctx, request.workspace, request.params)
                    .await?
            }
            "versions.compareFiles" => {
                self.versions_compare_files(&ctx, request.workspace, request.params)
                    .await?
            }
            "versions.createNamed" => {
                self.versions_create_named(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedText.read" => {
                self.versioned_text_read(&ctx, request.workspace, request.params)
                    .await?
            }
            "ydoc.recordUpdate" => {
                self.ydoc_record_update(
                    &ctx,
                    request.workspace,
                    request.idempotency_key.clone(),
                    request.params.clone(),
                )
                .await?
            }
            "ydoc.ownerOutbox.append" => {
                self.owner_ydoc_outbox_append(&ctx, request.workspace, request.params)
                    .await?
            }
            "ydoc.ownerOutbox.readPending" => {
                self.owner_ydoc_outbox_read_pending(&ctx, request.workspace, request.params, id)
                    .await?
            }
            "ydoc.ownerOutbox.acknowledge" => {
                self.owner_ydoc_outbox_acknowledge(&ctx, request.workspace, request.params)
                    .await?
            }
            "ydoc.ownerOutbox.quarantine" => {
                self.owner_ydoc_outbox_quarantine(&ctx, request.workspace, request.params)
                    .await?
            }
            "ydoc.settle" => {
                self.ydoc_settle(&ctx, request.workspace, request.params)
                    .await?
            }
            "ydoc.close" => {
                self.ydoc_close(&ctx, request.workspace, request.params)
                    .await?
            }
            "ydoc.evict" => {
                self.ydoc_evict(&ctx, request.workspace, request.params)
                    .await?
            }
            "conflicts.list" => {
                self.conflicts_list(&ctx, request.id, request.workspace, request.params)
                    .await?
            }
            "conflicts.open" => {
                self.conflicts_open(&ctx, request.workspace, request.params)
                    .await?
            }
            "conflicts.resolve" => {
                self.conflicts_resolve(
                    &ctx,
                    request.id,
                    request.deadline_ms,
                    request.workspace,
                    request.params,
                    request.idempotency_key,
                )
                .await?
            }
            "search.queryPage" => {
                self.search_query_page(&ctx, request.workspace, request.params)
                    .await?
            }
            "search.queryChatMessagesGranular" => {
                self.search_query_chat_messages_granular(&ctx, request.workspace, request.params)
                    .await?
            }
            "search.ensureIndex" => {
                self.search_ensure_index(&ctx, request.workspace, request.params)
                    .await?
            }
            "collections.list" => {
                self.collections_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "collections.listPendingAdoptions" => {
                self.collections_list_pending_adoptions(&ctx, request.workspace, request.params)
                    .await?
            }
            "watcher.status" => self.watcher_status(request.workspace)?,
            "capture.flush" => self.capture_flush(&ctx, request.workspace).await?,
            "capture.reconcile" => self.capture_reconcile(&ctx, request.workspace).await?,
            "capture.setAuthor" => {
                self.capture_set_author(&ctx, request.workspace, request.params)
                    .await?
            }
            "versions.active" => {
                self.versions_active(&ctx, request.workspace, request.params)
                    .await?
            }
            "versions.ensureMain" => {
                self.versions_ensure_main(&ctx, request.workspace, request.params)
                    .await?
            }
            "versions.setActive" => {
                self.versions_set_active(&ctx, request.workspace, request.params)
                    .await?
            }
            "versions.list" => {
                self.versions_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "versionedText.list" => {
                self.versioned_text_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "versionedText.captureSources" => {
                self.versioned_text_capture_sources(&ctx, request.workspace, request.params)
                    .await?
            }
            "versionedBinary.read" => {
                self.versioned_binary_read(&ctx, request.workspace, request.params)
                    .await?
            }
            "moments.list" => {
                self.moments_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "history.page" => {
                self.history_page(&ctx, request.workspace, request.params)
                    .await?
            }
            "moments.get" => {
                self.moments_get(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.list" => {
                self.secrets_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.stateExists" => {
                self.secrets_state_exists(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.write" => {
                self.secrets_write(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.delete" => {
                self.secrets_delete(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.fork" => {
                self.secrets_fork(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.moments.list" => {
                self.secrets_moments_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.moments.get" => {
                self.secrets_moments_get(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.compare" => {
                self.secrets_compare(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.apply" => {
                self.secrets_apply(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.restore" => {
                self.secrets_restore(&ctx, request.workspace, request.params)
                    .await?
            }
            "secrets.materialize" => {
                self.secrets_materialize(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.channels.create" => {
                self.chats_channels_create(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.channels.ensureGeneral" => {
                self.chats_channels_ensure_general(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.channels.ensureAgent" => {
                self.chats_channels_ensure_agent(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.channels.list" => {
                self.chats_channels_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.channels.findBySlug" => {
                self.chats_channels_find_by_slug(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.channels.getWireId" => {
                self.chats_channels_get_wire_id(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.threads.start" => {
                self.chats_threads_start(
                    &ctx,
                    request.workspace,
                    request.params,
                    request.idempotency_key,
                )
                .await?
            }
            "chats.threads.create" => {
                self.chats_threads_create(
                    &ctx,
                    request.workspace,
                    request.params,
                    request.idempotency_key,
                )
                .await?
            }
            "chats.threads.list" => {
                self.chats_threads_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.threads.listForFile" => {
                self.chats_threads_list_for_file(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.threads.listForChannel" => {
                self.chats_threads_list_for_channel(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.threads.findChannelId" => {
                self.chats_threads_find_channel_id(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.threads.getProjection" => {
                self.chats_threads_get_projection(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.threads.revision" => {
                self.chats_threads_revision(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.messages.send" => {
                self.chats_messages_send(
                    &ctx,
                    request.workspace,
                    request.params,
                    request.idempotency_key,
                )
                .await?
            }
            "chats.decisions.resolve" => {
                self.chats_decisions_resolve(
                    &ctx,
                    request.workspace,
                    request.params,
                    request.idempotency_key,
                )
                .await?
            }
            "chats.decisions.listForThread" => {
                self.chats_decisions_list_for_thread(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.reactions.set" => {
                self.chats_reactions_set(
                    &ctx,
                    request.workspace,
                    request.params,
                    request.idempotency_key,
                )
                .await?
            }
            "chats.reactions.list" => {
                self.chats_reactions_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.attachments.listForThread" => {
                self.chats_attachments_list_for_thread(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.attachments.listFileMentions" => {
                self.chats_attachments_list_file_mentions(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.mentions.listForHandle" => {
                self.chats_mentions_list_for_handle(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.messages.get" => {
                self.chats_messages_get(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.messages.list" => {
                self.chats_messages_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.readState.markThreadRead" => {
                self.chats_read_state_mark_thread_read(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.readState.get" => {
                self.chats_read_state_get(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.readState.listUnreadFileThreads" => {
                self.chats_read_state_list_unread_file_threads(
                    &ctx,
                    request.workspace,
                    request.params,
                )
                .await?
            }
            "chats.agentReadState.listUnreadThreads" => {
                self.chats_agent_read_state_list_unread_threads(
                    &ctx,
                    request.workspace,
                    request.params,
                )
                .await?
            }
            "chats.agentReadState.markThreadRead" => {
                self.chats_agent_read_state_mark_thread_read(
                    &ctx,
                    request.workspace,
                    request.params,
                )
                .await?
            }
            "chats.follows.set" => {
                self.chats_follows_set(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.follows.list" => {
                self.chats_follows_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.follows.ensureDefaults" => {
                self.chats_follows_ensure_defaults(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.feed.markSeen" => {
                self.chats_feed_mark_seen(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.feed.listPersonal" => {
                self.chats_feed_list_personal(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.bookmarks.save" => {
                self.chats_bookmarks_save(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.bookmarks.list" => {
                self.chats_bookmarks_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.bookmarks.find" => {
                self.chats_bookmarks_find(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.bookmarks.listPending" => {
                self.chats_bookmarks_list_pending(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.bookmarks.markReady" => {
                self.chats_bookmarks_mark_ready(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.bookmarks.archive" => {
                self.chats_bookmarks_archive(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.bookmarks.markPending" => {
                self.chats_bookmarks_mark_pending(
                    &ctx,
                    request.workspace,
                    request.params,
                    request.idempotency_key,
                )
                .await?
            }
            "chats.bookmarks.markFailed" => {
                self.chats_bookmarks_mark_failed(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.bookmarks.markStale" => {
                self.chats_bookmarks_mark_stale(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.enqueue" => {
                self.chats_dispatch_enqueue(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.recordEligibleTriggers" => {
                self.chats_dispatch_record_eligible_triggers(
                    &ctx,
                    request.workspace,
                    request.params,
                )
                .await?
            }
            "chats.dispatch.claimNextPending" => {
                self.chats_dispatch_claim_next_pending(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.listPending" => {
                self.chats_dispatch_list_pending(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.openRuns" => {
                self.chats_dispatch_open_runs(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.listRunMessages" => {
                self.chats_dispatch_list_run_messages(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.runIdForMessage" => {
                self.chats_dispatch_run_id_for_message(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.runRecordsForThread" => {
                self.chats_dispatch_run_records_for_thread(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.getRunRecord" => {
                self.chats_dispatch_get_run_record(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.isThreadPaused" => {
                self.chats_dispatch_thread_paused(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.getThreadPauseState" => {
                self.chats_dispatch_get_thread_pause_state(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.recentCount" => {
                self.chats_dispatch_recent_count(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.failPendingForThread" => {
                self.chats_dispatch_fail_pending_for_thread(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.recordRunMessage" => {
                self.chats_dispatch_record_run_message(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.setThreadPaused" => {
                self.chats_dispatch_set_thread_paused(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.markFailureNotePosted" => {
                self.chats_dispatch_mark_failure_note_posted(
                    &ctx,
                    request.workspace,
                    request.params,
                )
                .await?
            }
            "automations.subscribe" => {
                self.automations_subscribe(&ctx, request.workspace, request.params)
                    .await?
            }
            "automations.unsubscribe" => {
                self.automations_unsubscribe(&ctx, request.workspace, request.params)
                    .await?
            }
            "automations.releaseGroups" => {
                self.automations_release_groups(&ctx, request.workspace, request.params)
                    .await?
            }
            "automations.watchGroups" => {
                self.automations_watch_groups(&ctx, request.workspace, request.params)
                    .await?
            }
            "automations.claimNext" => {
                self.automations_claim_next(&ctx, request.workspace, request.params)
                    .await?
            }
            "automations.failures" => self.automations_failures(&ctx, request.workspace).await?,
            "automations.groupSkips" => {
                self.automations_group_skips(&ctx, request.workspace)
                    .await?
            }
            "automations.listClaims" => {
                self.automations_list_claims(&ctx, request.workspace, request.params)
                    .await?
            }
            "automations.settle" => {
                self.automations_settle(&ctx, request.workspace, request.params)
                    .await?
            }
            "automations.retry" => {
                self.automations_retry(&ctx, request.workspace, request.params)
                    .await?
            }
            "automations.release" => {
                self.automations_release(&ctx, request.workspace, request.params)
                    .await?
            }
            "automations.press" => {
                self.automations_press(&ctx, request.workspace, request.params)
                    .await?
            }
            "automations.claimSchedule" => {
                self.automations_claim_schedule(&ctx, request.workspace, request.params)
                    .await?
            }
            "automations.runNow" => {
                self.automations_run_now(&ctx, request.workspace, request.params)
                    .await?
            }
            "automations.scheduleMarks" => {
                self.automations_schedule_marks(&ctx, request.workspace)
                    .await?
            }
            "chats.dispatch.requeueFailedTrigger" => {
                self.chats_dispatch_requeue_failed_trigger(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.listAppQuitRecoveries" => {
                self.chats_dispatch_list_app_quit_recoveries(
                    &ctx,
                    request.workspace,
                    request.params,
                )
                .await?
            }
            "chats.dispatch.complete" => {
                self.chats_dispatch_complete(&ctx, request.workspace, request.params)
                    .await?
            }
            "chats.dispatch.fail" => {
                self.chats_dispatch_fail(&ctx, request.workspace, request.params)
                    .await?
            }
            _ => return Err(WireError::new(ErrorCode::MethodNotFound, "unknown method")),
        };
        Ok(ServiceResponse::response(Response { id, result }))
    }

    fn ensure_handle_allows_method(
        &self,
        handle: Option<&WorkspaceHandle>,
        method: &str,
    ) -> Result<(), WireError> {
        let Some(handle) = handle else {
            return Ok(());
        };
        let read_only = lock(&self.handles)
            .get(handle)
            .is_some_and(|open| open.mode == WorkspaceOpenMode::ReadOnly);
        if read_only
            && !matches!(
                method,
                "workspace.close"
                    | "search.queryChatMessagesGranular"
                    | "chats.readState.listUnreadFileThreads"
            )
        {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "method is unavailable on a read-only workspace handle",
            ));
        }
        Ok(())
    }

    /// Fence reads and barriers while the initial file baseline has no declared
    /// outcome. The bounded startup decision releases them in either `Ready` or
    /// explicit `Degraded`; recovery may continue from there, like any later
    /// watcher pass. The classifier is centralized so an early handle cannot
    /// leak an unreported import prefix through one handler while another stays
    /// fenced.
    fn require_initial_capture_ready(
        &self,
        handle: Option<&WorkspaceHandle>,
        method: &str,
    ) -> Result<(), WireError> {
        if !method_requires_initial_capture_ready(method) {
            return Ok(());
        }
        let Some(handle) = handle else {
            return Ok(());
        };
        let open = self.open(Some(handle))?;
        let phase = lock(&open.capture)
            .as_ref()
            .map(|driver| driver.status().snapshot().phase)
            .unwrap_or(capture_driver::CapturePhase::Ready);
        if !initial_capture_phase_requires_fence(phase) {
            return Ok(());
        }
        Err(initial_capture_updating())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_protocol::transport::EngineService as _;

    #[tokio::test]
    async fn configured_ordinary_methods_require_attached_handle_and_current_connection() {
        use dohc_engine_protocol::transport::ConnectionOwner;
        let attached = dohc_engine_testkit::ScratchDir::new().unwrap();
        let private = dohc_engine_testkit::ScratchDir::new().unwrap();
        let config = serde_json::from_value(json!({
            "version": 1, "relayNamespace": "relay",
            "host": {"hostId": "host", "hostEpoch": 1, "instanceId": "instance", "connectionId": "connection"},
            "workspaces": [
                {"root": attached.path(), "workspaceId": "attached", "maxRegistrations": 4,
                    "relay": {"baseUrl": "https://relay.example", "bearerToken": "actual-owner-credential"}},
                {"root": private.path(), "workspaceId": "private", "maxRegistrations": 4}
            ],
            "ingress": {"aggregateBytes": 400_000_000, "applicationWorkingReserveBytes": 1_000_000,
                "maxUploads": 2, "uploadDeadlineMs": 30_000}
        })).unwrap();
        let (service, owner, _ingress) = EngineService::configured_live_host(config).await.unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let mut request = Request {
            id: 1,
            method: "liveApplication.hosts".into(),
            workspace: None,
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
            params: json!({}),
        };
        let discovery = service.configured_live_hosts(&ctx, &request).unwrap();
        let attached_handle: WorkspaceHandle =
            serde_json::from_value(discovery["workspaces"][0]["workspaceHandle"].clone()).unwrap();
        let private_handle: WorkspaceHandle =
            serde_json::from_value(discovery["workspaces"][1]["workspaceHandle"].clone()).unwrap();
        for method in [
            "sync.claim",
            "sync.adoptJoinIdentity",
            "sync.pull",
            "sync.materializePendingCursor",
            "sync.commitCursor",
            "sync.push",
        ] {
            request.method = method.into();
            request.workspace = Some(attached_handle.clone());
            assert!(
                service
                    .ensure_configured_host_method(&ctx, &request)
                    .is_ok(),
                "{method}"
            );
            for handle in [
                Some(private_handle.clone()),
                Some(WorkspaceHandle("foreign".into())),
                None,
            ] {
                request.workspace = handle;
                assert_eq!(
                    service
                        .ensure_configured_host_method(&ctx, &request)
                        .unwrap_err()
                        .code,
                    ErrorCode::Forbidden
                );
            }
        }
        request.workspace = Some(attached_handle.clone());
        for method in [
            "workspace.open",
            "ydoc.open",
            "sync.recoverOrigin",
            "sync.probe",
            "versionedText.write",
        ] {
            request.method = method.into();
            assert_eq!(
                service
                    .ensure_configured_host_method(&ctx, &request)
                    .unwrap_err()
                    .code,
                ErrorCode::Forbidden
            );
        }
        request.method = "sync.pull".into();
        let other = ConnectionOwner::authenticated();
        ctx.connection = Some(other.handle());
        assert_eq!(
            service
                .ensure_configured_host_method(&ctx, &request)
                .unwrap_err()
                .code,
            ErrorCode::Forbidden
        );
        ctx.connection = Some(owner.handle());
        owner.retire();
        assert_eq!(
            service
                .ensure_configured_host_method(&ctx, &request)
                .unwrap_err()
                .code,
            ErrorCode::Forbidden
        );
        service
            .workspace_close(Some(attached_handle))
            .await
            .unwrap();
        service.workspace_close(Some(private_handle)).await.unwrap();
    }

    #[test]
    fn only_idempotent_version_bootstrap_bypasses_the_initial_capture_fence() {
        assert!(!method_requires_initial_capture_ready(
            "versions.ensureMain"
        ));
        for method in [
            "versions.active",
            "versions.list",
            "versions.createNamed",
            "versions.setActive",
            "collections.list",
            "collections.get",
            "collections.query",
            "collections.getRecord",
            "collections.listPendingAdoptions",
        ] {
            assert!(method_requires_initial_capture_ready(method), "{method}");
        }
    }

    #[test]
    fn only_secret_write_bypasses_the_initial_capture_fence() {
        assert!(!method_requires_initial_capture_ready("secrets.write"));
        for method in [
            "secrets.list",
            "secrets.stateExists",
            "secrets.delete",
            "secrets.fork",
            "secrets.moments.list",
            "secrets.moments.get",
            "secrets.compare",
            "secrets.apply",
            "secrets.restore",
            "secrets.materialize",
        ] {
            assert!(method_requires_initial_capture_ready(method), "{method}");
        }
    }

    #[test]
    fn bounded_degraded_startup_releases_safe_reads() {
        assert!(initial_capture_phase_requires_fence(
            capture_driver::CapturePhase::Starting
        ));
        assert!(initial_capture_phase_requires_fence(
            capture_driver::CapturePhase::Importing
        ));
        assert!(!initial_capture_phase_requires_fence(
            capture_driver::CapturePhase::Ready
        ));
        assert!(!initial_capture_phase_requires_fence(
            capture_driver::CapturePhase::Degraded
        ));
    }

    #[tokio::test]
    async fn engine_ping_answers_without_a_workspace_handle() {
        let service = EngineService::new();
        let answer = service
            .call(
                RequestContext::unbounded(),
                Request {
                    id: 1,
                    method: "engine.ping".to_owned(),
                    workspace: None,
                    deadline_ms: None,
                    idempotency_key: None,
                    progress: false,
                    params: Value::Null,
                },
            )
            .await
            .expect("engine.ping must answer");
        assert_eq!(answer.response.id, 1);
        assert_eq!(answer.response.result, json!({ "ok": true }));
    }

    /// Every listed method is registered, and the three retired ones
    /// (`share.view.push`, `ydoc.apply`, `chats.dispatch.reclaimRunning`) are
    /// not. A new arm added without a row here is not caught; that needs the
    /// dispatch table as data.
    ///
    /// Without a workspace handle a registered method fails on the missing
    /// handle or on its params; an unregistered one fails `MethodNotFound`.
    /// That difference is what makes the list checkable from outside.
    #[tokio::test]
    async fn listed_methods_are_registered_and_retired_methods_are_rejected() {
        const METHODS: &[&str] = &[
            "automations.claimNext",
            "automations.claimSchedule",
            "automations.failures",
            "automations.groupSkips",
            "automations.listClaims",
            "automations.press",
            "automations.release",
            "automations.releaseGroups",
            "automations.retry",
            "automations.runNow",
            "automations.scheduleMarks",
            "automations.settle",
            "automations.subscribe",
            "automations.unsubscribe",
            "automations.watchGroups",
            "capture.flush",
            "capture.reconcile",
            "capture.setAuthor",
            "chats.agentReadState.listUnreadThreads",
            "chats.agentReadState.markThreadRead",
            "chats.attachments.listFileMentions",
            "chats.attachments.listForThread",
            "chats.bookmarks.archive",
            "chats.bookmarks.find",
            "chats.bookmarks.list",
            "chats.bookmarks.listPending",
            "chats.bookmarks.markFailed",
            "chats.bookmarks.markPending",
            "chats.bookmarks.markReady",
            "chats.bookmarks.markStale",
            "chats.bookmarks.save",
            "chats.channels.create",
            "chats.channels.ensureAgent",
            "chats.channels.ensureGeneral",
            "chats.channels.findBySlug",
            "chats.channels.getWireId",
            "chats.channels.list",
            "chats.decisions.listForThread",
            "chats.decisions.resolve",
            "chats.dispatch.claimNextPending",
            "chats.dispatch.complete",
            "chats.dispatch.enqueue",
            "chats.dispatch.fail",
            "chats.dispatch.failPendingForThread",
            "chats.dispatch.getRunRecord",
            "chats.dispatch.getThreadPauseState",
            "chats.dispatch.isThreadPaused",
            "chats.dispatch.listAppQuitRecoveries",
            "chats.dispatch.listPending",
            "chats.dispatch.listRunMessages",
            "chats.dispatch.markFailureNotePosted",
            "chats.dispatch.openRuns",
            "chats.dispatch.recentCount",
            "chats.dispatch.recordEligibleTriggers",
            "chats.dispatch.recordRunMessage",
            "chats.dispatch.requeueFailedTrigger",
            "chats.dispatch.runIdForMessage",
            "chats.dispatch.runRecordsForThread",
            "chats.dispatch.setThreadPaused",
            "chats.feed.listPersonal",
            "chats.feed.markSeen",
            "chats.follows.ensureDefaults",
            "chats.follows.list",
            "chats.follows.set",
            "chats.mentions.listForHandle",
            "chats.messages.get",
            "chats.messages.list",
            "chats.messages.send",
            "chats.reactions.list",
            "chats.reactions.set",
            "chats.readState.get",
            "chats.readState.listUnreadFileThreads",
            "chats.readState.markThreadRead",
            "chats.threads.create",
            "chats.threads.findChannelId",
            "chats.threads.getProjection",
            "chats.threads.list",
            "chats.threads.listForChannel",
            "chats.threads.listForFile",
            "chats.threads.revision",
            "chats.threads.start",
            "collections.get",
            "collections.getRecord",
            "collections.list",
            "collections.listPendingAdoptions",
            "collections.query",
            "conflicts.list",
            "conflicts.open",
            "conflicts.resolve",
            "engine.ping",
            "history.page",
            "keys.download",
            "keys.upload",
            "moments.get",
            "moments.list",
            "search.ensureIndex",
            "search.queryChatMessagesGranular",
            "search.queryPage",
            "secrets.apply",
            "secrets.compare",
            "secrets.delete",
            "secrets.fork",
            "secrets.list",
            "secrets.materialize",
            "secrets.moments.get",
            "secrets.moments.list",
            "secrets.restore",
            "secrets.stateExists",
            "secrets.write",
            "share.channel.pull",
            "share.channel.push",
            "share.direct.push",
            "share.proposal.submit",
            "share.view.pull",
            "share.view.recordIdentity",
            "sync.adoptJoinIdentity",
            "sync.claim",
            "sync.materializePendingCursor",
            "sync.commitCursor",
            "sync.probe",
            "sync.pull",
            "sync.remoteChanges",
            "sync.push",
            "sync.recoverOrigin",
            "versionedBinary.read",
            "versionedBinary.readBlob",
            "versionedBinary.write",
            "versionedBinary.writeBlob",
            "versionedText.compare",
            "versionedText.checkMove",
            "versionedText.delete",
            "versionedText.list",
            "versionedText.captureSources",
            "versionedText.merge",
            "versionedText.read",
            "versionedText.readBlob",
            "versionedText.rename",
            "versionedText.rollback",
            "versionedText.write",
            "versions.active",
            "versions.compareFiles",
            "versions.createNamed",
            "versions.ensureMain",
            "versions.list",
            "versions.setActive",
            "watcher.status",
            "workspace.close",
            "workspace.open",
            "ydoc.close",
            "ydoc.evict",
            "ydoc.open",
            "ydoc.recordUpdate",
            "ydoc.resync",
            "ydoc.settle",
        ];
        async fn registered(service: &EngineService, method: &str) -> bool {
            service
                .call(
                    RequestContext::unbounded(),
                    Request {
                        id: 1,
                        method: method.to_owned(),
                        workspace: None,
                        deadline_ms: None,
                        idempotency_key: None,
                        progress: false,
                        params: json!({}),
                    },
                )
                .await
                .err()
                .is_none_or(|error| error.code != ErrorCode::MethodNotFound)
        }
        let service = EngineService::new();
        let mut missing = Vec::new();
        for method in METHODS {
            if !registered(&service, method).await {
                missing.push(*method);
            }
        }
        assert!(
            missing.is_empty(),
            "listed methods absent from dispatch: {missing:?}"
        );
        for retired in [
            "share.view.push",
            "ydoc.apply",
            "chats.dispatch.reclaimRunning",
        ] {
            assert!(
                !registered(&service, retired).await,
                "{retired} was retired and must stay out of dispatch"
            );
        }
    }
}
