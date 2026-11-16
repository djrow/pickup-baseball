/**
 * @fileoverview Pickup Baseball Clubhouse — Zero-Knowledge Client-Side Cryptography Engine (WP-5).
 * Uses native Web Crypto API (`window.crypto.subtle`):
 * - Identity & Key Agreement: ECDH (P-256) + ECDSA (P-256)
 * - Message & Media Payload Encryption: AES-GCM-256 (96-bit random IV, 128-bit auth tag)
 * - Multi-Device Key Backup Vault: PBKDF2-SHA256 (600,000 iterations) -> AES-GCM-256
 * - Client-Side Privacy Guard: Binary JPEG EXIF/GPS Metadata Stripper (APP1..APP15, COM)
 *
 * TABLE OF CONTENTS:
 * 1. Base64 / UTF-8 / Indexing Utilities
 * 2. ECDH P-256 Identity Generation, Wrap/Unwrap & Safety Number Fingerprints
 * 3. Channel AES-GCM-256 Encryption / Decryption (Text & Binary Attachments)
 * 4. PBKDF2-SHA256 Multi-Device Recovery Vault & Peer Verification Store
 * 5. Client-Side JPEG EXIF/GPS Metadata Stripper
 *
 * @global ClubhouseCrypto
 */
(function (root) {
  'use strict';

  var CRYPTO_DB_NAME = 'pickup_clubhouse_crypto';
  var CRYPTO_DB_VERSION = 1;
  var KEY_STORE_NAME = 'keystore';
  var PIN_DB_NAME = 'pickup_clubhouse_pins';
  var PIN_DB_VERSION = 1;
  var PIN_STORE_NAME = 'pins';
  var PBKDF2_ITERATIONS = 600000;

  var subtle = (root.crypto && root.crypto.subtle) ? root.crypto.subtle : null;
  var memoryKeyStore = {};
  var memoryPinStore = {};

  function getRandomBytes(length) {
    if (!root.crypto || typeof root.crypto.getRandomValues !== 'function') {
      throw new Error('Cryptographically secure randomness is unavailable in this environment.');
    }
    var arr = new Uint8Array(length);
    root.crypto.getRandomValues(arr);
    return arr;
  }

  function arrayBufferToBase64(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var chunkSize = 0x8000;
    var binary = '';
    for (var i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToUint8Array(b64) {
    var binStr = atob(String(b64 || ''));
    var bytes = new Uint8Array(binStr.length);
    for (var i = 0; i < binStr.length; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Client-side JPEG EXIF / GPS / Comment segment stripper.
   * Removes APP1..APP15 (0xFFE1..0xFFEF) and COM (0xFFFE) segments before upload.
   */
  function stripJpegMetadata(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
      return buffer;
    }
    var chunks = [bytes.slice(0, 2)];
    var pos = 2;
    while (pos + 4 <= bytes.length) {
      if (bytes[pos] !== 0xFF) {
        chunks.push(bytes.slice(pos));
        break;
      }
      var marker = bytes[pos + 1];
      if (marker === 0xDA || marker === 0xD9) {
        chunks.push(bytes.slice(pos));
        break;
      }
      var segLen = (bytes[pos + 2] << 8) | bytes[pos + 3];
      if (segLen < 2 || pos + 2 + segLen > bytes.length) {
        chunks.push(bytes.slice(pos));
        break;
      }
      var isExifOrComment = (marker >= 0xE1 && marker <= 0xEF) || marker === 0xFE;
      if (!isExifOrComment) {
        chunks.push(bytes.slice(pos, pos + 2 + segLen));
      }
      pos += 2 + segLen;
    }
    var totalLen = 0;
    for (var i = 0; i < chunks.length; i++) {
      totalLen += chunks[i].length;
    }
    var out = new Uint8Array(totalLen);
    var offset = 0;
    for (var j = 0; j < chunks.length; j++) {
      out.set(chunks[j], offset);
      offset += chunks[j].length;
    }
    return out.buffer;
  }

  /**
   * Open IndexedDB keystore (falls back to in-memory map in headless/private environments).
   */
  var cachedKeyDbPromise = null;
  var openKeyDbInstance = null;

  function closeKeyDbHandle() {
    if (openKeyDbInstance) {
      try { openKeyDbInstance.close(); } catch (e) { /* best-effort IDB handle close */ }
      openKeyDbInstance = null;
    }
    cachedKeyDbPromise = null;
  }

  if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
    try {
      var keyClearChannel = new BroadcastChannel('pickup_clubhouse_clear');
      if (typeof keyClearChannel.unref === 'function') {
        keyClearChannel.unref();
      }
      keyClearChannel.addEventListener('message', function (ev) {
        if (ev && ev.data && ev.data.type === 'clear') {
          memoryKeyStore = {};
          closeKeyDbHandle();
        }
      });
    } catch (e) { /* BroadcastChannel unavailable */ }
  }

  function openKeyDb() {
    if (cachedKeyDbPromise) return cachedKeyDbPromise;
    cachedKeyDbPromise = new Promise(function (resolve) {
      if (!root.indexedDB) {
        resolve(null);
        return;
      }
      try {
        var req = root.indexedDB.open(CRYPTO_DB_NAME, CRYPTO_DB_VERSION);
        req.onupgradeneeded = function (ev) {
          var db = ev.target.result;
          if (!db.objectStoreNames.contains(KEY_STORE_NAME)) {
            db.createObjectStore(KEY_STORE_NAME);
          }
        };
        req.onsuccess = function (ev) {
          var db = ev.target.result;
          openKeyDbInstance = db;
          db.onversionchange = function () {
            try { db.close(); } catch (e) { /* best-effort close on versionchange */ }
            if (openKeyDbInstance === db) openKeyDbInstance = null;
            cachedKeyDbPromise = null;
          };
          db.onclose = function () {
            if (openKeyDbInstance === db) openKeyDbInstance = null;
            cachedKeyDbPromise = null;
          };
          resolve(db);
        };
        req.onerror = function () {
          cachedKeyDbPromise = null;
          resolve(null);
        };
        req.onblocked = function () {
          cachedKeyDbPromise = null;
          resolve(null);
        };
      } catch (e) {
        cachedKeyDbPromise = null;
        resolve(null);
      }
    });
    return cachedKeyDbPromise;
  }

  function idbGet(key) {
    return openKeyDb().then(function (db) {
      if (!db) {
        return memoryKeyStore[key] !== undefined ? memoryKeyStore[key] : null;
      }
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction([KEY_STORE_NAME], 'readonly');
          var store = tx.objectStore(KEY_STORE_NAME);
          var req = store.get(key);
          req.onsuccess = function () {
            resolve(req.result !== undefined ? req.result : null);
          };
          req.onerror = function () {
            resolve(memoryKeyStore[key] !== undefined ? memoryKeyStore[key] : null);
          };
        } catch (e) {
          resolve(memoryKeyStore[key] !== undefined ? memoryKeyStore[key] : null);
        }
      });
    });
  }

  function idbPut(key, value) {
    memoryKeyStore[key] = value;
    return openKeyDb().then(function (db) {
      if (!db) return true;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction([KEY_STORE_NAME], 'readwrite');
          var store = tx.objectStore(KEY_STORE_NAME);
          var req = store.put(value, key);
          req.onsuccess = function () { resolve(true); };
          req.onerror = function () { resolve(false); };
        } catch (e) {
          resolve(false);
        }
      });
    });
  }

  function idbDelete(key) {
    delete memoryKeyStore[key];
    return openKeyDb().then(function (db) {
      if (!db) return true;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction([KEY_STORE_NAME], 'readwrite');
          var store = tx.objectStore(KEY_STORE_NAME);
          var req = store.delete(key);
          req.onsuccess = function () { resolve(true); };
          req.onerror = function () { resolve(false); };
        } catch (e) {
          resolve(false);
        }
      });
    });
  }

  function idbDeleteByPrefix(prefix) {
    var pfx = String(prefix || '');
    if (!pfx) return Promise.resolve(true);
    var memKeys = Object.keys(memoryKeyStore);
    for (var i = 0; i < memKeys.length; i++) {
      if (memKeys[i].indexOf(pfx) === 0) {
        delete memoryKeyStore[memKeys[i]];
      }
    }
    return openKeyDb().then(function (db) {
      if (!db) return true;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction([KEY_STORE_NAME], 'readwrite');
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
          tx.onabort = function () { resolve(false); };
          var store = tx.objectStore(KEY_STORE_NAME);
          var req = store.openCursor();
          req.onsuccess = function (ev) {
            var cursor = ev.target.result;
            if (!cursor) return;
            if (cursor.key !== undefined && String(cursor.key).indexOf(pfx) === 0) {
              cursor.delete();
            }
            cursor.continue();
          };
          req.onerror = function () { resolve(false); };
        } catch (e) {
          resolve(false);
        }
      });
    });
  }

  var cachedPinDbPromise = null;

  function openPinDb() {
    if (cachedPinDbPromise) return cachedPinDbPromise;
    cachedPinDbPromise = new Promise(function (resolve) {
      if (!root.indexedDB) {
        resolve(null);
        return;
      }
      try {
        var req = root.indexedDB.open(PIN_DB_NAME, PIN_DB_VERSION);
        req.onupgradeneeded = function (ev) {
          var db = ev.target.result;
          if (!db.objectStoreNames.contains(PIN_STORE_NAME)) {
            db.createObjectStore(PIN_STORE_NAME);
          }
        };
        req.onsuccess = function (ev) {
          var db = ev.target.result;
          db.onversionchange = function () {
            try { db.close(); } catch (e) { /* best-effort close on versionchange */ }
            cachedPinDbPromise = null;
          };
          db.onclose = function () {
            cachedPinDbPromise = null;
          };
          resolve(db);
        };
        req.onerror = function () {
          cachedPinDbPromise = null;
          resolve(null);
        };
        req.onblocked = function () {
          cachedPinDbPromise = null;
          resolve(null);
        };
      } catch (e) {
        cachedPinDbPromise = null;
        resolve(null);
      }
    });
    return cachedPinDbPromise;
  }

  function pinDbGet(key) {
    return openPinDb().then(function (db) {
      if (!db) {
        return memoryPinStore[key] !== undefined ? memoryPinStore[key] : null;
      }
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction([PIN_STORE_NAME], 'readonly');
          var store = tx.objectStore(PIN_STORE_NAME);
          var req = store.get(key);
          req.onsuccess = function () {
            resolve(req.result !== undefined ? req.result : null);
          };
          req.onerror = function () {
            resolve(memoryPinStore[key] !== undefined ? memoryPinStore[key] : null);
          };
        } catch (e) {
          resolve(memoryPinStore[key] !== undefined ? memoryPinStore[key] : null);
        }
      });
    });
  }

  function pinDbPut(key, value) {
    memoryPinStore[key] = value;
    return openPinDb().then(function (db) {
      if (!db) return true;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction([PIN_STORE_NAME], 'readwrite');
          var store = tx.objectStore(PIN_STORE_NAME);
          var req = store.put(value, key);
          req.onsuccess = function () { resolve(true); };
          req.onerror = function () { resolve(false); };
        } catch (e) {
          resolve(false);
        }
      });
    });
  }

  function pinDbDelete(key) {
    delete memoryPinStore[key];
    return openPinDb().then(function (db) {
      if (!db) return true;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction([PIN_STORE_NAME], 'readwrite');
          var store = tx.objectStore(PIN_STORE_NAME);
          var req = store.delete(key);
          req.onsuccess = function () { resolve(true); };
          req.onerror = function () { resolve(false); };
        } catch (e) {
          resolve(false);
        }
      });
    });
  }

  /**
   * Generate ECDH P-256 and ECDSA P-256 identity keypairs.
   * Stores non-extractable private keys in IndexedDB while returning JWK exports for vault backup.
   */
  function generateIdentityKeyPair() {
    var ecdhExportable;
    var ecdsaExportable;
    var ecdhPublicJwk;
    var ecdhPrivateJwk;
    var ecdsaPublicJwk;
    var ecdsaPrivateJwk;
    var nonExtractableEcdhPriv;
    var nonExtractableEcdsaPriv;

    return subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    ).then(function (pair1) {
      ecdhExportable = pair1;
      return subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
      );
    }).then(function (pair2) {
      ecdsaExportable = pair2;
      return Promise.all([
        subtle.exportKey('jwk', ecdhExportable.publicKey),
        subtle.exportKey('jwk', ecdhExportable.privateKey),
        subtle.exportKey('jwk', ecdsaExportable.publicKey),
        subtle.exportKey('jwk', ecdsaExportable.privateKey)
      ]);
    }).then(function (jwks) {
      ecdhPublicJwk = jwks[0];
      ecdhPrivateJwk = jwks[1];
      ecdsaPublicJwk = jwks[2];
      ecdsaPrivateJwk = jwks[3];

      // Re-import private keys with extractable: false for IndexedDB storage
      return Promise.all([
        subtle.importKey(
          'jwk',
          ecdhPrivateJwk,
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          ['deriveKey', 'deriveBits']
        ),
        subtle.importKey(
          'jwk',
          ecdsaPrivateJwk,
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['sign']
        )
      ]);
    }).then(function (nonExtKeys) {
      nonExtractableEcdhPriv = nonExtKeys[0];
      nonExtractableEcdsaPriv = nonExtKeys[1];
      return Promise.all([
        idbPut('identity_ecdh_private', nonExtractableEcdhPriv),
        idbPut('identity_ecdsa_private', nonExtractableEcdsaPriv),
        idbPut('identity_ecdh_public_jwk', ecdhPublicJwk),
        idbPut('identity_ecdsa_public_jwk', ecdsaPublicJwk)
      ]);
    }).then(function () {
      return {
        ecdhPublicJwk: ecdhPublicJwk,
        ecdhPrivateJwk: ecdhPrivateJwk,
        ecdsaPublicJwk: ecdsaPublicJwk,
        ecdsaPrivateJwk: ecdsaPrivateJwk,
        ecdhPrivateKey: nonExtractableEcdhPriv,
        ecdsaPrivateKey: nonExtractableEcdsaPriv
      };
    });
  }

  /**
   * Derive a 256-bit AES-GCM vault wrapping key from a user passphrase using PBKDF2-SHA256 (600,000 iterations).
   */
  function deriveVaultKeyFromPassphrase(passphrase, saltBytes) {
    var enc = new TextEncoder();
    return subtle.importKey(
      'raw',
      enc.encode(String(passphrase || '')),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    ).then(function (baseKey) {
      return subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: saltBytes,
          iterations: PBKDF2_ITERATIONS,
          hash: 'SHA-256'
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    });
  }

  /**
   * Encrypt private JWK bundle into a zero-knowledge passphrase-protected backup vault.
   */
  function encryptVault(passphrase, privatePayloadObj) {
    var salt = getRandomBytes(16);
    var iv = getRandomBytes(12);
    var enc = new TextEncoder();
    var plaintextBytes = enc.encode(JSON.stringify(privatePayloadObj));

    return deriveVaultKeyFromPassphrase(passphrase, salt).then(function (vaultKey) {
      return subtle.encrypt(
        { name: 'AES-GCM', iv: iv, tagLength: 128 },
        vaultKey,
        plaintextBytes
      );
    }).then(function (cipherBuf) {
      return {
        encryptedVaultB64: arrayBufferToBase64(cipherBuf),
        saltB64: arrayBufferToBase64(salt),
        ivB64: arrayBufferToBase64(iv)
      };
    });
  }

  /**
   * Decrypt private JWK bundle from backup vault and import non-extractable keys into IndexedDB.
   */
  function decryptVault(passphrase, encryptedVaultB64, saltB64, ivB64) {
    var salt = base64ToUint8Array(saltB64);
    var iv = base64ToUint8Array(ivB64);
    var cipherBytes = base64ToUint8Array(encryptedVaultB64);

    return deriveVaultKeyFromPassphrase(passphrase, salt).then(function (vaultKey) {
      return subtle.decrypt(
        { name: 'AES-GCM', iv: iv, tagLength: 128 },
        vaultKey,
        cipherBytes
      );
    }).then(function (plainBuf) {
      var dec = new TextDecoder();
      var parsed = JSON.parse(dec.decode(plainBuf));
      var promises = [];
      if (parsed.ecdhPriv) {
        promises.push(
          subtle.importKey(
            'jwk',
            parsed.ecdhPriv,
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            ['deriveKey', 'deriveBits']
          ).then(function (k) {
            return idbPut('identity_ecdh_private', k);
          })
        );
      }
      if (parsed.ecdsaPriv) {
        promises.push(
          subtle.importKey(
            'jwk',
            parsed.ecdsaPriv,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['sign']
          ).then(function (k) {
            return idbPut('identity_ecdsa_private', k);
          })
        );
      }
      if (parsed.ecdhPub) {
        promises.push(idbPut('identity_ecdh_public_jwk', parsed.ecdhPub));
      }
      if (parsed.ecdsaPub) {
        promises.push(idbPut('identity_ecdsa_public_jwk', parsed.ecdsaPub));
      }
      return Promise.all(promises).then(function () {
        return parsed;
      });
    });
  }

  /**
   * Generate a random 256-bit AES-GCM symmetric key for a channel epoch.
   */
  function generateChannelKey() {
    return subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Derive an ECDH shared AES-GCM-256 wrapping key between local private key and peer public JWK.
   */
  function deriveEcdhSharedKey(privateKey, peerPublicJwkOrKey) {
    var pubKeyPromise = (peerPublicJwkOrKey && peerPublicJwkOrKey.kty)
      ? subtle.importKey('jwk', peerPublicJwkOrKey, { name: 'ECDH', namedCurve: 'P-256' }, true, [])
      : Promise.resolve(peerPublicJwkOrKey);

    return pubKeyPromise.then(function (peerPubKey) {
      return subtle.deriveKey(
        { name: 'ECDH', public: peerPubKey },
        privateKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    });
  }

  /**
   * Wrap a channel AES-GCM-256 key using a pairwise ECDH shared key.
   */
  function wrapChannelKey(channelKey, sharedWrappingKey) {
    var iv = getRandomBytes(12);
    return subtle.exportKey('raw', channelKey).then(function (rawKeyBuf) {
      return subtle.encrypt(
        { name: 'AES-GCM', iv: iv, tagLength: 128 },
        sharedWrappingKey,
        rawKeyBuf
      );
    }).then(function (cipherBuf) {
      return {
        wrappedKeyBase64: arrayBufferToBase64(cipherBuf),
        wrapIv: arrayBufferToBase64(iv)
      };
    });
  }

  /**
   * Unwrap a channel AES-GCM-256 key using a pairwise ECDH shared key.
   */
  function unwrapChannelKey(wrappedKeyBase64, sharedWrappingKey, wrapIvBase64, extractable) {
    var cipherBytes = base64ToUint8Array(wrappedKeyBase64);
    var iv = base64ToUint8Array(wrapIvBase64);
    var isExt = extractable !== undefined ? Boolean(extractable) : false;

    return subtle.decrypt(
      { name: 'AES-GCM', iv: iv, tagLength: 128 },
      sharedWrappingKey,
      cipherBytes
    ).then(function (rawKeyBuf) {
      return subtle.importKey(
        'raw',
        rawKeyBuf,
        { name: 'AES-GCM', length: 256 },
        isExt,
        ['encrypt', 'decrypt']
      );
    });
  }

  /**
   * Encrypt a UTF-8 message string with AES-GCM-256.
   */
  function encryptPayload(channelKey, plaintext) {
    var iv = getRandomBytes(12);
    var enc = new TextEncoder();
    var data = enc.encode(String(plaintext || ''));

    return subtle.encrypt(
      { name: 'AES-GCM', iv: iv, tagLength: 128 },
      channelKey,
      data
    ).then(function (cipherBuf) {
      return {
        ciphertextB64: arrayBufferToBase64(cipherBuf),
        ivB64: arrayBufferToBase64(iv)
      };
    });
  }

  /**
   * Decrypt a base64 AES-GCM-256 message payload back to UTF-8 string.
   */
  function decryptPayload(channelKey, ciphertextB64, ivB64) {
    var cipherBytes = base64ToUint8Array(ciphertextB64);
    var iv = base64ToUint8Array(ivB64);

    return subtle.decrypt(
      { name: 'AES-GCM', iv: iv, tagLength: 128 },
      channelKey,
      cipherBytes
    ).then(function (plainBuf) {
      var dec = new TextDecoder();
      return dec.decode(plainBuf);
    });
  }

  /**
   * Encrypt binary attachment ArrayBuffer with AES-GCM-256.
   */
  function encryptBinaryBuffer(channelKey, arrayBuffer) {
    var iv = getRandomBytes(12);
    var bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    return subtle.encrypt(
      { name: 'AES-GCM', iv: iv, tagLength: 128 },
      channelKey,
      bytes
    ).then(function (cipherBuf) {
      return {
        encryptedBuffer: cipherBuf,
        ivB64: arrayBufferToBase64(iv)
      };
    });
  }

  /**
   * Decrypt binary attachment ArrayBuffer with AES-GCM-256.
   */
  function decryptBinaryBuffer(channelKey, cipherBuffer, ivB64) {
    var iv = base64ToUint8Array(ivB64);
    var bytes = cipherBuffer instanceof Uint8Array ? cipherBuffer : new Uint8Array(cipherBuffer);
    return subtle.decrypt(
      { name: 'AES-GCM', iv: iv, tagLength: 128 },
      channelKey,
      bytes
    );
  }

  /**
   * Enroll identity keys on the server (/api/keys/identity) with passphrase vault backup.
   */
  function enrollIdentityWithPassphrase(passphrase, privacyRelayMode) {
    var generated;
    return generateIdentityKeyPair().then(function (keys) {
      generated = keys;
      return encryptVault(passphrase, {
        ecdhPriv: keys.ecdhPrivateJwk,
        ecdsaPriv: keys.ecdsaPrivateJwk,
        ecdhPub: keys.ecdhPublicJwk,
        ecdsaPub: keys.ecdsaPublicJwk
      });
    }).then(function (vault) {
      return fetch('/api/keys/identity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          ecdh_public_key_jwk: JSON.stringify(generated.ecdhPublicJwk),
          ecdsa_public_key_jwk: JSON.stringify(generated.ecdsaPublicJwk),
          encrypted_private_vault: vault.encryptedVaultB64,
          vault_salt: vault.saltB64,
          vault_iv: vault.ivB64,
          privacy_relay_mode: privacyRelayMode ? 1 : 0
        })
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) {
            throw new Error((data && data.error) || 'Failed to upload E2EE identity keys');
          }
          return {
            success: true,
            ecdhPublicJwk: generated.ecdhPublicJwk,
            ecdsaPublicJwk: generated.ecdsaPublicJwk
          };
        });
      });
    });
  }

  /**
   * Restore identity private keys from server vault (/api/keys/vault) using user passphrase.
   */
  function restoreIdentityFromServerVault(passphrase) {
    return fetch('/api/keys/vault', {
      method: 'GET',
      credentials: 'same-origin'
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          throw new Error((data && data.error) || 'No encrypted key vault found on server');
        }
        return decryptVault(
          passphrase,
          data.encryptedPrivateVault || data.encrypted_private_vault,
          data.vaultSalt || data.vault_salt,
          data.vaultIv || data.vault_iv
        );
      });
    });
  }

  /**
   * Check whether local device has initialized E2EE identity keys in IndexedDB.
   */
  function hasLocalIdentityKeys() {
    return Promise.all([
      idbGet('identity_ecdh_private'),
      idbGet('identity_ecdh_public_jwk')
    ]).then(function (res) {
      return Boolean(res[0] && res[1]);
    });
  }

  /**
   * Retrieve locally stored identity keys from IndexedDB.
   */
  function getStoredIdentityKeys() {
    return Promise.all([
      idbGet('identity_ecdh_private'),
      idbGet('identity_ecdh_public_jwk'),
      idbGet('identity_ecdsa_private'),
      idbGet('identity_ecdsa_public_jwk')
    ]).then(function (res) {
      if (!res[0] || !res[1]) return null;
      return {
        ecdhPrivateKey: res[0],
        ecdhPublicJwk: res[1],
        ecdsaPrivateKey: res[2] || null,
        ecdsaPublicJwk: res[3] || null
      };
    });
  }

  /**
   * Re-import an extractable AES-GCM-256 key as non-extractable for safe local IndexedDB caching.
   */
  function toNonExtractableAesKey(extractableKey) {
    return subtle.exportKey('raw', extractableKey).then(function (rawBuf) {
      return subtle.importKey(
        'raw',
        rawBuf,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    });
  }

  function parseJwkObject(jwkOrStr) {
    if (!jwkOrStr) return null;
    if (typeof jwkOrStr === 'object') return jwkOrStr;
    try {
      return JSON.parse(jwkOrStr);
    } catch (e) {
      return null;
    }
  }

  function canonicalEcdhPubString(ecdhPublicJwk) {
    var jwk = parseJwkObject(ecdhPublicJwk);
    if (!jwk || !jwk.x || !jwk.y) return '';
    return 'PBF-ECDH|' + String(jwk.kty || 'EC') + '|' + String(jwk.crv || 'P-256') + '|' + String(jwk.x) + '|' + String(jwk.y);
  }

  /**
   * Compute a 128-bit formatted hex fingerprint (8 groups of 4 chars) for an ECDH public JWK.
   */
  function computeKeyFingerprint(ecdhPublicJwk) {
    var canon = canonicalEcdhPubString(ecdhPublicJwk);
    if (!canon || !subtle) return Promise.resolve('');
    var enc = new TextEncoder();
    return subtle.digest('SHA-256', enc.encode(canon)).then(function (hashBuf) {
      var bytes = new Uint8Array(hashBuf);
      var hexParts = [];
      for (var i = 0; i < 16; i += 2) {
        var b1 = bytes[i].toString(16).toUpperCase();
        var b2 = bytes[i + 1].toString(16).toUpperCase();
        if (b1.length < 2) b1 = '0' + b1;
        if (b2.length < 2) b2 = '0' + b2;
        hexParts.push(b1 + b2);
      }
      return hexParts.join(' ');
    });
  }

  /**
   * Compute a symmetric 60-digit (12 x 5-digit) Signal-style safety number for a 1:1 DM pair.
   */
  function computeSafetyNumber(myUserId, myPubJwk, peerUserId, peerPubJwk) {
    var myCanon = canonicalEcdhPubString(myPubJwk);
    var peerCanon = canonicalEcdhPubString(peerPubJwk);
    if (!myCanon || !peerCanon || !subtle) return Promise.resolve('');

    var pair = [
      { id: Number(myUserId || 0), canon: myCanon },
      { id: Number(peerUserId || 0), canon: peerCanon }
    ].sort(function (a, b) {
      if (a.id !== b.id) return a.id - b.id;
      return a.canon < b.canon ? -1 : (a.canon > b.canon ? 1 : 0);
    });

    var seed = 'PBF-SAFETY-v1|' + String(pair[0].id) + '|' + pair[0].canon + '|' + String(pair[1].id) + '|' + pair[1].canon;
    var enc = new TextEncoder();
    return subtle.digest('SHA-256', enc.encode(seed)).then(function (d1) {
      return subtle.digest('SHA-256', new Uint8Array(d1)).then(function (d2) {
        var bytes = new Uint8Array(64);
        bytes.set(new Uint8Array(d1), 0);
        bytes.set(new Uint8Array(d2), 32);
        var groups = [];
        for (var g = 0; g < 12; g++) {
          var off = g * 3;
          var val = ((bytes[off] << 16) | (bytes[off + 1] << 8) | bytes[off + 2]) % 100000;
          var s = String(val);
          while (s.length < 5) s = '0' + s;
          groups.push(s);
        }
        return groups.join(' ');
      });
    });
  }

  // TOFU pins are namespaced by the signed-in user so another account on a shared device
  // cannot inherit this user's pinned/verified peer fingerprints.
  var pinOwnerId = 0;

  function setPinOwner(userId) {
    pinOwnerId = Number(userId) || 0;
  }

  function pinKeyFor(peerUserId) {
    return 'peer_key_pin_' + (pinOwnerId ? 'u' + String(pinOwnerId) + '_' : '') + String(peerUserId);
  }

  function getPeerVerificationState(peerUserId, currentFingerprint) {
    var storeKey = pinKeyFor(peerUserId);
    return pinDbGet(storeKey).then(function (pin) {
      if (!pin && !pinOwnerId) {
        return idbGet('peer_key_pin_' + String(peerUserId)).then(function (legacyPin) {
          if (legacyPin) {
            return pinDbPut(storeKey, legacyPin).then(function () { return legacyPin; });
          }
          return null;
        });
      }
      return pin;
    }).then(function (pin) {
      if (!pin) {
        if (currentFingerprint) {
          return pinDbPut(storeKey, {
            lastSeenFingerprint: currentFingerprint,
            verifiedFingerprint: null,
            verifiedAt: null
          }).then(function () {
            return { verified: false, keyChangedWarning: false, verifiedAt: null };
          });
        }
        return { verified: false, keyChangedWarning: false, verifiedAt: null };
      }
      var verifiedFp = pin.verifiedFingerprint || null;
      var lastSeenFp = pin.lastSeenFingerprint || null;
      var verified = Boolean(verifiedFp && currentFingerprint && verifiedFp === currentFingerprint);
      var keyChangedWarning = Boolean(
        currentFingerprint &&
        ((verifiedFp && verifiedFp !== currentFingerprint) ||
         (lastSeenFp && lastSeenFp !== currentFingerprint))
      );
      return {
        verified: verified,
        keyChangedWarning: keyChangedWarning,
        verifiedAt: pin.verifiedAt || null,
        previousFingerprint: verifiedFp || lastSeenFp || null
      };
    });
  }

  function markPeerFingerprintVerified(peerUserId, fingerprint) {
    if (!peerUserId || !fingerprint) {
      return Promise.reject(new Error('Valid peer ID and key fingerprint are required.'));
    }
    var storeKey = pinKeyFor(peerUserId);
    var record = {
      lastSeenFingerprint: fingerprint,
      verifiedFingerprint: fingerprint,
      verifiedAt: new Date().toISOString()
    };
    return pinDbPut(storeKey, record).then(function () {
      return record;
    });
  }

  function clearPeerVerificationPin(peerUserId) {
    if (!peerUserId) return Promise.resolve(true);
    var keys = [pinKeyFor(peerUserId), 'peer_key_pin_' + String(peerUserId)];
    var unique = [];
    for (var i = 0; i < keys.length; i++) {
      if (unique.indexOf(keys[i]) === -1) unique.push(keys[i]);
    }
    return Promise.all(unique.map(function (k) {
      return pinDbDelete(k);
    })).then(function () {
      return true;
    });
  }

  function clearMemoryKeys() {
    memoryKeyStore = {};
    pinOwnerId = 0;
    if (typeof indexedDB !== 'undefined') {
      memoryPinStore = {};
    }
    closeKeyDbHandle();
  }

  /**
   * Decrypt a Member's own exported E2EE messages in-browser using WebCrypto.
   * Uses unlocked IndexedDB identity keys if present, or unlocks `chat.user_crypto_keys`
   * with a caller-supplied passphrase or `getPassphrase()` prompt callback.
   */
  function decryptExportBundle(bundle, options) {
    var opts = options || {};
    if (!bundle || !bundle.chat || !Array.isArray(bundle.chat.messages)) {
      return Promise.resolve(bundle);
    }

    var messages = bundle.chat.messages;
    var hasEncryptedMsgs = false;
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m && m.iv && m.content && !m.deleted_at && !m.hidden_at && m.message_type !== 'system') {
        hasEncryptedMsgs = true;
        break;
      }
    }

    var clonedChat = Object.assign({}, bundle.chat);
    var clonedBundle = Object.assign({}, bundle, { chat: clonedChat });

    if (!hasEncryptedMsgs) {
      clonedChat.messages = messages.map(function (msg) { return Object.assign({}, msg); });
      clonedChat.decryption_summary = { attempted: 0, decrypted: 0, failed: 0 };
      return Promise.resolve(clonedBundle);
    }
    if (!subtle) {
      return Promise.reject(new Error('WebCrypto API is unavailable in this browser.'));
    }

    function resolveIdentityKeys() {
      return getStoredIdentityKeys().then(function (idKeys) {
        if (idKeys && idKeys.ecdhPrivateKey) {
          return idKeys;
        }
        var vaultRow = bundle.chat.user_crypto_keys;
        if (!vaultRow || !vaultRow.encrypted_private_vault || !vaultRow.vault_salt || !vaultRow.vault_iv) {
          throw new Error('No unlocked E2EE keys or encrypted backup vault found.');
        }
        var passPromise = opts.passphrase !== undefined && opts.passphrase !== null
          ? Promise.resolve(opts.passphrase)
          : (typeof opts.getPassphrase === 'function'
            ? Promise.resolve(opts.getPassphrase())
            : Promise.reject(new Error('Passphrase is required to unlock your E2EE key vault.')));

        return passPromise.then(function (passphrase) {
          if (passphrase === null || passphrase === undefined || passphrase === '') {
            var cancelErr = new Error('E2EE vault unlock cancelled.');
            cancelErr.code = 'EXPORT_DECRYPT_CANCELLED';
            throw cancelErr;
          }
          return decryptVault(
            String(passphrase),
            vaultRow.encrypted_private_vault,
            vaultRow.vault_salt,
            vaultRow.vault_iv
          );
        }).then(function () {
          return getStoredIdentityKeys();
        }).then(function (unlocked) {
          if (!unlocked || !unlocked.ecdhPrivateKey) {
            throw new Error('Failed to load unlocked E2EE identity key.');
          }
          return unlocked;
        });
      });
    }

    var shares = Array.isArray(bundle.chat.channel_key_shares) ? bundle.chat.channel_key_shares : [];
    var myUserId = Number(bundle.user_id || 0);

    return resolveIdentityKeys().then(function (idKeys) {
      var channelKeyMap = {};
      var sharePromises = shares.map(function (share) {
        if (!share || !share.channel_id || !share.wrapped_key_base64 || !share.wrap_iv) {
          return Promise.resolve();
        }
        var epoch = Number(share.key_epoch || 1);
        var mapKey = String(share.channel_id) + ':' + String(epoch);
        var senderPub = parseJwkObject(share.sender_ephemeral_pub_jwk);
        if (!senderPub && Number(share.sender_user_id) === myUserId && idKeys.ecdhPublicJwk) {
          senderPub = idKeys.ecdhPublicJwk;
        }
        if (!senderPub) {
          senderPub = parseJwkObject(share.sender_ecdh_public_key_jwk);
        }
        if (!senderPub) {
          return Promise.resolve();
        }
        return deriveEcdhSharedKey(idKeys.ecdhPrivateKey, senderPub).then(function (sharedKey) {
          return unwrapChannelKey(share.wrapped_key_base64, sharedKey, share.wrap_iv, false);
        }).then(function (aesKey) {
          channelKeyMap[mapKey] = aesKey;
        }).catch(function () {
          // Leave unreadable share absent so per-message decryption records clean failure
        });
      });

      return Promise.all(sharePromises).then(function () {
        var missingCachePromises = [];
        var seenMissing = {};
        for (var j = 0; j < messages.length; j++) {
          var em = messages[j];
          if (!em || !em.iv || !em.content || em.deleted_at || em.hidden_at || em.message_type === 'system') continue;
          var ep = Number(em.key_epoch || 1);
          var mk = String(em.channel_id) + ':' + String(ep);
          if (!channelKeyMap[mk] && !seenMissing[mk]) {
            seenMissing[mk] = true;
            (function (chId, keyEpoch, keySlot) {
              missingCachePromises.push(
                idbGet('dm_aes_ch_' + String(chId) + '_ep_' + String(keyEpoch)).then(function (cachedAes) {
                  if (cachedAes) channelKeyMap[keySlot] = cachedAes;
                }).catch(function () {})
              );
            })(em.channel_id, ep, mk);
          }
        }
        return Promise.all(missingCachePromises);
      }).then(function () {
        var attempted = 0;
        var decrypted = 0;
        var failed = 0;

        return Promise.all(messages.map(function (msg) {
          var copy = Object.assign({}, msg);
          if (!msg || !msg.iv || !msg.content || msg.deleted_at || msg.hidden_at || msg.message_type === 'system') {
            return Promise.resolve(copy);
          }
          attempted++;
          var mk = String(msg.channel_id) + ':' + String(msg.key_epoch || 1);
          var aesKey = channelKeyMap[mk];
          if (!aesKey) {
            failed++;
            copy.e2ee_decrypted = false;
            copy.decryption_error = 'Missing channel key share for this message.';
            return Promise.resolve(copy);
          }
          return decryptPayload(aesKey, msg.content, msg.iv).then(function (plaintext) {
            decrypted++;
            copy.decrypted_content = plaintext;
            copy.e2ee_decrypted = true;
            return copy;
          }).catch(function () {
            failed++;
            copy.e2ee_decrypted = false;
            copy.decryption_error = 'Failed to decrypt message payload.';
            return copy;
          });
        })).then(function (decryptedMsgs) {
          clonedChat.messages = decryptedMsgs;
          clonedChat.decryption_summary = {
            attempted: attempted,
            decrypted: decrypted,
            failed: failed
          };
          return clonedBundle;
        });
      });
    });
  }

  var ClubhouseCrypto = {
    clearMemoryKeys: clearMemoryKeys,
    setPinOwner: setPinOwner,
    stripJpegMetadata: stripJpegMetadata,
    arrayBufferToBase64: arrayBufferToBase64,
    base64ToUint8Array: base64ToUint8Array,
    generateIdentityKeyPair: generateIdentityKeyPair,
    deriveVaultKeyFromPassphrase: deriveVaultKeyFromPassphrase,
    encryptVault: encryptVault,
    decryptVault: decryptVault,
    generateChannelKey: generateChannelKey,
    deriveEcdhSharedKey: deriveEcdhSharedKey,
    wrapChannelKey: wrapChannelKey,
    unwrapChannelKey: unwrapChannelKey,
    encryptPayload: encryptPayload,
    decryptPayload: decryptPayload,
    encryptBinaryBuffer: encryptBinaryBuffer,
    decryptBinaryBuffer: decryptBinaryBuffer,
    enrollIdentityWithPassphrase: enrollIdentityWithPassphrase,
    restoreIdentityFromServerVault: restoreIdentityFromServerVault,
    hasLocalIdentityKeys: hasLocalIdentityKeys,
    getStoredIdentityKeys: getStoredIdentityKeys,
    toNonExtractableAesKey: toNonExtractableAesKey,
    computeKeyFingerprint: computeKeyFingerprint,
    computeSafetyNumber: computeSafetyNumber,
    getPeerVerificationState: getPeerVerificationState,
    markPeerFingerprintVerified: markPeerFingerprintVerified,
    clearPeerVerificationPin: clearPeerVerificationPin,
    decryptExportBundle: decryptExportBundle,
    idbGet: idbGet,
    idbPut: idbPut,
    idbDelete: idbDelete,
    idbDeleteByPrefix: idbDeleteByPrefix
  };

  root.ClubhouseCrypto = ClubhouseCrypto;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ClubhouseCrypto;
  }
})(typeof window !== 'undefined' ? window : globalThis);
