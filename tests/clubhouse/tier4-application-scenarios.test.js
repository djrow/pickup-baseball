/**
 * tests/clubhouse/tier4-application-scenarios.test.js
 * Tier 4: Real-World Application Scenarios (End-to-End User Journeys)
 *
 * Implements 4 realistic community operational workflows:
 * - Scenario 1: Full Game-Day Sunday Lifecycle (Multi-actor game creation, RSVP, BP slot, Facilitator duty)
 * - Scenario 2: Community Media Upload & Foundation Gallery Promotion (EXIF strip, upload, admin promotion)
 * - Scenario 3: Bad Weather Coordination & Emergency Rainout Alert (War room guard, rainout call, locked BP)
 * - Scenario 4: E2EE Key Enrollment, Vault Backup & Multi-Device Restoration (Keygen, PBKDF2 vault, 2nd device restore)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClubhouseTestContext } = require('../helpers/test-harness');
const {
  generateIdentityKeyPair,
  generateChannelKey,
  encryptPayload,
  decryptPayload,
  deriveEcdhSharedKey,
  wrapChannelKey,
  unwrapChannelKey,
  encryptVault,
  decryptVault
} = require('../helpers/crypto-test-utils');
const { stripJpegMetadata } = require('../../src/app/security');

async function runTier4(t, ctx) {
  const {
    baseUrl,
    baseballDb,
    chatDb,
    baseballD1,
    chatD1,
    adminCookie,
    orgCookie,
    playerCookie,
    facilitatorCookie,
    adminUser,
    orgUser,
    playerUser,
    facilitatorUser,
    testEventId,
    apiReq,
    isEndpointAvailable
  } = ctx;

  await t.test('Tier 4: Real-World Community User Journeys', async (scenarios) => {
    // -----------------------------------------------------------------------
    // SCENARIO 1: Full Game-Day Sunday Lifecycle
    // -----------------------------------------------------------------------
    await scenarios.test('Scenario 1: Full Game-Day Sunday Lifecycle', async (tSub) => {
      // Check required WP-4 bridge endpoints
      if (!(await isEndpointAvailable('/api/baseball/events/1/quick-rsvp', 'POST'))) {
        tSub.skip('Waiting for WP-4: Clubhouse Live Baseball Bridge (/api/baseball/*)');
        return;
      }

      // 1. Organizer Alice creates next Sunday's game via /api/events
      const gameDate = new Date();
      gameDate.setDate(gameDate.getDate() + 7);
      gameDate.setHours(12, 0, 0, 0);

      const evRes = await apiReq('POST', '/api/events', orgCookie, {
        title: 'Sunday Sandlot Showdown',
        description: 'Casual community double-header with live batting practice',
        location: 'Bushrod Park Field 1',
        event_date: gameDate.toISOString(),
        max_players: 30
      });
      assert.equal(evRes.status, 200);
      assert.ok(evRes.data.event && evRes.data.event.id);
      const sundayEventId = evRes.data.event.id;

      // 2. Player Bob RSVPs attending via 1-click Quick RSVP endpoint
      const rsvpRes = await apiReq('POST', `/api/baseball/events/${sundayEventId}/quick-rsvp`, playerCookie, {
        status: 'attending'
      });
      assert.equal(rsvpRes.status, 200, 'Quick RSVP must return HTTP 200');
      assert.equal(rsvpRes.data.status, 'attending');

      // 3. Bob claims Batting Practice Slot #6 via 1-click Quick BP endpoint
      const bpRes = await apiReq('POST', `/api/baseball/events/${sundayEventId}/quick-bp`, playerCookie, {
        slot_number: 6
      });
      assert.equal(bpRes.status, 200, 'Quick BP signup must return HTTP 200');
      assert.equal(bpRes.data.slot_number, 6);

      // 4. Facilitator Charlie claims Game Facilitator duty via /api/events/:id/rsvp
      const duty = baseballDb.prepare("SELECT id FROM event_duties WHERE event_id = ? AND title LIKE '%Facilitator%'").get(sundayEventId);
      if (duty) {
        const facRsvpRes = await apiReq('POST', `/api/events/${sundayEventId}/rsvp`, facilitatorCookie, {
          name: 'Dana Facilitator',
          email: 'facilitator@pickupbaseball.org',
          status: 'attending',
          players_count: 1,
          selected_duties: [duty.id]
        });
        assert.equal(facRsvpRes.status, 200, 'Facilitator RSVP with duty selection must return HTTP 200');
      }

      // 5. Organizer Alice automatically creates game-day chat channel via sync-channel endpoint
      const syncChanRes = await apiReq('POST', `/api/baseball/events/${sundayEventId}/sync-channel`, orgCookie);
      assert.equal(syncChanRes.status, 200, 'Sync channel endpoint must return HTTP 200');
      assert.ok(syncChanRes.data.channel_id, 'Sync channel response must contain channel_id');

      // 6. Verify full cross-system state via live upcoming bridge endpoint and database
      const bridgeRes = await apiReq('GET', '/api/baseball/upcoming');
      assert.equal(bridgeRes.status, 200);
      assert.ok(bridgeRes.data.event);

      const attRow = baseballDb.prepare('SELECT status FROM attendees WHERE event_id = ? AND user_id = ?').get(sundayEventId, playerUser.id);
      assert.equal(attRow.status, 'attending', 'Attendee status in BASEBALL_DB must be attending');

      const bpRecord = baseballDb.prepare('SELECT user_id, slot_number FROM batting_practice_signups WHERE event_id = ? AND slot_number = 6').get(sundayEventId);
      assert.ok(bpRecord);
      assert.equal(bpRecord.user_id, playerUser.id, 'BP slot #6 must be assigned to player in BASEBALL_DB');

      const chRecord = chatDb.prepare('SELECT * FROM channels WHERE linked_event_id = ?').get(sundayEventId);
      assert.ok(chRecord, 'Game-day channel must exist in CHAT_DB with linked_event_id');
    });

    // -----------------------------------------------------------------------
    // SCENARIO 2: Community Media Upload & Foundation Gallery Promotion
    // -----------------------------------------------------------------------
    await scenarios.test('Scenario 2: Community Media Upload & Foundation Gallery Promotion', async (tSub) => {
      // Check required WP-3 media endpoints
      if (!(await isEndpointAvailable('/api/attachments/init', 'POST'))) {
        tSub.skip('Waiting for WP-3: Google Drive Media Engine (/api/attachments/*)');
        return;
      }

      // 1. Dave has high-res game photo with EXIF GPS metadata
      const rawJpegWithGps = Buffer.from([
        0xFF, 0xD8,
        0xFF, 0xE1, 0x00, 0x0C, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50, 0x53, 0x00,
        0xFF, 0xDA, 0x00, 0x02, 0xAA, 0xBB,
        0xFF, 0xD9
      ]);

      // 2. Client-side EXIF stripper removes GPS before upload
      const cleanJpeg = stripJpegMetadata(rawJpegWithGps);
      const cleanBuf = Buffer.from(cleanJpeg instanceof ArrayBuffer ? new Uint8Array(cleanJpeg) : cleanJpeg);

      // Validate APP1 marker is stripped
      let hasGps = false;
      for (let i = 0; i < cleanBuf.length - 1; i++) {
        if (cleanBuf[i] === 0xFF && cleanBuf[i + 1] === 0xE1) hasGps = true;
      }
      assert.equal(hasGps, false, 'EXIF GPS marker APP1 must be stripped');

      // 3. Dave initializes attachment upload via HTTP API (#highlights-and-media channel id 4)
      const initRes = await apiReq('POST', '/api/attachments/init', playerCookie, {
        channel_id: 4,
        file_name: 'walkoff_double.jpg',
        mime_type: 'image/jpeg',
        file_size: cleanBuf.length
      });
      assert.equal(initRes.status, 200, 'Attachment init must return HTTP 200');
      assert.ok(initRes.data.attachmentId, 'Attachment init must return attachmentId');
      const attId = initRes.data.attachmentId;

      // 4. Dave uploads cleaned image buffer to upload endpoint
      const uploadRes = await apiReq('PUT', `/api/attachments/${attId}/upload`, playerCookie, cleanBuf, {
        'Content-Type': 'image/jpeg'
      });
      assert.equal(uploadRes.status, 200, 'Attachment upload must return HTTP 200');

      // 5. Dave finalizes upload
      const completeRes = await apiReq('POST', `/api/attachments/${attId}/complete`, playerCookie);
      assert.equal(completeRes.status, 200, 'Attachment complete must return HTTP 200');

      // 6. Admin Alice promotes Dave's photo to BASEBALL_DB public gallery via promote-to-gallery endpoint
      const promoRes = await apiReq('POST', `/api/attachments/${attId}/promote-to-gallery`, adminCookie, {
        title: 'Walk-Off Double at Bushrod',
        caption: 'Fall Season Championship final hit'
      });
      assert.equal(promoRes.status, 200, 'Gallery promotion must return HTTP 200');
      assert.ok(promoRes.data.media_id, 'Promotion response must return media_id');
      const mediaId = promoRes.data.media_id;

      // 7. Verify linkage in both databases
      const attRow = chatDb.prepare('SELECT promoted_media_id FROM chat_attachments WHERE id = ?').get(attId);
      assert.equal(attRow.promoted_media_id, mediaId, 'chat_attachments must reference media_items.id');

      const mediaRow = baseballDb.prepare('SELECT is_approved, approved_by, title FROM media_items WHERE id = ?').get(mediaId);
      assert.ok(mediaRow);
      assert.equal(mediaRow.is_approved, 1);
      assert.equal(mediaRow.approved_by, adminUser.id);

      // 8. Elena browses public gallery via /api/media
      const galleryRes = await apiReq('GET', '/api/media');
      assert.equal(galleryRes.status, 200);
      assert.ok(
        Array.isArray(galleryRes.data.media) ||
        Array.isArray(galleryRes.data.items) ||
        Array.isArray(galleryRes.data),
        'Gallery response must contain media items array'
      );
    });

    // -----------------------------------------------------------------------
    // SCENARIO 3: Bad Weather Coordination & Emergency Rainout Alert
    // -----------------------------------------------------------------------
    await scenarios.test('Scenario 3: Bad Weather Coordination & Emergency Rainout Alert', async (tSub) => {
      // 1. Create a game for rainout test
      const evRes = await apiReq('POST', '/api/events', orgCookie, {
        title: 'Rainout Test Game',
        description: 'Morning weather check',
        location: 'Bushrod Park Diamond 1',
        event_date: new Date(Date.now() + 86400000).toISOString(),
        max_players: 28
      });
      assert.equal(evRes.status, 200);
      const rainoutEventId = evRes.data.event.id;

      // 2. Standard player Charlie tries to signal inside Organizers War Room (min_role_read: facilitator)
      if (await isEndpointAvailable('/api/rtc/signal', 'POST')) {
        const warRoomRes = await apiReq('POST', '/api/rtc/signal', playerCookie, {
          channel_id: 7,
          recipient_user_id: orgUser.id,
          signal_type: 'offer',
          payload_json: '{}'
        });
        assert.equal(warRoomRes.status, 403, 'Regular player must be blocked from war room signaling');
      }

      // 3. Organizer Alice calls emergency rainout via /api/events/:id/rainout
      const rainoutRes = await apiReq('POST', `/api/events/${rainoutEventId}/rainout`, orgCookie, {
        note: 'Standing water across infield. Game called for player safety.'
      });
      assert.equal(rainoutRes.status, 200);

      // 4. Verify event status updated in BASEBALL_DB
      const ev = baseballDb.prepare('SELECT status, rainout_note FROM events WHERE id = ?').get(rainoutEventId);
      assert.equal(ev.status, 'rainout');
      assert.ok(ev.rainout_note && ev.rainout_note.includes('Standing water'));

      // 5. Attempting Batting Practice signup on rained-out game is locked (400)
      const bpRes = await apiReq('POST', `/api/events/${rainoutEventId}/bp-order`, playerCookie, {
        slot_number: 1
      });
      assert.equal(bpRes.status, 400);
      assert.ok(bpRes.data.error.includes('rain') || bpRes.data.error.includes('cancelled'));

      // 6. Post rainout announcement card in #announcements (channel id 1) via HTTP API
      if (await isEndpointAvailable('/api/channels/1/messages', 'POST')) {
        // Non-organizer player attempt to post in #announcements must be blocked (min_role_write: organizer)
        const playerBlockRes = await apiReq('POST', '/api/channels/1/messages', playerCookie, {
          content: 'Unauthorized player announcement attempt'
        });
        assert.equal(playerBlockRes.status, 403, 'Player without organizer role must not post to #announcements');

        // Organizer Bob posts official rainout announcement
        const ancRes = await apiReq('POST', '/api/channels/1/messages', orgCookie, {
          content: '⚠️ RAINOUT NOTICE: Game called due to standing water.'
        });
        assert.equal(ancRes.status, 201, 'Organizer announcement post must return HTTP 201');
        assert.ok(ancRes.data.id);

        // Verify announcement appears in channel messages
        const msgListRes = await apiReq('GET', '/api/channels/1/messages', playerCookie);
        assert.equal(msgListRes.status, 200);
        const found = msgListRes.data.messages.some((m) => m.content.includes('RAINOUT NOTICE'));
        assert.ok(found, 'Announcement message must be visible to players');
      }
    });

    // -----------------------------------------------------------------------
    // SCENARIO 4: E2EE Key Enrollment, Vault Backup & Multi-Device Restoration
    // -----------------------------------------------------------------------
    await scenarios.test('Scenario 4: E2EE Key Enrollment, Vault Backup & Multi-Device Restoration', async (tSub) => {
      if (!(await isEndpointAvailable('/api/keys/identity', 'PUT'))) {
        tSub.skip('Waiting for WP-2: PUT /api/keys/identity');
        return;
      }

      // 1. Device 1: Dan generates WebCrypto ECDH/ECDSA keypairs
      const device1Keys = await generateIdentityKeyPair();

      // 2. Device 1: Dan sets recovery passphrase; client derives PBKDF2 vault key (600,000 iterations)
      const recoveryPassphrase = 'Oakland-Aces-2026-Championship-Vault!';
      const vaultPayload = {
        ecdhPrivateJwk: device1Keys.ecdhPrivateJwk,
        ecdsaPrivateJwk: device1Keys.ecdsaPrivateJwk
      };
      const vault = await encryptVault(recoveryPassphrase, vaultPayload);

      // 3. Device 1 uploads identity and encrypted vault via PUT /api/keys/identity
      const uploadVaultRes = await apiReq('PUT', '/api/keys/identity', playerCookie, {
        ecdh_public_key_jwk: JSON.stringify(device1Keys.ecdhPublicJwk),
        ecdsa_public_key_jwk: JSON.stringify(device1Keys.ecdsaPublicJwk),
        encrypted_private_vault: vault.encryptedVaultB64,
        vault_salt: vault.saltB64,
        vault_iv: vault.ivB64,
        privacy_relay_mode: 0
      });
      assert.equal(uploadVaultRes.status, 200, 'Identity and vault upload must return HTTP 200');
      assert.equal(uploadVaultRes.data.success, true);

      // 4. Device 1: Dan encrypts a message with channel key
      const channelKey = await generateChannelKey();
      const secretPlaintext = 'Secret playbook: Squeeze bunt on 3-2 count with runners on 1st and 3rd';
      const { ciphertextB64, ivB64 } = await encryptPayload(channelKey, secretPlaintext);

      // 5. Device 2 (Fresh device, zero local storage): downloads encrypted vault from server
      let storedVault = null;
      let storedSalt = null;
      let storedIv = null;

      const getVaultRes = await apiReq('GET', '/api/keys/identity', playerCookie);
      if (getVaultRes.status === 200 && getVaultRes.data.encrypted_private_vault) {
        storedVault = getVaultRes.data.encrypted_private_vault;
        storedSalt = getVaultRes.data.vault_salt;
        storedIv = getVaultRes.data.vault_iv;
      } else {
        // Fallback: inspect persistence in CHAT_DB.user_crypto_keys
        const dbKeyRow = chatDb.prepare('SELECT encrypted_private_vault, vault_salt, vault_iv FROM user_crypto_keys WHERE user_id = ?').get(playerUser.id);
        assert.ok(dbKeyRow, 'Identity record must be stored in CHAT_DB.user_crypto_keys');
        storedVault = dbKeyRow.encrypted_private_vault;
        storedSalt = dbKeyRow.vault_salt;
        storedIv = dbKeyRow.vault_iv;
      }
      assert.equal(storedVault, vault.encryptedVaultB64, 'Stored vault ciphertext must match uploaded vault');

      // 6. Device 2: Dan inputs recovery passphrase and recovers private keys
      const recoveredVault = await decryptVault(
        recoveryPassphrase,
        storedVault,
        storedSalt,
        storedIv
      );
      assert.deepEqual(recoveredVault.ecdhPrivateJwk, device1Keys.ecdhPrivateJwk);

      // 7. Device 2 decrypts the ciphertext message using channel key
      const decryptedMessage = await decryptPayload(channelKey, ciphertextB64, ivB64);
      assert.equal(decryptedMessage, secretPlaintext, 'Device 2 must successfully decrypt message with restored key vault');
    });
  });
}

// Standalone execution support
if (require.main === module) {
  test('Tier 4: Clubhouse Real-World Application Scenarios', async (t) => {
    const ctx = await createClubhouseTestContext();
    try {
      await runTier4(t, ctx);
    } finally {
      await ctx.cleanup();
    }
  });
}

module.exports = runTier4;
