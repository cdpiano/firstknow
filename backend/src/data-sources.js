/**
 * Data source fetchers for FirstKnow.
 * Each function returns normalized event/price data and degrades gracefully on failure.
 */

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const YAHOO_FINANCE_BASE = 'https://query1.finance.yahoo.com/v8/finance';
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const SEC_EDGAR_BASE = 'https://efts.sec.gov/LATEST';
const SEC_FILINGS_BASE = 'https://data.sec.gov';

// Well-known crypto ticker to CoinGecko ID mapping
const CRYPTO_ID_MAP = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  ADA: 'cardano',
  DOT: 'polkadot',
  AVAX: 'avalanche-2',
  MATIC: 'matic-network',
  LINK: 'chainlink',
  UNI: 'uniswap',
  DOGE: 'dogecoin',
  XRP: 'ripple',
  BNB: 'binancecoin',
  LTC: 'litecoin',
  ATOM: 'cosmos',
  NEAR: 'near',
  ARB: 'arbitrum',
  OP: 'optimism',
};

/**
 * Fetch news articles from Finnhub for given tickers.
 * Returns normalized event objects.
 */
export async function fetchFinnhubNews(tickers, apiKey) {
  if (!apiKey) {
    console.warn('FINNHUB_API_KEY not configured, skipping Finnhub news fetch');
    return [];
  }

  const allEvents = [];
  const now = new Date();
  const fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const from = fromDate.toISOString().split('T')[0];
  const to = now.toISOString().split('T')[0];

  for (const ticker of tickers) {
    try {
      const url = `${FINNHUB_BASE}/company-news?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&token=${apiKey}`;
      const resp = await fetchWithTimeout(url, 10000);

      if (!resp.ok) {
        console.warn(`Finnhub returned ${resp.status} for ${ticker}`);
        continue;
      }

      const articles = await resp.json();

      if (!Array.isArray(articles)) continue;

      for (const article of articles.slice(0, 20)) {
        const headline = article.headline || '';
        const summary = article.summary || '';

        // Relevance check: ticker must actually appear in headline or summary
        // Finnhub returns tangentially related articles (e.g., "10 stocks to buy"
        // lists NVDA but the article is about something else entirely)
        const relevance = computeRelevance(ticker, headline, summary);
        if (relevance === 'none') continue;

        const eventId = generateEventId('finnhub', article.id || article.datetime, ticker);
        allEvents.push({
          event_id: eventId,
          timestamp: new Date(article.datetime * 1000).toISOString(),
          headline: headline || 'No headline',
          source: article.source || 'Finnhub',
          source_url: article.url || null,
          event_type: classifyHeadline(headline),
          affected_tickers: [ticker],
          price_context: {},
          raw_content: summary || null,
          importance: relevance === 'high' ? 'important' : 'normal',
          _relevance: relevance,
        });
      }
    } catch (err) {
      console.error(`Error fetching Finnhub news for ${ticker}:`, err.message);
    }
  }

  return deduplicateByEventId(allEvents);
}

/**
 * Fetch current stock price data from Yahoo Finance (no API key required).
 * Returns a map of ticker -> price data.
 */
