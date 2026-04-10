/**
 * FirstKnow Backend — Cloudflare Worker (Plan C)
 *
 * Aggregates stock/crypto news, matches events to user portfolios,
 * and pushes template-based Telegram alerts. No LLM.
 */

import {
  initDatabase,
  storeEvents,
  getEvents,
  getTrackedTickers,
  updateTrackedTickers,
  syncTrackedTickersFromUsers,
  createOrUpdateUser,
  getUser,
  getAllUsers,
  deleteUser,
  setUserHoldings,
  getUserHoldings,
  getAllTrackedTickersFromUsers,
  recordPush,
  cleanOldPushHistory,
  getPendingTranslations,
  markTranslatedBatch,
} from './database.js';
import { fetchFinnhubNews, fetchPriceData, fetchCryptoData, fetchSECFilings } from './data-sources.js';
import { filterImportantEvents } from './importance-filter.js';
import { matchEventsToUsers } from './matcher.js';
import { shouldPush } from './anti-spam.js';
import { pushAlertToUser, sendTelegramMessage } from './telegram-push.js';
import { handleTelegramWebhook } from './telegram-bot.js';
import { generateDeepAnalysis } from './deep-analysis.js';
import { generateQuickAnalysis } from './quick-analysis.js';

// Default tickers to track if no users registered yet
const DEFAULT_STOCK_TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'];
const DEFAULT_CRYPTO_TICKERS = ['BTC', 'ETH', 'SOL'];

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

function errorResponse(message, status = 500, origin) {
  return jsonResponse({ error: message }, status, origin);
}

// ---------------------------------------------------------------------------
// Route handling
// ---------------------------------------------------------------------------

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  try {
    await initDatabase(env.DB);

    const path = url.pathname;
    const method = request.method;

    // Health
    if (path === '/api/health') {
      return handleHealth(env, origin);
    }

    // Events
    if (path === '/api/events/latest' && method === 'GET') {
      return handleLatestEvents(env, origin);
    }
    if (path === '/api/events' && method === 'GET') {
      return handleEvents(url, env, origin);
    }

    // Tickers (legacy, still works)
    if (path === '/api/tickers' && method === 'GET') {
      return handleGetTickers(env, origin);
    }
    if (path === '/api/tickers' && method === 'POST') {
      return handleUpdateTickers(request, env, origin);
    }

    // User routes
    if (path === '/api/users/register' && method === 'POST') {
      return handleRegisterUser(request, env, origin);
    }

    // Routes with :chatId
    const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch) {
      const chatId = decodeURIComponent(userMatch[1]);
      if (method === 'GET') return handleGetUser(chatId, env, origin);
      if (method === 'PUT') return handleUpdateUser(chatId, request, env, origin);
      if (method === 'DELETE') return handleDeleteUser(chatId, env, origin);
    }

    const holdingsMatch = path.match(/^\/api\/users\/([^/]+)\/holdings$/);
    if (holdingsMatch && method === 'PUT') {
      const chatId = decodeURIComponent(holdingsMatch[1]);
      return handleUpdateHoldings(chatId, request, env, origin);
    }

    // GET /api/users/:chatId/pending-translations
    const pendingMatch = path.match(/^\/api\/users\/([^/]+)\/pending-translations$/);
    if (pendingMatch && method === 'GET') {
      const chatId = decodeURIComponent(pendingMatch[1]);
      return handlePendingTranslations(chatId, env, origin);
    }

    // POST /api/users/:chatId/mark-translated
    const markMatch = path.match(/^\/api\/users\/([^/]+)\/mark-translated$/);
    if (markMatch && method === 'POST') {
      const chatId = decodeURIComponent(markMatch[1]);
      return handleMarkTranslated(chatId, request, env, origin);
    }

    // Telegram Bot webhook
    if (path === '/telegram/webhook' && method === 'POST') {
      return handleTelegramWebhookRoute(request, env, origin);
    }

    // Deep analysis (server-side, no user API key needed)
    if (path === '/api/deep-analysis' && method === 'POST') {
      return handleDeepAnalysis(request, env, origin);
    }

    // Setup webhook helper
    if (path === '/api/setup-webhook' && method === 'POST') {
      return handleSetupWebhook(env, origin);
    }

    return errorResponse('Not found', 404, origin);
  } catch (err) {
    console.error('Request handler error:', err.message, err.stack);
    return errorResponse('Internal server error', 500, origin);
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

async function handleHealth(env, origin) {
  let dbOk = false;
  try {
    await env.DB.prepare('SELECT 1').first();
    dbOk = true;
  } catch {
    dbOk = false;
  }

  return jsonResponse(
    {
      status: dbOk ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      database: dbOk ? 'connected' : 'error',
    },
    dbOk ? 200 : 503,
    origin
  );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

async function handleLatestEvents(env, origin) {
  const events = await getEvents(env.DB, { limit: 10 });
  return jsonResponse({ events, count: events.length }, 200, origin);
}

async function handleEvents(url, env, origin) {
  const since = url.searchParams.get('since') || null;
  const tickersParam = url.searchParams.get('tickers');
  const limitParam = url.searchParams.get('limit');

  const tickers = tickersParam
    ? tickersParam.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean)
    : null;
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 50, 200) : 50;

  const events = await getEvents(env.DB, { since, tickers, limit });
  return jsonResponse({ events, count: events.length, filters: { since, tickers, limit } }, 200, origin);
}

