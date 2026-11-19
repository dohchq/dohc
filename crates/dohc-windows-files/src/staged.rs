//! Keep a file dohc set aside private while it waits, and give it its own
//! DACL back when it returns to the workspace.

use std::fs::File;
use std::io;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW,
    ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
    SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, GetSecurityDescriptorControl, PROTECTED_DACL_SECURITY_INFORMATION,
    SE_DACL_AUTO_INHERIT_REQ, SE_DACL_AUTO_INHERITED, SE_DACL_PROTECTED, SetKernelObjectSecurity,
    SetSecurityDescriptorControl, UNPROTECTED_DACL_SECURITY_INFORMATION,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_FLAG_OVERLAPPED, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, GetFileInformationByHandle, READ_CONTROL, WRITE_DAC,
};

use crate::private_dir::{
    Local, PrivateDescriptor, Security, System, current_user, file_id, keeps_dacl, local_string,
    unsupported,
};

/// Why dohc leaves a staged file's DACL as it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeftReason {
    /// The file has other names. Every name of a file shares one DACL, so
    /// restricting the staged name would restrict the others too.
    HardLinks,
    /// Another account owns the file. An owner can always read a file and
    /// change its DACL, so restricting it would promise nothing.
    OtherOwner,
}

impl LeftReason {
    /// The reason as the engine records it.
    pub fn code(self) -> &'static str {
        match self {
            LeftReason::HardLinks => "hard-links",
            LeftReason::OtherOwner => "other-owner",
        }
    }
}

/// What a staged file's DACL is to dohc.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StagedSecurity {
    /// The file's own DACL in SDDL, to give back when it returns, and
    /// whether the file already has only the private DACL.
    Own { dacl: String, private: bool },
    /// dohc leaves the file's DACL as it is.
    Left(LeftReason),
}

/// A staged file: who it is, and its DACL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedFile {
    /// Its volume and file ID, the same for every name of the file.
    pub identity: String,
    pub security: StagedSecurity,
}

/// Open the regular file at `path` without following a link. `None` when
/// nothing is there, or when it is a link or a folder. Neither right dohc
/// asks for here is subject to another handle's sharing.
fn open_file(path: &Path, access: u32) -> io::Result<Option<File>> {
    let file = match std::fs::OpenOptions::new()
        .access_mode(access)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
        )
        .open(path)
    {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    let kind = file.metadata()?.file_type();
    Ok((kind.is_file() && !kind.is_symlink()).then_some(file))
}

fn identity_of(file: &File) -> io::Result<String> {
    file_id(file).ok_or_else(io::Error::last_os_error)
}

/// The identity of the regular file at `path`, or `None` when nothing, a
/// link or a folder is there.
pub fn file_identity(path: &Path) -> io::Result<Option<String>> {
    open_file(path, FILE_READ_ATTRIBUTES)?
        .map(|file| identity_of(&file))
        .transpose()
}

/// Read the staged file at `path`: its identity, and its own DACL unless
/// another account owns it or it has other names. `None` when nothing, a
/// link or a folder is there, and on a volume that keeps no DACL or a
/// network share, where dohc keeps nothing private.
pub fn read_staged(path: &Path) -> io::Result<Option<StagedFile>> {
    read_staged_in(path, &System::REAL)
}

fn read_staged_in(path: &Path, system: &System) -> io::Result<Option<StagedFile>> {
    let Some(file) = open_file(path, READ_CONTROL | FILE_READ_ATTRIBUTES)? else {
        return Ok(None);
    };
    if !keeps_dacl(&file)? {
        return Ok(None);
    }
    let identity = identity_of(&file)?;
    let security = match Security::read(&file, system) {
        Err(err) if unsupported(&err) => return Ok(None),
        read => read?,
    };
    let private = PrivateDescriptor::get()?;
    let owner = match (system.owner_of)(path) {
        Some(owner) => owner.to_owned(),
        None => security.owner()?,
    };
    let security = if !private.sids().contains(&owner.as_str()) {
        StagedSecurity::Left(LeftReason::OtherOwner)
    } else if links(&file)? > 1 {
        StagedSecurity::Left(LeftReason::HardLinks)
    } else {
        StagedSecurity::Own {
            dacl: dacl_sddl(&file)?,
            private: security.protected()?
                && security.allows_only(&private.sids(), |flags| flags == 0)?,
        }
    };
    Ok(Some(StagedFile { identity, security }))
}

