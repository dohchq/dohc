//! A minimal, runtime-agnostic cooperative cancellation signal.
//!
//! Deliberately dependency-free (std only) so the core protocol crate —
//! which mobile/web hosts would link — carries no tokio requirement
//! (portability guardrail 2). The supervisor feature composes it with tokio.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

#[derive(Debug, Default)]
struct Inner {
    cancelled: AtomicBool,
    wakers: Mutex<Vec<Waker>>,
}

/// Clonable cancellation signal. All clones observe the same state.
#[derive(Debug, Clone, Default)]
pub struct CancelSignal {
    inner: Arc<Inner>,
}

impl CancelSignal {
    pub fn new() -> Self {
        Self::default()
    }

    /// Cancel. Idempotent; wakes every pending [`cancelled`](Self::cancelled)
    /// future.
    pub fn cancel(&self) {
        if self.inner.cancelled.swap(true, Ordering::SeqCst) {
            return;
        }
        let wakers = {
            let mut guard = self
                .inner
                .wakers
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            std::mem::take(&mut *guard)
        };
        for waker in wakers {
            waker.wake();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    /// A future that resolves once the signal is cancelled.
    pub fn cancelled(&self) -> Cancelled {
        Cancelled {
            signal: self.clone(),
        }
    }
}

/// Future returned by [`CancelSignal::cancelled`].
#[derive(Debug)]
pub struct Cancelled {
    signal: CancelSignal,
}

impl Future for Cancelled {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.signal.is_cancelled() {
            return Poll::Ready(());
        }
        let mut wakers = self
            .signal
            .inner
            .wakers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Re-check under the lock: a concurrent cancel() may have drained the
        // waker list between the fast check above and taking the lock.
        if self.signal.is_cancelled() {
            return Poll::Ready(());
        }
        if !wakers.iter().any(|waker| waker.will_wake(cx.waker())) {
            wakers.push(cx.waker().clone());
        }
        Poll::Pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::task::{Context, Wake};

    struct FlagWaker(AtomicBool);

    impl Wake for FlagWaker {
        fn wake(self: Arc<Self>) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn resolves_only_after_cancel_and_wakes() {
        let signal = CancelSignal::new();
        let flag = Arc::new(FlagWaker(AtomicBool::new(false)));
        let waker = Waker::from(flag.clone());
        let mut cx = Context::from_waker(&waker);

        let mut future = signal.cancelled();
        assert_eq!(Pin::new(&mut future).poll(&mut cx), Poll::Pending);
        // Polling twice must not duplicate the waker.
        assert_eq!(Pin::new(&mut future).poll(&mut cx), Poll::Pending);
        assert!(!flag.0.load(Ordering::SeqCst));

        signal.cancel();
        assert!(flag.0.load(Ordering::SeqCst), "waker must fire on cancel");
        assert_eq!(Pin::new(&mut future).poll(&mut cx), Poll::Ready(()));
        assert!(signal.is_cancelled());

        // Idempotent and immediately ready afterwards.
        signal.cancel();
        let mut second = signal.cancelled();
        assert_eq!(Pin::new(&mut second).poll(&mut cx), Poll::Ready(()));
    }
}
