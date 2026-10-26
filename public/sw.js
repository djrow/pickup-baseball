// Service Worker for Pickup Baseball Foundation PWA
const CACHE_NAME = 'pbf-cache-v11';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/archive.html',
  '/event.html',
  '/donate.html',
  '/login.html',
  '/profile.html',
  '/admin.html',
  '/404.html',
  '/css/style.css',
  '/js/api.js',
  '/js/app.js',
  '/js/archive.js',
  '/js/account-dashboard.js',
  '/js/event.js',
  '/logo.svg',
  '/favicon.ico',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32x32.png',
  '/icons/favicon-16x16.png',
  '/i18n/ar.json',
  '/i18n/es.json',
  '/i18n/fa.json',
  '/i18n/fr.json',
  '/i18n/hi.json',
  '/i18n/hy.json',
  '/i18n/ja.json',
  '/i18n/ko.json',
  '/i18n/pa.json',
  '/i18n/pt.json',
  '/i18n/ru.json',
  '/i18n/tl.json',
  '/i18n/vi.json',
  '/i18n/zh.json'
];

// Install: Cache core application shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use Promise.all with individual catch so missing optional files don't fail install (ES6 compatible)
      return Promise.all(
        STATIC_ASSETS.map((url) => cache.add(url).catch((err) => console.warn('[SW] Failed to precache:', url, err)))
      );
    }).then(() => self.skipWaiting())
  );
});

// Activate: Clean up older cache versions & claim clients
self.addEventListener('activate', (event) => {
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
    }).then(() => self.clients.claim())
  );
});

// Fetch: Strategy depending on request type
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET requests
  if (req.method !== 'GET') {
    return;
  }

  // 1. Dynamic API calls: ALWAYS Network Only (Never cache live database, auth, or roster data)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  // 2. HTML Page Navigation: Network First with Cache Fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(() => {
          return caches.match(req).then((cached) => {
            return cached || caches.match('/index.html');
          });
        })
    );
    return;
  }

  // 3. Static Assets (CSS, JS, Images, i18n JSON): Stale-While-Revalidate
  // ignoreSearch: true allows versioned queries (?v=4) to match precached shell assets
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cachedRes) => {
      const fetchPromise = fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(() => cachedRes);

      return cachedRes || fetchPromise;
    })
  );
});
