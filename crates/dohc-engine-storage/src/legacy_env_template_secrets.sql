CREATE TEMP TABLE legacy_env_template_paths (path TEXT NOT NULL PRIMARY KEY);

WITH RECURSIVE
candidates(path) AS (
    SELECT path FROM secret_files
    UNION SELECT path FROM secret_fork_bases
    UNION SELECT path FROM secret_moments
    UNION SELECT json_extract(decision.value, '$.path')
    FROM engine_requests,
         json_each(CASE WHEN kind = 'sync-materialization' AND json_valid(payload_hash)
                        THEN payload_hash ELSE '[]' END) AS decision
    WHERE json_extract(decision.value, '$.contentKind') = 'secret'
),
segments(path, segment, rest) AS (
    SELECT path, NULL, path || '/' FROM candidates WHERE path IS NOT NULL
    UNION ALL
    SELECT path, substr(rest, 1, instr(rest, '/') - 1), substr(rest, instr(rest, '/') + 1)
    FROM segments WHERE rest <> ''
)
INSERT INTO legacy_env_template_paths (path)
SELECT basename.path FROM segments AS basename
WHERE basename.rest = ''
  AND rtrim(lower(basename.segment), '. ') IN ('.env.example', '.env.template', '.env.sample')
  AND NOT EXISTS (
      SELECT 1 FROM segments AS ancestor
      WHERE ancestor.path = basename.path AND rtrim(lower(ancestor.segment), '. ') = '.env'
  );

DELETE FROM secret_files WHERE path IN (SELECT path FROM legacy_env_template_paths);
DELETE FROM secret_fork_bases WHERE path IN (SELECT path FROM legacy_env_template_paths);
DELETE FROM secret_moments WHERE path IN (SELECT path FROM legacy_env_template_paths);

UPDATE engine_requests
SET payload_hash = (
    SELECT json_group_array(json(decision.value) ORDER BY decision.key)
    FROM json_each(engine_requests.payload_hash) AS decision
    WHERE NOT (
        json_extract(decision.value, '$.contentKind') = 'secret'
        AND json_extract(decision.value, '$.path') IN (SELECT path FROM legacy_env_template_paths)
    )
)
WHERE kind = 'sync-materialization'
  AND EXISTS (
      SELECT 1
      FROM json_each(CASE WHEN json_valid(engine_requests.payload_hash)
                          THEN engine_requests.payload_hash ELSE '[]' END) AS decision
      WHERE json_extract(decision.value, '$.contentKind') = 'secret'
        AND json_extract(decision.value, '$.path') IN (SELECT path FROM legacy_env_template_paths)
  );

DELETE FROM engine_requests WHERE kind = 'sync-materialization' AND payload_hash = '[]';

DROP TABLE legacy_env_template_paths;
