use dohc_engine_sync_http::HttpRelayTransport;

#[test]
fn socket_paths_must_be_absolute_and_credentials_nonempty() {
    assert!(
        HttpRelayTransport::new_unix_socket(std::path::Path::new("relay.sock"), "lease").is_err()
    );
    assert!(
        HttpRelayTransport::new_unix_socket(&std::env::temp_dir().join("relay.sock"), "").is_err()
    );
}

#[cfg(not(unix))]
#[test]
fn unsupported_socket_transport_never_falls_back_to_tcp() {
    let error =
        HttpRelayTransport::new_unix_socket(&std::env::temp_dir().join("relay.sock"), "lease")
            .unwrap_err();
    assert_eq!(
        error,
        dohc_engine_sync::RelayError::Local("relay-unix-socket-unavailable".into())
    );
}

#[cfg(unix)]
mod unix {
    use super::*;
    use dohc_engine_sync::{ProbeRequest, RelayTransport};
    use dohc_engine_testkit::ScratchDir;
    use std::{
        io::{Read, Write},
        os::unix::net::UnixListener,
    };

    fn probe() -> ProbeRequest {
        ProbeRequest {
            workspace_id: "w".into(),
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
        }
    }

    fn server(path: &std::path::Path, response: String) -> std::thread::JoinHandle<String> {
        let listener = UnixListener::bind(path).unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut received = Vec::new();
            while !received.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                received.push(byte[0]);
            }
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8(received).unwrap()
        })
    }

    #[test]
    fn pulls_through_the_socket_with_the_lease_and_api_version() {
        let root = ScratchDir::new().unwrap();
        let path = root.path().join("relay.sock");
        let body = r#"{"ops":[],"nextCursor":0,"hasMore":false}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let served = server(&path, response);
        let transport = HttpRelayTransport::new_unix_socket(&path, "private-lease").unwrap();
        assert!(!transport.probe(probe()).unwrap().has_content);
        let request = served.join().unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get /sync/w/log?"));
        assert!(request.contains("authorization: bearer private-lease\r\n"));
        assert!(request.contains("x-dohc-api-version: 1\r\n"));
    }

    #[test]
    fn redirects_and_missing_sockets_never_reach_tcp() {
        let root = ScratchDir::new().unwrap();
        let path = root.path().join("relay.sock");
        let served = server(&path, "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into());
        let transport = HttpRelayTransport::new_unix_socket(&path, "private-lease").unwrap();
        assert!(transport.probe(probe()).is_err());
        served.join().unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(transport.probe(probe()).is_err());
    }
}
