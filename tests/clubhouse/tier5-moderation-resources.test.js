/**
 * tests/clubhouse/tier5-moderation-resources.test.js
 * Tier 5: Clubhouse Moderation, Delegated Control, Personal Mutes & Resource Frugality Tests
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Wraps D1 `.prepare()` on both test databases for the duration of `fn`
 * to count exact SQL reads and writes per API call.
 */
async function withD1QueryCounter(ctx, fn) {
  const counts = {
    baseballReads: 0,
    baseballWrites: 0,
    chatReads: 0,
    chatWrites: 0,
    queries: []
  };

  const origBaseballPrepare = ctx.baseballD1.prepare.bind(ctx.baseballD1);
  const origChatPrepare = ctx.chatD1.prepare.bind(ctx.chatD1);

  function wrapPrepare(dbLabel, origPrepare) {
    return function wrappedPrepare(sql) {
      const stmt = origPrepare(sql);
      const isWrite = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)/i.test(String(sql || ''));
      const record = () => {
        counts.queries.push({ db: dbLabel, isWrite, sql: String(sql).trim().slice(0, 120) });
        if (dbLabel === 'baseball') {
          if (isWrite) counts.baseballWrites += 1;
          else counts.baseballReads += 1;
        } else {
          if (isWrite) counts.chatWrites += 1;
          else counts.chatReads += 1;
        }
      };
      const origFirst = stmt.first.bind(stmt);
      const origAll = stmt.all.bind(stmt);
      const origRun = stmt.run.bind(stmt);
      stmt.first = async (...args) => { record(); return origFirst(...args); };
      stmt.all = async (...args) => { record(); return origAll(...args); };
      stmt.run = async (...args) => { record(); return origRun(...args); };
      return stmt;
    };
  }

  ctx.baseballD1.prepare = wrapPrepare('baseball', origBaseballPrepare);
  ctx.chatD1.prepare = wrapPrepare('chat', origChatPrepare);
  try {
    const result = await fn(counts);
    return { result, counts };
  } finally {
    ctx.baseballD1.prepare = origBaseballPrepare;
    ctx.chatD1.prepare = origChatPrepare;
  }
}