export async function fetchPriceData(tickers) {
  if (!tickers || tickers.length === 0) return {};

  const priceMap = {};

  try {
    const symbols = tickers.join(',');
    const url = `${YAHOO_FINANCE_BASE}/chart/${encodeURIComponent(tickers[0])}?interval=1d&range=2d`;

    // Yahoo Finance v8 chart endpoint works one ticker at a time
    for (const ticker of tickers) {
      try {
        const chartUrl = `${YAHOO_FINANCE_BASE}/chart/${encodeURIComponent(ticker)}?interval=1d&range=2d`;
        const resp = await fetchWithTimeout(chartUrl, 8000);

        if (!resp.ok) {
          console.warn(`Yahoo Finance returned ${resp.status} for ${ticker}`);
          continue;
        }

        const data = await resp.json();
        const result = data?.chart?.result?.[0];

        if (!result) continue;

        const meta = result.meta || {};
        const currentPrice = meta.regularMarketPrice || 0;
        const previousClose = meta.chartPreviousClose || meta.previousClose || 0;
        const changePct = previousClose > 0 ? ((currentPrice - previousClose) / previousClose) * 100 : 0;
        const volume = meta.regularMarketVolume || 0;

        priceMap[ticker] = {
          current: roundTo(currentPrice, 2),
          previous_close: roundTo(previousClose, 2),
          change_pct: roundTo(changePct, 2),
          volume: volume,
          volume_vs_avg: null,
          fetched_at: new Date().toISOString(),
        };
      } catch (err) {
        console.error(`Error fetching Yahoo price for ${ticker}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Error in fetchPriceData:', err.message);
  }

  return priceMap;
}

/**
 * Fetch cryptocurrency price data from CoinGecko (free, no API key).
 * Returns a map of ticker -> price data.
 */
export async function fetchCryptoData(tickers) {
  if (!tickers || tickers.length === 0) return {};

  const priceMap = {};

  // Map tickers to CoinGecko IDs
  const idEntries = [];
  for (const ticker of tickers) {
    const cgId = CRYPTO_ID_MAP[ticker.toUpperCase()];
    if (cgId) {
      idEntries.push({ ticker: ticker.toUpperCase(), cgId });
    }
  }

  if (idEntries.length === 0) return {};

  try {
    const ids = idEntries.map((e) => e.cgId).join(',');
    const url = `${COINGECKO_BASE}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`;
    const resp = await fetchWithTimeout(url, 10000);

    if (!resp.ok) {
      console.warn(`CoinGecko returned ${resp.status}`);
      return {};
    }

    const data = await resp.json();

    for (const { ticker, cgId } of idEntries) {
      const coinData = data[cgId];
      if (!coinData) continue;

      priceMap[ticker] = {
        current: roundTo(coinData.usd || 0, 2),
        change_pct: roundTo(coinData.usd_24h_change || 0, 2),
        volume_24h: coinData.usd_24h_vol || 0,
        volume_vs_avg: null,
        fetched_at: new Date().toISOString(),
      };
    }
  } catch (err) {
    console.error('Error fetching CoinGecko data:', err.message);
  }

  return priceMap;
}

// ---------------------------------------------------------------------------
// SEC EDGAR — Earnings & Filing data (free, no API key)
// ---------------------------------------------------------------------------

// SEC requires a User-Agent header identifying the caller
const SEC_USER_AGENT = 'FirstKnow/1.0 (contact@firstknow.ai)';

// Cache ticker -> CIK mapping (fetched once per worker lifecycle)
let tickerToCikMap = null;
let tickerToCikLastFetch = 0;
const CIK_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch the ticker-to-CIK mapping from SEC EDGAR.
 * This is a ~5MB JSON file, so we cache it aggressively.
 */
async function getTickerCikMap() {
  const now = Date.now();
  if (tickerToCikMap && (now - tickerToCikLastFetch) < CIK_CACHE_TTL) {
    return tickerToCikMap;
  }

  try {
    const resp = await fetchWithTimeout(
      `${SEC_FILINGS_BASE}/submissions/company_tickers.json`,
      15000,
      { 'User-Agent': SEC_USER_AGENT }
    );

    if (!resp.ok) {
      console.warn(`SEC ticker map returned ${resp.status}`);
      return tickerToCikMap || {};
    }

    const data = await resp.json();
    const map = {};

    // data is { "0": { cik_str, ticker, title }, "1": { ... }, ... }
    for (const entry of Object.values(data)) {
      if (entry.ticker) {
        map[entry.ticker.toUpperCase()] = {
          cik: String(entry.cik_str).padStart(10, '0'),
          name: entry.title,
        };
      }
    }

    tickerToCikMap = map;
    tickerToCikLastFetch = now;
    console.log(`SEC ticker-CIK map loaded: ${Object.keys(map).length} entries`);
    return map;
  } catch (err) {
    console.error('Error fetching SEC ticker-CIK map:', err.message);
    return tickerToCikMap || {};
  }
}

// Filing types we care about
const IMPORTANT_FILING_TYPES = {
  '10-K': 'annual_report',       // Annual report
  '10-Q': 'quarterly_report',    // Quarterly report
  '8-K': 'current_report',       // Material events (earnings, M&A, leadership changes)
  '4': 'insider_trade',          // Insider trading
  'SC 13D': 'activist_stake',    // Activist investor >5% stake
  'SC 13G': 'passive_stake',     // Passive investor >5% stake
  'DEF 14A': 'proxy_statement',  // Proxy statement (executive compensation, votes)
};

// 8-K item descriptions that matter most
const IMPORTANT_8K_ITEMS = [
  'Results of Operations',       // Earnings
  'Financial Statements',        // Earnings
  'Departure of Directors',      // Management changes
  'Entry into a Material',       // M&A, major contracts
  'Triggering Events',           // Debt defaults
  'Bankruptcy',                  // Bankruptcy
  'Regulation FD',               // Material non-public info
  'Other Events',                // Catch-all for important news
];

/**
 * Fetch recent SEC filings for given tickers.
 * Uses the EDGAR EFTS (full-text search) API and company submissions.
 * Returns normalized event objects.
 */
export async function fetchSECFilings(tickers) {
  if (!tickers || tickers.length === 0) return [];

  const cikMap = await getTickerCikMap();
  const allEvents = [];

  for (const ticker of tickers) {
    const t = ticker.toUpperCase();
    const cikEntry = cikMap[t];
    if (!cikEntry) continue; // Not a SEC-registered company (e.g., crypto)

    try {
      // Fetch recent filings from company submissions endpoint
      const url = `${SEC_FILINGS_BASE}/submissions/CIK${cikEntry.cik}.json`;
      const resp = await fetchWithTimeout(url, 10000, { 'User-Agent': SEC_USER_AGENT });

      if (!resp.ok) {
        console.warn(`SEC EDGAR returned ${resp.status} for ${ticker} (CIK ${cikEntry.cik})`);
        continue;
      }

      const data = await resp.json();
      const recent = data.filings?.recent;
      if (!recent || !recent.form) continue;

      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // Iterate recent filings (arrays of same length)
      const count = Math.min(recent.form.length, 50); // Check last 50
      for (let i = 0; i < count; i++) {
        const form = recent.form[i];
        const filingDate = recent.filingDate?.[i];
        const primaryDocument = recent.primaryDocument?.[i];
        const accessionNumber = recent.accessionNumber?.[i];
        const description = recent.primaryDocDescription?.[i] || '';

        // Only care about important filing types
        const eventType = IMPORTANT_FILING_TYPES[form];
        if (!eventType) continue;

        // Only include filings from last 24 hours
        if (!filingDate) continue;
        const filedAt = new Date(filingDate + 'T00:00:00Z');
        if (filedAt < oneDayAgo) continue;

        // Build SEC filing URL
        const accNoClean = accessionNumber?.replace(/-/g, '') || '';
        const filingUrl = accNoClean && primaryDocument
          ? `https://www.sec.gov/Archives/edgar/data/${parseInt(cikEntry.cik)}/${accNoClean}/${primaryDocument}`
          : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cikEntry.cik}&type=${form}`;

        // Build headline
        const companyName = cikEntry.name || ticker;
        let headline = '';
        let importance = 'normal';

        switch (form) {
          case '8-K':
            headline = `${companyName} (${t}) files 8-K: ${description || 'Material Event'}`;
            importance = 'important'; // 8-K is always material
            break;
          case '10-K':
            headline = `${companyName} (${t}) files annual report (10-K)`;
            importance = 'important';
            break;
          case '10-Q':
            headline = `${companyName} (${t}) files quarterly report (10-Q)`;
            importance = 'important';
            break;
          case '4':
            headline = `Insider trade reported for ${companyName} (${t})`;
            importance = 'normal';
            break;
          case 'SC 13D':
            headline = `Activist investor takes >5% stake in ${companyName} (${t})`;
            importance = 'important';
            break;
          case 'SC 13G':
            headline = `Large investor reports >5% passive stake in ${companyName} (${t})`;
            importance = 'normal';
            break;
          case 'DEF 14A':
            headline = `${companyName} (${t}) files proxy statement`;
            importance = 'normal';
            break;
          default:
            headline = `${companyName} (${t}) files ${form}`;
        }

        const eventId = generateEventId('sec', `${accessionNumber}_${form}`, ticker);

        allEvents.push({
          event_id: eventId,
          timestamp: filedAt.toISOString(),
          headline,
          source: 'SEC EDGAR',
          source_url: filingUrl,
          event_type: eventType === 'current_report' ? 'earnings' : eventType,
          affected_tickers: [t],
          price_context: {},
          raw_content: `${companyName} filed ${form} with the SEC on ${filingDate}. ${description ? 'Description: ' + description : ''} View the full filing at SEC EDGAR.`,
          importance,
        });
      }
    } catch (err) {
      console.error(`Error fetching SEC filings for ${ticker}:`, err.message);
    }
  }

  return deduplicateByEventId(allEvents);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, timeoutMs, extraHeaders = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: extraHeaders,
    });
    return resp;
  } finally {
    clearTimeout(timeoutId);
  }
}

function generateEventId(source, rawId, ticker) {
  const hash = simpleHash(`${source}_${rawId}_${ticker}`);
  return `evt_${source}_${hash}`;
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

/**
 * Check how relevant an article is to a specific ticker.
 * Returns: 'high' | 'medium' | 'none'
 *
 * 'high'   — ticker is the main subject (in headline, or company name in headline)
 * 'medium' — ticker mentioned in summary but not headline
 * 'none'   — ticker not meaningfully mentioned, skip this article
 */
function computeRelevance(ticker, headline, summary) {
  const t = ticker.toUpperCase();
  const companyName = TICKER_TO_COMPANY[t];

  // Check headline first (strongest signal)
  if (tickerInText(t, headline)) return 'high';
  if (companyName && headline.toLowerCase().includes(companyName.toLowerCase())) return 'high';

  // Check summary (weaker signal)
  if (tickerInText(t, summary)) {
    // Extra filter: if it's a listicle ("10 stocks", "5 picks"), likely low quality
    if (isListicle(headline)) return 'none';
    return 'medium';
  }
  if (companyName && summary.toLowerCase().includes(companyName.toLowerCase())) {
    if (isListicle(headline)) return 'none';
    return 'medium';
  }

  return 'none';
}

/**
 * Check if ticker symbol appears as a distinct token in text.
 */
function tickerInText(ticker, text) {
  if (!text) return false;
  // Match $NVDA, (NVDA), or standalone NVDA with word boundaries
  const patterns = [
    new RegExp(`\\$${ticker}\\b`, 'i'),           // $NVDA
    new RegExp(`\\(${ticker}\\)`, 'i'),            // (NVDA)
    new RegExp(`\\b${ticker}\\b`, ticker.length <= 2 ? undefined : 'i'), // NVDA as word
  ];
  // Short tickers (1-2 chars like "U") need $ or () to avoid false positives
  if (ticker.length <= 2) {
    return patterns[0].test(text) || patterns[1].test(text);
  }
  return patterns.some(p => p.test(text));
}

/**
 * Detect listicle headlines that are typically low-signal.
 */
function isListicle(headline) {
  return /\b\d+\s+(stock|pick|best|top|high|safe|dividend|growth|mega)/i.test(headline)
    || /\bmy\s+\d+\b/i.test(headline)
    || /\bbuy and hold\b/i.test(headline)
    || /\bretirees should\b/i.test(headline);
}

// Map tickers to company names for fuzzy matching
const TICKER_TO_COMPANY = {
  NVDA: 'Nvidia',
  AAPL: 'Apple',
  MSFT: 'Microsoft',
  GOOGL: 'Google',
  GOOG: 'Google',
  AMZN: 'Amazon',
  META: 'Meta',
  TSLA: 'Tesla',
  AMD: 'AMD',
  INTC: 'Intel',
  HOOD: 'Robinhood',
  U: 'Unity',
  NFLX: 'Netflix',
  CRM: 'Salesforce',
  COIN: 'Coinbase',
  PLTR: 'Palantir',
  SNOW: 'Snowflake',
  SQ: 'Block',
  SHOP: 'Shopify',
  UBER: 'Uber',
  ABNB: 'Airbnb',
  RBLX: 'Roblox',
  SOFI: 'SoFi',
};

function classifyHeadline(headline) {
  const lower = headline.toLowerCase();

  if (/\bearnings?\b|revenue|profit|quarterly results|eps\b/.test(lower)) return 'earnings';
  if (/\bceo\b|cfo\b|cto\b|appointed|resign|stepped down|management change/.test(lower)) return 'management_change';
  if (/\blawsuit\b|sued|litigation|settlement|class.action/.test(lower)) return 'lawsuit';
  if (/\bfda\b|regulatory|antitrust|sec\b|investigation|compliance|fine\b|fined\b/.test(lower)) return 'regulatory';
  if (/\bupgrade\b|downgrade\b|price target|analyst|rating/.test(lower)) return 'analyst_rating';
  if (/\bacquisition\b|merger\b|acquire|buyout|takeover/.test(lower)) return 'merger_acquisition';
  if (/\bipo\b|offering|secondary\b|stock split|buyback/.test(lower)) return 'corporate_action';
  if (/\bpartnership\b|contract|deal\b|agreement/.test(lower)) return 'partnership';
  if (/\brecall\b|outage|breach|hack|cybersecurity/.test(lower)) return 'incident';

  return 'news';
}

function deduplicateByEventId(events) {
  const seen = new Set();
  return events.filter((e) => {
    if (seen.has(e.event_id)) return false;
    seen.add(e.event_id);
    return true;
  });
}

function roundTo(num, places) {
  const factor = Math.pow(10, places);
  return Math.round(num * factor) / factor;
}
