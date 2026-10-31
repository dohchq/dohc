use super::*;
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::Stdio,
};

fn helper_command(role: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--ignored",
            "--exact",
            "tests::containment::helper",
            "--nocapture",
        ])
        .env_clear()
        .env("DOHC_CONTAINMENT_ROLE", role)
        .env("TEMP", std::env::temp_dir())
        .env("TMP", std::env::temp_dir())
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.env("SystemRoot", std::env::var_os("SystemRoot").unwrap());
    command
}
fn receipt(reader: &mut impl BufRead) -> Value {
    let mut line = String::new();
    loop {
        line.clear();
        assert!(
            reader.read_line(&mut line).unwrap() > 0,
            "helper exited before receipt"
        );
        if let Some(json) = line.strip_prefix("RECEIPT ") {
            return serde_json::from_str(json).unwrap();
        }
    }
}
fn publish(value: Value) {
    println!("RECEIPT {value}");
    std::io::stdout().flush().unwrap();
}
fn wait_dead(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while crate::platform::alive(pid) {
        assert!(
            Instant::now() < deadline,
            "process {pid} survived containment"
        );
        thread::yield_now();
    }
}
struct OwnedProcess(crate::platform::Process);
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        self.0.terminate();
    }
}

#[test]
#[ignore = "native child selected by containment tests"]
fn helper() {
    match std::env::var("DOHC_CONTAINMENT_ROLE").unwrap().as_str() {
        "park" => {
            publish(json!({"pid":std::process::id()}));
            loop {
                thread::park();
            }
        }
        #[cfg(unix)]
        "leave-group" => {
            crate::platform::leave_test_group();
            publish(json!({"pid":std::process::id()}));
            loop {
                thread::park();
            }
        }
        "grandchild" => {
            let result = helper_command("park")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            if let Ok(mut child) = result {
                child.kill().unwrap();
                child.wait().unwrap();
                std::process::exit(2);
            }
        }
        "tree" => {
            #[expect(
                clippy::zombie_processes,
                reason = "The outer test kills this group and checks both processes."
            )]
            let child = helper_command("park")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            publish(json!({"pid":child.id()}));
            loop {
                thread::park();
            }
        }
        "descriptor" => {
            let value = std::env::var("DOHC_EXTRA_HANDLE")
                .unwrap()
                .parse::<usize>()
                .unwrap();
            std::process::exit(i32::from(crate::platform::inherited(value)));
        }
        "supervisor" => {
            // Runtime discovery is test setup, outside the contained child's environment.
            let (dir, config) = fixture("ignore-eof");
            let reader = Reader::new(Some(config));
            assert!(run(reader.request(request("ok"))).is_ok());
            let _active = reader.request(request("hang"));
            wait(&reader, |s| s.queue.is_empty());
            let (pid, cwd) = reader
                .shared
                .state
                .lock()
                .unwrap()
                .lifecycle
                .2
                .clone()
                .unwrap();
            publish(json!({"pid":pid,"cwd":cwd,"fixture":dir.path()}));
            loop {
                thread::park();
            }
        }
        _ => panic!("unknown helper role"),
    }
    std::process::exit(0);
}

#[cfg(windows)]
#[test]
fn job_prevents_a_grandchild_even_without_node_permissions() {
    let (process, mut out, input, mut err) =
        crate::platform::spawn(&mut helper_command("grandchild")).unwrap();
    let mut owned = OwnedProcess(process);
    drop(input);
    let mut stdout = String::new();
    out.read_to_string(&mut stdout).unwrap();
    let mut stderr = String::new();
    err.read_to_string(&mut stderr).unwrap();
    assert_eq!(
        crate::platform::exit_code(&mut owned.0),
        Some(0),
        "{stdout}\n{stderr}"
    );
    owned.0.terminate();
}

#[test]
fn unrelated_inheritable_handle_or_descriptor_is_not_inherited() {
    let extra = crate::platform::extra_handle();
    let mut command = helper_command("descriptor");
    command.env("DOHC_EXTRA_HANDLE", extra.1.to_string());
    let (process, mut out, input, mut err) = crate::platform::spawn(&mut command).unwrap();
    let mut owned = OwnedProcess(process);
    drop(input);
    let mut stdout = String::new();
    out.read_to_string(&mut stdout).unwrap();
    let mut stderr = String::new();
    err.read_to_string(&mut stderr).unwrap();
    assert_eq!(
        crate::platform::exit_code(&mut owned.0),
        Some(0),
        "{stdout}\n{stderr}"
    );
    drop(extra);
}