// ---------------------------------------------------------------------------
// Tickers (legacy)
// ---------------------------------------------------------------------------

async function handleGetTickers(env, origin) {
  const tickers = await getTrackedTickers(env.DB);
  return jsonResponse({ tickers }, 200, origin);
}

async function handleUpdateTickers(request, env, origin) {
  const body = await request.json();
  const tickers = body.tickers;

  if (!Array.isArray(tickers) || tickers.length === 0) {
    return errorResponse('tickers must be a non-empty array', 400, origin);
  }

  await updateTrackedTickers(env.DB, tickers);
  const current = await getTrackedTickers(env.DB);
  return jsonResponse({ tickers: current }, 200, origin);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

async function handleRegisterUser(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, origin);
  }

  const { chat_id, bot_token, holdings, language, timezone, alert_level, quiet_hours } = body;

  if (!chat_id || !bot_token) {
    return errorResponse('chat_id and bot_token are required', 400, origin);
  }

  // Create/update user
  const userData = {
    chat_id: String(chat_id),
    telegram_chat_id: String(chat_id),
    telegram_bot_token: bot_token,
    language: language || 'en',
    timezone: timezone || null,
    alert_level: alert_level || 'all',
    quiet_hours_start: quiet_hours?.start || null,
    quiet_hours_end: quiet_hours?.end || null,
  };

  await createOrUpdateUser(env.DB, userData);

  // Set holdings if provided
  if (Array.isArray(holdings) && holdings.length > 0) {
    await setUserHoldings(env.DB, String(chat_id), holdings);
  }

  // Sync tracked_tickers from all user holdings
  await syncTrackedTickersFromUsers(env.DB);

  const user = await getUser(env.DB, String(chat_id));
  const userHoldings = await getUserHoldings(env.DB, String(chat_id));

  return jsonResponse({ user, holdings: userHoldings }, 201, origin);
}

async function handleGetUser(chatId, env, origin) {
  const user = await getUser(env.DB, chatId);
  if (!user) {
    return errorResponse('User not found', 404, origin);
  }

  const holdings = await getUserHoldings(env.DB, chatId);
  return jsonResponse({ user, holdings }, 200, origin);
}

async function handleUpdateUser(chatId, request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, origin);
  }

  const existing = await getUser(env.DB, chatId);
  if (!existing) {
    return errorResponse('User not found', 404, origin);
  }

  // Partial update: merge provided fields with existing
  const userData = {
    chat_id: chatId,
    telegram_chat_id: body.telegram_chat_id || existing.telegram_chat_id,
    telegram_bot_token: body.bot_token || existing.telegram_bot_token,
    language: body.language ?? existing.language,
    timezone: body.timezone ?? existing.timezone,
    alert_level: body.alert_level ?? existing.alert_level,
    quiet_hours_start: body.quiet_hours?.start ?? existing.quiet_hours_start,
    quiet_hours_end: body.quiet_hours?.end ?? existing.quiet_hours_end,
  };

  await createOrUpdateUser(env.DB, userData);

  const user = await getUser(env.DB, chatId);
  const holdings = await getUserHoldings(env.DB, chatId);
  return jsonResponse({ user, holdings }, 200, origin);
}

