// Generate a post from the command line, without Telegram. Useful for testing prompts.
//   npm run generate -- "your rough idea here"
//   echo "idea" | npm run generate
import { loadConfig } from '../src/config.js';
import { generatePost } from '../src/generate.js';
import { log } from '../src/log.js';

let idea = process.argv.slice(2).join(' ').trim();
if (!idea && !process.stdin.isTTY) {
  for await (const chunk of process.stdin) idea += chunk;
  idea = idea.trim();
}
if (!idea) {
  console.error('Usage: npm run generate -- "your idea"');
  process.exit(1);
}

try {
  console.log(await generatePost(idea, loadConfig({ needTelegram: false })));
} catch (err) {
  log.error(err);
  process.exit(1);
}
