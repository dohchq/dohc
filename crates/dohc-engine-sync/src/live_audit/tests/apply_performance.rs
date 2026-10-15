use super::*;

#[test]
#[ignore = "paired release measurement"]
fn measure_host_apply_per_row() {
    let mut samples = Vec::new();
    for _ in 0..21 {
        let mut source = fixture(true);
        bootstrap(&mut source, false).unwrap();
        let doc = dohc_engine_collab::Ydoc::wire();
        doc.apply(&source.bytes).unwrap();
        let mut elapsed = 0.0;
        for cursor in 1..=100 {
            source.bytes = doc.richdoc_append_paragraph("Applied paragraph.");
            let start = std::time::Instant::now();
            accept_enrollment_event(&mut source, cursor);
            elapsed += start.elapsed().as_secs_f64() * 1_000_000.0;
        }
        samples.push(elapsed / 100.0);
    }
    samples.sort_by(f64::total_cmp);
    println!(
        "HOST_APPLY_US_PER_ROW median={} p95={} samples=21 rows=100",
        samples[10], samples[19]
    );
}
