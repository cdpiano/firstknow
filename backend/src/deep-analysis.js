/**
 * Deep analysis powered by Claude Haiku — runs on backend.
 * No user API key needed.
 */

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-3-haiku-20240307';

const SYSTEM_PROMPT = `You are a senior investment strategist. The user wants a deep dive on a news event affecting their portfolio. Provide thorough analysis.

Structure:
1. **What's really going on** — beneath the headline. What does this signal about the company's trajectory, competitive position, or regulatory environment?
2. **Historical comparison** — find the closest precedent. Show what happened to the stock price, how long recovery took.
3. **Portfolio impact assessment** — stress test with three scenarios:
   - Best case (probability + estimated % move)
   - Base case (probability + estimated % move)
   - Worst case (probability + estimated % move)
4. **Specific action items** — precise recommendations. "If NVDA drops below $780, add 3% to bring position to 28%" — not vague "consider adding".
5. **Key indicators to watch** — name specific metrics, dates, or events with expected timelines.

Style: thorough but readable. Use numbers and data, not generalities. Deep but not academic. Opinionated but honest about uncertainty.`;

/**
 * Generate a deep analysis for an event + portfolio context.
 * @param {Object} event - The news event object
 * @param {Array} holdings - User's holdings [{ticker, weight}, ...]
 * @param {string} language - 'en' | 'zh' | 'bilingual'
 * @param {string} apiKey - Anthropic API key (backend-owned)
 * @returns {string} Analysis text
 */
export async function generateDeepAnalysis(event, holdings, language, apiKey) {
  if (!apiKey) {
    return '⚠️ Deep analysis is temporarily unavailable. Please try again later.';
  }

  const portfolioStr = holdings
    .map((h) => `${h.ticker}${h.weight != null ? ` (${h.weight}%)` : ''}`)
    .join(', ');

  const priceCtxStr = event.price_context
    ? JSON.stringify(event.price_context, null, 2)
    : 'No price data available';

  const langInstruction = language === 'zh'
    ? 'Respond entirely in Chinese (简体中文).'
    : language === 'bilingual'
      ? 'Respond in English first, then provide a Chinese translation below.'
      : 'Respond in English.';

  const userMessage = `${langInstruction}

**News Event:**
${event.headline}

**Source:** ${event.source || 'Unknown'}

**Full Content:**
${event.raw_content || event.headline}

**Price Context:**
${priceCtxStr}

**User's Portfolio:**
${portfolioStr}

Provide your deep analysis now. Use the structure above with clear headers.`;

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
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`Deep analysis API error ${resp.status}: ${err}`);
      return '⚠️ Deep analysis failed. Please try again later.';
    }

    const data = await resp.json();
    const text = data.content
      ?.filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n') || '';

    return text || '⚠️ No analysis generated.';
  } catch (err) {
    console.error(`Deep analysis failed: ${err.message}`);
    return '⚠️ Deep analysis failed. Please try again later.';
  }
}