async function handleDeleteUser(chatId, env, origin) {
  const existing = await getUser(env.DB, chatId);
  if (!existing) {
    return errorResponse('User not found', 404, origin);
  }

  await deleteUser(env.DB, chatId);

  // Sync tracked_tickers after removal
  await syncTrackedTickersFromUsers(env.DB);

  return jsonResponse({ deleted: true, user_id: chatId }, 200, origin);
}

async function handleUpdateHoldings(chatId, request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, origin);
  }

  const existing = await getUser(env.DB, chatId);
  if (!existing) {
    return errorResponse('User not found', 404, origin);
  }

  const holdings = body.holdings;
  if (!Array.isArray(holdings)) {
    return errorResponse('holdings must be an array', 400, origin);
  }

  await setUserHoldings(env.DB, chatId, holdings);

  // Sync tracked_tickers
  await syncTrackedTickersFromUsers(env.DB);

  const updated = await getUserHoldings(env.DB, chatId);
  return jsonResponse({ holdings: updated }, 200, origin);
}

async function handlePendingTranslations(chatId, env, origin) {
  const user = await getUser(env.DB, chatId);
  if (!user) return errorResponse('User not found', 404, origin);

  const pending = await getPendingTranslations(env.DB, chatId);
  return jsonResponse({ pending, user: { language: user.language, telegram_chat_id: user.telegram_chat_id, telegram_bot_token: user.telegram_bot_token } }, 200, origin);
}

async function handleMarkTranslated(chatId, request, env, origin) {
  let body;
  try { body = await request.json(); } catch { return errorResponse('Invalid JSON', 400, origin); }

  const pushIds = body.push_ids;
  if (!Array.isArray(pushIds) || pushIds.length === 0) {
    return errorResponse('push_ids must be a non-empty array', 400, origin);
  }

  await markTranslatedBatch(env.DB, pushIds);
  return jsonResponse({ marked: pushIds.length }, 200, origin);
}

// ---------------------------------------------------------------------------
// Telegram Bot webhook
// ---------------------------------------------------------------------------

async function handleTelegramWebhookRoute(request, env, origin) {
  let update;
  try {
    update = await request.json();
  } catch {
    return errorResponse('Invalid JSON', 400, origin);
  }

  // Process webhook asynchronously — return 200 immediately to Telegram
  // (Telegram expects a fast response, analysis can take longer)
  try {
    await handleTelegramWebhook(update, env);
  } catch (err) {
    console.error('Telegram webhook error:', err.message);
  }

  return jsonResponse({ ok: true }, 200, origin);
}

// ---------------------------------------------------------------------------
// Deep analysis (server-side)
// ---------------------------------------------------------------------------

async function handleDeepAnalysis(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON', 400, origin);
  }

  const { chat_id, event_id } = body;
  if (!chat_id) {
    return errorResponse('chat_id is required', 400, origin);
  }

  const user = await getUser(env.DB, String(chat_id));
  if (!user) {
    return errorResponse('User not found', 404, origin);
  }

  const holdings = await getUserHoldings(env.DB, String(chat_id));

  // Find event
  let event;
  if (event_id) {
    const events = await getEvents(env.DB, { limit: 1 });
    event = events.find((e) => e.event_id === event_id) || events[0];
  } else {
    const tickers = holdings.map((h) => h.ticker);
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const events = await getEvents(env.DB, { since, tickers, limit: 1 });
    event = events[0];
  }

  if (!event) {
    return errorResponse('No recent event found', 404, origin);
  }

  const analysis = await generateDeepAnalysis(event, holdings, user.language || 'en', env.ANTHROPIC_API_KEY);

  // Optionally push to Telegram
  const botToken = user.telegram_bot_token || env.TELEGRAM_BOT_TOKEN;
  if (botToken) {
    const header = `🧠 Deep Analysis: ${event.headline}\n\n`;
    await sendTelegramMessage(user.telegram_chat_id, header + analysis, botToken).catch((err) => {
      console.error('Failed to push deep analysis to Telegram:', err.message);
    });
  }

  return jsonResponse({ event_id: event.event_id, analysis }, 200, origin);
}

// ---------------------------------------------------------------------------
// Setup webhook helper — call once to register with Telegram
// ---------------------------------------------------------------------------

