/**
 * tests/clubhouse/tier6-peer-blocking.test.js
 * Tier 6: Bidirectional Member-to-Member Peer Block Enforcement API Tests (#43 / ADR-0002)
 */

const assert = require('node:assert/strict');

module.exports = async function runTier6(t, ctx) {
  let generalChannelId = null;
  let announcementsChannelId = null;
  let existingDmId = null;
  let existingDmMsgId = null;

  await t.test('T6.1: Setup channels and baseline 1:1 DM before blocking', async () => {
    const bootRes = await ctx.apiReq('GET', '/api/bootstrap', ctx.playerCookie);
    assert.equal(bootRes.status, 200);
    assert.ok(Array.isArray(bootRes.data.blocked_user_ids), '/api/bootstrap must expose blocked_user_ids array');

    const general = (bootRes.data.channels || []).find((c) => c.slug === 'general');
    const announcements = (bootRes.data.channels || []).find((c) => c.slug === 'announcements');
    assert.ok(general, '#general channel must exist');
    assert.ok(announcements, '#announcements channel must exist');
    generalChannelId = general.id;
    announcementsChannelId = announcements.id;

    // Create or open 1:1 DM between player and facilitator
    const dmRes = await ctx.apiReq('POST', '/api/channels', ctx.playerCookie, {
      channel_type: 'dm',
      dm_user_id: ctx.facilitatorUser.id
    });
    assert.ok(dmRes.status === 200 || dmRes.status === 201);
    existingDmId = dmRes.data.channel.id;

    // Seed one encrypted DM message before blocking
    const msgRes = await ctx.apiReq('POST', `/api/channels/${existingDmId}/messages`, ctx.facilitatorCookie, {
      content: 'Y2lwaGVydGV4dC1iZWZvcmUtYmxvY2s=',
      iv: 'AAAAAAAAAAAAAAAA'
    });
    assert.equal(msgRes.status, 201);
    existingDmMsgId = msgRes.data.message.id;
  });

  await t.test('T6.2: Auth guards, input validation, opt-out & muted-user safety on /api/blocks', async () => {
    // Unauthenticated calls -> 401
    assert.equal((await ctx.apiReq('GET', '/api/blocks')).status, 401);
    assert.equal((await ctx.apiReq('POST', '/api/blocks', null, { blocked_user_id: ctx.facilitatorUser.id })).status, 401);
    assert.equal((await ctx.apiReq('DELETE', `/api/blocks/${ctx.facilitatorUser.id}`)).status, 401);

    // Self-block rejected -> 400
    const selfBlock = await ctx.apiReq('POST', '/api/blocks', ctx.playerCookie, {
      blocked_user_id: ctx.playerUser.id
    });
    assert.equal(selfBlock.status, 400);

    // Invalid IDs -> 400, nonexistent user -> 404
    const invalidPost = await ctx.apiReq('POST', '/api/blocks', ctx.playerCookie, { blocked_user_id: 'not-an-id' });
    assert.equal(invalidPost.status, 400);

    const missingTarget = await ctx.apiReq('POST', '/api/blocks', ctx.playerCookie, { blocked_user_id: 999999 });
    assert.equal(missingTarget.status, 404);

    const invalidDel = await ctx.apiReq('DELETE', '/api/blocks/abc', ctx.playerCookie);
    assert.equal(invalidDel.status, 400);

    // Opted-out user rejected on /api/blocks and gets empty blocked_user_ids on /api/bootstrap
    await ctx.apiReq('PUT', '/api/auth/clubhouse-opt-in', ctx.playerCookie, { opted_in: false });
    try {
      const optedOutBoot = await ctx.apiReq('GET', '/api/bootstrap', ctx.playerCookie);
      assert.equal(optedOutBoot.status, 200);
      assert.deepEqual(optedOutBoot.data.blocked_user_ids, []);

      const optedOutGet = await ctx.apiReq('GET', '/api/blocks', ctx.playerCookie);
      assert.equal(optedOutGet.status, 403);
      assert.equal(optedOutGet.data.code, 'CLUBHOUSE_OPT_OUT');

      const optedOutPost = await ctx.apiReq('POST', '/api/blocks', ctx.playerCookie, { blocked_user_id: ctx.facilitatorUser.id });
      assert.equal(optedOutPost.status, 403);
      assert.equal(optedOutPost.data.code, 'CLUBHOUSE_OPT_OUT');

      const optedOutDel = await ctx.apiReq('DELETE', `/api/blocks/${ctx.facilitatorUser.id}`, ctx.playerCookie);
      assert.equal(optedOutDel.status, 403);
      assert.equal(optedOutDel.data.code, 'CLUBHOUSE_OPT_OUT');
    } finally {
      await ctx.apiReq('PUT', '/api/auth/clubhouse-opt-in', ctx.playerCookie, { opted_in: true });
    }

    // Chat-muted user can STILL block/unblock for personal safety
    await ctx.apiReq('PUT', `/api/moderation/users/${ctx.playerUser.id}/mute`, ctx.adminCookie, {
      muted: true,
      reason: 'Verify muted user retains peer block safety control'
    });
    try {
      const mutedBlock = await ctx.apiReq('POST', '/api/blocks', ctx.playerCookie, {
        blocked_user_id: ctx.facilitatorUser.id
      });
      assert.equal(mutedBlock.status, 201);
      assert.ok(mutedBlock.data.blocked_user_ids.includes(ctx.facilitatorUser.id));

      const mutedUnblock = await ctx.apiReq('DELETE', `/api/blocks/${ctx.facilitatorUser.id}`, ctx.playerCookie);
      assert.equal(mutedUnblock.status, 200);
      assert.ok(!mutedUnblock.data.blocked_user_ids.includes(ctx.facilitatorUser.id));
    } finally {
      await ctx.apiReq('PUT', `/api/moderation/users/${ctx.playerUser.id}/mute`, ctx.adminCookie, { muted: false });
    }
  });

  await t.test('T6.3: Block/List/Unblock lifecycle & bootstrap/sync privacy isolation', async () => {
    // Player blocks facilitator
    const blockRes = await ctx.apiReq('POST', '/api/blocks', ctx.playerCookie, {
      blocked_user_id: ctx.facilitatorUser.id
    });
    assert.equal(blockRes.status, 201);
    assert.equal(blockRes.data.blocked_user_id, ctx.facilitatorUser.id);
    assert.ok(blockRes.data.blocked_user_ids.includes(ctx.facilitatorUser.id));

    // Idempotent repeat block
    const repeatRes = await ctx.apiReq('POST', '/api/blocks', ctx.playerCookie, {
      blocked_id: ctx.facilitatorUser.id
    });
    assert.equal(repeatRes.status, 201);
    assert.equal(repeatRes.data.blocked_user_ids.filter((id) => Number(id) === Number(ctx.facilitatorUser.id)).length, 1);

    // GET /api/blocks reflects block for blocker, empty for blocked target
    const listBlocker = await ctx.apiReq('GET', '/api/blocks', ctx.playerCookie);
    assert.equal(listBlocker.status, 200);
    assert.ok(listBlocker.data.blocked_user_ids.includes(ctx.facilitatorUser.id));
    assert.ok(listBlocker.data.blocked_users.some((u) => Number(u.blocked_id) === Number(ctx.facilitatorUser.id)));

    const listBlocked = await ctx.apiReq('GET', '/api/blocks', ctx.facilitatorCookie);
    assert.equal(listBlocked.status, 200);
    assert.ok(!listBlocked.data.blocked_user_ids.includes(ctx.playerUser.id), 'Blocked peer must not see blocker in own block list');

    // Bootstrap exposes blocked_user_ids only to blocker
    const bootBlocker = await ctx.apiReq('GET', '/api/bootstrap', ctx.playerCookie);
    assert.equal(bootBlocker.status, 200);
    assert.ok(bootBlocker.data.blocked_user_ids.includes(ctx.facilitatorUser.id));

    const bootBlocked = await ctx.apiReq('GET', '/api/bootstrap', ctx.facilitatorCookie);
    assert.equal(bootBlocked.status, 200);
    assert.ok(!bootBlocked.data.blocked_user_ids.includes(ctx.playerUser.id));

    // Non-idle /api/sync includes blocked_user_ids for blocker
    const syncBlocker = await ctx.apiReq('GET', '/api/sync?since_msg_id=0&since_event_id=0', ctx.playerCookie);
    assert.equal(syncBlocker.status, 200);
    assert.ok(Array.isArray(syncBlocker.data.blocked_user_ids));
    assert.ok(syncBlocker.data.blocked_user_ids.includes(ctx.facilitatorUser.id));
  });

  await t.test('T6.4: Bidirectional 1:1 DM enforcement (create, unhide, send, edit, react)', async () => {
    // Player currently blocks facilitator (from T6.3).
    // 1. Both directions blocked from sending messages in existing 1:1 DM (and 0 CHAT_DB writes on rejection)
    const origPrepare = ctx.chatD1.prepare.bind(ctx.chatD1);
    let chatWrites = 0;
    ctx.chatD1.prepare = (sql) => {
      const stmt = origPrepare(sql);
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(String(sql || ''))) {
        const origRun = stmt.run.bind(stmt);
        stmt.run = async (...args) => {
          chatWrites += 1;
          return origRun(...args);
        };
      }
      return stmt;
    };
    let facSendDm;
    try {
      facSendDm = await ctx.apiReq('POST', `/api/channels/${existingDmId}/messages`, ctx.facilitatorCookie, {
        content: 'YmxvY2tlZC1kbS1tZXNzYWdl',
        iv: 'AAAAAAAAAAAAAAAA'
      });
    } finally {
      ctx.chatD1.prepare = origPrepare;
    }
    assert.equal(facSendDm.status, 403);
    assert.equal(facSendDm.data.code, 'PEER_BLOCKED');
    assert.equal(chatWrites, 0, 'Blocked DM rejection must perform 0 CHAT_DB writes');

    const playerSendDm = await ctx.apiReq('POST', `/api/channels/${existingDmId}/messages`, ctx.playerCookie, {
      content: 'YmxvY2tlZC1kbS1tZXNzYWdl',
      iv: 'AAAAAAAAAAAAAAAA'
    });
    assert.equal(playerSendDm.status, 403);
    assert.equal(playerSendDm.data.code, 'PEER_BLOCKED');

    // 2. Editing & reacting inside blocked 1:1 DM rejected
    const editDmMsg = await ctx.apiReq('PATCH', `/api/messages/${existingDmMsgId}`, ctx.facilitatorCookie, {
      content: 'ZWRpdGVkLWFmdGVyLWJsb2Nr',
      iv: 'BBBBBBBBBBBBBBBB'
    });
    assert.equal(editDmMsg.status, 403);
    assert.equal(editDmMsg.data.code, 'PEER_BLOCKED');

    const reactDmMsg = await ctx.apiReq('POST', `/api/messages/${existingDmMsgId}/reactions`, ctx.facilitatorCookie, {
      emoji: '👋'
    });
    assert.equal(reactDmMsg.status, 403);
    assert.equal(reactDmMsg.data.code, 'PEER_BLOCKED');

    // 3. Hiding the 1:1 DM still works, while unhiding via /unhide or POST /api/channels is blocked in both directions
    const hideRes = await ctx.apiReq('POST', `/api/channels/${existingDmId}/hide`, ctx.playerCookie, {});
    assert.equal(hideRes.status, 200);

    const unhideBlocker = await ctx.apiReq('POST', `/api/channels/${existingDmId}/unhide`, ctx.playerCookie, {});
    assert.equal(unhideBlocker.status, 403);
    assert.equal(unhideBlocker.data.code, 'PEER_BLOCKED');

    const reopenViaChannelsBlocker = await ctx.apiReq('POST', '/api/channels', ctx.playerCookie, {
      channel_type: 'dm',
      dm_user_id: ctx.facilitatorUser.id
    });
    assert.equal(reopenViaChannelsBlocker.status, 403);
    assert.equal(reopenViaChannelsBlocker.data.code, 'PEER_BLOCKED');

    const reopenViaChannelsBlocked = await ctx.apiReq('POST', '/api/channels', ctx.facilitatorCookie, {
      channel_type: 'dm',
      dm_user_id: ctx.playerUser.id
    });
    assert.equal(reopenViaChannelsBlocked.status, 403);
    assert.equal(reopenViaChannelsBlocked.data.code, 'PEER_BLOCKED');

    // Also test a brand-new never-created 1:1 DM pair (facilitator <-> admin)
    const blockAdmin = await ctx.apiReq('POST', '/api/blocks', ctx.facilitatorCookie, {
      blocked_user_id: ctx.adminUser.id
    });
    assert.equal(blockAdmin.status, 201);
    try {
      const createNewDmBlocked = await ctx.apiReq('POST', '/api/channels', ctx.adminCookie, {
        channel_type: 'dm',
        dm_user_id: ctx.facilitatorUser.id
      });
      assert.equal(createNewDmBlocked.status, 403);
      assert.equal(createNewDmBlocked.data.code, 'PEER_BLOCKED');

      const createNewDmBlocker = await ctx.apiReq('POST', '/api/channels', ctx.facilitatorCookie, {
        channel_type: 'dm',
        dm_user_id: ctx.adminUser.id
      });
      assert.equal(createNewDmBlocker.status, 403);
      assert.equal(createNewDmBlocker.data.code, 'PEER_BLOCKED');
    } finally {
      await ctx.apiReq('DELETE', `/api/blocks/${ctx.adminUser.id}`, ctx.facilitatorCookie);
    }
  });

  await t.test('T6.5: Bidirectional WebRTC signaling & DM voice rejection + sync signal filtering', async () => {
    // Player still blocks facilitator. Both join shared voice channel #dugout-voice
    const joinPlayer = await ctx.apiReq('POST', '/api/voice/dugout-voice/join', ctx.playerCookie, {});
    const joinFac = await ctx.apiReq('POST', '/api/voice/dugout-voice/join', ctx.facilitatorCookie, {});
    const joinAdmin = await ctx.apiReq('POST', '/api/voice/dugout-voice/join', ctx.adminCookie, {});
    assert.equal(joinPlayer.status, 200);
    assert.equal(joinFac.status, 200);
    assert.equal(joinAdmin.status, 200);

    try {
      const sdpPayload = JSON.stringify({ type: 'offer', sdp: 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' });

      // Blocked peer -> blocker signal rejected
      const facToPlayer = await ctx.apiReq('POST', '/api/rtc/signal', ctx.facilitatorCookie, {
        channel_id: 'dugout-voice',
        recipient_user_id: ctx.playerUser.id,
        signal_type: 'offer',
        payload_json: sdpPayload
      });
      assert.equal(facToPlayer.status, 403);
      assert.equal(facToPlayer.data.code, 'PEER_BLOCKED');

      // Blocker -> blocked peer signal rejected
      const playerToFac = await ctx.apiReq('POST', '/api/rtc/signal', ctx.playerCookie, {
        channel_id: 'dugout-voice',
        recipient_user_id: ctx.facilitatorUser.id,
        signal_type: 'offer',
        payload_json: sdpPayload
      });
      assert.equal(playerToFac.status, 403);
      assert.equal(playerToFac.data.code, 'PEER_BLOCKED');

      // Unblocked peer (admin) can still exchange signals with player in same voice lounge
      const playerToAdmin = await ctx.apiReq('POST', '/api/rtc/signal', ctx.playerCookie, {
        channel_id: 'dugout-voice',
        recipient_user_id: ctx.adminUser.id,
        signal_type: 'offer',
        payload_json: sdpPayload
      });
      assert.equal(playerToAdmin.status, 200);

      // Joining voice in a blocked 1:1 DM is also rejected
      const dmVoiceJoin = await ctx.apiReq('POST', `/api/voice/${existingDmId}/join`, ctx.facilitatorCookie, {});
      assert.equal(dmVoiceJoin.status, 403);
      assert.equal(dmVoiceJoin.data.code, 'PEER_BLOCKED');

      // Pre-existing signal inserted before block is suppressed in /api/sync
      const nowSec = Math.floor(Date.now() / 1000);
      const voiceCh = ctx.chatDb.prepare("SELECT id FROM channels WHERE slug = 'dugout-voice-huddle' OR slug = 'dugout-voice'").get();
      const insSig = ctx.chatDb.prepare(
        'INSERT INTO rtc_signals (channel_id, sender_user_id, recipient_user_id, signal_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(voiceCh.id, ctx.facilitatorUser.id, ctx.playerUser.id, 'offer', sdpPayload, nowSec);

      const syncRes = await ctx.apiReq('GET', '/api/sync?since_msg_id=0&since_event_id=0&since_signal_id=0', ctx.playerCookie);
      assert.equal(syncRes.status, 200);
      assert.ok(
        !(syncRes.data.rtc_signals || []).some((s) => Number(s.id) === Number(insSig.lastInsertRowid)),
        'Sync must not deliver rtc_signals from a blocked peer'
      );
    } finally {
      await ctx.apiReq('POST', '/api/voice/dugout-voice/leave', ctx.playerCookie, {});
      await ctx.apiReq('POST', '/api/voice/dugout-voice/leave', ctx.facilitatorCookie, {});
      await ctx.apiReq('POST', '/api/voice/dugout-voice/leave', ctx.adminCookie, {});
    }
  });

  await t.test('T6.6: Announcement boards, group DMs, Moderator actions & user_mutes remain unaffected', async () => {
    // 1. Player blocks admin, yet admin's announcement post still succeeds and is visible to player
    const blockAdminRes = await ctx.apiReq('POST', '/api/blocks', ctx.playerCookie, {
      blocked_user_id: ctx.adminUser.id
    });
    assert.equal(blockAdminRes.status, 201);

    try {
      const annPost = await ctx.apiReq('POST', `/api/channels/${announcementsChannelId}/messages`, ctx.adminCookie, {
        content: 'Field #1 rain delay update for all members'
      });
      assert.equal(annPost.status, 201);
      const annMsgId = annPost.data.message.id;

      const annRead = await ctx.apiReq('GET', `/api/channels/${announcementsChannelId}/messages`, ctx.playerCookie);
      assert.equal(annRead.status, 200);
      assert.ok(
        annRead.data.messages.some((m) => Number(m.id) === Number(annMsgId)),
        'Announcement board messages must never be suppressed by Peer Block'
      );

      // 2. Shared #general channel messages and Moderator actions remain unaffected
      const genPost = await ctx.apiReq('POST', `/api/channels/${generalChannelId}/messages`, ctx.facilitatorCookie, {
        content: 'Shared #general message while blocked by player'
      });
      assert.equal(genPost.status, 201);
      const genMsgId = genPost.data.message.id;

      // Blocker can still report a message from a blocked peer (in DM or shared channel)
      const reportRes = await ctx.apiReq('POST', '/api/reports', ctx.playerCookie, {
        target_type: 'message',
        message_id: existingDmMsgId,
        reason: 'Reporting blocked peer DM message for moderator review'
      });
      assert.equal(reportRes.status, 201);

      // Admin/Moderator can still view report, hide/unhide blocked peer's message, and mute
      const modReports = await ctx.apiReq('GET', '/api/moderation/reports?status=open', ctx.adminCookie);
      assert.equal(modReports.status, 200);
      assert.ok(modReports.data.reports.some((r) => Number(r.id) === Number(reportRes.data.report.id)));

      const hideMod = await ctx.apiReq('POST', `/api/messages/${genMsgId}/hide`, ctx.adminCookie, {
        reason: 'Moderator enforcement works even if target blocked moderator'
      });
      assert.equal(hideMod.status, 200);
      await ctx.apiReq('POST', `/api/messages/${genMsgId}/unhide`, ctx.adminCookie, {});
      await ctx.apiReq('PATCH', `/api/moderation/reports/${reportRes.data.report.id}`, ctx.adminCookie, {
        status: 'resolved',
        resolution_note: 'Reviewed'
      });

      // 3. Group DM with 3rd member still works; hiding group DM does NOT auto-unhide on blocked sender's message
      const groupDmRes = await ctx.apiReq('POST', '/api/channels', ctx.adminCookie, {
        channel_type: 'group_dm',
        name: 'Team Captains',
        member_ids: [ctx.playerUser.id, ctx.facilitatorUser.id]
      });
      assert.ok(groupDmRes.status === 200 || groupDmRes.status === 201);
      const groupDmId = groupDmRes.data.channel.id;

      await ctx.apiReq('POST', `/api/channels/${groupDmId}/hide`, ctx.playerCookie, {});
      const gdmPost = await ctx.apiReq('POST', `/api/channels/${groupDmId}/messages`, ctx.facilitatorCookie, {
        content: 'Z3JvdXAtZG0tbXNn',
        iv: 'CCCCCCCCCCCCCCCC'
      });
      assert.equal(gdmPost.status, 201);

      const playerBoot = await ctx.apiReq('GET', '/api/bootstrap', ctx.playerCookie);
      assert.ok(
        !(playerBoot.data.channels || []).some((ch) => Number(ch.id) === Number(groupDmId)),
        'Blocked sender must not auto-unhide a hidden group DM for the blocker'
      );

      // 4. Personal user_mutes stays independent from user_blocks
      const muteRes = await ctx.apiReq('POST', '/api/mutes', ctx.playerCookie, { muted_user_id: ctx.facilitatorUser.id });
      assert.equal(muteRes.status, 201);
      const unmuteRes = await ctx.apiReq('DELETE', `/api/mutes/${ctx.facilitatorUser.id}`, ctx.playerCookie);
      assert.equal(unmuteRes.status, 200);
      const blocksStillPresent = await ctx.apiReq('GET', '/api/blocks', ctx.playerCookie);
      assert.ok(blocksStillPresent.data.blocked_user_ids.includes(ctx.facilitatorUser.id), 'Unmuting must not remove peer block');
    } finally {
      await ctx.apiReq('DELETE', `/api/blocks/${ctx.adminUser.id}`, ctx.playerCookie);
    }
  });

  await t.test('T6.7: Unblocking restores 1:1 DM & WebRTC signaling cleanly', async () => {
    const unblockRes = await ctx.apiReq('DELETE', `/api/blocks/${ctx.facilitatorUser.id}`, ctx.playerCookie);
    assert.equal(unblockRes.status, 200);
    assert.ok(!unblockRes.data.blocked_user_ids.includes(ctx.facilitatorUser.id));

    // Unhiding / reopening existing 1:1 DM now succeeds
    const unhideRes = await ctx.apiReq('POST', `/api/channels/${existingDmId}/unhide`, ctx.playerCookie, {});
    assert.equal(unhideRes.status, 200);
    assert.equal(unhideRes.data.hidden, false);

    // Sending 1:1 DM message now succeeds
    const dmAfterUnblock = await ctx.apiReq('POST', `/api/channels/${existingDmId}/messages`, ctx.facilitatorCookie, {
      content: 'dW5ibG9ja2VkLWRt',
      iv: 'DDDDDDDDDDDDDDDD'
    });
    assert.equal(dmAfterUnblock.status, 201);

    // WebRTC signal now succeeds
    await ctx.apiReq('POST', '/api/voice/dugout-voice/join', ctx.playerCookie, {});
    await ctx.apiReq('POST', '/api/voice/dugout-voice/join', ctx.facilitatorCookie, {});
    try {
      const sigAfterUnblock = await ctx.apiReq('POST', '/api/rtc/signal', ctx.facilitatorCookie, {
        channel_id: 'dugout-voice',
        recipient_user_id: ctx.playerUser.id,
        signal_type: 'offer',
        payload_json: JSON.stringify({ type: 'offer', sdp: 'v=0\r\no=- 456 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' })
      });
      assert.equal(sigAfterUnblock.status, 200);
      assert.equal(sigAfterUnblock.data.success, true);
    } finally {
      await ctx.apiReq('POST', '/api/voice/dugout-voice/leave', ctx.playerCookie, {});
      await ctx.apiReq('POST', '/api/voice/dugout-voice/leave', ctx.facilitatorCookie, {});
    }

    // Deleting a user cleans up their user_blocks rows in CHAT_DB
    const tempEmail = `block-cleanup-${Date.now()}@pickupbaseball.org`;
    const tempIns = ctx.baseballDb.prepare(
      "INSERT INTO users (name, email, role, is_admin, clubhouse_opted_in) VALUES ('Temp Peer', ?, 'member', 0, 1)"
    ).run(tempEmail);
    const tempId = Number(tempIns.lastInsertRowid);
    const blkTemp = await ctx.apiReq('POST', '/api/blocks', ctx.playerCookie, { blocked_user_id: tempId });
    assert.equal(blkTemp.status, 201);
    assert.equal(ctx.chatDb.prepare('SELECT COUNT(*) as c FROM user_blocks WHERE blocked_id = ?').get(tempId).c, 1);

    const delUserRes = await ctx.apiReq('DELETE', `/api/auth/users/${tempId}`, ctx.adminCookie);
    assert.equal(delUserRes.status, 200);
    assert.equal(ctx.chatDb.prepare('SELECT COUNT(*) as c FROM user_blocks WHERE blocked_id = ? OR blocker_id = ?').get(tempId, tempId).c, 0);
  });
};
