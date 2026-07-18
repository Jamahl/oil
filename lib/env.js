'use strict';
// Minimal .env loader — KEY=VALUE lines, no quotes/expansion. Existing env wins.
const fs = require('fs');
const path = require('path');

try {
  const txt = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* no .env file — fine */
}
