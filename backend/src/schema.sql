-- FirstKnow Plan C schema
-- Events storage (existing)

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  headline TEXT NOT NULL,
  source TEXT,
  source_url TEXT,
  event_type TEXT,
  affected_tickers TEXT,
  price_context TEXT,
  raw_content TEXT,
  importance TEXT DEFAULT 'normal',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_tickers ON events(affected_tickers);

-- Tracked tickers (auto-populated from user_holdings)

CREATE TABLE IF NOT EXISTS tracked_tickers (
  ticker TEXT PRIMARY KEY,
  added_at TEXT DEFAULT (datetime('now'))
);

-- Users

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  language TEXT DEFAULT 'en',
  timezone TEXT,
  alert_level TEXT DEFAULT 'all',
  quiet_hours_start TEXT,
  quiet_hours_end TEXT,
  telegram_chat_id TEXT NOT NULL,
  telegram_bot_token TEXT NOT NULL,
  onboarding_state TEXT DEFAULT 'new',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_telegram_chat_id ON users(telegram_chat_id);

-- User holdings (portfolio)

CREATE TABLE IF NOT EXISTS user_holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  weight REAL,
  notes TEXT,
  UNIQUE(user_id, ticker),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_holdings_user_id ON user_holdings(user_id);
CREATE INDEX IF NOT EXISTS idx_user_holdings_ticker ON user_holdings(ticker);

-- Push history (for anti-spam)

CREATE TABLE IF NOT EXISTS push_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  ticker TEXT,
  event_id TEXT,
  telegram_message_id TEXT,
  translated INTEGER DEFAULT 0,
  pushed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_push_history_user_ticker ON push_history(user_id, ticker);
CREATE INDEX IF NOT EXISTS idx_push_history_pushed_at ON push_history(pushed_at);
