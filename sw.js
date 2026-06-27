// ══════════════════════════════════════════════════════════════════════════════
// El Hórreo — Service Worker v2.1
// Push notifications + cache offline básico
// ══════════════════════════════════════════════════════════════════════════════

const SW_VERSION = "2.1.0";
const CACHE_NAME = "horreo-sw-" + SW_VERSION;

// ── Install — skipWaiting fuerza activación inmediata sin esperar tabs cerradas
self.addEventListener("install", event => {
  self.skipWaiting();
});

// ── Activate — limpia caches viejos y toma control de todos los clientes
// FIX: eliminado clients.navigate() que causaba recarga forzada al actualizar el SW,
// lo que podía interrumpir suscripciones push en proceso.
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Push ──────────────────────────────────────────────────────────────────────
self.addEventListener("push", event => {
  let data = {
    title: "El Hórreo",
    body:  "Nueva notificación",
    icon:  "/icon-192.svg",
    badge: "/icon-192.svg",
    tag:   "horreo-push",
    data:  {},
  };

  try {
    if (event.data) {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
    }
  } catch {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:     data.body,
      icon:     data.icon  || "/icon-192.svg",
      badge:    data.badge || "/icon-192.svg",
      tag:      data.tag   || "horreo-push",
      renotify: true,
      vibrate:  [200, 100, 200],
      data:     data.data  || {},
    })
  );
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) {
        existing.focus();
        if (url !== "/") existing.navigate(url);
      } else {
        clients.openWindow(url);
      }
    })
  );
});

// ── Fetch — pass-through con fallback offline para index.html ─────────────────
self.addEventListener("fetch", event => {
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/index.html"))
    );
  }
});
