//! The Seatbelt profile that confines the worker and esbuild.
//!
//! Deny by default. The tree may run only the installed Node and esbuild,
//! read those, the compiler root and the OS libraries, and read and write its
//! own build directory. It has no network and no Mach services, and may
//! signal or inspect only processes inside the same sandbox, so never the
//! owner. It may read only the sysctls Node and esbuild read at startup, so
//! it is refused process listings and machine identifiers. Seatbelt does not
//! mediate `kern.procargs2`, so a compromised worker can still read other
//! processes' arguments and environment; see docs/engineering/app-compiler.md.
//! Path metadata stays readable everywhere: Node aborts at startup without it.
use std::ffi::CString;
use std::path::Path;

/// The esbuild binary's package for the owner's own architecture.
const ESBUILD: &str = if cfg!(target_arch = "aarch64") {
    "node_modules/@esbuild/darwin-arm64/bin/esbuild"
} else {
    "node_modules/@esbuild/darwin-x64/bin/esbuild"
};

/// An SBPL string literal for a canonical absolute path. Refuses paths that
/// are not UTF-8 or that hold control characters, which SBPL or a log line
/// could misread.
fn literal(path: &Path) -> Result<String, String> {
    let text = path
        .to_str()
        .ok_or_else(|| format!("{} is not valid UTF-8.", path.display()))?;
    if !text.starts_with('/') || text.chars().any(char::is_control) {
        return Err(format!("{text:?} cannot appear in the compiler sandbox."));
    }
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for character in text.chars() {
        if character == '"' || character == '\\' {
            quoted.push('\\');
        }
        quoted.push(character);
    }
    quoted.push('"');
    Ok(quoted)
}

/// `root`, `node` and `build` must already be canonical, because Seatbelt
/// matches the resolved path of every file the tree opens.
pub fn profile(root: &Path, node: &Path, build: &Path) -> Result<CString, String> {
    let esbuild = literal(&root.join(ESBUILD))?;
    let (root, node, build) = (literal(root)?, literal(node)?, literal(build)?);
    let text = format!(
        r#"(version 1)
(deny default)
(allow process-exec (literal {node}) (literal {esbuild}))
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read
  (sysctl-name-prefix "hw.") (sysctl-name-prefix "machdep.cpu.")
  (sysctl-name "kern.hostname") (sysctl-name "kern.osrelease") (sysctl-name "kern.ostype") (sysctl-name "kern.osversion")
  (sysctl-name "kern.version") (sysctl-name "kern.osproductversion") (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.iossupportversion") (sysctl-name "kern.maxfilesperproc") (sysctl-name "sysctl.proc_translated"))
(allow file-read-metadata)
(allow file-read-data (literal "/"))
(allow file-read* (literal {node}) (subpath {root}) (subpath {build})
  (subpath "/usr/lib") (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes")
  (subpath "/private/var/db/dyld") (subpath "/Library/Apple/System")
  (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))
(allow file-write* (subpath {build}))
(allow file-write-data (literal "/dev/null"))
(deny file-map-executable (subpath {build}))
"#
    );
    CString::new(text).map_err(|_| "The compiler sandbox profile holds a NUL byte.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    #[test]
    fn quotes_and_backslashes_are_escaped() {
        assert_eq!(
            literal(Path::new(r#"/a "b" \c"#)).unwrap(),
            r#""/a \"b\" \\c""#
        );
    }

    #[test]
    fn refuses_paths_sbpl_could_misread() {
        for path in ["relative/path", "/new\nline", "/tab\there", "/bell\u{7}"] {
            assert!(literal(Path::new(path)).is_err(), "{path:?}");
        }
        assert!(literal(Path::new(OsStr::from_bytes(b"/not-utf8-\xff"))).is_err());
    }

    #[test]
    fn grants_each_path_its_own_rule() {
        let text = profile(Path::new("/r"), Path::new("/n"), Path::new("/b")).unwrap();
        let text = text.to_str().unwrap();
        assert!(text.starts_with("(version 1)\n(deny default)\n"));
        let esbuild = format!("/r/{ESBUILD}");
        assert!(text.contains(&format!(
            r#"(allow process-exec (literal "/n") (literal "{esbuild}"))"#
        )));
        assert!(text.contains(r#"(allow file-write* (subpath "/b"))"#));
        // Every rule that grants a sysctl names it.
        assert!(text.contains("(allow sysctl-read\n  (sysctl-name"));
        for absent in [
            "network",
            "mach-lookup",
            "dtracehelper",
            "kern.proc",
            "(allow sysctl-read)",
        ] {
            assert!(!text.contains(absent), "{absent} may not appear");
        }
    }
}
