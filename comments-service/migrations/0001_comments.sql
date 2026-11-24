PRAGMA foreign_keys = ON;
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  post TEXT NOT NULL,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL,
  published_at TEXT
);
CREATE INDEX comments_public ON comments(post, status, published_at, id);
CREATE INDEX comments_moderation ON comments(status, created_at, id);
CREATE TABLE replies (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX replies_comment ON replies(comment_id, created_at, id);
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(key, bucket)
);
CREATE TABLE used_tokens (
  digest TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
