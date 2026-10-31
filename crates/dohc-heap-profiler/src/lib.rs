//! dhat as the global allocator of whatever test binary links this crate, so
//! a `dhat::Profiler` there measures its heap. Only dohc-engine-collab's
//! held-proof memory measurement links it, under its `held-proof-memory`
//! feature.

#![allow(unsafe_code)]

#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;
