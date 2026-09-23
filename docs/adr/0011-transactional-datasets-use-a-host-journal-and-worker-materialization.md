# Transactional datasets use a host journal and worker materialization

Status: implemented on the campaign branch. Campaign acceptance verification remains in progress.

A transactional dataset's authoritative state is its validated checkpoint plus its committed journal. A persistent worker evaluates approved operations in an isolated guest and materializes committed changes, but it never makes a speculative change authoritative by itself. The host commits the changeset, retry receipt, history, attachment associations, quota accounting, and revision in one authority transaction after rechecking current access. The worker then applies that committed event. Recovery replays committed events without running app code, which preserves revocation and retry behavior without requiring an atomic transaction across the host and worker databases.

The dataset owns one approved schema and operation revision. Apps bind to a revision and an explicit operation subset. Document Collections keep their Y.Doc and Markdown authority. This journal applies only to transactional datasets.
