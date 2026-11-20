// @ts-check
/**
 * @fileoverview Event Page — Group RSVP Form, Participant/Spectator Steppers, Companion Inputs,
 * Post-RSVP Liability Waiver Prompt, Attendee & Waitlist Roster, Organizer Check-In Waiver Badges/Toggles,
 * Volunteer Task & Certified Shift Checklists, and Backup Hero Credit Redemption UI (`event/rsvp.js`).
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * TABLE OF CONTENTS:
 * 1. Attendee & Waitlist Roster Rendering & Organizer Check-In Actions (`renderAttendeesRoster`, `removeRosterAttendee`)
 * 2. Volunteer Task & Certified Shift Checklist & Backup Hero Credit UI (`renderTasksChecklist`)
 * 3. Group RSVP Form Steppers, Summary & State Machine (`getGroupFormCounts`, `updateGroupSummaryUi`, `setupRsvpState`)
 * 4. Group RSVP Submission, Visitor Privacy Consent & Edit Link Request (`setupRsvpForm`, `setupEditLinkForm`)
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root) return;

  var API = root.API = root.API || /** @type {any} */ ({});
  /** @type {any} */
  var EventUI = API._eventUi = API._eventUi || {};
  var state = EventUI.state = EventUI.state || {
    eventId: /** @type {string|null} */ (null),
    visitorToken: '',
    inviteToken: '',
    eventData: /** @type {any} */ (null),
    eventPublicConfig: /** @type {any} */ (null)
  };

  function el(id) {
    return typeof document !== 'undefined' ? /** @type {any} */ (document.getElementById(id)) : null;
  }

  function isBattingPracticeEnabled() {
    if (typeof EventUI.isBattingPracticeEnabled === 'function') {
      return EventUI.isBattingPracticeEnabled();
    }
    return API.isFeatureEnabled('battingPractice', state.eventPublicConfig);
  }

  function isCertifiedShiftsEnabled() {
    if (typeof EventUI.isCertifiedShiftsEnabled === 'function') {
      return EventUI.isCertifiedShiftsEnabled();
    }
    return API.isFeatureEnabled('certifiedShifts', state.eventPublicConfig);
  }

  async function removeRosterAttendee(attendeeId) {
    var ok = root.PBFDialog
      ? await root.PBFDialog.confirm('Remove this group from the game roster?', { danger: true })
      : false;
    if (!ok) return;
    try {
      var data = await API.removeAttendee(state.eventId, attendeeId);
      if (data.error) {
        if (root.PBFDialog) root.PBFDialog.toast(data.error, { type: 'error' });
      } else if (typeof EventUI.loadEventData === 'function') {
        await EventUI.loadEventData();
      }
    } catch (e) {
      if (root.PBFDialog) root.PBFDialog.toast('Failed to remove attendee.', { type: 'error' });
    }
  }

  function renderAttendeesRoster() {
    var container = el('attendees-container');
    if (!container || !state.eventData || !state.eventData.event) return;
    var eventData = state.eventData;
    var attendees = eventData.attendees || [];
    var waitlist = eventData.waitlist || [];
    var rosterBadge = el('roster-badge');
    var spectatorsBadge = el('spectators-badge');
    var maxParticipants = eventData.event.max_players;

    var confirmedParticipants = eventData.totalAttendees != null ? eventData.totalAttendees : attendees.length;
    var confirmedSpectators = eventData.totalSpectators != null ? eventData.totalSpectators : 0;
    var totalHeadcount = confirmedParticipants + confirmedSpectators;

    if (rosterBadge) {
      if (confirmedSpectators > 0) {
        rosterBadge.textContent = '👥 ' + totalHeadcount + ' ' + (totalHeadcount === 1 ? 'Attendee' : 'Attendees') + ' (' + confirmedParticipants + (maxParticipants ? '/' + maxParticipants : '') + ' ' + (confirmedParticipants === 1 ? 'Player' : 'Players') + ')';
      } else if (maxParticipants && maxParticipants > 0) {
        rosterBadge.textContent = '⚾ ' + confirmedParticipants + '/' + maxParticipants + ' Players';
      } else {
        rosterBadge.textContent = '⚾ ' + confirmedParticipants + ' ' + (confirmedParticipants === 1 ? 'Player' : 'Players');
      }
    }

    if (spectatorsBadge) {
      if (confirmedSpectators > 0) {
        spectatorsBadge.style.display = 'inline-flex';
        spectatorsBadge.textContent = '👏 ' + confirmedSpectators + ' Non-Playing ' + (confirmedSpectators === 1 ? 'Guest' : 'Guests');
      } else {
        spectatorsBadge.style.display = 'none';
        spectatorsBadge.textContent = '';
      }
    }

    var canMod = Boolean(API.currentUser && API.currentUser.canManageEvents);
    var canViewRoster = Boolean(eventData.canViewRoster || eventData.myRsvp || canMod);

    if (!canViewRoster) {
      container.innerHTML =
        '<div class="roster-private-card" style="text-align: center; padding: 28px 20px; background: var(--surface-2, #f5f8f7); border: 1.5px dashed var(--border); border-radius: 12px; margin-top: 8px;">' +
          '<div style="font-size: 2.2rem; margin-bottom: 10px;">🔒</div>' +
          '<h3 style="margin: 0 0 8px 0; color: var(--text); font-size: 1.15rem; font-weight: 700;">' +
            API.escapeHtml(API.t('event.roster_private_title', 'Attendee Roster is Private')) +
          '</h3>' +
          '<p style="margin: 0 auto 16px auto; max-width: 440px; color: var(--text-muted); font-size: 0.92rem; line-height: 1.5;">' +
            API.escapeHtml(API.t('event.roster_private_desc', 'To protect attendee privacy, individual names, non-playing guests, and task assignments are only visible to attendees. RSVP above to see the attendee roster!')) +
          '</p>' +
          '<a href="#rsvp-section" class="btn btn-primary" style="display: inline-flex; align-items: center; gap: 8px; text-decoration: none; padding: 9px 18px; font-size: 0.9rem; font-weight: 600; border-radius: 8px;">' +
            '<span>⚾</span> <span>' + API.escapeHtml(API.t('event.roster_private_cta', 'RSVP to View Attendee Roster')) + '</span>' +
          '</a>' +
        '</div>';
      return;
    }

    var rosterHtml;
    if (attendees.length === 0) {
      rosterHtml =
        '<p style="color: var(--text-muted); font-style: italic; padding: 12px 0;">' +
          API.escapeHtml(API.t('event.no_players_yet')) +
        '</p>';
    } else {
      var attendeeAbbr = API.abbreviateDisplayNames(attendees, 'name', 'user_id', 'Player');
      rosterHtml =
        '<ul class="roster-list">' +
          attendees.map(function (a, idx) {
            var displayName = a.show_full_name ? (a.name || 'Player') : (attendeeAbbr[idx] || API.formatDisplayName(a.name, 'Player'));
            var safeAvatar = API.safeAvatarUrl(a.avatar_url);
            var avatarImg = safeAvatar
              ? '<img src="' + API.escapeHtml(safeAvatar) + '" alt="' + API.escapeHtml(displayName) + '" class="roster-avatar" loading="lazy" decoding="async">'
              : '<span class="roster-avatar-placeholder">' + API.escapeHtml((displayName || 'P').charAt(0).toUpperCase()) + '</span>';
            var translatedDuties = a.duties_assigned
              ? a.duties_assigned.split(',').map(function (part) { return API.translatePhrase(part.trim()); }).join(', ')
              : '';

            var participantCount = a.players_count != null ? a.players_count : (1 + (a.additional_guests || 0));
            var spectatorCount = a.spectators_count || 0;

            var roleBadges = [];
            if (participantCount > 0) {
              roleBadges.push('<span class="badge badge-green" style="font-size: 0.7rem;">⚾ ' + participantCount + ' ' + (participantCount === 1 ? 'Player' : 'Players') + '</span>');
            }

            var bpList = (eventData && eventData.bp_signups) || [];
            var aBp = bpList.find(function (s) {
              return (a.user_id && s.user_id === a.user_id) ||
                (s.attendee_id && s.attendee_id === a.id) ||
                (s.player_name && a.name && s.player_name.trim().toLowerCase() === a.name.trim().toLowerCase());
            });
            if (aBp) {
              roleBadges.push('<span class="badge badge-orange" style="font-size: 0.7rem; font-weight: 700;">⚾ BP #' + aBp.slot_number + '</span>');
            }
            if (spectatorCount > 0) {
              if (participantCount === 0 && translatedDuties) {
                roleBadges.push('<span class="badge badge-volunteer" style="font-size: 0.7rem;">🙌 ' + (spectatorCount === 1 ? 'Volunteer (Non-Playing)' : (spectatorCount + ' Volunteers (Non-Playing)')) + '</span>');
              } else {
                roleBadges.push('<span class="badge badge-spectator" style="font-size: 0.7rem;">👏 ' + spectatorCount + ' Non-Playing ' + (spectatorCount === 1 ? 'Guest' : 'Guests') + '</span>');
              }
            } else if (participantCount === 0 && translatedDuties) {
              roleBadges.push('<span class="badge badge-volunteer" style="font-size: 0.7rem;">🙌 Volunteer (Non-Playing)</span>');
            }

            var isOrganizer = Boolean(API.currentUser && (API.currentUser.canManageEvents || API.currentUser.isAdmin));
            var wStatus = a.waiver_status || 'none';
            var waiverCheckinHtml = '';
            if (isOrganizer) {
              var badgeClass = 'badge-gray';
              var badgeLabel = API.t('event.waiver_badge_unsigned', '⏳ Unsigned');
              var nextAction = 'paper';
              var nextTitle = 'Click to record paper waiver on file';
              var isClickable = true;

              if (wStatus === 'digital') {
                badgeClass = 'badge-green';
                badgeLabel = API.t('event.waiver_badge_digital', '🔏 Digital');
                nextTitle = 'Signed digital waiver (ESIGN sealed)';
                isClickable = false;
              } else if (wStatus === 'paper') {
                badgeClass = 'badge-blue';
                badgeLabel = API.t('event.waiver_badge_paper', '📄 Paper');
                nextAction = 'none';
                nextTitle = 'Click to remove paper waiver';
              }

              var cursorStyle = isClickable ? 'cursor: pointer;' : 'cursor: default;';
              var actionAttr = isClickable
                ? 'data-action="toggle-paper-waiver" data-attendee-id="' + a.id + '" data-user-id="' + (a.user_id || '') + '" data-target-status="' + nextAction + '"'
                : '';

              waiverCheckinHtml = '<button type="button" class="badge ' + badgeClass + '" ' + actionAttr + ' title="' + nextTitle + '" style="font-size: 0.68rem; font-weight: 700; border: none; padding: 2px 7px; ' + cursorStyle + '">' + API.escapeHtml(badgeLabel) + '</button>';
            }

            var companionsVerifyHtml = '';
            var companionCount = participantCount + spectatorCount - 1;
            if (isOrganizer && companionCount > 0) {
              var compWarn = API.t('event.companions_verify_warning', '⚠️ +{count} companion(s) — verify at field', { count: companionCount });
              companionsVerifyHtml = '<div style="font-size: 0.74rem; color: var(--text-muted); margin-top: 2px;">' + API.escapeHtml(compWarn) + '</div>';
            }

            return (
              '<li class="roster-item" style="display: flex; gap: 12px; align-items: flex-start;">' +
                avatarImg +
                '<div style="flex: 1; min-width: 0;">' +
                  '<div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 6px; flex-wrap: wrap;">' +
                    '<div class="roster-name">' +
                      API.escapeHtml(displayName) +
                      (a.is_guest ? '<span style="font-size: 0.75rem; color: var(--text-muted); font-weight: normal;"> ' + API.escapeHtml(API.t('event.guest_tag')) + '</span>' : '') +
                    '</div>' +
                    '<div style="display: flex; gap: 5px; align-items: center; flex-wrap: wrap;">' +
                      roleBadges.join('') +
                      waiverCheckinHtml +
                      (canMod ? '<button type="button" data-action="remove-attendee" data-attendee-id="' + a.id + '" title="Remove from roster" style="background:none;border:none;cursor:pointer;font-size:0.85rem;color:var(--danger);padding:0 2px;">🗑️</button>' : '') +
                    '</div>' +
                  '</div>' +
                  companionsVerifyHtml +
                  (a.guest_names ? '<div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 3px;">👥 <em>' + API.escapeHtml(API.t('event.guests_prefix', 'Group:')) + ' ' + API.escapeHtml(API.formatDisplayNameList(a.guest_names)) + '</em></div>' : '') +
                  (translatedDuties ? '<div style="font-size: 0.79rem; color: var(--primary); font-weight: 700; margin-top: 3px;">🛡️ Group Tasks: ' + API.escapeHtml(translatedDuties) + '</div>' : '') +
                  (a.gear_bringing ? '<div class="roster-gear">🎒 <em>' + API.escapeHtml(a.gear_bringing) + '</em></div>' : '') +
                  (a.bio ? '<div class="player-bio-text">"' + API.escapeHtml(a.bio) + '"</div>' : '') +
                '</div>' +
              '</li>'
            );
          }).join('') +
        '</ul>';
    }

    var waitlistHtml = '';
    if (waitlist.length > 0) {
      var waitlistAbbr = API.abbreviateDisplayNames(waitlist, 'name', 'user_id', 'Player');
      waitlistHtml =
        '<div style="margin-top: 26px; padding-top: 18px; border-top: 1.5px dashed var(--border);">' +
          '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">' +
            '<h4 style="margin: 0; font-size: 0.95rem; color: var(--text-muted); display: flex; align-items: center; gap: 6px;">' +
              '<span>⏳</span> <span>' + API.escapeHtml(API.t('event.waitlist_heading', 'Player Waitlist')) + '</span>' +
            '</h4>' +
            '<span class="badge badge-gray" style="font-size: 0.72rem;">' + waitlist.length + ' waiting</span>' +
          '</div>' +
          '<ul class="roster-list" style="opacity: 0.95;">' +
            waitlist.map(function (w, idx) {
              var wDisplayName = w.show_full_name ? (w.name || 'Player') : (waitlistAbbr[idx] || API.formatDisplayName(w.name, 'Player'));
              var safeAvatar = API.safeAvatarUrl(w.avatar_url);
              var avatarImg = safeAvatar
                ? '<img src="' + API.escapeHtml(safeAvatar) + '" alt="' + API.escapeHtml(wDisplayName) + '" class="roster-avatar" loading="lazy" decoding="async">'
                : '<span class="roster-avatar-placeholder" style="background: var(--bg-subtle); color: var(--text-muted);">' + API.escapeHtml((wDisplayName || 'W').charAt(0).toUpperCase()) + '</span>';
              var wParticipants = w.players_count != null ? w.players_count : (1 + (w.additional_guests || 0));
              var wSpectators = w.spectators_count || 0;
              return (
                '<li class="roster-item" style="display: flex; gap: 12px; align-items: center; padding: 8px 12px;">' +
                  avatarImg +
                  '<div style="flex: 1; min-width: 0;">' +
                    '<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">' +
                      '<div class="roster-name" style="font-size: 0.9rem;">' +
                        API.escapeHtml(wDisplayName) +
                        '<span class="badge badge-subtle" style="font-weight: 700; margin-left: 6px; font-size: 0.7rem; background: var(--bg-subtle); color: var(--secondary); border: 1px solid var(--border);">⚾ ' + wParticipants + ' ' + (wParticipants === 1 ? 'player' : 'players') + (wSpectators > 0 ? ', +' + wSpectators + ' spec.' : '') + '</span>' +
                        (w.is_guest ? '<span style="font-size: 0.72rem; color: var(--text-muted); font-weight: normal;"> ' + API.escapeHtml(API.t('event.guest_tag')) + '</span>' : '') +
                      '</div>' +
                      '<div style="display: flex; gap: 6px; align-items: center;">' +
                        '<span class="badge badge-orange" style="font-size: 0.68rem; font-weight: 700;">Waitlist #' + (idx + 1) + '</span>' +
                        (canMod ? '<button type="button" data-action="remove-attendee" data-attendee-id="' + w.id + '" title="Remove from waitlist" style="background:none;border:none;cursor:pointer;font-size:0.85rem;color:var(--danger);padding:0 2px;">🗑️</button>' : '') +
                      '</div>' +
                    '</div>' +
                    (w.guest_names ? '<div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 2px;">👥 <em>' + API.escapeHtml(API.t('event.guests_prefix', 'Group:')) + ' ' + API.escapeHtml(API.formatDisplayNameList(w.guest_names)) + '</em></div>' : '') +
                  '</div>' +
                '</li>'
              );
            }).join('') +
          '</ul>' +
        '</div>';
    }

    container.innerHTML = rosterHtml + waitlistHtml;
    if (!container.dataset.cspBound) {
      container.dataset.cspBound = '1';
      container.addEventListener('click', async function (e) {
        var target = /** @type {HTMLElement|null} */ (e.target);
        if (!target || typeof target.closest !== 'function') return;
        var removeBtn = /** @type {HTMLElement|null} */ (target.closest('[data-action="remove-attendee"]'));
        if (removeBtn && (!container.contains || container.contains(removeBtn))) {
          removeRosterAttendee(parseInt(removeBtn.dataset.attendeeId || '0', 10));
          return;
        }

        var waiverBtn = /** @type {HTMLButtonElement|null} */ (target.closest('[data-action="toggle-paper-waiver"]'));
        if (waiverBtn && (!container.contains || container.contains(waiverBtn))) {
          var attendeeId = waiverBtn.dataset.attendeeId ? parseInt(waiverBtn.dataset.attendeeId, 10) : null;
          var userId = waiverBtn.dataset.userId ? parseInt(waiverBtn.dataset.userId, 10) : null;
          var targetStatus = waiverBtn.dataset.targetStatus || 'paper';

          waiverBtn.disabled = true;
          try {
            var res;
            if (userId) {
              res = await API.updateUserWaiverStatus(userId, targetStatus);
            } else if (attendeeId) {
              res = await API.updateAttendeeWaiverStatus(attendeeId, targetStatus);
            }
            if (res && res.error) {
              if (root.PBFDialog && typeof root.PBFDialog.toast === 'function') {
                root.PBFDialog.toast(res.error, { type: 'error' });
              } else {
                alert(res.error);
              }
              waiverBtn.disabled = false;
            } else if (typeof EventUI.loadEventData === 'function') {
              await EventUI.loadEventData(true);
            }
          } catch (err) {
            if (root.PBFDialog && typeof root.PBFDialog.toast === 'function') {
              root.PBFDialog.toast((err && err.message) || 'Failed to update waiver status', { type: 'error' });
            }
            waiverBtn.disabled = false;
          }
        }
      });
    }
  }

  function renderTasksChecklist(isInteractive) {
    var dutiesList = el('rsvp-duties-list');
    var eventData = state.eventData;
    if (!dutiesList || !eventData) return;

    var duties = eventData.duties || [];
    if (duties.length === 0) {
      dutiesList.innerHTML = '<div style="font-size: 0.85rem; color: var(--text-muted); font-style: italic;">No volunteer tasks listed for this game.</div>';
      return;
    }

    var myRsvp = eventData.myRsvp;
    var myAssignedDutyIds = (myRsvp && myRsvp.status === 'attending' && Array.isArray(myRsvp.duty_ids)) ? myRsvp.duty_ids : [];
    var isRainout = eventData.event && eventData.event.status === 'rainout';
    var isTasksLocked = Boolean(eventData.event && eventData.event.is_tasks_unlocked === false);
    var taskUnlockAt = eventData.event && eventData.event.task_unlock_at;

    var lockedBannerHtml = '';
    if (isTasksLocked) {
      var formattedUnlock = taskUnlockAt ? new Date(taskUnlockAt).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short'
      }) : 'closer to game day';
      lockedBannerHtml =
        '<div style="padding: 10px 14px; background: var(--bg-subtle); border: 1.5px dashed var(--border); border-radius: var(--radius-sm); margin-bottom: 12px; font-size: 0.82rem; color: var(--text-muted); display: flex; align-items: flex-start; gap: 8px;">' +
          '<span style="font-size: 1.1rem; line-height: 1;">🔒</span>' +
          '<div>' +
            '<strong style="color: var(--text-main); display: block; margin-bottom: 2px;">Tasks unlock on ' + API.escapeHtml(formattedUnlock) + '</strong>' +
            '<span>Under the 12-week Fair-Share Policy, volunteer and paid operations tasks unlock at 5:00 AM on Monday, 12 weeks before game day. You can RSVP as a player or spectator now; tasks can be claimed once unlocked.</span>' +
          '</div>' +
        '</div>';
    }

    var showHeroCreditOption = false;
    var memberHeroCredits = (myRsvp && typeof myRsvp.hero_credits === 'number') ? myRsvp.hero_credits : 0;

    var dutyRowsHtml = duties.map(function (d) {
      var assigned = d.assigned_players || [];
      var isMine = myAssignedDutyIds.indexOf(d.id) !== -1;
      var otherFilledCount = assigned.filter(function (p) { return !myRsvp || p.attendee_id !== myRsvp.id; }).length;
      var totalFilledCount = assigned.length;
      var isFullForMe = otherFilledCount >= d.slots_needed;
      var isCompletelyFull = totalFilledCount >= d.slots_needed;
      var assignedAbbr = API.abbreviateDisplayNames(assigned, 'name', 'user_id', 'Player');
      var volunteerNames = assigned.map(function (p, idx) {
        if (!p || !p.name) return '';
        var display = p.show_full_name ? p.name : (assignedAbbr[idx] || API.formatDisplayName(p.name, 'Player'));
        return API.escapeHtml(display);
      }).filter(Boolean).join(', ');
      var translatedTitle = API.translatePhrase(d.title);
      var translatedDesc = API.translatePhrase(d.description || '');

      var statusPillHtml;
      if (isRainout) {
        statusPillHtml = '<span class="badge badge-gray" style="font-size: 0.68rem;">🌧️ Excused</span>';
      } else if (isCompletelyFull) {
        statusPillHtml = '<span class="badge badge-green" style="font-size: 0.68rem;">✓ ' + (volunteerNames ? volunteerNames : API.escapeHtml(API.t('event.duty_covered', 'Covered'))) + '</span>';
      } else {
        var remaining = Math.max(0, d.slots_needed - totalFilledCount);
        statusPillHtml = '<span class="badge badge-orange" style="font-size: 0.68rem;">' + remaining + ' open</span>';
      }

      var badgePillHtml = '';
      if (isCertifiedShiftsEnabled() && d.is_paid) {
        if (d.duty_type === 'machine') {
          badgePillHtml = '<span class="badge badge-gray" style="font-size: 0.68rem; margin-right: 4px;">⚡ Machine Badge</span>';
        } else if (d.duty_type === 'field') {
          badgePillHtml = '<span class="badge badge-gray" style="font-size: 0.68rem; margin-right: 4px;">🚜 Dragging Badge</span>';
        }
      }

      if (isCertifiedShiftsEnabled() && d.is_urgent_cover && !isCompletelyFull) {
        badgePillHtml += '<span class="badge badge-green" style="font-size: 0.68rem; margin-right: 4px;">🛡️ Urgent Cover (+1 Hero Credit)</span>';
      }

      if (!isInteractive || isTasksLocked) {
        return (
          '<div class="rsvp-task-row is-readonly">' +
            '<div style="font-size: 0.86rem; flex: 1; min-width: 0;">' +
              '<div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 6px; flex-wrap: wrap;">' +
                '<strong style="color: var(--text-main);">' + API.escapeHtml(translatedTitle) + '</strong>' +
                '<div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap;">' +
                  badgePillHtml +
                  statusPillHtml +
                '</div>' +
              '</div>' +
              (translatedDesc ? '<div style="font-size: 0.77rem; color: var(--text-muted); margin-top: 2px;">' + API.escapeHtml(translatedDesc) + '</div>' : '') +
            '</div>' +
          '</div>'
        );
      }

      var ineligibilityReason = d.ineligibility_reason;
      var canUseCredit = Boolean(d.can_use_hero_credit);
      if (canUseCredit) {
        showHeroCreditOption = true;
      }

      var isDisallowedByPolicy = false;
      if (d.is_paid && !d.is_eligible && !isMine) {
        isDisallowedByPolicy = true;
      }

      var disabled = (isFullForMe || isDisallowedByPolicy) && !isMine;
      var rowClasses = ['rsvp-task-row'];
      if (isMine) rowClasses.push('is-checked');
      if (disabled) rowClasses.push('is-disabled');

      return (
        '<label class="' + rowClasses.join(' ') + '">' +
          '<input' +
            ' type="checkbox"' +
            ' name="duty_id"' +
            ' value="' + d.id + '"' +
            (isMine ? ' checked' : '') +
            (disabled ? ' disabled' : '') +
          '>' +
          '<div style="font-size: 0.86rem; flex: 1; min-width: 0;">' +
            '<div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 6px; flex-wrap: wrap;">' +
              '<strong style="color: ' + (disabled ? 'var(--text-muted)' : 'var(--text-main)') + ';">' + API.escapeHtml(translatedTitle) + '</strong>' +
              '<div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap;">' +
                badgePillHtml +
                statusPillHtml +
              '</div>' +
            '</div>' +
            (translatedDesc ? '<div style="font-size: 0.77rem; color: var(--text-muted); margin-top: 2px;">' + API.escapeHtml(translatedDesc) + '</div>' : '') +
            ((!isCompletelyFull && volunteerNames) ? '<div style="font-size: 0.74rem; color: var(--secondary); font-weight: 600; margin-top: 2px;">✓ ' + volunteerNames + '</div>' : '') +
            ((isDisallowedByPolicy && ineligibilityReason) ? '<div style="font-size: 0.74rem; color: var(--danger); font-weight: 600; margin-top: 3px;">⚠️ ' + API.escapeHtml(ineligibilityReason) + '</div>' : '') +
          '</div>' +
        '</label>'
      );
    }).join('');

    var heroCreditBoxHtml = '';
    if (showHeroCreditOption && !isTasksLocked) {
      heroCreditBoxHtml =
        '<div style="padding: 10px 14px; background: var(--bg-subtle); border: 1px solid var(--border); border-radius: var(--radius-sm); margin-top: 12px; font-size: 0.82rem;">' +
          '<label style="display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--secondary); cursor: pointer; margin-bottom: 0;">' +
            '<input type="checkbox" id="redeem-hero-credit-checkbox" name="redeem_hero_credit" value="1">' +
            '<span>🛡️ Redeem 1 Backup Hero Credit (You have ' + memberHeroCredits + ' available)</span>' +
          '</label>' +
          '<p style="font-size: 0.75rem; color: var(--text-muted); margin: 4px 0 0 24px;">' +
            'Redeeming a Backup Hero Credit grants early Tier 1 access to this shift even if you have reached your rolling 3-month fair-share cap.' +
          '</p>' +
        '</div>';
    }

    dutiesList.innerHTML = lockedBannerHtml + dutyRowsHtml + heroCreditBoxHtml;
  }

  function getGroupFormCounts() {
    var participantsInput = /** @type {HTMLInputElement|null} */ (el('rsvp-players-count'));
    var spectatorsInput = /** @type {HTMLInputElement|null} */ (el('rsvp-spectators-count'));
    var p = participantsInput ? parseInt(participantsInput.value, 10) : 1;
    var s = spectatorsInput ? parseInt(spectatorsInput.value, 10) : 0;
    if (isNaN(p) || p < 0) p = 0;
    if (p > 25) p = 25;
    if (isNaN(s) || s < 0) s = 0;
    if (s > 25) s = 25;
    if (participantsInput && String(p) !== participantsInput.value) participantsInput.value = String(p);
    if (spectatorsInput && String(s) !== spectatorsInput.value) spectatorsInput.value = String(s);
    var checkedTasks = typeof document !== 'undefined' && typeof document.querySelectorAll === 'function'
      ? document.querySelectorAll('input[name="duty_id"]:checked').length
      : 0;
    return { playersCount: p, spectatorsCount: s, checkedTasksCount: checkedTasks };
  }

  function updateGroupSummaryUi() {
    var counts = getGroupFormCounts();
    var p = counts.playersCount;
    var s = counts.spectatorsCount;
    var tCount = counts.checkedTasksCount;

    var participantsCard = el('players-counter-card');
    var spectatorsCard = el('spectators-counter-card');
    var pDecBtn = /** @type {HTMLButtonElement|null} */ (el('players-dec-btn'));
    var sDecBtn = /** @type {HTMLButtonElement|null} */ (el('spectators-dec-btn'));
    var summaryEl = el('rsvp-group-summary');
    var submitBtn = /** @type {HTMLButtonElement|null} */ (el('rsvp-submit-btn'));
    var eventData = state.eventData;

    if (participantsCard && participantsCard.classList) participantsCard.classList.toggle('is-active', p > 0);
    if (spectatorsCard && spectatorsCard.classList) spectatorsCard.classList.toggle('is-active', s > 0 || (p === 0 && tCount > 0));
    if (pDecBtn) pDecBtn.disabled = (p <= 0);
    if (sDecBtn) sDecBtn.disabled = (s <= 0);

    if (summaryEl) {
      if (p === 0 && s === 0 && tCount === 0) {
        summaryEl.className = 'rsvp-group-summary is-empty';
        summaryEl.textContent = 'Add at least 1 player, spectator, or volunteer task to RSVP.';
      } else {
        summaryEl.className = 'rsvp-group-summary';
        var parts = [];
        if (p > 0) {
          parts.push(p + ' ' + (p === 1 ? 'player' : 'players'));
        }
        if (s > 0) {
          if (p === 0 && tCount > 0) {
            parts.push(s + ' ' + (s === 1 ? 'volunteer' : 'volunteers/spectators'));
          } else {
            parts.push(s + ' ' + (s === 1 ? 'spectator' : 'spectators'));
          }
        } else if (p === 0 && tCount > 0) {
          parts.push('1 off-field volunteer');
        }
        var totalPeople = p + (s > 0 ? s : (p === 0 && tCount > 0 ? 1 : 0));
        var totalText = (p > 0 && s > 0) ? (' (' + totalPeople + ' people total)') : '';
        var taskText = tCount > 0 ? (' • Covering ' + tCount + ' group ' + (tCount === 1 ? 'task' : 'tasks')) : '';
        summaryEl.textContent = 'Your group: ' + parts.join(' + ') + totalText + taskText;
      }
    }

    if (submitBtn && eventData && eventData.event && !submitBtn.dataset.submitting) {
      var myRsvp = eventData.myRsvp;
      var maxParticipants = eventData.event.max_players;
      var myCurrentParticipants = (myRsvp && myRsvp.status === 'attending')
        ? (myRsvp.players_count != null ? myRsvp.players_count : (1 + (myRsvp.additional_guests || 0)))
        : 0;
      var otherConfirmedParticipants = Math.max(0, (eventData.totalAttendees || 0) - myCurrentParticipants);
      var wouldWaitlist = Boolean(maxParticipants && maxParticipants > 0 && p > 0 && (otherConfirmedParticipants + p > maxParticipants));

      submitBtn.removeAttribute('data-i18n');
      if (wouldWaitlist) {
        submitBtn.textContent = (myRsvp && myRsvp.status === 'waitlist')
          ? API.t('event.update_waitlist_btn', 'Update Waitlist RSVP')
          : API.t('event.join_waitlist_btn', 'Join Player Waitlist');
      } else if (myRsvp && myRsvp.status === 'attending') {
        submitBtn.textContent = API.t('event.update_rsvp_btn', 'Update RSVP');
      } else {
        submitBtn.textContent = API.t('event.submit_rsvp_btn', 'Confirm RSVP');
      }
      if (typeof API.updateOfflineUi === 'function') {
        API.updateOfflineUi();
      }
    }
  }

  async function setupRsvpState(preserveAlertHtml) {
    var eventData = state.eventData;
    if (!eventData || !eventData.event) return;
    var member = API.currentUser;
    var myRsvp = eventData.myRsvp;
    var visitorFields = el('guest-fields');
    var rsvpBadge = el('rsvp-badge-container');
    var rsvpForm = el('rsvp-form');
    var interactiveTop = el('rsvp-interactive-top');
    var interactiveBottom = el('rsvp-interactive-bottom');
    var loginPrompt = el('rsvp-login-prompt');
    var commentVisitorFields = el('comment-guest-fields');
    var commentForm = el('comment-form');
    var rainoutNotice = el('rsvp-rainout-notice');
    var editLinkBox = el('rsvp-edit-link-box');
    var alertDiv = el('rsvp-alert');
    var cancelBtn = el('rsvp-cancel-btn');

    if (!preserveAlertHtml && alertDiv) {
      alertDiv.innerHTML = '';
    }

    var requireLogin = true;
    if (eventData && eventData.require_login_to_rsvp !== undefined) {
      requireLogin = Boolean(eventData.require_login_to_rsvp);
    } else {
      try {
        var s = await API.getSettings();
        if (s && s.require_login_to_rsvp !== undefined) {
          requireLogin = Boolean(s.require_login_to_rsvp);
        }
      } catch (e) {
        console.warn('Could not load RSVP settings:', e);
        if (typeof API !== 'undefined' && API.recordDiagnostic) {
          API.recordDiagnostic({ route: '/api/auth/settings', method: 'GET', status: 0, code: 'EVENT_SETTINGS_FAILED' });
        }
      }
    }

    var isRainout = Boolean(eventData && eventData.event && eventData.event.status === 'rainout');
    var isRestricted = Boolean(eventData && eventData.event && eventData.event.is_restricted);
    var isAllowed = Boolean(eventData && eventData.event && eventData.event.is_allowed_to_rsvp);

    // Comment form auth state (signing in is always required to view or post comments)
    if (member) {
      if (commentForm && commentForm.dataset.lockedRendered === 'true' && commentForm.dataset.originalHtml) {
        commentForm.innerHTML = commentForm.dataset.originalHtml;
        delete commentForm.dataset.lockedRendered;
      }
      var activeVisitorFields = el('comment-guest-fields') || commentVisitorFields;
      if (activeVisitorFields) activeVisitorFields.style.display = 'none';
      var cName = el('comment-author-name');
      if (cName) cName.required = false;
    } else if (commentForm && !commentForm.dataset.lockedRendered) {
      if (!commentForm.dataset.originalHtml) {
        commentForm.dataset.originalHtml = commentForm.innerHTML;
      }
      commentForm.dataset.lockedRendered = 'true';
      commentForm.innerHTML =
        '<div style="background: var(--bg-subtle); border: 1.5px dashed var(--border); border-radius: var(--radius-sm); padding: 18px; text-align: center;">' +
          '<p style="margin: 0 0 10px 0; color: var(--text-muted); font-size: 0.9rem;">' +
            API.escapeHtml(API.t('event.signin_to_comment')) +
          '</p>' +
          '<a href="/login.html?redirect=' + encodeURIComponent(window.location.href) + '" class="btn btn-outline btn-sm" style="font-weight: 700;">' +
            API.escapeHtml(API.t('event.signin_email_btn')) +
          '</a>' +
        '</div>';
    }

    // 1. Rainout state: close RSVP inputs, keep tasks visible in read-only mode
    if (isRainout) {
      if (loginPrompt) loginPrompt.style.display = 'none';
      if (editLinkBox) editLinkBox.style.display = 'none';
      if (interactiveTop) interactiveTop.style.display = 'none';
      if (interactiveBottom) interactiveBottom.style.display = 'none';
      if (rsvpForm) rsvpForm.style.display = 'block';
      if (rainoutNotice) {
        rainoutNotice.style.display = 'block';
        rainoutNotice.className = 'alert alert-rainout';
        if (myRsvp && myRsvp.status === 'attending') {
          rainoutNotice.innerHTML =
            '<strong>🌧️ Game Called for Rain</strong>' +
            '<p style="margin: 6px 0 0 0;">Your group was confirmed for this game. Volunteer task and gear commitments are excused for today. Stay tuned to the discussion board below for updates!</p>';
        } else {
          rainoutNotice.innerHTML =
            '<strong>🌧️ RSVPs Closed</strong>' +
            '<p style="margin: 6px 0 0 0;">RSVPs and task signups are closed because this game has been called for rain.</p>';
        }
      }
      renderTasksChecklist(false);
      return;
    }

    if (rainoutNotice) {
      rainoutNotice.style.display = 'none';
      rainoutNotice.innerHTML = '';
    }

    // 2. Restricted whitelist locked state
    if (isRestricted && !isAllowed) {
      if (editLinkBox) editLinkBox.style.display = 'none';
      if (interactiveTop) interactiveTop.style.display = 'none';
      if (interactiveBottom) interactiveBottom.style.display = 'none';
      if (rsvpForm) rsvpForm.style.display = 'block';
      if (loginPrompt) {
        loginPrompt.className = 'alert alert-warning';
        loginPrompt.style.display = 'block';
        loginPrompt.style.textAlign = 'center';
        if (!member) {
          loginPrompt.innerHTML =
            '<h4 style="margin: 0 0 6px 0; color: var(--secondary); font-size: 1.05rem;">🔒 Private / Invited Roster Only</h4>' +
            '<p style="margin: 0 0 12px 0; font-size: 0.88rem; color: var(--text-muted);">' +
              'RSVP for this pickup game is restricted to an invited roster. Please sign in with your invited email address to RSVP.' +
            '</p>' +
            '<a href="/login.html?redirect=' + encodeURIComponent(window.location.href) + '" class="btn btn-primary" style="font-weight: 700;">' +
              'Sign In with Invited Email' +
            '</a>';
        } else {
          loginPrompt.innerHTML =
            '<h4 style="margin: 0 0 6px 0; color: var(--secondary); font-size: 1.05rem;">🔒 Restricted Roster</h4>' +
            '<p style="margin: 0; font-size: 0.88rem; color: var(--text-muted);">' +
              'RSVP for this game is restricted to an invited list. Your account (<strong dir="ltr" class="tech-token">' + API.escapeHtml(member.email) + '</strong>) is not on the roster for this event. Please contact the organizer if you should be included.' +
            '</p>';
        }
      }
      renderTasksChecklist(false);
      return;
    }

    // 3. Sign-in required and visitor is logged out: show clean sign-in CTA + read-only tasks list
    if (!member && requireLogin) {
      if (editLinkBox) editLinkBox.style.display = 'none';
      if (interactiveTop) interactiveTop.style.display = 'none';
      if (interactiveBottom) interactiveBottom.style.display = 'none';
      if (rsvpForm) rsvpForm.style.display = 'block';
      if (loginPrompt) {
        loginPrompt.className = 'alert alert-info';
        loginPrompt.style.display = 'block';
        loginPrompt.style.textAlign = 'center';
        loginPrompt.innerHTML =
          '<h4 style="margin: 0 0 6px 0; color: var(--secondary); font-size: 1.05rem;">' + API.escapeHtml(API.t('event.signin_required_title')) + '</h4>' +
          '<p style="margin: 0 0 12px 0; font-size: 0.88rem; color: var(--text-muted);">' +
            API.escapeHtml(API.t('event.signin_required_desc')) +
          '</p>' +
          '<a href="/login.html?redirect=' + encodeURIComponent(window.location.href) + '" class="btn btn-primary" style="font-weight: 700;">' +
            API.escapeHtml(API.t('event.signin_required_btn')) +
          '</a>';
      }
      renderTasksChecklist(false);
      return;
    }

    // 4. Interactive RSVP form enabled!
    if (rsvpForm) rsvpForm.style.display = 'block';
    if (interactiveTop) interactiveTop.style.display = 'block';
    if (interactiveBottom) interactiveBottom.style.display = 'block';

    var visitorConsentWrap = el('visitor-consent-wrap');
    var rsvpRosterConsentEl = /** @type {HTMLInputElement|null} */ (el('rsvp-roster-consent'));
    var rsvpNotifyEmailsEl = /** @type {HTMLInputElement|null} */ (el('rsvp-notify-emails'));
    var rsvpNameEl = /** @type {HTMLInputElement|null} */ (el('rsvp-name'));
    var rsvpEmailEl = /** @type {HTMLInputElement|null} */ (el('rsvp-email'));

    if (member) {
      if (loginPrompt) loginPrompt.style.display = 'none';
      if (editLinkBox) editLinkBox.style.display = 'none';
      if (visitorFields) visitorFields.style.display = 'none';
      if (visitorConsentWrap) visitorConsentWrap.style.display = 'none';
      if (rsvpNameEl) rsvpNameEl.required = false;
      if (rsvpEmailEl) rsvpEmailEl.required = false;
    } else {
      if (loginPrompt) loginPrompt.style.display = 'flex';
      if (editLinkBox) editLinkBox.style.display = 'block';
      if (visitorFields) visitorFields.style.display = 'grid';
      if (visitorConsentWrap) visitorConsentWrap.style.display = 'block';
      if (rsvpNameEl) rsvpNameEl.required = true;
      if (rsvpEmailEl) rsvpEmailEl.required = false;
    }

    if (!preserveAlertHtml && isRestricted && isAllowed && member && alertDiv && (!myRsvp || myRsvp.status !== 'attending')) {
      alertDiv.innerHTML = '<div class="alert alert-success" style="font-size: 0.85rem; padding: 8px 12px; margin-bottom: 12px;">✓ Your account is on the invited list for this game.</div>';
    }

    var maxParticipants = eventData.event.max_players;
    var totalParticipants = eventData.totalAttendees != null ? eventData.totalAttendees : (eventData.attendees || []).length;
    var isFull = Boolean(maxParticipants && maxParticipants > 0 && totalParticipants >= maxParticipants);

    var participantsInput = /** @type {HTMLInputElement|null} */ (el('rsvp-players-count'));
    var spectatorsInput = /** @type {HTMLInputElement|null} */ (el('rsvp-spectators-count'));
    var companionNamesInput = /** @type {HTMLInputElement|null} */ (el('rsvp-guest-names'));
    var gearInput = /** @type {HTMLInputElement|null} */ (el('rsvp-gear'));
    var optionalDetails = /** @type {HTMLDetailsElement|null} */ (el('rsvp-optional-details'));

    if (myRsvp) {
      if (rsvpBadge) {
        if (myRsvp.status === 'attending') {
          rsvpBadge.innerHTML = '<span class="badge badge-green">' + API.escapeHtml(API.t('home.you_are_attending')) + '</span>';
          if (cancelBtn) cancelBtn.style.display = 'inline-flex';
        } else if (myRsvp.status === 'waitlist') {
          var waitlist = eventData.waitlist || [];
          var idx = waitlist.findIndex(function (w) { return w.id === myRsvp.id; });
          var myPos = (idx !== -1 ? idx + 1 : 1);
          rsvpBadge.innerHTML = '<span class="badge badge-orange">⏳ ' + API.escapeHtml(API.t('event.waitlist_pos_badge', { pos: myPos })) + '</span>';
          if (cancelBtn) cancelBtn.style.display = 'inline-flex';
          if (!preserveAlertHtml && alertDiv) {
            alertDiv.innerHTML =
              '<div class="alert alert-info" style="border-left: 4px solid var(--primary); border-inline-start: 4px solid var(--primary); background: var(--bg-subtle); margin-bottom: 14px;">' +
                '<strong>⏳ Your Group is #' + myPos + ' on the Player Waitlist</strong>' +
                '<p style="margin: 4px 0 0 0; font-size: 0.86rem; color: var(--text-muted);">' +
                  'The playing roster is at capacity. If a player cancels, you will be promoted automatically and emailed! (Spectators with 0 players can confirm immediately.)' +
                '</p>' +
              '</div>';
          }
        } else {
          rsvpBadge.innerHTML = '<span class="badge badge-gray">' + API.escapeHtml(API.t('event.cant_make_it_badge')) + '</span>';
          if (cancelBtn) cancelBtn.style.display = 'none';
        }
      }

      if (myRsvp.name && rsvpNameEl) rsvpNameEl.value = myRsvp.name;
      if (myRsvp.email && rsvpEmailEl) rsvpEmailEl.value = myRsvp.email;
      if (gearInput) gearInput.value = myRsvp.gear_bringing || '';
      if (companionNamesInput) companionNamesInput.value = myRsvp.guest_names || '';
      if (rsvpRosterConsentEl) rsvpRosterConsentEl.checked = Boolean(myRsvp.roster_consent);
      if (rsvpNotifyEmailsEl) rsvpNotifyEmailsEl.checked = Boolean(myRsvp.notify_emails);

      if (myRsvp.status !== 'declined') {
        var pCount = myRsvp.players_count != null ? myRsvp.players_count : (1 + (myRsvp.additional_guests || 0));
        var sCount = myRsvp.spectators_count != null ? myRsvp.spectators_count : 0;
        if (participantsInput) participantsInput.value = String(pCount);
        if (spectatorsInput) spectatorsInput.value = String(sCount);
      } else {
        if (participantsInput) participantsInput.value = '1';
        if (spectatorsInput) spectatorsInput.value = '0';
      }

      if (optionalDetails) {
        optionalDetails.open = Boolean((myRsvp.gear_bringing && myRsvp.gear_bringing.trim()) || (myRsvp.guest_names && myRsvp.guest_names.trim()));
      }
    } else {
      if (rsvpBadge) rsvpBadge.innerHTML = '';
      if (cancelBtn) cancelBtn.style.display = 'none';
      if (participantsInput) participantsInput.value = '1';
      if (spectatorsInput) spectatorsInput.value = '0';
      if (rsvpRosterConsentEl) rsvpRosterConsentEl.checked = false;
      if (rsvpNotifyEmailsEl) rsvpNotifyEmailsEl.checked = false;
      if (!preserveAlertHtml && isFull && alertDiv) {
        alertDiv.innerHTML =
          '<div class="alert alert-warning" style="border-left: 4px solid var(--primary); border-inline-start: 4px solid var(--primary); background: var(--bg-subtle); margin-bottom: 14px;">' +
            '<strong>⚠️ Playing Roster Full (' + totalParticipants + '/' + maxParticipants + ' Players)</strong>' +
            '<p style="margin: 4px 0 0 0; font-size: 0.86rem; color: var(--text-muted);">' +
              'On-field player signups join the auto-promoting waitlist. Coming as a spectator or off-field volunteer? Set <strong>Players to 0</strong> below to confirm immediately!' +
            '</p>' +
          '</div>';
      }
    }

    var rsvpBpCb = /** @type {HTMLInputElement|null} */ (el('rsvp-bp-signup'));
    if (rsvpBpCb) {
      var hasMyBp = Boolean(eventData.bp_signups && eventData.bp_signups.some(function (s) { return s.is_mine; }));
      rsvpBpCb.checked = hasMyBp;
    }

    renderTasksChecklist(true);
    updateGroupSummaryUi();
  }

  function setupRsvpForm() {
    var form = el('rsvp-form');
    var alertBox = el('rsvp-alert');
    var participantsInput = /** @type {HTMLInputElement|null} */ (el('rsvp-players-count'));
    var spectatorsInput = /** @type {HTMLInputElement|null} */ (el('rsvp-spectators-count'));
    var pDecBtn = el('players-dec-btn');
    var pIncBtn = el('players-inc-btn');
    var sDecBtn = el('spectators-dec-btn');
    var sIncBtn = el('spectators-inc-btn');
    var dutiesList = el('rsvp-duties-list');
    var cancelBtn = /** @type {HTMLButtonElement|null} */ (el('rsvp-cancel-btn'));
    if (!form) return;

    function stepValue(inputEl, delta) {
      if (!inputEl) return;
      var current = parseInt(inputEl.value, 10) || 0;
      var next = Math.max(0, Math.min(25, current + delta));
      inputEl.value = String(next);
      updateGroupSummaryUi();
    }

    if (pDecBtn) pDecBtn.addEventListener('click', function () { stepValue(participantsInput, -1); });
    if (pIncBtn) pIncBtn.addEventListener('click', function () { stepValue(participantsInput, 1); });
    if (sDecBtn) sDecBtn.addEventListener('click', function () { stepValue(spectatorsInput, -1); });
    if (sIncBtn) sIncBtn.addEventListener('click', function () { stepValue(spectatorsInput, 1); });
    if (participantsInput) participantsInput.addEventListener('input', updateGroupSummaryUi);
    if (spectatorsInput) spectatorsInput.addEventListener('input', updateGroupSummaryUi);

    if (dutiesList) {
      dutiesList.addEventListener('change', function (e) {
        var target = /** @type {HTMLInputElement|null} */ (e.target);
        if (target && target.name === 'duty_id') {
          var row = typeof target.closest === 'function' ? target.closest('.rsvp-task-row') : null;
          if (row && row.classList) {
            row.classList.toggle('is-checked', target.checked);
          }
          updateGroupSummaryUi();
        }
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', async function () {
        var submitBtn = /** @type {HTMLButtonElement|null} */ (el('rsvp-submit-btn'));
        cancelBtn.disabled = true;
        cancelBtn.textContent = 'Cancelling...';
        if (submitBtn) submitBtn.disabled = true;
        if (alertBox) alertBox.innerHTML = '';

        var nameEl = /** @type {HTMLInputElement|null} */ (el('rsvp-name'));
        var emailEl = /** @type {HTMLInputElement|null} */ (el('rsvp-email'));
        var name = nameEl ? nameEl.value : '';
        var email = emailEl ? emailEl.value : '';

        try {
          var res = await API.postRsvp(state.eventId, {
            status: 'declined',
            name: name,
            email: email,
            players_count: 0,
            spectators_count: 0,
            gear_bringing: '',
            guest_names: '',
            duty_ids: [],
            management_token: state.visitorToken,
            invite_token: state.inviteToken
          });

          if (res.error) {
            if (alertBox) alertBox.innerHTML = '<div class="alert alert-error">' + API.escapeHtml(res.error) + '</div>';
          } else {
            if (res.managementToken) {
              state.visitorToken = res.managementToken;
              try { localStorage.setItem('guest_token_' + state.eventId, state.visitorToken); } catch (e) { /* localStorage unavailable */ }
            }
            if (alertBox) {
              alertBox.innerHTML = '<div class="alert alert-info">' + API.escapeHtml(res.message || 'Your RSVP has been cancelled.') + '</div>';
            }
            if (typeof EventUI.loadEventData === 'function') {
              await EventUI.loadEventData(true);
            }
          }
        } catch (err) {
          if (alertBox) alertBox.innerHTML = '<div class="alert alert-error">Network error. Please try again.</div>';
        } finally {
          cancelBtn.disabled = false;
          cancelBtn.textContent = API.t('event.cancel_rsvp_btn', "Can't Make It");
          if (submitBtn) submitBtn.disabled = false;
        }
      });
    }

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (alertBox) alertBox.innerHTML = '';

      var counts = getGroupFormCounts();
      var participantsCount = counts.playersCount;
      var spectatorsCount = counts.spectatorsCount;

      var checkedDuties = Array.from(document.querySelectorAll('input[name="duty_id"]:checked'))
        .map(function (cb) { return parseInt(/** @type {HTMLInputElement} */ (cb).value, 10); });

      if (participantsCount === 0 && spectatorsCount === 0 && checkedDuties.length === 0) {
        if (alertBox) {
          alertBox.innerHTML = '<div class="alert alert-error">Please add at least 1 player, spectator, or group task to confirm your RSVP.</div>';
        }
        return;
      }

      if (participantsCount === 0 && spectatorsCount === 0 && checkedDuties.length > 0) {
        spectatorsCount = 1;
      }

      var submitBtn = /** @type {HTMLButtonElement|null} */ (el('rsvp-submit-btn'));
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.dataset.submitting = 'true';
        submitBtn.textContent = API.t('event.saving_rsvp', 'Saving RSVP...');
      }

      var nameEl = /** @type {HTMLInputElement|null} */ (el('rsvp-name'));
      var emailEl = /** @type {HTMLInputElement|null} */ (el('rsvp-email'));
      var name = nameEl ? nameEl.value : '';
      var email = emailEl ? emailEl.value : '';
      var gearEl = /** @type {HTMLInputElement|null} */ (el('rsvp-gear'));
      var gear = gearEl ? gearEl.value : '';
      var companionNamesEl = /** @type {HTMLInputElement|null} */ (el('rsvp-guest-names'));
      var companionNames = ((companionNamesEl && companionNamesEl.value) || '').trim();
      var redeemHeroEl = /** @type {HTMLInputElement|null} */ (el('redeem-hero-credit-checkbox'));
      var redeemHeroCredit = Boolean(isCertifiedShiftsEnabled() && redeemHeroEl && redeemHeroEl.checked);

      var bpSignupEl = /** @type {HTMLInputElement|null} */ (el('rsvp-bp-signup'));
      var bpSignup = Boolean(isBattingPracticeEnabled() && bpSignupEl && bpSignupEl.checked);

      /** @type {Record<string, any>} */
      var payload = {
        status: 'attending',
        name: name,
        email: email,
        players_count: participantsCount,
        spectators_count: spectatorsCount,
        additional_guests: Math.max(0, participantsCount - 1),
        guest_names: companionNames,
        gear_bringing: gear,
        duty_ids: checkedDuties,
        redeem_hero_credit: redeemHeroCredit,
        bp_signup: bpSignup,
        management_token: state.visitorToken,
        invite_token: state.inviteToken
      };

      if (!API.currentUser) {
        var rosterConsentEl = /** @type {HTMLInputElement|null} */ (el('rsvp-roster-consent'));
        var notifyEmailsEl = /** @type {HTMLInputElement|null} */ (el('rsvp-notify-emails'));
        payload.roster_consent = Boolean(rosterConsentEl && rosterConsentEl.checked);
        payload.notify_emails = Boolean(notifyEmailsEl && notifyEmailsEl.checked);
      }

      try {
        var res = await API.postRsvp(state.eventId, payload);
        if (submitBtn) {
          delete submitBtn.dataset.submitting;
          submitBtn.disabled = false;
        }

        if (res.error) {
          if (alertBox) alertBox.innerHTML = '<div class="alert alert-error">' + API.escapeHtml(res.error) + '</div>';
          updateGroupSummaryUi();
        } else {
          if (res.managementToken) {
            state.visitorToken = res.managementToken;
            try { localStorage.setItem('guest_token_' + state.eventId, state.visitorToken); } catch (e) { /* localStorage unavailable */ }
          }
          var alertClass = res.status === 'waitlist' ? 'alert-info' : 'alert-success';
          var promptHtml = '';
          var currentWaiver = (API.currentUser && API.currentUser.waiver_status) || (state.eventData && state.eventData.myRsvp && state.eventData.myRsvp.waiver_status) || 'none';
          if (currentWaiver === 'none') {
            promptHtml =
              '<div style="margin-top: 10px; padding: 10px 12px; background: var(--bg-surface); border: 1px dashed var(--primary); border-radius: 6px; font-size: 0.85rem; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">' +
                '<span data-i18n="event.waiver_prompt_text">' + API.escapeHtml(API.t('event.waiver_prompt_text', '📝 Player Waiver: Please sign the waiver online before arriving at the field.')) + '</span>' +
                '<a href="/waiver.html?redirect=/event.html?id=' + encodeURIComponent(state.eventId || '') + '" class="btn btn-sm btn-primary" style="font-size: 0.8rem; font-weight: 700; text-decoration: none; padding: 4px 10px;" data-i18n="event.waiver_prompt_btn">' + API.escapeHtml(API.t('event.waiver_prompt_btn', 'Sign Waiver Before Arrival →')) + '</a>' +
              '</div>';
          }
          if (alertBox) {
            alertBox.innerHTML = '<div class="alert ' + alertClass + '">' + API.escapeHtml(res.message) + promptHtml + '</div>';
            maybeShowPostRsvpPushPrompt(alertBox);
          }
          if (typeof EventUI.loadEventData === 'function') {
            await EventUI.loadEventData(true);
          }
        }
      } catch (err) {
        if (submitBtn) {
          delete submitBtn.dataset.submitting;
          submitBtn.disabled = false;
        }
        if (alertBox) alertBox.innerHTML = '<div class="alert alert-error">Network error. Please try again.</div>';
        updateGroupSummaryUi();
      }
    });
  }

  function setupEditLinkForm() {
    var toggleBtn = el('rsvp-edit-link-toggle-btn');
    var form = el('rsvp-edit-link-form');
    var emailInput = /** @type {HTMLInputElement|null} */ (el('rsvp-edit-link-email'));
    var submitBtn = /** @type {HTMLButtonElement|null} */ (el('rsvp-edit-link-submit-btn'));
    var statusEl = el('rsvp-edit-link-status');
    if (!toggleBtn || !form || !emailInput || !submitBtn) return;

    toggleBtn.addEventListener('click', function () {
      var isOpen = form.style.display !== 'none';
      form.style.display = isOpen ? 'none' : 'flex';
      toggleBtn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
      if (!isOpen) {
        if (!emailInput.value) {
          var rsvpEmailEl = /** @type {HTMLInputElement|null} */ (el('rsvp-email'));
          if (rsvpEmailEl && rsvpEmailEl.value) {
            emailInput.value = rsvpEmailEl.value.trim();
          }
        }
        emailInput.focus();
      }
    });

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = (emailInput.value || '').trim();
      if (!email) return;

      submitBtn.disabled = true;
      submitBtn.textContent = API.t('event.edit_link_sending', 'Sending...');
      if (statusEl) statusEl.innerHTML = '';

      try {
        var res = await API.requestRsvpEditLink(state.eventId, email);
        if (statusEl) {
          if (res && res.error) {
            statusEl.innerHTML = '<div class="alert alert-error" style="font-size: 0.82rem; margin: 0;">' + API.escapeHtml(res.error) + '</div>';
          } else {
            statusEl.innerHTML = '<div class="alert alert-success" style="font-size: 0.82rem; margin: 0;">' + API.escapeHtml((res && res.message) || 'If an RSVP with that email exists for this event, a fresh edit link has been sent.') + '</div>';
            emailInput.value = '';
          }
        }
      } catch (err) {
        if (statusEl) {
          statusEl.innerHTML = '<div class="alert alert-error" style="font-size: 0.82rem; margin: 0;">Network error. Please try again.</div>';
        }
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = API.t('event.edit_link_send_btn', 'Send Edit Link');
      }
    });
  }

  function maybeShowPostRsvpPushPrompt(alertBox) {
    if (!alertBox || !API.currentUser) return;
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return;
    if (Notification.permission !== 'default') return;
    try {
      if (localStorage.getItem('pbf_push_prompt_dismissed') === '1') return;
    } catch (e) { /* ignore */ }

    fetch('/api/push/vapid-public-key', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (keyRes) {
        if (!keyRes || !keyRes.enabled || !keyRes.publicKey) return;
        var banner = document.createElement('div');
        banner.style.cssText = 'margin-top: 10px; padding: 10px 12px; background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 6px; font-size: 0.84rem; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;';
        var msg = document.createElement('span');
        msg.textContent = '🔔 Want instant rainout & field-change alerts on this device?';
        var actions = document.createElement('div');
        actions.style.cssText = 'display: flex; gap: 6px; align-items: center;';
        var enableBtn = document.createElement('button');
        enableBtn.type = 'button';
        enableBtn.className = 'btn btn-sm btn-primary';
        enableBtn.textContent = 'Enable Rainout Alerts';
        var dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'btn btn-sm btn-outline';
        dismissBtn.textContent = 'Not now';

        enableBtn.addEventListener('click', function () {
          enableBtn.disabled = true;
          Notification.requestPermission().then(function (perm) {
            if (perm !== 'granted') {
              banner.remove();
              return;
            }
            var padding = '='.repeat((4 - (keyRes.publicKey.length % 4)) % 4);
            var base64 = (keyRes.publicKey + padding).replace(/-/g, '+').replace(/_/g, '/');
            var rawData = window.atob(base64);
            var appKey = new Uint8Array(rawData.length);
            for (var i = 0; i < rawData.length; i++) appKey[i] = rawData.charCodeAt(i);
            return navigator.serviceWorker.ready.then(function (reg) {
              return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
            }).then(function (sub) {
              var subJson = sub.toJSON();
              return fetch('/api/push/subscribe', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  endpoint: subJson.endpoint,
                  keys: subJson.keys,
                  notify_rainouts: true,
                  notify_reminders: true,
                  notify_announcements: false
                })
              });
            }).then(function () {
              msg.textContent = '✅ Rainout & reminder push alerts enabled!';
              actions.remove();
            });
          }).catch(function () {
            enableBtn.disabled = false;
          });
        });

        dismissBtn.addEventListener('click', function () {
          try { localStorage.setItem('pbf_push_prompt_dismissed', '1'); } catch (e) { /* ignore */ }
          banner.remove();
        });

        actions.appendChild(enableBtn);
        actions.appendChild(dismissBtn);
        banner.appendChild(msg);
        banner.appendChild(actions);
        alertBox.appendChild(banner);
      })
      .catch(function () { /* ignore */ });
  }

  EventUI.renderAttendeesRoster = renderAttendeesRoster;
  EventUI.removeRosterAttendee = removeRosterAttendee;
  EventUI.renderTasksChecklist = renderTasksChecklist;
  EventUI.getGroupFormCounts = getGroupFormCounts;
  EventUI.updateGroupSummaryUi = updateGroupSummaryUi;
  EventUI.setupRsvpState = setupRsvpState;
  EventUI.setupRsvpForm = setupRsvpForm;
  EventUI.setupEditLinkForm = setupEditLinkForm;
})();
