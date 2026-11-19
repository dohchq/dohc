//! The folders and files the file change feed reads.
//!
//! On Unix each folder opens from its parent's handle and never through a
//! link, so a folder swapped for a link during a scan can't send the walk
//! outside the workspace. A folder moved out of the workspace while
//! its handle is held is still listed under its old path for that scan.
//! On Windows a folder or file opens by its path and is refused unless the
//! handle is still at that path, so a link on the way can't lead outside
//! either. No folder stays open there while its subfolders are walked, since
//! that would stop their ancestors from being renamed.

use std::io;

/// An entry's size and times, read without following a link.
pub(super) struct Facts {
    pub symlink: bool,
    pub size: u64,
    pub modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    pub changed: (i64, i64),
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Folder,
    File,
    Symlink,
    #[cfg(unix)]
    Other,
}

/// A file's contents, read only when it is a regular file under the cap.
pub(super) struct Contents {
    /// The facts of the file that was read, from the open handle, when the
    /// platform reads them there.
    pub facts: Option<Facts>,
    pub digest: Option<[u8; 32]>,
}

fn digest(mut file: impl io::Read, cap: u64) -> Option<[u8; 32]> {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    let mut buffer = vec![0; 64 * 1024];
    let mut bytes = 0u64;
    loop {
        let read = match file.read(&mut buffer) {
            Ok(0) => {
                let mut digest = [0; 32];
                digest.copy_from_slice(&hasher.finalize());
                return Some(digest);
            }
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return None,
        };
        bytes = bytes.saturating_add(read as u64);
        if bytes > cap {
            return None;
        }
        hasher.update(&buffer[..read]);
    }
}

#[cfg(unix)]
pub(super) use unix::{Child, Folder};

#[cfg(unix)]
mod unix {
    use super::{Contents, Facts, Kind};
    use rustix::fd::OwnedFd;
    use rustix::fs::{AtFlags, FileType, Mode, OFlags};
    use std::borrow::Cow;
    use std::ffi::{CStr, CString, OsStr};
    use std::io;
    use std::os::unix::ffi::OsStrExt;
    use std::rc::Rc;

    const FOLDER: OFlags = OFlags::RDONLY
        .union(OFlags::DIRECTORY)
        .union(OFlags::NONBLOCK)
        .union(OFlags::CLOEXEC);

    /// One path component: never empty, `.`, `..`, or holding a `/`.
    struct Name(CString);

    impl Name {
        fn new(name: &CStr) -> Option<Self> {
            let bytes = name.to_bytes();
            (!matches!(bytes, b"" | b"." | b"..") && !bytes.contains(&b'/'))
                .then(|| Self(name.to_owned()))
        }
    }

    /// An open folder. Clones share one handle.
    #[derive(Clone)]
    pub(in super::super) struct Folder(Rc<Handle>);

    struct Handle(OwnedFd);

    impl Handle {
        fn new(fd: OwnedFd) -> Rc<Self> {
            #[cfg(test)]
            OPEN.with(|open| {
                let (now, most) = open.get();
                open.set((now + 1, most.max(now + 1)));
            });
            Rc::new(Self(fd))
        }
    }

    #[cfg(test)]
    impl Drop for Handle {
        fn drop(&mut self) {
            OPEN.with(|open| {
                let (now, most) = open.get();
                open.set((now - 1, most));
            });
        }
    }

    #[cfg(test)]
    thread_local! {
        /// Folder handles open now, and the most open at once.
        pub(in super::super) static OPEN: std::cell::Cell<(usize, usize)> =
            const { std::cell::Cell::new((0, 0)) };
    }

    pub(in super::super) struct Child {
        name: Name,
        kind: FileType,
    }

