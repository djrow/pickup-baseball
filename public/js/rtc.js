/**
 * Pickup Baseball Clubhouse — WebRTC P2P Voice, Video, Screen-Share & Ephemeral DataChannel Engine (WP-5)
 * - Supports up to 8 peers per voice lounge (Dugout Voice Huddle, Organizers War Room)
 * - Scoped SDP/ICE signaling via POST /api/rtc/signal & GET /api/sync
 * - Honors "Hide My IP (Privacy Relay Mode)" via iceTransportPolicy: 'relay'
 * - Zero-DB Ephemeral Typing Indicators & Live Presence via RTCDataChannel ('clubhouse-ephemeral')
 */
(function (root) {
  'use strict';

  var HEARTBEAT_INTERVAL_MS = 12000;
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
    localAudioStream: null,
    localScreenStream: null,
    peerConnections: {},
    dataChannels: {},
    remoteStreams: {},
    speakingUsers: {},
    typingUsersByChannel: {},
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

  function getIceConfiguration(privacyRelayMode) {
    var cfg = {
      iceServers: DEFAULT_ICE_SERVERS.slice()
    };
    if (privacyRelayMode) {
      cfg.iceTransportPolicy = 'relay';
    }
    return cfg;
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
      return res.json().catch(function () { return {}; });
    });
  }

  function attachDataChannelHandlers(peerUserId, dc) {
    rtcState.dataChannels[peerUserId] = dc;
    dc.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg && msg.type === 'typing' && msg.channelId) {
          var chId = String(msg.channelId);
          if (!rtcState.typingUsersByChannel[chId]) {
            rtcState.typingUsersByChannel[chId] = {};
          }
          rtcState.typingUsersByChannel[chId][peerUserId] = {
            userId: peerUserId,
            userName: msg.userName || 'Player',
            expiresAt: Date.now() + 4000
          };
          emitRtc('typing_update', { channelId: chId });
        } else if (msg && msg.type === 'speaking') {
          rtcState.speakingUsers[peerUserId] = Boolean(msg.speaking);
          emitRtc('speaking_update', { userId: peerUserId, speaking: Boolean(msg.speaking) });
        }
      } catch (e) {}
    };
    dc.onclose = function () {
      delete rtcState.dataChannels[peerUserId];
    };
  }

  function getOrCreatePeerConnection(peerUserId, isInitiator) {
    var existing = rtcState.peerConnections[peerUserId];
    if (existing) return existing;
    if (typeof RTCPeerConnection === 'undefined') return null;

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

    pc.ondatachannel = function (ev) {
      if (ev.channel) {
        attachDataChannelHandlers(peerUserId, ev.channel);
      }
    };

    if (isInitiator) {
      try {
        var dc = pc.createDataChannel('clubhouse-ephemeral', { ordered: false, maxRetransmits: 0 });
        attachDataChannelHandlers(peerUserId, dc);
      } catch (e) {}
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
    if (!Array.isArray(signals)) return;
    for (var i = 0; i < signals.length; i++) {
      (function (sig) {
        var senderId = Number(sig.sender_user_id);
        var payload = {};
        try {
          payload = typeof sig.payload_json === 'string' ? JSON.parse(sig.payload_json) : (sig.payload_json || {});
        } catch (e) {
          return;
        }

        if (sig.signal_type === 'offer') {
          var pc = getOrCreatePeerConnection(senderId, false);
          if (!pc) return;
          pc.setRemoteDescription(new RTCSessionDescription(payload)).then(function () {
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
          var existingPc = rtcState.peerConnections[senderId];
          if (existingPc && existingPc.signalingState !== 'stable') {
            existingPc.setRemoteDescription(new RTCSessionDescription(payload)).catch(function () {});
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
          throw new Error((data && data.error) || 'Unable to join voice lounge');
        }
        rtcState.activeChannelId = data.channel_id;
        rtcState.activeChannelSlug = String(channelIdOrSlug);
        var participants = Array.isArray(data.participants) ? data.participants : [];

        startHeartbeatLoop();
        emitRtc('voice_joined', {
          channelId: data.channel_id,
          participants: participants
        });

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
      return res.json().catch(function () { return {}; });
    }).then(function (data) {
      emitRtc('voice_state_updated', data);
      return data;
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
      } catch (e) {}
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
      return res.json().catch(function () { return {}; });
    }).then(function (data) {
      emitRtc('voice_left', data);
      return data;
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
        } catch (e) {}
      }
    }
  }

  var ClubhouseRTC = {
    state: rtcState,
    onRtcEvent: onRtcEvent,
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
