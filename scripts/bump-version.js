#!/usr/bin/env node
/**
 * Atomically stamps the application version across backend, service worker,
 * client API config, and all static HTML asset query strings (?v=N).
 *
 * Usage:
 *   node scripts/bump-version.js        # auto-increments current version by 1
 *   node scripts/bump-version.js 48     # sets explicit version number
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const versionFile = path.join(ROOT, 'src', 'app', 'version.js');
const swFile = path.join(ROOT, 'public', 'sw.js');
const apiFile = path.join(ROOT, 'public', 'js', 'api.js');
const publicDir = path.join(ROOT, 'public');

const currentSrc = fs.readFileSync(versionFile, 'utf8');
const currentMatch = currentSrc.match(/CURRENT_APP_VERSION\s*=\s*'(\d+)'/);
if (!currentMatch) {
  console.error('Could not parse CURRENT_APP_VERSION in src/app/version.js');
  process.exit(1);
}

const currentVersion = parseInt(currentMatch[1], 10);
const nextArg = process.argv[2];
const nextVersion = nextArg ? String(parseInt(nextArg, 10)) : String(currentVersion + 1);
if (!/^\d+$/.test(nextVersion)) {
  console.error('Invalid version number:', nextArg);
  process.exit(1);
}

const toLf = (text) => text.replace(/\r\n/g, '\n');

const versionUpdated = currentSrc.replace(
  /CURRENT_APP_VERSION\s*=\s*'\d+'/,
  `CURRENT_APP_VERSION = '${nextVersion}'`
);
fs.writeFileSync(versionFile, toLf(versionUpdated), 'utf8');

const swUpdated = fs.readFileSync(swFile, 'utf8').replace(
  /const CACHE_NAME = 'pbf-cache-v\d+';/,
  `const CACHE_NAME = 'pbf-cache-v${nextVersion}';`
);
fs.writeFileSync(swFile, toLf(swUpdated), 'utf8');

const apiUpdated = fs.readFileSync(apiFile, 'utf8').replace(
  /CLIENT_VERSION:\s*'\d+'/,
  `CLIENT_VERSION: '${nextVersion}'`
);
fs.writeFileSync(apiFile, toLf(apiUpdated), 'utf8');

let htmlCount = 0;
for (const entry of fs.readdirSync(publicDir)) {
  if (!entry.endsWith('.html')) continue;
  const htmlPath = path.join(publicDir, entry);
  const before = fs.readFileSync(htmlPath, 'utf8');
  const after = before.replace(/((?:href|src)="\/(?:css|js)\/[^"?]+)\?v=\d+"/g, `$1?v=${nextVersion}"`);
  if (after !== before) {
    fs.writeFileSync(htmlPath, toLf(after), 'utf8');
    htmlCount++;
  }
}

console.log(`Stamped version v${currentVersion} -> v${nextVersion} across version.js, sw.js, api.js, and ${htmlCount} HTML files.`);
