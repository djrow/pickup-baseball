#!/usr/bin/env node
/**
 * Deterministic i18n key synchronization across split surface bundles and EN_DICT.
 *
 * Usage:
 *   node scripts/i18n-sync.js --surface clubhouse --add clubhouse.foo --en "Foo" --fill-en
 *   node scripts/i18n-sync.js --surface core --from-json keys.json --fill-en
 *   node scripts/i18n-sync.js --surface admin --remove admin.old_key,admin.old_key2
 *   node scripts/i18n-sync.js ... --dry-run
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXPECTED_LANGS = ['en', 'ar', 'es', 'fa', 'fr', 'hi', 'hy', 'ja', 'ko', 'pa', 'pt', 'ru', 'tl', 'vi', 'zh'];
const SURFACES = {
  core: 'public/i18n',
  clubhouse: 'public/i18n/clubhouse',
  admin: 'public/i18n/admin'
};

function patchEnDictSource(src, { mode, entries = {}, removeKeys = [] }) {
  const match = src.match(/((?:const|var)\s+EN_DICT\s*=\s*\{)([\s\S]*?)(\r?\n[ \t]*\};)/);
  if (!match) {
    throw new Error('Could not locate EN_DICT block in public/js/api/i18n.js');
  }

  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const rawLines = match[2]
    .split(/\r?\n/)
    .map((line) => line.replace(/,\s*$/, ''))
    .filter((line) => line.trim() !== '');

  const parsedEntries = rawLines.map((line) => {
    const m = line.match(/^(\s*)("(?:\\.|[^"\\])*")\s*:\s*([\s\S]*?)$/);
    if (!m) {
      throw new Error(`Unsupported EN_DICT line format: ${line}`);
    }
    return {
      indent: m[1] || '      ',
      key: JSON.parse(m[2]),
      line
    };
  });

  const defaultIndent = parsedEntries.length > 0 ? parsedEntries[0].indent : '      ';

  if (mode === 'add') {
    for (const [key, val] of Object.entries(entries)) {
      const formatted = `${defaultIndent}${JSON.stringify(key)}: ${JSON.stringify(val)}`;
      const existing = parsedEntries.find((item) => item.key === key);
      if (existing) {
        existing.line = `${existing.indent}${JSON.stringify(key)}: ${JSON.stringify(val)}`;
      } else {
        parsedEntries.push({ indent: defaultIndent, key, line: formatted });
      }
    }
  } else if (mode === 'remove') {
    const removeSet = new Set(removeKeys);
    for (let i = parsedEntries.length - 1; i >= 0; i--) {
      if (removeSet.has(parsedEntries[i].key)) {
        parsedEntries.splice(i, 1);
      }
    }
  }

  const newBody = parsedEntries.length > 0
    ? eol + parsedEntries.map((item) => item.line).join(',' + eol)
    : '';
  const updatedBlock = `${match[1]}${newBody}${match[3]}`;
  return src.slice(0, match.index) + updatedBlock + src.slice(match.index + match[0].length);
}

function syncI18nEntries({
  rootDir = ROOT,
  mode,
  surface = 'core',
  entries = {},
  translationsByKey = {},
  removeKeys = [],
  fillEn = false,
  dryRun = false
}) {
  if (!Object.prototype.hasOwnProperty.call(SURFACES, surface)) {
    throw new Error(`Unknown i18n surface "${surface}". Expected one of: ${Object.keys(SURFACES).join(', ')}`);
  }
  if (mode !== 'add' && mode !== 'remove') {
    throw new Error(`Unsupported mode "${mode}". Expected "add" or "remove".`);
  }

  const surfaceDir = path.join(rootDir, SURFACES[surface]);
  const i18nJsPath = path.join(rootDir, 'public', 'js', 'api', 'i18n.js');
  const changedFiles = [];

  let keysList;
  if (mode === 'add') {
    keysList = Object.keys(entries);
    if (keysList.length === 0) {
      throw new Error('No entries provided for i18n-sync add mode.');
    }
  } else {
    keysList = removeKeys.length > 0
      ? removeKeys.slice()
      : (Array.isArray(entries) ? entries.slice() : Object.keys(entries));
    if (keysList.length === 0) {
      throw new Error('No keys provided for i18n-sync remove mode.');
    }
  }

  for (const lang of EXPECTED_LANGS) {
    const filePath = path.join(surfaceDir, `${lang}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing locale bundle: ${path.relative(rootDir, filePath).replace(/\\/g, '/')}`);
    }
    const beforeRaw = fs.readFileSync(filePath, 'utf8');
    const dict = JSON.parse(beforeRaw);
    let mutated = false;

    if (mode === 'add') {
      for (const key of keysList) {
        const englishText = entries[key];
        const perKeyTranslations = translationsByKey[key] || {};
        let targetVal;
        if (lang === 'en') {
          targetVal = Object.prototype.hasOwnProperty.call(perKeyTranslations, 'en')
            ? perKeyTranslations.en
            : englishText;
        } else if (Object.prototype.hasOwnProperty.call(perKeyTranslations, lang)) {
          targetVal = perKeyTranslations[lang];
        } else if (fillEn) {
          targetVal = englishText;
        } else if (Object.prototype.hasOwnProperty.call(dict, key)) {
          continue;
        } else {
          throw new Error(
            `Missing translation for key "${key}" in locale "${lang}" (${surface}). Pass translations or --fill-en.`
          );
        }

        if (dict[key] !== targetVal) {
          dict[key] = targetVal;
          mutated = true;
        }
      }
    } else {
      for (const key of keysList) {
        if (Object.prototype.hasOwnProperty.call(dict, key)) {
          delete dict[key];
          mutated = true;
        }
      }
    }

    const nextRaw = JSON.stringify(dict, null, 2) + '\n';
    if (mutated || nextRaw !== beforeRaw.replace(/\r\n/g, '\n')) {
      changedFiles.push(path.relative(rootDir, filePath).replace(/\\/g, '/'));
      if (!dryRun) {
        fs.writeFileSync(filePath, nextRaw, 'utf8');
      }
    }
  }

  if (!fs.existsSync(i18nJsPath)) {
    throw new Error(`Missing EN_DICT host file: ${path.relative(rootDir, i18nJsPath).replace(/\\/g, '/')}`);
  }
  const beforeI18nJs = fs.readFileSync(i18nJsPath, 'utf8');
  const nextI18nJs = patchEnDictSource(beforeI18nJs, {
    mode,
    entries,
    removeKeys: keysList
  });
  if (nextI18nJs !== beforeI18nJs) {
    changedFiles.push(path.relative(rootDir, i18nJsPath).replace(/\\/g, '/'));
    if (!dryRun) {
      fs.writeFileSync(i18nJsPath, nextI18nJs, 'utf8');
    }
  }

  return {
    changedFiles,
    keysProcessed: keysList.length,
    dryRun: Boolean(dryRun)
  };
}

function parseCliArgs(argv) {
  const opts = {
    surface: 'core',
    addKey: null,
    enText: null,
    translationsJson: null,
    fromJson: null,
    removeKeys: [],
    fillEn: false,
    dryRun: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--surface' && argv[i + 1]) {
      opts.surface = argv[++i];
    } else if (arg.startsWith('--surface=')) {
      opts.surface = arg.slice('--surface='.length);
    } else if (arg === '--add' && argv[i + 1]) {
      opts.addKey = argv[++i];
    } else if (arg.startsWith('--add=')) {
      opts.addKey = arg.slice('--add='.length);
    } else if (arg === '--en' && argv[i + 1] !== undefined) {
      opts.enText = argv[++i];
    } else if (arg.startsWith('--en=')) {
      opts.enText = arg.slice('--en='.length);
    } else if (arg === '--translations' && argv[i + 1]) {
      opts.translationsJson = argv[++i];
    } else if (arg.startsWith('--translations=')) {
      opts.translationsJson = arg.slice('--translations='.length);
    } else if (arg === '--from-json' && argv[i + 1]) {
      opts.fromJson = argv[++i];
    } else if (arg.startsWith('--from-json=')) {
      opts.fromJson = arg.slice('--from-json='.length);
    } else if (arg === '--remove' && argv[i + 1]) {
      opts.removeKeys = argv[++i].split(',').map((k) => k.trim()).filter(Boolean);
    } else if (arg.startsWith('--remove=')) {
      opts.removeKeys = arg.slice('--remove='.length).split(',').map((k) => k.trim()).filter(Boolean);
    } else if (arg === '--fill-en') {
      opts.fillEn = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    }
  }

  return opts;
}

function runCli() {
  const opts = parseCliArgs(process.argv.slice(2));
  let mode;
  const entries = {};
  const translationsByKey = {};

  if (opts.removeKeys.length > 0) {
    mode = 'remove';
  } else if (opts.fromJson) {
    mode = 'add';
    const raw = JSON.parse(fs.readFileSync(path.resolve(opts.fromJson), 'utf8'));
    for (const [key, val] of Object.entries(raw)) {
      if (typeof val === 'string') {
        entries[key] = val;
      } else if (val && typeof val === 'object') {
        if (typeof val.en !== 'string') {
          throw new Error(`Entry "${key}" in ${opts.fromJson} must include an "en" string.`);
        }
        entries[key] = val.en;
        translationsByKey[key] = val;
      }
    }
  } else if (opts.addKey) {
    if (opts.enText === null) {
      throw new Error('--add requires --en "<english text>"');
    }
    mode = 'add';
    entries[opts.addKey] = opts.enText;
    if (opts.translationsJson) {
      translationsByKey[opts.addKey] = JSON.parse(opts.translationsJson);
    }
  } else {
    throw new Error('Specify --add <key> --en "<text>", --from-json <file>, or --remove <k1,k2>.');
  }

  const res = syncI18nEntries({
    rootDir: ROOT,
    mode,
    surface: opts.surface,
    entries,
    translationsByKey,
    removeKeys: opts.removeKeys,
    fillEn: opts.fillEn,
    dryRun: opts.dryRun
  });

  console.log(
    `i18n-sync: ${mode} ${res.keysProcessed} key(s) on ${opts.surface} across ${res.changedFiles.length} file(s)${res.dryRun ? ' (dry-run)' : ''}`
  );
}

if (require.main === module) {
  try {
    runCli();
  } catch (err) {
    console.error(`i18n-sync error: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  syncI18nEntries,
  EXPECTED_LANGS,
  SURFACES
};
