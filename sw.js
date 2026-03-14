const CACHE_NAME = 'table-v3.0';
const DATA_CACHE = 'table-data-v1';

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=iA+Writer+Mono:wght@400&display=swap'
];

// Firebase JS SDK modules to precache for offline
const FIREBASE_SDK = [
  'https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js',
];

// ============ INSTALL ============
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll([...STATIC_ASSETS, ...FIREBASE_SDK]))
      .then(() => self.skipWaiting())
  );
});

// ============ ACTIVATE ============
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME && k !== DATA_CACHE).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ============ FETCH ============
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Network-only for Firebase Auth and Cloud Functions (never cache auth/mutations)
  if (url.hostname.includes('identitytoolkit.googleapis.com') ||
      url.hostname.includes('securetoken.googleapis.com') ||
      url.hostname.includes('accounts.google.com') ||
      url.hostname.includes('cloudfunctions.net')) {
    return;
  }

  // Stale-while-revalidate for Firestore reads — serve cached, update in background
  if (url.hostname.includes('firestore.googleapis.com')) {
    e.respondWith(
      caches.open(DATA_CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          const networkFetch = fetch(e.request).then(response => {
            if (response.ok) cache.put(e.request, response.clone());
            return response;
          }).catch(() => cached); // if network fails, fall back to cache

          return cached || networkFetch;
        })
      )
    );
    return;
  }

  // Cache-first for Firebase Storage (images)
  if (url.hostname.includes('firebasestorage.googleapis.com')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Cache-first for fonts, CDN assets, and Firebase SDK
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com') ||
      url.hostname.includes('gstatic.com/firebasejs') ||
      url.hostname.includes('cdnjs.cloudflare.com')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Network-first for app pages (HTML, JS) — update cache, serve from cache if offline
  e.respondWith(
    fetch(e.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(e.request).then(cached => {
        // For navigation requests, always return index.html from cache
        if (e.request.mode === 'navigate') {
          return caches.match('./index.html') || cached;
        }
        return cached;
      }))
  );
});

// ============ BACKGROUND SYNC (future: offline visit logging) ============
self.addEventListener('sync', e => {
  if (e.tag === 'sync-visits') {
    // Placeholder for offline visit queue sync
    e.waitUntil(Promise.resolve());
  }
});
