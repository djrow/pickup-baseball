/**
 * tests/helpers/crypto-test-utils.js
 * Native WebCrypto Test Utilities using globalThis.crypto.subtle (Node.js v22)
 *
 * Implements:
 * - ECDH P-256 keypair generation & JWK export
 * - ECDSA P-256 keypair generation & JWK export
 * - ECDH shared secret derivation (AES-GCM-256)
 * - AES-GCM-256 encrypt & decrypt with 12-byte IV
 * - PBKDF2 passphrase-based vault derivation (600,000 iterations)
 * - End-to-end private key vault encryption & recovery
 */

const { subtle } = globalThis.crypto;

// Helper: Uint8Array / ArrayBuffer <-> Base64
function arrayBufferToBase64(buffer) {
  if (ArrayBuffer.isView(buffer)) {
    return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).toString('base64');
  }
  return Buffer.from(buffer).toString('base64');
}

function base64ToArrayBuffer(b64) {
  const buf = Buffer.from(b64, 'base64');
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Generate ECDH P-256 and ECDSA P-256 keypairs for a member
 */
async function generateIdentityKeyPair() {
  const ecdhPair = await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );

  const ecdsaPair = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  const ecdhPublicJwk = await subtle.exportKey('jwk', ecdhPair.publicKey);
  const ecdhPrivateJwk = await subtle.exportKey('jwk', ecdhPair.privateKey);
  const ecdsaPublicJwk = await subtle.exportKey('jwk', ecdsaPair.publicKey);
  const ecdsaPrivateJwk = await subtle.exportKey('jwk', ecdsaPair.privateKey);

  return {
    ecdhPair,
    ecdsaPair,
    ecdhPublicJwk,
    ecdhPrivateJwk,
    ecdsaPublicJwk,
    ecdsaPrivateJwk
  };
}

/**
 * Import a public ECDH JWK
 */
async function importPublicEcdhJwk(jwk) {
  return subtle.importKey(
    'jwk',
    typeof jwk === 'string' ? JSON.parse(jwk) : jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

/**
 * Derive AES-GCM 256-bit key from sender's private key and recipient's public key via ECDH
 */
async function deriveEcdhSharedKey(privateKey, peerPublicKey) {
  return subtle.deriveKey(
    {
      name: 'ECDH',
      public: peerPublicKey
    },
    privateKey,
    {
      name: 'AES-GCM',
      length: 256
    },
    true,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
  );
}

/**
 * Generate a random AES-GCM 256-bit channel key
 */
async function generateChannelKey() {
  return subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt UTF-8 plaintext with an AES-GCM key
 * Returns { ciphertextB64, ivB64 }
 */
async function encryptPayload(aesKey, plaintext) {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);

  const enc = new TextEncoder();
  const data = enc.encode(plaintext);

  const cipherBuffer = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    data
  );

  return {
    ciphertextB64: arrayBufferToBase64(cipherBuffer),
    ivB64: arrayBufferToBase64(iv)
  };
}

/**
 * Decrypt Base64 ciphertext with an AES-GCM key and Base64 IV
 * Returns UTF-8 plaintext string
 */
async function decryptPayload(aesKey, ciphertextB64, ivB64) {
  const cipherBuffer = base64ToArrayBuffer(ciphertextB64);
  const iv = new Uint8Array(base64ToArrayBuffer(ivB64));

  const decryptedBuffer = await subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    cipherBuffer
  );

  const dec = new TextDecoder();
  return dec.decode(decryptedBuffer);
}

/**
 * Derive PBKDF2 encryption key from user passphrase and salt
 */
async function deriveVaultKey(passphrase, saltBytes, iterations = 600000) {
  const enc = new TextEncoder();
  const keyMaterial = await subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt private key vault with user passphrase
 * Returns { encryptedVaultB64, saltB64, ivB64 }
 */
async function encryptVault(passphrase, vaultData) {
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);

  const vaultKey = await deriveVaultKey(passphrase, salt);
  const serialized = JSON.stringify(vaultData);
  const { ciphertextB64, ivB64 } = await encryptPayload(vaultKey, serialized);

  return {
    encryptedVaultB64: ciphertextB64,
    saltB64: arrayBufferToBase64(salt),
    ivB64
  };
}

/**
 * Decrypt private key vault using passphrase, salt, and IV
 * Returns parsed vaultData object
 */
async function decryptVault(passphrase, encryptedVaultB64, saltB64, ivB64) {
  const salt = new Uint8Array(base64ToArrayBuffer(saltB64));
  const vaultKey = await deriveVaultKey(passphrase, salt);
  const decryptedJson = await decryptPayload(vaultKey, encryptedVaultB64, ivB64);
  return JSON.parse(decryptedJson);
}

/**
 * Wrap an AES-GCM channel key using an ECDH-derived wrapping key
 */
async function wrapChannelKey(channelKey, wrappingKey) {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);

  const wrappedBuffer = await subtle.wrapKey(
    'raw',
    channelKey,
    wrappingKey,
    { name: 'AES-GCM', iv }
  );

  return {
    wrappedKeyBase64: arrayBufferToBase64(wrappedBuffer),
    wrapIv: arrayBufferToBase64(iv)
  };
}

/**
 * Unwrap an AES-GCM channel key using an ECDH-derived wrapping key
 */
async function unwrapChannelKey(wrappedKeyBase64, wrappingKey, wrapIv) {
  const wrappedBuffer = base64ToArrayBuffer(wrappedKeyBase64);
  const iv = new Uint8Array(base64ToArrayBuffer(wrapIv));

  return subtle.unwrapKey(
    'raw',
    wrappedBuffer,
    wrappingKey,
    { name: 'AES-GCM', iv },
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

module.exports = {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  generateIdentityKeyPair,
  importPublicEcdhJwk,
  deriveEcdhSharedKey,
  generateChannelKey,
  encryptPayload,
  decryptPayload,
  deriveVaultKey,
  encryptVault,
  decryptVault,
  wrapChannelKey,
  unwrapChannelKey
};
