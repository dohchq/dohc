use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::limits::WireLimits;
use dohc_engine_protocol::wire::{
    Envelope, Hello, PROTOCOL_VERSION, Request, decode_control, encode_control,
};
use dohc_engine_testkit::ScratchDir;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};

fn configuration(root: &Path) -> Value {
    json!({
        "version": 1, "relayNamespace": "configured-test-relay",
        "host": {"hostId":"host", "hostEpoch":1, "instanceId":"instance", "connectionId":"connection"},
        "workspaces": [{"root":root, "workspaceId":"workspace", "maxRegistrations":4}],
        "ingress": {"aggregateBytes":400_000_000, "applicationWorkingReserveBytes":1_000_000, "maxUploads":2, "uploadDeadlineMs":30_000}
    })
}

fn command(config: Option<&Path>) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_dohc-workspace-engine"));
    command.env("DOHC_ENGINE_AUTH_TOKEN", "configured-test-secret");
    command.env_remove("DOHC_ENGINE_LIVE_HOST_CONFIG");
    if let Some(config) = config {
        command.env("DOHC_ENGINE_LIVE_HOST_CONFIG", config);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

struct Daemon(Child);
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
impl Daemon {
    fn streamed(
        &mut self,
        id: u64,
        method: &str,
        workspace: dohc_engine_protocol::wire::WorkspaceHandle,
        params: Value,
        streams: &[(u64, &[u8])],
    ) -> Envelope {
        self.send(Envelope::Request(Request {
            id,
            method: method.into(),
            workspace: Some(workspace),
            deadline_ms: Some(30_000),
            idempotency_key: None,
            params,
        }));
        for (stream, bytes) in streams {
            self.send(Envelope::BlobStart(dohc_engine_protocol::wire::BlobStart {
                request_id: id,
                stream_id: *stream,
                total_bytes: Some(bytes.len() as u64),
                sha256: Some(dohc_engine_storage::hex_sha256(bytes)),
            }));
            self.0
                .stdin
                .as_mut()
                .unwrap()
                .write_all(
                    &dohc_engine_protocol::frame::encode_blob_chunk_frame(
                        *stream,
                        true,
                        bytes,
                        &WireLimits::default(),
                    )
                    .unwrap(),
                )
                .unwrap();
        }
        loop {
            let reply = self.read();
            if !matches!(reply, Envelope::Event(_)) {
                return reply;
            }
        }
    }
    fn send(&mut self, envelope: Envelope) {
        self.0
            .stdin
            .as_mut()
            .unwrap()
            .write_all(&encode_control(&envelope, &WireLimits::default()).unwrap())
            .unwrap();
    }
    fn read(&mut self) -> Envelope {
        let output = self.0.stdout.as_mut().unwrap();
        let mut header = [0; 12];
        output.read_exact(&mut header).unwrap();
        assert_eq!(&header[..4], b"DOP1");
        let length = u32::from_le_bytes(header[8..12].try_into().unwrap()) as usize;
        assert!(length <= WireLimits::default().max_frame_bytes as usize);
        let mut payload = vec![0; length];
        output.read_exact(&mut payload).unwrap();
        decode_control(&payload, &WireLimits::default()).unwrap()
    }
    fn hello(&mut self, token: &str) {
        self.send(Envelope::Hello(Hello {
            protocol_version: PROTOCOL_VERSION,
            auth_token: token.into(),
            capabilities: vec![],
            last_session_generation: None,
            max_frame_bytes: None,
        }));
    }
    fn request(
        &mut self,
        id: u64,
        method: &str,
        workspace: Option<dohc_engine_protocol::wire::WorkspaceHandle>,
        params: Value,
    ) -> Envelope {
        self.send(Envelope::Request(Request {
            id,
            method: method.into(),
            workspace,
            deadline_ms: None,
            idempotency_key: None,
            params,
        }));
        loop {
            let envelope = self.read();
            if !matches!(envelope, Envelope::Event(_)) {
                return envelope;
            }
        }
    }
}

#[test]
fn production_entrypoint_settles_bootstrap_and_replays_receipt_coverage() {
    use dohc_engine_storage::hex_sha256;
    let scratch = ScratchDir::new().unwrap();
    let root = scratch.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    let database = root.join(".dohc/engine/engine.db");
    std::fs::create_dir_all(database.parent().unwrap()).unwrap();
    let mut seeded = dohc_engine_storage::EngineStore::open(&database, 0).unwrap();
    let root_token = dohc_workspace_engine::root_binding::write_new_root_binding(&root).unwrap();
    seeded
        .bind_root_token(&root_token, &dohc_engine_storage::NoFaults)
        .unwrap();
    dohc_engine_domain::VersionedTextStore::new(&mut seeded)
        .ensure_main_version("workspace", "main", 0, &dohc_engine_storage::NoFaults)
        .unwrap();
    drop(seeded);
    let path = scratch.path().join("host.json");
    let mut config = configuration(&root);
    config["settlement"] = json!({"maxApplicationsPerSettlement":4});
    std::fs::write(&path, config.to_string()).unwrap();
    let mut daemon = Daemon(command(Some(&path)).spawn().unwrap());
    daemon.send(Envelope::Hello(Hello {
        protocol_version: PROTOCOL_VERSION,
        auth_token: "configured-test-secret".into(),
        capabilities: vec!["blobs".into()],
        last_session_generation: None,
        max_frame_bytes: None,
    }));
    assert!(matches!(daemon.read(), Envelope::HelloAck(_)));
    let Envelope::Response(hosts) = daemon.request(1, "liveApplication.hosts", None, json!({}))
    else {
        panic!("discovery")
    };
    let workspace: dohc_engine_protocol::wire::WorkspaceHandle =
        serde_json::from_value(hosts.result["workspaces"][0]["workspaceHandle"].clone()).unwrap();
    let db = rusqlite::Connection::open_with_flags(
        root.join(".dohc/engine/engine.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let main: String = db
        .query_row(
            "SELECT main_version_id FROM versioned_workspaces WHERE workspace_id='workspace'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/live-bootstrap-fixtures/live-bootstrap.json"
    ))
    .unwrap();
    let fixture = fixtures
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "rich-unicode")
        .unwrap();
    let bytes: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
    let markdown = fixture["markdown"].as_str().unwrap();
    let binding = json!({"workspaceId":"workspace","mainVersionId":main,"objectId":"object","lineageClaimId":hex_sha256(&bytes),"currentPath":"note.md","selectorPaths":["note.md"],"restoreFenceGeneration":0});
    let Envelope::Response(registered) = daemon.request(
        2,
        "liveApplication.register",
        Some(workspace.clone()),
        json!({"binding":binding}),
    ) else {
        panic!("registration")
    };
    let registration = registered.result["registrationId"].clone();
    let response=daemon.streamed(3,"liveApplication.bootstrap",workspace.clone(),json!({"registrationId":registration,"baselineStreamId":1,"baseline":{"bootstrapId":"baseline","bootstrapMomentId":"baseline-moment","baselineMomentRelaySequence":0,"baselineRegisteredAtMs":1,"baselineDigest":hex_sha256(&bytes),"baselineByteLength":bytes.len(),"projectedMarkdownDigest":hex_sha256(markdown.as_bytes()),"projectedMarkdownByteLength":markdown.len()}}),&[(1,&bytes)]);
    assert!(matches!(response, Envelope::Response(_)), "{response:?}");
    assert!(!root.join("note.md").exists());
    let params = json!({"registrationId":registration,"terminalReceipt":null});
    let Envelope::Response(settled) = daemon.request(
        4,
        "liveApplication.settle",
        Some(workspace.clone()),
        params.clone(),
    ) else {
        panic!("settlement")
    };
    assert_eq!(settled.result["status"], "settled");
    assert_eq!(settled.result["settlement"]["materialized"], true);
    assert_eq!(
        std::fs::read_to_string(root.join("note.md")).unwrap(),
        markdown
    );
    let Envelope::Response(replayed) =
        daemon.request(5, "liveApplication.settle", Some(workspace.clone()), params)
    else {
        panic!("replay")
    };
    assert_eq!(replayed.result, settled.result);
    let receipt = json!({"deliveryId":"noop","updateDigest":hex_sha256(&[0,0]),"journalCursor":2,"acceptingHostEpoch":1});
    let response=daemon.streamed(6,"liveApplication.apply",workspace.clone(),json!({"registrationId":registration,"rangeCount":0,"rangeStreamId":3,"rangeDigest":hex_sha256(&[]),"updateStreamId":2,"updateByteLength":2,"accepted":{"receipt":receipt,"binding":binding,"authority":{"principalKind":"owner","principalId":"person","grantId":null,"grantGeneration":null},"receivedAtMs":2}}),&[(2,&[0,0]),(3,&[])]);
    assert!(matches!(response, Envelope::Response(_)), "{response:?}");
    let Envelope::Response(covered) = daemon.request(
        7,
        "liveApplication.settle",
        Some(workspace.clone()),
        json!({"registrationId":registration,"terminalReceipt":receipt}),
    ) else {
        panic!("coverage")
    };
    assert_eq!(covered.result["settlement"]["applicationCount"], 1);
    assert_eq!(covered.result["settlement"]["terminalCursor"], 2);
    assert_eq!(
        covered.result["settlement"]["momentId"],
        settled.result["settlement"]["momentId"]
    );
    let counts:(i64,i64)=db.query_row("SELECT (SELECT COUNT(*) FROM live_device_settlements),(SELECT COUNT(*) FROM engine_search_files_fts WHERE object_id='object' AND text=?1)",[markdown],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(counts, (2, 1));
    let Envelope::Error(refused) = daemon.request(
        8,
        "liveApplication.settle",
        Some(workspace),
        json!({"registrationId":registration}),
    ) else {
        panic!("missing terminal refusal")
    };
    assert_eq!(refused.error.code, ErrorCode::InvalidParams);
    drop(daemon.0.stdin.take());
    assert!(daemon.0.wait().unwrap().success());
}

#[test]
fn production_entrypoint_discovers_fixed_roots_after_authentication() {
    let scratch = ScratchDir::new().unwrap();
    let root = scratch.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(
        root.join("not-captured.md"),
        "source remains outside capture",
    )
    .unwrap();
    let path = scratch.path().join("host.json");
    let second = scratch.path().join("second");
    std::fs::create_dir(&second).unwrap();
    let mut config = configuration(&root);
    config["workspaces"]
        .as_array_mut()
        .unwrap()
        .push(json!({"root":second,"workspaceId":"second","maxRegistrations":2}));
    std::fs::write(&path, config.to_string()).unwrap();
    let mut daemon = Daemon(command(Some(&path)).spawn().unwrap());
    daemon.hello("configured-test-secret");
    assert!(matches!(daemon.read(), Envelope::HelloAck(_)));
    let Envelope::Response(response) = daemon.request(1, "liveApplication.hosts", None, json!({}))
    else {
        panic!("expected discovery")
    };
    assert_eq!(response.result["relayNamespace"], "configured-test-relay");
    assert_eq!(response.result["host"], configuration(&root)["host"]);
    assert_eq!(response.result["workspaces"].as_array().unwrap().len(), 2);
    assert_eq!(response.result["workspaces"][0]["workspaceId"], "workspace");
    assert_eq!(
        response
            .result
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["host", "relayNamespace", "workspaces"]
    );
    for workspace in response.result["workspaces"].as_array().unwrap() {
        assert_eq!(
            workspace
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["workspaceHandle", "workspaceId"]
        );
    }
    let handle =
        serde_json::from_value(response.result["workspaces"][0]["workspaceHandle"].clone())
            .unwrap();
    for (id, method, workspace, params, expected) in [
        (
            2,
            "workspace.open",
            None,
            json!({"rootDir":root, "workspaceId":"workspace"}),
            ErrorCode::Forbidden,
        ),
        (
            3,
            "workspace.close",
            Some(handle),
            json!({}),
            ErrorCode::Forbidden,
        ),
        (
            4,
            "liveApplication.hosts",
            None,
            json!({"root":root}),
            ErrorCode::InvalidParams,
        ),
    ] {
        let Envelope::Error(error) = daemon.request(id, method, workspace, params) else {
            panic!("expected refusal")
        };
        assert_eq!(error.error.code, expected);
    }
    for (index, method) in [
        "engine.ping",
        "secrets.read",
        "versionedText.read",
        "versionedText.write",
        "sync.push",
        "versions.ensureMain",
        "liveApplication.arbitrary",
    ]
    .iter()
    .enumerate()
    {
        let Envelope::Error(error) = daemon.request(10 + index as u64, method, None, json!({}))
        else {
            panic!("configured method must refuse")
        };
        assert_eq!(error.error.code, ErrorCode::Forbidden, "{method}");
    }
    daemon.0.stdin.take();
    assert!(daemon.0.wait().unwrap().success());
    let store =
        dohc_engine_storage::EngineStore::open(&root.join(".dohc/engine/engine.db"), 0).unwrap();
    assert_eq!(
        store.table_row_count("moments").unwrap(),
        0,
        "configured hosts do not originate filesystem capture"
    );
}

#[test]
fn invalid_complete_configuration_never_opens_the_first_root() {
    let scratch = ScratchDir::new().unwrap();
    let root = scratch.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    let path = scratch.path().join("host.json");
    for case in 0..7 {
        let mut config = configuration(&root);
        match case {
            0 => config["extra"] = json!(true),
            1 => config["host"]["hostEpoch"] = json!(0),
            2 => config["workspaces"][0]["extra"] = json!(true),
            3 => config["workspaces"].as_array_mut().unwrap().push(json!({"root":scratch.path().join("missing"),"workspaceId":"second","maxRegistrations":1})),
            4 => config["ingress"]["aggregateBytes"] = json!(1),
            5 => config["ingress"]["uploadDeadlineMs"] = json!(u64::MAX),
            6 => config["workspaces"].as_array_mut().unwrap().push(json!({"root":root.join("."),"workspaceId":"second","maxRegistrations":1})),
            _ => unreachable!(),
        }
        std::fs::write(&path, config.to_string()).unwrap();
        let result = command(Some(&path)).output().unwrap();
        assert!(!result.status.success(), "case {case}");
        assert!(result.stdout.is_empty());
        assert!(
            !root.join(".dohc").exists(),
            "case {case} opened first root"
        );
    }
    std::fs::remove_file(&path).unwrap();
    assert!(!command(Some(&path)).output().unwrap().status.success());
    assert!(
        !command(Some(Path::new("relative-host.json")))
            .output()
            .unwrap()
            .status
            .success()
    );
    std::fs::write(&path, vec![b' '; 1024 * 1024 + 1]).unwrap();
    assert!(!command(Some(&path)).output().unwrap().status.success());
    assert!(!root.join(".dohc").exists());
}

#[test]
fn ordinary_daemon_has_no_host_and_configuration_does_not_bypass_auth() {
    let mut ordinary = Daemon(command(None).spawn().unwrap());
    ordinary.hello("configured-test-secret");
    assert!(matches!(ordinary.read(), Envelope::HelloAck(_)));
    let Envelope::Response(response) = ordinary.request(1, "engine.ping", None, json!({})) else {
        panic!("expected ping")
    };
    assert_eq!(response.result, json!({"ok":true}));
    assert!(matches!(
        ordinary.request(2, "liveApplication.hosts", None, json!({})),
        Envelope::Error(_)
    ));
    let scratch = ScratchDir::new().unwrap();
    let path = scratch.path().join("host.json");
    std::fs::write(&path, configuration(scratch.path()).to_string()).unwrap();
    let mut daemon = Daemon(command(Some(&path)).spawn().unwrap());
    daemon.hello("wrong-secret");
    let Envelope::Error(error) = daemon.read() else {
        panic!("expected auth refusal")
    };
    assert_eq!(error.error.code, ErrorCode::AuthFailed);
}

#[test]
fn ordinary_and_configured_processes_share_writer_exclusion_and_crash_release() {
    let scratch = ScratchDir::new().unwrap();
    let root = scratch.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    let path = scratch.path().join("host.json");
    std::fs::write(&path, configuration(&root).to_string()).unwrap();
    let mut first = Daemon(command(Some(&path)).spawn().unwrap());
    first.hello("configured-test-secret");
    assert!(matches!(first.read(), Envelope::HelloAck(_)));
    let alias = scratch.path().join("workspace-alias");
    let alias_config = scratch.path().join("alias.json");
    if dohc_engine_testkit::try_make_dir_alias(&root, &alias).unwrap() {
        std::fs::write(&alias_config, configuration(&alias).to_string()).unwrap();
        let aliased = command(Some(&alias_config)).output().unwrap();
        assert!(!aliased.status.success());
        assert!(String::from_utf8_lossy(&aliased.stderr).contains("workspace-owned"));
    } else {
        eprintln!("directory aliases unavailable; skipping alias refusal clause");
    }
    let second = command(Some(&path)).output().unwrap();
    assert!(!second.status.success());
    assert!(second.stdout.is_empty());
    assert!(String::from_utf8_lossy(&second.stderr).contains("workspace-owned"));
    let mut ordinary = Daemon(command(None).spawn().unwrap());
    ordinary.hello("configured-test-secret");
    assert!(matches!(ordinary.read(), Envelope::HelloAck(_)));
    let params = json!({"rootDir":root, "workspaceId":"workspace", "captureMode":"none"});
    let Envelope::Error(error) = ordinary.request(1, "workspace.open", None, params.clone()) else {
        panic!("second writer must refuse")
    };
    assert_eq!(error.error.code, ErrorCode::WorkspaceUnavailable);
    assert_eq!(error.error.message, "workspace-owned");
    first.0.kill().unwrap();
    first.0.wait().unwrap();
    let Envelope::Response(response) = ordinary.request(2, "workspace.open", None, params) else {
        panic!("crash must release writer")
    };
    let handle = serde_json::from_value(response.result["workspace"].clone()).unwrap();
    let ordinary_owned = command(Some(&path)).output().unwrap();
    assert!(!ordinary_owned.status.success());
    assert!(String::from_utf8_lossy(&ordinary_owned.stderr).contains("workspace-owned"));
    assert!(matches!(
        ordinary.request(3, "workspace.close", Some(handle), json!({})),
        Envelope::Response(_)
    ));
    let mut reopened = Daemon(command(Some(&path)).spawn().unwrap());
    reopened.hello("configured-test-secret");
    assert!(matches!(reopened.read(), Envelope::HelloAck(_)));
    reopened.0.stdin.take();
    assert!(reopened.0.wait().unwrap().success());
    assert!(root.join(".dohc/engine/engine.db.owner-lock").exists());
    let other_root = scratch.path().join("other-root");
    std::fs::create_dir_all(other_root.join(".dohc/engine")).unwrap();
    std::fs::hard_link(
        root.join(".dohc/engine/engine.db"),
        other_root.join(".dohc/engine/engine.db"),
    )
    .unwrap();
    std::fs::write(&alias_config, configuration(&other_root).to_string()).unwrap();
    let unbound_alias = command(Some(&alias_config)).output().unwrap();
    assert!(!unbound_alias.status.success());
    assert!(
        unbound_alias.stdout.is_empty(),
        "a hardlinked database cannot adopt another root"
    );
}
