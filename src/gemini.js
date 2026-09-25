import { log } from './log.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 120_000;

// Calls Gemini generateContent. The API key goes in a header, never the URL, so it can't leak into logs.
// json: true asks Gemini for a JSON response (used by the evaluation stages).
export async function generateText({ apiKey, model, temperature, systemInstruction, userContent, json = false }) {
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const body = JSON.stringify({
    ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
    contents: [{ role: 'user', parts: [{ text: userContent }] }],
    generationConfig: { temperature, ...(json ? { responseMimeType: 'application/json' } : {}) },
  });

  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const err = new Error(`Gemini HTTP ${res.status}: ${data?.error?.message ?? res.statusText}`);
        err.retryable = RETRYABLE.has(res.status);
        throw err;
      }

      const candidate = data.candidates?.[0];
      const text = candidate?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? '').join('') ?? '';
      if (!text.trim()) {
        const reason = data.promptFeedback?.blockReason ?? candidate?.finishReason ?? 'no candidates';
        const err = new Error(`Gemini returned no text (reason: ${reason})`);
        err.retryable = reason !== 'SAFETY' && reason !== 'PROHIBITED_CONTENT';
        throw err;
      }
      if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        log.warn(`Gemini finishReason=${candidate.finishReason}`);
      }
      return text;
    } catch (err) {
      const retryable = err.retryable ?? (err.name === 'TimeoutError' || err.name === 'TypeError');
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
      const delay = 2000 * attempt;
      log.warn(`Gemini attempt ${attempt} failed (${err.message}); retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// JSON call with validation. Invalid JSON or a failed validate() is retried once, then throws.
export async function generateJSON(request, validate) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = await generateText({ ...request, json: true });
    try {
      const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      return validate(parsed);
    } catch (err) {
      lastError = err;
      log.warn(`Invalid JSON from ${request.model} (attempt ${attempt}): ${err.message}`);
    }
  }
  throw lastError;
}
