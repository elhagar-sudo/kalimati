/* Offline cache for Kalimati */
const VERSION = 'kalimati-v2.8.0';
const OCR = 'kalimati-ocr-v1'; // camera reader files (about 11 MB): kept across app updates
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'pron.js', 'manifest.webmanifest', 'data/core.json', 'data/lex.json', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's own cache, so an update always gets the new files
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== OCR).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
const keep = (name, req, res) => { if (res && (res.ok || res.type === 'opaque')) { const cp = res.clone(); caches.open(name).then(c => c.put(req, cp)).catch(() => { }); } return res; };
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // app files: cache first, ignore query string (share links)
    const store = url.pathname.includes('/ocr/') ? OCR : VERSION;
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req).then(res => keep(store, req, res))
      .catch(err => { if (req.mode === 'navigate') return caches.match('index.html'); throw err; })));
  } else if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => keep(VERSION, req, res)).catch(() => new Response('', { status: 504 }))));
  }
});
