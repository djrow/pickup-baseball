#!/usr/bin/env node
/**
 * Interactive Self-Host Community Onboarding Wizard (`npm run setup`).
 * Zero external dependencies beyond Node.js built-ins + local `better-sqlite3` schema engine.
 *
 * Configures Community identity (`COMMUNITY_PRESET`, `COMMUNITY_NAME`, `PUBLIC_ORIGIN`,
 * `LOCK_PREVIEW_ORIGIN`, `ADMIN_EMAIL`, `ADMIN_NAME`, `FROM_EMAIL`), generates cryptographically
 * strong 256-bit hex secrets (`SESSION_SECRET`, `WAIVER_SIGNING_SECRET`, `CRON_SECRET`,
 * `INVITE_SECRET`), writes `.env` and `.dev.vars`, initializes dual D1/SQLite schemas,
 * and bootstraps the initial Admin account.
 *
 * Supports interactive terminal prompts or scripted/non-interactive execution via CLI flags
 * and environment variables (`--yes`, `--dir=...` / `SETUP_TARGET_DIR`).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const Database = require('better-sqlite3');

const { createD1Adapter } = require('../src/d1-sqlite');
const { ensureDualD1Schema } = require('../src/app/schema.js');

const ROOT_DIR = path.resolve(__dirname, '..');

const SECRET_KEYS = [
  'SESSION_SECRET',
  'WAIVER_SIGNING_SECRET',
  'CRON_SECRET',
  'INVITE_SECRET'
];

function generateSecretHex() {
  return crypto.randomBytes(32).toString('hex');
}

function parseKeyValueFile(filePath) {
  const out = {};
  if (!filePath || !fs.existsSync(filePath)) return out;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function formatEnvValue(val) {
  const str = val === undefined || val === null ? '' : String(val);
  if (!str) return '';
  if (/[\s#"']/.test(str)) {
    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return str;
}

function parseSetupArgs(argv) {
  const opts = {
    yes: false,
    rotateSecrets: false,
    skipDb: false,
    help: false,
    dir: process.env.SETUP_TARGET_DIR ? path.resolve(process.env.SETUP_TARGET_DIR) : ROOT_DIR,
    preset: null,
    name: null,
    origin: null,
    lockPreview: null,
    handbookUrl: null,
    adminEmail: null,
    adminName: null,
    fromEmail: null,
    replyToEmail: null,
    mailProvider: null,
    resendApiKey: null,
    storageProvider: null,
    r2AccountId: null,
    r2BucketName: null,
    r2AccessKeyId: null,
    r2SecretAccessKey: null,
    gdriveClientId: null,
    gdriveClientSecret: null,
    gdriveRefreshToken: null,
    gdriveRootFolderId: null,
    turnstileSiteKey: null,
    turnstileSecretKey: null
  };

  const flagMap = {
    '--dir': 'dir',
    '--preset': 'preset',
    '--name': 'name',
    '--origin': 'origin',
    '--lock-preview': 'lockPreview',
    '--handbook-url': 'handbookUrl',
    '--admin-email': 'adminEmail',
    '--admin-name': 'adminName',
    '--from-email': 'fromEmail',
    '--reply-to-email': 'replyToEmail',
    '--mail-provider': 'mailProvider',
    '--resend-api-key': 'resendApiKey',
    '--storage-provider': 'storageProvider',
    '--r2-account-id': 'r2AccountId',
    '--r2-bucket-name': 'r2BucketName',
    '--r2-access-key-id': 'r2AccessKeyId',
    '--r2-secret-access-key': 'r2SecretAccessKey',
    '--gdrive-client-id': 'gdriveClientId',
    '--gdrive-client-secret': 'gdriveClientSecret',
    '--gdrive-refresh-token': 'gdriveRefreshToken',
    '--gdrive-root-folder-id': 'gdriveRootFolderId',
    '--turnstile-site-key': 'turnstileSiteKey',
    '--turnstile-secret-key': 'turnstileSecretKey'
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes' || arg === '-y' || arg === '--non-interactive') {
      opts.yes = true;
    } else if (arg === '--rotate-secrets') {
      opts.rotateSecrets = true;
    } else if (arg === '--skip-db') {
      opts.skipDb = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      let matched = false;
      for (const [flag, prop] of Object.entries(flagMap)) {
        if (arg === flag && argv[i + 1] !== undefined) {
          const v = argv[++i];
          opts[prop] = prop === 'dir' ? path.resolve(v) : v;
          matched = true;
          break;
        }
        if (arg.startsWith(`${flag}=`)) {
          const v = arg.slice(flag.length + 1);
          opts[prop] = prop === 'dir' ? path.resolve(v) : v;
          matched = true;
          break;
        }
      }
      if (!matched) {
        throw new Error(`Unknown CLI argument: ${arg}`);
      }
    }
  }

  return opts;
}

function askQuestion(rl, promptText, defaultVal = '') {
  if (!rl) return Promise.resolve(defaultVal);
  const suffix = defaultVal ? ` [${defaultVal}]` : '';
  return new Promise((resolve) => {
    rl.question(`${promptText}${suffix}: `, (answer) => {
      const trimmed = String(answer || '').trim();
      resolve(trimmed || defaultVal);
    });
  });
}

function renderEnvContent(config) {
  const lines = [
    '# ==============================================================================',
    '# Community Hub — Self-Host Environment Configuration',
    '# Generated by `npm run setup` (scripts/setup.js). Never commit this file.',
    '# ==============================================================================',
    '',
    '# Boot / Deploy Identity & Preset (ADR-0001)',
    `COMMUNITY_PRESET=${formatEnvValue(config.COMMUNITY_PRESET)}`,
    `COMMUNITY_NAME=${formatEnvValue(config.COMMUNITY_NAME)}`,
    `PUBLIC_ORIGIN=${formatEnvValue(config.PUBLIC_ORIGIN)}`,
    `LOCK_PREVIEW_ORIGIN=${formatEnvValue(config.LOCK_PREVIEW_ORIGIN)}`,
    `HANDBOOK_URL=${formatEnvValue(config.HANDBOOK_URL)}`,
    '',
    '# Initial Admin & Email Sender Identity',
    `ADMIN_EMAIL=${formatEnvValue(config.ADMIN_EMAIL)}`,
    `ADMIN_NAME=${formatEnvValue(config.ADMIN_NAME)}`,
    `FROM_EMAIL=${formatEnvValue(config.FROM_EMAIL)}`,
    `REPLY_TO_EMAIL=${formatEnvValue(config.REPLY_TO_EMAIL)}`,
    '',
    '# Adapter Selectors',
    `MAIL_PROVIDER=${formatEnvValue(config.MAIL_PROVIDER)}`,
    `STORAGE_PROVIDER=${formatEnvValue(config.STORAGE_PROVIDER)}`,
    '',
    '# Sport Feature Flags (0/1)',
    `FEATURE_BATTING_PRACTICE=${formatEnvValue(config.FEATURE_BATTING_PRACTICE)}`,
    `FEATURE_CERTIFIED_SHIFTS=${formatEnvValue(config.FEATURE_CERTIFIED_SHIFTS)}`,
    `FEATURE_SUNDAY_PRIORITY=${formatEnvValue(config.FEATURE_SUNDAY_PRIORITY)}`,
    '',
    '# Cryptographic Secrets (256-bit hex)',
    `SESSION_SECRET=${formatEnvValue(config.SESSION_SECRET)}`,
    `WAIVER_SIGNING_SECRET=${formatEnvValue(config.WAIVER_SIGNING_SECRET)}`,
    `CRON_SECRET=${formatEnvValue(config.CRON_SECRET)}`,
    `INVITE_SECRET=${formatEnvValue(config.INVITE_SECRET)}`,
    `WAIVER_RETENTION_YEARS=${formatEnvValue(config.WAIVER_RETENTION_YEARS)}`,
    '',
    '# Local Runtime & Optional Provider Credentials',
    `PORT=${formatEnvValue(config.PORT)}`,
    `NODE_ENV=${formatEnvValue(config.NODE_ENV)}`,
    `DATA_DIR=${formatEnvValue(config.DATA_DIR)}`,
    `RESEND_API_KEY=${formatEnvValue(config.RESEND_API_KEY)}`,
    `BREVO_API_KEY=${formatEnvValue(config.BREVO_API_KEY)}`,
    `R2_ACCOUNT_ID=${formatEnvValue(config.R2_ACCOUNT_ID)}`,
    `R2_BUCKET_NAME=${formatEnvValue(config.R2_BUCKET_NAME)}`,
    `R2_ACCESS_KEY_ID=${formatEnvValue(config.R2_ACCESS_KEY_ID)}`,
    `R2_SECRET_ACCESS_KEY=${formatEnvValue(config.R2_SECRET_ACCESS_KEY)}`,
    `GDRIVE_CLIENT_ID=${formatEnvValue(config.GDRIVE_CLIENT_ID)}`,
    `GDRIVE_CLIENT_SECRET=${formatEnvValue(config.GDRIVE_CLIENT_SECRET)}`,
    `GDRIVE_REFRESH_TOKEN=${formatEnvValue(config.GDRIVE_REFRESH_TOKEN)}`,
    `GDRIVE_ROOT_FOLDER_ID=${formatEnvValue(config.GDRIVE_ROOT_FOLDER_ID)}`,
    `TURNSTILE_SITE_KEY=${formatEnvValue(config.TURNSTILE_SITE_KEY)}`,
    `TURNSTILE_SECRET_KEY=${formatEnvValue(config.TURNSTILE_SECRET_KEY)}`,
    ''
  ];
  return lines.join('\n');
}

async function initializeLocalDatabasesAndAdmin(targetDir, config) {
  const dataDir = path.resolve(targetDir, config.DATA_DIR || './data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const baseballDbPath = path.join(dataDir, 'baseball_charity.db');
  const chatDbPath = path.join(dataDir, 'pickup_chat.db');

  const baseballSqlite = new Database(baseballDbPath);
  const chatSqlite = new Database(chatDbPath);

  try {
    baseballSqlite.pragma('journal_mode = WAL');
    baseballSqlite.pragma('foreign_keys = ON');
    chatSqlite.pragma('journal_mode = WAL');
    chatSqlite.pragma('foreign_keys = ON');

    const baseballD1 = createD1Adapter(baseballSqlite);
    const chatD1 = createD1Adapter(chatSqlite);

    await ensureDualD1Schema({ BASEBALL_DB: baseballD1, CHAT_DB: chatD1 }, true, config);

    const adminEmail = (config.ADMIN_EMAIL || '').trim().toLowerCase();
    const adminName = (config.ADMIN_NAME || 'Community Admin').trim();
    if (adminEmail) {
      const existing = baseballSqlite.prepare('SELECT id, is_admin FROM users WHERE email = ?').get(adminEmail);
      if (!existing) {
        baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin) VALUES (?, ?, 'admin', 1)"
        ).run(adminName, adminEmail);
      } else {
        baseballSqlite.prepare(
          "UPDATE users SET name = COALESCE(NULLIF(?, ''), name), role = 'admin', is_admin = 1 WHERE id = ?"
        ).run(adminName, existing.id);
      }
    }
  } finally {
    try { baseballSqlite.close(); } catch (_) { /* best-effort close */ }
    try { chatSqlite.close(); } catch (_) { /* best-effort close */ }
  }

  return { baseballDbPath, chatDbPath };
}

