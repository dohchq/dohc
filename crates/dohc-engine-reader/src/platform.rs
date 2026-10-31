//! OS containment, not a security sandbox. All reader FFI stays here.
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
};
/// Refuse links and special files before any blocking read. Keep this handle
/// alive until the child exits; Windows excludes writers and replacement.
pub(super) fn open_asset(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    use std::{fs::OpenOptions, io};
    for parent in path.ancestors().skip(1) {
        let metadata = std::fs::symlink_metadata(parent)?;
        if metadata.file_type().is_symlink() {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        #[cfg(unix)]
        check_owner(&metadata, true)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(io::ErrorKind::InvalidInput.into());
            }
        }
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    #[cfg(unix)]
    check_owner(&metadata, false)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::ErrorKind::InvalidInput.into());
        }
    }
    if !metadata.is_file() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(file)
}
#[cfg(unix)]
fn check_owner(metadata: &std::fs::Metadata, directory: bool) -> std::io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid has no pointer arguments or side effects.
    let owner = unsafe { libc::geteuid() };
    let trusted_admin_gid = if cfg!(target_os = "macos") {
        Some(80)
    } else {
        None
    };
    if !trusted_owner(
        metadata.uid(),
        metadata.gid(),
        metadata.mode(),
        directory,
        owner,
        trusted_admin_gid,
    ) {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

#[cfg_attr(not(unix), allow(dead_code))]
fn trusted_owner(
    uid: u32,
    gid: u32,
    mode: u32,
    directory: bool,
    effective_uid: u32,
    trusted_admin_gid: Option<u32>,
) -> bool {
    let sticky_root = directory && uid == 0 && mode & 0o1000 != 0;
    // macOS administrators can already become root; this adds no new writer.
    let admin_root = directory
        && uid == 0
        && trusted_admin_gid == Some(gid)
        && mode & 0o020 != 0
        && mode & 0o002 == 0;
    sticky_root || admin_root || (mode & 0o022 == 0 && (uid == 0 || uid == effective_uid))
}

#[cfg(test)]
mod ownership_tests {
    use super::trusted_owner;

    #[test]
    fn macos_applications_accepts_root_admin_group_writes() {
        assert!(trusted_owner(0, 80, 0o775, true, 501, Some(80)));
        assert!(trusted_owner(0, 80, 0o775, true, 502, Some(80)));
    }

    #[test]
    fn admin_trust_does_not_extend_to_files_or_other_writers() {
        for (uid, gid, mode, directory) in [
            (0, 80, 0o775, false),
            (0, 80, 0o777, true),
            (0, 20, 0o775, true),
            (502, 80, 0o755, true),
            (502, 80, 0o444, false),
            (501, 80, 0o775, true),
        ] {
            assert!(!trusted_owner(uid, gid, mode, directory, 501, Some(80)));
        }
    }

    #[test]
    fn linux_policy_without_admin_trust_is_unchanged() {
        for uid in [0, 501, 502] {
            for gid in [0, 80, 501] {
                for mode in 0..=0o7777 {
                    for directory in [false, true] {
                        let sticky_root = directory && uid == 0 && mode & 0o1000 != 0;
                        let original =
                            sticky_root || (mode & 0o022 == 0 && (uid == 0 || uid == 501));
                        assert_eq!(
                            trusted_owner(uid, gid, mode, directory, 501, None),
                            original
                        );
                    }
                }
            }
        }
    }
}
#[cfg(windows)]
pub(super) fn asset_identity(file: &std::fs::File) -> std::io::Result<(u32, u32, u32)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    // SAFETY: the handle is live and the output is a correctly sized local struct.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the handle is live and info is a writable, correctly sized output.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}
#[cfg(unix)]
mod os {
    use std::{
        io,
        os::unix::process::CommandExt,
        process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    };
    pub struct Process {
        child: Child,
        reaped: bool,
    }
    pub type Pipes = (Process, ChildStdout, ChildStdin, ChildStderr);
    #[cfg(target_os = "linux")]
    fn descriptor_fallback(limit: i32) -> io::Result<()> {
        if limit > 65_536 {
            return Err(io::Error::from_raw_os_error(libc::ENOTSUP));
        }
        for fd in 3..limit {
            // SAFETY: fcntl changes only the inherited descriptor's close-on-exec flag.
            if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::EBADF) {
                    return Err(error);
                }
            }
        }
        Ok(())
    }
    #[test]
    #[cfg(target_os = "linux")]
    fn descriptor_fallback_refuses_unbounded_scans() {
        assert_eq!(
            descriptor_fallback(65_537).unwrap_err().raw_os_error(),
            Some(libc::ENOTSUP)
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    #[ignore = "release measurement; run alone with pinned affinity"]
    fn descriptor_fallback_measurement() {
        for round in 0..31 {
            let start = std::time::Instant::now();
            descriptor_fallback(65_536).unwrap();
            println!(
                "fallback {round} {}",
                start.elapsed().as_secs_f64() * 1000.0
            );
        }
    }
    pub fn spawn(command: &mut Command) -> io::Result<Pipes> {
        #[cfg(target_os = "linux")]
        // SAFETY: getrlimit writes a correctly sized local struct.
        let mut limit: libc::rlimit = unsafe { std::mem::zeroed() };
        #[cfg(target_os = "linux")]
        // SAFETY: The writable limit pointer is valid for this synchronous call.
        if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
            return Err(io::Error::last_os_error());
        }
        #[cfg(target_os = "linux")]
        let limit = limit.rlim_max.min(i32::MAX as libc::rlim_t) as i32;
        #[cfg(target_os = "macos")]
        let limit = {
            let mut limit: i32 = 0;
            let mut size = std::mem::size_of_val(&limit);
            let mut name = [libc::CTL_KERN, libc::KERN_MAXFILESPERPROC];
            // SAFETY: sysctl reads the two-element name and writes the sized integer.
            if unsafe {
                libc::sysctl(
                    name.as_mut_ptr(),
                    2,
                    (&mut limit as *mut i32).cast(),
                    &mut size,
                    std::ptr::null_mut(),
                    0,
                )
            } != 0
            {
                return Err(io::Error::last_os_error());
            }
            if limit < 3 {
                return Err(io::Error::from(io::ErrorKind::InvalidData));
            }
            limit
        };
        #[cfg(target_os = "linux")]
        // SAFETY: getpid has no pointer arguments or side effects.
        let parent = unsafe { libc::getpid() };
        command.process_group(0);
        // SAFETY: The callback only calls async-signal-safe OS operations, allocates
        // nothing and takes no locks. Captured values were obtained before fork.
        unsafe {
            command.pre_exec(move || {
                #[cfg(target_os = "linux")]
                {
                    // Linux ties this signal to the spawning owner thread's lifetime.
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    // A parent that died before prctl must not leave an orphan.
                    if libc::getppid() != parent {
                        return Err(io::Error::from_raw_os_error(libc::ESRCH));
                    }
                    // CLOEXEC keeps Rust's exec-error pipe usable until exec.
                    if libc::syscall(
                        libc::SYS_close_range,
                        3u32,
                        u32::MAX,
                        libc::CLOSE_RANGE_CLOEXEC,
                    ) == 0
                    {
                        return Ok(());
                    }
                }
                #[cfg(target_os = "linux")]
                return descriptor_fallback(limit);
                #[cfg(target_os = "macos")]
                {
                    for fd in 3..limit {
                        if libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) == -1 {
                            let error = io::Error::last_os_error();
                            if error.raw_os_error() != Some(libc::EBADF) {
                                return Err(error);
                            }
                        }
                    }
                    Ok(())
                }
            });
        }
        let mut child = command.spawn()?;
        let pipes = (
            child.stdout.take().unwrap(),
            child.stdin.take().unwrap(),
            child.stderr.take().unwrap(),
        );
        Ok((
            Process {
                child,
                reaped: false,
            },
            pipes.0,
            pipes.1,
            pipes.2,
        ))
    }
    impl Process {
        pub fn id(&self) -> u32 {
            self.child.id()
        }
        pub fn terminate(&mut self) {
            if self.reaped {
                return;
            }
            // SAFETY: The child is unreaped, so its PID cannot be reused. A negative
            // PID addresses the process group established before its exec.
            unsafe {
                libc::kill(-(self.id() as i32), libc::SIGKILL);
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
            self.reaped = true;
        }
    }
    #[cfg(test)]
    pub fn exit_code(process: &mut Process) -> Option<u32> {
        let code = process.child.wait().unwrap().code().map(|c| c as u32);
        process.reaped = true;
        code
    }
}

