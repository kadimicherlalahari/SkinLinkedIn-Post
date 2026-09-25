// Scores are computed 0-100 internally (config, thresholds, logs) and shown to Meera out of 10.
export const out10 = (n) => String(Math.round(n) / 10).replace(/\.0$/, '');
