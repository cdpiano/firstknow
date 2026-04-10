/**
 * D1 database operations for FirstKnow Plan C.
 * Event storage + user CRUD + holdings + push history.
 */

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const INIT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, headline TEXT NOT NULL, source TEXT, source_url TEXT, event_type TEXT, affected_tickers TEXT, price_context TEXT, raw_content TEXT, importance TEXT DEFAULT 'normal', created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_events_tickers ON events(affected_tickers)`,
  `CREATE TABLE IF NOT EXISTS tracked_tickers (ticker TEXT PRIMARY KEY, added_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, language TEXT DEFAULT 'en', timezone TEXT, alert_level TEXT DEFAULT 'all', quiet_hours_start TEXT, quiet_hours_end TEXT, telegram_chat_id TEXT NOT NULL, telegram_bot_token TEXT NOT NULL, onboarding_state TEXT DEFAULT 'new', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_users_telegram_chat_id ON users(telegram_chat_id)`,
  `CREATE TABLE IF NOT EXISTS user_holdings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, ticker TEXT NOT NULL, weight REAL, notes TEXT, UNIQUE(user_id, ticker))`,
  `CREATE INDEX IF NOT EXISTS idx_user_holdings_user_id ON user_holdings(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_user_holdings_ticker ON user_holdings(ticker)`,
  `CREATE TABLE IF NOT EXISTS push_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, ticker TEXT, event_id TEXT, telegram_message_id TEXT, translated INTEGER DEFAULT 0, pushed_at TEXT DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_push_history_user_ticker ON push_history(user_id, ticker)`,
  `CREATE INDEX IF NOT EXISTS idx_push_history_pushed_at ON push_history(pushed_at)`,
];

let _initialized = false;

export async function initDatabase(db) {
  if (_initialized) return;
  for (const sql of INIT_STATEMENTS) {
    await db.prepare(sql).run();
  }
  _initialized = true;
}

// ---------------------------------------------------------------------------
// Events (existing)
// ---------------------------------------------------------------------------

export async function storeEvents(db, events) {
  if (!events || events.length === 0) return { stored: 0, duplicates: 0 };

  let stored = 0;
  let duplicates = 0;

  for (const event of events) {
    try {
      await db
        .prepare(
          `INSERT OR IGNORE INTO events
           (event_id, timestamp, headline, source, source_url, event_type, affected_tickers, price_context, raw_content, importance)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          event.event_id,
          event.timestamp,
          event.headline,
          event.source || null,
          event.source_url || null,
          event.event_type || null,
          JSON.stringify(event.affected_tickers || []),
          JSON.stringify(event.price_context || {}),
          event.raw_content || null,
          event.importance || 'normal'
        )
        .run();

      stored++;
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE constraint')) {
        duplicates++;
      } else {
        console.error(`Failed to store event ${event.event_id}:`, err.message);
      }
    }
  }

  return { stored, duplicates };
}

export async function getEvents(db, { since, tickers, limit } = {}) {
  let query = 'SELECT * FROM events WHERE 1=1';
  const bindings = [];

  if (since) {
    query += ' AND timestamp >= ?';
    bindings.push(since);
  }

  if (tickers && tickers.length > 0) {
    const tickerClauses = tickers.map(() => 'affected_tickers LIKE ?');
    query += ` AND (${tickerClauses.join(' OR ')})`;
    for (const ticker of tickers) {
      bindings.push(`%"${ticker}"%`);
    }
  }

  query += ' ORDER BY timestamp DESC';

  const effectiveLimit = Math.min(limit || 50, 200);
  query += ' LIMIT ?';
  bindings.push(effectiveLimit);

  const stmt = db.prepare(query);
  const result = await (bindings.length > 0 ? stmt.bind(...bindings) : stmt).all();

  return (result.results || []).map(parseEventRow);
}

export async function getTrackedTickers(db) {
  const result = await db.prepare('SELECT ticker FROM tracked_tickers ORDER BY ticker').all();
  return (result.results || []).map((r) => r.ticker);
}

