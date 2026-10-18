//! The owner's command line, written by `compilerProcessSupervisor.ts`:
//!
//! `<memory bytes> <max processes> <timeout ms> <input bytes> <compiler root>
//! <build directory> <node> <worker> [worker arguments...]`
use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

pub struct Args {
    pub memory_bytes: u64,
    pub max_processes: usize,
    pub timeout: Duration,
    pub input_bytes: u64,
    pub root: PathBuf,
    pub build: PathBuf,
    pub node: PathBuf,
    pub worker: PathBuf,
    pub worker_args: Vec<OsString>,
}

fn number(name: &str, value: Option<OsString>, minimum: u64) -> Result<u64, String> {
    let parsed = value
        .as_deref()
        .and_then(|value| value.to_str())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| format!("The {name} is missing or not a number."))?;
    if parsed < minimum {
        return Err(format!("The {name} must be at least {minimum}."));
    }
    Ok(parsed)
}

/// The resolved path, so the sandbox profile names the file Seatbelt sees.
fn canonical(name: &str, value: Option<OsString>, directory: bool) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.ok_or_else(|| format!("The {name} is missing."))?);
    if !path.is_absolute() {
        return Err(format!("The {name} {} must be absolute.", path.display()));
    }
    let resolved = fs::canonicalize(&path)
        .map_err(|error| format!("The {name} {}: {error}", path.display()))?;
    let metadata = fs::metadata(&resolved)
        .map_err(|error| format!("The {name} {}: {error}", path.display()))?;
    if metadata.is_dir() != directory {
        let kind = if directory { "a directory" } else { "a file" };
        return Err(format!("The {name} {} is not {kind}.", path.display()));
    }
    Ok(resolved)
}

impl Args {
    pub fn parse(mut args: impl Iterator<Item = OsString>) -> Result<Args, String> {
        args.next();
        let memory_bytes = number("memory bound", args.next(), 1)?;
        let max_processes = usize::try_from(number("process bound", args.next(), 1)?)
            .map_err(|_| "The process bound is too large.".to_owned())?;
        let timeout_ms = number("timeout", args.next(), 1)?;
        let input_bytes = number("input length", args.next(), 0)?;
        let root = canonical("compiler root", args.next(), true)?;
        let build = canonical("build directory", args.next(), true)?;
        let node = canonical("Node runtime", args.next(), false)?;
        let worker = canonical("compiler worker", args.next(), false)?;
        if !worker.starts_with(&root) {
            return Err("The compiler worker must be inside the compiler root.".to_owned());
        }
        if build.starts_with(&root) || root.starts_with(&build) {
            return Err("The build directory and the compiler root must not overlap.".to_owned());
        }
        Ok(Args {
            memory_bytes,
            max_processes,
            timeout: Duration::from_millis(timeout_ms),
            input_bytes,
            root,
            build,
            node,
            worker,
            worker_args: args.collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn scratch(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("dohc-compiler-owner-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(directory.join("root")).unwrap();
        fs::create_dir_all(directory.join("build")).unwrap();
        fs::write(directory.join("root/worker.mjs"), "").unwrap();
        fs::write(directory.join("node"), "").unwrap();
        directory
    }

    fn parse(values: &[&str]) -> Result<Args, String> {
        Args::parse(
            std::iter::once("owner")
                .chain(values.iter().copied())
                .map(OsString::from),
        )
    }

    #[test]
    fn resolves_symlinks_and_keeps_worker_arguments() {
        let directory = scratch("resolves");
        symlink(directory.join("root"), directory.join("linked-root")).unwrap();
        let path = |name: &str| directory.join(name).to_str().unwrap().to_owned();
        let args = parse(&[
            "1024",
            "8",
            "60000",
            "5",
            &path("linked-root"),
            &path("build"),
            &path("node"),
            &path("linked-root/worker.mjs"),
            "a",
            "b",
        ])
        .unwrap();
        let real = fs::canonicalize(directory.join("root")).unwrap();
        assert_eq!(args.root, real);
        assert_eq!(args.worker, real.join("worker.mjs"));
        assert_eq!(args.worker_args, [OsString::from("a"), OsString::from("b")]);
        assert_eq!(args.timeout, Duration::from_millis(60000));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn refuses_bad_bounds_and_paths() {
        let directory = scratch("refuses");
        let path = |name: &str| directory.join(name).to_str().unwrap().to_owned();
        let (root, build, node, worker) = (
            path("root"),
            path("build"),
            path("node"),
            path("root/worker.mjs"),
        );
        assert!(parse(&["0", "8", "1", "0", &root, &build, &node, &worker]).is_err());
        assert!(parse(&["1", "x", "1", "0", &root, &build, &node, &worker]).is_err());
        assert!(parse(&["1", "8", "1", "0", "relative", &build, &node, &worker]).is_err());
        assert!(
            parse(&["1", "8", "1", "0", &root, &build, &node, &node]).is_err(),
            "worker outside root"
        );
        assert!(
            parse(&["1", "8", "1", "0", &root, &root, &node, &worker]).is_err(),
            "overlapping build directory"
        );
        assert!(
            parse(&["1", "8", "1", "0", &root, &build, &root, &worker]).is_err(),
            "Node must be a file"
        );
        assert!(parse(&["1", "8", "1", "0", &root, &build, &node, &worker]).is_ok());
        fs::remove_dir_all(directory).unwrap();
    }
}
