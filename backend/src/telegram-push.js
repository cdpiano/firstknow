/**
 * Telegram push notifications for FirstKnow.
 * Supports EN/ZH/Bilingual via backend-side LLM translation (Haiku).
 */

import { translateText } from './translate.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

const EVENT_TYPE_EN = {
  earnings: 'Earnings', management_change: 'Management Change', lawsuit: 'Lawsuit',
  regulatory: 'Regulatory', analyst_rating: 'Analyst Rating', merger_acquisition: 'M&A',
  corporate_action: 'Corporate Action', partnership: 'Partnership', incident: 'Incident',
  price_move: 'Price Move', news: 'News',
};

const EVENT_TYPE_ZH = {
  earnings: '财报', management_change: '管理层变动', lawsuit: '诉讼',
  regulatory: '监管', analyst_rating: '分析师评级', merger_acquisition: '并购',
  corporate_action: '公司行动', partnership: '合作', incident: '事件',
  price_move: '价格异动', news: '新闻',
};

/**
 * Format alert message. If language is zh/bilingual, translates via Haiku.
 * @param {Object} event
 * @param {Array} matchedHoldings
 * @param {string} language - 'en' | 'zh' | 'bilingual'
 * @param {string} anthropicApiKey - for translation
 */
export async function formatAlertMessage(event, matchedHoldings, language = 'en', anthropicApiKey = null, quickAnalysis = null) {
  const ticker = matchedHoldings[0]?.ticker || '???';
  const headline = event.headline || 'Unknown event';
  const eventType = event.event_type || 'news';
  const source = event.source || 'Unknown';
  const sourceUrl = event.source_url || null;
  const summary = truncateSummary(event.raw_content);

  // Price info
  let changePct = null;
  let currentPrice = null;
  let directionEmoji = '';
  const priceCtx = event.price_context || {};
  for (const h of matchedHoldings) {
    const pd = priceCtx[h.ticker];
    if (pd) {
      changePct = pd.change_pct;
      currentPrice = pd.current;
      directionEmoji = changePct > 0 ? '📈' : changePct < 0 ? '📉' : '➖';
      break;
    }
  }

  // Translate if needed
  let displayHeadline = headline;
  let displaySummary = summary;

  if (language === 'zh' && anthropicApiKey) {
    const translated = await translateText(headline, summary, 'zh', anthropicApiKey);
    displayHeadline = translated.headline;
    displaySummary = translated.summary;
  } else if (language === 'bilingual' && anthropicApiKey) {
    const translated = await translateText(headline, summary, 'zh', anthropicApiKey);
    displayHeadline = `${headline}\n${translated.headline}`;
    displaySummary = translated.summary ? `${summary}\n\n${translated.summary}` : summary;
  }

  // Build message based on language
  if (language === 'zh') {
    return buildMessage({
      headline: displayHeadline,
      holdingLabel: '你的持仓',
      holdings: matchedHoldings.map(h => `${h.ticker}${h.weight != null ? ` (占组合${h.weight}%)` : ''}`),
      typeLabel: EVENT_TYPE_ZH[eventType] || eventType,
      ticker, changePct, currentPrice, directionEmoji,
      summaryPrefix: '📰',
      summary: displaySummary,
      sourceUrl, source,
      sourceLabel: '来源',
      quickAnalysis,
      cta: '💬 回复 "深度" 获取AI深度分析',
    });
  }

  if (language === 'bilingual') {
    return buildMessage({
      headline: displayHeadline,
      holdingLabel: 'Your holding / 持仓',
      holdings: matchedHoldings.map(h => `${h.ticker}${h.weight != null ? ` (${h.weight}%)` : ''}`),
      typeLabel: EVENT_TYPE_EN[eventType] || eventType,
      ticker, changePct, currentPrice, directionEmoji,
      summaryPrefix: '📰',
      summary: displaySummary,
      sourceUrl, source,
      sourceLabel: 'Source / 来源',
      quickAnalysis,
      cta: '💬 Reply "deep" for analysis / 回复 "深度" 获取分析',
    });
  }

  // English (default)
  return buildMessage({
    headline: displayHeadline,
    holdingLabel: 'Your holding',
    holdings: matchedHoldings.map(h => `${h.ticker}${h.weight != null ? ` (${h.weight}% of portfolio)` : ''}`),
    typeLabel: EVENT_TYPE_EN[eventType] || eventType,
    ticker, changePct, currentPrice, directionEmoji,
    summaryPrefix: '📰',
    summary: displaySummary,
    sourceUrl, source,
    sourceLabel: 'Source',
    quickAnalysis,
    cta: '💬 Reply "deep" for AI-powered analysis',
  });
}

function buildMessage({ headline, holdingLabel, holdings, typeLabel, ticker, changePct, currentPrice, directionEmoji, summaryPrefix, summary, sourceUrl, source, sourceLabel, quickAnalysis, cta }) {
  let priceLine = `${typeLabel} | ${ticker}`;
  if (changePct != null && currentPrice != null) {
    const sign = changePct > 0 ? '+' : '';
    priceLine = `${directionEmoji} ${typeLabel} | ${ticker} ${sign}${changePct}% | $${currentPrice}`;
  } else if (changePct != null) {
    const sign = changePct > 0 ? '+' : '';
    priceLine = `${directionEmoji} ${typeLabel} | ${ticker} ${sign}${changePct}%`;
  }

  const lines = [
    `🔔 ${headline}`,
    '',
    `📌 ${holdingLabel}: ${holdings.join(', ')}`,
    priceLine,
  ];

  if (summary) lines.push('', `${summaryPrefix} ${summary}`);
  if (sourceUrl) {
    lines.push('', `🔗 ${sourceUrl}`);
  } else {
    lines.push('', `${sourceLabel}: ${source}`);
  }
  if (quickAnalysis) {
    lines.push('', `🧠 ${quickAnalysis}`);
  }
  lines.push('', cta);

  return lines.join('\n');
}

function truncateSummary(text, maxLen = 200) {
  if (!text) return '';
  const clean = text.replace(/<[^>]+>/g, '').trim();
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen);
  const lastPeriod = cut.lastIndexOf('. ');
  if (lastPeriod > maxLen * 0.4) return cut.slice(0, lastPeriod + 1);
  return cut + '…';
}

/**
 * Send a message via Telegram Bot API.
 */
export async function sendTelegramMessage(chatId, text, botToken) {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Telegram API error ${resp.status}: ${body}`);
  }
  return resp.json();
}

/**
 * Format and send alert for one user + one event.
 * Now async because translation may be needed.
 */
export async function pushAlertToUser(user, event, matchedHoldings, anthropicApiKey = null, { quickAnalysis = null, globalBotToken = null } = {}) {
  const text = await formatAlertMessage(event, matchedHoldings, user.language || 'en', anthropicApiKey, quickAnalysis);
  // Use user's own bot token if available, otherwise fall back to global bot token
  const botToken = user.telegram_bot_token || globalBotToken;
  if (!botToken) {
    throw new Error(`No bot token for user ${user.user_id}`);
  }
  return sendTelegramMessage(user.telegram_chat_id, text, botToken);
}
