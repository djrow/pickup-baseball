// @ts-check
/**
 * @fileoverview Admin Dashboard — Dual-Database Operational SQL (.zip) & PBKDF2 + AES-GCM Encrypted DR Backup (.pbfenc) (`admin/backup.js`).
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * TABLE OF CONTENTS:
 * 1. Client Store-Mode ZIP Builder & Base64/Blob Download Helpers (`buildStoreZipBlob`, `bytesToBase64`, `triggerBlobDownload`)
 * 2. WebCrypto PBKDF2 Wrapping Key Derivation (`deriveAdminBackupWrappingKey`)
 * 3. Operational SQL & Encrypted DR Backup Button Wiring (`setupAdminBackupButton`)
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root) return;

  var API = root.API = root.API || /** @type {any} */ ({});
  /** @type {any} */
  var AdminUI = API._adminUi = API._adminUi || {};

  function el(id) {
    return typeof document !== 'undefined' ? /** @type {any} */ (document.getElementById(id)) : null;
  }

  function buildStoreZipBlob(entries) {
    var crcTable = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[i] = c >>> 0;
    }
    function crc32(bytes) {
      var cVal = 0xFFFFFFFF;
      for (var idx = 0; idx < bytes.length; idx++) cVal = crcTable[(cVal ^ bytes[idx]) & 0xFF] ^ (cVal >>> 8);
      return (cVal ^ 0xFFFFFFFF) >>> 0;
    }

    var encoder = new TextEncoder();
    var localParts = [];
    var centralParts = [];
    var offset = 0;

    for (var eIdx = 0; eIdx < entries.length; eIdx++) {
      var entry = entries[eIdx];
      var nameBytes = encoder.encode(entry.name);
      var dataBytes = entry.bytes;
      var crc = crc32(dataBytes);
      var len = dataBytes.length;

      var localHdr = new ArrayBuffer(30 + nameBytes.length);
      var lv = new DataView(localHdr);
      lv.setUint32(0, 0x04034B50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(8, 0, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, len, true);
      lv.setUint32(22, len, true);
      lv.setUint16(26, nameBytes.length, true);
      new Uint8Array(localHdr, 30).set(nameBytes);
      localParts.push(new Uint8Array(localHdr), dataBytes);

      var centralHdr = new ArrayBuffer(46 + nameBytes.length);
      var cv = new DataView(centralHdr);
      cv.setUint32(0, 0x02014B50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, len, true);
      cv.setUint32(24, len, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      new Uint8Array(centralHdr, 46).set(nameBytes);
      centralParts.push(new Uint8Array(centralHdr));

      offset += 30 + nameBytes.length + len;
    }

    var centralSize = centralParts.reduce(function (s, p) { return s + p.length; }, 0);
    var eocd = new ArrayBuffer(22);
    var ev = new DataView(eocd);
    ev.setUint32(0, 0x06054B50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    return new Blob(localParts.concat(centralParts, [new Uint8Array(eocd)]), { type: 'application/zip' });
  }

  function bytesToBase64(bytes) {
    var binary = '';
    var chunkSize = 0x8000;
    for (var i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function triggerBlobDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  async function deriveAdminBackupWrappingKey(passphrase, iterations) {
    if (!root.crypto || !root.crypto.subtle || typeof root.crypto.getRandomValues !== 'function') {
      throw new Error('WebCrypto API is unavailable in this browser.');
    }
    var saltBytes = new Uint8Array(16);
    root.crypto.getRandomValues(saltBytes);
    var passBytes = new TextEncoder().encode(String(passphrase));
    var baseKey = await root.crypto.subtle.importKey(
      'raw',
      passBytes,
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );
    var derivedBits = await root.crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: saltBytes,
        iterations: iterations,
        hash: 'SHA-256'
      },
      baseKey,
      256
    );
    var derivedBytes = new Uint8Array(derivedBits);
    var result = {
      wrappingKey: bytesToBase64(derivedBytes),
      kdfSalt: bytesToBase64(saltBytes),
      kdfIterations: iterations
    };
    derivedBytes.fill(0);
    return result;
  }

  function setupAdminBackupButton() {
    var btn = el('btn-backup-db');
    if (btn && !btn.dataset.boundDualBackup) {
      btn.dataset.boundDualBackup = '1';

      btn.addEventListener('click', async function (e) {
        e.preventDefault();
        var origText = btn.textContent;
        btn.style.pointerEvents = 'none';
        btn.textContent = API.t('backup_scrubbed_working', '⏳ Exporting scrubbed SQL...');
        var dateStr = new Date().toISOString().slice(0, 10);

        try {
          var responses = await Promise.all([
            fetch('/api/events/admin/backup-db?db=baseball', { credentials: 'include', cache: 'no-store' }),
            fetch('/api/events/admin/backup-db?db=chat', { credentials: 'include', cache: 'no-store' })
          ]);
          var baseballRes = responses[0];
          var chatRes = responses[1];

          if (!baseballRes.ok) {
            throw new Error('Failed to export BASEBALL_DB (HTTP ' + baseballRes.status + ')');
          }

          var entries = [{
            name: 'baseball_operational_' + dateStr + '.sql',
            bytes: new Uint8Array(await baseballRes.arrayBuffer())
          }];

          if (chatRes.ok) {
            entries.push({
              name: 'clubhouse_chat_operational_' + dateStr + '.sql',
              bytes: new Uint8Array(await chatRes.arrayBuffer())
            });
          } else if (chatRes.status !== 503) {
            throw new Error('Failed to export CHAT_DB (HTTP ' + chatRes.status + ')');
          }

          var zipBlob = buildStoreZipBlob(entries);
          triggerBlobDownload(zipBlob, 'pickup_baseball_operational_backup_' + dateStr + '.zip');
          if (root.PBFDialog) {
            root.PBFDialog.toast(
              API.t('backup_scrubbed_success', 'Scrubbed operational SQL backup downloaded.'),
              { type: 'info' }
            );
          }
        } catch (err) {
          if (root.PBFDialog) {
            root.PBFDialog.toast(
              API.t('backup_failed', 'Database backup failed: {error}', { error: (err && err.message) || 'Unknown error' }),
              { type: 'error' }
            );
          }
        } finally {
          btn.style.pointerEvents = '';
          btn.textContent = origText;
        }
      });
    }

    var drBtn = /** @type {HTMLButtonElement|null} */ (el('btn-backup-dr'));
    if (drBtn && !drBtn.dataset.boundDrBackup) {
      drBtn.dataset.boundDrBackup = '1';

      drBtn.addEventListener('click', async function (e) {
        e.preventDefault();
        var passphrase = root.PBFDialog
          ? await root.PBFDialog.prompt(
              API.t(
                'backup_dr_prompt_msg',
                'Enter a passphrase (at least 8 characters) to encrypt this full disaster-recovery backup. Keep it safe — you will need it with scripts/restore-backup.js:'
              ),
              '',
              {
                title: API.t('backup_dr_prompt_title', '🔐 Encrypted Full DR Backup'),
                inputType: 'password',
                placeholder: API.t('backup_dr_prompt_placeholder', 'Enter backup encryption passphrase...'),
                confirmLabel: API.t('backup_dr_confirm_btn', 'Encrypt & Download')
              }
            )
          : null;

        if (passphrase === null) return;
        if (String(passphrase).length < 8) {
          if (root.PBFDialog) {
            root.PBFDialog.toast(
              API.t('backup_dr_passphrase_short', 'Backup passphrase must be at least 8 characters.'),
              { type: 'error' }
            );
          }
          return;
        }

        var origText = drBtn.textContent;
        drBtn.disabled = true;
        drBtn.textContent = API.t('backup_dr_working', '⏳ Encrypting DR backup...');
        var dateStr = new Date().toISOString().slice(0, 10);

        try {
          var kdfMaterial = await deriveAdminBackupWrappingKey(passphrase, 600000);
          /** @type {RequestInit} */
          var reqInit = {
            method: 'POST',
            credentials: 'include',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(kdfMaterial)
          };

          var responses = await Promise.all([
            fetch('/api/events/admin/backup-db?db=baseball', reqInit),
            fetch('/api/events/admin/backup-db?db=chat', reqInit)
          ]);
          var baseballRes = responses[0];
          var chatRes = responses[1];

          if (!baseballRes.ok) {
            throw new Error('Failed to export encrypted BASEBALL_DB (HTTP ' + baseballRes.status + ')');
          }

          var baseballJson = await baseballRes.text();
          triggerBlobDownload(
            new Blob([baseballJson], { type: 'application/json' }),
            'baseball_dr_backup_' + dateStr + '.pbfenc'
          );

          if (chatRes.ok) {
            var chatJson = await chatRes.text();
            triggerBlobDownload(
              new Blob([chatJson], { type: 'application/json' }),
              'clubhouse_chat_dr_backup_' + dateStr + '.pbfenc'
            );
          } else if (chatRes.status !== 503) {
            throw new Error('Failed to export encrypted CHAT_DB (HTTP ' + chatRes.status + ')');
          }

          if (root.PBFDialog) {
            root.PBFDialog.toast(
              API.t('backup_dr_success', 'Encrypted disaster-recovery backup (.pbfenc) downloaded.'),
              { type: 'info' }
            );
          }
        } catch (err) {
          if (root.PBFDialog) {
            root.PBFDialog.toast(
              API.t('backup_failed', 'Database backup failed: {error}', { error: (err && err.message) || 'Unknown error' }),
              { type: 'error' }
            );
          }
        } finally {
          drBtn.disabled = false;
          drBtn.textContent = origText;
        }
      });
    }
  }

  AdminUI.buildStoreZipBlob = buildStoreZipBlob;
  AdminUI.bytesToBase64 = bytesToBase64;
  AdminUI.triggerBlobDownload = triggerBlobDownload;
  AdminUI.deriveAdminBackupWrappingKey = deriveAdminBackupWrappingKey;
  AdminUI.setupAdminBackupButton = setupAdminBackupButton;
})();
