//! Keep a folder private to this user, as a user's profile folder is.

use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Component, Path, PathBuf};

use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED, HANDLE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SDDL_REVISION_1, SE_FILE_OBJECT, SetSecurityInfo,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION,
    GetAce, GetSecurityDescriptorControl, GetSecurityDescriptorDacl, GetTokenInformation,
    INHERIT_ONLY_ACE, INHERITED_ACE, InitializeAcl, OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSID, SE_DACL_PROTECTED, SECURITY_ATTRIBUTES,
    SetKernelObjectSecurity, TOKEN_QUERY, TOKEN_USER, TokenUser,
    UNPROTECTED_DACL_SECURITY_INFORMATION,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, FILE_ALL_ACCESS, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_ID_INFO, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_REMOTE_PROTOCOL_INFO,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FileIdInfo, FileRemoteProtocolInfo,
    GetFileInformationByHandleEx, GetVolumeInformationByHandleW, READ_CONTROL, WRITE_DAC,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// `FILE_PERSISTENT_ACLS` in `<winnt.h>`: the volume keeps a DACL.
const FILE_PERSISTENT_ACLS: u32 = 0x8;

/// `ACCESS_ALLOWED_ACE_TYPE` in `<winnt.h>`.
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

/// SYSTEM and BUILTIN\Administrators, whom the DACL admits besides this
/// user, and who may own the folder and what is in it.
const SYSTEM: &str = "S-1-5-18";
const ADMINISTRATORS: &str = "S-1-5-32-544";

/// Open access that keeps a folder, and the folders above it, where they are
/// while the handle is open. Access to metadata alone takes no part in
/// sharing, so it would not.
const HOLD: u32 = FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES;

/// What is at a path that dohc refuses to keep private.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotPrivateReason {
    /// A junction, a symbolic link, a mount point, or any other reparse
    /// point that names another item.
    Link,
    NotFolder,
    /// Another account owns the item, or something in the folder, or this
    /// user can't open it or change its DACL.
    OtherOwner,
    /// This user, Administrators or SYSTEM owns the folder, but this user
    /// can't open it with what dohc needs, such as changing its DACL, as when
    /// Administrators own it and give this user Modify.
    NotChangeable,
}

impl NotPrivateReason {
    /// The reason as the engine sends it.
    pub fn code(self) -> &'static str {
        match self {
            NotPrivateReason::Link => "link",
            NotPrivateReason::NotFolder => "not-folder",
            NotPrivateReason::OtherOwner => "other-owner",
            NotPrivateReason::NotChangeable => "not-changeable",
        }
    }
}

/// dohc refuses to keep `path` private because of what is there. `path` is
/// relative to the folder the caller started from, with `/` between its
/// parts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotPrivate {
    pub path: String,
    pub reason: NotPrivateReason,
}

impl std::fmt::Display for NotPrivate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let what = match self.reason {
            NotPrivateReason::Link => "is a link",
            NotPrivateReason::NotFolder => "is not a folder",
            NotPrivateReason::OtherOwner => "belongs to another user",
            NotPrivateReason::NotChangeable => "has permissions dohc can't use",
        };
        write!(f, "{} {what}, so dohc can't keep it private", self.path)
    }
}

impl std::error::Error for NotPrivate {}

/// The [`NotPrivate`] refusal `err` carries, if it is one.
pub fn not_private(err: &io::Error) -> Option<&NotPrivate> {
    err.get_ref()?.downcast_ref()
}

/// Create the folder `relative` in `base`, and any missing folder between
/// them, or take the one already there, and make it private: give it the
/// DACL of a user's profile folder, full control for SYSTEM, Administrators
/// and this user and nothing inherited from the folders above, and give
/// everything in it only what it inherits from that. Windows lets anyone a
/// file's own DACL admits open it by its full path, even in a folder they
/// can't list, so what is in the folder needs the change as much as the
/// folder does. A folder this call creates gets the DACL as it is created.
///
/// `base` may be or lie under a link. A link at any part of `relative`, or
/// anything that is not a folder, is refused as [`NotPrivate`] before
/// anything is created in it or changed. So is a part another account owns,
/// since an owner can always read an item and change its DACL. Only this
/// user, Administrators and SYSTEM may own the folders and what is in them.
///
/// Each folder on the way to it, such as `.dohc`, gets the same DACL on
/// itself alone, and nothing in it changes: an item already in it keeps its
/// own entries. With that DACL, no other account may add anything to the
/// folder on the way.
///
/// After the folder's DACL changes, everything in it is checked. An item
/// with entries of its own, or a protected DACL, is given only what the
/// folder gives it, as is one Windows left as it was. An item another
/// account owns, or one this user can't change, refuses the folder. Only
/// then is the folder recorded outside the workspace, in
/// `%LOCALAPPDATA%\dohc\private`, and a later call that finds its record,
/// and the folder's DACL right, changes nothing.
///
/// On a volume that keeps no DACL, such as FAT32 or exFAT, on one that
/// reports DACLs but can't read or set one, and on a network share, whose
/// server keeps the DACL and may not know this computer's accounts, folders
/// are created and taken as they are.
///
/// Returns the folder, held open without sharing it for removal, so the
/// caller keeps using the folder it checked, and the folders above it stay
/// where they are.
pub fn ensure_private_dir(base: &Path, relative: &Path) -> io::Result<File> {
    make_private_dir(base, relative, &System::REAL).map(|(folder, _)| folder)
}

/// What [`make_private_dir`] asks of the system, which tests stand in for.
struct System {
    /// The owner to report for the item at a path, as a string SID, in place
    /// of its own. Only an administrator can make another account an owner.
    owner_of: fn(&Path) -> Option<&'static str>,
    /// The error one kind of security call returns in place of its result.
    fail: Option<(Call, u32)>,
    /// The folder to keep [`Records`] in, in place of `%LOCALAPPDATA%`.
    records_in: Option<&'static Path>,
}

impl System {
    const REAL: System = System {
        owner_of: |_| None,
        fail: None,
        records_in: None,
    };

    fn fails(&self, call: Call) -> io::Result<()> {
        match self.fail {
            Some((failing, code)) if failing == call => {
                Err(io::Error::from_raw_os_error(code as i32))
            }
            _ => Ok(()),
        }
    }
}

/// A kind of security call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Call {
    Read,
    Change,
}