    impl Child {
        pub(in super::super) fn name(&self) -> Cow<'_, str> {
            OsStr::from_bytes(self.name.0.to_bytes()).to_string_lossy()
        }
    }

    impl Folder {
        /// The workspace root. A link at the root itself is followed, as the
        /// workspace path names it.
        pub(in super::super) fn root(path: &std::path::Path) -> io::Result<Self> {
            Ok(Self(Handle::new(rustix::fs::open(
                path,
                FOLDER,
                Mode::empty(),
            )?)))
        }

        pub(in super::super) fn open(&self, child: &Child) -> io::Result<Self> {
            Ok(self.open_name(&child.name)?)
        }

        fn open_name(&self, name: &Name) -> rustix::io::Result<Self> {
            // NOFOLLOW guards only the last component. `Name` is one
            // component and the parent is a handle, so nothing else resolves.
            let flags = FOLDER | OFlags::NOFOLLOW;
            let folder = rustix::fs::openat(&self.0.0, &name.0, flags, Mode::empty())?;
            Ok(Self(Handle::new(folder)))
        }

        pub(in super::super) fn list(
            &self,
        ) -> io::Result<impl Iterator<Item = io::Result<Child>> + use<>> {
            let entries = rustix::fs::Dir::read_from(&self.0.0)?;
            Ok(entries.filter_map(|entry| match entry {
                Err(error) => Some(Err(error.into())),
                Ok(entry) => Some(Ok(Child {
                    name: Name::new(entry.file_name())?,
                    kind: entry.file_type(),
                })),
            }))
        }

        fn stat(&self, name: &Name) -> io::Result<rustix::fs::Stat> {
            Ok(rustix::fs::statat(
                &self.0.0,
                &name.0,
                AtFlags::SYMLINK_NOFOLLOW,
            )?)
        }

        pub(in super::super) fn kind(&self, child: &Child) -> io::Result<Kind> {
            // Some volumes don't report types while listing.
            let kind = match child.kind {
                FileType::Unknown => FileType::from_raw_mode(self.stat(&child.name)?.st_mode),
                kind => kind,
            };
            Ok(match kind {
                FileType::Directory => Kind::Folder,
                FileType::RegularFile => Kind::File,
                FileType::Symlink => Kind::Symlink,
                _ => Kind::Other,
            })
        }

        pub(in super::super) fn facts(&self, child: &Child) -> io::Result<Facts> {
            Ok(facts(&self.stat(&child.name)?))
        }

        pub(in super::super) fn read(&self, child: &Child, cap: u64) -> Contents {
            // An ordinary open of a FIFO waits for a writer and would stall
            // the feed, so the open doesn't block and only a regular file is
            // read.
            let flags = OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC;
            let opened = rustix::fs::openat(&self.0.0, &child.name.0, flags, Mode::empty())
                .and_then(|file| Ok((rustix::fs::fstat(&file)?, file)));
            match opened {
                Ok((stat, file))
                    if FileType::from_raw_mode(stat.st_mode) == FileType::RegularFile =>
                {
                    let facts = facts(&stat);
                    let digest = (facts.size <= cap)
                        .then(|| super::digest(std::fs::File::from(file), cap))
                        .flatten();
                    Contents {
                        facts: Some(facts),
                        digest,
                    }
                }
                _ => Contents {
                    facts: None,
                    digest: None,
                },
            }
        }

        /// `.dohc/visibility.toml`, with the folder that holds it, or the
        /// facts of a `.dohc` that isn't a folder. Neither is followed.
        pub(in super::super) fn policy(&self) -> io::Result<(Facts, Option<(Self, Child)>)> {
            let dohc = Name(c".dohc".to_owned());
            let folder = match self.open_name(&dohc) {
                Ok(folder) => folder,
                // A link or file in its place still changes the policy
                // verdict, so its own facts are listed.
                Err(rustix::io::Errno::LOOP | rustix::io::Errno::NOTDIR) => {
                    return Ok((facts(&self.stat(&dohc)?), None));
                }
                Err(error) => return Err(error.into()),
            };
            // Tests swap `.dohc` here, after it opened and before its file is read.
            super::super::before_open(".dohc");
            let child = Child {
                name: Name(c"visibility.toml".to_owned()),
                kind: FileType::Unknown,
            };
            let facts = folder.facts(&child)?;
            Ok((facts, Some((folder, child))))
        }
    }

    // Field types differ between targets.
    #[allow(clippy::unnecessary_fallible_conversions, clippy::useless_conversion)]
    fn facts(stat: &rustix::fs::Stat) -> Facts {
        let modified = (|| {
            let seconds = i64::try_from(stat.st_mtime).ok()?;
            let nanos = u32::try_from(stat.st_mtime_nsec).ok()?;
            let since = std::time::Duration::new(seconds.unsigned_abs(), 0);
            let whole = if seconds < 0 {
                std::time::UNIX_EPOCH.checked_sub(since)
            } else {
                std::time::UNIX_EPOCH.checked_add(since)
            };
            whole?.checked_add(std::time::Duration::from_nanos(nanos.into()))
        })();
        Facts {
            symlink: FileType::from_raw_mode(stat.st_mode) == FileType::Symlink,
            size: u64::try_from(stat.st_size).unwrap_or(0),
            modified,
            changed: (
                i64::try_from(stat.st_ctime).unwrap_or(0),
                i64::try_from(stat.st_ctime_nsec).unwrap_or(0),
            ),
        }
    }
}

