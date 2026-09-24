import fs from "node:fs";
function edit(file, pairs) {
  let s = fs.readFileSync(file, "utf8");
  for (const [a, b] of pairs) {
    const n = s.split(a).length - 1;
    if (n !== 1) {
      console.log(`${file}: expected 1, found ${n}:`, JSON.stringify(a.slice(0, 90)));
      process.exit(1);
    }
    s = s.replace(a, b);
  }
  fs.writeFileSync(file, s);
}

edit("C:/w/cx-replace/crates/dohc-engine-storage/src/materialize.rs", [
  [
    `/// Every row of one job, in any state, oldest first.`,
    `/// Open and placed rows for one path, from any job, oldest first. An empty
/// \`workspace_id\` on either side matches every workspace.
pub(crate) fn list_unsettled_displacements_for_path(
    conn: &Connection,
    workspace_id: &str,
    path: &str,
) -> Result<Vec<Displacement>, StorageError> {
    query_displacements(
        conn,
        "state IN ('open', 'placed') AND target_path = ?2 \\
         AND (?1 = '' OR workspace_id = ?1 OR workspace_id = '')",
        [workspace_id, path],
    )
}

/// Every row of one job, in any state, oldest first.`,
  ],
]);

edit("C:/w/cx-replace/crates/dohc-engine-storage/src/store.rs", [
  [
    `    /// Every displacement of one job, in any state.`,
    `    /// The open and placed displacements of one path, from any job.
    pub fn list_unsettled_displacements_for_path(
        &self,
        workspace_id: &str,
        path: &str,
    ) -> Result<Vec<Displacement>, StorageError> {
        materialize::list_unsettled_displacements_for_path(&self.conn, workspace_id, path)
    }

    /// Every displacement of one job, in any state.`,
  ],
]);

edit("C:/w/cx-replace/crates/dohc-engine-files/src/lib.rs", [
  [
    `materialize_secret_one, probe_projection_target, recover_displacements, run_pending_jobs,`,
    `materialize_secret_one, probe_projection_target, recover_displacements,
    recover_path_displacements, run_pending_jobs,`,
  ],
]);

edit("C:/w/cx-replace/crates/dohc-engine-runtime/src/actor/capture.rs", [
  [
    `    let refuse = |reason| {
        RuntimeError::Sync(dohc_engine_sync::SyncError::RetryableState { reason })
    };
    if store.path_is_displaced(workspace_id, path)? {
        return Err(refuse("path-displaced-by-replace"));
    }
    let Some(root_dir) = root_dir else {
        return Err(refuse("absence-unconfirmed"));
    };`,
    `    let refuse = |reason| {
        RuntimeError::Sync(dohc_engine_sync::SyncError::RetryableState { reason })
    };
    let Some(root_dir) = root_dir else {
        return Err(refuse("absence-unconfirmed"));
    };
    if store.path_is_displaced(workspace_id, path)? {
        // A replace could not put a displaced file back when it ran. Try
        // again now; the check below then sees the file that returned.
        let _ = dohc_engine_files::recover_path_displacements(
            store,
            root_dir,
            workspace_id,
            path,
            &dohc_engine_files::MaterializeOptions {
                policy: dohc_engine_files::DurabilityPolicy::per_os(),
                replacer: &dohc_engine_files::StdReplacer,
                backoff: &dohc_engine_files::StdBackoff,
                now_ms: 0,
                faults: &dohc_engine_storage::NoFaults,
            },
        );
        if store.path_is_displaced(workspace_id, path)? {
            return Err(refuse("path-displaced-by-replace"));
        }
    }`,
  ],
]);
console.log("ok");
