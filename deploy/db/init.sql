-- Memory: one table, searched by vector similarity and full text (see DESIGN.md).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE observations (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    content    text NOT NULL,
    source     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    embedding  vector(384) NOT NULL,
    tsv        tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

CREATE INDEX ON observations USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON observations USING gin (tsv);
CREATE INDEX ON observations (source);