module.exports = async function runTier5(t, ctx) {
  let generalChannelId = null;
  let customBoardId = null;
  let testMsgId = null;
  let anotherMsgId = null;

  await t.test('T5.1: Setup General channel & seed messages', async () => {
    const res = await ctx.apiReq('GET', '/api/bootstrap', ctx.playerCookie);
    assert.equal(res.status, 200);
    const general = (res.data.channels || []).find((c) => c.slug === 'general') || res.data.channels[0];
    assert.ok(general, 'General channel must exist');
    generalChannelId = general.id;

    const msgRes = await ctx.apiReq('POST', `/api/channels/${generalChannelId}/messages`, ctx.facilitatorCookie, {
      content: 'Original message before moderation check'
    });
    assert.equal(msgRes.status, 201);
    testMsgId = msgRes.data.message.id;

    const msgRes2 = await ctx.apiReq('POST', `/api/channels/${generalChannelId}/messages`, ctx.facilitatorCookie, {
      content: 'Second message for report testing'
    });
    assert.equal(msgRes2.status, 201);
    anotherMsgId = msgRes2.data.message.id;
  });

  await t.test('T5.2: Delegated Moderator permission without Admin ownership transfer', async () => {
    // Non-moderator player cannot moderate or grant moderator
    const unauthModList = await ctx.apiReq('GET', '/api/moderation/users', ctx.playerCookie);
    assert.equal(unauthModList.status, 403);

    const playerTryGrant = await ctx.apiReq('PUT', `/api/auth/users/${ctx.facilitatorUser.id}/moderator`, ctx.playerCookie, {
      is_moderator: true
    });
    assert.equal(playerTryGrant.status, 403);

    // Admin delegates moderator capability to playerUser
    const grantRes = await ctx.apiReq('PUT', `/api/auth/users/${ctx.playerUser.id}/moderator`, ctx.adminCookie, {
      is_moderator: true
    });
    assert.equal(grantRes.status, 200);
    assert.equal(grantRes.data.user.isModerator, true);

    // Player keeps non-admin role, gets isModerator/canModerateChat flags dynamically
    const meRes = await ctx.apiReq('GET', '/api/auth/me', ctx.playerCookie);
    assert.equal(meRes.status, 200);
    assert.equal(meRes.data.user.role, 'player');
    assert.equal(meRes.data.user.isAdmin, false);
    assert.equal(meRes.data.user.isModerator, true);
    assert.equal(meRes.data.user.canModerateChat, true);

    // Delegated moderator CANNOT perform Admin-only ownership actions
    const adminUsersRes = await ctx.apiReq('GET', '/api/auth/users', ctx.playerCookie);
    assert.equal(adminUsersRes.status, 403);

    const roleChangeRes = await ctx.apiReq('PUT', `/api/auth/users/${ctx.facilitatorUser.id}/role`, ctx.playerCookie, {
      role: 'organizer'
    });
    assert.equal(roleChangeRes.status, 403);

    const modTransferRes = await ctx.apiReq('PUT', `/api/auth/users/${ctx.facilitatorUser.id}/moderator`, ctx.playerCookie, {
      is_moderator: true
    });
    assert.equal(modTransferRes.status, 403);

    const deleteUserRes = await ctx.apiReq('DELETE', `/api/auth/users/${ctx.facilitatorUser.id}`, ctx.playerCookie);
    assert.equal(deleteUserRes.status, 403);

    const settingsRes = await ctx.apiReq('PUT', '/api/settings', ctx.playerCookie, { require_login_rsvp: true });
    assert.equal(settingsRes.status, 403);

    // Moderator CAN list moderation roster without PII email addresses
    const modUsersRes = await ctx.apiReq('GET', '/api/moderation/users', ctx.playerCookie);
    assert.equal(modUsersRes.status, 200);
    assert.ok(Array.isArray(modUsersRes.data.users) && modUsersRes.data.users.length > 0);
    for (const u of modUsersRes.data.users) {
      assert.equal(u.email, undefined, 'Moderation user roster must not leak user emails');
    }

    // Delegated moderator CANNOT mute an Admin
    const muteAdminRes = await ctx.apiReq('PUT', `/api/moderation/users/${ctx.adminUser.id}/mute`, ctx.playerCookie, {
      muted: true,
      reason: 'Attempted admin mute'
    });
    assert.equal(muteAdminRes.status, 403);
  });

  await t.test('T5.3: Hide and unhide messages for a stated reason', async () => {
    // Reject missing/short reason
    const badHide = await ctx.apiReq('POST', `/api/messages/${testMsgId}/hide`, ctx.playerCookie, {
      reason: 'no'
    });
    assert.equal(badHide.status, 400);

    // Hide message with stated reason
    const hideRes = await ctx.apiReq('POST', `/api/messages/${testMsgId}/hide`, ctx.playerCookie, {
      reason: 'Off-topic spam in #general'
    });
    assert.equal(hideRes.status, 200);
    assert.equal(hideRes.data.message.hidden_reason, 'Off-topic spam in #general');
    assert.equal(hideRes.data.message.original_content, undefined);

    // Verify masked content for readers and stripped originals
    const listRes = await ctx.apiReq('GET', `/api/channels/${generalChannelId}/messages`, ctx.facilitatorCookie);
    assert.equal(listRes.status, 200);
    const hiddenMsg = listRes.data.messages.find((m) => m.id === testMsgId);
    assert.ok(hiddenMsg);
    assert.ok(hiddenMsg.hidden_at);
    assert.equal(hiddenMsg.hidden_reason, 'Off-topic spam in #general');
    assert.equal(hiddenMsg.content, '[Message hidden by moderator]');
    assert.equal(hiddenMsg.original_content, undefined);
    assert.deepEqual(hiddenMsg.attachments, []);

    // Unhide restores original content
    const unhideRes = await ctx.apiReq('POST', `/api/messages/${testMsgId}/unhide`, ctx.playerCookie);
    assert.equal(unhideRes.status, 200);
    const listAfter = await ctx.apiReq('GET', `/api/channels/${generalChannelId}/messages`, ctx.facilitatorCookie);
    const restored = listAfter.data.messages.find((m) => m.id === testMsgId);
    assert.equal(restored.hidden_at, null);
    assert.equal(restored.content, 'Original message before moderation check');
  });

  await t.test('T5.4: Message Boards — make, edit, protect #general, delete', async () => {
    const createRes = await ctx.apiReq('POST', '/api/channels', ctx.playerCookie, {
      name: 'Equipment Swap',
      category: 'Text Channels',
      channel_type: 'text',
      topic: 'Buy, sell, or lend gloves and bats'
    });
    assert.equal(createRes.status, 201);
    customBoardId = createRes.data.channel.id;

    const editRes = await ctx.apiReq('PATCH', `/api/channels/${customBoardId}`, ctx.playerCookie, {
      name: 'Cleat & Glove Swap',
      topic: 'Updated board topic',
      min_role_write: 'player'
    });
    assert.equal(editRes.status, 200);
    assert.equal(editRes.data.channel.name, 'Cleat & Glove Swap');
    assert.equal(editRes.data.channel.topic, 'Updated board topic');

    // Protect #general from deletion
    const delGeneralRes = await ctx.apiReq('DELETE', `/api/channels/${generalChannelId}`, ctx.adminCookie);
    assert.equal(delGeneralRes.status, 400);

    // Delete custom board
    const delCustomRes = await ctx.apiReq('DELETE', `/api/channels/${customBoardId}`, ctx.playerCookie);
    assert.equal(delCustomRes.status, 200);

    const bootAfter = await ctx.apiReq('GET', '/api/bootstrap', ctx.playerCookie);
    assert.ok(!bootAfter.data.channels.some((c) => c.id === customBoardId));
  });

  await t.test('T5.5: Blanket-mute blocks Clubhouse actions while preserving pickup baseball RSVPs', async () => {
    // Missing/short mute reason rejected
    const badMute = await ctx.apiReq('PUT', `/api/moderation/users/${ctx.facilitatorUser.id}/mute`, ctx.playerCookie, {
      muted: true,
      reason: 'x'
    });
    assert.equal(badMute.status, 400);

    // Delegated moderator blanket-mutes facilitator
    const muteRes = await ctx.apiReq('PUT', `/api/moderation/users/${ctx.facilitatorUser.id}/mute`, ctx.playerCookie, {
      muted: true,
      reason: 'Timeout for heated chat'
    });
    assert.equal(muteRes.status, 200);

    try {
      const meMuted = await ctx.apiReq('GET', '/api/auth/me', ctx.facilitatorCookie);
      assert.equal(meMuted.data.user.chatMuted, true);
      assert.equal(meMuted.data.user.chatMutedReason, 'Timeout for heated chat');

      // Blocked Clubhouse endpoints -> 403 USER_MUTED
      const postMsg = await ctx.apiReq('POST', `/api/channels/${generalChannelId}/messages`, ctx.facilitatorCookie, { content: 'Blocked post' });
      assert.equal(postMsg.status, 403);
      assert.equal(postMsg.data.code, 'USER_MUTED');

      const editMsg = await ctx.apiReq('PATCH', `/api/messages/${testMsgId}`, ctx.facilitatorCookie, { content: 'Blocked edit' });
      assert.equal(editMsg.status, 403);

      const reactMsg = await ctx.apiReq('POST', `/api/messages/${testMsgId}/reactions`, ctx.facilitatorCookie, { emoji: '👍' });
      assert.equal(reactMsg.status, 403);

      const dmRes = await ctx.apiReq('POST', '/api/channels', ctx.facilitatorCookie, { channel_type: 'dm', dm_user_id: ctx.playerUser.id });
      assert.equal(dmRes.status, 403);

      const voiceJoin = await ctx.apiReq('POST', `/api/voice/${generalChannelId}/join`, ctx.facilitatorCookie, {});
      assert.equal(voiceJoin.status, 403);

      const voiceState = await ctx.apiReq('POST', `/api/voice/${generalChannelId}/state`, ctx.facilitatorCookie, { muted: true });
      assert.equal(voiceState.status, 403);

      const signalRes = await ctx.apiReq('POST', '/api/rtc/signal', ctx.facilitatorCookie, {
        channel_id: generalChannelId,
        target_user_id: ctx.playerUser.id,
        signal_type: 'offer',
        payload: '{}'
      });
      assert.equal(signalRes.status, 403);

      const uploadInit = await ctx.apiReq('POST', '/api/attachments/init', ctx.facilitatorCookie, {
        channel_id: generalChannelId,
        file_name: 'photo.jpg',
        mime_type: 'image/jpeg',
        file_size: 1024
      });
      assert.equal(uploadInit.status, 403);

      // Pickup Baseball RSVPs STILL WORK for chat-muted users!
      const quickRsvp = await ctx.apiReq('POST', `/api/baseball/events/${ctx.testEventId}/quick-rsvp`, ctx.facilitatorCookie, {
        status: 'attending'
      });
      assert.equal(quickRsvp.status, 200);

      const upcomingRes = await ctx.apiReq('GET', '/api/baseball/upcoming', ctx.playerCookie);
      assert.equal(upcomingRes.status, 200);
      assert.ok((upcomingRes.data.attendees || []).some((a) => Number(a.user_id) === Number(ctx.facilitatorUser.id)));
    } finally {
      // Unmute facilitator & test Admin revoking moderator cleanly
      await ctx.apiReq('PUT', `/api/moderation/users/${ctx.facilitatorUser.id}/mute`, ctx.adminCookie, {
        muted: false,
        reason: 'Test complete'
      });
    }

    // Revoke player's moderator permission -> immediate 403
    const revokeRes = await ctx.apiReq('PUT', `/api/auth/users/${ctx.playerUser.id}/moderator`, ctx.adminCookie, {
      is_moderator: false
    });
    assert.equal(revokeRes.status, 200);

    const afterRevoke = await ctx.apiReq('GET', '/api/moderation/reports', ctx.playerCookie);
    assert.equal(afterRevoke.status, 403);

    // Unmuted facilitator can post again
    const postAgain = await ctx.apiReq('POST', `/api/channels/${generalChannelId}/messages`, ctx.facilitatorCookie, {
      content: 'Unmuted post succeeds'
    });
    assert.equal(postAgain.status, 201);
  });

  await t.test('T5.6: User/message reporting with stated reason + personal mute isolation from baseball games', async () => {
    // Reject short reason & self-report
    const badReport = await ctx.apiReq('POST', '/api/reports', ctx.playerCookie, {
      target_type: 'message',
      message_id: anotherMsgId,
      reason: 'no'
    });
    assert.equal(badReport.status, 400);

    const selfReport = await ctx.apiReq('POST', '/api/reports', ctx.facilitatorCookie, {
      target_type: 'user',
      reported_user_id: ctx.facilitatorUser.id,
      reason: 'Testing self report rejection'
    });
    assert.equal(selfReport.status, 400);

    // Valid message report
    const msgReport = await ctx.apiReq('POST', '/api/reports', ctx.playerCookie, {
      target_type: 'message',
      message_id: anotherMsgId,
      reason: 'Inappropriate language in team board'
    });
    assert.equal(msgReport.status, 201);
    const reportId = msgReport.data.report.id;

    // Duplicate open report rejected (409)
    const dupReport = await ctx.apiReq('POST', '/api/reports', ctx.playerCookie, {
      target_type: 'message',
      message_id: anotherMsgId,
      reason: 'Duplicate complaint'
    });
    assert.equal(dupReport.status, 409);

    // Admin fetches and resolves report
    const listReports = await ctx.apiReq('GET', '/api/moderation/reports?status=open', ctx.adminCookie);
    assert.equal(listReports.status, 200);
    const found = listReports.data.reports.find((r) => r.id === reportId);
    assert.ok(found && found.reason === 'Inappropriate language in team board');

    const resolveRes = await ctx.apiReq('PATCH', `/api/moderation/reports/${reportId}`, ctx.adminCookie, {
      status: 'resolved',
      resolution_note: 'Reviewed with team'
    });
    assert.equal(resolveRes.status, 200);

    // Personal User-to-User Mute
    const selfMute = await ctx.apiReq('POST', '/api/mutes', ctx.playerCookie, { muted_user_id: ctx.playerUser.id });
    assert.equal(selfMute.status, 400);

    const addMute = await ctx.apiReq('POST', '/api/mutes', ctx.playerCookie, { muted_user_id: ctx.facilitatorUser.id });
    assert.equal(addMute.status, 201);
    assert.ok(addMute.data.muted_user_ids.includes(ctx.facilitatorUser.id));

    const bootPlayer = await ctx.apiReq('GET', '/api/bootstrap', ctx.playerCookie);
    assert.ok(bootPlayer.data.muted_user_ids.includes(ctx.facilitatorUser.id));

    // Verify both Player and mutually/personally muted Facilitator still show up for the SAME baseball event
    const rsvpPlayer = await ctx.apiReq('POST', `/api/baseball/events/${ctx.testEventId}/quick-rsvp`, ctx.playerCookie, { status: 'attending' });
    const rsvpFac = await ctx.apiReq('POST', `/api/baseball/events/${ctx.testEventId}/quick-rsvp`, ctx.facilitatorCookie, { status: 'attending' });
    assert.equal(rsvpPlayer.status, 200);
    assert.equal(rsvpFac.status, 200);

    const upcomingBoth = await ctx.apiReq('GET', '/api/baseball/upcoming', ctx.playerCookie);
    const attendeeIds = (upcomingBoth.data.attendees || []).map((a) => Number(a.user_id));
    assert.ok(attendeeIds.includes(Number(ctx.playerUser.id)), 'Muter appears on game roster');
    assert.ok(attendeeIds.includes(Number(ctx.facilitatorUser.id)), 'Personally muted player still appears on same game roster');

    // Clean up personal mute
    const unmuteRes = await ctx.apiReq('DELETE', `/api/mutes/${ctx.facilitatorUser.id}`, ctx.playerCookie);
    assert.equal(unmuteRes.status, 200);
    assert.ok(!unmuteRes.data.muted_user_ids.includes(ctx.facilitatorUser.id));
  });

  await t.test('T5.7: Server Resource Frugality — idle sync fast-path, O(1) bootstrap & client thrift checks', async () => {
    // Capture current watermarks
    const seedSync = await ctx.apiReq('GET', '/api/sync?last_event_id=0&last_message_id=0', ctx.playerCookie);
    assert.equal(seedSync.status, 200);
    const watermarkEvent = seedSync.data.latest_event_id || 0;
    const watermarkMsg = seedSync.data.latest_message_id || 0;

    // 1. Measure idle /api/sync D1 query and write counts
    const { result: idleRes, counts: idleCounts } = await withD1QueryCounter(ctx, () =>
      ctx.apiReq('GET', `/api/sync?last_event_id=${watermarkEvent}&last_message_id=${watermarkMsg}`, ctx.playerCookie)
    );
    assert.equal(idleRes.status, 200);
    assert.equal(idleCounts.baseballWrites, 0, 'Idle /api/sync must perform 0 BASEBALL_DB writes');
    assert.equal(idleCounts.chatWrites, 0, 'Idle /api/sync must perform 0 CHAT_DB writes');
    assert.ok(idleCounts.baseballReads <= 2, `Expected <=2 BASEBALL_DB reads on lightweight sync, got ${idleCounts.baseballReads}`);
    assert.equal(idleCounts.chatReads, 1, `Expected 1 scalar watermark query on CHAT_DB idle sync, got ${idleCounts.chatReads}`);

    // 2. Measure muted rejected write does 0 CHAT_DB writes (rejects before rate limit insert)
    await ctx.apiReq('PUT', `/api/moderation/users/${ctx.facilitatorUser.id}/mute`, ctx.adminCookie, {
      muted: true,
      reason: 'Frugality short-circuit test'
    });
    const { result: mutedPostRes, counts: mutedCounts } = await withD1QueryCounter(ctx, () =>
      ctx.apiReq('POST', `/api/channels/${generalChannelId}/messages`, ctx.facilitatorCookie, { content: 'Should fail early' })
    );
    assert.equal(mutedPostRes.status, 403);
    assert.equal(mutedCounts.chatWrites, 0, 'Muted message rejection must perform 0 CHAT_DB writes');
    await ctx.apiReq('PUT', `/api/moderation/users/${ctx.facilitatorUser.id}/mute`, ctx.adminCookie, { muted: false });

    // 3. Verify /api/bootstrap uses O(1) queries regardless of channel count (no N+1)
    const { counts: bootBeforeCounts } = await withD1QueryCounter(ctx, () =>
      ctx.apiReq('GET', '/api/bootstrap', ctx.playerCookie)
    );
    const createdTempIds = [];
    for (let i = 0; i < 4; i++) {
      const chRes = await ctx.apiReq('POST', '/api/channels', ctx.adminCookie, { name: `frugality-board-${i}` });
      assert.equal(chRes.status, 201);
      createdTempIds.push(chRes.data.channel.id);
    }
    const { counts: bootAfterCounts } = await withD1QueryCounter(ctx, () =>
      ctx.apiReq('GET', '/api/bootstrap', ctx.playerCookie)
    );
    assert.equal(
      bootAfterCounts.chatReads,
      bootBeforeCounts.chatReads,
      'Bootstrap CHAT_DB read count must remain O(1) across varying channel counts (no N+1 loops)'
    );
    for (const tid of createdTempIds) {
      await ctx.apiReq('DELETE', `/api/channels/${tid}`, ctx.adminCookie);
    }

    // 4. Verify client-side resource frugality mechanisms exist
    const storeSrc = fs.readFileSync(path.resolve(__dirname, '../../public/js/store.js'), 'utf8');
    assert.ok(storeSrc.includes("visibilityState === 'hidden'"), 'store.js must pause idle polling when background tab is hidden');
    assert.ok(
      storeSrc.includes('VISIBLE_ACTIVE_SYNC_MS = 4000') && storeSrc.includes('VISIBLE_IDLE_SYNC_MS = 8000'),
      'store.js must enforce 4s active / 8s idle adaptive visible sync intervals'
    );
    const StoreMod = require('../../public/js/store.js');
    StoreMod.state.lastChatActivityAt = 0;
    assert.equal(StoreMod.isChatRecentlyActive(), false, 'Idle chat must start outside active window');
    StoreMod.markChatActivity();
    assert.equal(StoreMod.isChatRecentlyActive(), true, 'Typing or message activity must enter 4s active window');
    StoreMod.state.lastChatActivityAt = Date.now() - 65000;
    assert.equal(StoreMod.isChatRecentlyActive(), false, 'Chat must relax back to 8s idle interval after 60s of inactivity');
    StoreMod.state.lastChatActivityAt = 0;
    const rtcSrc = fs.readFileSync(path.resolve(__dirname, '../../public/js/rtc.js'), 'utf8');
    assert.ok(rtcSrc.includes('broadcastTypingIndicator'), 'rtc.js must route typing indicators over WebRTC DataChannel');
    const apiSrc = fs.readFileSync(path.resolve(__dirname, '../../public/js/api.js'), 'utf8');
    assert.ok(apiSrc.includes('pb_version_last_check'), 'api.js must throttle version checks via localStorage');

    // 5. Voice heartbeat keepalive skips sync_events insert when state is unchanged
    const joinVoiceRes = await ctx.apiReq('POST', '/api/voice/dugout-voice/join', ctx.adminCookie, {
      muted: false,
      deafened: false,
      screen_sharing: false
    });
    assert.equal(joinVoiceRes.status, 200);

    const syncBaseline = await ctx.apiReq('GET', '/api/sync?since_event_id=0&since_message_id=0', ctx.adminCookie);
    assert.equal(syncBaseline.status, 200);
    const baseEventId = syncBaseline.data.latest_event_id || 0;
    const baseMsgId = syncBaseline.data.latest_message_id || 0;

    const noopStateRes = await ctx.apiReq('POST', '/api/voice/dugout-voice/state', ctx.adminCookie, {
      muted: false,
      deafened: false,
      screen_sharing: false
    });
    assert.equal(noopStateRes.status, 200);
    const syncAfterNoop = await ctx.apiReq('GET', `/api/sync?since_event_id=${baseEventId}&since_message_id=${baseMsgId}`, ctx.adminCookie);
    assert.equal(syncAfterNoop.status, 200);
    const noopVoiceUpdates = (syncAfterNoop.data.events || []).filter((e) => e.event_type === 'voice_update');
    assert.equal(noopVoiceUpdates.length, 0, 'Unchanged voice heartbeat must not emit redundant voice_update sync events');

    const muteChangeRes = await ctx.apiReq('POST', '/api/voice/dugout-voice/state', ctx.adminCookie, {
      muted: true,
      deafened: false,
      screen_sharing: false
    });
    assert.equal(muteChangeRes.status, 200);
    const syncAfterMute = await ctx.apiReq('GET', `/api/sync?since_event_id=${baseEventId}&since_message_id=${baseMsgId}`, ctx.adminCookie);
    assert.equal(syncAfterMute.status, 200);
    const muteVoiceUpdates = (syncAfterMute.data.events || []).filter((e) => e.event_type === 'voice_update');
    assert.equal(muteVoiceUpdates.length, 1, 'Mute state change must still emit a voice_update sync event');

    await ctx.apiReq('POST', '/api/voice/dugout-voice/leave', ctx.adminCookie);
  });

  await t.test('T5.8: Guest game privacy, invite-only event restriction, volunteer crew name hiding & Mod tab board card removal', async () => {
    // 1. Mod tab must NOT contain Message Boards creation card
    const clubhouseHtml = fs.readFileSync(path.resolve(__dirname, '../../public/clubhouse.html'), 'utf8');
    assert.ok(!clubhouseHtml.includes('btn-mod-new-board'), 'Mod tab must not include Message Boards creation button');
    assert.ok(!clubhouseHtml.includes('<span>📋 Message Boards</span>'), 'Mod tab must not include Message Boards creation card');

    const clubhouseJs = fs.readFileSync(path.resolve(__dirname, '../../public/js/clubhouse.js'), 'utf8');
    assert.ok(clubhouseJs.includes("el('ch-bp-card')") && clubhouseJs.includes("el('ch-duties-card')"), 'clubhouse.js must gate game detail cards by login');

    // 2. Seed volunteer crew + BP slot on public event, plus an earlier invite-only restricted event
    const publicDetailBefore = await ctx.apiReq('GET', `/api/events/${ctx.testEventId}`, ctx.adminCookie);
    assert.equal(publicDetailBefore.status, 200);
    const generalDuty = (publicDetailBefore.data.duties || []).find((d) => !d.is_paid);
    assert.ok(generalDuty, 'Public event must have at least one volunteer duty');

    const rsvpCrew = await ctx.apiReq('POST', `/api/events/${ctx.testEventId}/rsvp`, ctx.playerCookie, {
      name: 'Volunteer Crew Player',
      players_count: 1,
      duty_ids: [generalDuty.id]
    });
    assert.equal(rsvpCrew.status, 200);

    const bpClaim = await ctx.apiReq('POST', `/api/baseball/events/${ctx.testEventId}/quick-bp`, ctx.playerCookie, { slot_number: 5 });
    assert.equal(bpClaim.status, 200);

    // Create an earlier upcoming invite-only restricted Sunday event (invited: playerUser ONLY)
    const soonIso = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const restRes = await ctx.apiReq('POST', '/api/events', ctx.adminCookie, {
      title: 'Sunday Secret Invite-Only Scrimmage',
      location: 'Private Diamond',
      event_date: soonIso,
      allowed_emails: [ctx.playerUser.email]
    });
    assert.equal(restRes.status, 200);
    const restrictedEventId = restRes.data.eventId;

    try {
      // 3. Guest (logged out) calling GET /api/baseball/upcoming sees ONLY next public game & ZERO names
      const guestUpcoming = await ctx.apiReq('GET', '/api/baseball/upcoming', null);
      assert.equal(guestUpcoming.status, 200);
      assert.equal(guestUpcoming.data.is_authenticated, false);
      assert.ok(guestUpcoming.data.event, 'Guest must see next public game summary');
      assert.notEqual(guestUpcoming.data.event.id, restrictedEventId, 'Guest must NOT see invite-only restricted event');
      assert.equal(guestUpcoming.data.event.allowed_emails, undefined);
      assert.deepEqual(guestUpcoming.data.attendees, [], 'Guest must NOT receive attendee names');
      assert.equal(guestUpcoming.data.linked_channel, null, 'Guest must NOT receive linked clubhouse channel');
      for (const d of (guestUpcoming.data.duties || [])) {
        for (const p of (d.assigned_players || [])) {
          assert.equal(p.name, '', 'Volunteer crew names must be blank when logged out in /api/baseball/upcoming');
        }
      }
      for (const s of (guestUpcoming.data.bp_signups || [])) {
        assert.equal(s.player_name, '', 'BP player names must be blank when logged out in /api/baseball/upcoming');
      }

      // 4. Guest calling GET /api/events/:publicId also sees blank volunteer crew names
      const guestPublicEvent = await ctx.apiReq('GET', `/api/events/${ctx.testEventId}`, null);
      assert.equal(guestPublicEvent.status, 200);
      const guestDuty = guestPublicEvent.data.duties.find((d) => d.id === generalDuty.id);
      for (const p of (guestDuty.assigned_players || [])) {
        assert.equal(p.name, '', 'Volunteer crew names must be blank when logged out in /api/events/:id');
      }

      // 5. Guest & uninvited logged-in user CANNOT see restricted invite-only event anywhere
      const guestEventsList = await ctx.apiReq('GET', '/api/events', null);
      assert.ok(!(guestEventsList.data.events || []).some((e) => e.id === restrictedEventId), 'Guest GET /api/events excludes restricted events');

      const guestRestrictedDetail = await ctx.apiReq('GET', `/api/events/${restrictedEventId}`, null);
      assert.equal(guestRestrictedDetail.status, 401);

      const uninvitedEventsList = await ctx.apiReq('GET', '/api/events', ctx.facilitatorCookie);
      assert.ok(!(uninvitedEventsList.data.events || []).some((e) => e.id === restrictedEventId), 'Uninvited logged-in user GET /api/events excludes restricted events');

      const uninvitedDetail = await ctx.apiReq('GET', `/api/events/${restrictedEventId}`, ctx.facilitatorCookie);
      assert.equal(uninvitedDetail.status, 403);

      const uninvitedBp = await ctx.apiReq('GET', `/api/events/${restrictedEventId}/bp-order`, ctx.facilitatorCookie);
      assert.equal(uninvitedBp.status, 403);

      const uninvitedUpcoming = await ctx.apiReq('GET', '/api/baseball/upcoming', ctx.facilitatorCookie);
      assert.equal(uninvitedUpcoming.status, 200);
      assert.notEqual(uninvitedUpcoming.data.event && uninvitedUpcoming.data.event.id, restrictedEventId, 'Uninvited user must not see restricted game in /api/baseball/upcoming');

      const uninvitedQuickRsvp = await ctx.apiReq('POST', `/api/baseball/events/${restrictedEventId}/quick-rsvp`, ctx.facilitatorCookie, { status: 'attending' });
      assert.equal(uninvitedQuickRsvp.status, 403);

      // 6. Invited logged-in user (playerUser) CAN see the restricted event (and allowed_emails PII stays hidden for non-organizers)
      const invitedEventsList = await ctx.apiReq('GET', '/api/events', ctx.playerCookie);
      const foundRest = (invitedEventsList.data.events || []).find((e) => e.id === restrictedEventId);
      assert.ok(foundRest, 'Invited logged-in user sees restricted event in GET /api/events');
      assert.equal(foundRest.allowed_emails, undefined);

      const invitedDetail = await ctx.apiReq('GET', `/api/events/${restrictedEventId}`, ctx.playerCookie);
      assert.equal(invitedDetail.status, 200);
      assert.equal(invitedDetail.data.event.is_restricted, true);
      assert.deepEqual(invitedDetail.data.event.allowed_emails_list, [], 'Non-organizer must not receive full invite email list');

      const invitedUpcoming = await ctx.apiReq('GET', '/api/baseball/upcoming', ctx.playerCookie);
      assert.equal(invitedUpcoming.status, 200);
      assert.equal(invitedUpcoming.data.event && invitedUpcoming.data.event.id, restrictedEventId, 'Invited logged-in user sees restricted upcoming game');

      // 7. Logged-in Organizer CAN see volunteer crew names
      const orgUpcoming = await ctx.apiReq('GET', '/api/baseball/upcoming', ctx.adminCookie);
      assert.equal(orgUpcoming.status, 200);
      assert.equal(orgUpcoming.data.is_authenticated, true);

      const orgPublicDetail = await ctx.apiReq('GET', `/api/events/${ctx.testEventId}`, ctx.adminCookie);
      assert.equal(orgPublicDetail.status, 200);
      const orgDuty = orgPublicDetail.data.duties.find((d) => d.id === generalDuty.id);
      assert.ok(orgDuty.assigned_players.some((p) => p.name === 'Volunteer Crew Player'), 'Logged-in organizer must see volunteer crew names');
    } finally {
      await ctx.apiReq('DELETE', `/api/events/${restrictedEventId}`, ctx.adminCookie);
    }
  });

  await t.test('T5.9: Members Directory Last-Name Abbreviation & Duplicate Collision Rules', async () => {
    const emailPrefix = `abbr_test_${Date.now()}`;
    const insertedIds = [];
    const testUsers = [
      { name: 'John Smith', email: `${emailPrefix}_1@example.com` },
      { name: 'John Sanchez', email: `${emailPrefix}_2@example.com` },
      { name: 'Jane Smith', email: `${emailPrefix}_3@example.com` },
      { name: 'Solo', email: `${emailPrefix}_4@example.com` }
    ];

    for (const tu of testUsers) {
      const ins = ctx.baseballDb.prepare(
        "INSERT INTO users (name, email, role, clubhouse_opted_in) VALUES (?, ?, 'player', 1)"
      ).run(tu.name, tu.email);
      insertedIds.push(ins.lastInsertRowid);
    }

    try {
      const bootRes = await ctx.apiReq('GET', '/api/bootstrap', ctx.playerCookie);
      assert.equal(bootRes.status, 200);
      const members = bootRes.data.members || [];

      const byId = new Map(members.map((m) => [m.id, m.name]));
      assert.equal(byId.get(insertedIds[0]), 'John Sm.', 'Duplicate first+last-initial user #1 must use first two letters of last name');
      assert.equal(byId.get(insertedIds[1]), 'John Sa.', 'Duplicate first+last-initial user #2 must use first two letters of last name');
      assert.equal(byId.get(insertedIds[2]), 'Jane S.', 'Unique first+last-initial user must use single initial');
      assert.equal(byId.get(insertedIds[3]), 'Solo', 'Single-word name must stay intact');

      // Standard seeded full-name users must also not expose full last names
      const charlie = members.find((m) => m.id === ctx.playerUser.id);
      assert.ok(charlie, 'Seeded player must appear in bootstrap members');
      assert.ok(!charlie.name.includes('Player'), `Expected abbreviated last name for seeded player, got "${charlie.name}"`);
      assert.match(charlie.name, /\s+[A-Za-z]{1,2}\.$/, 'Abbreviated member name must end with 1-2 letter last initial + period');

      const clubhouseJs = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'clubhouse.js'), 'utf8');
      assert.ok(clubhouseJs.includes('function abbreviateMemberNames('), 'clubhouse.js must define abbreviateMemberNames');
      assert.ok(!clubhouseJs.includes('?.'), 'clubhouse.js must remain strict ES6 (no ?.)');
      assert.ok(!clubhouseJs.includes('??'), 'clubhouse.js must remain strict ES6 (no ??)');
    } finally {
      for (const uid of insertedIds) {
        ctx.baseballDb.prepare('DELETE FROM users WHERE id = ?').run(uid);
      }
    }
  });

  await t.test('T5.10: Direct Messages Real ECDH E2EE Key Exchange, Zero-Knowledge Storage & DM Isolation', async () => {
    const subtle = globalThis.crypto.subtle;
    ctx.chatDb.prepare('DELETE FROM chat_rate_limits WHERE key IN (?, ?)').run(
      `user_${ctx.playerUser.id}_msgs`,
      `user_${ctx.facilitatorUser.id}_msgs`
    );

    // 1. Both participants generate real ECDH P-256 + ECDSA P-256 identities and publish public keys
    async function enrollKeypair(cookie) {
      const ecdh = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
      const ecdsa = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const ecdhPubJwk = await subtle.exportKey('jwk', ecdh.publicKey);
      const ecdsaPubJwk = await subtle.exportKey('jwk', ecdsa.publicKey);
      const putRes = await ctx.apiReq('PUT', '/api/keys/identity', cookie, {
        ecdh_public_key_jwk: ecdhPubJwk,
        ecdsa_public_key_jwk: ecdsaPubJwk,
        encrypted_private_vault: 'test_vault_blob_t5_10',
        vault_salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
        vault_iv: 'AAAAAAAAAAAAAAAA'
      });
      assert.equal(putRes.status, 200);
      return { ecdh, ecdsa, ecdhPubJwk };
    }

    const aliceKeys = await enrollKeypair(ctx.playerCookie);
    const bobKeys = await enrollKeypair(ctx.facilitatorCookie);

    // 2. Alice opens a DM with Bob
    const dmRes = await ctx.apiReq('POST', '/api/channels', ctx.playerCookie, {
      name: 'DM: Secret Practice Plan',
      channel_type: 'dm',
      dm_user_id: ctx.facilitatorUser.id,
      is_encrypted: true
    });
    assert.ok(dmRes.status === 200 || dmRes.status === 201);
    const dmId = dmRes.data.channel.id;
    assert.ok(Array.isArray(dmRes.data.channel.member_ids));
    assert.ok(dmRes.data.channel.member_ids.includes(ctx.playerUser.id));
    assert.ok(dmRes.data.channel.member_ids.includes(ctx.facilitatorUser.id));

    // 3. Server rejects unencrypted plaintext DM messages & enforces strict DM isolation (even from Admin)
    const plaintextReject = await ctx.apiReq('POST', `/api/channels/${dmId}/messages`, ctx.playerCookie, {
      content: 'Unencrypted message must fail'
    });
    assert.equal(plaintextReject.status, 400, 'DM POST without encryption_iv must be rejected');

    const adminBootstrap = await ctx.apiReq('GET', '/api/bootstrap', ctx.adminCookie);
    assert.equal(adminBootstrap.status, 200);
    assert.ok(
      !(adminBootstrap.data.channels || []).some((ch) => Number(ch.id) === Number(dmId)),
      'Non-participant Admin must NOT see Alice-Bob DM in /api/bootstrap'
    );
    const adminReadDm = await ctx.apiReq('GET', `/api/channels/${dmId}/messages`, ctx.adminCookie);
    assert.equal(adminReadDm.status, 403, 'Non-participant Admin must receive 403 reading DM');

    // 4. Alice generates random AES-GCM-256 DM key, wraps via pairwise ECDH P-256 for Alice & Bob
    const dmKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const rawDmKeyBuf = await subtle.exportKey('raw', dmKey);

    const peerKeysRes = await ctx.apiReq('GET', `/api/keys/users?ids=${ctx.playerUser.id},${ctx.facilitatorUser.id}`, ctx.playerCookie);
    assert.equal(peerKeysRes.status, 200);
    assert.equal(peerKeysRes.data.users.length, 2);

    const shares = [];
    for (const participant of peerKeysRes.data.users) {
      const peerPubKey = await subtle.importKey(
        'jwk',
        JSON.parse(participant.ecdh_public_key_jwk),
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        []
      );
      const sharedWrapKey = await subtle.deriveKey(
        { name: 'ECDH', public: peerPubKey },
        aliceKeys.ecdh.privateKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
      const wrapIv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const wrappedBuf = await subtle.encrypt({ name: 'AES-GCM', iv: wrapIv, tagLength: 128 }, sharedWrapKey, rawDmKeyBuf);
      shares.push({
        recipient_user_id: participant.user_id,
        key_epoch: 1,
        wrapped_key_base64: Buffer.from(wrappedBuf).toString('base64'),
        wrap_iv: Buffer.from(wrapIv).toString('base64')
      });
    }

    const sharePost = await ctx.apiReq('POST', `/api/keys/channel/${dmId}/share`, ctx.playerCookie, {
      key_epoch: 1,
      shares
    });
    assert.equal(sharePost.status, 200);
    assert.equal(sharePost.data.count, 2);

    // Admin still gets 403 trying to read DM key share
    const adminKeyGet = await ctx.apiReq('GET', `/api/keys/channel/${dmId}`, ctx.adminCookie);
    assert.equal(adminKeyGet.status, 403);

    // 5. Alice encrypts DM locally and posts ciphertext
    const secretText = 'Meet at 3rd base dugout at 9am — bring batting gloves';
    const msgIv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const cipherBuf = await subtle.encrypt(
      { name: 'AES-GCM', iv: msgIv, tagLength: 128 },
      dmKey,
      new TextEncoder().encode(secretText)
    );
    const cipherB64 = Buffer.from(cipherBuf).toString('base64');
    const ivB64 = Buffer.from(msgIv).toString('base64');

    const postCipher = await ctx.apiReq('POST', `/api/channels/${dmId}/messages`, ctx.playerCookie, {
      content: cipherB64,
      iv: ivB64,
      encryption_iv: ivB64,
      key_epoch: 1
    });
    assert.equal(postCipher.status, 201);
    const msgId = postCipher.data.id;

    // 6. Verify CHAT_DB stores ONLY ciphertext (server cannot read plaintext)
    const dbMsg = ctx.chatDb.prepare('SELECT content, iv FROM messages WHERE id = ?').get(msgId);
    assert.equal(dbMsg.iv, ivB64);
    assert.equal(dbMsg.content, cipherB64);
    assert.ok(!dbMsg.content.includes('dugout'), 'Database must not contain plaintext words');

    // 7. Bob fetches wrapped DM key share, unwraps via ECDH(Bob.priv, Alice.pub), and decrypts message
    const bobShareRes = await ctx.apiReq('GET', `/api/keys/channel/${dmId}`, ctx.facilitatorCookie);
    assert.equal(bobShareRes.status, 200);
    const aliceIdentityForBob = await ctx.apiReq('GET', `/api/keys/identity/${bobShareRes.data.senderUserId}`, ctx.facilitatorCookie);
    assert.equal(aliceIdentityForBob.status, 200);
    assert.equal(aliceIdentityForBob.data.encrypted_private_vault, undefined, 'Identity lookup must strip private vault');

    const alicePubForBob = await subtle.importKey(
      'jwk',
      JSON.parse(aliceIdentityForBob.data.ecdh_public_key_jwk),
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    );
    const bobSharedWrapKey = await subtle.deriveKey(
      { name: 'ECDH', public: alicePubForBob },
      bobKeys.ecdh.privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    const bobRawDmKey = await subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(bobShareRes.data.wrapIv, 'base64'), tagLength: 128 },
      bobSharedWrapKey,
      Buffer.from(bobShareRes.data.wrappedKeyBase64, 'base64')
    );
    const bobDmKey = await subtle.importKey('raw', bobRawDmKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);

    const bobMsgsRes = await ctx.apiReq('GET', `/api/channels/${dmId}/messages`, ctx.facilitatorCookie);
    assert.equal(bobMsgsRes.status, 200);
    const fetchedMsg = bobMsgsRes.data.messages.find((m) => m.id === msgId);
    assert.ok(fetchedMsg);
    const decryptedBuf = await subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(fetchedMsg.iv, 'base64'), tagLength: 128 },
      bobDmKey,
      Buffer.from(fetchedMsg.content, 'base64')
    );
    assert.equal(new TextDecoder().decode(decryptedBuf), secretText, 'Bob must decrypt Alice E2EE DM identically');

    // 8. Reject unencrypted edit on DM, allow encrypted edit, and block DM attachment promotion to public gallery
    const unencEdit = await ctx.apiReq('PATCH', `/api/messages/${msgId}`, ctx.playerCookie, { content: 'Plaintext edit' });
    assert.equal(unencEdit.status, 400);

    const attInit = await ctx.apiReq('POST', '/api/attachments/init', ctx.playerCookie, {
      channel_id: dmId,
      file_name: 'secret_diagram.png',
      mime_type: 'image/png',
      file_size: 16,
      is_encrypted: 1,
      iv: ivB64
    });
    assert.equal(attInit.status, 200);
    const promoBlocked = await ctx.apiReq('POST', `/api/attachments/${attInit.data.attachmentId}/promote-to-gallery`, ctx.adminCookie, {
      title: 'Should Fail'
    });
    assert.equal(promoBlocked.status, 400, 'Encrypted/DM attachment must not be promotable to public gallery');

    // 9. Verify honest UI labeling & strict ES6 compliance
    const clubhouseJs = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'clubhouse.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'store.js'), 'utf8');
    const cryptoJs = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'crypto.js'), 'utf8');
    assert.ok(clubhouseJs.includes('End-to-End Encrypted (ECDH)'), 'clubhouse.js must mark DMs as ECDH E2EE');
    assert.ok(clubhouseJs.includes('Moderated Board'), 'clubhouse.js must label public boards honestly as Moderated Board');
    assert.ok(storeJs.includes('ensureDmChannelKey'), 'store.js must wire ECDH DM key manager');
    for (const [fname, code] of [['clubhouse.js', clubhouseJs], ['store.js', storeJs], ['crypto.js', cryptoJs]]) {
      assert.ok(!code.includes('?.'), `${fname} must not contain ?.`);
      assert.ok(!code.includes('??'), `${fname} must not contain ??`);
    }
  });

  await t.test('T5.11: Strict CSP (no unsafe-inline scripts), Private Board ECDH E2EE & DM Safety Number Verification', async () => {
    const fs = require('fs');
    const path = require('path');
    const rootDir = path.join(__dirname, '..', '..');

    // 1. Verify no 'unsafe-inline' in script-src across headers, Hono index.js, and Express server.js
    for (const rel of ['public/_headers', 'src/app/index.js', 'src/server.js']) {
      const content = fs.readFileSync(path.join(rootDir, rel), 'utf8');
      const scriptSrcMatch = content.match(/script-src[^;"'\n]*(?:'[^']*'[^;\n]*)*/gi) || [];
      for (const directive of scriptSrcMatch) {
        assert.ok(!directive.includes("'unsafe-inline'"), `${rel} script-src must not include 'unsafe-inline'`);
      }
    }

    // 2. Verify zero inline <script> tags across HTML and zero inline on*= handlers across HTML & JS
    const publicDir = path.join(rootDir, 'public');
    for (const entry of fs.readdirSync(publicDir)) {
      if (entry.endsWith('.html')) {
        const html = fs.readFileSync(path.join(publicDir, entry), 'utf8');
        assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), `${entry} must not contain inline <script> blocks`);
        assert.ok(!/\son(click|change|submit|load|error|input|keydown)=/i.test(html), `${entry} must not contain inline event handlers`);
      }
    }
    const jsDir = path.join(publicDir, 'js');
    for (const entry of fs.readdirSync(jsDir)) {
      if (entry.endsWith('.js')) {
        const js = fs.readFileSync(path.join(jsDir, entry), 'utf8');
        assert.ok(!/\son(click|change|submit|load|error|input|keydown)=["'`]/i.test(js), `js/${entry} must not emit inline HTML event handlers`);
      }
    }

    // 3. Private / Invite-Only Board creation, strict non-invitee blocking, ECDH key sharing & epoch rotation
    const subtle = globalThis.crypto.subtle;
    async function enrollUserIdentity(cookie) {
      const ecdh = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
      const ecdsa = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const ecdhPubJwk = await subtle.exportKey('jwk', ecdh.publicKey);
      const ecdsaPubJwk = await subtle.exportKey('jwk', ecdsa.publicKey);
      const putRes = await ctx.apiReq('PUT', '/api/keys/identity', cookie, {
        ecdh_public_key_jwk: JSON.stringify(ecdhPubJwk),
        ecdsa_public_key_jwk: JSON.stringify(ecdsaPubJwk)
      });
      assert.equal(putRes.status, 200);
      return { ecdh, ecdhPubJwk };
    }

    const adminIdKeys = await enrollUserIdentity(ctx.adminCookie);
    const aliceIdKeys = await enrollUserIdentity(ctx.playerCookie);
    const bobIdKeys = await enrollUserIdentity(ctx.facilitatorCookie);

    const privCreate = await ctx.apiReq('POST', '/api/channels', ctx.adminCookie, {
      name: 'captains-vault',
      category: 'Private Huddles',
      topic: 'Secret strategy',
      is_private: true,
      member_ids: [ctx.playerUser.id]
    });
    assert.equal(privCreate.status, 201);
    const privCh = privCreate.data.channel;
    assert.equal(privCh.is_private, 1);
    assert.equal(privCh.min_role_read, 'invite');
    assert.equal(privCh.is_encrypted, 1);
    assert.ok(Array.isArray(privCh.member_ids) && privCh.member_ids.includes(ctx.playerUser.id));

    // Non-invited Facilitator must NOT see or access the private board or publish/read keys
    const facBoot = await ctx.apiReq('GET', '/api/bootstrap', ctx.facilitatorCookie);
    assert.ok(!(facBoot.data.channels || []).some((c) => c.id === privCh.id), 'Non-invited user must not see private board in bootstrap');
    const facMsgs = await ctx.apiReq('GET', `/api/channels/${privCh.id}/messages`, ctx.facilitatorCookie);
    assert.equal(facMsgs.status, 403);
    const facKeyGet = await ctx.apiReq('GET', `/api/keys/channel/${privCh.id}`, ctx.facilitatorCookie);
    assert.equal(facKeyGet.status, 403);

    // Plaintext post on private board rejected (400)
    const plainPrivPost = await ctx.apiReq('POST', `/api/channels/${privCh.id}/messages`, ctx.adminCookie, {
      content: 'Unencrypted private board leak'
    });
    assert.equal(plainPrivPost.status, 400);

    // Admin wraps epoch 1 board key via ECDH for [admin, player]
    const epoch1Key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const rawEp1 = await subtle.exportKey('raw', epoch1Key);
    const keysRes = await ctx.apiReq('GET', `/api/keys/users?ids=${ctx.adminUser.id},${ctx.playerUser.id}`, ctx.adminCookie);
    assert.equal(keysRes.status, 200);

    const sharesEp1 = [];
    for (const uRow of keysRes.data.users) {
      const peerPub = await subtle.importKey('jwk', JSON.parse(uRow.ecdh_public_key_jwk), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
      const wrapKey = await subtle.deriveKey({ name: 'ECDH', public: peerPub }, adminIdKeys.ecdh.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const wrapIv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv: wrapIv, tagLength: 128 }, wrapKey, rawEp1);
      sharesEp1.push({
        recipient_user_id: uRow.user_id,
        key_epoch: 1,
        wrapped_key_base64: Buffer.from(wrapped).toString('base64'),
        wrap_iv: Buffer.from(wrapIv).toString('base64')
      });
    }
    const shareRes1 = await ctx.apiReq('POST', `/api/keys/channel/${privCh.id}/share`, ctx.adminCookie, {
      key_epoch: 1,
      shares: sharesEp1
    });
    assert.equal(shareRes1.status, 200);

    // Encrypted message stored as opaque ciphertext in CHAT_DB
    const privIv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const privCipher = await subtle.encrypt({ name: 'AES-GCM', iv: privIv, tagLength: 128 }, epoch1Key, new TextEncoder().encode('Secret batting lineup #1'));
    const privPost = await ctx.apiReq('POST', `/api/channels/${privCh.id}/messages`, ctx.adminCookie, {
      content: Buffer.from(privCipher).toString('base64'),
      encryption_iv: Buffer.from(privIv).toString('base64'),
      key_epoch: 1
    });
    assert.equal(privPost.status, 201);
    const dbPrivRow = ctx.chatDb.prepare('SELECT content FROM messages WHERE id = ?').get(privPost.data.id);
    assert.ok(!dbPrivRow.content.includes('lineup'), 'Private board DB content must stay ciphertext');

    // Update invite list to replace Player with Facilitator and publish epoch 2 shares
    const patchRes = await ctx.apiReq('PATCH', `/api/channels/${privCh.id}`, ctx.adminCookie, {
      member_ids: [ctx.facilitatorUser.id]
    });
    assert.equal(patchRes.status, 200);
    assert.ok(patchRes.data.channel.member_ids.includes(ctx.facilitatorUser.id));
    assert.ok(!patchRes.data.channel.member_ids.includes(ctx.playerUser.id));

    const playerRemovedMsg = await ctx.apiReq('GET', `/api/channels/${privCh.id}/messages`, ctx.playerCookie);
    assert.equal(playerRemovedMsg.status, 403, 'Removed member must immediately lose private board access');

    const ep2ShareCheck = await ctx.apiReq('GET', `/api/keys/channel/${privCh.id}`, ctx.facilitatorCookie);
    assert.equal(ep2ShareCheck.status, 404, 'Newly invited member does not have old epoch 1 share until rotation');

    // 4. DM Safety Number Symmetry & MITM Key-Swap Warning via ClubhouseCrypto
    const ClubhouseCrypto = require('../../public/js/crypto.js');
    const snAliceView = await ClubhouseCrypto.computeSafetyNumber(
      ctx.playerUser.id,
      aliceIdKeys.ecdhPubJwk,
      ctx.facilitatorUser.id,
      bobIdKeys.ecdhPubJwk
    );
    const snBobView = await ClubhouseCrypto.computeSafetyNumber(
      ctx.facilitatorUser.id,
      bobIdKeys.ecdhPubJwk,
      ctx.playerUser.id,
      aliceIdKeys.ecdhPubJwk
    );
    assert.equal(snAliceView, snBobView, 'Both DM parties must derive the identical 60-digit safety number');
    assert.match(snAliceView, /^(\d{5} ){11}\d{5}$/, 'Safety number must be formatted as 12 groups of 5 digits');

    const bobFp = await ClubhouseCrypto.computeKeyFingerprint(bobIdKeys.ecdhPubJwk);
    assert.match(bobFp, /^([0-9A-F]{4} ){7}[0-9A-F]{4}$/, 'Key fingerprint must be formatted as 8 hex blocks');

    await ClubhouseCrypto.markPeerFingerprintVerified(ctx.facilitatorUser.id, bobFp);
    const samePin = await ClubhouseCrypto.getPeerVerificationState(ctx.facilitatorUser.id, bobFp);
    assert.equal(samePin.verified, true);
    assert.equal(samePin.keyChangedWarning, false);

    // Simulate active MITM swapping Bob's public key
    const attackerKey = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
    const attackerFp = await ClubhouseCrypto.computeKeyFingerprint(await subtle.exportKey('jwk', attackerKey.publicKey));
    const swappedPin = await ClubhouseCrypto.getPeerVerificationState(ctx.facilitatorUser.id, attackerFp);
    assert.equal(swappedPin.verified, false, 'Swapped MITM key must invalidate verified badge');
    assert.equal(swappedPin.keyChangedWarning, true, 'Swapped MITM key must raise keyChangedWarning');
  });

  await t.test('T5.12: Implicit Behavior Covenant present in Clubhouse UI and strict ES6/CSP preserved', async () => {
    const fs = require('fs');
    const path = require('path');
    const rootDir = path.join(__dirname, '..', '..');

    const clubhouseHtml = fs.readFileSync(path.join(rootDir, 'public', 'clubhouse.html'), 'utf8');
    const clubhouseJs = fs.readFileSync(path.join(rootDir, 'public', 'js', 'clubhouse.js'), 'utf8');

    assert.ok(clubhouseHtml.includes('id="ch-covenant-strip"'), 'clubhouse.html must show implicit covenant strip');
    assert.ok(
      clubhouseHtml.indexOf('id="ch-covenant-strip"') > clubhouseHtml.indexOf('id="ch-channel-list"') &&
      clubhouseHtml.indexOf('id="ch-covenant-strip"') < clubhouseHtml.indexOf('id="ch-composer-form"'),
      'Covenant strip must sit in the channel sidebar below the channel list, not below the message composer'
    );
    assert.ok(clubhouseHtml.includes('id="ch-covenant-modal"'), 'clubhouse.html must include full Behavior Covenant modal');
    assert.ok(/implicitly agree/i.test(clubhouseHtml), 'clubhouse.html must state implicit agreement by using Clubhouse');
    assert.ok(/no dehumanization/i.test(clubhouseHtml), 'clubhouse.html must explicitly prohibit dehumanization');
    assert.ok(/no harassment/i.test(clubhouseHtml), 'clubhouse.html must explicitly prohibit harassment');
    assert.ok(clubhouseJs.includes('openCovenantModal'), 'clubhouse.js must wire Behavior Covenant modal triggers');
    assert.ok(!clubhouseJs.includes('?.') && !clubhouseJs.includes('??'), 'clubhouse.js must remain strict ES6');
    assert.ok(!/\son(click|change|submit|load|error|input|keydown)=/i.test(clubhouseHtml), 'clubhouse.html must have zero inline handlers');
  });

  await t.test('T5.13: Clubhouse GIF Selector (Starter Catalog + PBF Shared Drive Web Link Import, SSRF Guard, Dedup & Stream)', async () => {
    const http = require('node:http');
    const rootDir = path.join(__dirname, '..', '..');

    // 1. Verify static starter catalog and GIF89a files on disk
    const catalogRaw = fs.readFileSync(path.join(rootDir, 'public', 'gifs', 'catalog.json'), 'utf8');
    const catalog = JSON.parse(catalogRaw);
    assert.ok(Array.isArray(catalog.gifs) && catalog.gifs.length >= 6, 'Starter GIF catalog must include starter GIFs');
    let totalStarterBytes = 0;
    for (const entry of catalog.gifs) {
      const diskPath = path.join(rootDir, 'public', entry.url.replace(/^\//, ''));
      const buf = fs.readFileSync(diskPath);
      assert.equal(buf.subarray(0, 6).toString('ascii'), 'GIF89a', `${entry.url} must be valid GIF89a`);
      totalStarterBytes += buf.length;
    }
    assert.ok(totalStarterBytes < 50 * 1024, 'Entire starter GIF pack should stay tiny (< 50 KB)');

    // 2. Verify SSRF & scheme protections on POST /api/gifs/import-url
    const httpReject = await ctx.apiReq('POST', '/api/gifs/import-url', ctx.playerCookie, {
      url: 'http://example.com/celebrate.gif'
    });
    assert.equal(httpReject.status, 400);

    const ssrfMetadata = await ctx.apiReq('POST', '/api/gifs/import-url', ctx.playerCookie, {
      url: 'https://169.254.169.254/latest/meta-data.gif'
    });
    assert.equal(ssrfMetadata.status, 403);

    const ssrfPrivate = await ctx.apiReq('POST', '/api/gifs/import-url', ctx.playerCookie, {
      url: 'https://10.0.0.5/internal.gif'
    });
    assert.equal(ssrfPrivate.status, 403);

    // 3. Spin up ephemeral test GIF host to test magic-byte check, Drive upload, dedup & streaming
    const sampleGif = fs.readFileSync(path.join(rootDir, 'public', 'gifs', 'home-run.gif'));
    const privateGif = fs.readFileSync(path.join(rootDir, 'public', 'gifs', 'safe.gif'));
    const rallyGif = fs.readFileSync(path.join(rootDir, 'public', 'gifs', 'rally-cap.gif'));
    let remoteFetchCount = 0;

    const mockGifServer = http.createServer((req, res) => {
      remoteFetchCount += 1;
      if (req.url === '/not-a-gif.gif') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Connection': 'close' });
        res.end('<html><body>not a gif</body></html>');
        return;
      }
      if (req.url === '/private-dm.gif') {
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': String(privateGif.length), 'Connection': 'close' });
        res.end(privateGif);
        return;
      }
      if (req.url === '/rally-gdrive.gif') {
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': String(rallyGif.length), 'Connection': 'close' });
        res.end(rallyGif);
        return;
      }
      if (req.url === '/large-gdrive-fail.gif') {
        const bigGif = Buffer.concat([rallyGif, Buffer.alloc(2 * 1024 * 1024 + 4096, 0x20)]);
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': String(bigGif.length), 'Connection': 'close' });
        res.end(bigGif);
        return;
      }
      if (req.url === '/small-gdrive-fallback.gif') {
        const smallGif = Buffer.concat([sampleGif, Buffer.from('small-fallback-salt')]);
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': String(smallGif.length), 'Connection': 'close' });
        res.end(smallGif);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': String(sampleGif.length), 'Connection': 'close' });
      res.end(sampleGif);
    });

    await new Promise((resolve) => mockGifServer.listen(0, '127.0.0.1', () => {
      mockGifServer.unref();
      resolve();
    }));
    const port = mockGifServer.address().port;

    try {
      // Unconfigured Google Drive must reject imports cleanly (500) and never save GIFs into D1
      const unconfiguredRes = await ctx.apiReq('POST', '/api/gifs/import-url', ctx.playerCookie, {
        url: `http://127.0.0.1:${port}/batflip.gif`,
        title: 'Bat Flip Celebration'
      });
      assert.equal(unconfiguredRes.status, 500);
      assert.match(String(unconfiguredRes.data.error || ''), /Google Drive storage is not configured/i);

      // Verify true PBF Shared Drive upload + zero D1 binary payload using MockGoogleDriveService
      const { createMockGDriveServer } = require('../helpers/mock-gdrive');
      const { app: honoApp } = await import('../../src/app/index.js');
      const mockDrive = await createMockGDriveServer();
      const gdriveEnv = {
        NODE_ENV: 'test',
        BASEBALL_DB: ctx.baseballD1,
        CHAT_DB: ctx.chatD1,
        DB: ctx.baseballD1,
        GDRIVE_API_BASE: mockDrive.baseUrl,
        GDRIVE_ACCESS_TOKEN: 'mock_token'
      };
      const honoApiReq = async (method, urlPath, cookie, jsonBody) => {
        const headers = { 'Origin': 'http://127.0.0.1' };
        if (cookie) headers['Cookie'] = cookie;
        if (jsonBody !== undefined) headers['Content-Type'] = 'application/json';
        const res = await honoApp.fetch(new Request(`http://127.0.0.1${urlPath}`, {
          method,
          headers,
          body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined
        }), gdriveEnv);
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch (e) {}
        return { status: res.status, headers: res.headers, data, text };
      };

      try {
        // Non-GIF payload must be rejected by magic-byte verification
        const fakeRes = await honoApiReq('POST', '/api/gifs/import-url', ctx.playerCookie, {
          url: `http://127.0.0.1:${port}/not-a-gif.gif`
        });
        assert.equal(fakeRes.status, 400);

        // Import real GIF URL via Google Drive
        const importRes = await honoApiReq('POST', '/api/gifs/import-url', ctx.playerCookie, {
          url: `http://127.0.0.1:${port}/batflip.gif`,
          title: 'Bat Flip Celebration'
        });
        assert.equal(importRes.status, 201);
        assert.equal(importRes.data.deduplicated, false);
        assert.equal(importRes.data.gif.title, 'Bat Flip Celebration');
        assert.equal(importRes.data.gif.storage_provider, 'gdrive');

        const gifId = importRes.data.gif.id;
        const d1Row = await ctx.chatD1.prepare('SELECT storage_provider, drive_file_id, local_data_base64 FROM clubhouse_gifs WHERE id = ?').bind(gifId).first();
        assert.equal(d1Row.storage_provider, 'gdrive');
        assert.ok(d1Row.drive_file_id, 'GIF must be stored in Google Drive');
        assert.equal(d1Row.local_data_base64, null, 'Binary bytes must NEVER be saved in D1');

        const rallyRes = await honoApiReq('POST', '/api/gifs/import-url', ctx.playerCookie, {
          url: `http://127.0.0.1:${port}/rally-gdrive.gif`,
          title: 'GDrive Rally Cap',
          tags: 'gdrive rally'
        });
        assert.equal(rallyRes.status, 201);
        assert.equal(rallyRes.data.gif.storage_provider, 'gdrive');
        const gdRow = await ctx.chatD1.prepare('SELECT storage_provider, drive_file_id, local_data_base64 FROM clubhouse_gifs WHERE id = ?').bind(rallyRes.data.gif.id).first();
        assert.equal(gdRow.storage_provider, 'gdrive');
        assert.ok(gdRow.drive_file_id);
        assert.equal(gdRow.local_data_base64, null);

        const gdStreamRes = await honoApp.fetch(
          new Request(`http://127.0.0.1/api/gifs/${encodeURIComponent(rallyRes.data.gif.id)}/stream`, { method: 'GET' }),
          gdriveEnv
        );
        assert.equal(gdStreamRes.status, 200);
        assert.equal(gdStreamRes.headers.get('content-type'), 'image/gif');
        await gdStreamRes.arrayBuffer();

        // Re-importing the exact same URL deduplicates with zero external fetch
        const fetchesBeforeUrlDedup = remoteFetchCount;
        const dupUrlRes = await honoApiReq('POST', '/api/gifs/import-url', ctx.facilitatorCookie, {
          url: `http://127.0.0.1:${port}/batflip.gif`
        });
        assert.equal(dupUrlRes.status, 200);
        assert.equal(dupUrlRes.data.deduplicated, true);
        assert.equal(dupUrlRes.data.gif.id, gifId);
        assert.equal(remoteFetchCount, fetchesBeforeUrlDedup, 'URL dedup must skip fetching remote host');

        // Different URL with identical bytes deduplicates by SHA-256 hash
        const dupHashRes = await honoApiReq('POST', '/api/gifs/import-url', ctx.facilitatorCookie, {
          url: `http://127.0.0.1:${port}/mirror-batflip.gif`
        });
        assert.equal(dupHashRes.status, 200);
        assert.equal(dupHashRes.data.deduplicated, true);
        assert.equal(dupHashRes.data.gif.id, gifId);

        // Stream full GIF & Range request from Drive
        const streamRes = await honoApiReq('GET', `/api/gifs/${encodeURIComponent(gifId)}/stream`);
        assert.equal(streamRes.status, 200);
        assert.equal(streamRes.headers.get('content-type'), 'image/gif');

        // Private / DM GIF import must stay unlisted from other users' drawer and require auth to stream
        const privRes = await honoApiReq('POST', '/api/gifs/import-url', ctx.playerCookie, {
          url: `http://127.0.0.1:${port}/private-dm.gif`,
          title: 'Secret Slide',
          is_public: false
        });
        assert.equal(privRes.status, 201);
        const privId = privRes.data.gif.id;

        const listOther = await honoApiReq('GET', '/api/gifs', ctx.facilitatorCookie);
        assert.equal(listOther.status, 200);
        assert.ok(listOther.data.gifs.some((g) => g.id === gifId), 'Public GIF should appear in community list');
        assert.ok(!listOther.data.gifs.some((g) => g.id === privId), 'Unlisted DM GIF must not appear in other users list');

        const unauthPrivStream = await honoApiReq('GET', `/api/gifs/${encodeURIComponent(privId)}/stream`);
        assert.equal(unauthPrivStream.status, 401);

        const authPrivStream = await honoApiReq('GET', `/api/gifs/${encodeURIComponent(privId)}/stream`, ctx.facilitatorCookie);
        assert.equal(authPrivStream.status, 200);
        assert.ok(String(authPrivStream.headers.get('cache-control') || '').includes('private'));

        // Google Drive failure must never fall back to D1 (regardless of GIF size) and must return structured 502
        const closedPort = await (async () => {
          const srv = http.createServer();
          await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
          const p = srv.address().port;
          await new Promise((resolve) => srv.close(resolve));
          return p;
        })();

        const brokenDriveEnv = {
          NODE_ENV: 'test',
          BASEBALL_DB: ctx.baseballD1,
          CHAT_DB: ctx.chatD1,
          DB: ctx.baseballD1,
          GDRIVE_API_BASE: `http://127.0.0.1:${closedPort}`,
          GDRIVE_ACCESS_TOKEN: 'mock_token'
        };

        const smallFailRes = await honoApp.fetch(new Request('http://127.0.0.1/api/gifs/import-url', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cookie': ctx.playerCookie,
            'Origin': 'http://127.0.0.1'
          },
          body: JSON.stringify({ url: `http://127.0.0.1:${port}/small-gdrive-fallback.gif` })
        }), brokenDriveEnv);
        assert.equal(smallFailRes.status, 500, 'Small GIF must NOT fall back to D1 when Drive fails');
        const smallFailData = await smallFailRes.json();
        assert.match(String(smallFailData.error || ''), /Google Drive upload failed/i);

        const largeFailRes = await honoApp.fetch(new Request('http://127.0.0.1/api/gifs/import-url', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cookie': ctx.playerCookie,
            'Origin': 'http://127.0.0.1'
          },
          body: JSON.stringify({ url: `http://127.0.0.1:${port}/large-gdrive-fail.gif` })
        }), brokenDriveEnv);
        assert.equal(largeFailRes.status, 500, 'Over 2 MB GIF when Drive fails must return structured JSON error');
        const largeFailData = await largeFailRes.json();
        assert.match(String(largeFailData.error || ''), /Google Drive upload failed/i);

        const localRows = await ctx.chatD1.prepare('SELECT COUNT(*) AS cnt FROM clubhouse_gifs WHERE local_data_base64 IS NOT NULL').first();
        assert.equal(Number(localRows.cnt || 0), 0, 'No GIF binary data may ever be stored in D1');

        const unreachableHostRes = await honoApiReq('POST', '/api/gifs/import-url', ctx.playerCookie, {
          url: `http://127.0.0.1:${closedPort}/unreachable.gif`
        });
        assert.equal(unreachableHostRes.status, 422, 'Unreachable remote GIF host must return 422 JSON error');
      } finally {
        await mockDrive.close();
      }
    } finally {
      if (typeof mockGifServer.closeAllConnections === 'function') {
        mockGifServer.closeAllConnections();
      }
      await new Promise((resolve) => mockGifServer.close(resolve));
    }

    // 4. Verify UI & strict ES6/CSP invariants
    const clubhouseHtml = fs.readFileSync(path.join(rootDir, 'public', 'clubhouse.html'), 'utf8');
    const clubhouseJs = fs.readFileSync(path.join(rootDir, 'public', 'js', 'clubhouse.js'), 'utf8');
    assert.ok(clubhouseHtml.includes('id="btn-open-gif-picker"'));
    assert.ok(clubhouseHtml.includes('id="ch-gif-picker"'));
    assert.ok(clubhouseHtml.includes('id="ch-gif-import-form"'));
    assert.ok(clubhouseJs.includes('renderMessageTextWithGifs'));
    assert.ok(clubhouseJs.includes('handleImportGifUrl'));
    assert.ok(!clubhouseHtml.includes('id="rail-dm-btn"'), 'Left-rail DM button/tab should be removed');
    assert.ok(!clubhouseJs.includes('sidebarMode'), 'Left-sidebar DM mode toggle should be removed');
    assert.ok(clubhouseJs.includes('data-dm-uid'), 'Members panel DM button must remain available');
    assert.ok(clubhouseJs.includes("'Direct Messages'"), 'Direct Messages category in channel list must remain');
    assert.ok(!clubhouseJs.includes('?.') && !clubhouseJs.includes('??'), 'clubhouse.js must remain strict ES6');
    assert.ok(!/\son(click|change|submit|load|error|input|keydown)=/i.test(clubhouseHtml), 'clubhouse.html must have zero inline handlers');
  });

  await t.test('T5.14: Per-User DM History Hiding in Channel List & Logged-Out Cached DM Clearance', async () => {
    // 1. Verify player & facilitator have an active DM (re-uses or creates existing 1:1 DM)
    const dmOpenRes = await ctx.apiReq('POST', '/api/channels', ctx.playerCookie, {
      name: 'DM: Secret Practice Plan',
      channel_type: 'dm',
      dm_user_id: ctx.facilitatorUser.id,
      is_encrypted: true
    });
    assert.ok(dmOpenRes.status === 200 || dmOpenRes.status === 201);
    const dmId = dmOpenRes.data.channel.id;

    // 2. Reject hiding non-DM boards and reject non-participant DM hide attempts
    const hideGeneralRes = await ctx.apiReq('POST', '/api/channels/general/hide', ctx.adminCookie, {});
    assert.equal(hideGeneralRes.status, 400, 'Non-DM channels must reject /hide');

    const outsiderHideRes = await ctx.apiReq('POST', `/api/channels/${dmId}/hide`, ctx.adminCookie, {});
    assert.equal(outsiderHideRes.status, 403, 'Non-participant Admin must receive 403 trying to hide someone else\'s DM');

    // 3. Player hides the DM from their own channel list
    const hideRes = await ctx.apiReq('POST', `/api/channels/${dmId}/hide`, ctx.playerCookie, {});
    assert.equal(hideRes.status, 200);
    assert.equal(hideRes.data.hidden, true);

    const playerBootstrapAfterHide = await ctx.apiReq('GET', '/api/bootstrap', ctx.playerCookie);
    assert.equal(playerBootstrapAfterHide.status, 200);
    assert.ok(
      !(playerBootstrapAfterHide.data.channels || []).some((ch) => Number(ch.id) === Number(dmId)),
      'Hidden DM must NOT appear in hiding user\'s /api/bootstrap channel list'
    );

    const playerChannelsAfterHide = await ctx.apiReq('GET', '/api/channels', ctx.playerCookie);
    assert.equal(playerChannelsAfterHide.status, 200);
    assert.ok(
      !(playerChannelsAfterHide.data.channels || []).some((ch) => Number(ch.id) === Number(dmId)),
      'Hidden DM must NOT appear in hiding user\'s GET /api/channels'
    );

    // Other participant (facilitator) MUST still see the DM in their channel list, and encrypted history remains readable
    const bobBootstrap = await ctx.apiReq('GET', '/api/bootstrap', ctx.facilitatorCookie);
    assert.equal(bobBootstrap.status, 200);
    assert.ok(
      (bobBootstrap.data.channels || []).some((ch) => Number(ch.id) === Number(dmId)),
      'Hiding DM must be strictly per-user and NOT hide it for the other participant'
    );
    const playerHistory = await ctx.apiReq('GET', `/api/channels/${dmId}/messages`, ctx.playerCookie);
    assert.equal(playerHistory.status, 200, 'Hiding a DM from sidebar must preserve access to its encrypted history');

    // 4. Re-opening DM via POST /api/channels (clicking DM in Members) restores it to player's channel list
    const reopenRes = await ctx.apiReq('POST', '/api/channels', ctx.playerCookie, {
      channel_type: 'dm',
      dm_user_id: ctx.facilitatorUser.id
    });
    assert.equal(reopenRes.status, 200);
    const playerBootstrapReopened = await ctx.apiReq('GET', '/api/bootstrap', ctx.playerCookie);
    assert.ok(
      (playerBootstrapReopened.data.channels || []).some((ch) => Number(ch.id) === Number(dmId)),
      'Re-opening a hidden DM must restore it to the user\'s channel list'
    );

    // 5. Hiding again then receiving a new encrypted message auto-unhides DM and emits scoped channel_create sync event
    const hideAgain = await ctx.apiReq('POST', `/api/channels/${dmId}/hide`, ctx.playerCookie, {});
    assert.equal(hideAgain.status, 200);
    const syncBeforeRow = ctx.chatDb.prepare('SELECT COALESCE(MAX(id), 0) as m FROM sync_events').get();
    const msgBeforeRow = ctx.chatDb.prepare('SELECT COALESCE(MAX(id), 0) as m FROM messages').get();

    ctx.chatDb.prepare('DELETE FROM chat_rate_limits WHERE key = ?').run(`user_${ctx.facilitatorUser.id}_msgs`);
    const newMsgRes = await ctx.apiReq('POST', `/api/channels/${dmId}/messages`, ctx.facilitatorCookie, {
      content: 'dGVzdF9jaXBoZXJ0ZXh0',
      iv: 'AAAAAAAAAAAAAAAA'
    });
    assert.equal(newMsgRes.status, 201);

    const playerSync = await ctx.apiReq(
      'GET',
      `/api/sync?since_msg_id=${msgBeforeRow.m}&since_event_id=${syncBeforeRow.m}`,
      ctx.playerCookie
    );
    assert.equal(playerSync.status, 200);
    assert.ok(
      (playerSync.data.events || []).some((ev) => ev.event_type === 'channel_create' && Number(ev.target_id) === Number(dmId)),
      'Incoming DM message must emit scoped channel_create sync event to unhide DM live'
    );

    const adminSync = await ctx.apiReq(
      'GET',
      `/api/sync?since_msg_id=${msgBeforeRow.m}&since_event_id=${syncBeforeRow.m}`,
      ctx.adminCookie
    );
    assert.equal(adminSync.status, 200);
    assert.ok(
      !(adminSync.data.events || []).some((ev) => Number(ev.target_id) === Number(dmId)),
      'Non-participant Admin sync must NOT receive DM unhide sync_event'
    );

    // Explicitly test POST /api/channels/:id/unhide as well
    await ctx.apiReq('POST', `/api/channels/${dmId}/hide`, ctx.playerCookie, {});
    const unhideRes = await ctx.apiReq('POST', `/api/channels/${dmId}/unhide`, ctx.playerCookie, {});
    assert.equal(unhideRes.status, 200);
    assert.equal(unhideRes.data.hidden, false);

    // 6. Client Store logged-out / 401 cache isolation (simulating cached DM in IndexedDB after logout or expired session)
    const rootDir = path.join(__dirname, '..', '..');
    const storeJs = fs.readFileSync(path.join(rootDir, 'public', 'js', 'store.js'), 'utf8');
    const clubhouseJs = fs.readFileSync(path.join(rootDir, 'public', 'js', 'clubhouse.js'), 'utf8');
    const apiJs = fs.readFileSync(path.join(rootDir, 'public', 'js', 'api.js'), 'utf8');

    assert.ok(!storeJs.includes('?.') && !storeJs.includes('??'), 'store.js must remain strict ES6');
    assert.ok(clubhouseJs.includes('data-hide-dm-id'), 'clubhouse.js must render DM hide button in channel list');
    assert.ok(clubhouseJs.includes('clearSignedOutUi'), 'clubhouse.js must clear UI on auth_required');
    assert.ok(apiJs.includes('clearClubhouseIndexedDb'), 'api.js must clear pickup_clubhouse_db on logout/cache clear');

    const prevFetch = globalThis.fetch;
    const prevIndexedDB = globalThis.indexedDB;
    const prevLocalStorage = globalThis.localStorage;
    try {
      const storeModulePath = require.resolve('../../public/js/store.js');
      delete require.cache[storeModulePath];

      const idbStores = {
        channels: new Map([
          [1, { id: 1, slug: 'general', name: '#general', channel_type: 'text', is_private: 0 }],
          [99, { id: 99, slug: 'dm-1-2', name: 'DM: Secret Teammate', channel_type: 'dm', category: 'Direct Messages', is_private: 0 }]
        ]),
        messages: new Map([
          [501, { id: 501, channel_id: 99, content: 'cipher', author_name: 'Secret' }]
        ]),
        meta: new Map([['cached_user_id', 1]])
      };

      const makeTx = () => ({
        objectStore(storeName) {
          const backing = idbStores[storeName] || new Map();
          return {
            indexNames: { contains: () => false },
            getAll() {
              const req = { result: Array.from(backing.values()) };
              queueMicrotask(() => { if (req.onsuccess) req.onsuccess(); });
              return req;
            },
            get(k) {
              const req = { result: backing.get(k) };
              queueMicrotask(() => { if (req.onsuccess) req.onsuccess(); });
              return req;
            },
            put(val, k) {
              const key = k !== undefined ? k : val.id;
              backing.set(key, val);
              return {};
            },
            delete(k) {
              backing.delete(k);
              return {};
            },
            clear() {
              backing.clear();
              return {};
            }
          };
        }
      });

      const fakeDb = {
        objectStoreNames: { contains: (n) => Object.prototype.hasOwnProperty.call(idbStores, n) },
        transaction: () => makeTx()
      };

      globalThis.indexedDB = {
        open() {
          const req = {};
          queueMicrotask(() => {
            if (req.onsuccess) req.onsuccess({ target: { result: fakeDb } });
          });
          return req;
        }
      };
      globalThis.localStorage = {
        _map: new Map([['pickup_cached_user', JSON.stringify({ id: 1, name: 'Stale User' })]]),
        getItem(k) { return this._map.has(k) ? this._map.get(k) : null; },
        setItem(k, v) { this._map.set(k, String(v)); },
        removeItem(k) { this._map.delete(k); }
      };
      globalThis.fetch = async () => ({
        ok: false,
        status: 401,
        headers: new Headers(),
        async json() { return { error: 'Authentication required' }; }
      });

      const FreshStore = require('../../public/js/store.js');
      const seenEvents = [];
      let cachedEmittedHasDm = false;
      FreshStore.subscribe((ev, detail) => {
        seenEvents.push(ev);
        if (ev === 'bootstrap_cached' && detail && Array.isArray(detail.channels)) {
          cachedEmittedHasDm = detail.channels.some((c) => c.channel_type === 'dm' || c.channel_type === 'group_dm');
        }
      });

      await assert.rejects(() => FreshStore.bootstrap(), /Authentication required/);
      assert.equal(cachedEmittedHasDm, false, 'bootstrap_cached must NEVER expose cached DM channels before auth verification');
      assert.ok(seenEvents.includes('auth_required'), '401 bootstrap must emit auth_required');
      assert.equal(FreshStore.state.user, null, '401 bootstrap must clear Store.state.user');
      assert.equal(FreshStore.state.channels.length, 0, '401 bootstrap must clear Store.state.channels');
      assert.equal(idbStores.channels.size, 0, '401 bootstrap must clear cached IndexedDB channels');
      assert.equal(idbStores.messages.size, 0, '401 bootstrap must clear cached IndexedDB messages');
      assert.equal(globalThis.localStorage.getItem('pickup_cached_user'), null, '401 bootstrap must clear stale pickup_cached_user');
    } finally {
      globalThis.fetch = prevFetch;
      globalThis.indexedDB = prevIndexedDB;
      globalThis.localStorage = prevLocalStorage;
      delete require.cache[require.resolve('../../public/js/store.js')];
    }
  });

  await t.test('T5.15: Logged-Out Single Public Channel (#announcements) Access & Private Channel Isolation', async () => {
    // 1. Seed a public announcement message and a private/player chat message in #general
    const ancPost = await ctx.apiReq('POST', '/api/channels/announcements/messages', ctx.adminCookie, {
      content: 'Sunday pickup at 10am at Bushrod Field!'
    });
    assert.equal(ancPost.status, 201);

    // 2. Unauthenticated GET /api/public/channels returns strictly 1 public channel (#announcements)
    const pubChRes = await ctx.apiReq('GET', '/api/public/channels', null);
    assert.equal(pubChRes.status, 200);
    assert.ok(Array.isArray(pubChRes.data.channels));
    assert.equal(pubChRes.data.channels.length, 1, 'Logged-out public channels list must expose exactly 1 public channel');
    assert.equal(pubChRes.data.channels[0].slug, 'announcements');

    // 3. Unauthenticated GET /api/channels/announcements/messages succeeds (200)
    const ancMsgsRes = await ctx.apiReq('GET', '/api/channels/announcements/messages', null);
    assert.equal(ancMsgsRes.status, 200);
    assert.ok(
      (ancMsgsRes.data.messages || []).some((m) => m.content && m.content.includes('Bushrod Field')),
      'Logged-out visitor must be able to read #announcements messages'
    );

    // 4. All other channels (#general, #facilitators-lounge, DMs, unknown slugs) still reject logged-out reads with 401
    for (const restrictedSlug of ['general', 'facilitators-lounge', 'nonexistent-channel-999']) {
      const denied = await ctx.apiReq('GET', `/api/channels/${restrictedSlug}/messages`, null);
      assert.equal(denied.status, 401, `Logged-out read on ${restrictedSlug} must return 401`);
    }

    // 5. Client Store.bootstrap() on 401 + 200 /api/public/channels clears stale DMs and loads only #announcements
    const prevFetch = globalThis.fetch;
    const prevIndexedDB = globalThis.indexedDB;
    const prevLocalStorage = globalThis.localStorage;
    try {
      const storeModulePath = require.resolve('../../public/js/store.js');
      delete require.cache[storeModulePath];

      const idbStores = {
        channels: new Map([
          [99, { id: 99, slug: 'dm-1-2', name: 'DM: Old Cached User', channel_type: 'dm', category: 'Direct Messages' }]
        ]),
        messages: new Map([
          [501, { id: 501, channel_id: 99, content: 'stale secret' }]
        ]),
        meta: new Map([['cached_user_id', 1]])
      };

      const fakeDb = {
        objectStoreNames: { contains: (n) => Object.prototype.hasOwnProperty.call(idbStores, n) },
        transaction: () => ({
          objectStore(storeName) {
            const backing = idbStores[storeName] || new Map();
            return {
              indexNames: { contains: () => false },
              getAll() {
                const req = { result: Array.from(backing.values()) };
                queueMicrotask(() => { if (req.onsuccess) req.onsuccess(); });
                return req;
              },
              get(k) {
                const req = { result: backing.get(k) };
                queueMicrotask(() => { if (req.onsuccess) req.onsuccess(); });
                return req;
              },
              put(val, k) { backing.set(k !== undefined ? k : val.id, val); return {}; },
              delete(k) { backing.delete(k); return {}; },
              clear() { backing.clear(); return {}; }
            };
          }
        })
      };

      globalThis.indexedDB = {
        open() {
          const req = {};
          queueMicrotask(() => { if (req.onsuccess) req.onsuccess({ target: { result: fakeDb } }); });
          return req;
        }
      };
      globalThis.localStorage = {
        _map: new Map(),
        getItem(k) { return this._map.has(k) ? this._map.get(k) : null; },
        setItem(k, v) { this._map.set(k, String(v)); },
        removeItem(k) { this._map.delete(k); }
      };
      globalThis.fetch = async (url) => {
        if (String(url).includes('/api/public/channels')) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            async json() {
              return { channels: pubChRes.data.channels };
            }
          };
        }
        return {
          ok: false,
          status: 401,
          headers: new Headers(),
          async json() { return { error: 'Authentication required' }; }
        };
      };

      const GuestStore = require('../../public/js/store.js');
      let publicLoadedEvent = false;
      GuestStore.subscribe((ev) => {
        if (ev === 'public_channels_loaded') publicLoadedEvent = true;
      });

      const bootOut = await GuestStore.bootstrap();
      assert.equal(bootOut.publicOnly, true);
      assert.equal(publicLoadedEvent, true, 'public_channels_loaded event must fire for logged-out guest');
      assert.equal(GuestStore.state.user, null);
      assert.equal(GuestStore.state.channels.length, 1, 'Guest Store must hold only the 1 public channel');
      assert.equal(GuestStore.state.channels[0].slug, 'announcements');
      assert.equal(idbStores.channels.size, 0, 'Cached DM IndexedDB entries must be cleared even when showing public channel');
      assert.equal(idbStores.messages.size, 0);
    } finally {
      globalThis.fetch = prevFetch;
      globalThis.indexedDB = prevIndexedDB;
      globalThis.localStorage = prevLocalStorage;
      delete require.cache[require.resolve('../../public/js/store.js')];
    }
  });

  await t.test('T5.16: Clubhouse Opt-In / Opt-Out Lifecycle (Members Directory, Hidden/Restored Messages, Reactions & DM Isolation)', async () => {
    const fs = require('fs');
    const path = require('path');
    const rootDir = path.resolve(__dirname, '..', '..');

    // 1. Insert a brand-new Pickup Baseball user (default clubhouse_opted_in = 0)
    const futureExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const uRes = ctx.baseballDb.prepare(
      "INSERT INTO users (name, email, role, is_admin) VALUES ('Eve Newcomer', 'eve-optin@pickupbaseball.org', 'player', 0)"
    ).run();
    const eveId = Number(uRes.lastInsertRowid);
    const eveSess = 'sess_eve_' + Date.now();
    ctx.baseballDb.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(eveSess, eveId, futureExpiry);
    const eveCookie = `baseball_session=${eveSess}`;

    // Verify Eve is NOT in Clubhouse members list and cannot post/react/join voice while opted out
    const bootBefore = await ctx.apiReq('GET', '/api/bootstrap', ctx.adminCookie);
    assert.equal(bootBefore.status, 200);
    assert.ok(!(bootBefore.data.members || []).some((m) => Number(m.id) === eveId), 'Opted-out user must not appear in members directory');

    const eveMeBefore = await ctx.apiReq('GET', '/api/auth/me', eveCookie);
    assert.equal(eveMeBefore.status, 200);
    assert.equal(eveMeBefore.data.user.clubhouseOptedIn, false);

    const blockedPost = await ctx.apiReq('POST', '/api/channels/general/messages', eveCookie, { content: 'Should be blocked' });
    assert.equal(blockedPost.status, 403);
    assert.equal(blockedPost.data.code, 'CLUBHOUSE_OPT_OUT');

    // 2. Eve opts in -> appears in members list, posts in #general, reacts, and exchanges DMs with Charlie Player
    const optInRes = await ctx.apiReq('PUT', '/api/auth/clubhouse-opt-in', eveCookie, { opted_in: true });
    assert.equal(optInRes.status, 200);
    assert.equal(optInRes.data.clubhouseOptedIn, true);

    const bootAfterIn = await ctx.apiReq('GET', '/api/bootstrap', ctx.adminCookie);
    assert.ok((bootAfterIn.data.members || []).some((m) => Number(m.id) === eveId), 'Opted-in user must appear in members directory');

    const eveMsgRes = await ctx.apiReq('POST', '/api/channels/general/messages', eveCookie, { content: 'Hello from Eve!' });
    assert.equal(eveMsgRes.status, 201);
    const eveMsgId = eveMsgRes.data.message.id;

    const adminMsgRes = await ctx.apiReq('POST', '/api/channels/general/messages', ctx.adminCookie, { content: 'Welcome Eve!' });
    assert.equal(adminMsgRes.status, 201);
    const adminMsgId = adminMsgRes.data.message.id;

    const rxRes = await ctx.apiReq('POST', `/api/messages/${adminMsgId}/reactions`, eveCookie, { emoji: '⚾' });
    assert.equal(rxRes.status, 200);
    assert.ok((rxRes.data.reactions || []).some((r) => Number(r.user_id) === eveId && r.emoji === '⚾'));

    const dmOpen = await ctx.apiReq('POST', '/api/channels', ctx.playerCookie, {
      channel_type: 'dm',
      dm_user_id: eveId,
      is_encrypted: true
    });
    assert.ok(dmOpen.status === 200 || dmOpen.status === 201);
    const dmId = dmOpen.data.channel.id;

    const playerDmMsg = await ctx.apiReq('POST', `/api/channels/${dmId}/messages`, ctx.playerCookie, {
      content: 'CIPHER_FROM_PLAYER',
      encryption_iv: 'iv_player_1'
    });
    assert.equal(playerDmMsg.status, 201);
    const eveDmMsg = await ctx.apiReq('POST', `/api/channels/${dmId}/messages`, eveCookie, {
      content: 'CIPHER_FROM_EVE',
      encryption_iv: 'iv_eve_1'
    });
    assert.equal(eveDmMsg.status, 201);

    // 3. Eve opts out -> disappears from members, her #general messages & reactions hide, DM thread stays open for Player with only Player's messages
    const optOutRes = await ctx.apiReq('PUT', '/api/auth/clubhouse-opt-in', eveCookie, { opted_in: false });
    assert.equal(optOutRes.status, 200);
    assert.equal(optOutRes.data.clubhouseOptedIn, false);

    const bootAfterOut = await ctx.apiReq('GET', '/api/bootstrap', ctx.playerCookie);
    assert.ok(!(bootAfterOut.data.members || []).some((m) => Number(m.id) === eveId), 'Opted-out user must disappear from members directory');
    assert.ok((bootAfterOut.data.channels || []).some((ch) => Number(ch.id) === Number(dmId)), 'DM thread must remain visible in Player channel list');

    const generalAfterOut = await ctx.apiReq('GET', '/api/channels/general/messages', ctx.playerCookie);
    assert.equal(generalAfterOut.status, 200);
    assert.ok(!(generalAfterOut.data.messages || []).some((m) => Number(m.id) === Number(eveMsgId)), 'Opted-out user message must be hidden in #general');
    const adminMsgAfterOut = (generalAfterOut.data.messages || []).find((m) => Number(m.id) === Number(adminMsgId));
    assert.ok(adminMsgAfterOut, 'Other users messages remain visible');
    assert.ok(!(adminMsgAfterOut.reactions || []).some((r) => Number(r.user_id) === eveId), 'Opted-out user reactions must be hidden');

    const dmMsgsAfterOut = await ctx.apiReq('GET', `/api/channels/${dmId}/messages`, ctx.playerCookie);
    assert.equal(dmMsgsAfterOut.status, 200);
    assert.ok((dmMsgsAfterOut.data.messages || []).some((m) => Number(m.id) === Number(playerDmMsg.data.message.id)), 'Player DM message remains visible');
    assert.ok(!(dmMsgsAfterOut.data.messages || []).some((m) => Number(m.id) === Number(eveDmMsg.data.message.id)), 'Opted-out Eve DM message must be hidden');

    // 4. Eve opts back in -> member listing, #general message, reaction, and DM message all restore
    const rejoinRes = await ctx.apiReq('PUT', '/api/auth/clubhouse-opt-in', eveCookie, { opted_in: true });
    assert.equal(rejoinRes.status, 200);

    const bootRejoin = await ctx.apiReq('GET', '/api/bootstrap', ctx.playerCookie);
    assert.ok((bootRejoin.data.members || []).some((m) => Number(m.id) === eveId), 'Rejoined user must reappear in members directory');

    const generalRejoin = await ctx.apiReq('GET', '/api/channels/general/messages', ctx.playerCookie);
    assert.ok((generalRejoin.data.messages || []).some((m) => Number(m.id) === Number(eveMsgId)), 'Rejoined user #general message must be restored');
    const adminMsgRejoin = (generalRejoin.data.messages || []).find((m) => Number(m.id) === Number(adminMsgId));
    assert.ok((adminMsgRejoin.reactions || []).some((r) => Number(r.user_id) === eveId), 'Rejoined user reaction must be restored');

    const dmMsgsRejoin = await ctx.apiReq('GET', `/api/channels/${dmId}/messages`, ctx.playerCookie);
    assert.ok((dmMsgsRejoin.data.messages || []).some((m) => Number(m.id) === Number(eveDmMsg.data.message.id)), 'Rejoined user DM message must be restored');

    // 5. Verify UI controls & strict ES6 preserved
    const clubhouseHtml = fs.readFileSync(path.join(rootDir, 'public', 'clubhouse.html'), 'utf8');
    const clubhouseJs = fs.readFileSync(path.join(rootDir, 'public', 'js', 'clubhouse.js'), 'utf8');
    const profileHtml = fs.readFileSync(path.join(rootDir, 'public', 'profile.html'), 'utf8');
    assert.ok(clubhouseHtml.includes('id="ch-optin-banner"'));
    assert.ok(clubhouseHtml.includes('id="btn-join-clubhouse"'));
    assert.ok(clubhouseJs.includes('btn-clubhouse-opt-toggle'));
    assert.ok(profileHtml.includes('id="btn-profile-clubhouse-optin"'));
    assert.ok(!clubhouseJs.includes('?.') && !clubhouseJs.includes('??'), 'clubhouse.js must remain strict ES6');
  });

  await t.test('T5.17: Channel Read Watermark (POST /api/channels/:id/read) & Attachment Cleanup Delete (DELETE /api/attachments/:id)', async () => {
    // 1. Admin posts a message in #general so Player has unread count, then Player marks channel read
    const postRes = await ctx.apiReq('POST', '/api/channels/general/messages', ctx.adminCookie, {
      content: 'Unread watermark verification message'
    });
    assert.equal(postRes.status, 201);
    const postedId = Number(postRes.data.message.id);
    const generalId = Number(postRes.data.message.channel_id);

    const readRes = await ctx.apiReq('POST', '/api/channels/general/read', ctx.playerCookie, {
      last_read_message_id: postedId
    });
    assert.equal(readRes.status, 200);
    assert.equal(readRes.data.success, true);
    assert.ok(Number(readRes.data.last_read_message_id) >= postedId);

    // 2. Player initializes an attachment session in #general -> Facilitator gets 403 -> Player (uploader) deletes it 200 -> 404 thereafter
    const initAtt = await ctx.apiReq('POST', '/api/attachments/init', ctx.playerCookie, {
      channel_id: generalId,
      file_name: 'temp-check.png',
      mime_type: 'image/png',
      file_size: 128
    });
    assert.equal(initAtt.status, 200);
    const attId = initAtt.data.attachment_id;
    assert.ok(attId, 'Attachment session should return attachment_id');

    const otherDel = await ctx.apiReq('DELETE', `/api/attachments/${attId}`, ctx.facilitatorCookie);
    assert.equal(otherDel.status, 403, 'Unrelated user must get 403 deleting another user attachment');

    const ownerDel = await ctx.apiReq('DELETE', `/api/attachments/${attId}`, ctx.playerCookie);
    assert.equal(ownerDel.status, 200);
    assert.equal(ownerDel.data.success, true);

    const afterDel = await ctx.apiReq('DELETE', `/api/attachments/${attId}`, ctx.playerCookie);
    assert.equal(afterDel.status, 404, 'Deleted attachment must return 404');
  });
};
