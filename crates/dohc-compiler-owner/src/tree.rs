//! The processes one build started, and how the owner measures and stops them.
use crate::sys::{self, Identity, Pid, Signalled, State};
use std::collections::{HashMap, HashSet};
use std::io;
use std::thread::sleep;
use std::time::{Duration, Instant};

/// The process table the owner reads and signals. Tests describe their own.
pub trait Table {
    fn group_members(&mut self, group: Pid) -> io::Result<Vec<Pid>>;
    fn children(&mut self, parent: Pid) -> io::Result<Vec<Pid>>;
    fn state(&mut self, pid: Pid) -> io::Result<State>;
    fn footprint(&mut self, pid: Pid) -> io::Result<Option<u64>>;
    /// How many of the user's task slots a live `pid` takes.
    fn threads(&mut self, pid: Pid) -> io::Result<u64>;
    fn kill(&mut self, pid: Pid) -> io::Result<Signalled>;
    /// Collects every exited child of the owner. True while the owner still
    /// has a child, or may have one.
    fn reap(&mut self) -> bool;
}

/// The real process table.
pub struct System;

impl Table for System {
    fn group_members(&mut self, group: Pid) -> io::Result<Vec<Pid>> {
        sys::group_members(group)
    }
    fn children(&mut self, parent: Pid) -> io::Result<Vec<Pid>> {
        sys::children(parent)
    }
    fn state(&mut self, pid: Pid) -> io::Result<State> {
        sys::state(pid)
    }
    fn footprint(&mut self, pid: Pid) -> io::Result<Option<u64>> {
        sys::footprint(pid)
    }
    fn threads(&mut self, pid: Pid) -> io::Result<u64> {
        sys::threads(pid)
    }
    fn kill(&mut self, pid: Pid) -> io::Result<Signalled> {
        sys::kill(pid)
    }
    fn reap(&mut self) -> bool {
        sys::reap_children()
    }
}

/// The live processes found by one look at the process table.
struct Census {
    /// Pids to measure or kill. A freshly listed pid the table could not
    /// describe is included, so teardown still signals it.
    live: Vec<Pid>,
    /// False when any part of the table could not be read. An incomplete
    /// census never proves the tree is empty.
    complete: bool,
    /// Listed processes that already exited: zombies no one has reaped.
    unreaped: usize,
}

pub struct Sample {
    pub processes: usize,
    /// The user's task slots the tree takes: each live process's threads,
    /// and every process it has not reaped. Each one counts against the
    /// user's limit, so a tree that hoards them can stop the user's other
    /// programs from starting a process or thread.
    pub tasks: u64,
    pub footprint: u64,
}

pub struct Tree<T: Table> {
    owner: Pid,
    /// Descendants seen earlier, with their identities. A descendant that
    /// left the owner's group with setsid or setpgid stays reachable here
    /// after its parent exits. An entry leaves only once the table shows its
    /// pid gone or naming another process.
    known: HashMap<Pid, Identity>,
    table: T,
}

impl<T: Table> Tree<T> {
    /// `owner` leads the process group the worker and esbuild inherit.
    pub fn new(owner: Pid, table: T) -> Tree<T> {
        Tree {
            owner,
            known: HashMap::new(),
            table,
        }
    }

