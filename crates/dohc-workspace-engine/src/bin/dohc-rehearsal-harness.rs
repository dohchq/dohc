//! Dispatch-only CLI for the harness-feature clone/reset rehearsal.

use dohc_workspace_engine::rehearsal_harness::{HarnessConfig, run};
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    match parse_args().and_then(|args| {
        run(HarnessConfig {
            source: &args.source,
            scratch: &args.scratch,
            recovery: &args.recovery,
        })
        .map_err(|error| error.to_string())
    }) {
        Ok(evidence) => {
            println!(
                "GATE6 rehearsal complete\nclone: {}\nevidence: {}/REHEARSAL_EVIDENCE.json",
                evidence.clone_path, evidence.recovery_path
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("dohc rehearsal harness refused or failed: {error}");
            ExitCode::FAILURE
        }
    }
}

struct Args {
    source: PathBuf,
    scratch: PathBuf,
    recovery: PathBuf,
}

fn parse_args() -> Result<Args, String> {
    let mut source = None;
    let mut scratch = None;
    let mut recovery = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(flag) = args.next() {
        let flag_text = flag.to_string_lossy();
        if flag_text == "--help" || flag_text == "-h" {
            return Err(usage().to_owned());
        }
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag_text}\n{}", usage()))?;
        match flag_text.as_ref() {
            "--source" => set_once(&mut source, PathBuf::from(value), "--source")?,
            "--scratch" => set_once(&mut scratch, PathBuf::from(value), "--scratch")?,
            "--recovery" => set_once(&mut recovery, PathBuf::from(value), "--recovery")?,
            _ => return Err(format!("unknown argument {flag_text}\n{}", usage())),
        }
    }
    Ok(Args {
        source: source.ok_or_else(|| format!("missing --source\n{}", usage()))?,
        scratch: scratch.ok_or_else(|| format!("missing --scratch\n{}", usage()))?,
        recovery: recovery.ok_or_else(|| format!("missing --recovery\n{}", usage()))?,
    })
}

fn set_once(slot: &mut Option<PathBuf>, value: PathBuf, flag: &str) -> Result<(), String> {
    if slot.replace(value).is_some() {
        return Err(format!("duplicate {flag}\n{}", usage()));
    }
    Ok(())
}

fn usage() -> &'static str {
    "usage: dohc-rehearsal-harness --source <real workspace root> --scratch <clone parent> --recovery <outside-root artifact dir>"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_values_are_rejected_by_the_slot_guard() {
        let mut slot = None;
        set_once(&mut slot, PathBuf::from("first"), "--source").expect("first");
        assert!(set_once(&mut slot, PathBuf::from("second"), "--source").is_err());
    }
}
