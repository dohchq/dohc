-- FTS5 keeps key metadata in its content table; virtual-table equality filters scan it.
-- The covering index supplies rowids for exact member deletion without a full FTS scan.
CREATE INDEX idx_engine_search_files_key ON engine_search_files_fts_content(c0,c1,c2);