async function handleSetupWebhook(env, origin) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return errorResponse('TELEGRAM_BOT_TOKEN not set', 500, origin);
  }

  // Derive the webhook URL from the worker URL
  const webhookUrl = 'https://firstknow-backend.yuchen-9cf.workers.dev/telegram/webhook';

  const resp = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl }),
  });

  const result = await resp.json();
  return jsonResponse({ webhook_url: webhookUrl, telegram_response: result }, 200, origin);
}

// ---------------------------------------------------------------------------
// Cron: data fetching + push pipeline
// ---------------------------------------------------------------------------

async function handleCron(event, env) {
  const cronName = event.cron;
  console.log(`Cron triggered: ${cronName} at ${new Date().toISOString()}`);

  try {
    await initDatabase(env.DB);

    // Clean old push history periodically
    await cleanOldPushHistory(env.DB, 48);

    // Determine which tickers to fetch
    let trackedTickers = await getTrackedTickers(env.DB);

    if (trackedTickers.length === 0) {
      // Seed with defaults on first run (no users registered yet)
      await updateTrackedTickers(env.DB, [...DEFAULT_STOCK_TICKERS, ...DEFAULT_CRYPTO_TICKERS]);
      trackedTickers = [...DEFAULT_STOCK_TICKERS, ...DEFAULT_CRYPTO_TICKERS];
    }

    const stockTickers = trackedTickers.filter((t) => !DEFAULT_CRYPTO_TICKERS.includes(t) && !isCryptoTicker(t));
    const cryptoTickers = trackedTickers.filter((t) => DEFAULT_CRYPTO_TICKERS.includes(t) || isCryptoTicker(t));

    let newEvents = [];

    if (cronName === '*/5 * * * *') {
      newEvents = await runNewsPipeline(env, stockTickers, cryptoTickers, trackedTickers);
    } else if (cronName === '*/1 * * * *') {
      newEvents = await runPricePipeline(env, stockTickers, cryptoTickers, trackedTickers);
    } else {
      const newsEvents = await runNewsPipeline(env, stockTickers, cryptoTickers, trackedTickers);
      const priceEvents = await runPricePipeline(env, stockTickers, cryptoTickers, trackedTickers);
      newEvents = [...newsEvents, ...priceEvents];
    }

    // Push pipeline: match events to users and send alerts
    if (newEvents.length > 0) {
      await runPushPipeline(env.DB, newEvents, env);
    }
  } catch (err) {
    console.error('Cron handler error:', err.message, err.stack);
  }
}

async function runNewsPipeline(env, stockTickers, cryptoTickers, allTracked) {
  console.log(`News pipeline: stocks=${stockTickers.length}, crypto=${cryptoTickers.length}`);

  // Fetch news from multiple sources in parallel
  const [newsEvents, secEvents] = await Promise.all([
    fetchFinnhubNews(stockTickers, env.FINNHUB_API_KEY),
    fetchSECFilings(stockTickers),
  ]);
  console.log(`Fetched ${newsEvents.length} Finnhub news, ${secEvents.length} SEC filings`);

  // Merge all news sources
  const allNewsEvents = [...newsEvents, ...secEvents];

  if (allNewsEvents.length === 0) return [];

  // Enrich events with current price context
  const priceData = await fetchPriceData(stockTickers);
  const enrichedEvents = allNewsEvents.map((event) => enrichWithPriceContext(event, priceData));

  // Run importance filter
  const filteredEvents = filterImportantEvents(enrichedEvents, allTracked, { keepAll: true });
  console.log(`After importance filter: ${filteredEvents.length} events`);

  // Store in D1
  const { stored, duplicates } = await storeEvents(env.DB, filteredEvents);
  console.log(`Stored ${stored} new events, ${duplicates} duplicates skipped`);

  // Only return newly stored events (exclude duplicates) for push pipeline
  // Since we use INSERT OR IGNORE, we return all filtered events and let push_history dedup
  return filteredEvents;
}

