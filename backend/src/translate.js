/**
 * LLM-powered translation for FirstKnow backend.
 * Uses Claude Haiku for cost-efficient translation (~$0.0003/call).
 */

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-3-haiku-20240307';

/**
 * Translate headline + summary to target language.
 * @param {string} headline - English headline
 * @param {string} summary - English summary (optional)
 * @param {string} targetLang - 'zh' or 'bilingual'
 * @param {string} apiKey - Anthropic API key
 * @returns {{ headline: string, summary: string }}
 */
export async function translateText(headline, summary, targetLang, apiKey) {
  if (!apiKey) {
    console.warn('No ANTHROPIC_API_KEY, skipping translation');
    return { headline, summary: summary || '' };
  }

  const langInstruction = targetLang === 'zh'
    ? 'Translate to Chinese (简体中文).'
    : 'Provide both English original and Chinese translation.';

  const prompt = `${langInstruction}
Keep all ticker symbols (NVDA, BTC etc), numbers, $amounts, and percentages unchanged.
Be concise and natural. No commentary.

Headline: ${headline}
${summary ? `Summary: ${summary}` : ''}

Return in this exact format:
Headline: <translated>
${summary ? 'Summary: <translated>' : ''}`;

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
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`Translation API error ${resp.status}: ${err}`);
      return { headline, summary: summary || '' };
    }

    const data = await resp.json();
    const text = data.content
      ?.filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n') || '';

    const headlineMatch = text.match(/Headline:\s*(.+)/);
    const summaryMatch = text.match(/Summary:\s*([\s\S]+)/);

    return {
      headline: headlineMatch ? headlineMatch[1].trim() : headline,
      summary: summaryMatch ? summaryMatch[1].trim() : summary || '',
    };
  } catch (err) {
    console.error(`Translation failed: ${err.message}`);
    return { headline, summary: summary || '' };
  }
}
