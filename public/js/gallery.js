/**
 * @fileoverview Community Photo & Video Gallery with Full-Width Chronological Carousels.
 * Strict ES6 compatible (no optional chaining or nullish coalescing).
 *
 * TABLE OF CONTENTS:
 * 1. Date Helpers, Ownership Tokens & Pending Moderation Queue (`getSundayOffsetDate`, `renderPendingQueue`)
 * 2. Chronological Album Bookmarks, Photo & Video Carousels (`renderAlbumBookmarks`, `renderPhotos`, `renderVideos`)
 * 3. Carousel Paddles, Lightbox Viewer & Upload/Remote Submission Form (`setupCarouselPaddles`, `setupLightbox`, `setupSubmissionForm`)
 * 4. Toolbar Sorting & Submitter Controls (`setupToolbarListeners`, `renderUserSubmissionsTray`)
 */

(function() {
  'use strict';

  var currentSortOrder = 'asc';
  var galleryMedia = [];
  var galleryAlbums = [];
  var currentLightboxIndex = -1;
  var currentPhotoItems = [];
  var currentUser = null;
  var selectedFiles = /** @type {Array<{ file: File, name: string, mime: string, previewUrl: string }>} */ ([]);

  function stripJpegMetadataClient(buffer) {
    if (window.ClubhouseCrypto && typeof window.ClubhouseCrypto.stripJpegMetadata === 'function') {
      return window.ClubhouseCrypto.stripJpegMetadata(buffer);
    }
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

  function uploadChunksToGDrive(uploadUrl, arrayBuffer, mimeType, progressCb) {
    var CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
    var total = arrayBuffer.byteLength;
    var offset = 0;

    function nextChunk() {
      var end = Math.min(offset + CHUNK_SIZE_BYTES, total);
      var chunk = arrayBuffer.slice(offset, end);
      var contentRange = 'bytes ' + offset + '-' + (end - 1) + '/' + total;

      return fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Range': contentRange,
          'Content-Type': mimeType || 'application/octet-stream'
        },
        body: chunk
      }).then(function (res) {
        if (!res.ok && res.status !== 308) {
          throw new Error('Chunk upload failed with HTTP ' + res.status);
        }
        offset = end;
        var pct = Math.min(92, Math.round(15 + (offset / total) * 77));
        if (typeof progressCb === 'function') {
          progressCb(pct, 'Uploading to PBF Shared Drive (' + Math.round((offset / total) * 100) + '%)...');
        }
        if (offset < total && (res.status === 308 || res.ok)) {
          return nextChunk();
        }
        return res.json().catch(function () { return {}; });
      });
    }

    return nextChunk();
  }

  function slugify(text) {
    return String(text || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function formatDisplayDate(dateStr) {
    if (!dateStr) return '';
    try {
      var parts = String(dateStr).split('-');
      if (parts.length === 3) {
        var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        return new Intl.DateTimeFormat(API.getLang ? API.getLang() : 'en', {
          month: 'short',
          day: 'numeric',
          year: 'numeric'
        }).format(d);
      }
    } catch (e) { /* fallback to raw dateStr */ }
    return dateStr;
  }

  function getSundayOffsetDate(sundayOffset) {
    var now = new Date();
    var day = now.getDay(); // 0 is Sunday
    var diffToLastSunday = day === 0 ? 0 : day;
    var targetSunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToLastSunday - (sundayOffset * 7));
    var y = targetSunday.getFullYear();
    var m = String(targetSunday.getMonth() + 1).padStart(2, '0');
    var d = String(targetSunday.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function isManagerUser() {
    var u = currentUser || (typeof API !== 'undefined' && (API.currentUser || (API.getCachedUser && API.getCachedUser())));
    return Boolean(u && (u.canManageEvents || u.isAdmin || u.role === 'admin' || u.role === 'organizer'));
  }

  // ---------------------------------------------------------------------------
  // Uploader Ownership & Takedown Token Storage
  // ---------------------------------------------------------------------------
  var SUBMISSIONS_STORAGE_KEY = 'pbf_my_media_submissions';

  function getMySubmissions() {
    try {
      var raw = localStorage.getItem(SUBMISSIONS_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveMySubmission(record) {
    if (!record || !record.id) return;
    try {
      var all = getMySubmissions();
      all[record.id] = Object.assign({}, all[record.id] || {}, record);
      localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(all));
    } catch (e) { /* localStorage unavailable */ }
  }

  function removeMySubmission(id) {
    try {
      var all = getMySubmissions();
      delete all[id];
      localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(all));
    } catch (e) { /* localStorage unavailable */ }
  }

  function canUserDeleteMedia(item) {
    if (!item || !item.id) return false;
    if (isManagerUser()) return true;
    if (currentUser && item.contributor_id && currentUser.id === item.contributor_id) return true;
    var my = getMySubmissions();
    if (my[item.id]) return true;
    return false;
  }

  function getMediaDeleteToken(id) {
    var my = getMySubmissions();
    return (my[id] && my[id].token) ? my[id].token : null;
  }

  // ---------------------------------------------------------------------------
  // 1. Initialization
  // ---------------------------------------------------------------------------
  async function initGallery() {
    try {
      if (typeof API !== 'undefined') {
        if (API.getCachedUser) {
          currentUser = API.getCachedUser();
        }
        if (API.currentUser) {
          currentUser = API.currentUser;
        }
        if (API.getMe) {
          try {
            var meData = await API.getMe();
            currentUser = (meData && meData.user) ? meData.user : (meData && meData.id ? meData : (API.currentUser || currentUser));
          } catch (e) {
            currentUser = API.currentUser || currentUser || null;
          }
        }
        if (API.renderNav) {
          API.renderNav(currentUser);
        }
        if (API.renderFooter) {
          API.renderFooter();
        }
      }
    } catch (err) {
      console.warn('[Gallery] Nav init error:', err);
    }

    setupToolbarListeners();
    setupSubmissionForm();
    setupLightbox();
    setupCarouselPaddles();

    try {
      if (typeof API !== 'undefined' && API.getSettings) {
        var appSettings = await API.getSettings();
        var disallowZeroLogin = Boolean(appSettings && appSettings.disallow_zero_login_media);
        var loginNotice = document.getElementById('media-login-required-notice');
        var submitFormEl = document.getElementById('media-submit-form');
        var dropStatusBadge = document.getElementById('media-drop-status-badge');
        if (disallowZeroLogin && !currentUser) {
          if (loginNotice) loginNotice.style.display = 'flex';
          if (submitFormEl) submitFormEl.style.display = 'none';
          if (dropStatusBadge) {
            dropStatusBadge.className = 'badge badge-orange';
            dropStatusBadge.textContent = '🔒 Sign-In Required';
          }
        }
      }
    } catch (e) {
      console.warn('[Gallery] Settings lookup failed:', e);
      if (typeof API !== 'undefined' && API.recordDiagnostic) {
        API.recordDiagnostic({ route: '/api/auth/settings', method: 'GET', status: 0, code: 'GALLERY_SETTINGS_FAILED' });
      }
    }

    await loadGalleryData();

    // Check if URL contains an album anchor
    if (window.location.hash && window.location.hash.startsWith('#album-')) {
      var targetSlug = window.location.hash.replace('#album-', '');
      setTimeout(function() {
        jumpToAlbum(targetSlug);
      }, 400);
    }

    // Check if URL has takedown parameter e.g. /gallery.html?takedown=123&token=abc
    try {
      var urlParams = new URLSearchParams(window.location.search);
      var takedownId = urlParams.get('takedown');
      var takedownToken = urlParams.get('token');
      if (urlParams.has('token') && typeof window.history !== 'undefined' && typeof window.history.replaceState === 'function') {
        try {
          var cleanGalleryUrl = new URL(window.location.href);
          cleanGalleryUrl.searchParams.delete('token');
          window.history.replaceState({}, document.title, cleanGalleryUrl.pathname + cleanGalleryUrl.search + cleanGalleryUrl.hash);
        } catch (e) { /* best-effort URL token strip */ }
      }
      if (takedownId) {
        if (takedownToken) {
          saveMySubmission({ id: parseInt(takedownId, 10), token: takedownToken });
        }
        setTimeout(function() {
          handleDeleteMedia(takedownId, 'submission');
        }, 500);
      }
    } catch (e) {
      console.warn('[Gallery] Takedown URL handling failed:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Data Fetching & Rendering
  // ---------------------------------------------------------------------------
  async function loadGalleryData() {
    var photosContainer = document.getElementById('photos-albums-container');
    var videosContainer = document.getElementById('videos-grid-container');

    try {
      var data = await API.getMedia({
        order: currentSortOrder
      });

      galleryMedia = data && data.media ? data.media : [];
      galleryAlbums = data && data.albums ? data.albums : [];
      var pendingMedia = data && data.pending ? data.pending : [];

      renderPendingQueue(pendingMedia);
      updateCounts();
      updateTimelineLabels();
      renderAlbumBookmarks();
      renderPhotos();
      renderVideos();
      populateAlbumSelectOptions();
      renderUserSubmissionsTray();
    } catch (err) {
      console.error('[Gallery] Failed to load media:', err);
      if (photosContainer) {
        photosContainer.innerHTML = '<div class="alert alert-error" style="margin: 20px;">Failed to load photo carousel: ' + API.escapeHtml(err.message || 'Server error') + '</div>';
      }
      if (videosContainer) {
        videosContainer.innerHTML = '<div class="alert alert-error" style="margin: 20px;">Failed to load video carousel.</div>';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2b. Admin Media Moderation Queue
  // ---------------------------------------------------------------------------
  function renderPendingQueue(pendingList) {
    var queueSection = document.getElementById('media-moderation-queue');
    var listContainer = document.getElementById('pending-media-list');
    var countBadge = document.getElementById('pending-count-badge');
    var isManager = isManagerUser();

    if (!queueSection || !listContainer) return;

    if (!isManager || !pendingList || pendingList.length === 0) {
      queueSection.style.display = 'none';
      return;
    }

    queueSection.style.display = 'block';
    if (countBadge) countBadge.textContent = pendingList.length + ' Hidden from Timeline';

    var pendingAbbr = API.abbreviateDisplayNames ? API.abbreviateDisplayNames(pendingList, 'contributor_name', 'user_id', 'Community User') : [];
    var html = pendingList.map(function(item, pIdx) {
      var dateLabel = formatDisplayDate(item.date_taken);
      var contributor = item.contributor_name
        ? API.escapeHtml(pendingAbbr[pIdx] || API.formatDisplayName(item.contributor_name, 'Community User'))
        : 'Community User';
      var title = item.title ? API.escapeHtml(item.title) : (item.media_type === 'youtube' ? 'YouTube Video' : 'Photo Submission');
      var album = item.album ? API.escapeHtml(item.album) : 'General';
      var thumbHtml;

      if (item.media_type === 'youtube') {
        var ytId = API.getYouTubeId ? API.getYouTubeId(item.file_url || item.original_url) : null;
        if (!ytId) {
          var m = String(item.file_url || item.original_url || '').match(/([\w-]{11})/);
          ytId = m ? m[1] : '';
        }
        var thumbUrl = ytId ? 'https://img.youtube.com/vi/' + ytId + '/hqdefault.jpg' : '/logo.svg';
        thumbHtml = '<img src="' + API.escapeHtml(thumbUrl) + '" alt="' + title + '" class="pending-media-thumb">';
      } else {
        var safeImgUrl = (API.safeUrl ? API.safeUrl(item.file_url) : item.file_url) || '/logo.svg';
        thumbHtml = '<img src="' + API.escapeHtml(safeImgUrl) + '" alt="' + title + '" class="pending-media-thumb">';
      }

      return `
        <div class="pending-media-card" id="pending-card-${item.id}">
          <div class="pending-media-thumb-wrap">
            ${thumbHtml}
            <span class="badge badge-yellow" style="position: absolute; top: 6px; left: 6px; font-size: 0.72rem; font-weight: 700;">⏳ Awaiting Approval</span>
          </div>
          <div class="pending-media-body">
            <div style="font-weight: 700; font-size: 0.92rem; color: var(--secondary);">${title}</div>
            <div style="font-size: 0.78rem; color: var(--text-muted);">
              <span>📅 ${API.escapeHtml(dateLabel)}</span> &bull; <span>📌 ${album}</span>
            </div>
            <div style="font-size: 0.78rem; color: var(--text-muted);">By ${contributor}</div>
            ${item.caption ? `<div style="font-size: 0.8rem; color: var(--text-main); margin-top: 4px; font-style: italic;">"${API.escapeHtml(item.caption)}"</div>` : ''}
            <div class="pending-media-actions">
              <button type="button" class="btn-approve-media" data-media-id="${item.id}">
                ✓ Approve
              </button>
              <button type="button" class="btn-reject-media" data-media-id="${item.id}">
                ✕ Reject
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    listContainer.innerHTML = html;

    listContainer.querySelectorAll('.btn-approve-media').forEach(function(node) {
      var btn = /** @type {HTMLButtonElement} */ (node);
      btn.addEventListener('click', async function() {
        var id = btn.getAttribute('data-media-id') || '';
        btn.disabled = true;
        btn.textContent = 'Approving...';
        try {
          await API.approveMedia(id);
          await loadGalleryData();
        } catch (e) {
          var errObj = /** @type {any} */ (e);
          if (window.PBFDialog) window.PBFDialog.toast((errObj && errObj.message) || 'Failed to approve media.', { type: 'error' });
          btn.disabled = false;
          btn.textContent = '✓ Approve';
        }
      });
    });

    listContainer.querySelectorAll('.btn-reject-media').forEach(function(node) {
      var btn = /** @type {HTMLButtonElement} */ (node);
      btn.addEventListener('click', async function() {
        var id = btn.getAttribute('data-media-id') || '';
        var ok = window.PBFDialog
          ? await window.PBFDialog.confirm('Reject and permanently delete this pending submission?', { danger: true })
          : false;
        if (!ok) return;
        btn.disabled = true;
        btn.textContent = 'Rejecting...';
        try {
          await API.deleteMedia(id);
          await loadGalleryData();
        } catch (e) {
          var errObj = /** @type {any} */ (e);
          if (window.PBFDialog) window.PBFDialog.toast((errObj && errObj.message) || 'Failed to reject media.', { type: 'error' });
          btn.disabled = false;
          btn.textContent = '✕ Reject';
        }
      });
    });
  }

  function updateCounts() {
    var photoCount = 0;
    var videoCount = 0;
    for (var i = 0; i < galleryMedia.length; i++) {
      if (galleryMedia[i].media_type === 'photo') photoCount++;
      if (galleryMedia[i].media_type === 'video' || galleryMedia[i].media_type === 'youtube') videoCount++;
    }

    var countAll = document.getElementById('count-all');
    var countPhotos = document.getElementById('count-photos');
    var countVideos = document.getElementById('count-videos');

    if (countAll) countAll.textContent = String(galleryMedia.length);
    if (countPhotos) countPhotos.textContent = String(photoCount);
    if (countVideos) countVideos.textContent = String(videoCount);
  }

  function updateTimelineLabels() {
    var isAsc = currentSortOrder === 'asc';

    // Photos Ribbon & Edge Hint labels (Earlier on Left, Later on Right by default)
    var pRibbonLeft = document.getElementById('photos-ribbon-left-text');
    var pRibbonRight = document.getElementById('photos-ribbon-right-text');
    var pEdgeLeft = document.getElementById('photos-edge-left-label');
    var pEdgeRight = document.getElementById('photos-edge-right-label');

    if (pRibbonLeft) pRibbonLeft.textContent = isAsc ? 'Earlier (Past Moments)' : 'Later (Newer Moments)';
    if (pRibbonRight) pRibbonRight.textContent = isAsc ? 'Later (Recent Moments)' : 'Earlier (Past Moments)';
    if (pEdgeLeft) pEdgeLeft.textContent = isAsc ? 'Earlier' : 'Newer';
    if (pEdgeRight) pEdgeRight.textContent = isAsc ? 'Later' : 'Earlier';

    // Videos Ribbon & Edge Hint labels
    var vRibbonLeft = document.getElementById('videos-ribbon-left-text');
    var vRibbonRight = document.getElementById('videos-ribbon-right-text');
    var vEdgeLeft = document.getElementById('videos-edge-left-label');
    var vEdgeRight = document.getElementById('videos-edge-right-label');

    if (vRibbonLeft) vRibbonLeft.textContent = isAsc ? 'Earlier (Past Releases)' : 'Later (Recent Releases)';
    if (vRibbonRight) vRibbonRight.textContent = isAsc ? 'Later (Recent Releases)' : 'Earlier (Past Releases)';
    if (vEdgeLeft) vEdgeLeft.textContent = isAsc ? 'Earlier' : 'Newer';
    if (vEdgeRight) vEdgeRight.textContent = isAsc ? 'Later' : 'Earlier';
  }

  // ---------------------------------------------------------------------------
  // 3. Album Bookmarks Bar (Quick Jump Navigation into Photo Carousel)
  // ---------------------------------------------------------------------------
  function renderAlbumBookmarks() {
    var container = document.getElementById('album-bookmarks-bar');
    if (!container) return;

    var photoCount = 0;
    for (var i = 0; i < galleryMedia.length; i++) {
      if (galleryMedia[i].media_type === 'photo') photoCount++;
    }

    var html = '<button type="button" class="album-bookmark-pill active" data-album="all"><span>🌟 All Albums (' + photoCount + ')</span></button>';

    if (galleryAlbums && galleryAlbums.length > 0) {
      for (var a = 0; a < galleryAlbums.length; a++) {
        var alb = galleryAlbums[a];
        var slug = slugify(alb.album);
        html += '<button type="button" class="album-bookmark-pill" data-album-slug="' + API.escapeHtml(slug) + '" data-album-name="' + API.escapeHtml(alb.album) + '">';
        html += '<span>📌 ' + API.escapeHtml(alb.album) + '</span>';
        html += '<span class="badge" style="background: rgba(0,56,49,0.12); color: var(--secondary); font-size: 0.75rem; margin-left: 4px;">' + alb.count + '</span>';
        html += '</button>';
      }
    }

    container.innerHTML = html;

    container.querySelectorAll('.album-bookmark-pill').forEach(function(btn) {
      btn.addEventListener('click', function() {
        container.querySelectorAll('.album-bookmark-pill').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');

        var slug = btn.getAttribute('data-album-slug');
        if (!slug || slug === 'all') {
          jumpToAlbum('all');
        } else {
          jumpToAlbum(slug);
        }
      });
    });
  }

  /**
   * Jump photo carousel directly to the first photo in that particular album.
   */
  function jumpToAlbum(slug) {
    var photoTrack = document.getElementById('photos-albums-container');
    if (!photoTrack) return;

    if (!slug || slug === 'all') {
      photoTrack.scrollTo({ left: 0, behavior: 'smooth' });
      highlightActiveBookmark('all');
      if (history.pushState) history.pushState(null, null, '#');
      return;
    }

    // Find the first photo card belonging to this album safely without selector interpolation
    var targetCard = null;
    var cards = photoTrack.querySelectorAll('.photo-card');
    for (var ci = 0; ci < cards.length; ci++) {
      if (cards[ci].getAttribute('data-album-slug') === String(slug)) {
        targetCard = cards[ci];
        break;
      }
    }
    if (targetCard) {
      // Calculate scroll offset within horizontal track
      var targetOffsetLeft = targetCard.offsetLeft - photoTrack.offsetLeft;
      photoTrack.scrollTo({
        left: Math.max(0, targetOffsetLeft - 16),
        behavior: 'smooth'
      });

      // Provide visual flash highlight on the targeted photo
      targetCard.classList.add('photo-jump-focus');
      setTimeout(function() {
        targetCard.classList.remove('photo-jump-focus');
      }, 1900);

      highlightActiveBookmark(slug);

      if (history.pushState) {
        history.pushState(null, null, '#album-' + slug);
      }
    }
  }

  function highlightActiveBookmark(slug) {
    var container = document.getElementById('album-bookmarks-bar');
    if (!container) return;

    container.querySelectorAll('.album-bookmark-pill').forEach(function(btn) {
      var s = btn.getAttribute('data-album-slug');
      if ((!slug || slug === 'all') && (!s || s === 'all')) {
        btn.classList.add('active');
        btn.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
      } else if (s === slug) {
        btn.classList.add('active');
        btn.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
      } else {
        btn.classList.remove('active');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 4. Render Photo Carousel (Full-Width, Compact Vertical Height, Horizontal)
  // ---------------------------------------------------------------------------
  function renderPhotos() {
    var container = document.getElementById('photos-albums-container');
    var section = document.getElementById('photos-section');
    if (!container || !section) return;

    var photos = [];
    for (var i = 0; i < galleryMedia.length; i++) {
      var item = galleryMedia[i];
      if (item.media_type === 'photo') {
        photos.push(item);
      }
    }

    currentPhotoItems = photos;

    if (photos.length === 0) {
      container.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--text-muted); width: 100%;"><span style="font-size: 1.8rem;">📸</span><br>No photos uploaded yet. Use the media drop below to add Sunday game memories!</div>';
      updateCarouselEdgeHints(container, 'photos-paddle-prev', 'photos-paddle-next', 'photos-edge-left', 'photos-edge-right');
      return;
    }

    var isManager = isManagerUser();
    var _photoAbbr = API.abbreviateDisplayNames ? API.abbreviateDisplayNames(photos, 'contributor_name', 'user_id', 'Community') : [];

    var html = photos.map(function(pt, idx) {
      var ptDate = formatDisplayDate(pt.date_taken);
      var ptTitle = pt.title ? API.escapeHtml(pt.title) : '';
      var ptAlbum = pt.album || 'General';
      var ptAlbumSlug = slugify(ptAlbum);
      var safeImgUrl = (API.safeUrl ? API.safeUrl(pt.file_url) : pt.file_url) || '/logo.svg';

      var canDelete = canUserDeleteMedia(pt);
      var deleteBtn = canDelete ? `
        <button type="button" class="btn-delete-photo" data-media-id="${pt.id}" title="${isManager ? 'Remove Photo from Carousel' : 'Take Down Your Photo'}" aria-label="Take Down Photo">🗑️</button>
      ` : '';

      return `
        <div class="photo-card" id="photo-card-${pt.id}" data-global-index="${idx}" data-album-slug="${API.escapeHtml(ptAlbumSlug)}" data-album-name="${API.escapeHtml(ptAlbum)}">
          <div class="photo-card-img-wrap">
            <img src="${API.escapeHtml(safeImgUrl)}" alt="${ptTitle || 'Baseball Photo'}" loading="lazy" class="photo-card-img">
            <div class="photo-card-overlay">
              <div class="photo-card-meta-row">
                <span>📅 ${API.escapeHtml(ptDate)}</span>
                <span class="photo-card-album-tag" title="Album: ${API.escapeHtml(ptAlbum)}">📌 ${API.escapeHtml(ptAlbum)}</span>
              </div>
              ${ptTitle ? `<div class="photo-card-caption">${ptTitle}</div>` : ''}
            </div>
            ${deleteBtn}
          </div>
        </div>
      `;
    }).join('');

    container.innerHTML = html;

    // Attach Lightbox click handlers
    container.querySelectorAll('.photo-card').forEach(function(card) {
      card.addEventListener('click', function(e) {
        var target = /** @type {HTMLElement|null} */ (e.target);
        if (target && target.closest && target.closest('.btn-delete-photo')) return;
        if (target && target.classList.contains('btn-delete-photo')) return;
        var idx = parseInt(card.getAttribute('data-global-index') || '', 10);
        if (!isNaN(idx)) openLightbox(idx);
      });
    });

    // Attach Admin Delete listeners
    container.querySelectorAll('.btn-delete-photo').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        e.preventDefault();
        var id = btn.getAttribute('data-media-id');
        handleDeleteMedia(id, 'photo');
      });
    });

    // Setup scroll listeners for photo carousel hints
    updateCarouselEdgeHints(container, 'photos-paddle-prev', 'photos-paddle-next', 'photos-edge-left', 'photos-edge-right');
    if (!container.dataset.scrollBound) {
      container.dataset.scrollBound = '1';
      container.addEventListener('scroll', function() {
        updateCarouselEdgeHints(container, 'photos-paddle-prev', 'photos-paddle-next', 'photos-edge-left', 'photos-edge-right');
        syncPhotoScrollWithBookmarks();
      }, { passive: true });
    }
  }

  /**
   * Sync active bookmark pill as user scrolls horizontally through the photo carousel.
   */
  var scrollSyncTimeout = null;
  function syncPhotoScrollWithBookmarks() {
    if (scrollSyncTimeout) clearTimeout(scrollSyncTimeout);
    scrollSyncTimeout = setTimeout(function() {
      var photoTrack = document.getElementById('photos-albums-container');
      if (!photoTrack) return;

      var cards = photoTrack.querySelectorAll('.photo-card');
      if (!cards || cards.length === 0) return;

      var trackLeft = photoTrack.scrollLeft;
      var currentVisibleSlug = null;

      for (var i = 0; i < cards.length; i++) {
        var card = /** @type {HTMLElement} */ (cards[i]);
        if (card.offsetLeft >= trackLeft - 20) {
          currentVisibleSlug = card.getAttribute('data-album-slug');
          break;
        }
      }

      if (currentVisibleSlug) {
        highlightActiveBookmark(currentVisibleSlug);
      }
    }, 150);
  }

  // ---------------------------------------------------------------------------
  // 5. Render Video Carousel (Full-Width, Dedicated Section)
  // ---------------------------------------------------------------------------
  function renderVideos() {
    var container = document.getElementById('videos-grid-container');
    var section = document.getElementById('videos-section');
    if (!container || !section) return;

    var videos = [];
    for (var i = 0; i < galleryMedia.length; i++) {
      var item = galleryMedia[i];
      if (item.media_type === 'video' || item.media_type === 'youtube') {
        videos.push(item);
      }
    }

    if (videos.length === 0) {
      container.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--text-muted); width: 100%;"><span style="font-size: 1.8rem;">🎬</span><br>No video releases yet. Paste YouTube highlights in the submission form below!</div>';
      updateCarouselEdgeHints(container, 'videos-paddle-prev', 'videos-paddle-next', 'videos-edge-left', 'videos-edge-right');
      return;
    }

    var isManager = isManagerUser();

    var videoAbbr = API.abbreviateDisplayNames ? API.abbreviateDisplayNames(videos, 'contributor_name', 'user_id', 'Community') : [];
    var html = videos.map(function(vid, vIdx) {
      var dateLabel = formatDisplayDate(vid.date_taken);
      var contributor = vid.contributor_name
        ? API.escapeHtml(videoAbbr[vIdx] || API.formatDisplayName(vid.contributor_name, 'Community'))
        : 'Community';
      var title = vid.title ? API.escapeHtml(vid.title) : 'Game Highlights';
      var caption = vid.caption ? API.escapeHtml(vid.caption) : '';
      var albumTag = vid.album ? API.escapeHtml(vid.album) : 'General';

      var canDelete = canUserDeleteMedia(vid);
      var playerHtml;
      var gDriveId = API.getGoogleDriveId ? API.getGoogleDriveId(vid.file_url || vid.original_url) : null;
      if (!gDriveId && String(vid.file_url || '').indexOf('drive.google.com/file/d/') !== -1) {
        var mDrive = String(vid.file_url).match(/drive\.google\.com\/file\/d\/([\w-]{25,})/);
        if (mDrive) gDriveId = mDrive[1];
      }

      if (vid.media_type === 'youtube') {
        var ytId = API.getYouTubeId ? API.getYouTubeId(vid.file_url || vid.original_url) : null;
        if (!ytId) {
          var m = String(vid.file_url || vid.original_url || '').match(/([\w-]{11})/);
          ytId = m ? m[1] : '';
        }
        var thumbUrl = ytId ? 'https://img.youtube.com/vi/' + ytId + '/hqdefault.jpg' : '/logo.svg';

        playerHtml = `
          <div class="video-facade-container" data-youtube-id="${API.escapeHtml(ytId)}">
            <img src="${API.escapeHtml(thumbUrl)}" alt="${title}" class="video-facade-thumb" loading="lazy">
            <button type="button" class="video-play-btn" aria-label="Play Video">▶</button>
            <span class="video-badge-pill">YouTube HD</span>
            ${canDelete ? `<button type="button" class="btn-delete-video" data-media-id="${vid.id}" title="${isManager ? 'Remove Video from Carousel' : 'Take Down Your Video'}" aria-label="Take Down Video">🗑️</button>` : ''}
          </div>
        `;
      } else if (gDriveId) {
        var previewUrl = 'https://drive.google.com/file/d/' + encodeURIComponent(gDriveId) + '/preview';
        playerHtml = `
          <div class="video-facade-container video-gdrive-container" style="position: relative; width: 100%; height: 210px; background: #000; border-radius: var(--radius-sm); overflow: hidden;">
            <iframe src="${API.escapeHtml(previewUrl)}" allow="autoplay; fullscreen" style="width: 100%; height: 100%; border: none;" title="${title}"></iframe>
            <span class="video-badge-pill" style="position: absolute; top: 8px; left: 8px; background: rgba(0,0,0,0.7); color: #fff; font-size: 0.7rem; padding: 2px 8px; border-radius: 4px;">Google Drive HD</span>
            ${canDelete ? `<button type="button" class="btn-delete-video" data-media-id="${vid.id}" title="${isManager ? 'Remove Video from Carousel' : 'Take Down Your Video'}" aria-label="Take Down Video">🗑️</button>` : ''}
          </div>
        `;
      } else {
        var safeVidUrl = API.safeUrl ? API.safeUrl(vid.file_url) : vid.file_url;
        playerHtml = `
          <div class="video-native-container" style="position: relative;">
            <video src="${API.escapeHtml(safeVidUrl)}" controls playsinline preload="metadata" class="video-native-player"></video>
            ${canDelete ? `<button type="button" class="btn-delete-video" data-media-id="${vid.id}" title="${isManager ? 'Remove Video from Carousel' : 'Take Down Your Video'}" aria-label="Take Down Video">🗑️</button>` : ''}
          </div>
        `;
      }

      var adminDeleteBtn = canDelete ? `
        <button type="button" class="btn btn-outline btn-xs btn-delete-media" data-media-id="${vid.id}" title="${isManager ? 'Remove Video from Carousel' : 'Take Down Your Video'}" style="color: var(--danger); border-color: #fca5a5; font-size: 0.72rem; padding: 2px 8px; margin-left: auto; cursor: pointer;">
          🗑️ ${isManager ? 'Remove' : 'Take Down'}
        </button>
      ` : '';

      return `
        <div class="video-card" data-video-id="${vid.id}">
          ${playerHtml}
          <div class="video-card-body">
            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px; flex-wrap: wrap;">
              <span class="badge badge-orange" style="font-size: 0.72rem; padding: 2px 6px;">📅 ${API.escapeHtml(dateLabel)}</span>
              <span class="badge" style="background: var(--bg-subtle); color: var(--text-muted); font-size: 0.72rem; padding: 2px 6px;">📌 ${albumTag}</span>
              ${adminDeleteBtn}
            </div>
            <h3 style="font-size: 0.95rem; color: var(--text-main); margin: 0 0 2px 0; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${title}</h3>
            <p style="font-size: 0.78rem; color: var(--text-muted); margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">By ${contributor}${caption ? ' · ' + caption : ''}</p>
          </div>
        </div>
      `;
    }).join('');

    container.innerHTML = html;

    // Attach YouTube Lite Facade Click Listeners
    container.querySelectorAll('.video-facade-container').forEach(function(facade) {
      facade.addEventListener('click', function(e) {
        var target = /** @type {HTMLElement|null} */ (e.target);
        if (target && target.closest && (target.closest('.btn-delete-video') || target.closest('.btn-delete-media'))) return;
        if (target && (target.classList.contains('btn-delete-video') || target.classList.contains('btn-delete-media'))) return;
        var ytId = facade.getAttribute('data-youtube-id');
        if (!ytId) return;
        var iframe = document.createElement('iframe');
        iframe.setAttribute('src', 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(ytId) + '?autoplay=1&rel=0');
        iframe.setAttribute('title', 'YouTube Video Player');
        iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
        iframe.setAttribute('allowfullscreen', 'true');
        iframe.className = 'video-embed-iframe';
        facade.innerHTML = '';
        facade.appendChild(iframe);
      });
    });

    // Attach Admin Delete Listeners
    container.querySelectorAll('.btn-delete-video, .btn-delete-media').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        e.preventDefault();
        var id = btn.getAttribute('data-media-id');
        handleDeleteMedia(id, 'video');
      });
    });

    // Setup scroll listeners for video carousel hints
    updateCarouselEdgeHints(container, 'videos-paddle-prev', 'videos-paddle-next', 'videos-edge-left', 'videos-edge-right');
    if (!container.dataset.scrollBound) {
      container.dataset.scrollBound = '1';
      container.addEventListener('scroll', function() {
        updateCarouselEdgeHints(container, 'videos-paddle-prev', 'videos-paddle-next', 'videos-edge-left', 'videos-edge-right');
      }, { passive: true });
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Carousel Paddles & Edge Hints Controller
  // ---------------------------------------------------------------------------
  function setupCarouselPaddles() {
    var pTrack = document.getElementById('photos-albums-container');
    var pPrev = document.getElementById('photos-paddle-prev');
    var pNext = document.getElementById('photos-paddle-next');

    if (pPrev && pTrack) {
      pPrev.addEventListener('click', function() {
        var distance = Math.max(260, pTrack.clientWidth * 0.75);
        pTrack.scrollBy({ left: -distance, behavior: 'smooth' });
      });
    }
    if (pNext && pTrack) {
      pNext.addEventListener('click', function() {
        var distance = Math.max(260, pTrack.clientWidth * 0.75);
        pTrack.scrollBy({ left: distance, behavior: 'smooth' });
      });
    }

    var vTrack = document.getElementById('videos-grid-container');
    var vPrev = document.getElementById('videos-paddle-prev');
    var vNext = document.getElementById('videos-paddle-next');

    if (vPrev && vTrack) {
      vPrev.addEventListener('click', function() {
        var distance = Math.max(340, vTrack.clientWidth * 0.75);
        vTrack.scrollBy({ left: -distance, behavior: 'smooth' });
      });
    }
    if (vNext && vTrack) {
      vNext.addEventListener('click', function() {
        var distance = Math.max(340, vTrack.clientWidth * 0.75);
        vTrack.scrollBy({ left: distance, behavior: 'smooth' });
      });
    }
  }

  function updateCarouselEdgeHints(trackEl, prevBtnId, nextBtnId, leftHintId, rightHintId) {
    if (!trackEl) return;
    var prevBtn = document.getElementById(prevBtnId);
    var nextBtn = document.getElementById(nextBtnId);
    var leftHint = document.getElementById(leftHintId);
    var rightHint = document.getElementById(rightHintId);

    var scrollLeft = trackEl.scrollLeft;
    var maxScrollLeft = trackEl.scrollWidth - trackEl.clientWidth;

    // Check left boundary (at start)
    if (scrollLeft <= 10) {
      if (prevBtn) prevBtn.classList.add('paddle-disabled');
      if (leftHint) leftHint.classList.add('edge-hidden');
    } else {
      if (prevBtn) prevBtn.classList.remove('paddle-disabled');
      if (leftHint) leftHint.classList.remove('edge-hidden');
    }

    // Check right boundary (at end)
    if (scrollLeft >= maxScrollLeft - 10 || maxScrollLeft <= 0) {
      if (nextBtn) nextBtn.classList.add('paddle-disabled');
      if (rightHint) rightHint.classList.add('edge-hidden');
    } else {
      if (nextBtn) nextBtn.classList.remove('paddle-disabled');
      if (rightHint) rightHint.classList.remove('edge-hidden');
    }
  }

  // ---------------------------------------------------------------------------
  // 7. Fullscreen Lightbox Modal
  // ---------------------------------------------------------------------------
  function setupLightbox() {
    var modal = document.getElementById('gallery-lightbox');
    var closeBtn = document.getElementById('lightbox-close');
    var prevBtn = document.getElementById('lightbox-prev');
    var nextBtn = document.getElementById('lightbox-next');
    var deleteBtn = document.getElementById('lightbox-delete-btn');

    if (!modal) return;

    if (closeBtn) closeBtn.addEventListener('click', closeLightbox);
    if (prevBtn) prevBtn.addEventListener('click', prevLightbox);
    if (nextBtn) nextBtn.addEventListener('click', nextLightbox);
    if (deleteBtn) {
      deleteBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var photo = currentPhotoItems[currentLightboxIndex];
        if (photo && photo.id) {
          handleDeleteMedia(photo.id, 'photo');
        }
      });
    }

    modal.addEventListener('click', function(e) {
      if (e.target === modal) closeLightbox();
    });

    window.addEventListener('keydown', function(e) {
      if (modal.style.display !== 'none') {
        if (e.key === 'Escape') closeLightbox();
        if (e.key === 'ArrowLeft') prevLightbox();
        if (e.key === 'ArrowRight') nextLightbox();
      }
    });
  }

  function openLightbox(index) {
    if (index < 0 || index >= currentPhotoItems.length) return;
    currentLightboxIndex = index;
    updateLightboxContent();
    var modal = document.getElementById('gallery-lightbox');
    if (modal) modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    var modal = document.getElementById('gallery-lightbox');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';
  }

  function prevLightbox() {
    if (currentLightboxIndex > 0) {
      currentLightboxIndex--;
    } else {
      currentLightboxIndex = currentPhotoItems.length - 1;
    }
    updateLightboxContent();
  }

  function nextLightbox() {
    if (currentLightboxIndex < currentPhotoItems.length - 1) {
      currentLightboxIndex++;
    } else {
      currentLightboxIndex = 0;
    }
    updateLightboxContent();
  }

  function updateLightboxContent() {
    var photo = currentPhotoItems[currentLightboxIndex];
    if (!photo) return;

    var img = /** @type {HTMLImageElement|null} */ (document.getElementById('lightbox-img'));
    var caption = document.getElementById('lightbox-caption');
    var meta = document.getElementById('lightbox-meta');

    if (img) {
      img.src = API.safeUrl ? API.safeUrl(photo.file_url) : photo.file_url;
      img.alt = photo.title || 'Baseball Gallery Photo';
    }
    if (caption) {
      caption.textContent = photo.title || photo.caption || ('Photo ' + (currentLightboxIndex + 1) + ' of ' + currentPhotoItems.length);
    }
    if (meta) {
      var d = formatDisplayDate(photo.date_taken);
      var lightboxAbbr = API.abbreviateDisplayNames ? API.abbreviateDisplayNames(currentPhotoItems, 'contributor_name', 'user_id', 'Community Member') : [];
      var c = photo.contributor_name
        ? (lightboxAbbr[currentLightboxIndex] || (API.formatDisplayName ? API.formatDisplayName(photo.contributor_name, 'Community Member') : photo.contributor_name))
        : 'Community Member';
      var a = photo.album ? photo.album : 'General';
      meta.textContent = '📅 ' + d + ' • 📷 By ' + c + ' • 📌 ' + a + ' (' + (currentLightboxIndex + 1) + '/' + currentPhotoItems.length + ')';
    }

    var deleteBtn = document.getElementById('lightbox-delete-btn');
    if (deleteBtn) {
      var canDelete = canUserDeleteMedia(photo);
      deleteBtn.style.display = canDelete ? 'inline-flex' : 'none';
      deleteBtn.textContent = isManagerUser() ? '🗑️ Remove Photo from Carousel' : '🗑️ Take Down Your Photo';
      deleteBtn.setAttribute('data-media-id', photo.id);
    }
  }

  // ---------------------------------------------------------------------------
  // 8. Community Zero-Login Submission Form
  // ---------------------------------------------------------------------------
  function setupSubmissionForm() {
    var form = document.getElementById('media-submit-form');
    var modeUploadBtn = document.getElementById('tab-mode-upload');
    var modeLinkBtn = document.getElementById('tab-mode-link');
    var uploadContainer = document.getElementById('mode-upload-container');
    var linkContainer = document.getElementById('mode-link-container');
    var fileInput = /** @type {HTMLInputElement|null} */ (document.getElementById('media-file-input'));
    var browseBtn = document.getElementById('btn-browse-files');
    var dropzone = document.getElementById('media-dropzone');
    var dateInput = /** @type {HTMLInputElement|null} */ (document.getElementById('media-date-input'));
    var albumSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('media-album-select'));
    var newAlbumWrap = document.getElementById('new-album-wrap');
    var urlInput = /** @type {HTMLInputElement|null} */ (document.getElementById('media-url-input'));

    // Default date input to most recent Sunday
    if (dateInput) {
      dateInput.value = getSundayOffsetDate(0);
    }

    var managerOpts = document.getElementById('media-manager-options');
    if (managerOpts && isManagerUser()) {
      managerOpts.style.display = 'block';
    }

    // Quick Date Selector Buttons
    document.querySelectorAll('.btn-quick-date').forEach(function(btn) {
      btn.addEventListener('click', function() {
        if (!dateInput) return;
        var days = btn.getAttribute('data-days');
        var sun = btn.getAttribute('data-sunday');
        if (days === '0') {
          dateInput.value = new Date().toISOString().slice(0, 10);
        } else if (sun === 'last') {
          dateInput.value = getSundayOffsetDate(0);
        } else if (sun === 'prev') {
          dateInput.value = getSundayOffsetDate(1);
        }
      });
    });

    // Mode Toggle Buttons (Upload vs Link)
    if (modeUploadBtn && modeLinkBtn) {
      modeUploadBtn.addEventListener('click', function() {
        modeUploadBtn.className = 'btn btn-sm btn-primary submission-tab-btn active';
        modeLinkBtn.className = 'btn btn-sm btn-outline submission-tab-btn';
        if (uploadContainer) uploadContainer.style.display = 'block';
        if (linkContainer) linkContainer.style.display = 'none';
        updateLivePreview();
      });

      modeLinkBtn.addEventListener('click', function() {
        modeLinkBtn.className = 'btn btn-sm btn-primary submission-tab-btn active';
        modeUploadBtn.className = 'btn btn-sm btn-outline submission-tab-btn';
        if (linkContainer) linkContainer.style.display = 'block';
        if (uploadContainer) uploadContainer.style.display = 'none';
        updateLivePreview();
      });
    }

    // Dropzone & File Browse
    if (browseBtn && fileInput) {
      browseBtn.addEventListener('click', function() { fileInput.click(); });
    }
    if (dropzone && fileInput) {
      dropzone.addEventListener('click', function(e) {
        if (e.target !== browseBtn) fileInput.click();
      });
      dropzone.addEventListener('dragover', function(e) {
        e.preventDefault();
        dropzone.classList.add('dropzone-dragover');
      });
      dropzone.addEventListener('dragleave', function() {
        dropzone.classList.remove('dropzone-dragover');
      });
      dropzone.addEventListener('drop', function(e) {
        e.preventDefault();
        dropzone.classList.remove('dropzone-dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          handleFilesChosen(e.dataTransfer.files);
        }
      });
      fileInput.addEventListener('change', function() {
        if (fileInput.files && fileInput.files.length > 0) {
          handleFilesChosen(fileInput.files);
        }
      });
    }

    // Album Selection & Custom Album Name
    if (albumSelect && newAlbumWrap) {
      albumSelect.addEventListener('change', function() {
        if (albumSelect.value === '__NEW__') {
          newAlbumWrap.style.display = 'block';
          var newInp = document.getElementById('media-new-album-input');
          if (newInp) newInp.focus();
        } else {
          newAlbumWrap.style.display = 'none';
        }
      });
    }

    // URL change live preview
    if (urlInput) {
      urlInput.addEventListener('input', updateLivePreview);
      urlInput.addEventListener('change', updateLivePreview);
    }

    // Form Submit
    if (form) {
      form.addEventListener('submit', handleFormSubmit);
    }
  }

  var ALLOWED_UPLOAD_MIME = [
    'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
    'video/mp4', 'video/webm'
  ];

  var ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.mp4', '.webm'];

  function isAllowedMediaType(file) {
    if (!file) return false;
    var type = (file.type || '').toLowerCase();
    if (ALLOWED_UPLOAD_MIME.indexOf(type) !== -1) return true;
    var name = (file.name || '').toLowerCase();
    for (var i = 0; i < ALLOWED_EXTENSIONS.length; i++) {
      if (name.endsWith(ALLOWED_EXTENSIONS[i])) return true;
    }
    return false;
  }

  function inferMediaMime(file) {
    var mime = (file && file.type) ? String(file.type).toLowerCase() : '';
    if (mime) return mime;
    var name = (file && file.name ? String(file.name) : '').toLowerCase();
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.webp')) return 'image/webp';
    if (name.endsWith('.gif')) return 'image/gif';
    if (name.endsWith('.avif')) return 'image/avif';
    if (name.endsWith('.mp4')) return 'video/mp4';
    if (name.endsWith('.webm')) return 'video/webm';
    return 'image/jpeg';
  }

  function updateSelectedFilesLabel() {
    var fileNameLabel = document.getElementById('dropzone-file-name');
    if (!fileNameLabel) return;
    if (selectedFiles.length === 0) {
      fileNameLabel.textContent = '';
      return;
    }
    var totalBytes = 0;
    for (var i = 0; i < selectedFiles.length; i++) {
      totalBytes += Number(selectedFiles[i].file.size || 0);
    }
    var sizeText = totalBytes > 1024 * 1024
      ? (totalBytes / (1024 * 1024)).toFixed(2) + ' MB'
      : Math.max(1, Math.round(totalBytes / 1024)) + ' KB';
    if (selectedFiles.length === 1) {
      fileNameLabel.textContent = '✓ Selected 1 file: ' + selectedFiles[0].name + ' (' + sizeText + ') · Full uncompressed quality';
    } else {
      fileNameLabel.textContent = '✓ Selected ' + selectedFiles.length + ' files (' + sizeText + ' total) · Full uncompressed quality';
    }
  }

  function clearSelectedFiles() {
    for (var i = 0; i < selectedFiles.length; i++) {
      if (selectedFiles[i].previewUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        try { URL.revokeObjectURL(selectedFiles[i].previewUrl); } catch (e) { /* ignore */ }
      }
    }
    selectedFiles = [];
    var fileInput = /** @type {HTMLInputElement|null} */ (document.getElementById('media-file-input'));
    if (fileInput) fileInput.value = '';
    updateSelectedFilesLabel();
  }

  function handleFilesChosen(fileList) {
    if (!fileList || fileList.length === 0) return;
    var maxBytes = 50 * 1024 * 1024; // 50MB max file size
    var maxBatch = 50;
    var skipped = [];

    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      if (!f) continue;
      if (selectedFiles.length >= maxBatch) {
        skipped.push(f.name + ' (batch limit of ' + maxBatch + ' files reached)');
        continue;
      }
      if (!isAllowedMediaType(f)) {
        skipped.push(f.name + ' (unsupported format)');
        continue;
      }
      if (f.size > maxBytes) {
        skipped.push(f.name + ' (' + (f.size / 1024 / 1024).toFixed(1) + ' MB exceeds 50MB limit)');
        continue;
      }
      var dup = false;
      for (var d = 0; d < selectedFiles.length; d++) {
        var cur = selectedFiles[d].file;
        if (cur.name === f.name && cur.size === f.size && cur.lastModified === f.lastModified) {
          dup = true;
          break;
        }
      }
      if (dup) continue;

      var previewUrl = (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function')
        ? URL.createObjectURL(f)
        : '';
      selectedFiles.push({
        file: f,
        name: f.name,
        mime: inferMediaMime(f),
        previewUrl: previewUrl
      });
    }

    if (skipped.length > 0 && window.PBFDialog) {
      window.PBFDialog.alert('Skipped ' + skipped.length + ' file(s):\n• ' + skipped.join('\n• '));
    }

    updateSelectedFilesLabel();
    updateLivePreview();
  }

  function updateLivePreview() {
    var previewBox = document.getElementById('media-preview-box');
    var previewTarget = document.getElementById('media-preview-target');
    var tabModeLink = document.getElementById('tab-mode-link');
    var isLinkMode = tabModeLink && tabModeLink.classList.contains('active');
    var urlInput = /** @type {HTMLInputElement|null} */ (document.getElementById('media-url-input'));

    if (!previewBox || !previewTarget) return;

    if (isLinkMode) {
      var url = urlInput ? urlInput.value.trim() : '';
      if (!url) {
        previewBox.style.display = 'none';
        previewTarget.innerHTML = '';
        return;
      }

      var ytId = API.getYouTubeId ? API.getYouTubeId(url) : null;
      var gDriveId = API.getGoogleDriveId ? API.getGoogleDriveId(url) : null;
      var isDirectVideo = /\.(mp4|webm)($|[?#])/i.test(url);

      if (ytId) {
        previewBox.style.display = 'block';
        previewTarget.innerHTML = `
          <div style="max-width: 400px; border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border);">
            <img src="https://img.youtube.com/vi/${API.escapeHtml(ytId)}/hqdefault.jpg" alt="YouTube Preview" style="width: 100%; display: block;">
            <div style="padding: 8px 12px; background: var(--bg-subtle); font-size: 0.85rem; color: var(--secondary); font-weight: 600;">
              ✓ YouTube Video Recognized (ID: ${API.escapeHtml(ytId)}) — will stream in video carousel without file size limits (1GB+ supported)!
            </div>
          </div>
        `;
      } else if (gDriveId) {
        previewBox.style.display = 'block';
        previewTarget.innerHTML = `
          <div style="max-width: 400px; border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border); padding: 16px; background: var(--bg-subtle); text-align: center;">
            <div style="font-size: 2rem; margin-bottom: 6px;">🎬</div>
            <div style="font-weight: 700; color: var(--secondary); font-size: 0.95rem; margin-bottom: 4px;">
              ✓ Google Drive Video Recognized
            </div>
            <div style="font-size: 0.82rem; color: var(--text-muted);">
              File ID: ${API.escapeHtml(gDriveId)} — will stream directly in the video carousel without size limits (1GB+ full games supported)!
            </div>
          </div>
        `;
      } else if (isDirectVideo) {
        var safeVidPreviewUrl = API.safeUrl ? (API.safeUrl(url) || '') : url;
        previewBox.style.display = 'block';
        previewTarget.innerHTML = `
          <div style="max-width: 400px; border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border);">
            <video src="${API.escapeHtml(safeVidPreviewUrl)}" controls style="width: 100%; max-height: 220px; display: block;"></video>
            <div style="padding: 8px 12px; background: var(--bg-subtle); font-size: 0.85rem; color: var(--secondary); font-weight: 600;">
              ✓ Direct Video Stream Link (.mp4 / .webm) — will stream directly in video carousel!
            </div>
          </div>
        `;
      } else {
        var safeImgPreviewUrl = API.safeUrl ? (API.safeUrl(url) || '') : url;
        previewBox.style.display = 'block';
        previewTarget.innerHTML = `
          <div style="max-width: 400px; border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border);">
            <img src="${API.escapeHtml(safeImgPreviewUrl)}" alt="Remote Image" style="max-width: 100%; max-height: 250px; display: block;" data-fallback="/logo.svg">
            <div style="padding: 8px 12px; background: var(--bg-subtle); font-size: 0.85rem; color: var(--secondary); font-weight: 600;">
              ✓ External Image / Facebook CDN — will be copied and permanently saved in PBF vault!
            </div>
          </div>
        `;
      }
    } else {
      if (selectedFiles.length > 0) {
        previewBox.style.display = 'block';
        var cardsHtml = '<div style="display:flex;flex-wrap:wrap;gap:10px;">';
        for (var i = 0; i < selectedFiles.length; i++) {
          var item = selectedFiles[i];
          var isVideo = item.mime && item.mime.indexOf('video/') === 0;
          var safeSrc = item.previewUrl ? API.escapeHtml(item.previewUrl) : '';
          var mediaHtml;
          if (safeSrc) {
            mediaHtml = isVideo
              ? '<video src="' + safeSrc + '" controls style="width:100%;height:96px;object-fit:cover;border-radius:4px;display:block;"></video>'
              : '<img src="' + safeSrc + '" alt="' + API.escapeHtml(item.name) + '" style="width:100%;height:96px;object-fit:cover;border-radius:4px;display:block;">';
          } else {
            mediaHtml = '<div style="height:96px;display:flex;align-items:center;justify-content:center;font-size:1.6rem;">' + (isVideo ? '🎬' : '🖼️') + '</div>';
          }
          cardsHtml += '<div style="width:124px;border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px;background:var(--bg-subtle);display:flex;flex-direction:column;gap:4px;">' +
            mediaHtml +
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:4px;">' +
              '<span style="font-size:0.74rem;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + API.escapeHtml(item.name) + '">' + API.escapeHtml(item.name) + '</span>' +
              '<button type="button" class="btn btn-outline btn-xs btn-remove-selected-file" data-remove-idx="' + i + '" aria-label="Remove ' + API.escapeHtml(item.name) + '" style="padding:1px 6px;line-height:1.2;">✕</button>' +
            '</div>' +
          '</div>';
        }
        cardsHtml += '</div>';
        previewTarget.innerHTML = cardsHtml;

        if (!/** @type {any} */ (previewTarget)._removeDelegationBound) {
          /** @type {any} */ (previewTarget)._removeDelegationBound = true;
          previewTarget.addEventListener('click', function(ev) {
            var btn = ev.target && /** @type {Element} */ (ev.target).closest ? /** @type {Element} */ (ev.target).closest('.btn-remove-selected-file') : null;
            if (!btn) return;
            var idx = Number(btn.getAttribute('data-remove-idx'));
            if (!isNaN(idx) && idx >= 0 && idx < selectedFiles.length) {
              var removed = selectedFiles.splice(idx, 1)[0];
              if (removed && removed.previewUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
                try { URL.revokeObjectURL(removed.previewUrl); } catch (e) { /* ignore */ }
              }
              updateSelectedFilesLabel();
              updateLivePreview();
            }
          });
        }
      } else {
        previewBox.style.display = 'none';
        previewTarget.innerHTML = '';
      }
    }
  }

  async function uploadSingleFile(entry, payload, submitBtn, index, total) {
    if (submitBtn) {
      submitBtn.textContent = total > 1
        ? ('Uploading ' + (index + 1) + ' of ' + total + '…')
        : 'Uploading Media…';
    }
    var rawBuf = await entry.file.arrayBuffer();
    var uploadBuf = rawBuf;
    var mimeToUpload = entry.mime || entry.file.type || 'image/jpeg';

    if (mimeToUpload === 'image/jpeg' || mimeToUpload === 'image/jpg') {
      uploadBuf = stripJpegMetadataClient(rawBuf);
    }

    var initPayload = {
      file_name: entry.name || entry.file.name,
      mime_type: mimeToUpload,
      file_size: uploadBuf.byteLength,
      date_taken: payload.date_taken,
      album: payload.album,
      title: payload.title,
      caption: payload.caption,
      contributor_name: payload.contributor_name
    };
    if (payload.publish_immediately === false) {
      initPayload.publish_immediately = false;
    }

    var initRes = await API.request('POST', '/api/media/init', initPayload, {
      throwOnError: true,
      errorMsg: 'Failed to initialize media upload.'
    });

    var mediaId = initRes.mediaId || initRes.media_id;
    var uploadToken = initRes.uploadToken || initRes.upload_token;
    var uploadUrl = initRes.uploadUrl || initRes.upload_url;
    var storageProvider = initRes.storageProvider || initRes.storage_provider || 'local';

    var isGdriveUploadUrl = false;
    if (storageProvider === 'gdrive' && uploadUrl) {
      try {
        var uHost = new URL(uploadUrl).hostname.toLowerCase();
        isGdriveUploadUrl = (uHost === 'googleapis.com' || uHost.endsWith('.googleapis.com'));
      } catch (e) { isGdriveUploadUrl = false; }
    }

    if (isGdriveUploadUrl) {
      if (submitBtn && total === 1) submitBtn.textContent = 'Uploading to Drive…';
      var gdriveMeta = await uploadChunksToGDrive(uploadUrl, uploadBuf, mimeToUpload);
      var resolvedDriveId = (gdriveMeta && gdriveMeta.id) ? gdriveMeta.id : initRes.driveFileId;
      return await API.request('POST', '/api/media/' + encodeURIComponent(mediaId) + '/complete', {
        upload_token: uploadToken,
        drive_file_id: resolvedDriveId
      }, { throwOnError: true, errorMsg: 'Failed to complete Google Drive upload.' });
    }

    if (storageProvider === 'r2' && uploadUrl) {
      if (submitBtn && total === 1) submitBtn.textContent = 'Uploading to R2…';
      var r2PutRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': mimeToUpload,
          'Content-Length': String(uploadBuf.byteLength)
        },
        body: uploadBuf
      });
      if (!r2PutRes.ok) {
        throw new Error('Direct R2 upload failed with HTTP ' + r2PutRes.status);
      }
      return await API.request('POST', '/api/media/' + encodeURIComponent(mediaId) + '/complete', {
        upload_token: uploadToken
      }, { throwOnError: true, errorMsg: 'Failed to complete R2 upload.' });
    }

    if (submitBtn && total === 1) submitBtn.textContent = 'Uploading media…';
    var localPutRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeToUpload,
        'X-Upload-Token': uploadToken
      },
      body: uploadBuf
    });
    if (!localPutRes.ok) {
      var errData = await localPutRes.json().catch(function() { return {}; });
      throw new Error(errData.error || ('Local direct upload failed with HTTP ' + localPutRes.status));
    }
    return await API.request('POST', '/api/media/' + encodeURIComponent(mediaId) + '/complete', {
      upload_token: uploadToken
    }, { throwOnError: true, errorMsg: 'Failed to complete local upload.' });
  }

  async function handleFormSubmit(e) {
    e.preventDefault();
    var alertBox = document.getElementById('media-submit-alert');
    var submitBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('media-submit-btn'));
    var tabModeLink = document.getElementById('tab-mode-link');
    var isLinkMode = tabModeLink && tabModeLink.classList.contains('active');
    var urlInput = /** @type {HTMLInputElement|null} */ (document.getElementById('media-url-input'));
    var dateInput = /** @type {HTMLInputElement|null} */ (document.getElementById('media-date-input'));
    var albumSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('media-album-select'));
    var newAlbumInput = /** @type {HTMLInputElement|null} */ (document.getElementById('media-new-album-input'));
    var titleInput = /** @type {HTMLInputElement|null} */ (document.getElementById('media-title-input'));
    var captionInput = /** @type {HTMLInputElement|null} */ (document.getElementById('media-caption-input'));
    var contributorInput = /** @type {HTMLInputElement|null} */ (document.getElementById('media-contributor-input'));

    if (alertBox) alertBox.innerHTML = '';

    var dateTaken = dateInput ? dateInput.value.trim() : '';
    if (!dateTaken) {
      if (alertBox) alertBox.innerHTML = '<div class="alert alert-error">Please provide the approximate date the photo or video was taken.</div>';
      return;
    }

    var chosenAlbum = 'General Community Moments';
    if (albumSelect) {
      if (albumSelect.value === '__NEW__') {
        chosenAlbum = (newAlbumInput && newAlbumInput.value.trim()) ? newAlbumInput.value.trim() : 'New Album';
      } else {
        chosenAlbum = albumSelect.value;
      }
    }

    /** @type {Record<string, any>} */
    var payload = {
      date_taken: dateTaken,
      album: chosenAlbum,
      title: titleInput ? titleInput.value.trim() : '',
      caption: captionInput ? captionInput.value.trim() : '',
      contributor_name: contributorInput ? contributorInput.value.trim() : ''
    };

    var publishCheckbox = /** @type {HTMLInputElement|null} */ (document.getElementById('media-publish-immediately'));
    if (isManagerUser() && publishCheckbox && !publishCheckbox.checked) {
      payload.publish_immediately = false;
    }

    if (isLinkMode) {
      var url = urlInput ? urlInput.value.trim() : '';
      if (!url) {
        if (alertBox) alertBox.innerHTML = '<div class="alert alert-error">Please enter a valid YouTube or external image URL.</div>';
        return;
      }
      payload.url = url;
    } else if (selectedFiles.length === 0) {
      if (alertBox) alertBox.innerHTML = '<div class="alert alert-error">Please select at least one photo or video file from your camera roll or desktop.</div>';
      return;
    }

    try {
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = isLinkMode ? 'Copying & Saving Media…' : 'Uploading Media…';
      }

      if (isLinkMode) {
        var res = await API.submitMedia(payload);
        if (res && res.item) {
          saveMySubmission({
            id: res.item.id,
            title: res.item.title || payload.title || 'Submission #' + res.item.id,
            token: res.delete_token,
            date_taken: res.item.date_taken || payload.date_taken,
            media_type: res.item.media_type || 'youtube',
            file_url: res.item.file_url,
            is_approved: res.is_approved
          });
        }
        if (alertBox) {
          var alertClass = res.requires_approval ? 'alert-info' : 'alert-success';
          var takedownHtml = (res && res.item) ? (
            '<div style="margin-top: 8px;">' +
              '<button type="button" class="btn btn-outline btn-xs btn-immediate-takedown" data-id="' + res.item.id + '" data-type="' + (res.item.media_type || 'photo') + '" style="color: var(--danger); border-color: #fca5a5; font-size: 0.78rem; padding: 4px 10px;">' +
                '🗑️ Take down this submission' +
              '</button>' +
            '</div>'
          ) : '';
          var defaultMsg = (res.requires_approval || res.is_approved === 0)
            ? '✓ Media saved as hidden from the public timeline.'
            : '✓ Media uploaded and published live to gallery!';
          alertBox.innerHTML = '<div class="alert ' + alertClass + '" style="font-weight: 600;">' +
            API.escapeHtml(res.message || defaultMsg) + takedownHtml + '</div>';
          var immediateBtn = alertBox.querySelector('.btn-immediate-takedown');
          if (immediateBtn) {
            immediateBtn.addEventListener('click', function() {
              handleDeleteMedia(immediateBtn.getAttribute('data-id'), immediateBtn.getAttribute('data-type'));
            });
          }
        }
        if (urlInput) urlInput.value = '';
        if (titleInput) titleInput.value = '';
        if (captionInput) captionInput.value = '';
        if (newAlbumInput) newAlbumInput.value = '';
        updateLivePreview();
        await loadGalleryData();
        if (!res.requires_approval) {
          var targetSlug = slugify(chosenAlbum);
          setTimeout(function() { jumpToAlbum(targetSlug); }, 350);
        }
        return;
      }

      var batch = selectedFiles.slice();
      var succeeded = [];
      var failed = [];
      for (var i = 0; i < batch.length; i++) {
        try {
          var itemRes = await uploadSingleFile(batch[i], payload, submitBtn, i, batch.length);
          succeeded.push(itemRes);
          if (itemRes && itemRes.item) {
            saveMySubmission({
              id: itemRes.item.id,
              title: itemRes.item.title || payload.title || batch[i].name || ('Submission #' + itemRes.item.id),
              token: itemRes.delete_token,
              date_taken: itemRes.item.date_taken || payload.date_taken,
              media_type: itemRes.item.media_type || 'photo',
              file_url: itemRes.item.file_url,
              is_approved: itemRes.is_approved
            });
          }
        } catch (fileErr) {
          failed.push({ entry: batch[i], error: (fileErr && fileErr.message) ? fileErr.message : 'Upload failed' });
        }
      }

      if (failed.length === 0) {
        var firstRes = succeeded[0];
        if (alertBox) {
          if (succeeded.length === 1 && firstRes) {
            var oneClass = firstRes.requires_approval ? 'alert-info' : 'alert-success';
            var oneTakedown = (firstRes.item) ? (
              '<div style="margin-top: 8px;">' +
                '<button type="button" class="btn btn-outline btn-xs btn-immediate-takedown" data-id="' + firstRes.item.id + '" data-type="' + (firstRes.item.media_type || 'photo') + '" style="color: var(--danger); border-color: #fca5a5; font-size: 0.78rem; padding: 4px 10px;">' +
                  '🗑️ Take down this submission' +
                '</button>' +
              '</div>'
            ) : '';
            var oneMsg = (firstRes.requires_approval || firstRes.is_approved === 0)
              ? '✓ Media saved as hidden from the public timeline.'
              : '✓ Media uploaded and published live to gallery!';
            alertBox.innerHTML = '<div class="alert ' + oneClass + '" style="font-weight: 600;">' +
              API.escapeHtml(firstRes.message || oneMsg) + oneTakedown + '</div>';
            var oneBtn = alertBox.querySelector('.btn-immediate-takedown');
            if (oneBtn) {
              oneBtn.addEventListener('click', function() {
                handleDeleteMedia(oneBtn.getAttribute('data-id'), oneBtn.getAttribute('data-type'));
              });
            }
          } else {
            alertBox.innerHTML = '<div class="alert alert-success" style="font-weight: 600;">✓ Uploaded ' + succeeded.length + ' of ' + batch.length + ' files and published live to gallery!</div>';
          }
        }
        clearSelectedFiles();
        if (titleInput) titleInput.value = '';
        if (captionInput) captionInput.value = '';
        if (newAlbumInput) newAlbumInput.value = '';
        updateLivePreview();
        await loadGalleryData();
        if (firstRes && !firstRes.requires_approval) {
          var albumSlug = slugify(chosenAlbum);
          setTimeout(function() { jumpToAlbum(albumSlug); }, 350);
        }
      } else {
        var failedEntries = [];
        var errNames = [];
        for (var fIdx = 0; fIdx < failed.length; fIdx++) {
          failedEntries.push(failed[fIdx].entry);
          errNames.push(failed[fIdx].entry.name + ' (' + failed[fIdx].error + ')');
        }
        selectedFiles = failedEntries;
        updateSelectedFilesLabel();
        updateLivePreview();
        if (succeeded.length > 0) {
          await loadGalleryData();
        }
        if (alertBox) {
          alertBox.innerHTML = '<div class="alert alert-error">Uploaded ' + succeeded.length + ' of ' + batch.length + ' files. Failed (' + failed.length + '): ' + API.escapeHtml(errNames.join(', ')) + '</div>';
        }
      }

    } catch (err) {
      if (alertBox) {
        alertBox.innerHTML = '<div class="alert alert-error">' + API.escapeHtml(err.message || 'Failed to submit media.') + '</div>';
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = '🚀 Submit to Community Gallery';
      }
    }
  }

  function populateAlbumSelectOptions() {
    var select = /** @type {HTMLSelectElement|null} */ (document.getElementById('media-album-select'));
    if (!select) return;

    var curVal = select.value;
    var html = '<option value="General Community Moments">General Community Moments</option>';

    if (galleryAlbums && galleryAlbums.length > 0) {
      for (var i = 0; i < galleryAlbums.length; i++) {
        var a = galleryAlbums[i].album;
        if (a && a !== 'General Community Moments') {
          html += '<option value="' + API.escapeHtml(a) + '">' + API.escapeHtml(a) + '</option>';
        }
      }
    }

    html += '<option value="__NEW__">➕ Create New Album...</option>';
    select.innerHTML = html;
    if (curVal) select.value = curVal;
  }

  // ---------------------------------------------------------------------------
  // 9. Toolbar Controls (Chronological Sort)
  // ---------------------------------------------------------------------------
  function setupToolbarListeners() {
    var sortSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('gallery-sort-select'));

    if (sortSelect) {
      sortSelect.addEventListener('change', async function() {
        currentSortOrder = sortSelect.value || 'desc';
        await loadGalleryData();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 10. Media Deletion & Uploader Takedown
  // ---------------------------------------------------------------------------
  async function handleDeleteMedia(id, mediaType) {
    if (!id) return;
    var typeLabel = mediaType === 'video' ? 'video' : 'photo';
    var isManager = isManagerUser();
    var confirmMsg = isManager
      ? 'Are you sure you want to permanently remove this ' + typeLabel + ' from the display carousel?'
      : 'Are you sure you want to take down your submitted ' + typeLabel + '? It will be permanently removed from the website.';

    var ok = window.PBFDialog
      ? await window.PBFDialog.confirm(confirmMsg, { danger: true })
      : false;
    if (!ok) return;

    var token = getMediaDeleteToken(id);

    try {
      await API.deleteMedia(id, token);
      removeMySubmission(id);
      if (typeof closeLightbox === 'function') {
        closeLightbox();
      }
      await loadGalleryData();
      renderUserSubmissionsTray();
      var alertBox = document.getElementById('media-submit-alert');
      if (alertBox) {
        alertBox.innerHTML = '<div class="alert alert-success" style="font-weight: 600;">✓ Submission taken down and permanently removed.</div>';
        setTimeout(function() { alertBox.innerHTML = ''; }, 4000);
      }
    } catch (err) {
      if (window.PBFDialog) window.PBFDialog.toast(err.message || 'Failed to remove ' + typeLabel + '.', { type: 'error' });
    }
  }

  // ---------------------------------------------------------------------------
  // 11. User Submissions & Takedown Manager Tray
  // ---------------------------------------------------------------------------
  function renderUserSubmissionsTray() {
    var container = document.getElementById('user-submissions-container');
    var list = document.getElementById('user-submissions-list');
    var countBadge = document.getElementById('user-submissions-count');
    if (!container || !list) return;

    var mySubs = getMySubmissions();

    // If logged in, also populate items matching currentUser.id
    if (currentUser && currentUser.id && galleryMedia && galleryMedia.length > 0) {
      galleryMedia.forEach(function(item) {
        if (item.contributor_id === currentUser.id && !mySubs[item.id]) {
          mySubs[item.id] = {
            id: item.id,
            title: item.title,
            caption: item.caption,
            date_taken: item.date_taken,
            media_type: item.media_type,
            file_url: item.file_url,
            is_approved: item.is_approved
          };
        }
      });
    }

    var myIds = Object.keys(mySubs);
    if (myIds.length === 0) {
      container.style.display = 'none';
      list.innerHTML = '';
      return;
    }

    container.style.display = 'block';
    if (countBadge) {
      countBadge.textContent = myIds.length + ' item' + (myIds.length === 1 ? '' : 's');
    }

    var items = myIds.map(function(id) {
      var local = mySubs[id];
      var live = (galleryMedia || []).find(function(m) { return String(m.id) === String(id); });
      return Object.assign({}, local, live || {});
    });

    list.innerHTML = items.map(function(item) {
      var isVideo = item.media_type === 'video' || item.media_type === 'youtube';
      var thumbUrl;
      if (item.media_type === 'youtube') {
        var ytId = API.getYouTubeId ? API.getYouTubeId(item.file_url || item.original_url) : null;
        thumbUrl = ytId ? 'https://img.youtube.com/vi/' + ytId + '/hqdefault.jpg' : '/logo.svg';
      } else {
        thumbUrl = API.safeUrl ? API.safeUrl(item.file_url) : item.file_url;
      }

      var statusBadge = item.is_approved === 1
        ? '<span class="badge badge-green" style="font-size: 0.7rem;">✓ Live in Carousel</span>'
        : '<span class="badge badge-orange" style="font-size: 0.7rem;">🙈 Hidden from Timeline</span>';

      var typeBadge = item.media_type === 'youtube'
        ? '<span class="badge badge-orange" style="font-size: 0.7rem;">▶️ YouTube</span>'
        : (item.media_type === 'video' ? '<span class="badge badge-blue" style="font-size: 0.7rem;">🎬 Video</span>' : '<span class="badge badge-green" style="font-size: 0.7rem;">📷 Photo</span>');

      var title = item.title ? API.escapeHtml(item.title) : (isVideo ? 'Game Video' : 'Game Photo');
      var dateTaken = item.date_taken ? API.escapeHtml(item.date_taken) : '';

      return `
        <div class="card" id="user-sub-${item.id}" style="padding: 10px; margin-bottom: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); display: flex; flex-direction: column; justify-content: space-between;">
          <div>
            <div style="position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: 4px; overflow: hidden; background: #0c1f1a; margin-bottom: 8px;">
              <img src="${API.escapeHtml(thumbUrl)}" alt="${title}" data-fallback="/logo.svg" style="width: 100%; height: 100%; object-fit: cover; display: block;" loading="lazy">
              <div style="position: absolute; top: 4px; left: 4px; display: flex; gap: 4px; flex-wrap: wrap;">
                ${typeBadge}
                ${statusBadge}
              </div>
            </div>
            <h4 style="font-size: 0.88rem; margin: 0 0 2px 0; color: var(--secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${title}">${title}</h4>
            <div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 6px;">📅 ${dateTaken || 'Recent'}</div>
          </div>
          <button type="button" class="btn btn-outline btn-xs btn-user-takedown" data-id="${item.id}" data-type="${item.media_type || 'photo'}" style="color: var(--danger); border-color: #fca5a5; font-weight: 700; width: 100%; margin-top: 6px; padding: 4px 8px;">
            🗑️ Take Down Submission
          </button>
        </div>
      `;
    }).join('');

    list.querySelectorAll('.btn-user-takedown').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        var id = btn.getAttribute('data-id');
        var type = btn.getAttribute('data-type');
        handleDeleteMedia(id, type);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', initGallery);
})();