/// [`ensure_private_dir`], returning too whether it checked everything in
/// the folder.
fn make_private_dir(base: &Path, relative: &Path, system: &System) -> io::Result<(File, bool)> {
    let mut names = Vec::new();
    for part in relative.components() {
        match part {
            Component::Normal(name) => names.push(name),
            _ => return Err(io::ErrorKind::InvalidInput.into()),
        }
    }
    let mut private = if keeps_dacl(&open(base, FILE_READ_ATTRIBUTES, 0)?)? {
        Some(PrivateDescriptor::get()?)
    } else {
        None
    };
    let mut held = HeldFolders::in_base(base);
    let mut security = None;
    for (index, name) in names.iter().enumerate() {
        let last = index + 1 == names.len();
        let folder = held.take(name, private, system)?;
        if let Some(owners) = private {
            match Security::read(folder, system) {
                Err(err) if unsupported(&err) => private = None,
                read => {
                    let read = read?;
                    owners.check_owner(&read, &held.path, &held.shown, system)?;
                    if !last && !owners.is_private_folder(&read)? {
                        let folder = held.folders.last().ok_or(io::ErrorKind::InvalidInput)?;
                        match set_own_dacl(folder, owners, system) {
                            Err(err) if unsupported(&err) => {
                                private = None;
                                continue;
                            }
                            set => set.map_err(denied_as(&held.shown))?,
                        }
                    }
                    security = Some(read);
                }
            }
        }
    }
    // The folders above stay held until this returns the last one.
    let (path, shown) = (held.path.clone(), held.shown.clone());
    let folder = held.folders.pop().ok_or(io::ErrorKind::InvalidInput)?;
    let (Some(private), Some(security)) = (private, security) else {
        return Ok((folder, false));
    };
    let records = Records::open(private, system);
    let record = records.as_ref().and_then(|records| records.of(&folder));
    let folder_private = private.is_private_folder(&security)?;
    if folder_private && record.as_ref().is_some_and(|record| record.exists()) {
        return Ok((folder, false));
    }
    // A change that stops before every item is checked leaves no record.
    if let Some(record) = &record {
        match std::fs::remove_file(record) {
            Err(err) if err.kind() != io::ErrorKind::NotFound => return Err(err),
            _ => {}
        }
    }
    if !folder_private {
        let protected = PROTECTED_DACL_SECURITY_INFORMATION;
        match set_security(&folder, protected, private.dacl()?, system) {
            Err(err) if unsupported(&err) => return Ok((folder, false)),
            set => set.map_err(denied_as(&shown))?,
        }
    }
    // Only this user, Administrators and SYSTEM can add an item from here
    // on, so the check sees everything Windows passed over.
    check_items(&path, &shown, private, system)?;
    // Without its record, the next open checks everything again.
    if let (Some(records), Some(record)) = (&records, &record) {
        let _ = File::create(record);
        records.prune();
    }
    Ok((folder, true))
}

/// Folders taken one inside another from a base, each without following a
/// link and held, so that each stays the folder dohc took while the next is
/// created in it and the last is used.
struct HeldFolders {
    path: PathBuf,
    shown: String,
    folders: Vec<File>,
}

impl HeldFolders {
    fn in_base(base: &Path) -> Self {
        Self {
            path: base.to_path_buf(),
            shown: String::new(),
            folders: Vec::new(),
        }
    }

    /// Take the folder `name` in the last one held, as [`take_folder`] does,
    /// and hold it too.
    fn take(
        &mut self,
        name: &OsStr,
        private: Option<&PrivateDescriptor>,
        system: &System,
    ) -> io::Result<&File> {
        self.path.push(name);
        if !self.shown.is_empty() {
            self.shown.push('/');
        }
        self.shown.push_str(&name.to_string_lossy());
        self.folders
            .push(take_folder(&self.path, &self.shown, private, system)?);
        Ok(&self.folders[self.folders.len() - 1])
    }
}

/// The most records [`Records`] keeps. A folder keeps its record after it is
/// deleted, so the oldest go first, and a folder whose record went is checked
/// again at its next open.
const MOST_RECORDS: usize = 1000;

/// The records of engine folders whose items were all checked: the folder
/// `dohc\private` in `%LOCALAPPDATA%`, kept private like the engine's
/// folder. A record is an empty file named for one folder's volume and file
/// ID, not its path. Only this user, Administrators and SYSTEM can write
/// here, so another account can neither make a record nor keep one, and a
/// different folder at the engine's path has none.
struct Records {
    /// `dohc` and `private`, held while records are read and written.
    held: HeldFolders,
}

impl Records {
    /// Create the folder, private, or take the one there. `None` when there
    /// is none this user can trust, so every open checks everything: when
    /// `%LOCALAPPDATA%` is not a full path, or is on a volume that keeps no
    /// DACL, or when `dohc` or `private` in it is a link, is not a folder, or
    /// is not private. Only `private` itself needs to be this user's: any
    /// other folder at its path is another's, or not private.
    fn open(private: &PrivateDescriptor, system: &System) -> Option<Self> {
        let base = match system.records_in {
            Some(base) => base.to_path_buf(),
            None => PathBuf::from(std::env::var_os("LOCALAPPDATA")?),
        };
        if !base.is_absolute() {
            return None;
        }
        let mut held = HeldFolders::in_base(&base);
        // `private` is created on the volume `dohc` is on, since a mount point
        // at it is a link.
        // Only `private` is read and changed, so `dohc` is only held.
        let dohc = held.take("dohc".as_ref(), None, system).ok()?;
        if !keeps_dacl(dohc).ok()? {
            return None;
        }
        let folder = held.take("private".as_ref(), Some(private), system).ok()?;
        let security = Security::read(folder, system).ok()?;
        private
            .check_owner(&security, &held.path, "", system)
            .ok()?;
        private
            .is_private_folder(&security)
            .ok()?
            .then_some(Self { held })
    }

    /// Where `folder`'s record is.
    fn of(&self, folder: &File) -> Option<PathBuf> {
        let mut id = FILE_ID_INFO::default();
        // SAFETY: The handle is open and `id` is writable for this
        // synchronous call, which retains neither.
        #[allow(unsafe_code)]
        let read = unsafe {
            GetFileInformationByHandleEx(
                folder.as_raw_handle() as HANDLE,
                FileIdInfo,
                std::ptr::from_mut(&mut id).cast(),
                size_of::<FILE_ID_INFO>() as u32,
            )
        };
        if read == 0 {
            return None;
        }
        let file_id: String = id
            .FileId
            .Identifier
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Some(
            self.held
                .path
                .join(format!("{:016x}-{file_id}", id.VolumeSerialNumber)),
        )
    }

    /// Remove the oldest records past [`MOST_RECORDS`].
    fn prune(&self) {
        let Ok(entries) = std::fs::read_dir(&self.held.path) else {
            return;
        };
        let mut records: Vec<_> = entries
            .flatten()
            .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
            .collect();
        let Some(excess) = records.len().checked_sub(MOST_RECORDS) else {
            return;
        };
        records.sort_unstable();
        for (_, record) in &records[..excess] {
            let _ = std::fs::remove_file(record);
        }
    }
}

fn refused(shown: &str, reason: NotPrivateReason) -> io::Error {
    io::Error::other(NotPrivate {
        path: shown.to_owned(),
        reason,
    })
}

fn denied(err: &io::Error) -> bool {
    err.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32)
}

/// A refusal of the item named `shown` in place of access denied.
fn denied_as(shown: &str) -> impl FnOnce(io::Error) -> io::Error {
    move |err| {
        if denied(&err) {
            refused(shown, NotPrivateReason::OtherOwner)
        } else {
            err
        }
    }
}

/// Whether `err` is a file system saying it can't read or set a DACL.
fn unsupported(err: &io::Error) -> bool {
    [ERROR_NOT_SUPPORTED, ERROR_INVALID_FUNCTION]
        .into_iter()
        .any(|code| err.raw_os_error() == Some(code as i32))
}

/// Open `path`, sharing it for reading and writing but not for removal.
/// `flags` adds to the flag every folder needs.
fn open(path: &Path, access: u32, flags: u32) -> io::Result<File> {
    std::fs::OpenOptions::new()
        .access_mode(access)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | flags)
        .open(path)
}

/// Open the item at `path`, named `shown`, without following a link, and
/// refuse it unless it is a folder.
fn open_folder(path: &Path, shown: &str, access: u32) -> io::Result<File> {
    let folder = open(path, access, FILE_FLAG_OPEN_REPARSE_POINT)?;
    // Only a name-surrogate reparse point is a link. A cloud file
    // placeholder, for one, is the folder itself.
    let kind = folder.metadata()?.file_type();
    if kind.is_symlink() {
        Err(refused(shown, NotPrivateReason::Link))
    } else if !kind.is_dir() {
        Err(refused(shown, NotPrivateReason::NotFolder))
    } else {
        Ok(folder)
    }
}

