/**
 * Per-user event matching for FirstKnow Plan C.
 * Matches events to users based on their portfolio holdings.
 */

/**
 * For each event, find which users hold any of the affected tickers.
 *
 * @param {Array} events - normalized event objects with affected_tickers arrays
 * @param {Array} users - user objects, each with a `holdings` array of {ticker, weight, notes}
 * @returns {Array<{user, event, matchedHoldings}>}
 */
export function matchEventsToUsers(events, users) {
  if (!events || events.length === 0 || !users || users.length === 0) {
    return [];
  }

  // Build a map: ticker -> list of {user, holding}
  const tickerUserMap = new Map();

  for (const user of users) {
    const holdings = user.holdings || [];
    for (const holding of holdings) {
      const ticker = holding.ticker.toUpperCase();
      if (!tickerUserMap.has(ticker)) {
        tickerUserMap.set(ticker, []);
      }
      tickerUserMap.get(ticker).push({ user, holding });
    }
  }

  const matches = [];

  for (const event of events) {
    const affectedTickers = event.affected_tickers || [];

    // Collect matches per user for this event to group holdings
    const userMatchMap = new Map();

    for (const ticker of affectedTickers) {
      const upperTicker = ticker.toUpperCase();
      const entries = tickerUserMap.get(upperTicker);
      if (!entries) continue;

      for (const { user, holding } of entries) {
        const userId = user.user_id;
        if (!userMatchMap.has(userId)) {
          userMatchMap.set(userId, { user, matchedHoldings: [] });
        }
        userMatchMap.get(userId).matchedHoldings.push(holding);
      }
    }

    for (const { user, matchedHoldings } of userMatchMap.values()) {
      matches.push({ user, event, matchedHoldings });
    }
  }

  return matches;
}
