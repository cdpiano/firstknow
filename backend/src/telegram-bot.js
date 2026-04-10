/**
 * Telegram Bot webhook handler for FirstKnow.
 * Handles registration, portfolio updates, settings, and deep analysis
 * entirely within Telegram — no local scripts needed.
 */

import {
  createOrUpdateUser,
  getUser,
  getUserHoldings,
  setUserHoldings,
  syncTrackedTickersFromUsers,
  getEvents,
  getEventByTelegramMessageId,
} from './database.js';
import { sendTelegramMessage } from './telegram-push.js';
import { generateDeepAnalysis } from './deep-analysis.js';

// ---------------------------------------------------------------------------
// Portfolio text parser (ported from scripts/update-portfolio.js)
// ---------------------------------------------------------------------------

function parsePortfolioText(input) {
  const holdings = [];
  const parts = input.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);

  for (const part of parts) {
    // Match: NVDA 25%, AAPL 20, $TSLA 15%
    const match = part.match(/^\$?([A-Za-z.]{1,10})\s+(\d+(?:\.\d+)?)\s*%?$/);
    if (match) {
      holdings.push({ ticker: match[1].toUpperCase(), weight: parseFloat(match[2]) });
      continue;
    }
    // Match: just a ticker
    const tickerMatch = part.match(/^\$?([A-Za-z.]{1,10})$/);
    if (tickerMatch) {
      holdings.push({ ticker: tickerMatch[1].toUpperCase(), weight: null });
    }
  }

  // Equal distribution if no weights
  if (holdings.length > 0 && holdings.every((h) => h.weight === null)) {
    const w = Math.round(100 / holdings.length);
    holdings.forEach((h) => (h.weight = w));
  }

  return holdings;
}

/**
 * Check if text looks like a portfolio input (contains tickers).
 */
function looksLikePortfolio(text) {
  // At least one word that looks like a ticker (1-10 uppercase letters)
  const words = text.split(/[\s,;]+/);
  let tickerCount = 0;
  for (const w of words) {
    if (/^\$?[A-Za-z.]{1,10}$/.test(w) && w.length <= 10) tickerCount++;
  }
  return tickerCount >= 2; // At least 2 tickers
}

// ---------------------------------------------------------------------------
// Main webhook handler
// ---------------------------------------------------------------------------

/**
 * Handle an incoming Telegram webhook update.
 * @param {Object} update - Telegram Update object
 * @param {Object} env - Worker env (DB, ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN)
 */