async function runPricePipeline(env, stockTickers, cryptoTickers, allTracked) {
  const results = await Promise.allSettled([
    fetchPriceData(stockTickers),
    fetchCryptoData(cryptoTickers),
  ]);

  const stockPrices = results[0].status === 'fulfilled' ? results[0].value : {};
  const cryptoPrices = results[1].status === 'fulfilled' ? results[1].value : {};

  const allPrices = { ...stockPrices, ...cryptoPrices };

  const priceEvents = [];
  const now = new Date().toISOString();

  for (const [ticker, priceData] of Object.entries(allPrices)) {
    const absChange = Math.abs(priceData.change_pct || 0);

    if (absChange >= 5.0) {
      const direction = priceData.change_pct > 0 ? 'surges' : 'plunges';
      priceEvents.push({
        event_id: `evt_price_${ticker}_${Date.now()}`,
        timestamp: now,
        headline: `${ticker} ${direction} ${absChange.toFixed(1)}% in 24h`,
        source: 'FirstKnow Price Monitor',
        source_url: null,
        event_type: 'price_move',
        affected_tickers: [ticker],
        price_context: { [ticker]: priceData },
        raw_content: `${ticker} is trading at $${priceData.current} with a ${priceData.change_pct.toFixed(2)}% change.`,
        importance: 'important',
      });
    }
  }

  if (priceEvents.length > 0) {
    const { stored } = await storeEvents(env.DB, priceEvents);
    console.log(`Stored ${stored} price-move events`);
  }

  return priceEvents;
}

/**
 * Push pipeline: match events to users, check anti-spam, send Telegram alerts.
 */
async function runPushPipeline(db, events, env) {
  // Get all users with their holdings
  const allUsers = await getAllUsers(db);

  if (allUsers.length === 0) {
    console.log('Push pipeline: no registered users, skipping');
    return;
  }

  // Attach holdings to each user
  const usersWithHoldings = [];
  for (const user of allUsers) {
    const holdings = await getUserHoldings(db, user.user_id);
    usersWithHoldings.push({ ...user, holdings });
  }

  // Match events to users
  const matches = matchEventsToUsers(events, usersWithHoldings);
  console.log(`Push pipeline: ${matches.length} event-user matches found`);

  let pushed = 0;
  let skipped = 0;

  for (const { user, event, matchedHoldings } of matches) {
    // Use the first matched ticker for anti-spam check
    const primaryTicker = matchedHoldings[0]?.ticker;
    if (!primaryTicker) continue;

    // Check alert_level: if 'important', only push important events
    if (user.alert_level === 'important' && event.importance !== 'important') {
      skipped++;
      continue;
    }

    // Check anti-spam
    const { allowed, reason } = await shouldPush(db, user, primaryTicker);
    if (!allowed) {
      console.log(`Push skipped for user ${user.user_id} ticker ${primaryTicker}: ${reason}`);
      skipped++;
      continue;
    }

    // Generate quick analysis for important events
    let quickAnalysis = null;
    if (event.importance === 'important' && env.ANTHROPIC_API_KEY) {
      try {
        quickAnalysis = await generateQuickAnalysis(event, matchedHoldings, user.language || 'en', env.ANTHROPIC_API_KEY);
      } catch (err) {
        console.error(`Quick analysis failed for event ${event.event_id}: ${err.message}`);
        // Continue without quick analysis — alert still sends
      }
    }

    // Send the alert (with translation + quick analysis if available)
    try {
      const tgResult = await pushAlertToUser(user, event, matchedHoldings, env.ANTHROPIC_API_KEY, {
        quickAnalysis,
        globalBotToken: env.TELEGRAM_BOT_TOKEN,
      });
      const messageId = tgResult?.result?.message_id?.toString() || null;
      await recordPush(db, user.user_id, primaryTicker, event.event_id, messageId);
      pushed++;
    } catch (err) {
      console.error(`Failed to push to user ${user.user_id}:`, err.message);
    }
  }

  console.log(`Push pipeline complete: ${pushed} sent, ${skipped} skipped`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function enrichWithPriceContext(event, priceData) {
  const context = {};
  for (const ticker of event.affected_tickers || []) {
    if (priceData[ticker]) {
      context[ticker] = priceData[ticker];
    }
  }
  return { ...event, price_context: context };
}

const KNOWN_CRYPTO = new Set([
  'BTC', 'ETH', 'SOL', 'ADA', 'DOT', 'AVAX', 'MATIC', 'LINK',
  'UNI', 'DOGE', 'XRP', 'BNB', 'LTC', 'ATOM', 'NEAR', 'ARB', 'OP',
]);

function isCryptoTicker(ticker) {
  return KNOWN_CRYPTO.has(ticker.toUpperCase());
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(event, env));
  },
};
