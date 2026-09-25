import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../config.js';

// Evaluation settings, prompts and product data are read on every call,
// so tuning config/evaluation.json or prompts/*.md takes effect without a restart.

export function loadEvalSettings() {
  return JSON.parse(readFileSync(resolve(ROOT, 'config/evaluation.json'), 'utf8'));
}

export function loadPrompt(name, vars) {
  const template = readFileSync(resolve(ROOT, 'prompts', `${name}.md`), 'utf8');
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

// Returns the product reference data as text, or null if the project has none.
export function loadProductData(settings) {
  const path = resolve(ROOT, settings.productDataPath ?? '');
  if (!settings.productDataPath || !existsSync(path)) return null;
  const text = readFileSync(path, 'utf8').trim();
  return text || null;
}

// Prompt fragments shared by both stages.
export function claimPromptVars(productData) {
  return productData
    ? {
        PRODUCT_DATA: productData,
        INTERNAL_RULE: '"verified" if it matches the product reference data below; "unverified" if it contradicts it or cannot be checked against it.',
      }
    : {
        PRODUCT_DATA: '(none - the project has no Skinstinct product data yet)',
        INTERNAL_RULE: '"needs_confirmation" (there is no product data to check against).',
      };
}

export function pillarList(settings) {
  return settings.pillars.map((p) => `- ${p.name}: ${p.description}`).join('\n');
}
