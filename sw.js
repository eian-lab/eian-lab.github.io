import { getFile } from './storage.js';
import { parseRange, mediaType } from './core.js';
const VERSION = 'minna-shell-v3.0.0';
const ROOT = new URL('./', self.location.href);
const SHELL = ['', 'app.css', 'app.js', 'core.js', 'storage.js', 'manifest.webmanifest', 'icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'data/catalog.json'];
self.addEventListener('install', event => {
  // New cache names must contain newly fetched files, never a previous release's
  // HTTP-cache copies of app.js, core.js, or storage.js.
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL.map(path => new Request(new URL(path, ROOT), { cache: 'reload' })));
    // Only take over after every release file is safely available offline.
    // Existing windows keep their current document and playback until reopened.
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('minna-shell-') && name !== VERSION) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'SHELL_STATUS') event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    const complete = (await Promise.all(SHELL.map(path => cache.match(new URL(path, ROOT).href)))).every(Boolean);
    event.ports[0]?.postMessage({ complete, version: VERSION });
  })());
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname)) return;
  const relative = url.pathname.slice(ROOT.pathname.length);
  if (relative.startsWith('__local/')) {
    event.respondWith(localMedia(event.request, relative)); return;
  }
  if (event.request.method !== 'GET') return;
  if (event.request.mode === 'navigate' && (relative === '' || relative === 'index.html')) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const response = await cache.match(ROOT.href) || await fetch(event.request);
      return navigationResponse(response);
    })()); return;
  }
  if (SHELL.some(path => new URL(path, ROOT).pathname === url.pathname)) {
    event.respondWith((async () => (await caches.open(VERSION)).match(event.request, { ignoreSearch: true }).then(cached => cached || fetch(event.request)))());
  }
});
function navigationResponse(response) {
  // Navigation requests use manual redirects. A cached response whose fetch
  // already followed index.html -> / is rejected by Safari when replayed as-is.
  // Keep genuine HTTP/opaque redirects intact so the browser can perform them.
  if (!response.redirected || response.type === 'opaqueredirect' || response.status < 200 || (response.status >= 300 && response.status < 400)) return response;
  // Do not relabel a third-party final document as this app's same-origin HTML.
  if (response.url && new URL(response.url).origin !== ROOT.origin) return Response.redirect(response.url, 302);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
async function localMedia(request, relative) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  const match = /^__local\/(lesson-\d{2})\/(audio\/[a-zA-Z0-9_-]+\.(?:mp3|m4a)|data\/lesson-\d{2}\.json)$/.exec(relative);
  if (!match) return new Response('本机课程文件路径不正确。', { status: 400 });
  try {
    const record = await getFile(match[1], match[2]);
    if (!record?.blob) return new Response(`找不到音频或课程文件：${match[2]}`, { status: 404 });
    const blob = record.blob, range = parseRange(request.headers.get('Range'), blob.size);
    const headers = { 'Content-Type': mediaType(match[2]), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (range === false) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${blob.size}` } });
    if (range) {
      const slice = blob.slice(range.start, range.end + 1, blob.type);
      return new Response(request.method === 'HEAD' ? null : slice, { status: 206, headers: { ...headers, 'Content-Length': String(slice.size), 'Content-Range': `bytes ${range.start}-${range.end}/${blob.size}` } });
    }
    return new Response(request.method === 'HEAD' ? null : blob, { headers: { ...headers, 'Content-Length': String(blob.size) } });
  } catch {
    return new Response(`无法读取本机文件：${match[2]}。请重新打开或导入课程包。`, { status: 503 });
  }
}
