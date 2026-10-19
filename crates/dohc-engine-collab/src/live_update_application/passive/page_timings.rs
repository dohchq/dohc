//! Test-only phase measurements. Shipping builds omit these clocks and storage.

use std::cell::Cell;
use std::time::Instant;

#[derive(Clone, Copy, Debug, Default)]
pub struct PageTimings {
    pub row_loop_ms: f64,
    pub dependency_check_ms: f64,
}

thread_local! {
    static LAST: Cell<Option<PageTimings>> = const { Cell::new(None) };
}

pub fn take_last() -> Option<PageTimings> {
    LAST.with(Cell::take)
}

#[derive(Default)]
pub(super) struct PhaseTimer {
    start: Option<Instant>,
    phases: PageTimings,
}

impl PhaseTimer {
    pub(super) fn start_rows(&mut self) {
        LAST.with(|last| last.set(None));
        self.start = Some(Instant::now());
    }

    pub(super) fn start_check(&mut self) {
        self.phases.row_loop_ms = self.elapsed();
        self.start = Some(Instant::now());
    }

    pub(super) fn finish_check(&mut self) {
        self.phases.dependency_check_ms = self.elapsed();
    }

    pub(super) fn publish(&self) {
        LAST.with(|last| last.set(Some(self.phases)));
    }

    fn elapsed(&self) -> f64 {
        self.start.expect("phase started").elapsed().as_secs_f64() * 1000.0
    }
}
