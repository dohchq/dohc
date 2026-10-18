//! The processes one build started, and how the owner measures and stops them.
use crate::sys::{self, Identity, Pid, Signalled, State};
use std::collections::HashMap;
use std::io;
use std::thread::sleep;
use std::time::{Duration, Instant};

/// The live processes found by one look at the process table.
struct Census {
    /// Pids to measure or kill. A pid the table could not describe is
    /// included, so teardown still signals it.
    live: Vec<Pid>,
    /// False when any part of the table could not be read. An incomplete
    /// census never proves the tree is empty.
    complete: bool,
}

pub struct Sample {
    pub processes: usize,
    pub footprint: u64,
}

pub struct Tree {
    owner: Pid,
    /// Descendants seen earlier, with their identities. A descendant that
    /// left the owner's group with setsid or setpgid stays reachable here
    /// after its parent exits.
    known: HashMap<Pid, Identity>,
}

impl Tree {
    /// `owner` leads the process group the worker and esbuild inherit.
    pub fn new(owner: Pid) -> Tree {
        Tree {
            owner,
            known: HashMap::new(),
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
        match sys::group_members(self.owner) {
            Ok(pids) => queue.extend(pids.into_iter().map(|pid| (pid, None))),
            Err(error) => fail(error)?,
        }
        match sys::children(self.owner) {
            Ok(pids) => queue.extend(pids.into_iter().map(|pid| (pid, None))),
            Err(error) => fail(error)?,
        }
        queue.extend(
            self.known
                .values()
                .map(|identity| (identity.pid, Some(*identity))),
        );
        let mut found: HashMap<Pid, Identity> = HashMap::new();
        let mut unreadable: Vec<Pid> = Vec::new();
        while let Some((pid, expected)) = queue.pop() {
            if pid == self.owner || found.contains_key(&pid) || unreadable.contains(&pid) {
                continue;
            }
            match sys::state(pid) {
                Ok(State::Live(identity)) => {
                    // The pid now names an unrelated process.
                    if expected.is_some_and(|expected| expected != identity) {
                        continue;
                    }
                    found.insert(pid, identity);
                    match sys::children(pid) {
                        Ok(pids) => queue.extend(pids.into_iter().map(|child| (child, None))),
                        Err(error) => fail(error)?,
                    }
                }
                Ok(State::Gone) => {}
                Err(error) => {
                    fail(error)?;
                    // A known pid may have been reused, so only a pid the
                    // table listed fresh is worth a signal.
                    if expected.is_none() {
                        unreadable.push(pid);
                    }
                }
            }
        }
        let mut live: Vec<Pid> = found.keys().copied().chain(unreadable).collect();
        live.sort_unstable();
        self.known = found;
        Ok(Census { live, complete })
    }

    /// The number of live processes and their summed physical footprint. Any
    /// unreadable entry is an error, never a smaller figure.
    pub fn measure(&mut self) -> io::Result<Sample> {
        let census = self.census(true)?;
        let mut footprint: u64 = 0;
        for &pid in &census.live {
            if let Some(bytes) = sys::footprint(pid)? {
                footprint = footprint.saturating_add(bytes);
            }
        }
        Ok(Sample {
            processes: census.live.len(),
            footprint,
        })
    }

    /// Kills every live process of the build, again and again until a
    /// complete census finds none. One round is not enough: a fork in flight
    /// during a round can create a process that round missed. Reaps the
    /// owner's own children so they do not linger as zombies. Gives up after
    /// `budget`, so a process it may not signal cannot hold the owner forever.
    pub fn stop(&mut self, budget: Duration) -> Result<(), String> {
        let deadline = Instant::now() + budget;
        let mut last_problem = String::new();
        loop {
            sys::reap_children();
            match self.census(false) {
                Ok(census) if census.live.is_empty() && census.complete => return Ok(()),
                Ok(census) => {
                    if !census.complete {
                        last_problem = "part of the process table could not be read".to_owned();
                    }
                    for pid in census.live {
                        match sys::kill(pid) {
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
