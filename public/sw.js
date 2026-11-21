// Service Worker for Pickup Baseball Foundation PWA
const CACHE_NAME = 'pbf-cache-v183';
/** @type {ServiceWorkerGlobalScope} */
const sw = /** @type {any} */ (self);

// Core app shell & pages precached on install; i18n bundles (~312 KB) are cached on demand
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/archive.html',
  '/event.html',
  '/donate.html',
  '/about.html',
  '/art.html',
  '/gallery.html',
  '/clubhouse.html',
  '/waiver.html',
  '/login.html',
  '/profile.html',
  '/admin.html',
  '/404.html',
  '/css/style.css',
  '/css/dialog.css',
  '/css/weather.css',
  '/css/event.css',
  '/css/gallery.css',
  '/css/art.css',
  '/css/themes.css',
  '/css/clubhouse.css',
  '/js/api.js',
  '/js/api/i18n.js',
  '/js/api/ui.js',
  '/js/api/endpoints.js',
  '/js/dialog.js',
  '/js/crypto.js',
  '/js/store.js',
  '/js/store/idb.js',
  '/js/store/e2ee.js',
  '/js/store/sync.js',
  '/js/store/actions.js',
  '/js/rtc.js',
  '/js/clubhouse/layout.js',
  '/js/clubhouse/messages.js',
  '/js/clubhouse/e2ee-ui.js',
  '/js/clubhouse/panels.js',
  '/js/clubhouse.js',
  '/js/weather.js',
  '/js/art.js',
  '/js/gallery.js',
  '/js/app.js',
  '/js/archive.js',
  '/js/admin/backup.js',
  '/js/admin/events-tasks.js',
  '/js/admin/users-moderation.js',
  '/js/admin/content-media.js',
  '/js/admin.js',
  '/js/login.js',
  '/js/profile.js',
  '/js/event/rsvp.js',
  '/js/event/organizer.js',
  '/js/event/bp.js',
  '/js/event.js',
  '/js/waiver.js',
  '/js/nav-init.js',
  '/logo.svg',
  '/favicon.ico',
  '/manifest.webmanifest',
  '/gifs/catalog.json',
  '/gifs/cheers.gif',
  '/gifs/goodwill.gif',
  '/gifs/home-run.gif',
  '/gifs/play-ball.gif',
  '/gifs/rain-check.gif',
  '/gifs/rally-cap.gif',
  '/gifs/safe.gif',
  '/gifs/strikeout.gif',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32x32.png',
  '/icons/favicon-16x16.png'
];

// Install: Cache core application shell
sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use Promise.all with individual catch so missing optional files don't fail install (ES6 compatible)
      return Promise.all(
        STATIC_ASSETS.map((url) => cache.add(url).catch((err) => console.warn('[SW] Failed to precache:', url, err)))
      );
    }).then(() => sw.skipWaiting())
  );
});

// Activate: Clean up older cache versions & claim clients
sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Deleting obsolete cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => sw.clients.claim())
  );
});

// Only cache successful same-origin responses that do not opt out of storage
function isCacheableResponse(res) {
  if (!res || res.status !== 200 || res.type !== 'basic') return false;
  const cacheControl = (res.headers.get('Cache-Control') || '').toLowerCase();
  return cacheControl.indexOf('no-store') === -1 && cacheControl.indexOf('private') === -1;
}

// Fetch: Strategy depending on request type
sw.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GET requests
  if (req.method !== 'GET' || url.origin !== sw.location.origin) {
    return;
  }

  // 1. Dynamic API & RSS Feed calls: ALWAYS Network Only (Never cache live database, auth, roster, or feed data)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/') || url.pathname === '/feed.xml') {
    event.respondWith(fetch(req));
    return;
  }

  // 2. HTML Page Navigation: Network First with Cache Fallback
  if (req.mode === 'navigate') {
    const hasSensitiveParams =
      url.searchParams.has('token') ||
      url.searchParams.has('takedown') ||
      url.searchParams.has('code');
    const normalizedNavKey = new Request(url.origin + url.pathname);
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (!hasSensitiveParams && isCacheableResponse(networkRes)) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(normalizedNavKey, clone));
          }
          return networkRes;
        })
        .catch(() => {
          return caches.match(normalizedNavKey).then((cached) => {
            return cached || caches.match('/index.html');
          });
        })
    );
    return;
  }

  // 3. Static Assets (CSS, JS, Images, i18n JSON): Version-Aware Stale-While-Revalidate
  // Versioned URLs (?v=N) require an exact cache match first so an older SW never serves stale JS/CSS across releases,
  // falling back to { ignoreSearch: true } only if the network is unreachable offline.
  const isVersionedAsset = url.searchParams.has('v');
  event.respondWith(
    caches.match(req, isVersionedAsset ? undefined : { ignoreSearch: true }).then((cachedRes) => {
      const fetchPromise = fetch(req)
        .then((networkRes) => {
          if (isCacheableResponse(networkRes)) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(() => {
          if (cachedRes) return cachedRes;
          if (!isVersionedAsset) return Response.error();
          return caches.match(req, { ignoreSearch: true }).then((fallback) => fallback || Response.error());
        });

      return cachedRes || fetchPromise;
    })
  );
});

// Message listener for manual app update
sw.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    sw.skipWaiting();
  }
});

// Web Push: display opt-in notification
sw.addEventListener('push', (event) => {
  let payload = { title: 'Pickup Baseball', body: 'New field or game update.', url: '/' };
  try {
    if (event.data) {
      const parsed = event.data.json();
      if (parsed && typeof parsed === 'object') {
        payload = Object.assign(payload, parsed);
      }
    }
  } catch (e) {
    if (event.data) payload.body = event.data.text();
  }
  event.waitUntil(
    sw.registration.showNotification(payload.title || 'Pickup Baseball', {
      body: payload.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: payload.tag || undefined,
      data: { url: payload.url || '/' }
    })
  );
});

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification && event.notification.data && event.notification.data.url) ? event.notification.data.url : '/';
  event.waitUntil(
    sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.indexOf(targetUrl) !== -1 && 'focus' in client) {
          return client.focus();
        }
      }
      if (sw.clients.openWindow) return sw.clients.openWindow(targetUrl);
    })
  );
});
