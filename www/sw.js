// Service worker: fa funzionare l'app su PC anche senza connessione.
const CACHE = "cf-v2";
const SHELL = ["./", "index.html", "style.css", "app.js", "config.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "seed.json"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Firebase (dati, accesso, copertine): sempre dalla rete; l'app ne tiene già una copia locale.
  if (url.host.endsWith("googleapis.com") && !url.host.startsWith("fonts.")) return;
  // Font: prima la cache, poi la rete.
  if (url.host.includes("fonts.g")) {
    e.respondWith(caches.open(CACHE + "-img").then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      const res = await fetch(req); if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res;
    }));
    return;
  }
  // File dell'app: prima la rete (così prendi subito gli aggiornamenti), cache se sei offline.
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(res => { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); return res; }).catch(() => caches.match(req).then(r => r || caches.match("index.html"))));
  }
});
