#!/usr/bin/env node
/**
 * Disaster-Recovery Backup Decryption CLI & Helper Module (ADR-0002 / Ticket #40).
 *
 * Decrypts `.pbfenc` (`pbf-dr-backup-v1`) AES-256-GCM envelopes exported by
 * `POST /api/events/admin/backup-db?db=baseball|chat`.
 *
 * Usage:
 *   node scripts/restore-backup.js --input baseball_dr_backup_2026-11-16.pbfenc --passphrase "<pass>" --output restored.sql
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_PBKDF2_ITERATIONS = 600000;
const MIN_PBKDF2_ITERATIONS = 100000;
const MAX_PBKDF2_ITERATIONS = 10000000;
const GCM_IV_BYTE_LENGTH = 12;
const GCM_TAG_BYTE_LENGTH = 16;
const AES_KEY_BYTE_LENGTH = 32;

function decodeBase64Strict(input, fieldName) {
  if (typeof input !== 'string') {
    throw new Error(`Invalid ${fieldName}: expected a base64 string.`);
  }
  const trimmed = input.trim();
  if (!trimmed || trimmed.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new Error(`Invalid ${fieldName}: malformed base64 encoding.`);
  }
  return Buffer.from(trimmed, 'base64');
}

/**
 * Derives a 256-bit (32-byte) AES-GCM wrapping key from a passphrase and salt
 * using PBKDF2-HMAC-SHA256.
 *
 * @param {string} passphrase
 * @param {string | Buffer | Uint8Array} salt
 * @param {number} [iterations=600000]
 * @returns {Buffer}
 */
function deriveBackupWrappingKey(passphrase, salt, iterations = DEFAULT_PBKDF2_ITERATIONS) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('Passphrase must be a non-empty string.');
  }
  let saltBytes;
  if (typeof salt === 'string') {
    saltBytes = decodeBase64Strict(salt, 'kdf.salt');
  } else if (Buffer.isBuffer(salt)) {
    saltBytes = salt;
  } else if (salt instanceof Uint8Array) {
    saltBytes = Buffer.from(salt.buffer, salt.byteOffset, salt.byteLength);
  } else {
    throw new Error('Invalid salt: expected base64 string, Buffer, or Uint8Array.');
  }

  if (saltBytes.byteLength < 16 || saltBytes.byteLength > 64) {
    throw new Error('Invalid kdf.salt length: expected between 16 and 64 bytes.');
  }

  const iterCount = Number(iterations);
  if (!Number.isInteger(iterCount) || iterCount < MIN_PBKDF2_ITERATIONS || iterCount > MAX_PBKDF2_ITERATIONS) {
    throw new Error(`Invalid PBKDF2 iterations: expected integer between ${MIN_PBKDF2_ITERATIONS} and ${MAX_PBKDF2_ITERATIONS}.`);
  }

  return crypto.pbkdf2Sync(
    Buffer.from(passphrase, 'utf8'),
    saltBytes,
    iterCount,
    AES_KEY_BYTE_LENGTH,
    'sha256'
  );
}

/**
 * Decrypts a `pbf-dr-backup-v1` JSON envelope using the provided passphrase
 * (or pre-derived 32-byte `wrappingKey`).
 *
 * @param {object | string | Buffer} envelopeOrJson
 * @param {string | { passphrase?: string, wrappingKey?: string | Buffer | Uint8Array }} passphraseOrOptions
 * @returns {string} Decrypted UTF-8 SQL dump
 */
