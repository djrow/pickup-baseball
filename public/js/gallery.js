/**
 * public/js/gallery.js
 * Community Photo & Video Gallery with Full-Width Chronological Carousels
 * Sunday Pickup Baseball Charity Platform
 *
 * Strict ES6 compatible (No optional chaining or nullish coalescing).
 */

(function() {
  'use strict';

  var currentSortOrder = 'asc';
  var galleryMedia = [];
  var galleryAlbums = [];
  var currentLightboxIndex = -1;
  var currentPhotoItems = [];
  var currentUser = null;
  var selectedFileBase64 = null;
  var selectedFileMime = null;

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
    } catch (e) {}
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

    await loadGalleryData();

    // Check if URL contains an album anchor
    if (window.location.hash && window.location.hash.startsWith('#album-')) {
      var targetSlug = window.location.hash.replace('#album-', '');
      setTimeout(function() {
        jumpToAlbum(targetSlug);
      }, 400);
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

      if (typeof window !== 'undefined' && window.ArtStudio && typeof window.ArtStudio.setUser === 'function') {
        window.ArtStudio.setUser(currentUser);
      }
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
    if (countBadge) countBadge.textContent = pendingList.length + ' Pending Approval';

    var html = pendingList.map(function(item) {
      var dateLabel = formatDisplayDate(item.date_taken);
      var contributor = item.contributor_name ? API.escapeHtml(item.contributor_name) : 'Community User';
      var title = item.title ? API.escapeHtml(item.title) : (item.media_type === 'youtube' ? 'YouTube Video' : 'Photo Submission');
      var album = item.album ? API.escapeHtml(item.album) : 'General';
      var thumbHtml = '';

      if (item.media_type === 'youtube') {
        var ytId = API.getYouTubeId ? API.getYouTubeId(item.file_url || item.original_url) : null;
        if (!ytId) {
          var m = String(item.file_url || item.original_url || '').match(/([\w-]{11})/);
          ytId = m ? m[1] : '';
        }
        var thumbUrl = ytId ? 'https://img.youtube.com/vi/' + ytId + '/hqdefault.jpg' : '/logo.svg';
        thumbHtml = '<img src="' + API.escapeHtml(thumbUrl) + '" alt="' + title + '" class="pending-media-thumb">';
      } else {
        var safeImgUrl = API.safeUrl ? API.safeUrl(item.file_url) : item.file_url;
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

    listContainer.querySelectorAll('.btn-approve-media').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        var id = btn.getAttribute('data-media-id');
        btn.disabled = true;
        btn.textContent = 'Approving...';
        try {
          await API.approveMedia(id);
          await loadGalleryData();
        } catch (e) {
          alert(e.message || 'Failed to approve media.');
          btn.disabled = false;
          btn.textContent = '✓ Approve';
        }
      });
    });

    listContainer.querySelectorAll('.btn-reject-media').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        var id = btn.getAttribute('data-media-id');
        if (!confirm('Reject and permanently delete this pending submission?')) return;
        btn.disabled = true;
        btn.textContent = 'Rejecting...';
        try {
          await API.deleteMedia(id);
          await loadGalleryData();
        } catch (e) {
          alert(e.message || 'Failed to reject media.');
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

    // Find the first photo card belonging to this album
    var targetCard = photoTrack.querySelector('.photo-card[data-album-slug="' + slug + '"]');
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

    var html = photos.map(function(pt, idx) {
      var ptDate = formatDisplayDate(pt.date_taken);
      var ptContributor = pt.contributor_name ? API.escapeHtml(pt.contributor_name) : 'Community';
      var ptTitle = pt.title ? API.escapeHtml(pt.title) : '';
      var ptAlbum = pt.album || 'General';
      var ptAlbumSlug = slugify(ptAlbum);
      var safeImgUrl = API.safeUrl ? API.safeUrl(pt.file_url) : pt.file_url;

      var deleteBtn = isManager ? `
        <button type="button" class="btn-delete-photo" data-media-id="${pt.id}" title="Remove Photo from Carousel" aria-label="Remove Photo from Carousel">🗑️</button>
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
        if (e.target.closest && e.target.closest('.btn-delete-photo')) return;
        if (e.target.classList.contains('btn-delete-photo')) return;
        var idx = parseInt(card.getAttribute('data-global-index'), 10);
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
    container.addEventListener('scroll', function() {
      updateCarouselEdgeHints(container, 'photos-paddle-prev', 'photos-paddle-next', 'photos-edge-left', 'photos-edge-right');
      syncPhotoScrollWithBookmarks();
    }, { passive: true });
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
        var card = cards[i];
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

    var html = videos.map(function(vid) {
      var dateLabel = formatDisplayDate(vid.date_taken);
      var contributor = vid.contributor_name ? API.escapeHtml(vid.contributor_name) : 'Community';
      var title = vid.title ? API.escapeHtml(vid.title) : 'Game Highlights';
      var caption = vid.caption ? API.escapeHtml(vid.caption) : '';
      var albumTag = vid.album ? API.escapeHtml(vid.album) : 'General';

      var playerHtml = '';
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
            ${isManager ? `<button type="button" class="btn-delete-video" data-media-id="${vid.id}" title="Remove Video from Carousel" aria-label="Remove Video from Carousel">🗑️</button>` : ''}
          </div>
        `;
      } else {
        var safeVidUrl = API.safeUrl ? API.safeUrl(vid.file_url) : vid.file_url;
        playerHtml = `
          <div class="video-native-container" style="position: relative;">
            <video src="${API.escapeHtml(safeVidUrl)}" controls playsinline preload="metadata" class="video-native-player"></video>
            ${isManager ? `<button type="button" class="btn-delete-video" data-media-id="${vid.id}" title="Remove Video from Carousel" aria-label="Remove Video from Carousel">🗑️</button>` : ''}
          </div>
        `;
      }

      var adminDeleteBtn = isManager ? `
        <button type="button" class="btn btn-outline btn-xs btn-delete-media" data-media-id="${vid.id}" title="Remove Video from Carousel" style="color: var(--danger); border-color: #fca5a5; font-size: 0.72rem; padding: 2px 8px; margin-left: auto; cursor: pointer;">
          🗑️ Remove
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
        if (e.target.closest && (e.target.closest('.btn-delete-video') || e.target.closest('.btn-delete-media'))) return;
        if (e.target.classList.contains('btn-delete-video') || e.target.classList.contains('btn-delete-media')) return;
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
    container.addEventListener('scroll', function() {
      updateCarouselEdgeHints(container, 'videos-paddle-prev', 'videos-paddle-next', 'videos-edge-left', 'videos-edge-right');
    }, { passive: true });
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

    var img = document.getElementById('lightbox-img');
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
      var c = photo.contributor_name ? photo.contributor_name : 'Community Member';
      var a = photo.album ? photo.album : 'General';
      meta.textContent = '📅 ' + d + ' • 📷 By ' + c + ' • 📌 ' + a + ' (' + (currentLightboxIndex + 1) + '/' + currentPhotoItems.length + ')';
    }

    var deleteBtn = document.getElementById('lightbox-delete-btn');
    if (deleteBtn) {
      deleteBtn.style.display = isManagerUser() ? 'inline-flex' : 'none';
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
    var fileInput = document.getElementById('media-file-input');
    var browseBtn = document.getElementById('btn-browse-files');
    var dropzone = document.getElementById('media-dropzone');
    var dateInput = document.getElementById('media-date-input');
    var albumSelect = document.getElementById('media-album-select');
    var newAlbumWrap = document.getElementById('new-album-wrap');
    var urlInput = document.getElementById('media-url-input');

    // Default date input to most recent Sunday
    if (dateInput) {
      dateInput.value = getSundayOffsetDate(0);
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
          handleFileChosen(e.dataTransfer.files[0]);
        }
      });
      fileInput.addEventListener('change', function() {
        if (fileInput.files && fileInput.files.length > 0) {
          handleFileChosen(fileInput.files[0]);
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

  function compressImageIfLarge(file, callback) {
    if (!file || !file.type || !file.type.startsWith('image/') || file.size < 1.5 * 1024 * 1024) {
      var reader = new FileReader();
      reader.onload = function(e) {
        callback(e.target.result, file.type || 'image/jpeg');
      };
      reader.readAsDataURL(file);
      return;
    }

    var img = new Image();
    var reader = new FileReader();
    reader.onload = function(e) {
      img.onload = function() {
        var canvas = document.createElement('canvas');
        var maxDim = 2048;
        var width = img.width;
        var height = img.height;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            maxDim = height;
          }
        }
        canvas.width = width;
        canvas.height = height;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        var compressedB64 = canvas.toDataURL('image/jpeg', 0.85);
        callback(compressedB64, 'image/jpeg');
      };
      img.onerror = function() {
        callback(e.target.result, file.type || 'image/jpeg');
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function handleFileChosen(file) {
    var fileNameLabel = document.getElementById('dropzone-file-name');
    if (!file) return;

    if (file.size > 15 * 1024 * 1024) {
      alert('Selected file is too large (' + (file.size / 1024 / 1024).toFixed(1) + 'MB). Please choose a file under 15MB.');
      return;
    }

    if (fileNameLabel) {
      fileNameLabel.textContent = '✓ Selected: ' + file.name + ' (' + (file.size / 1024).toFixed(0) + ' KB)';
    }

    compressImageIfLarge(file, function(b64, mime) {
      selectedFileBase64 = b64;
      selectedFileMime = mime;
      updateLivePreview();
    });
  }

  function updateLivePreview() {
    var previewBox = document.getElementById('media-preview-box');
    var previewTarget = document.getElementById('media-preview-target');
    var isLinkMode = document.getElementById('tab-mode-link') && document.getElementById('tab-mode-link').classList.contains('active');
    var urlInput = document.getElementById('media-url-input');

    if (!previewBox || !previewTarget) return;

    if (isLinkMode) {
      var url = urlInput ? urlInput.value.trim() : '';
      if (!url) {
        previewBox.style.display = 'none';
        previewTarget.innerHTML = '';
        return;
      }

      var ytId = API.getYouTubeId ? API.getYouTubeId(url) : null;
      if (ytId) {
        previewBox.style.display = 'block';
        previewTarget.innerHTML = `
          <div style="max-width: 400px; border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border);">
            <img src="https://img.youtube.com/vi/${API.escapeHtml(ytId)}/hqdefault.jpg" alt="YouTube Preview" style="width: 100%; display: block;">
            <div style="padding: 8px 12px; background: var(--bg-subtle); font-size: 0.85rem; color: var(--secondary); font-weight: 600;">
              ✓ YouTube Video Recognized (ID: ${API.escapeHtml(ytId)}) — will stream in video carousel!
            </div>
          </div>
        `;
      } else {
        previewBox.style.display = 'block';
        previewTarget.innerHTML = `
          <div style="max-width: 400px; border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border);">
            <img src="${API.escapeHtml(url)}" alt="Remote Image" style="max-width: 100%; max-height: 250px; display: block;" onerror="this.onerror=null; this.src='/logo.svg';">
            <div style="padding: 8px 12px; background: var(--bg-subtle); font-size: 0.85rem; color: var(--secondary); font-weight: 600;">
              ✓ External Image / Facebook CDN — will be copied and permanently saved in PBF vault!
            </div>
          </div>
        `;
      }
    } else {
      if (selectedFileBase64) {
        previewBox.style.display = 'block';
        var isVideo = selectedFileMime && selectedFileMime.startsWith('video/');
        if (isVideo) {
          previewTarget.innerHTML = `
            <video src="${selectedFileBase64}" controls style="max-width: 100%; max-height: 250px; border-radius: var(--radius-sm);"></video>
          `;
        } else {
          previewTarget.innerHTML = `
            <img src="${selectedFileBase64}" alt="Upload Preview" style="max-width: 100%; max-height: 250px; border-radius: var(--radius-sm); border: 1px solid var(--border);">
          `;
        }
      } else {
        previewBox.style.display = 'none';
        previewTarget.innerHTML = '';
      }
    }
  }

  async function handleFormSubmit(e) {
    e.preventDefault();
    var alertBox = document.getElementById('media-submit-alert');
    var submitBtn = document.getElementById('media-submit-btn');
    var isLinkMode = document.getElementById('tab-mode-link') && document.getElementById('tab-mode-link').classList.contains('active');
    var urlInput = document.getElementById('media-url-input');
    var dateInput = document.getElementById('media-date-input');
    var albumSelect = document.getElementById('media-album-select');
    var newAlbumInput = document.getElementById('media-new-album-input');
    var titleInput = document.getElementById('media-title-input');
    var captionInput = document.getElementById('media-caption-input');
    var contributorInput = document.getElementById('media-contributor-input');

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

    var payload = {
      date_taken: dateTaken,
      album: chosenAlbum,
      title: titleInput ? titleInput.value.trim() : '',
      caption: captionInput ? captionInput.value.trim() : '',
      contributor_name: contributorInput ? contributorInput.value.trim() : ''
    };

    if (isLinkMode) {
      var url = urlInput ? urlInput.value.trim() : '';
      if (!url) {
        if (alertBox) alertBox.innerHTML = '<div class="alert alert-error">Please enter a valid YouTube or external image URL.</div>';
        return;
      }
      payload.url = url;
    } else {
      if (!selectedFileBase64) {
        if (alertBox) alertBox.innerHTML = '<div class="alert alert-error">Please select a photo or video file from your camera roll or desktop.</div>';
        return;
      }
      payload.file_data = selectedFileBase64;
      payload.mime_type = selectedFileMime;
    }

    try {
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = isLinkMode ? 'Copying & Saving Media…' : 'Uploading Media…';
      }

      var res = await API.submitMedia(payload);

      if (alertBox) {
        var alertClass = res.requires_approval ? 'alert-info' : 'alert-success';
        alertBox.innerHTML = `
          <div class="alert ${alertClass}" style="font-weight: 600;">
            ${API.escapeHtml(res.message || '✓ Media successfully saved!')}
          </div>
        `;
      }

      // Reset form
      selectedFileBase64 = null;
      selectedFileMime = null;
      var fileLabel = document.getElementById('dropzone-file-name');
      if (fileLabel) fileLabel.textContent = '';
      if (urlInput) urlInput.value = '';
      if (titleInput) titleInput.value = '';
      if (captionInput) captionInput.value = '';
      if (newAlbumInput) newAlbumInput.value = '';
      updateLivePreview();

      // Refresh gallery
      await loadGalleryData();

      // If published immediately, scroll to album
      if (!res.requires_approval) {
        var targetSlug = slugify(chosenAlbum);
        setTimeout(function() {
          jumpToAlbum(targetSlug);
        }, 350);
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
    var select = document.getElementById('media-album-select');
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
    var sortSelect = document.getElementById('gallery-sort-select');

    if (sortSelect) {
      sortSelect.addEventListener('change', async function() {
        currentSortOrder = sortSelect.value || 'desc';
        await loadGalleryData();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 10. Admin Media Deletion from Carousels
  // ---------------------------------------------------------------------------
  async function handleDeleteMedia(id, mediaType) {
    if (!id) return;
    var typeLabel = mediaType === 'video' ? 'video' : 'photo';
    if (!confirm('Are you sure you want to permanently remove this ' + typeLabel + ' from the display carousel?')) return;

    try {
      await API.deleteMedia(id);
      if (typeof closeLightbox === 'function') {
        closeLightbox();
      }
      await loadGalleryData();
    } catch (err) {
      alert(err.message || 'Failed to remove ' + typeLabel + ' from carousel.');
    }
  }

  document.addEventListener('DOMContentLoaded', initGallery);
})();
