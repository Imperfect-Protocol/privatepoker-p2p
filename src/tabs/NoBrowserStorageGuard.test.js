import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { test } from 'node:test';

const ROOTS = [
  '/Users/sadhbh/src/ImperfectProtocol/privatepoker-p2p/src',
  '/Users/sadhbh/src/ImperfectProtocol/privatepoker-p2p-testapp/src',
];
const FORBIDDEN = [
  /\blocalStorage\b/i,
  /\bsessionStorage\b/i,
  /\bindexedDB\b/i,
  /document\.cookie/i,
  /\bserviceWorker\b/i,
  /\bSharedWorker\b/,
];

function collectSources(root, matches) {
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      collectSources(path, matches);
      continue;
    }
    if (!['.js', '.jsx'].includes(extname(entry))) continue;
    if (entry.endsWith('.test.js') || entry.endsWith('.test.jsx')) continue;
    const text = readFileSync(path, 'utf8');
    FORBIDDEN.forEach((pattern) => {
      if (pattern.test(text)) matches.push({ path: path.slice(root.length + 1), pattern });
    });
  }
}

test('the library and testapp never reach for persistent browser storage', () => {
  const matches = [];
  ROOTS.forEach((root) => collectSources(root, matches));
  assert.deepEqual(matches, []);
});
