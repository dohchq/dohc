//! Owns one desktop app compile on macOS and Linux: confines the Node worker
//! and esbuild, with Seatbelt on macOS and Landlock and seccomp on Linux,
//! bounds their time, memory and process count, and stops every process they
//! started. The desktop runs it from `compilerProcessSupervisor.ts`. Windows
//! uses a job object instead. See docs/engineering/app-compiler.md.
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod args;
#[cfg(target_os = "macos")]
mod profile;
#[cfg(target_os = "linux")]
mod rules;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod supervise;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod sys;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod tree;

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn main() -> std::process::ExitCode {
    supervise::main()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn main() -> std::process::ExitCode {
    eprintln!("The app compiler owner runs only on macOS and Linux.");
    std::process::ExitCode::from(126)
}