export async function handleTelegramWebhook(update, env) {
  const message = update.message;
  if (!message || !message.text) return; // Ignore non-text messages

  const chatId = String(message.chat.id);
  const text = message.text.trim();
  const replyToMessageId = message.reply_to_message?.message_id?.toString() || null;
  const botToken = env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    console.error('TELEGRAM_BOT_TOKEN not set');
    return;
  }

  try {
    // Route to handler based on command or text
    if (text === '/start') {
      await handleStart(chatId, env, botToken);
    } else if (text.startsWith('/portfolio')) {
      await handlePortfolio(chatId, env, botToken);
    } else if (text.startsWith('/settings')) {
      await handleSettings(chatId, env, botToken);
    } else if (text.startsWith('/language')) {
      await handleLanguage(chatId, text, env, botToken);
    } else if (text.startsWith('/alert')) {
      await handleAlertLevel(chatId, text, env, botToken);
    } else if (text.startsWith('/quiet')) {
      await handleQuietHours(chatId, text, env, botToken);
    } else if (text.startsWith('/check')) {
      await handleCheck(chatId, env, botToken);
    } else if (/^(deep|深度)$/i.test(text)) {
      await handleDeep(chatId, env, botToken, replyToMessageId);
    } else if (text === '/help') {
      await handleHelp(chatId, botToken);
    } else {
      // Check if it looks like portfolio input
      const user = await getUser(env.DB, chatId);
      if (!user || user.onboarding_state === 'awaiting_portfolio') {
        // New user or waiting for portfolio — try to parse
        await handlePortfolioInput(chatId, text, env, botToken);
      } else if (looksLikePortfolio(text)) {
        // Existing user updating portfolio
        await handlePortfolioInput(chatId, text, env, botToken);
      }
      // Otherwise silently ignore unrecognized text
    }
  } catch (err) {
    console.error(`Webhook handler error for chat ${chatId}: ${err.message}`);
    await sendTelegramMessage(chatId, '⚠️ Something went wrong. Please try again.', botToken).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleStart(chatId, env, botToken) {
  // Create user shell (or greet existing)
  const existing = await getUser(env.DB, chatId);

  if (existing && existing.onboarding_state === 'active') {
    const holdings = await getUserHoldings(env.DB, chatId);
    const holdingsStr = holdings.map((h) => `• ${h.ticker} (${h.weight || '?'}%)`).join('\n');
    await sendTelegramMessage(chatId,
      `👋 Welcome back! You're already set up.\n\n📊 Your holdings:\n${holdingsStr}\n\nSend new tickers to update, or use /help for commands.`,
      botToken
    );
    return;
  }

  // Create new user in awaiting_portfolio state
  await createOrUpdateUser(env.DB, {
    chat_id: chatId,
    telegram_chat_id: chatId,
    telegram_bot_token: botToken,
    language: 'en',
    onboarding_state: 'awaiting_portfolio',
  });

  await sendTelegramMessage(chatId,
    `👋 Welcome to FirstKnow!\n\nI monitor breaking news, SEC filings, and price moves for stocks and crypto you hold — and push alerts to you 24/7.\n\n📝 Send me your holdings to get started.\n\nExample:\nNVDA 25%, AAPL 20%, BTC 15%, TSLA 10%\n\n(I'll distribute weights equally if you don't specify)`,
    botToken
  );
}

async function handlePortfolioInput(chatId, text, env, botToken) {
  const holdings = parsePortfolioText(text);

  if (holdings.length === 0) {
    await sendTelegramMessage(chatId,
      `🤔 I couldn't parse any tickers from that. Try this format:\n\nNVDA 25%, AAPL 20%, BTC 15%\n\nOr just list tickers: NVDA, AAPL, BTC, TSLA`,
      botToken
    );
    return;
  }

  // Ensure user exists
  const existing = await getUser(env.DB, chatId);
  if (!existing) {
    await createOrUpdateUser(env.DB, {
      chat_id: chatId,
      telegram_chat_id: chatId,
      telegram_bot_token: botToken,
      language: 'en',
      onboarding_state: 'active',
    });
  } else if (existing.onboarding_state !== 'active') {
    // Mark onboarding complete
    await createOrUpdateUser(env.DB, {
      chat_id: chatId,
      telegram_chat_id: chatId,
      telegram_bot_token: existing.telegram_bot_token || botToken,
      language: existing.language || 'en',
      timezone: existing.timezone,
      alert_level: existing.alert_level || 'all',
      quiet_hours_start: existing.quiet_hours_start,
      quiet_hours_end: existing.quiet_hours_end,
      onboarding_state: 'active',
    });
  }

  // Save holdings
  await setUserHoldings(env.DB, chatId, holdings);
  await syncTrackedTickersFromUsers(env.DB);

  const holdingsStr = holdings.map((h) => `• ${h.ticker} (${h.weight || '?'}%)`).join('\n');

  await sendTelegramMessage(chatId,
    `✅ Got it! Monitoring ${holdings.length} holdings:\n${holdingsStr}\n\n🔔 You'll get alerts when something important happens.\n\nCommands:\n/portfolio — view holdings\n/check — latest news\n/language en|zh — change language\n/settings — view all settings\n/help — all commands\n\nReply "deep" to any alert for AI analysis.`,
    botToken
  );
}

async function handlePortfolio(chatId, env, botToken) {
  const user = await getUser(env.DB, chatId);
  if (!user) {
    await sendTelegramMessage(chatId, '👋 You haven\'t set up yet. Send /start to begin.', botToken);
    return;
  }

  const holdings = await getUserHoldings(env.DB, chatId);
  if (holdings.length === 0) {
    await sendTelegramMessage(chatId, '📊 No holdings set. Send me tickers like: NVDA 25%, AAPL 20%', botToken);
    return;
  }

  const holdingsStr = holdings.map((h) => `• ${h.ticker} (${h.weight || '?'}%)`).join('\n');
  await sendTelegramMessage(chatId,
    `📊 Your portfolio:\n${holdingsStr}\n\nTo update, send new holdings:\nNVDA 30%, AAPL 25%, BTC 10%`,
    botToken
  );
}

async function handleSettings(chatId, env, botToken) {
  const user = await getUser(env.DB, chatId);
  if (!user) {
    await sendTelegramMessage(chatId, '👋 You haven\'t set up yet. Send /start to begin.', botToken);
    return;
  }

  const quietStr = user.quiet_hours_start && user.quiet_hours_end
    ? `${user.quiet_hours_start} - ${user.quiet_hours_end}`
    : 'Off';

  await sendTelegramMessage(chatId,
    `⚙️ Your settings:\n\n🌐 Language: ${user.language || 'en'}\n🔔 Alert level: ${user.alert_level || 'all'}\n🌙 Quiet hours: ${quietStr}\n🕐 Timezone: ${user.timezone || 'Not set'}\n\nChange with:\n/language en|zh|bilingual\n/alert all|important\n/quiet 00:00-08:00`,
    botToken
  );
}

async function handleLanguage(chatId, text, env, botToken) {
  const parts = text.split(/\s+/);
  const lang = parts[1]?.toLowerCase();

  if (!lang || !['en', 'zh', 'bilingual'].includes(lang)) {
    await sendTelegramMessage(chatId, '🌐 Usage: /language en | zh | bilingual', botToken);
    return;
  }

  const user = await getUser(env.DB, chatId);
  if (!user) {
    await sendTelegramMessage(chatId, '👋 Send /start first.', botToken);
    return;
  }

  await createOrUpdateUser(env.DB, {
    chat_id: chatId,
    telegram_chat_id: user.telegram_chat_id,
    telegram_bot_token: user.telegram_bot_token,
    language: lang,
    timezone: user.timezone,
    alert_level: user.alert_level,
    quiet_hours_start: user.quiet_hours_start,
    quiet_hours_end: user.quiet_hours_end,
    onboarding_state: user.onboarding_state,
  });

  const labels = { en: 'English', zh: '中文', bilingual: 'Bilingual' };
  await sendTelegramMessage(chatId, `✅ Language set to ${labels[lang]}.`, botToken);
}

async function handleAlertLevel(chatId, text, env, botToken) {
  const parts = text.split(/\s+/);
  const level = parts[1]?.toLowerCase();

  if (!level || !['all', 'important'].includes(level)) {
    await sendTelegramMessage(chatId, '🔔 Usage: /alert all | important', botToken);
    return;
  }

  const user = await getUser(env.DB, chatId);
  if (!user) {
    await sendTelegramMessage(chatId, '👋 Send /start first.', botToken);
    return;
  }

  await createOrUpdateUser(env.DB, {
    chat_id: chatId,
    telegram_chat_id: user.telegram_chat_id,
    telegram_bot_token: user.telegram_bot_token,
    language: user.language,
    timezone: user.timezone,
    alert_level: level,
    quiet_hours_start: user.quiet_hours_start,
    quiet_hours_end: user.quiet_hours_end,
    onboarding_state: user.onboarding_state,
  });

  await sendTelegramMessage(chatId, `✅ Alert level set to "${level}".`, botToken);
}

async function handleQuietHours(chatId, text, env, botToken) {
  const match = text.match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/);

  if (!match) {
    await sendTelegramMessage(chatId, '🌙 Usage: /quiet 00:00-08:00\nTo disable: /quiet off', botToken);
    return;
  }

  const user = await getUser(env.DB, chatId);
  if (!user) {
    await sendTelegramMessage(chatId, '👋 Send /start first.', botToken);
    return;
  }

  const [, start, end] = match;

  await createOrUpdateUser(env.DB, {
    chat_id: chatId,
    telegram_chat_id: user.telegram_chat_id,
    telegram_bot_token: user.telegram_bot_token,
    language: user.language,
    timezone: user.timezone,
    alert_level: user.alert_level,
    quiet_hours_start: start,
    quiet_hours_end: end,
    onboarding_state: user.onboarding_state,
  });

  await sendTelegramMessage(chatId, `✅ Quiet hours set to ${start} - ${end}.`, botToken);
}

