const CACHE_NAME = "shopclock-pwa-v1";

const BASE_URL = new URL("./", self.location).href;

const APP_FILES = [
  BASE_URL,
  new URL("./index.html", self.location).href,
  new URL("./styles.css", self.location).href,
  new URL("./app.js", self.location).href,
  new URL("./manifest.webmanifest", self.location).href,
  new URL("./icon.svg", self.location).href,
  new URL("./icon-192.png", self.location).href,
  new URL("./icon-512.png", self.location).href,
  new URL("./vendor/jsQR.js", self.location).href,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES))
  );

  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
  );

  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(async (cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      try {
        const networkResponse = await fetch(event.request);

        if (
          networkResponse.ok ||
          networkResponse.type === "opaque"
        ) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(event.request, networkResponse.clone());
        }

        return networkResponse;
      } catch (error) {
        if (event.request.mode === "navigate") {
          return caches.match(
            new URL("./index.html", self.location).href
          );
        }

        throw error;
      }
    })
  );
});