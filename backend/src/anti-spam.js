/**
 * Anti-spam logic for FirstKnow Plan C.
 * Quiet hours, per-ticker rate limiting, cooldown.
 */

/**
 * Check if the current time falls within the user's quiet hours.
 * Uses the user's configured timezone.
 */
export function isQuietHours(user) {
  const start = user.quiet_hours_start;
  const end = user.quiet_hours_end;

  if (!start || !end) return false;

  const tz = user.timezone || 'UTC';
  let nowStr;
  try {
    nowStr = new Date().toLocaleTimeString('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    // Invalid timezone, fall back to UTC
    nowStr = new Date().toLocaleTimeString('en-GB', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  // nowStr is "HH:MM", start/end are "HH:MM"
  if (start <= end) {
    // Normal range, e.g., 23:00 - 07:00 would NOT hit this branch
    // This is e.g., 09:00 - 17:00
    return nowStr >= start && nowStr < end;
  }

  // Wraps midnight, e.g., 23:00 - 07:00
  return nowStr >= start || nowStr < end;
}

/**
 * Check anti-spam constraints:
 * - Max 3 pushes per ticker per day (24h rolling)
 * - 30-minute cooldown between pushes for the same ticker
 *
 * @param {D1Database} db
 * @param {string} userId
 * @param {string} ticker
 * @returns {Promise<{allowed: boolean, reason: string|null}>}
 */
export async function checkAntiSpam(db, userId, ticker) {
  const upperTicker = ticker.toUpperCase();

  // Check 30-minute cooldown
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const recentResult = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM push_history
       WHERE user_id = ? AND ticker = ? AND pushed_at > ?`
    )
    .bind(userId, upperTicker, thirtyMinAgo)
    .first();

  if (recentResult && recentResult.cnt > 0) {
    return { allowed: false, reason: `cooldown: pushed ${upperTicker} within last 30 minutes` };
  }

  // Check max 3 per ticker per 24h
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const dailyResult = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM push_history
       WHERE user_id = ? AND ticker = ? AND pushed_at > ?`
    )
    .bind(userId, upperTicker, twentyFourHoursAgo)
    .first();

  if (dailyResult && dailyResult.cnt >= 3) {
    return { allowed: false, reason: `rate_limit: already pushed ${upperTicker} 3 times in 24h` };
  }

  return { allowed: true, reason: null };
}

/**
 * Combined check: quiet hours + anti-spam.
 */
export async function shouldPush(db, user, ticker) {
  if (isQuietHours(user)) {
    return { allowed: false, reason: 'quiet_hours' };
  }

  return checkAntiSpam(db, user.user_id, ticker);
}
