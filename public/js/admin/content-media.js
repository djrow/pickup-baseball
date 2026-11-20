// @ts-check
/**
 * @fileoverview Admin Dashboard — Community Highlights Publishing/Deletion & Gallery Media Moderation Carousels (`admin/content-media.js`).
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * TABLE OF CONTENTS:
 * 1. Community Highlights & RSS Feed Publisher (`setupCommunityHighlightsAdmin`, `updateAdminPostEventDropdown`, `loadAdminPosts`)
 * 2. Gallery Photo & Video Moderation Carousels (`setupMediaCarouselsAdmin`)
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root) return;

  var API = root.API = root.API || /** @type {any} */ ({});
  /** @type {any} */
  var AdminUI = API._adminUi = API._adminUi || {};
  AdminUI.state = AdminUI.state || /** @type {any} */ ({});

  function el(id) {
    return typeof document !== 'undefined' ? /** @type {any} */ (document.getElementById(id)) : null;
  }

  // =============================================================================
  // Community Highlights & RSS Feed Administration
  // =============================================================================
  function setupCommunityHighlightsAdmin() {
    var form = /** @type {HTMLFormElement|null} */ (el('create-post-form'));
    var mediaUrlInput = /** @type {HTMLInputElement|null} */ (el('post-media-url-input'));
    var mediaTypeSelect = /** @type {HTMLSelectElement|null} */ (el('post-media-type-select'));
    var previewContainer = el('post-media-preview-container');
    var previewTarget = el('post-media-preview-target');
    var alertBox = el('post-form-alert');

    function updateLivePreview() {
      if (!previewContainer || !previewTarget || !mediaUrlInput || !mediaTypeSelect) return;
      var url = (mediaUrlInput.value || '').trim();
      var resolvedType = API.parseMediaType(url, mediaTypeSelect.value);
      if (!url || resolvedType === 'none') {
        previewContainer.style.display = 'none';
        previewTarget.innerHTML = '';
        return;
      }

      previewContainer.style.display = 'block';
      var safeLink = API.safeUrl(url);

      if (resolvedType === 'youtube') {
        var embedUrl = API.getYouTubeEmbedUrl(url);
        previewTarget.innerHTML = embedUrl
          ? '<div class="feed-post-media feed-media-youtube" style="max-width: 480px; border-radius: var(--radius-sm); overflow: hidden;"><iframe src="' + API.escapeHtml(embedUrl) + '" title="YouTube Preview" allowfullscreen></iframe></div><small style="color: var(--text-muted); display: block; margin-top: 6px;">✓ YouTube detected (ID: ' + API.escapeHtml(API.getYouTubeId(url) || '') + ')</small>'
          : '<span style="color: var(--danger);">⚠️ Could not parse YouTube video ID from URL.</span>';
      } else if (!safeLink) {
        previewTarget.innerHTML = '<span style="color: var(--danger);">⚠️ Invalid media URL.</span>';
      } else if (resolvedType === 'image') {
        previewTarget.innerHTML = '<div style="max-width: 360px;"><img src="' + API.escapeHtml(safeLink) + '" alt="Preview" style="max-width: 100%; border-radius: var(--radius-sm); border: 1px solid var(--border);"></div><small style="color: var(--text-muted); display: block; margin-top: 6px;">✓ Image link detected — will render photo card and RSS enclosure.</small>';
      } else if (resolvedType === 'video') {
        previewTarget.innerHTML = '<div style="max-width: 480px;"><video src="' + API.escapeHtml(safeLink) + '" controls playsinline style="max-width: 100%; border-radius: var(--radius-sm);"></video></div><small style="color: var(--text-muted); display: block; margin-top: 6px;">✓ Direct video stream link detected.</small>';
      } else if (resolvedType === 'audio') {
        previewTarget.innerHTML = '<div style="max-width: 480px;"><audio src="' + API.escapeHtml(safeLink) + '" controls style="width: 100%;"></audio></div><small style="color: var(--text-muted); display: block; margin-top: 6px;">✓ Direct audio podcast link detected.</small>';
      } else {
        previewTarget.innerHTML = '<div style="font-size: 0.9rem;">🔗 Web link: <a href="' + API.escapeHtml(safeLink) + '" target="_blank" rel="noopener noreferrer">' + API.escapeHtml(url) + '</a></div>';
      }
    }

    if (mediaUrlInput) {
      mediaUrlInput.addEventListener('input', updateLivePreview);
      mediaUrlInput.addEventListener('change', updateLivePreview);
    }
    if (mediaTypeSelect) mediaTypeSelect.addEventListener('change', updateLivePreview);

    if (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (alertBox) alertBox.innerHTML = '';

        var submitBtn = /** @type {HTMLButtonElement|null} */ (el('post-submit-btn'));
        var titleInput = /** @type {HTMLInputElement|null} */ (el('post-title-input'));
        var contentInput = /** @type {HTMLTextAreaElement|null} */ (el('post-content-input'));
        var summaryInput = /** @type {HTMLInputElement|null} */ (el('post-summary-input'));
        var eventSelect = /** @type {HTMLSelectElement|null} */ (el('post-event-id-select'));

        var title = (titleInput && titleInput.value) ? titleInput.value.trim() : '';
        var content = (contentInput && contentInput.value) ? contentInput.value.trim() : '';
        if (!title || !content) {
          if (alertBox) alertBox.innerHTML = '<div class="alert alert-error">Title and content are required.</div>';
          return;
        }

        try {
          if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Publishing…'; }
          await API.createPost({
            title: title,
            content: content,
            summary: (summaryInput && summaryInput.value) ? summaryInput.value.trim() : '',
            media_url: (mediaUrlInput && mediaUrlInput.value) ? mediaUrlInput.value.trim() : '',
            media_type: (mediaTypeSelect && mediaTypeSelect.value) ? mediaTypeSelect.value : 'auto',
            event_id: (eventSelect && eventSelect.value) ? eventSelect.value : null
          });

          if (alertBox) {
            alertBox.innerHTML = '<div class="alert alert-success">✓ Highlight published successfully! Added to <a href="/feed.xml" target="_blank" rel="noopener noreferrer" style="text-decoration: underline;">/feed.xml</a> and the community homepage.</div>';
          }
          form.reset();
          updateLivePreview();
          await loadAdminPosts();
        } catch (err) {
          if (alertBox) alertBox.innerHTML = '<div class="alert alert-error">' + API.escapeHtml((err && err.message) || 'Failed to publish highlight.') + '</div>';
        } finally {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '🚀 Publish Highlight to Community Feed & RSS'; }
        }
      });
    }

    loadAdminPosts();
  }

  function updateAdminPostEventDropdown(events) {
    var select = /** @type {HTMLSelectElement|null} */ (el('post-event-id-select'));
    if (!select) return;
    var currentVal = select.value;
    var html = '<option value="">-- No specific game --</option>';
    if (Array.isArray(events)) {
      events.forEach(function (ev) {
        var dateStr = ev.event_date ? API.formatDate(ev.event_date) : '';
        html += '<option value="' + API.escapeHtml(String(ev.id)) + '">Game #' + API.escapeHtml(String(ev.id)) + ': ' + API.escapeHtml(ev.title || 'Pickup Game') + (dateStr ? ' (' + API.escapeHtml(dateStr) + ')' : '') + '</option>';
      });
    }
    select.innerHTML = html;
    if (currentVal) select.value = currentVal;
  }

  async function loadAdminPosts() {
    var container = el('admin-posts-container');
    if (!container) return;

    try {
      var data = await API.getPosts();
      var posts = (data && data.posts) ? data.posts : [];

      if (posts.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 24px; color: var(--text-muted); background: var(--bg-subtle); border-radius: var(--radius-sm);">No highlights published yet. Use the form above to post the first game recap or photo!</div>';
        return;
      }

      /** @type {Record<string, string>} */
      var mediaBadgeMap = {
        youtube: '<span class="badge badge-orange">▶ YouTube Video</span>',
        image: '<span class="badge badge-green">📷 Photo / Image</span>',
        video: '<span class="badge badge-blue">🎬 Video Stream</span>',
        audio: '<span class="badge badge-blue">🎙️ Audio Clip</span>'
      };

      container.innerHTML = posts.map(function (post) {
        var dateLabel = post.created_at ? API.formatDate(post.created_at) : '';
        var mUrl = post.media_url ? String(post.media_url).trim() : '';
        var mType = post.media_type || API.parseMediaType(mUrl);
        var mediaBadge = mediaBadgeMap[mType] || (mUrl ? '<span class="badge">🔗 Link</span>' : '<span class="badge" style="background: var(--bg-subtle); color: var(--text-muted);">Text Only</span>');

        return (
          '<div class="card" style="margin-bottom: 12px; padding: 14px 18px; display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; flex-wrap: wrap;">' +
            '<div style="flex: 1; min-width: 240px;">' +
              '<div style="display: flex; gap: 8px; align-items: center; margin-bottom: 6px; flex-wrap: wrap;">' +
                mediaBadge +
                '<span style="font-size: 0.8rem; color: var(--text-muted);">' + API.escapeHtml(dateLabel) + '</span>' +
                (post.event_id ? '<span style="font-size: 0.8rem; color: var(--primary);">• ⚾ Game #' + API.escapeHtml(String(post.event_id)) + '</span>' : '') +
                (post.author_name ? '<span style="font-size: 0.8rem; color: var(--text-muted);">• By ' + API.escapeHtml(post.author_name) + '</span>' : '') +
              '</div>' +
              '<h4 style="margin: 0 0 6px 0; font-size: 1.05rem; color: var(--text-primary);">' + API.escapeHtml(post.title) + '</h4>' +
              '<p style="margin: 0; font-size: 0.88rem; color: var(--text-muted); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">' + API.escapeHtml(post.content) + '</p>' +
              (mUrl ? '<div style="margin-top: 6px; font-size: 0.8rem;"><a href="' + API.escapeHtml(API.safeUrl(mUrl)) + '" target="_blank" rel="noopener noreferrer" style="color: var(--primary); text-decoration: underline; word-break: break-all;">' + API.escapeHtml(mUrl) + ' ↗</a></div>' : '') +
            '</div>' +
            '<div>' +
              '<button type="button" class="btn btn-outline btn-sm admin-delete-post-btn" data-post-id="' + API.escapeHtml(String(post.id)) + '" style="color: var(--danger); border-color: #fca5a5;">🗑️ Delete</button>' +
            '</div>' +
          '</div>'
        );
      }).join('');

      container.querySelectorAll('.admin-delete-post-btn').forEach(function (btnEl) {
        var btn = /** @type {HTMLButtonElement} */ (btnEl);
        btn.addEventListener('click', async function (e) {
          e.preventDefault();
          var postId = btn.getAttribute('data-post-id');
          if (!postId) return;
          var ok = root.PBFDialog
            ? await root.PBFDialog.confirm('Are you sure you want to permanently delete this highlight from the community feed and RSS?', { danger: true })
            : false;
          if (!ok) return;
          try {
            btn.disabled = true;
            await API.deletePost(postId);
            await loadAdminPosts();
          } catch (err) {
            if (root.PBFDialog) root.PBFDialog.toast((err && err.message) || 'Failed to delete highlight.', { type: 'error' });
            btn.disabled = false;
          }
        });
      });
    } catch (err) {
      container.innerHTML = '<p style="color: var(--danger);">Failed to load highlights.</p>';
    }
  }

  // ---------------------------------------------------------------------------
  // Photo & Video Display Carousels Management
  // ---------------------------------------------------------------------------
  /** @type {any[]} */
  var allCarouselMedia = [];
  var activeMediaTypeFilter = 'all';
  var activeMediaStatusFilter = 'all';

  async function setupMediaCarouselsAdmin() {
    var container = el('admin-media-grid');
    var countBadge = el('admin-media-count-badge');
    var alertEl = el('admin-media-alert');
    var refreshBtn = el('admin-refresh-media-btn');
    var searchInput = /** @type {HTMLInputElement|null} */ (el('admin-media-search-input'));
    var filterBtns = typeof document !== 'undefined' ? document.querySelectorAll('.admin-media-filter-btn') : [];
    var statusBtns = typeof document !== 'undefined' ? document.querySelectorAll('.admin-media-status-btn') : [];

    if (!container) return;

    async function loadMediaItems() {
      container.innerHTML = '<p style="color: var(--text-muted); padding: 24px; text-align: center; grid-column: 1 / -1;">Loading carousel media...</p>';
      try {
        var data = await API.getMedia({ order: 'desc', status: 'all' });
        allCarouselMedia = (data && data.media) ? data.media : [];
        renderMediaItems();
      } catch (err) {
        container.innerHTML = '<div class="alert alert-error" style="grid-column: 1 / -1;">Failed to load carousel media: ' + API.escapeHtml((err && err.message) || 'Error') + '</div>';
      }
    }

    function renderMediaItems() {
      var query = (searchInput ? searchInput.value : '').toLowerCase().trim();
      var filtered = allCarouselMedia;

      if (activeMediaTypeFilter === 'photo') {
        filtered = filtered.filter(function (m) { return m.media_type === 'photo'; });
      } else if (activeMediaTypeFilter === 'video') {
        filtered = filtered.filter(function (m) { return m.media_type === 'video' || m.media_type === 'youtube'; });
      }

      if (activeMediaStatusFilter === 'live') {
        filtered = filtered.filter(function (m) { return m.is_approved === 1; });
      } else if (activeMediaStatusFilter === 'pending') {
        filtered = filtered.filter(function (m) { return m.is_approved === 0; });
      }

      if (query) {
        filtered = filtered.filter(function (m) {
          var title = (m.title || '').toLowerCase();
          var caption = (m.caption || '').toLowerCase();
          var album = (m.album || '').toLowerCase();
          var contributor = (m.contributor_name || '').toLowerCase();
          return title.indexOf(query) !== -1 || caption.indexOf(query) !== -1 || album.indexOf(query) !== -1 || contributor.indexOf(query) !== -1;
        });
      }

      if (countBadge) {
        countBadge.textContent = filtered.length + ' item' + (filtered.length === 1 ? '' : 's');
      }

      if (filtered.length === 0) {
        container.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; padding: 32px 16px; background: var(--bg-subtle); border-radius: var(--radius-sm); color: var(--text-muted);"><span style="font-size: 1.6rem;">🖼️</span><br>No matching media found in the carousels.</div>';
        return;
      }

      container.innerHTML = filtered.map(function (item) {
        var isVideo = item.media_type === 'video' || item.media_type === 'youtube';
        var thumbUrl;
        if (item.media_type === 'youtube') {
          var ytId = typeof API.getYouTubeId === 'function' ? API.getYouTubeId(item.file_url || item.original_url) : null;
          thumbUrl = ytId ? ('https://img.youtube.com/vi/' + ytId + '/hqdefault.jpg') : '/logo.svg';
        } else {
          thumbUrl = typeof API.safeUrl === 'function' ? API.safeUrl(item.file_url) : item.file_url;
        }

        var typeBadge = item.media_type === 'youtube'
          ? '<span class="badge badge-orange" style="font-size: 0.7rem;">▶️ YouTube</span>'
          : (item.media_type === 'video'
            ? '<span class="badge badge-blue" style="font-size: 0.7rem;">🎬 Video</span>'
            : '<span class="badge badge-green" style="font-size: 0.7rem;">📷 Photo</span>');

        var statusBadge = item.is_approved === 1
          ? '<span class="badge badge-green" style="font-size: 0.7rem;">✓ Live</span>'
          : '<span class="badge badge-orange" style="font-size: 0.7rem;">🙈 Hidden</span>';

        var dateLabel = item.date_taken ? API.escapeHtml(item.date_taken) : '';
        var album = item.album ? API.escapeHtml(item.album) : 'General';
        var contributor = item.contributor_name ? API.escapeHtml(item.contributor_name) : 'Community';
        var title = item.title ? API.escapeHtml(item.title) : (isVideo ? 'Game Video' : 'Game Photo');

        return (
          '<div class="card" id="admin-media-card-' + item.id + '" style="display: flex; flex-direction: column; justify-content: space-between; margin-bottom: 0; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-sm);">' +
            '<div>' +
              '<div style="position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: var(--radius-sm); overflow: hidden; background: #0c1f1a; margin-bottom: 10px;">' +
                '<img src="' + API.escapeHtml(thumbUrl) + '" alt="' + title + '" data-fallback="/logo.svg" style="width: 100%; height: 100%; object-fit: cover; display: block;" loading="lazy">' +
                '<div style="position: absolute; top: 6px; left: 6px; display: flex; gap: 4px; flex-wrap: wrap;">' +
                  typeBadge +
                  statusBadge +
                '</div>' +
                (dateLabel ? '<div style="position: absolute; bottom: 6px; left: 6px; background: rgba(0,0,0,0.7); color: #fff; font-size: 0.7rem; font-weight: 700; padding: 2px 6px; border-radius: 4px;">📅 ' + dateLabel + '</div>' : '') +
              '</div>' +
              '<h3 style="margin: 0 0 4px 0; font-size: 0.95rem; color: var(--secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="' + title + '">' + title + '</h3>' +
              '<div style="font-size: 0.78rem; color: var(--text-muted); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 6px;">' +
                '<span>📌 ' + album + '</span> &bull; <span>By ' + contributor + '</span>' +
              '</div>' +
              (item.caption ? '<p style="font-size: 0.78rem; color: var(--text-main); margin: 0 0 8px 0; line-height: 1.3; max-height: 2.6em; overflow: hidden; font-style: italic;">"' + API.escapeHtml(item.caption) + '"</p>' : '') +
            '</div>' +
            '<div style="margin-top: 10px;">' +
              '<div class="flex-row-wrap" style="gap: 6px;">' +
                '<button type="button" class="btn btn-outline btn-sm btn-admin-edit-media" data-id="' + item.id + '" style="flex: 1; font-weight: 700; font-size: 0.78rem; padding: 5px 8px;">✏️ Edit</button>' +
                (item.is_approved === 0
                  ? '<button type="button" class="btn btn-outline btn-sm btn-admin-publish-media" data-id="' + item.id + '" style="color: var(--secondary); border-color: var(--secondary); font-weight: 700; font-size: 0.78rem; padding: 5px 8px;">✓ Publish</button>'
                  : '<button type="button" class="btn btn-outline btn-sm btn-admin-hide-media" data-id="' + item.id + '" style="color: var(--text-muted); border-color: var(--border); font-weight: 700; font-size: 0.78rem; padding: 5px 8px;">🙈 Hide</button>') +
                '<button type="button" class="btn btn-outline btn-sm btn-admin-remove-media" data-id="' + item.id + '" data-type="' + item.media_type + '" style="color: var(--danger); border-color: #fca5a5; font-weight: 700; font-size: 0.78rem; padding: 5px 8px;">🗑️ Remove</button>' +
              '</div>' +
              '<!-- Inline Edit Form -->' +
              '<div id="edit-media-panel-' + item.id + '" style="display: none; margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border);">' +
                '<div id="edit-media-alert-' + item.id + '"></div>' +
                '<form class="admin-media-edit-form" data-id="' + item.id + '" style="display: flex; flex-direction: column; gap: 8px;">' +
                  '<div>' +
                    '<label for="edit-media-title-' + item.id + '" style="font-size: 0.74rem; font-weight: 700; color: var(--text-muted); display: block; margin-bottom: 2px;">Title</label>' +
                    '<input type="text" id="edit-media-title-' + item.id + '" value="' + API.escapeHtml(item.title || '') + '" style="width: 100%; padding: 5px 8px; font-size: 0.82rem;" class="form-input" required>' +
                  '</div>' +
                  '<div>' +
                    '<label for="edit-media-caption-' + item.id + '" style="font-size: 0.74rem; font-weight: 700; color: var(--text-muted); display: block; margin-bottom: 2px;">Caption / Story</label>' +
                    '<textarea id="edit-media-caption-' + item.id + '" rows="2" style="width: 100%; padding: 5px 8px; font-size: 0.82rem; resize: vertical;" class="form-input">' + API.escapeHtml(item.caption || '') + '</textarea>' +
                  '</div>' +
                  '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">' +
                    '<div>' +
                      '<label for="edit-media-album-' + item.id + '" style="font-size: 0.74rem; font-weight: 700; color: var(--text-muted); display: block; margin-bottom: 2px;">Album</label>' +
                      '<input type="text" id="edit-media-album-' + item.id + '" value="' + API.escapeHtml(item.album || 'General') + '" style="width: 100%; padding: 5px 8px; font-size: 0.82rem;" class="form-input">' +
                    '</div>' +
                    '<div>' +
                      '<label for="edit-media-date-' + item.id + '" style="font-size: 0.74rem; font-weight: 700; color: var(--text-muted); display: block; margin-bottom: 2px;">Date Taken</label>' +
                      '<input type="date" id="edit-media-date-' + item.id + '" value="' + API.escapeHtml(item.date_taken || '') + '" style="width: 100%; padding: 5px 8px; font-size: 0.82rem;" class="form-input">' +
                    '</div>' +
                  '</div>' +
                  '<div>' +
                    '<label for="edit-media-contributor-' + item.id + '" style="font-size: 0.74rem; font-weight: 700; color: var(--text-muted); display: block; margin-bottom: 2px;">Contributor Name</label>' +
                    '<input type="text" id="edit-media-contributor-' + item.id + '" value="' + API.escapeHtml(item.contributor_name || '') + '" style="width: 100%; padding: 5px 8px; font-size: 0.82rem;" class="form-input">' +
                  '</div>' +
                  '<div style="margin-top: 2px;">' +
                    '<label style="display: flex; align-items: center; gap: 6px; font-size: 0.8rem; font-weight: 600; cursor: pointer;">' +
                      '<input type="checkbox" id="edit-media-approved-' + item.id + '" ' + (item.is_approved === 1 ? 'checked' : '') + '>' +
                      '<span>Live in Carousel</span>' +
                    '</label>' +
                  '</div>' +
                  '<div style="display: flex; gap: 6px; margin-top: 4px;">' +
                    '<button type="submit" class="btn btn-primary btn-sm btn-save-media" data-id="' + item.id + '" style="flex: 1; font-size: 0.78rem; padding: 5px 8px;">💾 Save</button>' +
                    '<button type="button" class="btn btn-outline btn-sm btn-cancel-edit-media" data-id="' + item.id + '" style="font-size: 0.78rem; padding: 5px 8px;">Cancel</button>' +
                  '</div>' +
                '</form>' +
              '</div>' +
            '</div>' +
          '</div>'
        );
      }).join('');

      container.querySelectorAll('.btn-admin-edit-media').forEach(function (btnEl) {
        var btn = /** @type {HTMLElement} */ (btnEl);
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-id');
          var panel = el('edit-media-panel-' + id);
          if (panel) {
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
          }
        });
      });

      container.querySelectorAll('.btn-cancel-edit-media').forEach(function (btnEl) {
        var btn = /** @type {HTMLElement} */ (btnEl);
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-id');
          var panel = el('edit-media-panel-' + id);
          if (panel) panel.style.display = 'none';
        });
      });

      container.querySelectorAll('.admin-media-edit-form').forEach(function (formEl) {
        var form = /** @type {HTMLFormElement} */ (formEl);
        form.addEventListener('submit', async function (e) {
          e.preventDefault();
          var id = form.getAttribute('data-id') || '';
          var titleEl = /** @type {HTMLInputElement|null} */ (el('edit-media-title-' + id));
          var captionEl = /** @type {HTMLTextAreaElement|null} */ (el('edit-media-caption-' + id));
          var albumEl = /** @type {HTMLInputElement|null} */ (el('edit-media-album-' + id));
          var dateEl = /** @type {HTMLInputElement|null} */ (el('edit-media-date-' + id));
          var contribEl = /** @type {HTMLInputElement|null} */ (el('edit-media-contributor-' + id));
          var approvedEl = /** @type {HTMLInputElement|null} */ (el('edit-media-approved-' + id));

          var title = (titleEl ? titleEl.value : '').trim();
          var caption = (captionEl ? captionEl.value : '').trim();
          var album = (albumEl ? albumEl.value : '').trim() || 'General';
          var date_taken = (dateEl ? dateEl.value : '').trim();
          var contributor_name = (contribEl ? contribEl.value : '').trim();
          var is_approved = approvedEl && approvedEl.checked ? 1 : 0;

          var saveBtn = /** @type {HTMLButtonElement|null} */ (form.querySelector('.btn-save-media'));
          var alertPanel = el('edit-media-alert-' + id);
          if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

          try {
            var res = await API.updateMedia(id, {
              title: title,
              caption: caption,
              album: album,
              date_taken: date_taken,
              contributor_name: contributor_name,
              is_approved: is_approved
            });
            var updated = (res && res.item) ? res.item : { id: parseInt(id, 10), title: title, caption: caption, album: album, date_taken: date_taken, contributor_name: contributor_name, is_approved: is_approved };
            var idx = allCarouselMedia.findIndex(function (m) { return String(m.id) === String(id); });
            if (idx !== -1) {
              allCarouselMedia[idx] = Object.assign({}, allCarouselMedia[idx], updated);
            }
            if (alertEl) {
              alertEl.innerHTML = '<div class="alert alert-success" style="padding: 10px 14px; margin-bottom: 12px;">✓ Media item "' + API.escapeHtml(title) + '" updated successfully.</div>';
              setTimeout(function () { alertEl.innerHTML = ''; }, 4000);
            }
            renderMediaItems();
          } catch (err) {
            if (alertPanel) {
              alertPanel.innerHTML = '<div class="alert alert-error" style="padding: 8px 12px; margin-bottom: 8px;">Failed to save: ' + API.escapeHtml((err && err.message) || 'Error') + '</div>';
            } else if (root.PBFDialog) {
              root.PBFDialog.toast('Failed to update media: ' + ((err && err.message) || 'Error'), { type: 'error' });
            }
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Save'; }
          }
        });
      });

      container.querySelectorAll('.btn-admin-publish-media').forEach(function (btnEl) {
        var btn = /** @type {HTMLButtonElement} */ (btnEl);
        btn.addEventListener('click', async function () {
          var id = btn.getAttribute('data-id') || '';
          btn.disabled = true;
          btn.textContent = 'Publishing...';
          try {
            await API.approveMedia(id);
            var found = allCarouselMedia.find(function (m) { return String(m.id) === String(id); });
            if (found) found.is_approved = 1;
            if (alertEl) {
              alertEl.innerHTML = '<div class="alert alert-success" style="padding: 10px 14px; margin-bottom: 12px;">✓ Media item published live to carousels.</div>';
              setTimeout(function () { alertEl.innerHTML = ''; }, 4000);
            }
            renderMediaItems();
          } catch (err) {
            if (root.PBFDialog) root.PBFDialog.toast('Failed to publish media: ' + ((err && err.message) || 'Error'), { type: 'error' });
            btn.disabled = false;
            btn.textContent = '✓ Publish';
          }
        });
      });

      container.querySelectorAll('.btn-admin-hide-media').forEach(function (btnEl) {
        var btn = /** @type {HTMLButtonElement} */ (btnEl);
        btn.addEventListener('click', async function () {
          var id = btn.getAttribute('data-id') || '';
          btn.disabled = true;
          btn.textContent = 'Hiding...';
          try {
            await API.updateMedia(id, { is_approved: 0 });
            var found = allCarouselMedia.find(function (m) { return String(m.id) === String(id); });
            if (found) found.is_approved = 0;
            if (alertEl) {
              alertEl.innerHTML = '<div class="alert alert-success" style="padding: 10px 14px; margin-bottom: 12px;">🙈 Media item hidden from the public timeline.</div>';
              setTimeout(function () { alertEl.innerHTML = ''; }, 4000);
            }
            renderMediaItems();
          } catch (err) {
            if (root.PBFDialog) root.PBFDialog.toast('Failed to hide media: ' + ((err && err.message) || 'Error'), { type: 'error' });
            btn.disabled = false;
            btn.textContent = '🙈 Hide';
          }
        });
      });

      container.querySelectorAll('.btn-admin-remove-media').forEach(function (btnEl) {
        var btn = /** @type {HTMLButtonElement} */ (btnEl);
        btn.addEventListener('click', async function () {
          var id = btn.getAttribute('data-id') || '';
          var type = btn.getAttribute('data-type');
          var typeLabel = (type === 'video' || type === 'youtube') ? 'video' : 'photo';
          var ok = root.PBFDialog
            ? await root.PBFDialog.confirm('Are you sure you want to permanently remove this ' + typeLabel + ' from the display carousels?', { danger: true })
            : false;
          if (!ok) return;

          btn.disabled = true;
          btn.textContent = 'Removing...';
          try {
            await API.deleteMedia(id);
            allCarouselMedia = allCarouselMedia.filter(function (m) { return String(m.id) !== String(id); });
            renderMediaItems();
            if (alertEl) {
              alertEl.innerHTML = '<div class="alert alert-success" style="padding: 10px 14px; margin-bottom: 12px;">✓ ' + (typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)) + ' successfully removed from the carousel.</div>';
              setTimeout(function () { alertEl.innerHTML = ''; }, 4000);
            }
          } catch (err) {
            if (root.PBFDialog) root.PBFDialog.toast('Failed to delete media item: ' + ((err && err.message) || 'Error'), { type: 'error' });
            btn.disabled = false;
            btn.textContent = '🗑️ Remove';
          }
        });
      });
    }

    filterBtns.forEach(function (btnEl) {
      var btn = /** @type {HTMLElement} */ (btnEl);
      btn.addEventListener('click', function () {
        filterBtns.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        activeMediaTypeFilter = btn.getAttribute('data-type') || 'all';
        renderMediaItems();
      });
    });

    statusBtns.forEach(function (btnEl) {
      var btn = /** @type {HTMLElement} */ (btnEl);
      btn.addEventListener('click', function () {
        statusBtns.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        activeMediaStatusFilter = btn.getAttribute('data-status') || 'all';
        renderMediaItems();
      });
    });

    if (searchInput) {
      searchInput.addEventListener('input', function () {
        renderMediaItems();
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        loadMediaItems();
      });
    }

    await loadMediaItems();
  }

  AdminUI.setupCommunityHighlightsAdmin = setupCommunityHighlightsAdmin;
  AdminUI.updateAdminPostEventDropdown = updateAdminPostEventDropdown;
  AdminUI.loadAdminPosts = loadAdminPosts;
  AdminUI.setupMediaCarouselsAdmin = setupMediaCarouselsAdmin;
})();
