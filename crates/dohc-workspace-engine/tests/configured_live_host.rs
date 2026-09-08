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
    std::fs::write(&path, configuration(&root).to_string()).unwrap();
    let mut daemon = Daemon(command(Some(&path)).spawn().unwrap());
    daemon.hello("configured-test-secret");
    assert!(matches!(daemon.read(), Envelope::HelloAck(_)));
    let Envelope::Response(response) = daemon.request(1, "liveApplication.hosts", None, json!({}))
    else {
        panic!("expected discovery")
    };
    assert_eq!(response.result["relayNamespace"], "configured-test-relay");
    assert_eq!(response.result["host"], configuration(&root)["host"]);
    assert_eq!(response.result["workspaces"].as_array().unwrap().len(), 1);
    assert_eq!(response.result["workspaces"][0]["workspaceId"], "workspace");
    assert!(!response.result.to_string().contains("root"));
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
