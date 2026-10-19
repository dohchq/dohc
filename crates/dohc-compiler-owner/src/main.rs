//! Owns one desktop app compile on macOS: confines the Node worker and esbuild
//! with Seatbelt, bounds their time, memory and process count, and stops
//! every process they started. The desktop runs it from
//! `compilerProcessSupervisor.ts`. Windows uses a job object instead, and
//! Linux has no owner yet. See docs/engineering/app-compiler.md.
#[cfg(target_os = "macos")]
mod args;
#[cfg(target_os = "macos")]
mod profile;
#[cfg(target_os = "macos")]
mod supervise;
#[cfg(target_os = "macos")]
mod sys;
#[cfg(target_os = "macos")]
mod tree;

#[cfg(target_os = "macos")]
fn main() -> std::process::ExitCode {
    supervise::main()
}

#[cfg(not(target_os = "macos"))]
fn main() -> std::process::ExitCode {
    eprintln!("The app compiler owner runs only on macOS.");
    std::process::ExitCode::from(126)
}