#[cfg(windows)]
mod os {
    use std::{
        ffi::OsStr,
        fs::File,
        io,
        mem::{size_of, zeroed},
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        process::Command,
        ptr::{null, null_mut},
        sync::Mutex,
    };
    use windows_sys::Win32::{
        Foundation::*,
        System::{JobObjects::*, Pipes::CreatePipe, Threading::*},
    };
    pub struct Process {
        process: OwnedHandle,
        job: OwnedHandle,
        #[cfg(test)]
        pid: u32,
    }
    pub type Pipes = (Process, File, File, File);
    fn check(ok: i32) -> io::Result<()> {
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: Callers pass a newly created handle, transferring its sole ownership.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }
    fn encoded(value: &OsStr) -> io::Result<Vec<u16>> {
        let bytes: Vec<_> = value.encode_wide().collect();
        if bytes.contains(&0) {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        Ok(bytes)
    }
    fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
        let mut bytes = encoded(value)?;
        bytes.push(0);
        Ok(bytes)
    }
    fn quoted(value: &OsStr, out: &mut Vec<u16>) -> io::Result<()> {
        out.push(34);
        let mut slashes = 0;
        for ch in encoded(value)? {
            if ch == 92 {
                slashes += 1;
                continue;
            }
            out.extend(std::iter::repeat_n(
                92,
                slashes * if ch == 34 { 2 } else { 1 },
            ));
            if ch == 34 {
                out.push(92);
            }
            out.push(ch);
            slashes = 0;
        }
        out.extend(std::iter::repeat_n(92, slashes * 2));
        out.push(34);
        Ok(())
    }
    fn pipe(child_reads: bool) -> io::Result<(File, OwnedHandle)> {
        let (mut read, mut write) = (null_mut(), null_mut());
        // SAFETY: Writable handle slots live through the call; null attributes disable inheritance.
        unsafe {
            check(CreatePipe(&mut read, &mut write, null(), 0))?;
        }
        let (read, write) = (owned(read)?, owned(write)?);
        let (parent, child) = if child_reads {
            (write, read)
        } else {
            (read, write)
        };
        Ok((File::from(parent), child))
    }
    struct Attributes(Vec<usize>);
    impl Drop for Attributes {
        fn drop(&mut self) {
            // SAFETY: This buffer contains an initialized list and still owns its allocation.
            unsafe {
                DeleteProcThreadAttributeList(self.0.as_mut_ptr().cast());
            }
        }
    }
    pub fn spawn(command: &mut Command) -> io::Result<Pipes> {
        // Command holds arguments, cwd and an explicit environment; CreateProcessW owns launch.
        let program = wide(command.get_program())?;
        let cwd = wide(
            command
                .get_current_dir()
                .ok_or(io::ErrorKind::InvalidInput)?
                .as_os_str(),
        )?;
        let mut line = Vec::new();
        quoted(command.get_program(), &mut line)?;
        for arg in command.get_args() {
            line.push(32);
            quoted(arg, &mut line)?;
        }
        line.push(0);
        let mut environment = Vec::new();
        for (key, value) in command.get_envs() {
            if let Some(value) = value {
                environment.extend(encoded(key)?);
                environment.push(61);
                environment.extend(wide(value)?);
            }
        }
        environment.push(0);
        if environment.len() == 1 {
            environment.push(0);
        }
        // Any other engine spawn must use platform::spawn or share this lock; std's spawn lock does not cover this path.
        static SPAWN: Mutex<()> = Mutex::new(());
        let _spawn = SPAWN.lock().map_err(|_| io::ErrorKind::Other)?;
        let (stdin, input) = pipe(true)?;
        let (stdout, output) = pipe(false)?;
        let (stderr, error) = pipe(false)?;
        // SAFETY: No name or security attributes; the returned handle is uniquely owned.
        let job = owned(unsafe { CreateJobObjectW(null(), null()) })?;
        // SAFETY: These Win32 plain-data structs accept all-zero initialization.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        limits.BasicLimitInformation.ActiveProcessLimit = 1;
        limits.ProcessMemoryLimit = 1024 * 1024 * 1024;
        // SAFETY: The job and correctly sized input buffer remain live for the synchronous call.
        unsafe {
            check(SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of_val(&limits) as u32,
            ))?;
        }
        let mut size = 0;
        // SAFETY: The null-list query writes only the provided size slot.
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut size);
        }
        if size == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut storage = vec![0usize; size.div_ceil(size_of::<usize>())];
        // SAFETY: The allocation is pointer-aligned and at least the queried byte size.
        unsafe {
            check(InitializeProcThreadAttributeList(
                storage.as_mut_ptr().cast(),
                2,
                0,
                &mut size,
            ))?;
        }
        let mut attributes = Attributes(storage);
        let list = attributes.0.as_mut_ptr().cast();
        let handles = [
            input.as_raw_handle(),
            output.as_raw_handle(),
            error.as_raw_handle(),
        ];
        let jobs = [job.as_raw_handle()];
        // SAFETY: Both arrays, their handles and the initialized attribute list live
        // through CreateProcessW. The only inherited handles are these three pipes.
        unsafe {
            for (attribute, values) in [
                (PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles.as_slice()),
                (PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs.as_slice()),
            ] {
                check(UpdateProcThreadAttribute(
                    list,
                    0,
                    attribute as usize,
                    values.as_ptr().cast(),
                    size_of_val(values),
                    null_mut(),
                    null(),
                ))?;
            }
        }
        // SAFETY: These Win32 output/startup structs accept zero initialization.
        let (mut startup, mut info): (STARTUPINFOEXW, PROCESS_INFORMATION) =
            unsafe { (zeroed(), zeroed()) };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = handles[0];
        startup.StartupInfo.hStdOutput = handles[1];
        startup.StartupInfo.hStdError = handles[2];
        startup.lpAttributeList = list;
        // SAFETY: All null-terminated buffers and attributes remain live. Atomic Job
        // assignment prevents any user code running outside the configured limits.
        unsafe {
            for handle in handles {
                check(SetHandleInformation(
                    handle,
                    HANDLE_FLAG_INHERIT,
                    HANDLE_FLAG_INHERIT,
                ))?;
            }
            check(CreateProcessW(
                program.as_ptr(),
                line.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                environment.as_ptr().cast(),
                cwd.as_ptr(),
                (&startup as *const STARTUPINFOEXW).cast(),
                &mut info,
            ))?;
        }
        let process = owned(info.hProcess)?;
        drop(owned(info.hThread)?);
        Ok((
            Process {
                process,
                job,
                #[cfg(test)]
                pid: info.dwProcessId,
            },
            stdout,
            stdin,
            stderr,
        ))
    }
    impl Process {
        #[cfg(test)]
        pub fn id(&self) -> u32 {
            self.pid
        }
        pub fn terminate(&mut self) {
            // SAFETY: Both handles remain owned. Termination also ends any process
            // in the Job; waiting on our process does not reap an unrelated PID.
            unsafe {
                TerminateJobObject(self.job.as_raw_handle(), 1);
                WaitForSingleObject(self.process.as_raw_handle(), INFINITE);
            }
        }
    }
    #[cfg(test)]
    pub fn exit_code(process: &mut Process) -> Option<u32> {
        let mut code = 0;
        // SAFETY: The process handle and writable exit-code slot remain valid.
        unsafe {
            if WaitForSingleObject(process.process.as_raw_handle(), 10000) != WAIT_OBJECT_0 {
                return None;
            }
            check(GetExitCodeProcess(
                process.process.as_raw_handle(),
                &mut code,
            ))
            .unwrap();
        }
        Some(code)
    }
}
#[cfg(test)]
pub(super) use os::exit_code;
#[cfg(all(test, unix))]
pub(super) fn leave_test_group() {
    // SAFETY: The helper joins its parent's group in the same session before its receipt.
    assert_eq!(
        unsafe { libc::setpgid(0, libc::getpgid(libc::getppid())) },
        0
    );
}
pub(super) use os::{Process, spawn};

