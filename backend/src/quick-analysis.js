/**
 * Quick 2-3 sentence analysis for important events.
 * Appended to push alerts automatically — no user action needed.
 */

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-3-haiku-20240307';

const SYSTEM_PROMPT = `You are a sharp investment analyst. Given a breaking news event and the user's portfolio, write exactly 2-3 sentences of analysis.

Rules:
- Lead with the conclusion (positive/negative/neutral for the holding)
- Use specific numbers from the price context
- Put it in portfolio context (mention their weight if available)
- Be direct and opinionated. No filler phrases.
- Under 60 words total.
- Do NOT use headers, bullet points, or markdown. Just plain sentences.`;

/**
 * Generate a quick 2-3 sentence analysis for push alerts.
 * Gracefully returns null on failure (alert still sends without it).
 *
 * @param {Object} event - The news event
 * @param {Array} matchedHoldings - [{ticker, weight}, ...]
 * @param {string} language - 'en' | 'zh' | 'bilingual'
 * @param {string} apiKey - Anthropic API key
 * @returns {string|null} Quick analysis text, or null on failure
 */
export async function generateQuickAnalysis(event, matchedHoldings, language, apiKey) {
  if (!apiKey) return null;

  const holdingsStr = matchedHoldings
    .map((h) => `${h.ticker}${h.weight != null ? ` (${h.weight}%)` : ''}`)
    .join(', ');

  const priceCtxStr = event.price_context
    ? JSON.stringify(event.price_context, null, 2)
    : 'No price data';

  const langInstruction = language === 'zh'
    ? 'Respond in Chinese (简体中文).'
    : language === 'bilingual'
      ? 'Respond in English.'
      : 'Respond in English.';

  const userMessage = `${langInstruction}

Event: ${event.headline}
Type: ${event.event_type || 'news'}
Source: ${event.source || 'Unknown'}
Content: ${(event.raw_content || '').slice(0, 300)}
Price: ${priceCtxStr}
User holds: ${holdingsStr}

Write 2-3 sentences of analysis. No headers or bullets.`;

  try {
    const resp = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!resp.ok) {
      console.error(`Quick analysis API error ${resp.status}`);
      return null;
    }

    const data = await resp.json();
    const text = data.content
      ?.filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim() || null;

    return text;
  } catch (err) {
    console.error(`Quick analysis failed: ${err.message}`);
    return null;
  }
}
