# Datasets own transactional data

A transactional dataset is the workspace-owned authority for structured records, schema, operations, and files. Apps request permission to invoke approved dataset operations; an app publication cannot provide a second private database or weaken the dataset rules.

The dataset host evaluates approved operations in isolated persistent workers and commits the candidate, receipt, history, and file associations together after checking the approved revision and caller grant. Persistent workers avoid copying the complete database on each operation; the host retains commit and recovery authority. Local datasets run on the owner’s device. Shared datasets use one configured host and refuse writes while that host is unavailable.

One SQLite database backs each dataset and its related tables initially. A transaction can span those tables. Cross-dataset transactions refuse before any write. The database is an implementation detail of the dataset, not a user-selected app backend or an ordinary workspace file.

Collections, forms, owner views, agents, and published apps use the same dataset authority. Document Collections remain document-backed and keep their live document source. CSV and arbitrary SQLite files remain inspectable files until an explicit import creates dataset records.

This decision supersedes the former app-owned private backend design. It preserves immutable publication review, explicit owner approval, isolated app execution, browser isolation, and recoverable history while giving multiple apps one coherent data system.
