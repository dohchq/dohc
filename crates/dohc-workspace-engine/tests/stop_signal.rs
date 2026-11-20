#![cfg(unix)]

use dohc_engine_protocol::limits::WireLimits;
use dohc_engine_protocol::wire::{
    Envelope, Hello, PROTOCOL_VERSION, Request, decode_control, encode_control,
};
use serde_json::json;
use std::io::{Read, Write};
use std::process::{ChildStdin, ChildStdout, Command, Stdio};

fn send(input: &mut ChildStdin, envelope: Envelope) {
    input
        .write_all(&encode_control(&envelope, &WireLimits::default()).unwrap())
        .unwrap();
}

fn read(output: &mut ChildStdout) -> Envelope {
    let mut header = [0; 12];
    output.read_exact(&mut header).unwrap();
    assert_eq!(&header[..4], b"DOP1");
    let length = u32::from_le_bytes(header[8..12].try_into().unwrap()) as usize;
    let mut payload = vec![0; length];
    output.read_exact(&mut payload).unwrap();
    decode_control(&payload, &WireLimits::default()).unwrap()
}

#[test]
fn stop_signals_leave_the_engine_answering_until_its_input_closes() {
    let mut engine = Command::new(env!("CARGO_BIN_EXE_dohc-workspace-engine"))
        .env("DOHC_ENGINE_AUTH_TOKEN", "stop-signal-secret")
        .env_remove("DOHC_ENGINE_LIVE_HOST_CONFIG")
        .env_remove("DOHC_ENGINE_OWNER_HOST_CONFIG")
        .env_remove("DOHC_ENGINE_READER_CONFIG")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut input = engine.stdin.take().unwrap();
    let mut output = engine.stdout.take().unwrap();
    send(
        &mut input,
        Envelope::Hello(Hello {
            protocol_version: PROTOCOL_VERSION,
            auth_token: "stop-signal-secret".into(),
            capabilities: vec![],
            last_session_generation: None,
            max_frame_bytes: None,
        }),
    );
    assert!(matches!(read(&mut output), Envelope::HelloAck(_)));

    let pid = i32::try_from(engine.id()).unwrap();
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        assert_eq!(unsafe { libc::kill(pid, signal) }, 0);
    }

    send(
        &mut input,
        Envelope::Request(Request {
            id: 1,
            method: "engine.ping".into(),
            workspace: None,
            deadline_ms: Some(30_000),
            idempotency_key: None,
            progress: false,
            params: json!({}),
        }),
    );
    let answer = loop {
        match read(&mut output) {
            Envelope::Event(_) => continue,
            envelope => break envelope,
        }
    };
    assert!(
        matches!(&answer, Envelope::Response(response) if response.id == 1),
        "the engine answers after the signals: {answer:?}"
    );

    drop(input);
    let status = engine.wait().unwrap();
    assert!(
        status.success(),
        "the engine exits cleanly once its input closes: {status}"
    );
}
