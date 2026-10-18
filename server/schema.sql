PRAGMA foreign_keys = ON;

-- 账号表：用户名 + PBKDF2 密码哈希（对齐 Edgechat 的认证实现）
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  rating INTEGER NOT NULL DEFAULT 1000,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 战绩流水：每条对局结果一行，用于排行榜与历史
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT '1v1',
  result TEXT NOT NULL CHECK(result IN ('win', 'loss')),
  opponent TEXT NOT NULL DEFAULT '',
  rating_delta INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_matches_user ON matches(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_users_rating ON users(rating DESC, wins DESC);
