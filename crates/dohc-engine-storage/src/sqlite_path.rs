use std::path::Path;

/// Use the ordinary Windows spelling when it names exactly the same file.
/// SQLite otherwise mistakes a verbatim drive path for UNC and shares SHM
/// handles whose concurrent read-lock bookkeeping can strand WAL readers.
pub(crate) fn sqlite_path(path: &Path) -> &Path {
    #[cfg(windows)]
    {
        let Some(text) = path.to_str() else {
            return path;
        };
        let Some(disk) = text.strip_prefix(r"\\?\") else {
            return path;
        };
        let bytes = disk.as_bytes();
        if bytes.len() < 3
            || !bytes[0].is_ascii_alphabetic()
            || &bytes[1..3] != b":\\"
            // Leave room for SQLite's -journal sidecar below MAX_PATH.
            || disk.encode_utf16().count() + "-journal".len() >= 260
        {
            return path;
        }
        for component in disk[3..].split('\\') {
            if component.is_empty()
                || component.ends_with(['.', ' '])
                || component.chars().any(|c| {
                    c <= '\u{1f}' || matches!(c, '<' | '>' | ':' | '"' | '/' | '|' | '?' | '*')
                })
            {
                return path;
            }
            let stem = component
                .split('.')
                .next()
                .unwrap_or("")
                .trim_end_matches(' ');
            let device = stem.eq_ignore_ascii_case("CON")
                || stem.eq_ignore_ascii_case("PRN")
                || stem.eq_ignore_ascii_case("AUX")
                || stem.eq_ignore_ascii_case("NUL")
                || stem.eq_ignore_ascii_case("CONIN$")
                || stem.eq_ignore_ascii_case("CONOUT$")
                || (stem.get(..3).is_some_and(|s| {
                    s.eq_ignore_ascii_case("COM") || s.eq_ignore_ascii_case("LPT")
                }) && matches!(
                    stem.get(3..),
                    Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
                ));
            if device {
                return path;
            }
        }
        Path::new(disk)
    }
    #[cfg(not(windows))]
    path
}

/// Open the store at `path`. On Linux a path that reaches its folder
/// through a descriptor the engine holds opens with the VFS that keeps that
/// path, so the store and every file SQLite opens beside it go through that
/// folder, not through whatever has its name.
pub(crate) fn open_store(
    path: &Path,
    flags: rusqlite::OpenFlags,
) -> rusqlite::Result<rusqlite::Connection> {
    #[cfg(target_os = "linux")]
    if dohc_linux_files::held::is_path_by_fd(path) {
        let vfs = dohc_linux_files::held::held_vfs().map_err(|err| {
            let code = rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CANTOPEN);
            rusqlite::Error::SqliteFailure(code, Some(err.to_string()))
        })?;
        return rusqlite::Connection::open_with_flags_and_vfs(path, flags, vfs);
    }
    rusqlite::Connection::open_with_flags(sqlite_path(path), flags)
}

#[cfg(all(test, not(windows)))]
mod non_windows_tests {
    use super::*;

