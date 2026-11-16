/**
 * Pickup Baseball Clubhouse — WebRTC P2P Voice, Video, Screen-Share & Ephemeral DataChannel Engine (WP-5)
 * - Supports up to 8 peers per voice lounge (Dugout Voice Huddle, Organizers War Room)
 * - Scoped SDP/ICE signaling via POST /api/rtc/signal & GET /api/sync
 * - Honors "Hide My IP (Privacy Relay Mode)" via iceTransportPolicy: 'relay'
 * - Zero-DB Ephemeral Typing Indicators & Live Presence via RTCDataChannel ('clubhouse-ephemeral')
 */
(function (root) {
  'use strict';

  var HEARTBEAT_INTERVAL_MS = 16000;
  var DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' }
  ];

  var rtcState = {
    activeChannelId: null,
    activeChannelSlug: null,
    muted: false,
    deafened: false,
    cameraEnabled: false,
    screenSharing: false,
    privacyRelayMode: false,
    turnConfigured: false,
    customIceServers: [],
    iceServers: [],
    localAudioStream: null,
    localScreenStream: null,
    peerConnections: Object.create(null),
    dataChannels: Object.create(null),
    remoteStreams: Object.create(null),
    speakingUsers: Object.create(null),
    typingUsersByChannel: Object.create(null),
    heartbeatTimer: null,
    audioContext: null,
    speakingCheckTimer: null,
    listeners: []
  };

  function onRtcEvent(fn) {
    if (typeof fn === 'function') {
      rtcState.listeners.push(fn);
    }
    return function unsubscribe() {
      var idx = rtcState.listeners.indexOf(fn);
      if (idx !== -1) rtcState.listeners.splice(idx, 1);
    };
  }

  function emitRtc(type, detail) {
    for (var i = 0; i < rtcState.listeners.length; i++) {
      try {
        rtcState.listeners[i](type, detail, rtcState);
      } catch (e) {
        console.error('[ClubhouseRTC] Listener error:', e);
      }
    }
  }

  function getCustomIceServers() {
    if (Array.isArray(rtcState.customIceServers) && rtcState.customIceServers.length > 0) {
      return rtcState.customIceServers.slice();
    }
    if (Array.isArray(rtcState.iceServers) && rtcState.iceServers.length > 0) {
      return rtcState.iceServers.slice();
    }
    return [];
  }

  function isTurnUrl(url) {
    return typeof url === 'string' && /^turns?:/i.test(url.trim());
  }

  function filterTurnOnlyServers(servers) {
    if (!Array.isArray(servers)) return [];
    var out = [];
    for (var i = 0; i < servers.length; i++) {
      var s = servers[i];
      if (!s || !s.urls) continue;
      if (Array.isArray(s.urls)) {
        var turnUrls = [];
        for (var j = 0; j < s.urls.length; j++) {
          if (isTurnUrl(s.urls[j])) {
            turnUrls.push(String(s.urls[j]).trim());
          }
        }
        if (turnUrls.length > 0) {
          var copyArr = { urls: turnUrls };
          if (s.username) copyArr.username = s.username;
          if (s.credential) copyArr.credential = s.credential;
          out.push(copyArr);
        }
      } else if (isTurnUrl(s.urls)) {
        var copySingle = { urls: String(s.urls).trim() };
        if (s.username) copySingle.username = s.username;
        if (s.credential) copySingle.credential = s.credential;
        out.push(copySingle);
      }
    }
    return out;
  }

  function hasTurnRelayServer(servers) {
    return filterTurnOnlyServers(servers).length > 0;
  }

  function getIceServersList() {
    var custom = getCustomIceServers();
    if (custom.length > 0) {
      var hasStun = custom.some(function (s) {
        var u = s && s.urls ? (Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls)) : '';
        return /^stuns?:/i.test(u) || /,stuns?:/i.test(u);
      });
      return hasStun ? custom : DEFAULT_ICE_SERVERS.concat(custom);
    }
    return DEFAULT_ICE_SERVERS.slice();
  }

  function setIceServers(servers) {
    var list = Array.isArray(servers) ? servers.slice() : [];
    rtcState.customIceServers = list;
    rtcState.iceServers = list;
    rtcState.turnConfigured = hasTurnRelayServer(list);
    emitRtc('turn_config_updated', {
      turnConfigured: rtcState.turnConfigured,
      iceServers: list
    });
    return list;
  }

  function setTurnConfigured(configured) {
    rtcState.turnConfigured = Boolean(configured);
    if (!rtcState.turnConfigured) {
      rtcState.customIceServers = [];
      rtcState.iceServers = [];
    }
    emitRtc('turn_config_updated', { turnConfigured: rtcState.turnConfigured });
    return rtcState.turnConfigured;
  }

  function isTurnConfigured() {
    return Boolean(rtcState.turnConfigured) || hasTurnRelayServer(getCustomIceServers());
  }

  function loadIceServers() {
    if (typeof fetch !== 'function') {
      return Promise.resolve({
        turnConfigured: isTurnConfigured(),
        iceServers: getCustomIceServers()
      });
    }
    return fetch('/api/rtc/ice-servers', {
      method: 'GET',
      credentials: 'same-origin'
    }).then(function (res) {
      if (!res.ok) {
        return {
          turnConfigured: isTurnConfigured(),
          iceServers: getCustomIceServers()
        };
      }
      return res.json().then(function (data) {
        if (data && Array.isArray(data.iceServers)) {
          setIceServers(data.iceServers);
        }
        if (data && typeof data.turnConfigured === 'boolean') {
          rtcState.turnConfigured = data.turnConfigured || hasTurnRelayServer(getCustomIceServers());
        }
        return {
          turnConfigured: isTurnConfigured(),
          iceServers: getCustomIceServers()
        };
      }).catch(function () {
        return {
          turnConfigured: isTurnConfigured(),
          iceServers: getCustomIceServers()
        };
      });
    }).catch(function () {
      return {
        turnConfigured: isTurnConfigured(),
        iceServers: getCustomIceServers()
      };
    });
  }

  function getIceConfiguration(privacyRelayMode) {
    var useRelay = privacyRelayMode !== undefined ? Boolean(privacyRelayMode) : Boolean(rtcState.privacyRelayMode);
    if (useRelay) {
      var turnServers = filterTurnOnlyServers(getCustomIceServers());
      if (turnServers.length === 0) {
        console.warn('[ClubhouseRTC] Privacy Relay Mode requested, but no TURN relay server is configured.');
        emitRtc('privacy_relay_unavailable', { reason: 'turn_not_configured' });
        return {
          iceTransportPolicy: 'relay',
          iceServers: []
        };
      }
      return {
        iceTransportPolicy: 'relay',
        iceServers: turnServers
      };
    }
    return {
      iceServers: getIceServersList()
    };
  }

  function sendSignal(channelId, recipientUserId, signalType, payloadObj) {
    return fetch('/api/rtc/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        channel_id: channelId,
        recipient_user_id: Number(recipientUserId),
        signal_type: signalType,
        payload_json: JSON.stringify(payloadObj)
      })
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (errData) {
          if (res.status === 403 && errData && errData.code === 'PEER_BLOCKED') {
            emitRtc('peer_blocked', {
              channelId: channelId,
              recipientUserId: Number(recipientUserId),
              message: errData.error || 'WebRTC signaling is blocked between you and this member.'
            });
          }
          return {};
        });
      }
      return res.json().catch(function () { return {}; });
    }).catch(function () {
      return {};
    });
  }

  var typingCleanupTimers = Object.create(null);

  function attachDataChannelHandlers(peerUserId, dc) {
    var peerKey = Number(peerUserId);
    if (!Number.isInteger(peerKey) || peerKey <= 0) return;
    rtcState.dataChannels[peerKey] = dc;
    dc.onmessage = function (ev) {
      try {
        if (root.ClubhouseStore && typeof root.ClubhouseStore.isPeerBlockedByMe === 'function' && root.ClubhouseStore.isPeerBlockedByMe(peerKey)) {
          return;
        }
        var msg = JSON.parse(ev.data);
        if (msg && msg.type === 'typing' && msg.channelId) {
          var parsedChId = Number(msg.channelId);
          if (!Number.isInteger(parsedChId) || parsedChId <= 0) {
            return;
          }
          var chId = String(parsedChId);
          // Only accept typing indicators for channels this user can actually see
          var knownChannels = (root.ClubhouseStore && root.ClubhouseStore.state && Array.isArray(root.ClubhouseStore.state.channels))
            ? root.ClubhouseStore.state.channels : null;
          if (knownChannels) {
            var channelKnown = false;
            for (var kc = 0; kc < knownChannels.length; kc++) {
              if (Number(knownChannels[kc].id) === parsedChId) { channelKnown = true; break; }
            }
            if (!channelKnown) return;
          }
          if (!rtcState.typingUsersByChannel[chId]) {
            rtcState.typingUsersByChannel[chId] = Object.create(null);
          }
          var memberDisplayName = 'Player';
          if (root.ClubhouseStore && root.ClubhouseStore.state && Array.isArray(root.ClubhouseStore.state.members)) {
            for (var m = 0; m < root.ClubhouseStore.state.members.length; m++) {
              if (Number(root.ClubhouseStore.state.members[m].id) === Number(peerUserId)) {
                var rawMemberName = root.ClubhouseStore.state.members[m].display_name || root.ClubhouseStore.state.members[m].name || '';
                memberDisplayName = rawMemberName
                  ? ((root.API && root.API.formatDisplayName) ? root.API.formatDisplayName(rawMemberName, 'Player') : rawMemberName)
                  : 'Player';
                break;
              }
            }
          }
          rtcState.typingUsersByChannel[chId][peerUserId] = {
            userId: peerUserId,
            userName: memberDisplayName,
            expiresAt: Date.now() + 4000
          };
          var timerKey = chId + ':' + String(peerUserId);
          if (typingCleanupTimers[timerKey]) {
            clearTimeout(typingCleanupTimers[timerKey]);
          }
          typingCleanupTimers[timerKey] = setTimeout(function () {
            delete typingCleanupTimers[timerKey];
            if (rtcState.typingUsersByChannel[chId] && rtcState.typingUsersByChannel[chId][peerUserId]) {
              if (rtcState.typingUsersByChannel[chId][peerUserId].expiresAt <= Date.now()) {
                delete rtcState.typingUsersByChannel[chId][peerUserId];
                emitRtc('typing_update', { channelId: chId });
              }
            }
          }, 4100);
          emitRtc('typing_update', { channelId: chId });
        } else if (msg && msg.type === 'speaking') {
          rtcState.speakingUsers[peerUserId] = Boolean(msg.speaking);
          emitRtc('speaking_update', { userId: peerUserId, speaking: Boolean(msg.speaking) });
        }
      } catch (e) {
        console.warn('[ClubhouseRTC] Ephemeral DataChannel message parse failed:', e);
      }
    };
    dc.onclose = function () {
      if (rtcState.dataChannels[peerKey] === dc) {
        delete rtcState.dataChannels[peerKey];
      }
    };
  }

  function getOrCreatePeerConnection(peerUserId, isInitiator) {
    var existing = rtcState.peerConnections[peerUserId];
    if (existing) return existing;
    if (typeof RTCPeerConnection === 'undefined') return null;
    if (rtcState.privacyRelayMode && !hasTurnRelayServer(getIceServersList())) {
      emitRtc('privacy_relay_unavailable', { peerUserId: peerUserId });
      return null;
    }

    var pc = new RTCPeerConnection(getIceConfiguration(rtcState.privacyRelayMode));
    rtcState.peerConnections[peerUserId] = pc;

    if (rtcState.localAudioStream) {
      var audioTracks = rtcState.localAudioStream.getTracks();
      for (var i = 0; i < audioTracks.length; i++) {
        pc.addTrack(audioTracks[i], rtcState.localAudioStream);
      }
    }
    if (rtcState.localScreenStream) {
      var screenTracks = rtcState.localScreenStream.getTracks();
      for (var j = 0; j < screenTracks.length; j++) {
        pc.addTrack(screenTracks[j], rtcState.localScreenStream);
      }
    }

    pc.onicecandidate = function (ev) {
      if (ev.candidate && rtcState.activeChannelId) {
        if (rtcState.privacyRelayMode) {
          var candStr = String(ev.candidate.candidate || '');
          var candType = ev.candidate.type || '';
          if (candType !== 'relay' && candStr.indexOf(' typ relay') === -1) {
            return;
          }
        }
        sendSignal(rtcState.activeChannelId, peerUserId, 'ice-candidate', {
          candidate: ev.candidate
        });
      }
    };

    pc.ontrack = function (ev) {
      var stream = (ev.streams && ev.streams[0]) ? ev.streams[0] : new MediaStream([ev.track]);
      rtcState.remoteStreams[peerUserId] = stream;
      emitRtc('remote_stream', { userId: peerUserId, stream: stream, track: ev.track });
    };

    var handlePeerDisconnected = function () {
      if (rtcState.remoteStreams[peerUserId]) {
        delete rtcState.remoteStreams[peerUserId];
        emitRtc('remote_stream_removed', { userId: peerUserId });
      }
      if (rtcState.peerConnections[peerUserId] === pc) {
        delete rtcState.peerConnections[peerUserId];
      }
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        handlePeerDisconnected();
      }
    };
    pc.oniceconnectionstatechange = function () {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
        handlePeerDisconnected();
      }
    };

    pc.ondatachannel = function (ev) {
      if (ev.channel) {
        attachDataChannelHandlers(peerUserId, ev.channel);
      }
    };

    if (isInitiator) {
      try {
        var dc = pc.createDataChannel('clubhouse-ephemeral', { ordered: false, maxRetransmits: 0 });
        attachDataChannelHandlers(peerUserId, dc);
      } catch (e) {
        console.warn('[ClubhouseRTC] Failed to create ephemeral data channel:', e);
      }
    }

    return pc;
  }

  function initiateOfferToPeer(peerUserId) {
    var pc = getOrCreatePeerConnection(peerUserId, true);
    if (!pc || !rtcState.activeChannelId) return Promise.resolve();

    return pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer).then(function () {
        return sendSignal(rtcState.activeChannelId, peerUserId, 'offer', {
          type: offer.type,
          sdp: offer.sdp
        });
      });
    }).catch(function (err) {
      console.warn('[ClubhouseRTC] Offer error:', err);
    });
  }

  /**
   * Process incoming rtc_signals delivered by Delta Sync.
   */
  function handleIncomingSignals(signals) {
    if (!rtcState.activeChannelId) return;
    if (!Array.isArray(signals) || signals.length === 0) return;
    for (var i = 0; i < signals.length; i++) {
      (function (sig) {
        if (!sig.channel_id || Number(sig.channel_id) !== Number(rtcState.activeChannelId)) return;
        var senderId = Number(sig.sender_user_id);
        if (!senderId || senderId === Number(rtcState.currentUserId)) return;
        if (root.ClubhouseStore && typeof root.ClubhouseStore.isPeerBlockedByMe === 'function' && root.ClubhouseStore.isPeerBlockedByMe(senderId)) {
          return;
        }
        var payload;
        try {
          payload = typeof sig.payload_json === 'string' ? JSON.parse(sig.payload_json) : (sig.payload_json || {});
        } catch (e) {
          return;
        }

        if (root.ClubhouseStore && root.ClubhouseStore.state && Array.isArray(root.ClubhouseStore.state.voiceParticipants)) {
          var activeInChannel = root.ClubhouseStore.state.voiceParticipants.some(function (p) {
            return Number(p.user_id) === senderId && Number(p.channel_id) === Number(rtcState.activeChannelId);
          });
          if (!activeInChannel) return;
        }

        if (sig.signal_type === 'offer') {
          if (payload.type !== 'offer' || typeof payload.sdp !== 'string' || !payload.sdp) return;
          var pc = getOrCreatePeerConnection(senderId, false);
          if (!pc) return;
          // Ignore offers arriving mid-negotiation (SDP glare / replayed offers) to avoid state disruption
          if (pc.signalingState !== 'stable') return;
          pc.setRemoteDescription(new RTCSessionDescription({ type: payload.type, sdp: payload.sdp })).then(function () {
            return pc.createAnswer();
          }).then(function (answer) {
            return pc.setLocalDescription(answer).then(function () {
              return sendSignal(sig.channel_id, senderId, 'answer', {
                type: answer.type,
                sdp: answer.sdp
              });
            });
          }).catch(function (err) {
            console.warn('[ClubhouseRTC] Answer error:', err);
          });
        } else if (sig.signal_type === 'answer') {
          if (payload.type !== 'answer' || typeof payload.sdp !== 'string' || !payload.sdp) return;
          var existingPc = rtcState.peerConnections[senderId];
          if (existingPc && existingPc.signalingState !== 'stable') {
            existingPc.setRemoteDescription(new RTCSessionDescription({ type: payload.type, sdp: payload.sdp })).catch(function () {});
          }
        } else if (sig.signal_type === 'ice-candidate' && payload.candidate) {
          var targetPc = rtcState.peerConnections[senderId];
          if (targetPc) {
            targetPc.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(function () {});
          }
        }
      })(signals[i]);
    }
  }

  /**
   * Join a voice lounge, acquire microphone (with graceful fallback if denied/headless), and start heartbeat.
   */
  function joinVoiceChannel(channelIdOrSlug, currentUserId) {
    var mediaPromise;
    if (typeof navigator !== 'undefined' && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
      mediaPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      }).catch(function () {
        return null;
      });
    } else {
      mediaPromise = Promise.resolve(null);
    }

    return mediaPromise.then(function (stream) {
      rtcState.localAudioStream = stream;
      return fetch('/api/voice/' + encodeURIComponent(channelIdOrSlug) + '/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          muted: rtcState.muted ? 1 : 0,
          deafened: rtcState.deafened ? 1 : 0,
          screen_sharing: rtcState.screenSharing ? 1 : 0
        })
      });
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || 'Unable to join voice lounge');
          err.status = res.status;
          err.code = (data && data.code) ? data.code : '';
          throw err;
        }
        if (Array.isArray(data.iceServers)) {
          setIceServers(data.iceServers);
        }
        if (typeof data.turnConfigured === 'boolean') {
          rtcState.turnConfigured = data.turnConfigured || hasTurnRelayServer(getCustomIceServers());
        }
        rtcState.activeChannelId = data.channel_id;
        rtcState.activeChannelSlug = String(channelIdOrSlug);
        rtcState.currentUserId = currentUserId ? Number(currentUserId) : null;
        var participants = Array.isArray(data.participants) ? data.participants : [];

        startHeartbeatLoop();
        emitRtc('voice_joined', {
          channelId: data.channel_id,
          participants: participants
        });

        if (rtcState.privacyRelayMode && !hasTurnRelayServer(getCustomIceServers())) {
          emitRtc('privacy_relay_unavailable', { channelId: data.channel_id });
          return data;
        }

        for (var i = 0; i < participants.length; i++) {
          var p = participants[i];
          if (currentUserId && Number(p.user_id) !== Number(currentUserId)) {
            initiateOfferToPeer(Number(p.user_id));
          }
        }
        return data;
      });
    });
  }

  function updateVoiceState(partialState) {
    if (partialState.muted !== undefined) {
      rtcState.muted = Boolean(partialState.muted);
      if (rtcState.localAudioStream) {
        var tracks = rtcState.localAudioStream.getAudioTracks();
        for (var i = 0; i < tracks.length; i++) {
          tracks[i].enabled = !rtcState.muted;
        }
      }
    }
    if (partialState.deafened !== undefined) {
      rtcState.deafened = Boolean(partialState.deafened);
    }
    if (partialState.screenSharing !== undefined) {
      rtcState.screenSharing = Boolean(partialState.screenSharing);
    }

    if (!rtcState.activeChannelId) {
      return Promise.resolve(null);
    }

    return fetch('/api/voice/' + encodeURIComponent(rtcState.activeChannelId) + '/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        muted: rtcState.muted ? 1 : 0,
        deafened: rtcState.deafened ? 1 : 0,
        screen_sharing: rtcState.screenSharing ? 1 : 0
      })
    }).then(function (res) {
      if (!res.ok) return {};
      return res.json().catch(function () { return {}; });
    }).then(function (data) {
      emitRtc('voice_state_updated', data);
      return data;
    }).catch(function () {
      return {};
    });
  }

  function toggleScreenShare() {
    if (rtcState.screenSharing) {
      if (rtcState.localScreenStream) {
        var tracks = rtcState.localScreenStream.getTracks();
        for (var i = 0; i < tracks.length; i++) {
          tracks[i].stop();
        }
        rtcState.localScreenStream = null;
      }
      return updateVoiceState({ screenSharing: false });
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      return updateVoiceState({ screenSharing: true });
    }

    return navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { max: 30 } },
      audio: false
    }).then(function (screenStream) {
      rtcState.localScreenStream = screenStream;
      var videoTrack = screenStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = function () {
          rtcState.localScreenStream = null;
          updateVoiceState({ screenSharing: false });
        };
      }
      var peerIds = Object.keys(rtcState.peerConnections);
      for (var i = 0; i < peerIds.length; i++) {
        var pc = rtcState.peerConnections[peerIds[i]];
        if (pc && videoTrack) {
          pc.addTrack(videoTrack, screenStream);
        }
      }
      emitRtc('local_screen_stream', { stream: screenStream });
      return updateVoiceState({ screenSharing: true });
    }).catch(function () {
      return null;
    });
  }

  function leaveVoiceChannel() {
    var targetId = rtcState.activeChannelId || rtcState.activeChannelSlug;
    stopHeartbeatLoop();

    var peerIds = Object.keys(rtcState.peerConnections);
    for (var i = 0; i < peerIds.length; i++) {
      try {
        rtcState.peerConnections[peerIds[i]].close();
      } catch (e) { /* best-effort peer connection close */ }
    }
    rtcState.peerConnections = {};
    rtcState.dataChannels = {};
    rtcState.remoteStreams = {};

    if (rtcState.localAudioStream) {
      var aTracks = rtcState.localAudioStream.getTracks();
      for (var j = 0; j < aTracks.length; j++) {
        aTracks[j].stop();
      }
      rtcState.localAudioStream = null;
    }
    if (rtcState.localScreenStream) {
      var sTracks = rtcState.localScreenStream.getTracks();
      for (var k = 0; k < sTracks.length; k++) {
        sTracks[k].stop();
      }
      rtcState.localScreenStream = null;
    }

    rtcState.activeChannelId = null;
    rtcState.activeChannelSlug = null;
    rtcState.currentUserId = null;
    rtcState.screenSharing = false;

    if (!targetId) {
      emitRtc('voice_left', {});
      return Promise.resolve();
    }

    return fetch('/api/voice/' + encodeURIComponent(targetId) + '/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin'
    }).then(function (res) {
      if (!res.ok) return {};
      return res.json().catch(function () { return {}; });
    }).then(function (data) {
      emitRtc('voice_left', data);
      return data;
    }).catch(function () {
      emitRtc('voice_left', {});
      return {};
    });
  }

  function startHeartbeatLoop() {
    stopHeartbeatLoop();
    rtcState.heartbeatTimer = setInterval(function () {
      if (rtcState.activeChannelId) {
        updateVoiceState({});
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeatLoop() {
    if (rtcState.heartbeatTimer) {
      clearInterval(rtcState.heartbeatTimer);
      rtcState.heartbeatTimer = null;
    }
  }

  /**
   * Broadcast ephemeral typing indicator over RTCDataChannel (zero database writes).
   */
  function broadcastTypingIndicator(channelId, userName) {
    var payload = JSON.stringify({
      type: 'typing',
      channelId: channelId,
      userName: userName || 'Player',
      timestamp: Date.now()
    });
    var peerIds = Object.keys(rtcState.dataChannels);
    for (var i = 0; i < peerIds.length; i++) {
      var dc = rtcState.dataChannels[peerIds[i]];
      if (dc && dc.readyState === 'open') {
        try {
          dc.send(payload);
        } catch (e) { /* ignore transient DataChannel send failure for typing indicator */ }
      }
    }
  }

  var ClubhouseRTC = {
    state: rtcState,
    onRtcEvent: onRtcEvent,
    setTurnConfigured: setTurnConfigured,
    isTurnConfigured: isTurnConfigured,
    setIceServers: setIceServers,
    loadIceServers: loadIceServers,
    getIceConfiguration: getIceConfiguration,
    joinVoiceChannel: joinVoiceChannel,
    updateVoiceState: updateVoiceState,
    toggleScreenShare: toggleScreenShare,
    leaveVoiceChannel: leaveVoiceChannel,
    handleIncomingSignals: handleIncomingSignals,
    broadcastTypingIndicator: broadcastTypingIndicator
  };

  root.ClubhouseRTC = ClubhouseRTC;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ClubhouseRTC;
  }
})(typeof window !== 'undefined' ? window : globalThis);
