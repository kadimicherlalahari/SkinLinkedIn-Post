import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ROOT } from '../config.js';
import { log } from '../log.js';

// Local files under data/ (gitignored):
//   evaluations.jsonl - one line per event (gate, override, quality), joined by id, for tuning thresholds
//   pending.json      - notes waiting on a "Generate anyway" / "Skip" button press
//   posts.jsonl       - every post sent, labelled post_001, post_002... for the overlap check
export function createStore(dir = resolve(ROOT, 'data')) {
  const evalFile = resolve(dir, 'evaluations.jsonl');
  const pendingFile = resolve(dir, 'pending.json');
  const postsFile = resolve(dir, 'posts.jsonl');
  mkdirSync(dir, { recursive: true });

  const readPending = () => {
    try {
      return existsSync(pendingFile) ? JSON.parse(readFileSync(pendingFile, 'utf8')) : {};
    } catch (err) {
      log.error('pending.json unreadable, starting empty:', err);
      return {};
    }
  };
  const writePending = (p) => writeFileSync(pendingFile, JSON.stringify(p, null, 2));

  return {
    newId: () => randomBytes(6).toString('hex'),

    logEvent(event) {
      try {
        appendFileSync(evalFile, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
      } catch (err) {
        log.error('Could not write evaluation log:', err);
      }
    },

    savePending(id, entry, expiryDays = 7) {
      const pending = readPending();
      const cutoff = Date.now() - expiryDays * 86_400_000;
      for (const [k, v] of Object.entries(pending)) if (Date.parse(v.createdAt) < cutoff) delete pending[k];
      pending[id] = { ...entry, createdAt: new Date().toISOString() };
      writePending(pending);
    },

    // All sent posts, oldest first.
    readPosts() {
      try {
        if (!existsSync(postsFile)) return [];
        return readFileSync(postsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch (err) {
        log.error('posts.jsonl unreadable, overlap check will see no past posts:', err);
        return [];
      }
    },

    // Records a sent post and returns its label (post_001...).
    addPost({ id, pillar, angle, post }) {
      const label = `post_${String(this.readPosts().length + 1).padStart(3, '0')}`;
      try {
        appendFileSync(postsFile, `${JSON.stringify({ label, id, ts: new Date().toISOString(), pillar, angle, post })}\n`);
      } catch (err) {
        log.error('Could not record post:', err);
      }
      return label;
    },

    // Removes and returns the entry, so a button can only be acted on once.
    takePending(id) {
      const pending = readPending();
      const entry = pending[id];
      if (entry) {
        delete pending[id];
        writePending(pending);
      }
      return entry ?? null;
    },
  };
}