async function handleCheck(chatId, env, botToken) {
  const user = await getUser(env.DB, chatId);
  if (!user) {
    await sendTelegramMessage(chatId, '👋 Send /start first.', botToken);
    return;
  }

  const holdings = await getUserHoldings(env.DB, chatId);
  if (holdings.length === 0) {
    await sendTelegramMessage(chatId, '📊 No holdings set. Send me tickers first.', botToken);
    return;
  }

  const tickers = holdings.map((h) => h.ticker);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const events = await getEvents(env.DB, { since, tickers, limit: 5 });

  if (events.length === 0) {
    await sendTelegramMessage(chatId, '✅ No significant events for your holdings in the last 24 hours.', botToken);
    return;
  }

  const lines = [`📰 ${events.length} recent event(s):\n`];
  for (const evt of events) {
    const tickers = Array.isArray(evt.affected_tickers)
      ? evt.affected_tickers.join(', ')
      : String(evt.affected_tickers || '');
    lines.push(`🔔 ${evt.headline}`);
    lines.push(`   ${evt.event_type || 'news'} | ${tickers}`);
    if (evt.source_url) lines.push(`   🔗 ${evt.source_url}`);
    lines.push('');
  }

  await sendTelegramMessage(chatId, lines.join('\n'), botToken);
}

