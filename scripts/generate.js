// Run the pipeline from the command line, without Telegram. Useful for testing prompts and thresholds.
//   npm run generate -- "your rough idea here"          gate + generation + quality check
//   npm run gate -- "your rough idea here"              Stage 1 only, prints the JSON
//   echo "idea" | npm run generate
import { loadConfig } from '../src/config.js';
import { generatePost } from '../src/generate.js';
import { evaluateNote } from '../src/eval/gate.js';
import { formatScoreBlock } from '../src/eval/quality.js';
import { createStore } from '../src/eval/store.js';
import { out10 } from '../src/eval/scale.js';
import { log } from '../src/log.js';

const gateOnly = process.argv.includes('--gate-only');
let idea = process.argv.slice(2).filter((a) => a !== '--gate-only').join(' ').trim();
if (!idea && !process.stdin.isTTY) {
  for await (const chunk of process.stdin) idea += chunk;
  idea = idea.trim();
}
if (!idea) {
  console.error('Usage: npm run generate -- "your idea"   |   npm run gate -- "your idea"');
  process.exit(1);
}

try {
  const config = loadConfig({ needTelegram: false });
  const gate = await evaluateNote(idea, config);
  if (gateOnly) {
    console.log(JSON.stringify(gate, null, 2));
    process.exit(0);
  }
  if (gate) console.error(`Note gate: ${gate.decision} (${out10(gate.composite)}/10) - generating regardless (CLI)\n`);
  const { post, quality } = await generatePost(idea, config, { gate, pastPosts: createStore().readPosts() });
  console.log(post);
  if (quality) console.log(`\n---\n${formatScoreBlock(quality, gate, { overridden: gate && gate.decision !== 'PROCEED' })}`);
} catch (err) {
  log.error(err);
  process.exit(1);
}