/// Open the folder at `path`, named `shown`, and hold it where it is. When
/// nothing is there, create it, with `private`'s DACL if
/// given. With `private`, also open it to read its owner and change its DACL.
/// One that can't be opened so is refused as another account's, unless one
/// of [`PrivateDescriptor::sids`] owns it, when it is refused as one whose
/// DACL dohc can't change.
fn take_folder(
    path: &Path,
    shown: &str,
    private: Option<&PrivateDescriptor>,
    system: &System,
) -> io::Result<File> {
    let access = match private {
        None => HOLD,
        Some(_) => HOLD | READ_CONTROL | WRITE_DAC,
    };
    match open_folder(path, shown, access) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            create_dir(path, private)?;
            open_folder(path, shown, access)
        }
        // This computer's accounts may have no access at all to a folder
        // from a drive another computer used. A link or a file names
        // itself first.
        Err(err) if denied(&err) => {
            open_folder(path, shown, FILE_READ_ATTRIBUTES).map_err(denied_as(shown))?;
            // One of this user's own may still be closed to its DACL.
            let ours = private.is_some_and(|private| {
                open_folder(path, shown, READ_CONTROL)
                    .and_then(|folder| Security::read(&folder, system))
                    .and_then(|security| private.check_owner(&security, path, shown, system))
                    .is_ok()
            });
            Err(refused(
                shown,
                if ours {
                    NotPrivateReason::NotChangeable
                } else {
                    NotPrivateReason::OtherOwner
                },
            ))
        }
        folder => folder,
    }
}

/// Create the folder at `path` with `private`'s DACL, if given. One made
/// there meanwhile is taken.
fn create_dir(path: &Path, private: Option<&PrivateDescriptor>) -> io::Result<()> {
    let attributes = private.map(|private| SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: private.descriptor.0,
        bInheritHandle: 0,
    });
    let path = wide(path)?;
    // SAFETY: The path ends with one null, and it, the attributes and the
    // descriptor they point to outlive this synchronous call, which retains
    // none of them.
    #[allow(unsafe_code)]
    let created = unsafe {
        CreateDirectoryW(
            path.as_ptr(),
            attributes
                .as_ref()
                .map_or(std::ptr::null(), std::ptr::from_ref),
        )
    };
    match created {
        0 => match io::Error::last_os_error() {
            err if err.kind() == io::ErrorKind::AlreadyExists => Ok(()),
            err => Err(err),
        },
        _ => Ok(()),
    }
}

/// Whether the volume `item` is on keeps a DACL dohc can set: a local volume
/// with persistent ACLs.
fn keeps_dacl(item: &File) -> io::Result<bool> {
    let handle = item.as_raw_handle() as HANDLE;
    let mut remote = FILE_REMOTE_PROTOCOL_INFO::default();
    // SAFETY: The handle is open and the output is writable for this
    // synchronous call, which retains neither. Only an item on a network
    // share has a remote protocol.
    #[allow(unsafe_code)]
    let on_share = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileRemoteProtocolInfo,
            std::ptr::from_mut(&mut remote).cast(),
            size_of::<FILE_REMOTE_PROTOCOL_INFO>() as u32,
        )
    } != 0;
    if on_share {
        return Ok(false);
    }
    let mut flags = 0;
    // SAFETY: As above. Windows writes only the flags.
    #[allow(unsafe_code)]
    let read = unsafe {
        GetVolumeInformationByHandleW(
            handle,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut flags,
            std::ptr::null_mut(),
            0,
        )
    };
    if read == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(flags & FILE_PERSISTENT_ACLS != 0)
}

/// An item's owner and DACL, read in one call.
struct Security {
    descriptor: Local<core::ffi::c_void>,
    owner: PSID,
    dacl: *mut ACL,
}

impl Security {
    fn read(item: &File, system: &System) -> io::Result<Self> {
        system.fails(Call::Read)?;
        let (mut owner, mut dacl) = (std::ptr::null_mut(), std::ptr::null_mut());
        let mut descriptor = std::ptr::null_mut();
        // SAFETY: The handle is open for this synchronous call. `descriptor`
        // is freed once, by `Local`, and `owner` and `dacl` point into it.
        #[allow(unsafe_code)]
        let status = unsafe {
            GetSecurityInfo(
                item.as_raw_handle() as HANDLE,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        Ok(Self {
            descriptor: Local(descriptor),
            owner,
            dacl,
        })
    }

    fn protected(&self) -> io::Result<bool> {
        let (mut control, mut revision) = (0, 0);
        // SAFETY: The descriptor is valid while `self` is.
        #[allow(unsafe_code)]
        let read =
            unsafe { GetSecurityDescriptorControl(self.descriptor.0, &mut control, &mut revision) };
        if read == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(control & SE_DACL_PROTECTED != 0)
    }

    /// Whether the DACL allows full control to exactly `sids`, one entry
    /// each in any order, with flags `flags_fit` accepts, and nothing else.
    fn allows_only(&self, sids: &[&str], flags_fit: impl Fn(u32) -> bool) -> io::Result<bool> {
        // SAFETY: The DACL, if any, lies in the descriptor, which is alive.
        // A null DACL admits everyone.
        #[allow(unsafe_code)]
        let Some(dacl) = (unsafe { self.dacl.as_ref() }) else {
            return Ok(false);
        };
        if usize::from(dacl.AceCount) != sids.len() {
            return Ok(false);
        }
        let mut allowed = Vec::with_capacity(sids.len());
        for index in 0..dacl.AceCount {
            let mut entry = std::ptr::null_mut();
            // SAFETY: The index is below the DACL's entry count, and Windows
            // points `entry` into the DACL. Every entry starts with a header,
            // and an access-allowed one has a mask and its SID after it.
            #[allow(unsafe_code)]
            let entry = unsafe {
                if GetAce(dacl, index.into(), &mut entry) == 0 {
                    return Err(io::Error::last_os_error());
                }
                &*entry.cast::<ACCESS_ALLOWED_ACE>()
            };
            if entry.Header.AceType != ACCESS_ALLOWED_ACE_TYPE
                || entry.Mask != FILE_ALL_ACCESS
                || !flags_fit(entry.Header.AceFlags.into())
            {
                return Ok(false);
            }
            let sid = std::ptr::from_ref(&entry.SidStart).cast_mut().cast();
            allowed.push(sid_string(sid)?);
        }
        allowed.sort_unstable();
        let mut sids = sids.to_vec();
        sids.sort_unstable();
        Ok(allowed == sids)
    }
}

/// Give `item` the DACL `dacl`, set as `flags` say. On a folder, Windows
/// gives what is in it the entries it inherits, item by item from the open
/// folder rather than by its path, and does not follow a link.
fn set_security(item: &File, flags: u32, dacl: &ACL, system: &System) -> io::Result<()> {
    system.fails(Call::Change)?;
    // SAFETY: The handle is open and the ACL is valid for this synchronous
    // call, which copies it.
    #[allow(unsafe_code)]
    let status = unsafe {
        SetSecurityInfo(
            item.as_raw_handle() as HANDLE,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | flags,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            dacl,
            std::ptr::null(),
        )
    };
    match status {
        0 => Ok(()),
        status => Err(io::Error::from_raw_os_error(status as i32)),
    }
}

/// Give `folder` the private DACL, protected, on itself alone: unlike
/// [`set_security`], this leaves what is in it as it is.
fn set_own_dacl(folder: &File, private: &PrivateDescriptor, system: &System) -> io::Result<()> {
    system.fails(Call::Change)?;
    let flags = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
    // SAFETY: The handle is open and the descriptor valid for this
    // synchronous call, which copies what it needs.
    #[allow(unsafe_code)]
    let set = unsafe {
        SetKernelObjectSecurity(
            folder.as_raw_handle() as HANDLE,
            flags,
            private.descriptor.0,
        )
    };
    if set == 0 {
        return Err(io::Error::last_os_error());
    }
    if private.is_private_folder(&Security::read(folder, system)?)? {
        Ok(())
    } else {
        Err(io::Error::other("a folder on the way kept other entries"))
    }
}

/// Give `item` only what its folder gives it: none of its own entries, and
/// no protection from the folder.
fn inherit_only(item: &File, system: &System) -> io::Result<()> {
    let mut empty = ACL::default();
    // SAFETY: `empty` is writable and as large as the length given.
    #[allow(unsafe_code)]
    if unsafe { InitializeAcl(&mut empty, size_of::<ACL>() as u32, ACL_REVISION) } == 0 {
        return Err(io::Error::last_os_error());
    }
    set_security(item, UNPROTECTED_DACL_SECURITY_INFORMATION, &empty, system)
}

/// Check every item in the folder at `path`, named `shown`, at any depth.
/// Give an item with entries of its own, a protected DACL, or entries
/// Windows left from before, only what the folder gives it. Refuse the
/// folder for an item another account owns, or one this user can't open or
/// change. A link is checked, not followed, as Windows does not follow one.
fn check_items(
    path: &Path,
    shown: &str,
    private: &PrivateDescriptor,
    system: &System,
) -> io::Result<()> {
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let item_path = entry.path();
        let access = READ_CONTROL | WRITE_DAC;
        let item = match open(&item_path, access, FILE_FLAG_OPEN_REPARSE_POINT) {
            Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
            item => item.map_err(denied_as(shown))?,
        };
        let security = Security::read(&item, system)?;
        private.check_owner(&security, &item_path, shown, system)?;
        if !private.is_inherited_only(&security)? {
            inherit_only(&item, system).map_err(denied_as(shown))?;
            if !private.is_inherited_only(&Security::read(&item, system)?)? {
                return Err(io::Error::other(
                    "an item in the folder kept its own entries",
                ));
            }
        }
        if entry.file_type()?.is_dir() {
            check_items(&item_path, shown, private, system)?;
        }
    }
    Ok(())
}

/// Memory Windows allocated for the caller, freed once on drop.
struct Local<T>(*mut T);

impl<T> Drop for Local<T> {
    fn drop(&mut self) {
        // SAFETY: Windows allocated the pointer with LocalAlloc for the caller
        // to free, and nothing uses it after this.
        #[allow(unsafe_code)]
        unsafe {
            LocalFree(self.0.cast());
        }
    }
}

/// A security descriptor with the DACL of a user's profile folder, for this
/// user, protected from the folders above.
struct PrivateDescriptor {
    descriptor: Local<core::ffi::c_void>,
    user: String,
}

// SAFETY: Nothing changes the descriptor after it is made, and Windows only
// reads it, from any thread.
#[allow(unsafe_code)]
unsafe impl Send for PrivateDescriptor {}
#[allow(unsafe_code)]
unsafe impl Sync for PrivateDescriptor {}

impl PrivateDescriptor {
    /// This process's descriptor, made once: parsing it costs more than the
    /// rest of an open that finds the folder private.
    fn get() -> io::Result<&'static Self> {
        static PRIVATE: std::sync::OnceLock<PrivateDescriptor> = std::sync::OnceLock::new();
        if let Some(private) = PRIVATE.get() {
            return Ok(private);
        }
        let private = Self::new()?;
        Ok(PRIVATE.get_or_init(|| private))
    }