#[cfg(unix)]
#[test]
fn termination_kills_the_whole_process_group() {
    let (process, out, input, _err) = crate::platform::spawn(&mut helper_command("tree")).unwrap();
    let mut owned = OwnedProcess(process);
    let pid = receipt(&mut BufReader::new(out))["pid"].as_u64().unwrap() as u32;
    owned.0.terminate();
    let deadline = Instant::now() + Duration::from_secs(10);
    while crate::platform::alive(pid) && Instant::now() < deadline {
        thread::yield_now();
    }
    let survived = crate::platform::alive(pid);
    if survived {
        crate::platform::kill_test_child(pid);
    }
    wait_dead(pid);
    drop(input);
    assert!(!survived, "grandchild {pid} survived group termination");
}

#[cfg(any(windows, target_os = "linux"))]
#[test]
fn killing_the_supervisor_also_kills_its_reader() {
    let mut command = helper_command("supervisor");
    // The helper discovers the installed runtime, rather than copying Node.
    command.env("PATH", std::env::var_os("PATH").unwrap());
    let mut helper = command.stderr(Stdio::inherit()).spawn().unwrap();
    let receipt = receipt(&mut BufReader::new(helper.stdout.take().unwrap()));
    let pid = receipt["pid"].as_u64().unwrap() as u32;
    helper.kill().unwrap();
    helper.wait().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while crate::platform::alive(pid) && Instant::now() < deadline {
        thread::yield_now();
    }
    let survived = crate::platform::alive(pid);
    if survived {
        crate::platform::kill_test_child(pid);
    }
    wait_dead(pid);
    for name in ["cwd", "fixture"] {
        let path = PathBuf::from(receipt[name].as_str().unwrap());
        assert!(path.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(path).unwrap();
    }
    assert!(!survived, "reader {pid} outlived its supervisor");
}

#[cfg(unix)]
#[test]
fn termination_reaps_a_reader_that_left_its_group() {
    let (process, out, _input, _err) =
        crate::platform::spawn(&mut helper_command("leave-group")).unwrap();
    let pid = receipt(&mut BufReader::new(out))["pid"].as_u64().unwrap() as u32;
    let (done, completion) = std::sync::mpsc::channel();
    let owner = thread::spawn(move || {
        let mut owned = OwnedProcess(process);
        owned.0.terminate();
        done.send(()).unwrap();
    });
    let terminated = completion.recv_timeout(Duration::from_secs(3)).is_ok();
    if !terminated {
        crate::platform::kill_test_child(pid);
    }
    owner.join().unwrap();
    wait_dead(pid);
    assert!(terminated, "termination waited on an escaped reader");
}

#[test]
fn native_spawn_reports_a_missing_executable() {
    let dir = tempfile::tempdir().unwrap();
    let mut command = Command::new(dir.path().join("absent.exe"));
    command.current_dir(dir.path());
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match crate::platform::spawn(&mut command) {
        Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::NotFound),
        Ok((process, _, _, _)) => {
            drop(OwnedProcess(process));
            panic!("spawn hid the exec error");
        }
    }
}

#[cfg(windows)]
#[test]
fn exceeding_the_process_memory_limit_reports_crashed() {
    let (_dir, config) = fixture("ok");
    let mut reader = Reader::new(Some(config));
    assert!(run(reader.request(request("ok"))).is_ok());
    fail(run(reader.request(request("memory"))), Failure::Crashed);
    finish(&mut reader);
}

#[cfg(windows)]
#[test]
fn a_reader_at_its_measured_peak_stays_under_the_process_memory_limit() {
    let (_dir, config) = fixture("ok");
    let mut reader = Reader::new(Some(config));
    assert!(run(reader.request(request("peak"))).is_ok());
    finish(&mut reader);
}

#[cfg(windows)]
#[test]
fn native_launch_preserves_empty_quoted_and_unicode_arguments() {
    let arguments = ["", "two words", "trailing\\", "a\\\"b", "Ω"];
    let mut command = Command::new(runtime().0);
    command
        .env_clear()
        .env("SystemRoot", std::env::var_os("SystemRoot").unwrap())
        .current_dir(std::env::temp_dir())
        .args([
            "-e",
            "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
            "--",
        ])
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let (process, mut out, input, _err) = crate::platform::spawn(&mut command).unwrap();
    let mut owned = OwnedProcess(process);
    drop(input);
    let mut output = Vec::new();
    out.read_to_end(&mut output).unwrap();
    assert_eq!(
        serde_json::from_slice::<Vec<String>>(&output).unwrap(),
        arguments
    );
    assert_eq!(crate::platform::exit_code(&mut owned.0), Some(0));
}