#[cfg(test)]
pub(super) fn extra_handle() -> (Vec<std::fs::File>, usize) {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{HANDLE_FLAG_INHERIT, SetHandleInformation};
        let mut files = vec![tempfile::tempfile().unwrap()];
        for _ in 0..256 {
            files.push(files[0].try_clone().unwrap());
        }
        let handle = files.last().unwrap().as_raw_handle();
        // SAFETY: This live file handle belongs to the test and remains open.
        assert_ne!(
            unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) },
            0
        );
        (files, handle as usize)
    }
    #[cfg(unix)]
    {
        use std::os::fd::{AsRawFd, FromRawFd};
        let file = tempfile::tempfile().unwrap();
        // SAFETY: F_DUPFD creates a distinct owned descriptor without CLOEXEC.
        let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD, 200) };
        assert!(fd >= 200);
        // SAFETY: The successful fcntl returned a new descriptor owned by this test.
        (vec![unsafe { std::fs::File::from_raw_fd(fd) }], fd as usize)
    }
}
#[cfg(test)]
pub(super) fn inherited(value: usize) -> bool {
    #[cfg(windows)]
    {
        let mut flags = 0;
        // SAFETY: GetHandleInformation accepts an arbitrary numeric handle and reports invalid ones.
        unsafe { windows_sys::Win32::Foundation::GetHandleInformation(value as _, &mut flags) != 0 }
    }
    #[cfg(unix)]
    // SAFETY: F_GETFD accepts any descriptor number and reports EBADF for closed ones.
    unsafe {
        libc::fcntl(value as i32, libc::F_GETFD) != -1
    }
}
#[cfg(test)]
pub(super) fn alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::{Foundation::*, System::Threading::*};
        // SAFETY: The API validates this PID; every returned handle is closed here.
        unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if handle.is_null() {
                return false;
            }
            let alive = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
            CloseHandle(handle);
            alive
        }
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .is_ok_and(|s| !s.rsplit_once(')').unwrap().1.trim_start().starts_with('Z'))
    }
    #[cfg(target_os = "macos")]
    // SAFETY: Signal zero only probes the test-owned process.
    unsafe {
        libc::kill(pid as i32, 0) == 0
    }
}
#[cfg(test)]
pub(super) fn kill_test_child(pid: u32) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::*};
        // SAFETY: The PID comes from this test's child receipt, and its handle is closed.
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !handle.is_null() {
                TerminateProcess(handle, 1);
                CloseHandle(handle);
            }
        }
    }
    #[cfg(unix)]
    // SAFETY: The PID comes from this test's live child receipt.
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}