    fn new() -> io::Result<Self> {
        let user = current_user()?;
        let sddl = format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{user})");
        let sddl: Vec<u16> = sddl.encode_utf16().chain([0]).collect();
        let mut descriptor = std::ptr::null_mut();
        // SAFETY: The string ends with one null and outlives this synchronous
        // call. The descriptor it returns is freed once, by `Local`.
        #[allow(unsafe_code)]
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        };
        if converted == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            descriptor: Local(descriptor),
            user,
        })
    }

    fn dacl(&self) -> io::Result<&ACL> {
        let (mut present, mut defaulted) = (0, 0);
        let mut dacl = std::ptr::null_mut();
        // SAFETY: The descriptor is valid while `self` is, and the DACL
        // pointer it returns points into it.
        #[allow(unsafe_code)]
        let read = unsafe {
            GetSecurityDescriptorDacl(self.descriptor.0, &mut present, &mut dacl, &mut defaulted)
        };
        if read == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: The SDDL above always yields a DACL, which lives as long as
        // the descriptor in `self`.
        #[allow(unsafe_code)]
        unsafe { dacl.as_ref() }.ok_or_else(|| io::Error::other("the private DACL is missing"))
    }

    /// Who the DACL admits, and who may own the folder and what is in it.
    fn sids(&self) -> [&str; 3] {
        [SYSTEM, ADMINISTRATORS, &self.user]
    }

    /// Whether `security` is the private folder's: protected from the
    /// folders above, and full control for SYSTEM, Administrators and this
    /// user, for the folder and everything in it.
    fn is_private_folder(&self, security: &Security) -> io::Result<bool> {
        let fits = |flags| flags == OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
        Ok(security.protected()? && security.allows_only(&self.sids(), fits)?)
    }

    /// Whether `security` is what an item in the private folder inherits
    /// from it, and nothing of its own.
    fn is_inherited_only(&self, security: &Security) -> io::Result<bool> {
        let fits = |flags| flags & INHERITED_ACE != 0 && flags & INHERIT_ONLY_ACE == 0;
        Ok(!security.protected()? && security.allows_only(&self.sids(), fits)?)
    }

    /// Refuse the item at `path`, named `shown`, unless this user,
    /// Administrators or SYSTEM owns it: an owner can always read an item
    /// and change its DACL.
    fn check_owner(
        &self,
        security: &Security,
        path: &Path,
        shown: &str,
        system: &System,
    ) -> io::Result<()> {
        let owner = match (system.owner_of)(path) {
            Some(owner) => owner.to_owned(),
            None => sid_string(security.owner)?,
        };
        if self.sids().contains(&owner.as_str()) {
            Ok(())
        } else {
            Err(refused(shown, NotPrivateReason::OtherOwner))
        }
    }
}

/// This process's user, as a string SID.
fn current_user() -> io::Result<String> {
    let mut token = std::ptr::null_mut();
    // SAFETY: The pseudo handle for this process needs no closing, and the
    // token handle Windows returns is closed once, by `OwnedHandle`.
    #[allow(unsafe_code)]
    let token = unsafe {
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        OwnedHandle::from_raw_handle(token)
    };
    // A TOKEN_USER and the largest SID, aligned for the pointer in it.
    let mut user = [0_usize; 16];
    let mut length = 0;
    // SAFETY: The token is open and the buffer is writable for its whole
    // length during this synchronous call.
    #[allow(unsafe_code)]
    let read = unsafe {
        GetTokenInformation(
            token.as_raw_handle() as HANDLE,
            TokenUser,
            user.as_mut_ptr().cast(),
            size_of_val(&user) as u32,
            &mut length,
        )
    };
    if read == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: Windows wrote a TOKEN_USER at the start of the buffer, whose SID
    // lies in the buffer too.
    #[allow(unsafe_code)]
    let sid = unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    sid_string(sid)
}

/// `sid` as a string SID, such as `S-1-5-18`.
fn sid_string(sid: PSID) -> io::Result<String> {
    let mut text = std::ptr::null_mut();
    // SAFETY: `sid` points at a valid SID for this synchronous call. The
    // string Windows returns is freed once, by `Local`.
    #[allow(unsafe_code)]
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(local_string(Local(text)))
}

