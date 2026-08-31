// No-op service worker — present only so "Add to Home Screen" behaves like a
// real installable PWA. No caching: this probe should always hit the network.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
