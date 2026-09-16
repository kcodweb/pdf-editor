// Offline support: the app shell is cached on install; fonts and pdf.js character maps are
// cached the first time they're used. Bump VERSION when shipping changes to the app shell.
const VERSION = 'pdf-editor-v5';
// Text recognition (OCR) engine and language data are fetched on first use from these hosts.
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];

const APP_SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'fonts.js',
  'forms.js',
  'textlayer.js',
  'decor.js',
  'export.js',
  'signature.js',
  'secure.js',
  'convert.js',
  'hub.js',
  'vendor/pdf-lib-secure.min.js',
  'vendor/pdf.min.js',
  'vendor/pdf.worker.min.js',
  'vendor/pdf-lib.min.js',
  'vendor/fontkit.umd.min.js',
  'vendor/jszip.min.js',
  'fonts/NotoSans-Regular.ttf',
  'fonts/NotoSans-Bold.ttf',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !CDN_HOSTS.includes(url.hostname)) return;

  // Fonts, libraries and character maps never change: cache first.
  const immutable = !sameOrigin || /\/(fonts|vendor)\//.test(url.pathname);

  event.respondWith(caches.open(VERSION).then(async (cache) => {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached && immutable) return cached;
    const network = fetch(request)
      .then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
      .catch(() => cached || Response.error());
    // App files: serve the cached copy immediately and refresh it in the background.
    return cached || network;
  }));
});