/// A string Windows allocated, ending with a null.
fn local_string(text: Local<u16>) -> String {
    // SAFETY: Windows wrote a string that ends with a null, and `text` keeps
    // it allocated while it is read.
    #[allow(unsafe_code)]
    unsafe {
        let length = (0..).take_while(|&at| *text.0.add(at) != 0).count();
        String::from_utf16_lossy(std::slice::from_raw_parts(text.0, length))
    }
}

fn wide(path: &Path) -> io::Result<Vec<u16>> {
    let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
    if value.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a file path contains a null character",
        ));
    }
    value.push(0);
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_test_scratch::ScratchDir;
    use std::ffi::OsStr;
    use std::path::PathBuf;
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertStringSidToSidW,
        GetEffectiveRightsFromAclW, NO_MULTIPLE_TRUSTEE, TRUSTEE_IS_SID,
        TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::SetFileSecurityW;
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_BASIC_INFO, FILE_DELETE_CHILD, FileBasicInfo,
    };

    const ENGINE: &str = ".dohc/engine";

    /// Users, the stand-in for another account as an owner.
    const USERS: &str = "S-1-5-32-545";

    /// Authenticated Users, a stand-in for another account in permission
    /// tests.
    const AUTHENTICATED_USERS: &str = "S-1-5-11";

    fn open_engine(root: &Path, system: &System) -> io::Result<bool> {
        make_private_dir(root, Path::new(ENGINE), system).map(|(_, checked)| checked)
    }

    /// A workspace root whose test DACL grants Users read access.
    fn shared_root(scratch: &ScratchDir, name: &str) -> PathBuf {
        let root = scratch.join(name);
        std::fs::create_dir(&root).expect("root");
        let users = OsStr::new("*S-1-5-32-545:(OI)(CI)R");
        run("icacls", &[root.as_os_str(), OsStr::new("/grant"), users]);
        root
    }

    /// An older workspace in a shared root: its engine folder, a folder in
    /// it, and files that took the root's entries, Users among them.
    fn older_workspace(scratch: &ScratchDir, name: &str) -> (PathBuf, PathBuf) {
        let root = shared_root(scratch, name);
        let engine = root.join(ENGINE);
        let worker = engine.join("displaced").join("worker-0");
        std::fs::create_dir_all(&worker).expect("folders");
        for file in [
            engine.join("engine.db"),
            engine.join("engine.db-wal"),
            worker.join("6a6f62.0"),
        ] {
            std::fs::write(&file, b"history").expect("file");
            assert!(sddl(&file).contains("(A;ID;FR;;;BU)"), "{}", sddl(&file));
        }
        (root, engine)
    }

    fn run(program: &str, args: &[&OsStr]) {
        let status = std::process::Command::new(program)
            .args(args)
            .stdout(std::process::Stdio::null())
            .status()
            .expect(program);
        assert!(status.success(), "{program} {args:?}");
    }

    fn icacls(path: &Path, args: &[&str]) {
        let args: Vec<&OsStr> = args.iter().map(OsStr::new).collect();
        run("icacls", &[&[path.as_os_str()][..], &args].concat());
    }

    fn junction(at: &Path, to: &Path) {
        // `mklink` takes a `/` in a path for a switch.
        let at: PathBuf = at.components().collect();
        let mklink = ["/c", "mklink", "/J"].map(OsStr::new);
        run(
            "cmd",
            &[&mklink[..], &[at.as_os_str(), to.as_os_str()]].concat(),
        );
    }

    /// The DACL of the item at `path` in SDDL, read without following a link.
    fn sddl(path: &Path) -> String {
        let item = open(path, READ_CONTROL, FILE_FLAG_OPEN_REPARSE_POINT).expect("item");
        let mut descriptor = std::ptr::null_mut();
        let mut text = std::ptr::null_mut();
        // SAFETY: Each call is synchronous, and each string or descriptor
        // Windows returns is freed once, by `Local`, after its last use.
        #[allow(unsafe_code)]
        unsafe {
            let status = GetSecurityInfo(
                item.as_raw_handle() as HANDLE,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            );
            assert_eq!(status, 0);
            let descriptor = Local(descriptor);
            let converted = ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor.0,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                std::ptr::null_mut(),
            );
            assert_ne!(converted, 0);
        }
        local_string(Local(text))
    }

    /// Give the folder at `path` the DACL in `sddl`, and nothing in it any
    /// entry: unlike SetSecurityInfo, SetFileSecurityW reaches only the
    /// folder.
    fn set_folder_dacl(path: &Path, sddl: &str) {
        let sddl: Vec<u16> = sddl.encode_utf16().chain([0]).collect();
        let path = wide(path).expect("path");
        let mut descriptor = std::ptr::null_mut();
        // SAFETY: Both strings end with a null and outlive these synchronous
        // calls. The descriptor is freed once, by `Local`.
        #[allow(unsafe_code)]
        unsafe {
            let converted = ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            );
            assert_ne!(converted, 0);
            let descriptor = Local(descriptor);
            let flags = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
            assert_ne!(SetFileSecurityW(path.as_ptr(), flags, descriptor.0), 0);
        }
    }

    /// The DACL of a private folder, then of a folder and of a file in it.
    /// Windows marks the DACLs it changes as inherited automatically, but not
    /// one a folder is created with, nor what that folder's items inherit.
    fn private_dacls(created: bool) -> [String; 3] {
        let user = current_user().expect("user");
        let entries =
            |flags: &str| format!("(A;{flags};FA;;;SY)(A;{flags};FA;;;BA)(A;{flags};FA;;;{user})");
        let (folder, item) = if created {
            ("D:P", "D:")
        } else {
            ("D:PAI", "D:AI")
        };
        [
            format!("{folder}{}", entries("OICI")),
            format!("{item}{}", entries("OICIID")),
            format!("{item}{}", entries("ID")),
        ]
    }

    fn refusal(made: io::Result<bool>) -> (String, NotPrivateReason) {
        let err = made.expect_err("refused");
        let refused = not_private(&err).expect("not private");
        (refused.path.clone(), refused.reason)
    }

    /// The real system, with its records in `scratch` rather than in this
    /// user's `%LOCALAPPDATA%`.
    fn system(scratch: &ScratchDir) -> System {
        let records = scratch.join("app-data");
        std::fs::create_dir_all(&records).expect("records");
        System {
            records_in: Some(Box::leak(records.into_boxed_path())),
            ..System::REAL
        }
    }

    /// Where the record of the engine folder at `engine` is.
    fn record(system: &System, engine: &Path) -> PathBuf {
        let private = PrivateDescriptor::get().expect("descriptor");
        let records = Records::open(private, system).expect("records");
        let access = FILE_READ_ATTRIBUTES;
        let folder = open(engine, access, FILE_FLAG_OPEN_REPARSE_POINT).expect("engine");
        records.of(&folder).expect("record")
    }

    /// The DACL of a private folder, set as dohc sets it.
    fn private_sddl() -> String {
        let user = current_user().expect("user");
        format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{user})")
    }

    /// A new folder admits only this user, SYSTEM and Administrators, however
    /// open the folders above it are, and so does everything made in it.
    #[test]
    fn a_new_folder_admits_only_this_user_system_and_administrators() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let root = shared_root(&scratch, "root");
        assert!(open_engine(&root, &real).expect("create"));
        let engine = root.join(ENGINE);
        assert!(record(&real, &engine).exists());
        std::fs::create_dir(engine.join("displaced")).expect("folder");
        std::fs::write(engine.join("engine.db"), b"history").expect("file");
        let [folder, inner_folder, file] = private_dacls(true);
        assert_eq!(sddl(&engine), folder);
        assert_eq!(sddl(&engine.join("displaced")), inner_folder);
        assert_eq!(sddl(&engine.join("engine.db")), file);
        // `.dohc` is made private as it is created too.
        assert_eq!(sddl(&root.join(".dohc")), folder);
        assert!(!open_engine(&root, &real).expect("reopen"));
    }

    /// The rights the DACL of the item at `path` gives the account `sid`.
    fn rights_of(path: &Path, sid: &str) -> u32 {
        let item = open(path, READ_CONTROL, FILE_FLAG_OPEN_REPARSE_POINT).expect("item");
        let security = Security::read(&item, &System::REAL).expect("security");
        let sid: Vec<u16> = sid.encode_utf16().chain([0]).collect();
        let (mut account, mut rights) = (std::ptr::null_mut(), 0);
        // SAFETY: Each call is synchronous. The SID string ends with a null,
        // the SID Windows returns is freed once, by `Local`, after its last
        // use, and the DACL lies in the descriptor `security` keeps alive.
        #[allow(unsafe_code)]
        unsafe {
            assert_ne!(ConvertStringSidToSidW(sid.as_ptr(), &mut account), 0);
            let account = Local(account);
            let trustee = TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
                ptstrName: account.0.cast(),
            };
            assert_eq!(
                GetEffectiveRightsFromAclW(security.dacl, &trustee, &mut rights),
                0
            );
        }
        rights
    }

    /// When the item at `path` last changed, its DACL included.
    fn change_time(path: &Path) -> i64 {
        let item = open(path, FILE_READ_ATTRIBUTES, FILE_FLAG_OPEN_REPARSE_POINT).expect("item");
        let mut info = FILE_BASIC_INFO::default();
        // SAFETY: The handle is open and the output is writable for this
        // synchronous call, which retains neither.
        #[allow(unsafe_code)]
        let read = unsafe {
            GetFileInformationByHandleEx(
                item.as_raw_handle() as HANDLE,
                FileBasicInfo,
                std::ptr::from_mut(&mut info).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        };
        assert_ne!(read, 0);
        info.ChangeTime
    }

    /// An open restricts the DACLs of `.dohc`, `.dohc\engine` and
    /// `.dohc\local`, keeps the entries of what else is in `.dohc`, and
    /// changes nothing on a later open.
    #[test]
    fn an_open_closes_dohc_and_its_private_folders_to_other_accounts() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let root = scratch.join("root");
        std::fs::create_dir(&root).expect("root");
        icacls(&root, &["/grant", "*S-1-5-11:(OI)(CI)M"]);
        let dohc = root.join(".dohc");
        let synced = dohc.join("databases").join("ops.jsonl");
        std::fs::create_dir_all(synced.parent().expect("databases")).expect("folders");
        std::fs::write(&synced, b"{}").expect("file");
        assert_ne!(rights_of(&dohc, AUTHENTICATED_USERS) & DELETE, 0);

        let open = |relative: &str| {
            drop(make_private_dir(&root, Path::new(relative), &real).expect("open"))
        };
        open(ENGINE);
        open(".dohc/local");
        for account in [USERS, AUTHENTICATED_USERS] {
            assert_eq!(
                rights_of(&dohc, account) & (DELETE | FILE_DELETE_CHILD),
                0,
                "{account}"
            );
            for folder in ["engine", "local"] {
                assert_eq!(
                    rights_of(&dohc.join(folder), account) & DELETE,
                    0,
                    "{account} {folder}"
                );
            }
        }
        assert_eq!(sddl(&dohc), private_sddl());
        // A file `.dohc` keeps for every computer kept the entries it had.
        assert!(
            sddl(&synced).contains("(A;ID;0x1301bf;;;AU)"),
            "{}",
            sddl(&synced)
        );

        let items = [
            dohc.clone(),
            dohc.join("engine"),
            dohc.join("local"),
            synced,
        ];
        let changed = items.clone().map(|item| change_time(&item));
        open(ENGINE);
        open(".dohc/local");
        assert_eq!(items.map(|item| change_time(&item)), changed);
    }

    /// An older workspace's folder, and everything already in it, loses the
    /// entries it took from the folders above. A second open changes nothing.
    #[test]
    fn a_folder_already_there_and_what_is_in_it_lose_the_entries_from_above() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let (root, engine) = older_workspace(&scratch, "root");
        assert!(open_engine(&root, &real).expect("open"));
        let [folder, inner_folder, file] = private_dacls(false);
        assert_eq!(sddl(&engine), folder);
        assert_eq!(
            sddl(&engine.join("displaced").join("worker-0")),
            inner_folder
        );
        for name in ["engine.db", "engine.db-wal", "displaced/worker-0/6a6f62.0"] {
            assert_eq!(sddl(&engine.join(name)), file, "{name}");
        }
        assert!(record(&real, &engine).exists());
        assert!(!open_engine(&root, &real).expect("reopen"));
        assert_eq!(sddl(&engine), folder);
    }

    /// Windows keeps an item's own entries, and leaves alone one with a
    /// protected DACL. Each is given only what the folder gives it.
    #[test]
    fn an_item_with_entries_of_its_own_gets_only_what_the_folder_gives() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let (root, engine) = older_workspace(&scratch, "root");
        let granted = engine.join("engine.db");
        icacls(&granted, &["/grant", "*S-1-5-32-545:(R)"]);
        let protected = engine.join("secret.key");
        std::fs::write(&protected, b"key").expect("key");
        let user = format!("*{}:(F)", current_user().expect("user"));
        icacls(
            &protected,
            &["/inheritance:r", "/grant:r", "*S-1-5-32-545:(R)", &user],
        );
        assert!(sddl(&granted).starts_with("D:AI(A;;FR;;;BU)"));
        assert!(sddl(&protected).starts_with("D:PAI"));
        assert!(open_engine(&root, &real).expect("open"));
        let [_, _, file] = private_dacls(false);
        assert_eq!(sddl(&granted), file);
        assert_eq!(sddl(&protected), file);
    }

    /// An open that stopped after the folder's DACL changed, before every
    /// item was checked, left no record. The next open finishes it.
    #[test]
    fn an_open_that_stopped_partway_is_finished_by_the_next() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let (root, engine) = older_workspace(&scratch, "root");
        set_folder_dacl(&engine, &private_sddl());
        let db = engine.join("engine.db");
        assert!(sddl(&db).contains("(A;ID;FR;;;BU)"));
        let checked = open_engine(&root, &real).expect("open");
        // The folder keeps the DACL it had. Windows marks each item it gave
        // the folder's entries.
        assert_eq!(sddl(&engine), private_sddl());
        let [_, inner_folder, file] = private_dacls(false);
        assert_eq!(sddl(&engine.join("displaced")), inner_folder);
        assert_eq!(sddl(&db), file);
        assert_eq!(sddl(&engine.join("displaced/worker-0/6a6f62.0")), file);
        assert!(checked && record(&real, &engine).exists());
    }

    /// A file planted in the folder under the name the record once had is
    /// only an item, so the open checks everything.
    #[test]
    fn a_record_planted_in_the_folder_does_not_skip_the_check() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let (root, engine) = older_workspace(&scratch, "root");
        set_folder_dacl(&engine, &private_sddl());
        std::fs::write(engine.join("PRIVATE"), b"").expect("planted");
        let db = engine.join("engine.db");
        assert!(sddl(&db).contains("(A;ID;FR;;;BU)"));
        let checked = open_engine(&root, &real).expect("open");
        assert_eq!(sddl(&db), private_dacls(false)[2]);
        assert!(checked);
    }

    /// A different folder at the engine's path, with the private DACL but
    /// nothing of it passed down, has no record, so it is checked in full.
    #[test]
    fn a_different_folder_at_the_engine_path_with_the_private_dacl_is_checked_in_full() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let (root, engine) = older_workspace(&scratch, "root");
        assert!(open_engine(&root, &real).expect("open"));
        // Made where Users may read, as `.dohc` no longer lets them.
        let swapped = root.join("swapped");
        std::fs::create_dir(&swapped).expect("swapped");
        std::fs::write(swapped.join("engine.db"), b"history").expect("file");
        set_folder_dacl(&swapped, &private_sddl());
        std::fs::write(swapped.join("PRIVATE"), b"").expect("planted");
        std::fs::rename(&engine, root.join(".dohc").join("before")).expect("aside");
        std::fs::rename(&swapped, &engine).expect("swapped in");
        let db = engine.join("engine.db");
        assert!(sddl(&db).contains("(A;ID;FR;;;BU)"));
        let checked = open_engine(&root, &real).expect("reopen");
        assert_eq!(sddl(&db), private_dacls(false)[2]);
        assert!(checked);
    }

    /// A refused open leaves no record, and nothing planted in the folder
    /// meanwhile stands for one, so the next open checks, and refuses, again.
    #[test]
    fn a_refused_open_leaves_no_record_for_the_next() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let db_is_users = System {
            owner_of: |path| path.ends_with("engine.db").then_some(USERS),
            ..system(&scratch)
        };
        let (root, engine) = older_workspace(&scratch, "root");
        assert!(open_engine(&root, &real).expect("open"));
        // The folder stops being private, and an item another account owns
        // turns up.
        icacls(&engine, &["/grant", "*S-1-5-32-545:(OI)(CI)R"]);
        let other_owner = (ENGINE.into(), NotPrivateReason::OtherOwner);
        assert_eq!(refusal(open_engine(&root, &db_is_users)), other_owner);
        assert!(!record(&real, &engine).exists());
        std::fs::write(engine.join("PRIVATE"), b"").expect("planted");
        assert_eq!(refusal(open_engine(&root, &db_is_users)), other_owner);
    }

    /// Records in a folder other accounts can write prove nothing, so every
    /// open checks everything.
    #[test]
    fn records_others_can_write_are_not_trusted() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let (root, engine) = older_workspace(&scratch, "root");
        assert!(open_engine(&root, &real).expect("open"));
        let records = record(&real, &engine).parent().expect("records").to_owned();
        icacls(&records, &["/grant", "*S-1-5-32-545:(OI)(CI)M"]);
        assert!(open_engine(&root, &real).expect("reopen"));
        assert!(open_engine(&root, &real).expect("and again"));
    }

    /// A record folder reached through a link at `dohc` is not the one dohc
    /// checked and holds, so it holds no records, and every open checks
    /// everything.
    #[test]
    fn a_link_on_the_way_to_the_records_gives_none() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let (root, engine) = older_workspace(&scratch, "root");
        assert!(open_engine(&root, &real).expect("open"));
        let records = record(&real, &engine).parent().expect("records").to_owned();
        let linked = scratch.join("linked-app-data");
        std::fs::create_dir(&linked).expect("linked");
        junction(&linked.join("dohc"), records.parent().expect("dohc"));
        let through_link = System {
            records_in: Some(Box::leak(linked.into_boxed_path())),
            ..System::REAL
        };
        std::fs::remove_file(record(&real, &engine)).expect("record");
        assert!(open_engine(&root, &through_link).expect("reopen"));
        assert!(open_engine(&root, &through_link).expect("and again"));
        assert_eq!(std::fs::read_dir(&records).expect("records").count(), 0);
    }

    /// An empty `%LOCALAPPDATA%`, or one that is not a full path, names no
    /// folder of this user's, so there are no records, and every open checks
    /// everything.
    #[test]
    fn records_in_a_folder_that_is_not_a_full_path_are_not_kept() {
        let scratch = ScratchDir::new().expect("scratch");
        let empty = System {
            records_in: Some(Path::new("")),
            ..System::REAL
        };
        let (root, _) = older_workspace(&scratch, "root");
        assert!(open_engine(&root, &empty).expect("open"));
        assert!(open_engine(&root, &empty).expect("reopen"));
    }

    /// A folder keeps its record after it is deleted, test runs' folders
    /// most of all, so only the newest records are kept.
    #[test]
    fn only_the_newest_records_are_kept() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let (root, engine) = older_workspace(&scratch, "root");
        assert!(open_engine(&root, &real).expect("open"));
        let ours = record(&real, &engine);
        let records = ours.parent().expect("records").to_owned();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        for index in 0..MOST_RECORDS {
            let stale = File::create(records.join(format!("stale-{index}"))).expect("stale");
            stale.set_modified(old).expect("old");
        }
        std::fs::remove_file(&ours).expect("record");
        assert!(open_engine(&root, &real).expect("check again"));
        let kept = std::fs::read_dir(&records).expect("records").count();
        assert_eq!(kept, MOST_RECORDS);
        assert!(ours.exists());
    }

    /// Once everything is checked, only this user, Administrators, SYSTEM
    /// or an item's owner, one of them, can change an item, so an open that
    /// finds the folder private and recorded looks no further. Without the
    /// record, the next open checks everything again.
    #[test]
    fn only_a_folder_without_its_record_is_checked_again() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let (root, engine) = older_workspace(&scratch, "root");
        assert!(open_engine(&root, &real).expect("open"));
        let db = engine.join("engine.db");
        icacls(&db, &["/grant", "*S-1-5-32-545:(R)"]);
        assert!(!open_engine(&root, &real).expect("reopen"));
        assert!(sddl(&db).contains("(A;;FR;;;BU)"));
        std::fs::remove_file(record(&real, &engine)).expect("record");
        assert!(open_engine(&root, &real).expect("check again"));
        assert_eq!(sddl(&db), private_dacls(false)[2]);
    }

    /// The same three entries in another order are private too.
    #[test]
    fn the_same_entries_in_another_order_are_private() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let root = shared_root(&scratch, "root");
        open_engine(&root, &real).expect("create");
        let engine = root.join(ENGINE);
        let user = current_user().expect("user");
        let reordered = format!("D:P(A;OICI;FA;;;{user})(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)");
        set_folder_dacl(&engine, &reordered);
        assert_eq!(sddl(&engine), reordered);
        assert!(!open_engine(&root, &real).expect("reopen"));
        assert_eq!(sddl(&engine), reordered);
    }

    /// An owner can always read an item and change its DACL, so a folder
    /// another account owns is refused before anything changes, even once
    /// it was checked.
    #[test]
    fn a_folder_another_account_owns_is_refused() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let engine_is_users = System {
            owner_of: |path| path.ends_with("engine").then_some(USERS),
            ..system(&scratch)
        };
        let dohc_is_users = System {
            owner_of: |path| path.ends_with(".dohc").then_some(USERS),
            ..system(&scratch)
        };
        let (root, engine) = older_workspace(&scratch, "root");
        let before = sddl(&engine);
        assert_eq!(
            refusal(open_engine(&root, &engine_is_users)),
            (ENGINE.into(), NotPrivateReason::OtherOwner)
        );
        assert_eq!(sddl(&engine), before);
        assert!(open_engine(&root, &real).expect("open"));
        assert_eq!(
            refusal(open_engine(&root, &engine_is_users)),
            (ENGINE.into(), NotPrivateReason::OtherOwner)
        );
        assert_eq!(
            refusal(open_engine(&root, &dohc_is_users)),
            (".dohc".into(), NotPrivateReason::OtherOwner)
        );
    }

    /// An item another account owns refuses the folder, and leaves it to be
    /// checked again.
    #[test]
    fn an_item_another_account_owns_refuses_the_folder() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let db_is_users = System {
            owner_of: |path| path.ends_with("engine.db").then_some(USERS),
            ..system(&scratch)
        };
        let (root, engine) = older_workspace(&scratch, "root");
        assert_eq!(
            refusal(open_engine(&root, &db_is_users)),
            (ENGINE.into(), NotPrivateReason::OtherOwner)
        );
        assert!(!record(&real, &engine).exists());
        assert!(open_engine(&root, &real).expect("open"));
    }

    /// Windows skips an item whose DACL this user can't change, and reports
    /// success, so the folder is refused and left to be checked again.
    #[test]
    fn an_item_this_user_cannot_change_refuses_the_folder() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let (root, engine) = older_workspace(&scratch, "root");
        let locked = engine.join("engine.db");
        // Owner rights limited to reading, and a denied right to change the
        // DACL, stand in for a file this user can't change. The denial goes
        // first: once owner rights are limited, only an entry for this user
        // could still let the DACL change, and the folder above may have none.
        let deny = format!("*{}:(WDAC)", current_user().expect("user"));
        icacls(&locked, &["/deny", &deny]);
        icacls(&locked, &["/grant", "*S-1-3-4:(R)"]);
        assert_eq!(
            refusal(open_engine(&root, &real)),
            (ENGINE.into(), NotPrivateReason::OtherOwner)
        );
        assert!(!record(&real, &engine).exists());
    }

    /// A folder this user can't open at all, not even to read its
    /// attributes, as on a drive another computer used, is refused by its
    /// name.
    #[test]
    fn a_folder_this_user_cannot_open_is_refused_by_its_name() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let (root, _) = older_workspace(&scratch, "root");
        let dohc = root.join(".dohc");
        let user = format!("*{}", current_user().expect("user"));
        // Listing a folder lets one read the attributes of what is in it.
        icacls(&root, &["/deny", &format!("{user}:(RD)")]);
        icacls(&dohc, &["/deny", &format!("{user}:(RD,RA)")]);
        let opened = open_engine(&root, &real);
        icacls(&root, &["/remove:d", &user]);
        icacls(&dohc, &["/remove:d", &user]);
        assert_eq!(
            refusal(opened),
            (".dohc".into(), NotPrivateReason::OtherOwner)
        );
    }

    /// A file system that reports DACLs but can't read or change one keeps
    /// what the workspace had, as a volume without DACLs does.
    #[test]
    fn a_volume_that_cannot_read_or_change_a_dacl_opens_as_before() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let cant_read = System {
            fail: Some((Call::Read, ERROR_NOT_SUPPORTED)),
            ..system(&scratch)
        };
        let cant_change = System {
            fail: Some((Call::Change, ERROR_INVALID_FUNCTION)),
            ..system(&scratch)
        };
        for (name, system) in [("read", &cant_read), ("change", &cant_change)] {
            let (root, engine) = older_workspace(&scratch, name);
            let before = [sddl(&engine), sddl(&engine.join("engine.db"))];
            assert!(!open_engine(&root, system).expect("open"), "{name}");
            assert_eq!(
                [sddl(&engine), sddl(&engine.join("engine.db"))],
                before,
                "{name}"
            );
            assert!(!record(&real, &engine).exists(), "{name}");
        }
        // A folder dohc creates is private as it is made, so the engine folder
        // takes what `.dohc` gives it, though nothing is checked.
        let fresh = shared_root(&scratch, "fresh");
        assert!(!open_engine(&fresh, &cant_read).expect("create"));
        assert_eq!(sddl(&fresh.join(".dohc")), private_dacls(true)[0]);
        assert!(!sddl(&fresh.join(ENGINE)).contains(";;;BU)"));
    }

    /// A `.dohc` that Administrators own and let this user change what is in,
    /// but not its DACL, is refused for that, not as another user's, and
    /// nothing is made in it.
    #[test]
    fn a_folder_on_the_way_whose_dacl_this_user_cannot_change_is_refused_for_that() {
        let scratch = ScratchDir::new().expect("scratch");
        let root = shared_root(&scratch, "root");
        let dohc = root.join(".dohc");
        std::fs::create_dir(&dohc).expect("dohc");
        let user = current_user().expect("user");
        // An OWNER RIGHTS entry takes the place of what an owner may always
        // do, so this user, its real owner, may change what is in it but not
        // its DACL.
        let modify = "0x1301bf";
        set_folder_dacl(
            &dohc,
            &format!(
                "D:P(A;OICI;{modify};;;{user})(A;;{modify};;;OW)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
            ),
        );
        let administrators_own = System {
            owner_of: |path| path.ends_with(".dohc").then_some(ADMINISTRATORS),
            ..system(&scratch)
        };
        assert_eq!(
            refusal(open_engine(&root, &administrators_own)),
            (".dohc".into(), NotPrivateReason::NotChangeable)
        );
        assert!(!dohc.join("engine").exists());
        let refused = NotPrivate {
            path: ".dohc".into(),
            reason: NotPrivateReason::NotChangeable,
        };
        assert_eq!(
            refused.to_string(),
            ".dohc has permissions dohc can't use, so dohc can't keep it private"
        );
    }

    /// While the caller holds the folder, it and the folders above it stay
    /// where they are.
    #[test]
    fn the_folder_stays_in_place_while_it_is_held() {
        let scratch = ScratchDir::new().expect("scratch");
        let (root, engine) = older_workspace(&scratch, "root");
        let aside = root.join(".dohc").join("aside");
        let (held, _) =
            make_private_dir(&root, Path::new(ENGINE), &system(&scratch)).expect("open");
        assert!(std::fs::rename(&engine, &aside).is_err());
        drop(held);
        std::fs::rename(&engine, &aside).expect("rename once released");
    }

    /// A link at `.dohc` or at the folder is refused before anything is made
    /// or changed in what it names, and so is a file at the folder.
    #[test]
    fn a_link_or_a_file_is_refused_and_what_it_names_is_left_alone() {
        let scratch = ScratchDir::new().expect("scratch");
        let real = system(&scratch);
        let elsewhere = shared_root(&scratch, "elsewhere");
        let note = elsewhere.join("note.md");
        std::fs::write(&note, b"note").expect("note");
        let dacls = || [sddl(&elsewhere), sddl(&note)];
        let before = dacls();

        let linked = shared_root(&scratch, "linked");
        junction(&linked.join(".dohc"), &elsewhere);
        assert_eq!(
            refusal(open_engine(&linked, &real)),
            (".dohc".into(), NotPrivateReason::Link)
        );
        assert!(!elsewhere.join("engine").exists());
        assert_eq!(dacls(), before);

        let linked = shared_root(&scratch, "linked-engine");
        std::fs::create_dir(linked.join(".dohc")).expect("dohc");
        junction(&linked.join(ENGINE), &elsewhere);
        assert_eq!(
            refusal(open_engine(&linked, &real)),
            (ENGINE.into(), NotPrivateReason::Link)
        );
        assert_eq!(dacls(), before);

        let file = shared_root(&scratch, "file");
        std::fs::create_dir(file.join(".dohc")).expect("dohc");
        std::fs::write(file.join(ENGINE), b"").expect("file");
        assert_eq!(
            refusal(open_engine(&file, &real)),
            (ENGINE.into(), NotPrivateReason::NotFolder)
        );
    }
}
