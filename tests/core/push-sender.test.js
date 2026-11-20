const test = require('node:test');
const assert = require('node:assert/strict');
const sender = import('../../src/app/push-sender.js');

const b64u = (u) => Buffer.from(u).toString('base64url');
const enc = new TextEncoder();
async function hk(ikm, salt, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

test('encryptPayload produces an RFC 8291 aes128gcm body the subscriber can decrypt', async () => {
  const { encryptPayload } = await sender;
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const body = await encryptPayload(b64u(uaPub), b64u(auth), 'hello ??');
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPub = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const peer = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, ua.privateKey, 256));
  const prk = await hk(shared, auth, Buffer.concat([enc.encode('WebPush: info\0'), uaPub, asPub]), 32);
  const cek = await hk(prk, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(prk, salt, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, ct));
  assert.equal(new TextDecoder().decode(pt.slice(0, -1)), 'hello ??');
  assert.equal(pt[pt.length - 1], 2);
});

test('isQuietNow honors wrap-around windows and timezones', async () => {
  const { isQuietNow } = await sender;
  const now = new Date('2026-01-01T23:30:00Z');
  const base = { quiet_enabled: 1, quiet_start: '22:00', quiet_end: '07:00' };
  assert.equal(isQuietNow({ ...base, quiet_tz: 'UTC' }, now), true);
  assert.equal(isQuietNow({ ...base, quiet_enabled: 0, quiet_tz: 'UTC' }, now), false);
  assert.equal(isQuietNow({ ...base, quiet_tz: 'Asia/Tokyo' }, now), false);
});
