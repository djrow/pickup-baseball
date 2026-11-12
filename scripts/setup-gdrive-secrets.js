#!/usr/bin/env node
/**
 * Interactive helper to set the 4 Google Drive Media Engine secrets
 * on Cloudflare Pages (--project-name pickup-baseball) without PowerShell
 * multi-line paste issues.
 *
 * Usage:
 *   npm run setup:gdrive
 */

const readline = require('node:readline');
const { spawnSync } = require('node:child_process');

const PROJECT_NAME = 'pickup-baseball';
const SECRETS = [
  {
    key: 'GDRIVE_CLIENT_ID',
    prompt: '1/4 Enter GDRIVE_CLIENT_ID (e.g. 123456-abc.apps.googleusercontent.com): '
  },
  {
    key: 'GDRIVE_CLIENT_SECRET',
    prompt: '2/4 Enter GDRIVE_CLIENT_SECRET (e.g. GOCSPX-...): '
  },
  {
    key: 'GDRIVE_REFRESH_TOKEN',
    prompt: '3/4 Enter GDRIVE_REFRESH_TOKEN (e.g. 1//04...): '
  },
  {
    key: 'GDRIVE_ROOT_FOLDER_ID',
    prompt: '4/4 Enter GDRIVE_ROOT_FOLDER_ID (Folder ID from your Google Drive URL): '
  }
];

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans.trim())));
}

async function main() {
  console.log('\n============================================================');
  console.log('⚾ Pickup Baseball Clubhouse — 5 TB Google Drive Secret Setup');
  console.log(`   Target Cloudflare Pages Project: ${PROJECT_NAME}`);
  console.log('============================================================\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const values = {};
  for (const item of SECRETS) {
    const val = await ask(rl, item.prompt);
    if (!val) {
      console.log(`\n⚠️  Skipped ${item.key} (empty value).`);
      continue;
    }
    values[item.key] = val;
  }

  rl.close();

  const keys = Object.keys(values);
  if (keys.length === 0) {
    console.log('\nNo secrets entered. Exiting without changes.');
    process.exit(0);
  }

  console.log('\nUploading secrets to Cloudflare Pages...');
  for (const key of keys) {
    console.log(`\n-> Setting ${key} on project "${PROJECT_NAME}"...`);
    const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const result = spawnSync(
      cmd,
      ['wrangler', 'pages', 'secret', 'put', key, '--project-name', PROJECT_NAME],
      {
        input: values[key] + '\n',
        stdio: ['pipe', 'inherit', 'inherit'],
        encoding: 'utf-8',
        shell: process.platform === 'win32'
      }
    );

    if (result.status !== 0) {
      console.error(`❌ Failed to set ${key} (exit code ${result.status}).`);
      process.exit(result.status || 1);
    }
  }

  console.log('\n✅ All provided Google Drive secrets have been uploaded to Cloudflare Pages!');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
