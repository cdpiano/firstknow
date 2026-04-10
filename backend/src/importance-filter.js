/**
 * Rule-based importance filter for FirstKnow events.
 * No LLM -- pure keyword/threshold logic for millisecond latency.
 */

// Event types that are always considered important
const IMPORTANT_EVENT_TYPES = new Set([
  'earnings',
  'management_change',
  'lawsuit',
  'regulatory',
  'analyst_rating',
  'merger_acquisition',
  'incident',
  'annual_report',
  'quarterly_report',
  'current_report',
  'activist_stake',
]);

// Keywords in headlines that signal importance (case-insensitive)
const IMPORTANT_KEYWORDS = [
  /\bbreaking\b/i,
  /\burgent\b/i,
  /\bcrash(?:es|ed|ing)?\b/i,
  /\bsurg(?:e|es|ed|ing)\b/i,
  /\bhalt(?:s|ed|ing)?\b/i,
  /\bsuspend(?:s|ed|ing)?\b/i,
  /\bbankrupt(?:cy)?\b/i,
  /\bdefault(?:s|ed)?\b/i,
  /\bfraud\b/i,
  /\bindictment\b/i,
  /\brecall(?:s|ed)?\b/i,
  /\bdata\s*breach\b/i,
  /\bfda\s*approv/i,
  /\bfed\b.*\brate/i,
  /\bshutdown\b/i,
  /\bacquisition\b/i,
  /\btakeover\b/i,
  /\bbuyout\b/i,
  /\bipo\b/i,
  /\bstock\s*split\b/i,
  /\bguidance\b.*\b(raise|lower|cut|miss)/i,
  /\b(?:beat|miss)(?:s|ed|es)?\b.*\b(?:estimate|expectation|consensus)/i,
];

// Thresholds for price-based importance
const PRICE_THRESHOLDS = {
  daily_change_pct: 5.0,
  hourly_change_pct: 3.0,
  volume_vs_avg_ratio: 2.5,
};

/**
 * Filter events, marking important ones and optionally discarding low-value noise.
 *
 * @param {Array} events - array of normalized event objects
 * @param {Array} trackedTickers - tickers the user is monitoring
 * @param {Object} options
 * @param {boolean} options.keepAll - if true, return all events with importance set; if false, return only important ones
 * @returns {Array} events with importance field set
 */
export function filterImportantEvents(events, trackedTickers, { keepAll = true } = {}) {
  if (!events || events.length === 0) return [];

  const trackedSet = new Set((trackedTickers || []).map((t) => t.toUpperCase()));

  const scored = events.map((event) => {
    const reasons = [];
    let isImportant = false;

    // Rule 1: Event type importance
    if (event.event_type && IMPORTANT_EVENT_TYPES.has(event.event_type)) {
      isImportant = true;
      reasons.push(`event_type:${event.event_type}`);
    }

    // Rule 2: Keyword matching in headline
    if (event.headline) {
      for (const pattern of IMPORTANT_KEYWORDS) {
        if (pattern.test(event.headline)) {
          isImportant = true;
          reasons.push(`keyword:${pattern.source}`);
          break;
        }
      }
    }

    // Rule 3: Price movement thresholds
    if (event.price_context && typeof event.price_context === 'object') {
      for (const [ticker, priceData] of Object.entries(event.price_context)) {
        if (!priceData) continue;

        const absChange = Math.abs(priceData.change_pct || 0);

        if (absChange >= PRICE_THRESHOLDS.daily_change_pct) {
          isImportant = true;
          reasons.push(`price_move:${ticker}:${priceData.change_pct}%`);
        }

        if (priceData.hourly_change_pct && Math.abs(priceData.hourly_change_pct) >= PRICE_THRESHOLDS.hourly_change_pct) {
          isImportant = true;
          reasons.push(`hourly_move:${ticker}:${priceData.hourly_change_pct}%`);
        }

        if (priceData.volume_vs_avg && priceData.volume_vs_avg >= PRICE_THRESHOLDS.volume_vs_avg_ratio) {
          isImportant = true;
          reasons.push(`high_volume:${ticker}:${priceData.volume_vs_avg}x`);
        }
      }
    }

    // Rule 4: Tracked ticker appears in headline
    if (event.headline && trackedSet.size > 0) {
      for (const ticker of trackedSet) {
        if (tickerAppearsInText(ticker, event.headline)) {
          isImportant = true;
          reasons.push(`tracked_ticker_headline:${ticker}`);
          break;
        }
      }
    }

    // Rule 5: Event directly affects tracked tickers
    const affectedTickers = event.affected_tickers || [];
    const affectsTracked = affectedTickers.some((t) => trackedSet.has(t.toUpperCase()));
    if (affectsTracked) {
      isImportant = true;
      reasons.push('affects_tracked_ticker');
    }

    return {
      ...event,
      importance: isImportant ? 'important' : 'normal',
      _importance_reasons: reasons,
    };
  });

  if (keepAll) return scored;
  return scored.filter((e) => e.importance === 'important');
}

/**
 * Check if a stock ticker symbol appears in text as a distinct token.
 * Avoids false positives like "AM" matching inside words.
 */
function tickerAppearsInText(ticker, text) {
  if (!ticker || !text) return false;

  // Short tickers (1-2 chars) need stricter matching: must be preceded by $ or surrounded by specific delimiters
  if (ticker.length <= 2) {
    const dollarPattern = new RegExp(`\\$${escapeRegex(ticker)}\\b`, 'i');
    return dollarPattern.test(text);
  }

  // Longer tickers can match as word boundaries
  const pattern = new RegExp(`(?:^|[\\s($])${escapeRegex(ticker)}(?=[\\s).,;:!?]|$)`, 'i');
  return pattern.test(text);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