    /// Walks the owner's group, the owner's children and every known
    /// descendant, then each live process's children. A strict census fails
    /// on the first unreadable entry. A lenient one keeps going for teardown.
    fn census(&mut self, strict: bool) -> io::Result<Census> {
        let mut complete = true;
        let mut fail = |error: io::Error| {
            if strict {
                Err(error)
            } else {
                complete = false;
                Ok(())
            }
        };
        // (pid, identity it must still have)
        let mut queue: Vec<(Pid, Option<Identity>)> = Vec::new();
        match self.table.group_members(self.owner) {
            Ok(pids) => queue.extend(pids.into_iter().map(|pid| (pid, None))),
            Err(error) => fail(error)?,
        }
        match self.table.children(self.owner) {
            Ok(pids) => queue.extend(pids.into_iter().map(|pid| (pid, None))),
            Err(error) => fail(error)?,
        }
        queue.extend(
            self.known
                .values()
                .map(|identity| (identity.pid, Some(*identity))),
        );
        let mut found: HashMap<Pid, Identity> = HashMap::new();
        // Known descendants this census could not inspect. They stay known.
        let mut unchecked: HashMap<Pid, Identity> = HashMap::new();
        let mut unreadable: Vec<Pid> = Vec::new();
        let mut unreaped: HashSet<Pid> = HashSet::new();
        while let Some((pid, expected)) = queue.pop() {
            if pid == self.owner || found.contains_key(&pid) || unreadable.contains(&pid) {
                continue;
            }
            match self.table.state(pid) {
                Ok(State::Live(identity)) => {
                    // The pid now names an unrelated process.
                    if expected.is_some_and(|expected| expected != identity) {
                        continue;
                    }
                    found.insert(pid, identity);
                    match self.table.children(pid) {
                        Ok(pids) => queue.extend(pids.into_iter().map(|child| (child, None))),
                        Err(error) => fail(error)?,
                    }
                }
                // Listed but gone: it exited, and its parent has not reaped it.
                Ok(State::Gone) if expected.is_none() => {
                    unreaped.insert(pid);
                }
                Ok(State::Gone) => {}
                Err(error) => {
                    fail(error)?;
                    match expected {
                        // A known pid may have been reused, so it gets no
                        // signal until a later census confirms it.
                        Some(identity) => {
                            unchecked.insert(pid, identity);
                        }
                        None => unreadable.push(pid),
                    }
                }
            }
        }
        let mut live: Vec<Pid> = found.keys().copied().chain(unreadable).collect();
        live.sort_unstable();
        for (pid, identity) in unchecked {
            found.entry(pid).or_insert(identity);
        }
        self.known = found;
        Ok(Census {
            live,
            complete,
            unreaped: unreaped.len(),
        })
    }

    /// The number of live processes, the task slots the tree takes, and the
    /// processes' summed physical footprint. Any unreadable entry is an
    /// error, never a smaller figure.
    pub fn measure(&mut self) -> io::Result<Sample> {
        let census = self.census(true)?;
        let mut footprint: u64 = 0;
        let mut tasks = census.unreaped as u64;
        for &pid in &census.live {
            if let Some(bytes) = self.table.footprint(pid)? {
                footprint = footprint.saturating_add(bytes);
            }
            tasks = tasks.saturating_add(self.table.threads(pid)?);
        }
        Ok(Sample {
            processes: census.live.len(),
            tasks,
            footprint,
        })
    }

