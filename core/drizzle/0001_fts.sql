CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='id');
--> statement-breakpoint
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE transcripts_fts USING fts5(text, content='transcripts', content_rowid='seq');
--> statement-breakpoint
CREATE TRIGGER transcripts_ai AFTER INSERT ON transcripts WHEN new.text IS NOT NULL BEGIN
  INSERT INTO transcripts_fts(rowid, text) VALUES (new.seq, new.text);
END;