function decryptDrBackupEnvelope(envelopeOrJson, passphraseOrOptions) {
  let envelope = envelopeOrJson;
  if (Buffer.isBuffer(envelopeOrJson)) {
    envelope = JSON.parse(envelopeOrJson.toString('utf8'));
  } else if (typeof envelopeOrJson === 'string') {
    envelope = JSON.parse(envelopeOrJson);
  }

  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Invalid DR backup envelope: expected JSON object.');
  }
  if (envelope.format !== 'pbf-dr-backup-v1') {
    throw new Error(`Unsupported DR backup format: "${envelope.format}". Expected "pbf-dr-backup-v1".`);
  }
  if (envelope.cipher !== 'AES-256-GCM') {
    throw new Error(`Unsupported DR backup cipher: "${envelope.cipher}". Expected "AES-256-GCM".`);
  }
  if (!envelope.kdf || typeof envelope.kdf !== 'object') {
    throw new Error('Invalid DR backup envelope: missing kdf metadata.');
  }
  if (envelope.kdf.algorithm !== 'PBKDF2' || envelope.kdf.hash !== 'SHA-256') {
    throw new Error('Unsupported DR backup KDF: expected PBKDF2 with SHA-256.');
  }

  const ivBytes = decodeBase64Strict(envelope.iv, 'iv');
  if (ivBytes.byteLength !== GCM_IV_BYTE_LENGTH) {
    throw new Error(`Invalid DR backup IV length: expected ${GCM_IV_BYTE_LENGTH} bytes.`);
  }

  const cipherAndTagBytes = decodeBase64Strict(envelope.ciphertext, 'ciphertext');
  if (cipherAndTagBytes.byteLength <= GCM_TAG_BYTE_LENGTH) {
    throw new Error('Invalid DR backup ciphertext: payload is shorter than GCM authentication tag.');
  }

  let keyBytes = null;
  if (typeof passphraseOrOptions === 'string') {
    keyBytes = deriveBackupWrappingKey(passphraseOrOptions, envelope.kdf.salt, envelope.kdf.iterations);
  } else if (passphraseOrOptions && typeof passphraseOrOptions === 'object') {
    if (passphraseOrOptions.wrappingKey) {
      const wk = passphraseOrOptions.wrappingKey;
      if (typeof wk === 'string') {
        keyBytes = decodeBase64Strict(wk, 'wrappingKey');
      } else if (Buffer.isBuffer(wk)) {
        keyBytes = Buffer.from(wk);
      } else if (wk instanceof Uint8Array) {
        keyBytes = Buffer.from(wk.buffer, wk.byteOffset, wk.byteLength);
      }
    } else if (typeof passphraseOrOptions.passphrase === 'string') {
      keyBytes = deriveBackupWrappingKey(passphraseOrOptions.passphrase, envelope.kdf.salt, envelope.kdf.iterations);
    }
  }

  if (!keyBytes || keyBytes.byteLength !== AES_KEY_BYTE_LENGTH) {
    throw new Error('A valid passphrase or 256-bit wrappingKey is required to decrypt the backup.');
  }

  const ciphertextBody = cipherAndTagBytes.subarray(0, cipherAndTagBytes.byteLength - GCM_TAG_BYTE_LENGTH);
  const authTag = cipherAndTagBytes.subarray(cipherAndTagBytes.byteLength - GCM_TAG_BYTE_LENGTH);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, ivBytes, {
      authTagLength: GCM_TAG_BYTE_LENGTH
    });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertextBody), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('Failed to decrypt DR backup: wrong passphrase or tampered ciphertext.');
  } finally {
    keyBytes.fill(0);
  }
}

function parseCliArgs(argv) {
  const parsed = { input: '', passphrase: '', output: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] || '');
    if ((arg === '--input' || arg === '-i') && i + 1 < argv.length) {
      parsed.input = String(argv[++i]);
    } else if (arg.startsWith('--input=')) {
      parsed.input = arg.slice('--input='.length);
    } else if ((arg === '--passphrase' || arg === '-p') && i + 1 < argv.length) {
      parsed.passphrase = String(argv[++i]);
    } else if (arg.startsWith('--passphrase=')) {
      parsed.passphrase = arg.slice('--passphrase='.length);
    } else if ((arg === '--output' || arg === '-o') && i + 1 < argv.length) {
      parsed.output = String(argv[++i]);
    } else if (arg.startsWith('--output=')) {
      parsed.output = arg.slice('--output='.length);
    }
  }
  return parsed;
}

/**
 * Runs the DR backup restore CLI workflow.
 *
 * @param {string[]} [argv=process.argv.slice(2)]
 * @param {{ writeStdout?: boolean }} [options]
 * @returns {string} Decrypted SQL text
 */
function runRestoreCli(argv = process.argv.slice(2), options = {}) {
  const args = parseCliArgs(argv);
  const passphrase = args.passphrase || process.env.PBF_BACKUP_PASSPHRASE || '';
  if (!args.input) {
    throw new Error('Usage: node scripts/restore-backup.js --input <file.pbfenc> --passphrase <pass> [--output <restored.sql>]');
  }
  if (!passphrase) {
    throw new Error('Missing passphrase. Pass --passphrase <pass> or set PBF_BACKUP_PASSPHRASE.');
  }

  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Backup input file not found: ${inputPath}`);
  }

  const rawJson = fs.readFileSync(inputPath, 'utf8');
  const sql = decryptDrBackupEnvelope(rawJson, passphrase);

  if (args.output) {
    const outputPath = path.resolve(args.output);
    fs.writeFileSync(outputPath, sql, { encoding: 'utf8', mode: 0o600 });
  } else if (options.writeStdout) {
    process.stdout.write(sql);
  }

  return sql;
}

if (require.main === module) {
  try {
    runRestoreCli(process.argv.slice(2), { writeStdout: true });
  } catch (err) {
    console.error(`[restore-backup] Error: ${err && err.message ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

module.exports = {
   DEFAULT_PBKDF2_ITERATIONS,
  deriveBackupWrappingKey,
  decryptDrBackupEnvelope,
  runRestoreCli
};
