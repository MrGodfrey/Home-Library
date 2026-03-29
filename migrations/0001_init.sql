CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  publisher TEXT NOT NULL DEFAULT '',
  year TEXT NOT NULL DEFAULT '',
  isbn TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL CHECK (location IN ('成都', '重庆')),
  status TEXT NOT NULL CHECK (status IN ('在家', '不在家')),
  cover_url TEXT NOT NULL DEFAULT '',
  owner_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_books_location ON books (location);
CREATE INDEX IF NOT EXISTS idx_books_isbn ON books (isbn);
CREATE INDEX IF NOT EXISTS idx_books_created_at ON books (created_at DESC);