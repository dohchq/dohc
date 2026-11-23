//! dhat as the global allocator of whatever test binary links this crate, so
//! a `dhat::Profiler` there measures its heap. dohc-engine-collab links it in
//! its held-proof memory measurement, under its `held-proof-memory` feature,
//! and in its `markdown_memory` test.

#![allow(unsafe_code)]

#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;
