use dohc_engine_crypto::{create_key_file, load_key_file};
use dohc_engine_domain::{CreateNamedVersion, SecretWrite};
use dohc_engine_runtime::{
    ActiveVersionSwitch, ActorHandle, CancellationToken, NoFaults, SecretWriteDisk,
    WorkspaceSupervisor,
};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use rusqlite::{Connection, params};
use std::path::Path;
use std::sync::Arc;

const WORKSPACE: &str = "ws-legacy-template";

async fn open_main(supervisor: &WorkspaceSupervisor, database: &Path, root: &Path) -> ActorHandle {
    let actor = supervisor.open(database, 1).expect("actor").actor;
    actor
        .ensure_main_version(
            WORKSPACE.to_owned(),
            1,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main");
    create_key_file(&root.join(".dohc/engine")).expect("secret key");
    actor
}

async fn write_secret(
    actor: &ActorHandle,
    root: &Path,
    version_id: &str,
    path: &str,
    disk: SecretWriteDisk,
    now_ms: i64,
) {
    let key = load_key_file(&root.join(".dohc/engine"))
        .expect("load key")
        .expect("key exists");
    actor
        .write_secret_file(
            SecretWrite {
                workspace_id: WORKSPACE.to_owned(),
                version_id: version_id.to_owned(),
                path: path.to_owned(),
                text: format!("FROM={version_id}\n"),
                moment_id: format!("legacy-{version_id}-{now_ms}"),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms,
            },
            disk,
            key,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("secret write");
}

async fn create_feature(actor: &ActorHandle, now_ms: i64) {
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WORKSPACE.to_owned(),
                new_version_id: "feature".to_owned(),
                name: "Feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("feature");
}

async fn switch_to(actor: &ActorHandle, root: &Path, version_id: &str, now_ms: i64) {
    actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WORKSPACE.to_owned(),
                version_id: version_id.to_owned(),
                root_dir: root.to_path_buf(),
                self_writes: Arc::new(()),
                now_ms,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap_or_else(|error| panic!("switch to {version_id}: {error:?}"));
}

fn store_as_older_build_template(database: &Path, version_id: Option<&str>) {
    let connection = Connection::open(database).expect("sqlite");
    for sql in [
        "UPDATE secret_files SET path = '.env.example' \
         WHERE path = '.env.local' AND (?1 IS NULL OR version_id = ?1)",
        "UPDATE secret_fork_bases SET path = '.env.example' \
         WHERE path = '.env.local' AND (?1 IS NULL OR version_id = ?1)",
        "UPDATE secret_moments SET path = '.env.example' \
         WHERE path = '.env.local' AND (?1 IS NULL OR version_id = ?1)",
        "UPDATE materialization_jobs SET target_path = '.env.example' \
         WHERE target_path = '.env.local' AND ?1 IS NULL",
    ] {
        connection
            .execute(sql, params![version_id])
            .expect("store the row as an older build did");
    }
}

fn paths(database: &Path, table: &str, version_id: &str) -> Vec<String> {
    Connection::open(database)
        .expect("sqlite")
        .prepare(&format!(
            "SELECT path FROM {table} WHERE workspace_id = ?1 AND version_id = ?2 ORDER BY path"
        ))
        .expect("prepare")
        .query_map(params![WORKSPACE, version_id], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("paths")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switching_versions_ignores_an_older_builds_env_template_tip() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path();
    let database = engine_db_path(&scratch).expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = open_main(&supervisor, &database, root).await;
    write_secret(
        &actor,
        root,
        "main",
        ".env.local",
        SecretWriteDisk::AlreadyOnDisk,
        2,
    )
    .await;
    create_feature(&actor, 3).await;
    write_secret(
        &actor,
        root,
        "feature",
        ".env.local",
        SecretWriteDisk::AlreadyOnDisk,
        4,
    )
    .await;
    supervisor.close(&database).expect("close");
    store_as_older_build_template(&database, None);
    std::fs::write(root.join(".env.example"), "EXAMPLE=disk\n").expect("template on disk");
    let actor = supervisor.open(&database, 5).expect("reopen").actor;

    switch_to(&actor, root, "feature", 6).await;
    switch_to(&actor, root, "main", 7).await;

    assert_eq!(
        std::fs::read_to_string(root.join(".env.example")).expect("template"),
        "EXAMPLE=disk\n"
    );
    supervisor.close(&database).expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_version_leaves_an_older_builds_env_template_rows_behind() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path();
    let database = engine_db_path(&scratch).expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = open_main(&supervisor, &database, root).await;
    write_secret(
        &actor,
        root,
        "main",
        ".env",
        SecretWriteDisk::AlreadyOnDisk,
        2,
    )
    .await;
    write_secret(
        &actor,
        root,
        "main",
        ".env.local",
        SecretWriteDisk::AlreadyOnDisk,
        3,
    )
    .await;
    supervisor.close(&database).expect("close");
    store_as_older_build_template(&database, None);
    let actor = supervisor.open(&database, 4).expect("reopen").actor;

    create_feature(&actor, 5).await;

    let listed: Vec<String> = actor
        .list_secret_files_page(WORKSPACE.to_owned(), "feature".to_owned(), None, 10)
        .await
        .expect("feature secrets")
        .into_iter()
        .map(|stat| stat.path)
        .collect();
    assert_eq!(listed, [".env"]);
    supervisor.close(&database).expect("close");
    assert_eq!(paths(&database, "secret_fork_bases", "feature"), [".env"]);
    assert_eq!(
        paths(&database, "secret_files", "main"),
        [".env", ".env.example"]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn startup_replay_settles_an_older_builds_pending_env_template_write() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path();
    let database = engine_db_path(&scratch).expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = open_main(&supervisor, &database, root).await;
    write_secret(
        &actor,
        root,
        "main",
        ".env.local",
        SecretWriteDisk::Queue {
            root_dir: root.to_path_buf(),
        },
        2,
    )
    .await;
    supervisor.close(&database).expect("close");
    store_as_older_build_template(&database, None);
    let pending = |database: &Path| -> i64 {
        Connection::open(database)
            .expect("sqlite")
            .query_row(
                "SELECT COUNT(*) FROM materialization_jobs \
                 WHERE target_path = '.env.example' AND status = 'pending'",
                [],
                |row| row.get(0),
            )
            .expect("pending jobs")
    };
    assert_eq!(pending(&database), 1);
    let actor = supervisor.open(&database, 3).expect("reopen").actor;

    actor
        .materialize_replay_pending(root.to_path_buf(), WORKSPACE.to_owned(), 4)
        .await
        .expect("startup replay");

    supervisor.close(&database).expect("close");
    assert_eq!(pending(&database), 0);
    assert!(!root.join(".env.example").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn comparing_versions_skips_an_older_builds_env_template_row_across_pages() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path();
    let database = engine_db_path(&scratch).expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = open_main(&supervisor, &database, root).await;
    write_secret(
        &actor,
        root,
        "main",
        ".env.local",
        SecretWriteDisk::AlreadyOnDisk,
        2,
    )
    .await;
    create_feature(&actor, 3).await;
    supervisor.close(&database).expect("close");
    store_as_older_build_template(&database, Some("main"));
    let actor = supervisor.open(&database, 4).expect("reopen").actor;

    let mut compared = Vec::new();
    let mut after_path = None;
    loop {
        let page = actor
            .compare_secret_files(
                WORKSPACE.to_owned(),
                "main".to_owned(),
                "feature".to_owned(),
                after_path,
                1,
                None,
            )
            .await
            .expect("compare page");
        compared.extend(page.entries.into_iter().map(|entry| entry.path));
        after_path = page.next_after_path;
        if after_path.is_none() {
            break;
        }
    }

    assert_eq!(compared, [".env.local"]);
    supervisor.close(&database).expect("close");
}
