#[cfg(test)]
use std::sync::Arc;
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FaultPoint {
    BackupAfterDatabaseCopy,
    BackupDuringDatabaseVerify,
    BackupDuringDirectoryCopy,
    AfterBackedUp,
    AfterMovedAside,
    AfterInitialized,
}

impl FaultPoint {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BackupAfterDatabaseCopy => "rehearsal.backup.after-database-copy",
            Self::BackupDuringDatabaseVerify => "rehearsal.backup.during-database-verify",
            Self::BackupDuringDirectoryCopy => "rehearsal.backup.during-directory-copy",
            Self::AfterBackedUp => "rehearsal.after-backed-up",
            Self::AfterMovedAside => "rehearsal.after-moved-aside",
            Self::AfterInitialized => "rehearsal.after-initialized",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultAction {
    Continue,
    Crash,
}

pub trait FaultInjector: Send + Sync {
    fn poll(&self, point: FaultPoint) -> FaultAction;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NoFaults;

impl FaultInjector for NoFaults {
    fn poll(&self, _point: FaultPoint) -> FaultAction {
        FaultAction::Continue
    }
}

#[cfg(test)]
pub(crate) struct ScriptedFaults {
    point: FaultPoint,
    armed: AtomicBool,
}

#[cfg(test)]
impl ScriptedFaults {
    pub(crate) fn crash_at(point: FaultPoint) -> Arc<Self> {
        Arc::new(Self {
            point,
            armed: AtomicBool::new(true),
        })
    }

    pub(crate) fn fired(&self) -> bool {
        !self.armed.load(Ordering::Acquire)
    }
}

#[cfg(test)]
impl FaultInjector for ScriptedFaults {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == self.point && self.armed.swap(false, Ordering::AcqRel) {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}
