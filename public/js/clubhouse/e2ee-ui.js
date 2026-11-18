// @ts-check
/**
 * @fileoverview Pickup Baseball Clubhouse — Passphrase Vault, Safety Number Verification, Behavior Covenant & DM E2EE Audit Notices (`clubhouse/e2ee-ui.js`).
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * TABLE OF CONTENTS:
 * 1. Vault & Covenant Modal Open/Close Handlers (`openVaultModal`, `openCovenantModal`)
 * 2. DM & Private Board E2EE Status Banner (`refreshDmE2eeNotice`)
 * 3. Safety Number & Key Fingerprint Verification Modal (`refreshVerifyKeyButton`, `openVerifyKeysModal`)
 * 4. System Security Audit Card Builder (`buildSystemAuditCardHtml`)
 * 5. E2EE Vault, Safety Number & Covenant DOM Event Wiring
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root) return;

  var Store = root.ClubhouseStore = root.ClubhouseStore || /** @type {any} */ ({ state: {} });
  /** @type {any} */
  var UI = Store._ui = Store._ui || {};
  var uiState = UI.uiState;

  var el = UI.el;
  var escapeHtml = UI.escapeHtml;
  var formatTime = UI.formatTime;
  var tClubhouse = UI.tClubhouse;
  var isChannelBlockedDm = UI.isChannelBlockedDm;
  var trapModal = UI.trapModal;
  var releaseModalTrap = UI.releaseModalTrap;

  function openVaultModal(triggerEl) {
    var modal = el('ch-vault-modal');
    if (!modal) return;
    var trig = triggerEl || document.activeElement;
    modal.classList.remove('hidden');
    if (typeof UI.syncPrivacyRelayToggleUi === 'function') UI.syncPrivacyRelayToggleUi();
    if (typeof UI.loadStorageStatusWidget === 'function') UI.loadStorageStatusWidget();
    refreshOwnVaultFingerprint();
    trapModal('ch-vault-modal', trig, el('ch-vault-passphrase') || el('btn-close-vault-modal'));
  }

  function closeVaultModal() {
    var modal = el('ch-vault-modal');
    if (modal) modal.classList.add('hidden');
    releaseModalTrap('ch-vault-modal');
  }

  function closeVerifyModal() {
    var modal = el('ch-verify-modal');
    if (modal) modal.classList.add('hidden');
    releaseModalTrap('ch-verify-modal');
  }

  function openCovenantModal(triggerEl) {
    var modal = el('ch-covenant-modal');
    if (!modal) return;
    var trig = triggerEl || document.activeElement;
    modal.classList.remove('hidden');
    trapModal('ch-covenant-modal', trig, el('btn-done-covenant-modal'));
  }

  function closeCovenantModal() {
    var modal = el('ch-covenant-modal');
    if (modal) modal.classList.add('hidden');
    releaseModalTrap('ch-covenant-modal');
  }

  function refreshDmE2eeNotice(channel) {
    var bannerEl = el('ch-dm-e2ee-banner');
    var textEl = el('ch-dm-e2ee-banner-text');
    var vaultBtn = el('btn-dm-open-vault');
    if (!bannerEl) return;

    var ch = channel || uiState.activeChannel;
    var isE2eeCh = Store.requiresE2eeChannel ? Store.requiresE2eeChannel(ch) : (ch && (ch.channel_type === 'dm' || ch.channel_type === 'group_dm' || ch.is_private === 1));
    if (isChannelBlockedDm(ch) && Store.state.user) {
      bannerEl.classList.remove('hidden');
      if (textEl) {
        textEl.textContent = tClubhouse('clubhouse.peer_blocked_dm_notice', '🚫 Direct messages are blocked between you and this member.');
      }
      if (vaultBtn) vaultBtn.style.display = 'none';
      return;
    }
    if (!ch || !isE2eeCh || !Store.state.user) {
      bannerEl.classList.add('hidden');
      return;
    }

    Promise.resolve(Store.getDmE2eeStatus(ch.id)).then(function (status) {
      if (!uiState.activeChannel || Number(uiState.activeChannel.id) !== Number(ch.id)) return;
      if (status && status.ready) {
        bannerEl.classList.add('hidden');
        return;
      }
      bannerEl.classList.remove('hidden');
      if (status && status.reason === 'E2EE_PEER_NOT_ENROLLED') {
        if (textEl) {
          textEl.textContent = (status.isPrivateBoard)
            ? '⏳ Private Board E2EE requires all invited members to set up 🔐 E2EE Key Vault. Waiting on invited member(s) to enroll.'
            : '⏳ Direct Messages require both members to set up 🔐 E2EE Key Vault. Waiting on recipient to enroll their key vault.';
        }
        if (vaultBtn) vaultBtn.style.display = 'none';
      } else {
        if (textEl) {
          textEl.textContent = '🔐 Set up or restore your E2EE Key Vault on this browser to encrypt & read this conversation.';
        }
        if (vaultBtn) vaultBtn.style.display = '';
      }
    }).catch(function () {});
  }

  function refreshVerifyKeyButton(channel) {
    var btn = el('btn-dm-verify-key');
    if (!btn) return;
    var ch = channel || uiState.activeChannel;
    var isE2eeCh = Store.requiresE2eeChannel ? Store.requiresE2eeChannel(ch) : (ch && (ch.channel_type === 'dm' || ch.channel_type === 'group_dm'));
    if (!ch || !isE2eeCh || !Store.state.user || typeof Store.getChannelVerificationInfo !== 'function') {
      btn.classList.add('hidden');
      return;
    }
    btn.classList.remove('hidden');
    btn.textContent = tClubhouse('clubhouse.verify_key_btn', '🛡️ Verify Key');
    btn.style.color = '';
    btn.style.borderColor = '';
    Store.getChannelVerificationInfo(ch.id).then(function (info) {
      if (!uiState.activeChannel || Number(uiState.activeChannel.id) !== Number(ch.id)) return;
      if (!info || !info.supported) return;
      if (info.anyKeyChanged) {
        btn.textContent = tClubhouse('clubhouse.verify_key_changed_btn', '⚠️ Key Changed!');
        btn.style.color = '#fde68a';
        btn.style.borderColor = '#f59e0b';
      } else if (info.allVerified) {
        btn.textContent = tClubhouse('clubhouse.verify_key_verified_btn', '✓ Key Verified');
        btn.style.color = '#6ee7b7';
        btn.style.borderColor = 'rgba(16,185,129,0.5)';
      } else {
        btn.textContent = tClubhouse('clubhouse.verify_key_btn', '🛡️ Verify Key');
        btn.style.color = '';
        btn.style.borderColor = '';
      }
    }).catch(function () {});
  }

  function openVerifyKeysModal(triggerEl) {
    var modal = el('ch-verify-modal');
    var warnEl = el('ch-verify-warning');
    var safetyWrap = el('ch-verify-safety-wrap');
    var safetyNumEl = el('ch-verify-safety-number');
    var peersEl = el('ch-verify-peers-list');
    var statusEl = el('ch-verify-status-msg');
    if (!modal || !uiState.activeChannel || typeof Store.getChannelVerificationInfo !== 'function') return;

    var trig = triggerEl || document.activeElement;
    if (statusEl) statusEl.textContent = '';
    if (peersEl) {
      peersEl.innerHTML = '<div style="color:var(--ch-text-muted);">' +
        escapeHtml(tClubhouse('clubhouse.verify_computing', 'Computing cryptographic fingerprints...')) +
        '</div>';
    }
    modal.classList.remove('hidden');
    trapModal('ch-verify-modal', trig, el('btn-done-verify-modal'));

    Store.getChannelVerificationInfo(uiState.activeChannel.id).then(function (info) {
      if (!info || !info.supported) {
        if (peersEl) {
          peersEl.innerHTML = '<div>' +
            escapeHtml(tClubhouse('clubhouse.verify_unsupported', 'Key verification is available on E2EE DMs and Private Boards.')) +
            '</div>';
        }
        return;
      }
      if (warnEl) {
        if (info.anyKeyChanged) warnEl.classList.remove('hidden');
        else warnEl.classList.add('hidden');
      }
      if (safetyWrap && safetyNumEl) {
        if (info.isOneToOne && info.safetyNumber) {
          safetyWrap.classList.remove('hidden');
          safetyNumEl.textContent = info.safetyNumber;
        } else {
          safetyWrap.classList.add('hidden');
          safetyNumEl.textContent = '';
        }
      }

      var html = '';
      html += '<div style="padding:8px;border:1px solid var(--ch-border);border-radius:6px;margin-bottom:8px;">';
      html += '<div style="font-weight:700;margin-bottom:3px;">' + escapeHtml(tClubhouse('clubhouse.verify_your_fp', 'Your Key Fingerprint')) + '</div>';
      html += '<div dir="ltr" style="font-family:monospace;font-size:11.5px;color:var(--ch-text-secondary);word-break:break-word;unicode-bidi:isolate;">' +
        escapeHtml(info.myFingerprint || tClubhouse('clubhouse.verify_not_enrolled', 'Not enrolled on this browser yet')) + '</div></div>';

      var peers = info.peers || [];
      for (var i = 0; i < peers.length; i++) {
        var p = peers[i];
        html += '<div style="padding:8px;border:1px solid var(--ch-border);border-radius:6px;margin-bottom:8px;">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;">';
        var verBadge = (p.hasKey && p.keyVersion) ? (' <span style="font-size:11px;color:var(--ch-text-muted);font-weight:400;">(v' + Number(p.keyVersion) + ')</span>') : '';
        html += '<strong>' + escapeHtml(p.name) + verBadge + '</strong>';
        if (p.hasKey) {
          if (p.keyChangedWarning) {
            html += '<button type="button" class="ch-promote-btn btn-verify-peer-fp" data-peer-id="' + Number(p.userId) + '" data-fp="' + escapeHtml(p.fingerprint) + '" style="border-color:#f59e0b;color:#fde68a;">' + escapeHtml(tClubhouse('clubhouse.verify_reverify_btn', '⚠️ Re-Verify New Key')) + '</button>';
          } else if (p.verified) {
            html += '<span style="color:#6ee7b7;font-weight:700;">' + escapeHtml(tClubhouse('clubhouse.verify_verified_badge', '✓ Verified')) + '</span>';
          } else {
            html += '<button type="button" class="ch-promote-btn btn-verify-peer-fp" data-peer-id="' + Number(p.userId) + '" data-fp="' + escapeHtml(p.fingerprint) + '">' + escapeHtml(tClubhouse('clubhouse.verify_mark_btn', '✓ Mark Verified')) + '</button>';
          }
        } else {
          html += '<span style="color:#fbbf24;">' + escapeHtml(tClubhouse('clubhouse.verify_no_vault', '⏳ No E2EE Vault')) + '</span>';
        }
        html += '</div>';
        html += '<div dir="ltr" style="font-family:monospace;font-size:11.5px;color:var(--ch-text-secondary);word-break:break-word;unicode-bidi:isolate;">' +
          escapeHtml(p.fingerprint || tClubhouse('clubhouse.verify_waiting_member', 'Waiting for member to enroll key vault')) + '</div>';
        if (p.keyRotatedAt) {
          html += '<div style="font-size:11px;color:var(--ch-text-muted);margin-top:3px;">' + escapeHtml(tClubhouse('clubhouse.verify_last_rotated', 'Last rotated: {date}', { date: String(p.keyRotatedAt) })) + '</div>';
        }
        html += '</div>';
      }
      if (peersEl) {
        peersEl.innerHTML = html;
        var vBtns = peersEl.querySelectorAll('.btn-verify-peer-fp');
        for (var b = 0; b < vBtns.length; b++) {
          vBtns[b].addEventListener('click', function () {
            var uid = Number(this.getAttribute('data-peer-id'));
            var fp = this.getAttribute('data-fp') || '';
            Store.verifyPeerIdentityKey(uid, fp).then(function () {
              if (statusEl) statusEl.textContent = tClubhouse('clubhouse.verify_pinned_success', '✓ Key fingerprint pinned & marked verified on this device.');
              refreshVerifyKeyButton(null);
              openVerifyKeysModal(null);
            }).catch(function (err) {
              if (statusEl) statusEl.textContent = tClubhouse('clubhouse.verify_error', 'Error: {message}', { message: (err && err.message) || '' });
            });
          });
        }
      }
    }).catch(function (err) {
      if (peersEl) {
        peersEl.innerHTML = '<div style="color:#ff8a80;">' +
          escapeHtml(tClubhouse('clubhouse.verify_load_failed', 'Failed to load key info: {message}', { message: (err && err.message) || '' })) +
          '</div>';
      }
    });
  }

  function refreshOwnVaultFingerprint() {
    var CryptoEngine = root.ClubhouseCrypto;
    var fpBox = el('ch-vault-own-fp');
    if (!fpBox || !CryptoEngine || typeof CryptoEngine.getStoredIdentityKeys !== 'function') return;
    CryptoEngine.getStoredIdentityKeys().then(function (keys) {
      if (!keys || !keys.ecdhPublicJwk || typeof CryptoEngine.computeKeyFingerprint !== 'function') {
        fpBox.classList.add('hidden');
        return;
      }
      return CryptoEngine.computeKeyFingerprint(keys.ecdhPublicJwk).then(function (fp) {
        if (fp) {
          fpBox.textContent = tClubhouse('clubhouse.verify_own_fp', 'Your ECDH Identity Key Fingerprint: {fp}', { fp: fp });
          fpBox.classList.remove('hidden');
        }
      });
    }).catch(function () {});
  }

  function buildSystemAuditCardHtml(msg, displayContent) {
    var html = '';
    html += '<article class="ch-msg-card ch-msg-system-audit" data-msg-id="' + msg.id + '" data-audit-type="' + escapeHtml((msg.metadata && msg.metadata.audit_type) || 'system') + '">';
    html += '<div class="ch-msg-avatar" title="' + escapeHtml(tClubhouse('clubhouse.audit_notice_title', 'Server Security Audit Notice')) + '">🛡️</div>';
    html += '<div class="ch-msg-body">';
    html += '<div class="ch-msg-header">';
    html += '<span class="ch-msg-author">' + escapeHtml(tClubhouse('clubhouse.audit_sender_name', 'Clubhouse Security Audit')) + '</span>';
    html += '<span class="ch-badge role-organizer">' + escapeHtml(tClubhouse('clubhouse.audit_verified_badge', '🔐 Server Verified')) + '</span>';
    html += '<span class="ch-msg-time">' + escapeHtml(formatTime(msg.created_at)) + '</span>';
    html += '</div>';
    html += '<div class="ch-msg-content" style="color:#fde68a;">' + escapeHtml(displayContent) + '</div>';
    html += '</div></article>';
    return html;
  }

  function initE2eeUiDomEvents() {
    var CryptoEngine = root.ClubhouseCrypto;
    var RtcEngine = root.ClubhouseRTC;

    // Vault modal
    var vaultBtn = el('btn-user-vault');
    var dmOpenVaultBtn = el('btn-dm-open-vault');
    var vaultModal = el('ch-vault-modal');
    var closeVaultBtn = el('btn-close-vault-modal');
    var enrollBtn = el('btn-enroll-keys');
    var restoreBtn = el('btn-restore-keys');

    if (vaultBtn && vaultModal) {
      vaultBtn.addEventListener('click', function () {
        openVaultModal(vaultBtn);
      });
    }
    if (dmOpenVaultBtn && vaultModal) {
      dmOpenVaultBtn.addEventListener('click', function () {
        openVaultModal(dmOpenVaultBtn);
      });
    }
    if (closeVaultBtn && vaultModal) {
      closeVaultBtn.addEventListener('click', closeVaultModal);
    }

    // Clubhouse Behavior Covenant modal
    var joinClubhouseBtn = el('btn-join-clubhouse');
    if (joinClubhouseBtn) {
      joinClubhouseBtn.addEventListener('click', function () {
        if (typeof UI.handleClubhouseOptToggle === 'function') {
          UI.handleClubhouseOptToggle(true, joinClubhouseBtn);
        }
      });
    }

    var openCovenantBtn = el('btn-open-covenant');
    var covenantModal = el('ch-covenant-modal');
    var closeCovenantBtn = el('btn-close-covenant-modal');
    var doneCovenantBtn = el('btn-done-covenant-modal');
    if (openCovenantBtn) openCovenantBtn.addEventListener('click', function () { openCovenantModal(openCovenantBtn); });
    if (closeCovenantBtn) closeCovenantBtn.addEventListener('click', closeCovenantModal);
    if (doneCovenantBtn) doneCovenantBtn.addEventListener('click', closeCovenantModal);
    if (covenantModal) {
      covenantModal.addEventListener('click', function (ev) {
        if (ev.target === covenantModal) closeCovenantModal();
      });
    }

    // DM / Private Board Key Fingerprint & Safety Number modal
    var verifyKeyBtn = el('btn-dm-verify-key');
    var verifyModal = el('ch-verify-modal');
    var closeVerifyBtn = el('btn-close-verify-modal');
    var doneVerifyBtn = el('btn-done-verify-modal');
    var copySafetyBtn = el('btn-copy-safety-number');
    if (verifyKeyBtn) {
      verifyKeyBtn.addEventListener('click', function () { openVerifyKeysModal(verifyKeyBtn); });
    }
    if (closeVerifyBtn && verifyModal) {
      closeVerifyBtn.addEventListener('click', closeVerifyModal);
    }
    if (doneVerifyBtn && verifyModal) {
      doneVerifyBtn.addEventListener('click', closeVerifyModal);
    }
    if (copySafetyBtn) {
      copySafetyBtn.addEventListener('click', function () {
        var safetyEl = el('ch-verify-safety-number');
        var statusEl = el('ch-verify-status-msg');
        var val = (safetyEl && safetyEl.textContent) ? safetyEl.textContent.trim() : '';
        if (!val) return;
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(val).then(function () {
            if (statusEl) statusEl.textContent = '✓ Safety number copied to clipboard.';
          }).catch(function () {});
        }
      });
    }
    var relayToggleEl = el('ch-privacy-relay-toggle');
    if (relayToggleEl) {
      if (typeof UI.syncPrivacyRelayToggleUi === 'function') UI.syncPrivacyRelayToggleUi();
      relayToggleEl.addEventListener('change', function () {
        var turnOk = typeof UI.isClubhouseTurnConfigured === 'function' ? UI.isClubhouseTurnConfigured() : false;
        if (!turnOk) {
          relayToggleEl.checked = false;
          relayToggleEl.disabled = true;
          if (RtcEngine && RtcEngine.state) {
            RtcEngine.state.privacyRelayMode = false;
          }
          if (typeof UI.syncPrivacyRelayToggleUi === 'function') UI.syncPrivacyRelayToggleUi();
          return;
        }
        if (RtcEngine && RtcEngine.state) {
          RtcEngine.state.privacyRelayMode = relayToggleEl.checked;
        }
      });
    }
    if (enrollBtn) {
      enrollBtn.addEventListener('click', function () {
        var passInput = el('ch-vault-passphrase');
        var relayToggle = el('ch-privacy-relay-toggle');
        var statusEl = el('ch-vault-status-msg');
        var pass = passInput ? passInput.value : '';
        if (!pass || pass.length < 6) {
          if (statusEl) statusEl.textContent = 'Please enter a recovery passphrase of at least 6 characters.';
          return;
        }
        if (statusEl) statusEl.textContent = 'Generating ECDH/ECDSA P-256 keys & deriving 600,000-iteration PBKDF2 vault...';
        var turnOk = typeof UI.isClubhouseTurnConfigured === 'function' ? UI.isClubhouseTurnConfigured() : false;
        var usePrivacyRelay = Boolean(turnOk && relayToggle && !relayToggle.disabled && relayToggle.checked);
        CryptoEngine.enrollIdentityWithPassphrase(pass, usePrivacyRelay).then(function () {
          if (statusEl) statusEl.textContent = '✓ E2EE Identity Keys enrolled & encrypted backup vault stored!';
          Store.clearCachedDmKeys();
          return Store.redecryptChannelMessages(uiState.activeChannelId);
        }).then(function () {
          if (typeof UI.renderMessageStream === 'function') UI.renderMessageStream(null);
          refreshDmE2eeNotice(null);
          refreshOwnVaultFingerprint();
          refreshVerifyKeyButton(null);
        }).catch(function (err) {
          if (statusEl) statusEl.textContent = 'Error: ' + err.message;
        });
      });
    }
    if (restoreBtn) {
      restoreBtn.addEventListener('click', function () {
        var passInput = el('ch-vault-passphrase');
        var statusEl = el('ch-vault-status-msg');
        var pass = passInput ? passInput.value : '';
        if (!pass) {
          if (statusEl) statusEl.textContent = 'Enter your recovery passphrase to unwrap your key vault.';
          return;
        }
        if (statusEl) statusEl.textContent = 'Unwrapping PBKDF2-SHA256 vault...';
        CryptoEngine.restoreIdentityFromServerVault(pass).then(function () {
          if (statusEl) statusEl.textContent = '✓ E2EE Private Keys restored to local IndexedDB!';
          Store.clearCachedDmKeys();
          return Store.redecryptChannelMessages(uiState.activeChannelId);
        }).then(function () {
          if (typeof UI.renderMessageStream === 'function') UI.renderMessageStream(null);
          refreshDmE2eeNotice(null);
          refreshOwnVaultFingerprint();
          refreshVerifyKeyButton(null);
        }).catch(function (err) {
          if (statusEl) statusEl.textContent = 'Restore failed: ' + err.message;
        });
      });
    }
  }

  Object.assign(UI, {
    openVaultModal: openVaultModal,
    closeVaultModal: closeVaultModal,
    closeVerifyModal: closeVerifyModal,
    openCovenantModal: openCovenantModal,
    closeCovenantModal: closeCovenantModal,
    refreshDmE2eeNotice: refreshDmE2eeNotice,
    refreshVerifyKeyButton: refreshVerifyKeyButton,
    openVerifyKeysModal: openVerifyKeysModal,
    refreshOwnVaultFingerprint: refreshOwnVaultFingerprint,
    buildSystemAuditCardHtml: buildSystemAuditCardHtml,
    initE2eeUiDomEvents: initE2eeUiDomEvents
  });
})();
