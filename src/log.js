// Logger that scrubs secrets from anything it prints.
const SECRET_VARS = ['GEMINI_API_KEY', 'TELEGRAM_BOT_TOKEN'];

export function redact(text) {
  let out = String(text);
  for (const name of SECRET_VARS) {
    const secret = process.env[name]?.trim();
    if (secret && secret.length > 4) out = out.split(secret).join(`[${name}]`);
  }
  // Belt and braces: Telegram bot tokens have a recognisable shape.
  return out.replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, '[TELEGRAM_BOT_TOKEN]');
}

function format(args) {
  return args
    .map((a) => (a instanceof Error ? `${a.message}${a.cause ? ` (cause: ${a.cause.message ?? a.cause})` : ''}` : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
}

const stamp = () => new Date().toISOString();
export const log = {
  info: (...args) => console.log(`${stamp()} INFO  ${redact(format(args))}`),
  warn: (...args) => console.warn(`${stamp()} WARN  ${redact(format(args))}`),
  error: (...args) => console.error(`${stamp()} ERROR ${redact(format(args))}`),
};