    /// Kills every live process of the build, again and again until a
    /// complete census finds none and the owner has no child left. One round
    /// is not enough: a fork in flight during a round can create a process
    /// that round missed. On Linux every descendant reaches the owner through
    /// a live chain of parents, so a child left over also shows a process the
    /// census missed. Reaps the owner's own children so they do not linger as
    /// zombies. Gives up after `budget`, so a process it may not signal, or
    /// one it cannot inspect, cannot hold the owner forever.
    pub fn stop(&mut self, budget: Duration) -> Result<(), String> {
        let deadline = Instant::now() + budget;
        let mut last_problem = String::new();
        loop {
            let parenting = self.table.reap();
            match self.census(false) {
                Ok(census) if census.live.is_empty() && census.complete && !parenting => {
                    return Ok(());
                }
                Ok(census) => {
                    if !census.complete {
                        last_problem = "part of the process table could not be read".to_owned();
                    } else if census.live.is_empty() {
                        last_problem = "a child of the owner is still running".to_owned();
                    }
                    for pid in census.live {
                        match self.table.kill(pid) {
                            Ok(Signalled::Sent | Signalled::Gone) => {}
                            Err(error) => {
                                last_problem =
                                    format!("process {pid} could not be stopped: {error}")
                            }
                        }
                    }
                }
                Err(error) => last_problem = error.to_string(),
            }
            if Instant::now() >= deadline {
                return Err(last_problem);
            }
            sleep(Duration::from_millis(1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: Pid = 100;
    const WORKER: Pid = 101;
    /// Left the owner's group with setsid while the worker lived.
    const ESCAPED: Pid = 102;

    fn identity(pid: Pid, started: u64) -> Identity {
        Identity {
            pid,
            started: (started, 0),
        }
    }

    /// A process table that tests change by hand.
    #[derive(Default)]
    struct Fake {
        group: Vec<Pid>,
        children: HashMap<Pid, Vec<Pid>>,
        live: HashMap<Pid, Identity>,
        /// How many more times `state` fails for each pid.
        failures: HashMap<Pid, usize>,
        killed: Vec<Pid>,
        /// A child of the owner that no listing shows.
        unlisted_child: bool,
        /// Threads of a live pid, when more than one.
        threads: HashMap<Pid, u64>,
    }

    impl Table for Fake {
        fn group_members(&mut self, _group: Pid) -> io::Result<Vec<Pid>> {
            Ok(self.group.clone())
        }
        fn children(&mut self, parent: Pid) -> io::Result<Vec<Pid>> {
            Ok(self.children.get(&parent).cloned().unwrap_or_default())
        }
        fn state(&mut self, pid: Pid) -> io::Result<State> {
            if let Some(left) = self.failures.get_mut(&pid).filter(|left| **left > 0) {
                *left -= 1;
                return Err(io::Error::other("injected inspection failure"));
            }
            Ok(self
                .live
                .get(&pid)
                .map_or(State::Gone, |identity| State::Live(*identity)))
        }
        fn footprint(&mut self, pid: Pid) -> io::Result<Option<u64>> {
            Ok(self.live.contains_key(&pid).then_some(1))
        }
        fn threads(&mut self, pid: Pid) -> io::Result<u64> {
            Ok(self.threads.get(&pid).copied().unwrap_or(1))
        }
        fn kill(&mut self, pid: Pid) -> io::Result<Signalled> {
            if self.live.remove(&pid).is_none() {
                return Ok(Signalled::Gone);
            }
            self.killed.push(pid);
            self.group.retain(|&member| member != pid);
            Ok(Signalled::Sent)
        }
        fn reap(&mut self) -> bool {
            self.unlisted_child
        }
    }

    /// The worker started a descendant that left the group, then exited. The
    /// descendant is now reachable only through what the owner remembers.
    fn escaped_descendant() -> Tree<Fake> {
        let table = Fake {
            group: vec![WORKER],
            children: HashMap::from([(WORKER, vec![ESCAPED])]),
            live: HashMap::from([
                (WORKER, identity(WORKER, 1)),
                (ESCAPED, identity(ESCAPED, 2)),
            ]),
            ..Fake::default()
        };
        let mut tree = Tree::new(OWNER, table);
        assert_eq!(tree.measure().unwrap().processes, 2);
        tree.table.live.remove(&WORKER);
        tree.table.group.clear();
        tree.table.children.clear();
        tree
    }

    #[test]
    fn one_failed_inspection_does_not_drop_an_escaped_descendant() {
        let mut tree = escaped_descendant();
        tree.table.failures.insert(ESCAPED, 1);
        assert_eq!(tree.stop(Duration::from_secs(5)), Ok(()));
        assert_eq!(tree.table.killed, [ESCAPED]);
    }

    #[test]
    fn a_descendant_that_cannot_be_inspected_exhausts_the_budget() {
        let mut tree = escaped_descendant();
        tree.table.failures.insert(ESCAPED, usize::MAX);
        assert!(tree.stop(Duration::from_millis(30)).is_err());
        assert!(
            tree.table.killed.is_empty(),
            "an unverified identity gets no signal"
        );
    }

    #[test]
    fn threads_and_unreaped_processes_count_as_tasks() {
        const UNREAPED: Pid = 103;
        let table = Fake {
            group: vec![WORKER, UNREAPED],
            children: HashMap::from([(WORKER, vec![ESCAPED, UNREAPED])]),
            live: HashMap::from([
                (WORKER, identity(WORKER, 1)),
                (ESCAPED, identity(ESCAPED, 2)),
            ]),
            threads: HashMap::from([(WORKER, 12)]),
            ..Fake::default()
        };
        let sample = Tree::new(OWNER, table).measure().unwrap();
        // 12 threads, 1 thread, and one exited process listed twice.
        assert_eq!((sample.processes, sample.tasks), (2, 14));
    }

    #[test]
    fn a_child_no_listing_shows_keeps_teardown_going() {
        let mut tree = escaped_descendant();
        tree.table.live.clear();
        tree.table.unlisted_child = true;
        assert_eq!(
            tree.stop(Duration::from_millis(30)),
            Err("a child of the owner is still running".to_owned())
        );
    }

    #[test]
    fn a_reused_pid_is_forgotten_without_a_signal() {
        let mut tree = escaped_descendant();
        tree.table.live.insert(ESCAPED, identity(ESCAPED, 3));
        assert_eq!(tree.stop(Duration::from_secs(5)), Ok(()));
        assert!(tree.table.killed.is_empty());
    }
}
