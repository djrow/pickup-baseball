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
    const rtcSrc = fs.readFileSync(path.resolve(__dirname, '../../public/js/rtc.js'), 'utf8');
    assert.ok(rtcSrc.includes('broadcastTypingIndicator'), 'rtc.js must route typing indicators over WebRTC DataChannel');
    const apiSrc = fs.readFileSync(path.resolve(__dirname, '../../public/js/api.js'), 'utf8');
    assert.ok(apiSrc.includes('pb_version_last_check'), 'api.js must throttle version checks via localStorage');
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
};
