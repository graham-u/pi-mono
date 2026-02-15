/**
 * Service worker for push notifications.
 *
 * Handles incoming push events and notification click actions.
 * Served from /sw.js via Vite's public/ directory.
 */

// Activate new service worker immediately (don't wait for tabs to close)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(clients.claim()));

self.addEventListener("push", (event) => {
	if (!event.data) return;

	let data;
	try {
		data = event.data.json();
	} catch {
		data = { title: "Pi Assistant", body: event.data.text() };
	}

	const options = {
		body: data.body || "",
		icon: "/favicon.ico",
		data: { url: data.url || "/" },
	};

	event.waitUntil(self.registration.showNotification(data.title || "Pi Assistant", options));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();

	const url = event.notification.data?.url || "/";

	event.waitUntil(
		clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
			// Focus an existing tab if one is open
			for (const client of clientList) {
				if (new URL(client.url).pathname.startsWith(url) && "focus" in client) {
					return client.focus();
				}
			}
			// Otherwise open a new tab
			return clients.openWindow(url);
		}),
	);
});