/// Give the file at `path`, when it is the file `identity` names, the DACL
/// of a private file: protected, with full control for this user, SYSTEM
/// and Administrators. `false` when nothing or another file is there.
pub fn make_staged_private(path: &Path, identity: &str) -> io::Result<bool> {
    let user = current_user()?;
    set_dacl_of(
        path,
        identity,
        &format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{user})"),
    )
}

/// Give the file at `path`, when it is the file `identity` names, the DACL
/// `dacl` in SDDL as it was, its protection included. Windows passes
/// nothing down to it from its folder. `false` when nothing or another file
/// is there.
pub fn restore_dacl(path: &Path, identity: &str, dacl: &str) -> io::Result<bool> {
    set_dacl_of(path, identity, dacl)
}

fn set_dacl_of(path: &Path, identity: &str, dacl: &str) -> io::Result<bool> {
    let access = READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES;
    let Some(file) = open_file(path, access)? else {
        return Ok(false);
    };
    if identity_of(&file)? != identity {
        return Ok(false);
    }
    if dacl.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a DACL contains a null character",
        ));
    }
    let sddl: Vec<u16> = dacl.encode_utf16().chain([0]).collect();
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
    let descriptor = Local(descriptor);
    let (mut control, mut revision) = (0, 0);
    // SAFETY: The descriptor is valid while `descriptor` is alive.
    #[allow(unsafe_code)]
    if unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: As above.
    #[allow(unsafe_code)]
    if control & SE_DACL_AUTO_INHERITED != 0
        && unsafe {
            SetSecurityDescriptorControl(
                descriptor.0,
                SE_DACL_AUTO_INHERIT_REQ,
                SE_DACL_AUTO_INHERIT_REQ,
            )
        } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let protection = if control & SE_DACL_PROTECTED != 0 {
        PROTECTED_DACL_SECURITY_INFORMATION
    } else {
        UNPROTECTED_DACL_SECURITY_INFORMATION
    };
    // SAFETY: The handle is open and the descriptor valid for this
    // synchronous call, which copies what it needs.
    #[allow(unsafe_code)]
    let set = unsafe {
        SetKernelObjectSecurity(
            file.as_raw_handle() as HANDLE,
            DACL_SECURITY_INFORMATION | protection,
            descriptor.0,
        )
    };
    if set == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(true)
}

/// How many names the file has.
fn links(file: &File) -> io::Result<u32> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: The handle is open and `info` is writable for this synchronous
    // call, which retains neither.
    #[allow(unsafe_code)]
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(info.nNumberOfLinks)
}

