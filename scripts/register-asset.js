#!/usr/bin/env node
/**
 * Register new public HTML/CSS/JS assets in public/sw.js STATIC_ASSETS
 * and optionally inject versioned tags (?v=<CURRENT_APP_VERSION>) into HTML pages.
 *
 * Usage:
 *   node scripts/register-asset.js --sync
 *   node scripts/register-asset.js /js/foo.js /css/foo.css --pages index.html,event.html
 *   node scripts/register-asset.js --sync --dry-run
 */

const fs = require('node:fs');
const path = require('node:path');
const { checkPwaAssetSync } = require('./security-scan.js');

const ROOT = path.resolve(__dirname, '..');

function normalizeAssetPath(raw) {
  let p = String(raw || '').trim().replace(/\\/g, '/');
  if (!p) return '';
  p = p.replace(/^\/?public\//, '/');
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patchServiceWorkerAssets(swSrc, newAssets) {
  if (newAssets.length === 0) return { updatedSrc: swSrc, added: [] };

  const match = swSrc.match(/((?:const|var)\s+STATIC_ASSETS\s*=\s*\[)([\s\S]*?)(\r?\n[ \t]*\];)/);
  if (!match) {
    throw new Error('Could not locate STATIC_ASSETS array in public/sw.js');
  }

  const eol = swSrc.includes('\r\n') ? '\r\n' : '\n';
  const lines = match[2].split(/\r?\n/);
  const added = [];

  for (const asset of newAssets) {
    if (match[2].includes(`'${asset}'`) || match[2].includes(`"${asset}"`) || added.includes(asset)) {
      continue;
    }

    let extPattern = null;
    if (asset.endsWith('.html')) extPattern = /\.html['"],?\s*$/;
    else if (asset.endsWith('.css')) extPattern = /\.css['"],?\s*$/;
    else if (asset.endsWith('.js')) extPattern = /\.js['"],?\s*$/;

    let insertAt = -1;
    if (extPattern) {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (extPattern.test(lines[i])) {
          insertAt = i + 1;
          break;
        }
      }
    }
    if (insertAt === -1) {
      insertAt = lines.length;
    }

    lines.splice(insertAt, 0, `  '${asset}',`);
    added.push(asset);
  }

  if (added.length === 0) {
    return { updatedSrc: swSrc, added: [] };
  }

  const entryLineIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*['"][^'"]+['"]\s*,?\s*$/.test(lines[i])) {
      entryLineIndices.push(i);
    }
  }
  const lastEntryIdx = entryLineIndices[entryLineIndices.length - 1];
  for (const idx of entryLineIndices) {
    const clean = lines[idx].replace(/,\s*$/, '');
    lines[idx] = idx === lastEntryIdx ? clean : `${clean},`;
  }

  const updatedBlock = `${match[1]}${lines.join(eol)}${match[3]}`;
  return {
    updatedSrc: swSrc.slice(0, match.index) + updatedBlock + swSrc.slice(match.index + match[0].length),
    added
  };
}

function injectAssetTagsIntoHtml(htmlSrc, assets, appVer) {
  const eol = htmlSrc.includes('\r\n') ? '\r\n' : '\n';
  let updated = htmlSrc;

  for (const asset of assets) {
    if (asset.endsWith('.css')) {
      const existingRx = new RegExp(`href=["']${escapeRegExp(asset)}(?:\\?v=\\d+)?["']`);
      if (!existingRx.test(updated)) {
        const headCloseRx = /([ \t]*)<\/head>/i;
        if (headCloseRx.test(updated)) {
          updated = updated.replace(
            headCloseRx,
            `$1  <link rel="stylesheet" href="${asset}?v=${appVer}">${eol}$1</head>`
          );
        }
      }
    } else if (asset.endsWith('.js')) {
      const existingRx = new RegExp(`src=["']${escapeRegExp(asset)}(?:\\?v=\\d+)?["']`);
      if (!existingRx.test(updated)) {
        const bodyCloseRx = /([ \t]*)<\/body>/i;
        if (bodyCloseRx.test(updated)) {
          updated = updated.replace(
            bodyCloseRx,
            `$1  <script src="${asset}?v=${appVer}"></script>${eol}$1</body>`
          );
        }
      }
    }
  }

  return updated;
}

function registerAssets({
  rootDir = ROOT,
  assets = [],
  sync = false,
  pages = [],
  dryRun = false
} = {}) {
  const versionPath = path.join(rootDir, 'src', 'app', 'version.js');
  const swPath = path.join(rootDir, 'public', 'sw.js');
  const verSrc = fs.readFileSync(versionPath, 'utf8');
  const verMatch = verSrc.match(/CURRENT_APP_VERSION\s*=\s*'(\d+)'/);
  if (!verMatch) {
    throw new Error('Could not parse CURRENT_APP_VERSION in src/app/version.js');
  }
  const appVer = verMatch[1];

  const targetAssets = [];
  const pushUniqueAsset = (raw) => {
    const norm = normalizeAssetPath(raw);
    if (norm && !targetAssets.includes(norm)) targetAssets.push(norm);
  };

  for (const asset of assets) pushUniqueAsset(asset);
  if (sync) {
    const audit = checkPwaAssetSync(rootDir, { silent: true });
    for (const missing of audit.missingFromSw || []) pushUniqueAsset(missing);
  }

  const swSrc = fs.readFileSync(swPath, 'utf8');
  const { updatedSrc: nextSwSrc, added: addedToSw } = patchServiceWorkerAssets(swSrc, targetAssets);
  if (addedToSw.length > 0 && !dryRun) {
    fs.writeFileSync(swPath, nextSwSrc, 'utf8');
  }

  const updatedPages = [];
  const normalizedPages = Array.from(
    new Set(pages.map((p) => String(p || '').trim().replace(/^\/+/, '')).filter(Boolean))
  );
  for (const page of normalizedPages) {
    const pagePath = path.join(rootDir, 'public', page);
    if (!fs.existsSync(pagePath)) {
      throw new Error(`HTML page not found: public/${page}`);
    }
    const beforeHtml = fs.readFileSync(pagePath, 'utf8');
    const nextHtml = injectAssetTagsIntoHtml(beforeHtml, targetAssets, appVer);
    if (nextHtml !== beforeHtml) {
      updatedPages.push(page);
      if (!dryRun) {
        fs.writeFileSync(pagePath, nextHtml, 'utf8');
      }
    }
  }

  return {
    addedToSw,
    updatedPages,
    appVer,
    dryRun: Boolean(dryRun)
  };
}

function parseCliArgs(argv) {
  const opts = {
    assets: [],
    sync: false,
    pages: [],
    dryRun: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sync') {
      opts.sync = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--pages' && argv[i + 1]) {
      opts.pages.push(...argv[++i].split(',').map((p) => p.trim()).filter(Boolean));
    } else if (arg.startsWith('--pages=')) {
      opts.pages.push(...arg.slice('--pages='.length).split(',').map((p) => p.trim()).filter(Boolean));
    } else if (!arg.startsWith('-')) {
      opts.assets.push(arg);
    }
  }

  return opts;
}

function runCli() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (!opts.sync && opts.assets.length === 0) {
    throw new Error('Specify asset paths and/or --sync.');
  }

  const res = registerAssets({
    rootDir: ROOT,
    assets: opts.assets,
    sync: opts.sync,
    pages: opts.pages,
    dryRun: opts.dryRun
  });

  console.log(
    `register-asset: added ${res.addedToSw.length} asset(s) to sw.js, updated ${res.updatedPages.length} HTML page(s) at v${res.appVer}${res.dryRun ? ' (dry-run)' : ''}`
  );
}

if (require.main === module) {
  try {
    runCli();
  } catch (err) {
    console.error(`register-asset error: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  registerAssets
};