    #[test]
    fn paths_are_unchanged() {
        for text in [
            "/tmp/engine.db",
            r"\\?\C:\work\engine.db",
            r"\\server\share",
        ] {
            let path = Path::new(text);
            assert!(std::ptr::eq(sqlite_path(path), path));
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn ordinary_drive_paths_are_simplified() {
        assert_eq!(
            sqlite_path(Path::new(r"\\?\C:\work\engine.db")),
            Path::new(r"C:\work\engine.db")
        );
        assert_eq!(
            sqlite_path(Path::new(r"C:\work\engine.db")),
            Path::new(r"C:\work\engine.db")
        );
    }

    #[test]
    fn unsafe_or_non_drive_paths_keep_their_spelling() {
        for path in [
            r"\\?\C:\work\..\engine.db",
            r"\\?\C:\work\.\engine.db",
            r"\\?\C:\work.\engine.db",
            r"\\?\C:\work \engine.db",
            r"\\?\C:\CON",
            r"\\?\C:\nul.db",
            r"\\?\C:\PRN.db.bak",
            r"\\?\C:\aux .db",
            r"\\?\C:\COM1.db",
            r"\\?\C:\LPT9",
            r"\\?\C:\bad:name",
            r"\\?\C:\bad?name",
            r"\\?\C:\bad/name",
            r"\\server\share\engine.db",
            r"\\?\UNC\server\share\engine.db",
        ] {
            assert_eq!(
                sqlite_path(Path::new(path)).as_os_str(),
                Path::new(path).as_os_str(),
                "{path}"
            );
        }
        let long = format!(r"\\?\C:\{}\engine.db", "a".repeat(260));
        assert_eq!(
            sqlite_path(Path::new(&long)).as_os_str(),
            Path::new(&long).as_os_str()
        );
    }

    #[test]
    fn length_limit_counts_utf16_units() {
        let boundary = format!(r"\\?\C:\{}", "a".repeat(248));
        assert_eq!(sqlite_path(Path::new(&boundary)), Path::new(&boundary[4..]));
        let too_long = format!("{boundary}a");
        assert_eq!(
            sqlite_path(Path::new(&too_long)).as_os_str(),
            Path::new(&too_long).as_os_str()
        );
        let short = format!(r"\\?\C:\{}", "\u{1f980}".repeat(124));
        assert_eq!(sqlite_path(Path::new(&short)), Path::new(&short[4..]));
        let long = format!(r"\\?\C:\{}", "\u{1f980}".repeat(125));
        assert_eq!(
            sqlite_path(Path::new(&long)).as_os_str(),
            Path::new(&long).as_os_str()
        );
    }

    #[test]
    fn reserved_devices_and_invalid_characters_keep_the_verbatim_path() {
        let mut names = vec![
            "CON".to_owned(),
            "prn".to_owned(),
            "Aux".to_owned(),
            "NUL".to_owned(),
            "CONIN$".to_owned(),
            "CONOUT$".to_owned(),
        ];
        for prefix in ["COM", "LPT"] {
            for digit in [
                "1", "2", "3", "4", "5", "6", "7", "8", "9", "\u{b9}", "\u{b2}", "\u{b3}",
            ] {
                names.push(format!("{prefix}{digit}"));
            }
        }
        for name in names {
            for suffix in ["", ".db", ".db.bak", " .db"] {
                let text = format!(r"\\?\C:\{name}{suffix}\engine.db");
                assert_eq!(
                    sqlite_path(Path::new(&text)).as_os_str(),
                    Path::new(&text).as_os_str()
                );
            }
        }
        for invalid in (0..=31)
            .map(char::from)
            .chain(['<', '>', ':', '"', '/', '|', '?', '*'])
        {
            let text = format!(r"\\?\C:\bad{invalid}name\engine.db");
            assert_eq!(
                sqlite_path(Path::new(&text)).as_os_str(),
                Path::new(&text).as_os_str()
            );
        }
        use std::os::windows::ffi::OsStringExt;
        let mut units: Vec<u16> = r"\\?\C:\".encode_utf16().collect();
        units.push(0xd800);
        let non_unicode = std::ffi::OsString::from_wide(&units);
        assert_eq!(
            sqlite_path(Path::new(&non_unicode)).as_os_str(),
            non_unicode
        );
    }
}

#[cfg(all(test, windows))]
#[test]
fn fresh_stores_create_and_reopen_at_path_length_boundary() {
    use crate::{EngineStore, NoFaults, StorageError};
    use dohc_test_scratch::ScratchDir;

    fn create_and_reopen(path: &Path) -> Result<(), StorageError> {
        let mut store = EngineStore::open(path, 0)?;
        store.write_with(&NoFaults, |tx| {
            tx.execute_batch("CREATE TABLE path_probe(n); INSERT INTO path_probe VALUES(42)")
                .map_err(StorageError::persist_public)
        })?;
        drop(store);
        let reopened = EngineStore::open(path, 1)?;
        let value: i64 = reopened.read_with(|conn| {
            conn.query_row("SELECT n FROM path_probe", [], |row| row.get(0))
                .map_err(StorageError::persist_public)
        })?;
        assert_eq!(value, 42);
        Ok(())
    }

    let mut failures = Vec::new();
    for units in 251..=255 {
        let scratch = ScratchDir::new().unwrap();
        let root_units = scratch.path().to_str().unwrap().encode_utf16().count();
        let parent = scratch.join("a".repeat(units - root_units - 11));
        std::fs::create_dir(&parent).unwrap();
        let path = std::fs::canonicalize(parent).unwrap().join("engine.db");
        assert_eq!(path.to_str().unwrap()[4..].encode_utf16().count(), units);
        match create_and_reopen(&path) {
            Ok(()) => eprintln!("plain path {units}: created and reopened"),
            Err(error) => failures.push(format!("plain path {units}: {error}")),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