async function handleDeep(chatId, env, botToken, replyToMessageId = null) {
  const user = await getUser(env.DB, chatId);
  if (!user) {
    await sendTelegramMessage(chatId, '👋 Send /start first.', botToken);
    return;
  }

  const holdings = await getUserHoldings(env.DB, chatId);
  if (holdings.length === 0) {
    await sendTelegramMessage(chatId, '📊 No holdings set. Send me tickers first.', botToken);
    return;
  }

  // Try to find the specific event the user replied to
  let event = null;

  if (replyToMessageId) {
    event = await getEventByTelegramMessageId(env.DB, chatId, replyToMessageId);
  }

  // Fallback: get the most recent event for user's tickers
  if (!event) {
    const tickers = holdings.map((h) => h.ticker);
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const events = await getEvents(env.DB, { since, tickers, limit: 1 });
    event = events[0];
  }

  if (!event) {
    await sendTelegramMessage(chatId, '🤷 No recent events found for your holdings to analyze.', botToken);
    return;
  }

  await sendTelegramMessage(chatId, `🔍 Analyzing: ${event.headline}\n\nPlease wait 10-15 seconds...`, botToken);
  const analysis = await generateDeepAnalysis(event, holdings, user.language || 'en', env.ANTHROPIC_API_KEY);

  // Split long messages for Telegram's 4096 char limit
  const header = `🧠 Deep Analysis: ${event.headline}\n\n`;
  const fullText = header + analysis;

  if (fullText.length <= 4096) {
    await sendTelegramMessage(chatId, fullText, botToken);
  } else {
    // Send in chunks
    await sendTelegramMessage(chatId, header + analysis.slice(0, 3800), botToken);
    if (analysis.length > 3800) {
      await sendTelegramMessage(chatId, analysis.slice(3800), botToken);
    }
  }
}

async function handleHelp(chatId, botToken) {
  await sendTelegramMessage(chatId,
    `📖 FirstKnow Commands:\n\n/start — Set up or restart\n/portfolio — View your holdings\n/check — Latest news for your stocks\n/settings — View all settings\n/language en|zh|bilingual — Change language\n/alert all|important — Alert level\n/quiet 00:00-08:00 — Quiet hours\n/help — This message\n\nTo update holdings, just send tickers:\nNVDA 30%, AAPL 20%, BTC 10%\n\nReply "deep" to any alert for AI analysis.`,
    botToken
  );
}