#[cfg(windows)]
pub(super) use windows::{Child, Folder};

#[cfg(windows)]
mod windows {
    use super::{Contents, Facts, Kind};
    use dohc_windows_files::in_place::{self, Entry};
    use std::borrow::Cow;
    use std::io;
    use std::path::PathBuf;
    use std::rc::Rc;

    /// A folder by its path from the workspace root's real path. Each open
    /// under it is refused unless it is still at that path.
    #[derive(Clone)]
    pub(in super::super) struct Folder(Rc<PathBuf>);

    pub(in super::super) struct Child(Entry);

    impl Child {
        pub(in super::super) fn name(&self) -> Cow<'_, str> {
            self.0.name.to_string_lossy()
        }
    }

    impl Folder {
        /// The workspace root. A link at the root itself is followed, as the
        /// workspace path names it.
        pub(in super::super) fn root(path: &std::path::Path) -> io::Result<Self> {
            Ok(Self(Rc::new(in_place::root(path)?)))
        }

        pub(in super::super) fn open(&self, child: &Child) -> io::Result<Self> {
            Ok(Self(Rc::new(self.0.join(&child.0.name))))
        }

        pub(in super::super) fn list(
            &self,
        ) -> io::Result<impl Iterator<Item = io::Result<Child>> + use<>> {
            Ok(in_place::list(&self.0)?.map(|entry| entry.map(Child)))
        }

        pub(in super::super) fn kind(&self, child: &Child) -> io::Result<Kind> {
            Ok(if child.0.link {
                Kind::Symlink
            } else if child.0.folder {
                Kind::Folder
            } else {
                Kind::File
            })
        }

        pub(in super::super) fn facts(&self, child: &Child) -> io::Result<Facts> {
            Ok(Facts {
                symlink: child.0.link,
                size: child.0.size,
                modified: child.0.modified,
            })
        }

        pub(in super::super) fn read(&self, child: &Child, cap: u64) -> Contents {
            let opened = in_place::open_file(&self.0.join(&child.0.name))
                .and_then(|file| Ok((file.metadata()?, file)));
            match opened {
                Ok((metadata, file)) if metadata.is_file() => {
                    let facts = facts(&metadata);
                    let digest = (facts.size <= cap)
                        .then(|| super::digest(file, cap))
                        .flatten();
                    Contents {
                        facts: Some(facts),
                        digest,
                    }
                }
                _ => Contents {
                    facts: None,
                    digest: None,
                },
            }
        }

        /// `.dohc/visibility.toml`, with the folder that holds it, or the
        /// facts of a `.dohc` that isn't a folder. Neither is followed.
        pub(in super::super) fn policy(&self) -> io::Result<(Facts, Option<(Self, Child)>)> {
            let (parent, dohc) = in_place::open_entry(&self.0.join(".dohc"))?;
            let parent = parent.metadata()?;
            if !parent.is_dir() {
                // A link or file in its place still changes the policy
                // verdict, so its own facts are listed.
                return Ok((facts(&parent), None));
            }
            // Tests swap `.dohc` here, after it opened and before its file is read.
            super::super::before_open(".dohc");
            let folder = Self(Rc::new(dohc));
            let (file, _) = in_place::open_entry(&folder.0.join("visibility.toml"))?;
            let metadata = file.metadata()?;
            let child = Child(Entry {
                name: "visibility.toml".into(),
                folder: metadata.is_dir(),
                link: metadata.is_symlink(),
                size: metadata.len(),
                modified: metadata.modified().ok(),
            });
            Ok((facts(&metadata), Some((folder, child))))
        }
    }

    fn facts(metadata: &std::fs::Metadata) -> Facts {
        Facts {
            symlink: metadata.is_symlink(),
            size: metadata.len(),
            modified: metadata.modified().ok(),
        }
    }
}