export async function updateTrackedTickers(db, tickers) {
  if (!tickers || tickers.length === 0) return;

  for (const ticker of tickers) {
    await db
      .prepare('INSERT OR IGNORE INTO tracked_tickers (ticker) VALUES (?)')
      .bind(ticker.toUpperCase())
      .run();
  }
}

/**
 * Sync tracked_tickers table from the union of all user_holdings tickers.
 * Removes tickers no longer held by any user, adds new ones.
 */
export async function syncTrackedTickersFromUsers(db) {
  // Get all distinct tickers from user holdings
  const holdingTickers = await getAllTrackedTickersFromUsers(db);

  if (holdingTickers.length === 0) return;

  // Clear tracked_tickers and repopulate from user holdings
  await db.exec('DELETE FROM tracked_tickers');

  for (const ticker of holdingTickers) {
    await db
      .prepare('INSERT OR IGNORE INTO tracked_tickers (ticker) VALUES (?)')
      .bind(ticker)
      .run();
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * Create or update a user with settings.
 */
export async function createOrUpdateUser(db, userData) {
  const {
    chat_id,
    language = 'en',
    timezone = null,
    alert_level = 'all',
    quiet_hours_start = null,
    quiet_hours_end = null,
    telegram_chat_id,
    telegram_bot_token,
    onboarding_state = 'new',
  } = userData;

  const userId = chat_id;
  const chatId = telegram_chat_id || chat_id;
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO users (user_id, language, timezone, alert_level, quiet_hours_start, quiet_hours_end, telegram_chat_id, telegram_bot_token, onboarding_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         language = excluded.language,
         timezone = excluded.timezone,
         alert_level = excluded.alert_level,
         quiet_hours_start = excluded.quiet_hours_start,
         quiet_hours_end = excluded.quiet_hours_end,
         telegram_chat_id = excluded.telegram_chat_id,
         telegram_bot_token = excluded.telegram_bot_token,
         onboarding_state = excluded.onboarding_state,
         updated_at = excluded.updated_at`
    )
    .bind(userId, language, timezone, alert_level, quiet_hours_start, quiet_hours_end, chatId, telegram_bot_token, onboarding_state, now, now)
    .run();

  return { user_id: userId };
}

/**
 * Get user by chat ID.
 */
export async function getUser(db, chatId) {
  const row = await db
    .prepare('SELECT * FROM users WHERE user_id = ?')
    .bind(chatId)
    .first();

  return row || null;
}

/**
 * List all users.
 */
export async function getAllUsers(db) {
  const result = await db.prepare('SELECT * FROM users ORDER BY created_at').all();
  return result.results || [];
}

/**
 * Delete user and their holdings (CASCADE should handle holdings if DB supports it,
 * but we explicitly delete to be safe with D1).
 */
export async function deleteUser(db, chatId) {
  await db.prepare('DELETE FROM user_holdings WHERE user_id = ?').bind(chatId).run();
  await db.prepare('DELETE FROM push_history WHERE user_id = ?').bind(chatId).run();
  await db.prepare('DELETE FROM users WHERE user_id = ?').bind(chatId).run();
}

// ---------------------------------------------------------------------------
// Holdings
// ---------------------------------------------------------------------------

/**
 * Replace all holdings for a user: delete old ones, insert new ones.
 * holdings: [{ticker, weight, notes}]
 */
export async function setUserHoldings(db, chatId, holdings) {
  await db.prepare('DELETE FROM user_holdings WHERE user_id = ?').bind(chatId).run();

  if (!holdings || holdings.length === 0) return;

  for (const h of holdings) {
    await db
      .prepare(
        'INSERT INTO user_holdings (user_id, ticker, weight, notes) VALUES (?, ?, ?, ?)'
      )
      .bind(chatId, h.ticker.toUpperCase(), h.weight ?? null, h.notes ?? null)
      .run();
  }
}

/**
 * Get holdings for a user.
 */
export async function getUserHoldings(db, chatId) {
  const result = await db
    .prepare('SELECT ticker, weight, notes FROM user_holdings WHERE user_id = ? ORDER BY ticker')
    .bind(chatId)
    .all();

  return result.results || [];
}

/**
 * Get the distinct set of tickers across all users' holdings.
 * Replaces the old static tracked_tickers approach.
 */
export async function getAllTrackedTickersFromUsers(db) {
  const result = await db
    .prepare('SELECT DISTINCT ticker FROM user_holdings ORDER BY ticker')
    .all();

  return (result.results || []).map((r) => r.ticker);
}

// ---------------------------------------------------------------------------
// Push history
// ---------------------------------------------------------------------------

/**
 * Record a push notification sent, including the Telegram message ID for later editing.
 */
export async function recordPush(db, userId, ticker, eventId, telegramMessageId = null) {
  const now = new Date().toISOString();
  await db
    .prepare('INSERT INTO push_history (user_id, ticker, event_id, telegram_message_id, translated, pushed_at) VALUES (?, ?, ?, ?, 0, ?)')
    .bind(userId, ticker.toUpperCase(), eventId, telegramMessageId, now)
    .run();
}

/**
 * Get recent pushes that haven't been translated yet (for OpenClaw skill to process).
 */
export async function getPendingTranslations(db, userId) {
  const result = await db
    .prepare(
      `SELECT ph.id, ph.event_id, ph.ticker, ph.telegram_message_id, ph.pushed_at,
              e.headline, e.source, e.source_url, e.event_type, e.raw_content, e.price_context, e.affected_tickers
       FROM push_history ph
       LEFT JOIN events e ON ph.event_id = e.event_id
       WHERE ph.user_id = ? AND ph.translated = 0 AND ph.telegram_message_id IS NOT NULL
       ORDER BY ph.pushed_at DESC
       LIMIT 20`
    )
    .bind(userId)
    .all();

  return (result.results || []).map(row => ({
    push_id: row.id,
    event_id: row.event_id,
    ticker: row.ticker,
    telegram_message_id: row.telegram_message_id,
    pushed_at: row.pushed_at,
    headline: row.headline,
    source: row.source,
    source_url: row.source_url,
    event_type: row.event_type,
    raw_content: row.raw_content,
    price_context: safeJsonParse(row.price_context, {}),
    affected_tickers: safeJsonParse(row.affected_tickers, []),
  }));
}

/**
 * Mark a push as translated.
 */
export async function markTranslated(db, pushId) {
  await db.prepare('UPDATE push_history SET translated = 1 WHERE id = ?').bind(pushId).run();
}

/**
 * Batch mark multiple pushes as translated.
 */
export async function markTranslatedBatch(db, pushIds) {
  for (const id of pushIds) {
    await db.prepare('UPDATE push_history SET translated = 1 WHERE id = ?').bind(id).run();
  }
}

/**
 * Get recent pushes for a user+ticker (for anti-spam checks).
 */
export async function getPushHistory(db, userId, ticker, sinceHours = 24) {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
  const result = await db
    .prepare(
      `SELECT * FROM push_history
       WHERE user_id = ? AND ticker = ? AND pushed_at > ?
       ORDER BY pushed_at DESC`
    )
    .bind(userId, ticker.toUpperCase(), since)
    .all();

  return result.results || [];
}

/**
 * Clean old push history records.
 */
export async function cleanOldPushHistory(db, olderThanHours = 48) {
  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000).toISOString();
  await db.prepare('DELETE FROM push_history WHERE pushed_at < ?').bind(cutoff).run();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseEventRow(row) {
  return {
    event_id: row.event_id,
    timestamp: row.timestamp,
    headline: row.headline,
    source: row.source,
    source_url: row.source_url,
    event_type: row.event_type,
    affected_tickers: safeJsonParse(row.affected_tickers, []),
    price_context: safeJsonParse(row.price_context, {}),
    raw_content: row.raw_content,
    importance: row.importance,
    created_at: row.created_at,
  };
}

function safeJsonParse(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
