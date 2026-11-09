ALTER TABLE chat_messages ADD COLUMN author_reported TEXT
    CHECK (author_reported IS NULL OR (author_kind = 'agent' AND json_valid(author_reported)));