/// The file's DACL in SDDL, with its protection and inheritance flags.
fn dacl_sddl(file: &File) -> io::Result<String> {
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: The handle is open for this synchronous call. `descriptor` is
    // freed once, by `Local`.
    #[allow(unsafe_code)]
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle() as HANDLE,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let descriptor = Local(descriptor);
    let mut text = std::ptr::null_mut();
    // SAFETY: The descriptor is valid while `descriptor` is alive. The string
    // Windows returns is freed once, by `Local`.
    #[allow(unsafe_code)]
    let converted = unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor.0,
            SDDL_REVISION_1,
            DACL_SECURITY_INFORMATION,
            &mut text,
            std::ptr::null_mut(),
        )
    };
    if converted == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(local_string(Local(text)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ensure_private_staging_dir;
    use crate::private_dir::tests::icacls;
    use dohc_test_scratch::ScratchDir;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use windows_sys::Win32::Security::GetFileSecurityW;

    /// A folder whose test DACL gives Users read access, as a shared
    /// workspace might, and a file in it.
    fn shared_file(scratch: &ScratchDir) -> PathBuf {
        let folder = scratch.join("workspace");
        std::fs::create_dir(&folder).expect("folder");
        icacls(&folder, &["/grant", "*S-1-5-32-545:(OI)(CI)R"]);
        let file = folder.join("notes.md");
        std::fs::write(&file, b"notes").expect("file");
        file
    }

    fn sddl(file: &Path) -> String {
        let flags =
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED;
        dacl_sddl(&crate::private_dir::open(file, READ_CONTROL, flags).expect("open"))
            .expect("dacl")
    }

    fn own(file: &Path) -> (String, String) {
        match read_staged(file).expect("read").expect("staged") {
            StagedFile {
                identity,
                security: StagedSecurity::Own { dacl, private },
            } => {
                assert!(!private, "{dacl}");
                (identity, dacl)
            }
            other => panic!("{other:?}"),
        }
    }

    /// Save a file's DACL, make it private, and give the DACL back: the file
    /// ends with the DACL it had, and was private in between.
    fn round_trip(file: &Path) {
        let before = sddl(file);
        let (identity, dacl) = own(file);
        assert_eq!(dacl, before);
        assert!(make_staged_private(file, &identity).expect("private"));
        let user = current_user().expect("user");
        assert_eq!(
            sddl(file),
            format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{user})")
        );
        assert!(matches!(
            read_staged(file).expect("read").expect("staged").security,
            StagedSecurity::Own { private: true, .. }
        ));
        assert!(restore_dacl(file, &identity, &dacl).expect("restore"));
        assert_eq!(sddl(file), before);
    }

    #[test]
    fn a_file_with_only_inherited_entries_gets_them_back() {
        let scratch = ScratchDir::new().expect("scratch");
        let file = shared_file(&scratch);
        assert!(sddl(&file).contains("(A;ID;FR;;;BU)"), "{}", sddl(&file));
        round_trip(&file);
    }

    #[test]
    fn a_file_with_entries_of_its_own_and_inherited_ones_gets_both_back() {
        let scratch = ScratchDir::new().expect("scratch");
        let file = shared_file(&scratch);
        icacls(&file, &["/grant", "*S-1-5-11:(M)"]);
        let before = sddl(&file);
        assert!(
            before.contains(";;;AU)") && before.contains("ID;"),
            "{before}"
        );
        round_trip(&file);
    }

    #[test]
    fn a_protected_dacl_comes_back_protected() {
        let scratch = ScratchDir::new().expect("scratch");
        let file = shared_file(&scratch);
        let user = format!("*{}:(F)", current_user().expect("user"));
        icacls(
            &file,
            &["/inheritance:r", "/grant:r", "*S-1-5-32-545:(R)", &user],
        );
        assert!(sddl(&file).starts_with("D:PAI"), "{}", sddl(&file));
        round_trip(&file);
    }

    #[test]
    fn a_null_dacl_comes_back_null() {
        let scratch = ScratchDir::new().expect("scratch");
        let file = shared_file(&scratch);
        let identity = file_identity(&file).expect("identity").expect("file");
        assert!(restore_dacl(&file, &identity, "D:NO_ACCESS_CONTROL").expect("null"));
        assert_eq!(sddl(&file), "D:NO_ACCESS_CONTROL");
        round_trip(&file);
    }

    /// The DACL Windows keeps for the file at `path`, read without asking
    /// for the right to wait on it, which a file with an empty DACL refuses
    /// even to its owner.
    fn stored_sddl(path: &Path) -> String {
        let name: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        let mut needed = 0;
        let mut buffer = vec![0u64; 512];
        // SAFETY: The name ends with one null, and the buffer is writable for
        // its length, through this synchronous call. Both outlive it.
        #[allow(unsafe_code)]
        let read = unsafe {
            GetFileSecurityW(
                name.as_ptr(),
                DACL_SECURITY_INFORMATION,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * 8) as u32,
                &mut needed,
            )
        };
        assert_ne!(read, 0, "{}", io::Error::last_os_error());
        let mut text = std::ptr::null_mut();
        // SAFETY: The buffer holds the descriptor Windows wrote. The string
        // it returns is freed once, by `Local`.
        #[allow(unsafe_code)]
        let converted = unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                buffer.as_mut_ptr().cast(),
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(converted, 0);
        local_string(Local(text))
    }

    /// No one can open a file with an empty DACL to read it, dohc included,
    /// so dohc leaves it as it is. One that comes back with dohc's DACL gets
    /// its empty DACL back.
    #[test]
    fn an_empty_dacl_comes_back_empty() {
        for empty in ["D:P", "D:"] {
            let scratch = ScratchDir::new().expect("scratch");
            let file = shared_file(&scratch);
            let identity = file_identity(&file).expect("identity").expect("file");
            assert!(make_staged_private(&file, &identity).expect("private"));
            assert!(restore_dacl(&file, &identity, empty).expect("empty"));
            assert_eq!(stored_sddl(&file), empty);
            let refused = read_staged(&file).expect_err("empty");
            assert_eq!(refused.kind(), io::ErrorKind::PermissionDenied);
            assert_eq!(stored_sddl(&file), empty);
        }
    }

    /// A DACL is given back only through a handle on the file it was read
    /// from, never to another file now at its name.
    #[test]
    fn another_file_at_the_name_keeps_its_dacl() {
        let scratch = ScratchDir::new().expect("scratch");
        let file = shared_file(&scratch);
        let (identity, _) = own(&file);
        std::fs::remove_file(&file).expect("remove");
        assert!(!make_staged_private(&file, &identity).expect("missing"));
        std::fs::write(&file, b"another").expect("another");
        let before = sddl(&file);
        assert!(!make_staged_private(&file, &identity).expect("other"));
        assert!(!restore_dacl(&file, &identity, "D:NO_ACCESS_CONTROL").expect("other"));
        assert_eq!(sddl(&file), before);
    }

    #[test]
    fn a_file_with_other_names_is_left_as_it_is() {
        let scratch = ScratchDir::new().expect("scratch");
        let file = shared_file(&scratch);
        std::fs::hard_link(&file, file.with_file_name("other.md")).expect("link");
        let staged = read_staged(&file).expect("read").expect("staged");
        assert_eq!(staged.security, StagedSecurity::Left(LeftReason::HardLinks));
    }

    #[test]
    fn a_file_another_account_owns_is_left_as_it_is() {
        let scratch = ScratchDir::new().expect("scratch");
        let file = shared_file(&scratch);
        let users_own_it = System::owned_by(|_| Some("S-1-5-32-545"));
        let staged = read_staged_in(&file, &users_own_it)
            .expect("read")
            .expect("staged");
        assert_eq!(
            staged.security,
            StagedSecurity::Left(LeftReason::OtherOwner)
        );
        let administrators_own_it = System::owned_by(|_| Some("S-1-5-32-544"));
        let staged = read_staged_in(&file, &administrators_own_it)
            .expect("read")
            .expect("staged");
        assert!(matches!(staged.security, StagedSecurity::Own { .. }));
    }

    /// A folder dohc stages files in beside the workspace admits only this
    /// user, SYSTEM and Administrators, whether dohc makes it or finds it
    /// from an earlier version, and a file already in it keeps its DACL
    /// until dohc saves it.
    #[test]
    fn a_staging_folder_is_private_on_its_own() {
        let scratch = ScratchDir::new().expect("scratch");
        let file = shared_file(&scratch);
        let user = current_user().expect("user");
        let private = format!("(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{user})");
        let made = file.with_file_name(".dohc-write-displaced");
        ensure_private_staging_dir(&made).expect("new");
        assert_eq!(sddl(&made), format!("D:P{private}"));

        let earlier = scratch.join("earlier");
        std::fs::create_dir(&earlier).expect("earlier");
        icacls(&earlier, &["/grant", "*S-1-5-32-545:(OI)(CI)R"]);
        let staged = earlier.join("notes.md");
        std::fs::rename(&file, &staged).expect("stage");
        let before = sddl(&staged);
        assert!(before.contains("(A;ID;FR;;;BU)"), "{before}");
        ensure_private_staging_dir(&earlier).expect("earlier");
        assert_eq!(sddl(&earlier), format!("D:P{private}"));
        assert_eq!(sddl(&staged), before);

        let not_a_folder = scratch.join("file");
        std::fs::write(&not_a_folder, b"file").expect("file");
        let refused = ensure_private_staging_dir(&not_a_folder).expect_err("file");
        assert!(crate::not_private(&refused).is_some(), "{refused}");
    }

    #[test]
    fn nothing_and_a_folder_are_not_staged_files() {
        let scratch = ScratchDir::new().expect("scratch");
        assert_eq!(
            read_staged(&scratch.join("missing")).expect("missing"),
            None
        );
        assert_eq!(read_staged(scratch.path()).expect("folder"), None);
        assert_eq!(file_identity(scratch.path()).expect("folder"), None);
    }
}