async function runSetupWizard(argv = process.argv.slice(2)) {
  const opts = parseSetupArgs(argv);
  if (opts.help) {
    console.log([
      'Usage: npm run setup -- [options]',
      '',
      'Options:',
      '  --yes, -y                  Run non-interactively with defaults or provided flags',
      '  --dir=<path>               Target directory for .env, .dev.vars, and ./data',
      '  --preset=<preset>          generic-community (default) or pickup-baseball',
      '  --name=<name>              Community display name',
      '  --origin=<url>             Canonical HTTPS public origin (optional)',
      '  --lock-preview=<0|1>       Lock *.pages.dev preview origin (default: 0)',
      '  --admin-email=<email>      Initial Admin email address',
      '  --admin-name=<name>        Initial Admin display name',
      '  --from-email=<sender>      Outbound email From header',
      '  --mail-provider=<p>        mock | resend | brevo',
      '  --resend-api-key=<key>     Optional Resend API key',
      '  --storage-provider=<p>     local | r2 | gdrive',
      '  --rotate-secrets           Regenerate existing 256-bit secrets',
      '  --skip-db                  Skip local SQLite schema & Admin initialization'
    ].join('\n'));
    return;
  }

  const targetDir = opts.dir;
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const envPath = path.join(targetDir, '.env');
  const devVarsPath = path.join(targetDir, '.dev.vars');
  const existingEnv = {
    ...parseKeyValueFile(devVarsPath),
    ...parseKeyValueFile(envPath)
  };

  const isInteractive = !opts.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = isInteractive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;

  try {
    console.log('\n============================================================');
    console.log('🛠️  Community Starter Kit — Interactive Self-Host Setup');
    console.log(`   Target Directory: ${targetDir}`);
    console.log('============================================================\n');

    const rawPreset = opts.preset !== null
      ? opts.preset
      : await askQuestion(rl, '1. Community preset (generic-community | pickup-baseball)', existingEnv.COMMUNITY_PRESET || 'generic-community');
    const preset = String(rawPreset).trim().toLowerCase() === 'pickup-baseball'
      ? 'pickup-baseball'
      : 'generic-community';

    const defaultCommunityName = existingEnv.COMMUNITY_NAME || (preset === 'pickup-baseball' ? 'Sunday Pickup Baseball' : 'Community Hub');
    const communityName = opts.name !== null
      ? opts.name
      : await askQuestion(rl, '2. Community display name', defaultCommunityName);

    const publicOrigin = opts.origin !== null
      ? opts.origin
      : await askQuestion(rl, '3. Canonical public origin (leave blank for *.pages.dev)', existingEnv.PUBLIC_ORIGIN || '');

    const lockPreviewRaw = opts.lockPreview !== null
      ? opts.lockPreview
      : await askQuestion(rl, '4. Lock *.pages.dev preview origin to PUBLIC_ORIGIN? (0 or 1)', existingEnv.LOCK_PREVIEW_ORIGIN || '0');
    const lockPreview = String(lockPreviewRaw).trim() === '1' ? '1' : '0';

    const adminEmailRaw = opts.adminEmail !== null
      ? opts.adminEmail
      : await askQuestion(rl, '5. Initial Admin email address', existingEnv.ADMIN_EMAIL || 'admin@example.org');
    const adminEmail = String(adminEmailRaw).trim().toLowerCase();

    const adminName = opts.adminName !== null
      ? opts.adminName
      : await askQuestion(rl, '6. Initial Admin display name', existingEnv.ADMIN_NAME || 'Community Admin');

    const defaultFromEmail = existingEnv.FROM_EMAIL || `${communityName} <onboarding@resend.dev>`;
    const fromEmail = opts.fromEmail !== null
      ? opts.fromEmail
      : await askQuestion(rl, '7. Outbound From email address', defaultFromEmail);

    const replyToEmail = opts.replyToEmail !== null
      ? opts.replyToEmail
      : await askQuestion(rl, '8. Reply-To email address (optional)', existingEnv.REPLY_TO_EMAIL || adminEmail);

    const resendApiKey = opts.resendApiKey !== null
      ? opts.resendApiKey
      : await askQuestion(rl, '9. Resend API Key (optional, leave blank for local mock mail)', existingEnv.RESEND_API_KEY || '');

    const defaultMailProvider = opts.mailProvider
      || (resendApiKey ? 'resend' : (existingEnv.MAIL_PROVIDER || 'mock'));
    const mailProvider = String(defaultMailProvider).trim().toLowerCase();

    const storageProviderRaw = opts.storageProvider !== null
      ? opts.storageProvider
      : await askQuestion(rl, '10. Media storage provider (local | r2 | gdrive)', existingEnv.STORAGE_PROVIDER || 'local');
    const storageProvider = ['local', 'r2', 'gdrive'].includes(String(storageProviderRaw).trim().toLowerCase())
      ? String(storageProviderRaw).trim().toLowerCase()
      : 'local';

    const turnstileSiteKey = opts.turnstileSiteKey !== null
      ? opts.turnstileSiteKey
      : await askQuestion(rl, '11. Cloudflare Turnstile Site Key (optional)', existingEnv.TURNSTILE_SITE_KEY || '');
    const turnstileSecretKey = opts.turnstileSecretKey !== null
      ? opts.turnstileSecretKey
      : (turnstileSiteKey
        ? await askQuestion(rl, '12. Cloudflare Turnstile Secret Key (optional)', existingEnv.TURNSTILE_SECRET_KEY || '')
        : (existingEnv.TURNSTILE_SECRET_KEY || ''));

    const isBaseball = preset === 'pickup-baseball';
    const config = {
      COMMUNITY_PRESET: preset,
      COMMUNITY_NAME: communityName,
      PUBLIC_ORIGIN: publicOrigin,
      LOCK_PREVIEW_ORIGIN: lockPreview,
      HANDBOOK_URL: opts.handbookUrl !== null ? opts.handbookUrl : (existingEnv.HANDBOOK_URL || ''),
      ADMIN_EMAIL: adminEmail,
      ADMIN_NAME: adminName,
      FROM_EMAIL: fromEmail,
      REPLY_TO_EMAIL: replyToEmail,
      MAIL_PROVIDER: mailProvider,
      STORAGE_PROVIDER: storageProvider,
      FEATURE_BATTING_PRACTICE: existingEnv.FEATURE_BATTING_PRACTICE !== undefined ? existingEnv.FEATURE_BATTING_PRACTICE : (isBaseball ? '1' : '0'),
      FEATURE_CERTIFIED_SHIFTS: existingEnv.FEATURE_CERTIFIED_SHIFTS !== undefined ? existingEnv.FEATURE_CERTIFIED_SHIFTS : (isBaseball ? '1' : '0'),
      FEATURE_SUNDAY_PRIORITY: existingEnv.FEATURE_SUNDAY_PRIORITY !== undefined ? existingEnv.FEATURE_SUNDAY_PRIORITY : (isBaseball ? '1' : '0'),
      WAIVER_RETENTION_YEARS: existingEnv.WAIVER_RETENTION_YEARS || '3',
      PORT: existingEnv.PORT || '3000',
      NODE_ENV: existingEnv.NODE_ENV || 'development',
      DATA_DIR: existingEnv.DATA_DIR || './data',
      RESEND_API_KEY: resendApiKey,
      BREVO_API_KEY: existingEnv.BREVO_API_KEY || '',
      R2_ACCOUNT_ID: opts.r2AccountId !== null ? opts.r2AccountId : (existingEnv.R2_ACCOUNT_ID || ''),
      R2_BUCKET_NAME: opts.r2BucketName !== null ? opts.r2BucketName : (existingEnv.R2_BUCKET_NAME || ''),
      R2_ACCESS_KEY_ID: opts.r2AccessKeyId !== null ? opts.r2AccessKeyId : (existingEnv.R2_ACCESS_KEY_ID || ''),
      R2_SECRET_ACCESS_KEY: opts.r2SecretAccessKey !== null ? opts.r2SecretAccessKey : (existingEnv.R2_SECRET_ACCESS_KEY || ''),
      GDRIVE_CLIENT_ID: opts.gdriveClientId !== null ? opts.gdriveClientId : (existingEnv.GDRIVE_CLIENT_ID || ''),
      GDRIVE_CLIENT_SECRET: opts.gdriveClientSecret !== null ? opts.gdriveClientSecret : (existingEnv.GDRIVE_CLIENT_SECRET || ''),
      GDRIVE_REFRESH_TOKEN: opts.gdriveRefreshToken !== null ? opts.gdriveRefreshToken : (existingEnv.GDRIVE_REFRESH_TOKEN || ''),
      GDRIVE_ROOT_FOLDER_ID: opts.gdriveRootFolderId !== null ? opts.gdriveRootFolderId : (existingEnv.GDRIVE_ROOT_FOLDER_ID || ''),
      TURNSTILE_SITE_KEY: turnstileSiteKey,
      TURNSTILE_SECRET_KEY: turnstileSecretKey
    };

    for (const key of SECRET_KEYS) {
      const existingVal = existingEnv[key] ? String(existingEnv[key]).trim() : '';
      if (!opts.rotateSecrets && existingVal.length >= 32) {
        config[key] = existingVal;
      } else {
        config[key] = generateSecretHex();
      }
    }

    const rendered = renderEnvContent(config);
    fs.writeFileSync(envPath, rendered, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(devVarsPath, rendered, { encoding: 'utf8', mode: 0o600 });

    console.log(`✅ Wrote configuration and 256-bit secrets to ${envPath} and ${devVarsPath}`);

    if (!opts.skipDb) {
      const { baseballDbPath, chatDbPath } = await initializeLocalDatabasesAndAdmin(targetDir, config);
      console.log(`✅ Initialized local dual SQLite/D1 databases:\n   - ${baseballDbPath}\n   - ${chatDbPath}`);
      console.log(`✅ Bootstrapped initial Admin account: ${adminName} <${adminEmail}>`);
    }

    console.log('\n🎉 Self-host onboarding complete! Next steps:');
    console.log('   • Start local dev server: npm run dev');
    console.log('   • Read SELF_HOST.md for Cloudflare Pages & D1 deployment instructions.\n');
  } finally {
    if (rl) rl.close();
  }
}

if (require.main === module) {
  runSetupWizard().catch((err) => {
    console.error('❌ Setup failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  SECRET_KEYS,
  generateSecretHex,
  parseKeyValueFile,
  parseSetupArgs,
  renderEnvContent,
  initializeLocalDatabasesAndAdmin,
  runSetupWizard
};
