/**
 * Push notification registration for the assistant frontend.
 *
 * Registers a service worker and subscribes to push notifications
 * using the Web Push API with VAPID authentication.
 */

/**
 * Convert a URL-safe base64 string to a Uint8Array (for applicationServerKey).
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
	const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64);
	const arr = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) {
		arr[i] = raw.charCodeAt(i);
	}
	return arr;
}

/**
 * Send a subscription object to the server.
 */
async function sendSubscriptionToServer(subscription: PushSubscription): Promise<void> {
	const res = await fetch("/api/push/subscribe", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(subscription.toJSON()),
	});
	if (!res.ok) {
		throw new Error(`Server rejected subscription: ${res.status}`);
	}
}

/**
 * Register for push notifications.
 *
 * 1. Checks browser support
 * 2. Registers the service worker
 * 3. Re-sends existing subscription or creates a new one
 * 4. Sends subscription to the server
 */
export async function registerPushNotifications(): Promise<void> {
	if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
		console.log("[push] Push notifications not supported in this browser");
		return;
	}

	if (Notification.permission === "denied") {
		console.log("[push] Notification permission denied — skipping");
		return;
	}

	const registration = await navigator.serviceWorker.register("/sw.js");
	console.log("[push] Service worker registered");

	// Check for existing subscription
	const existing = await registration.pushManager.getSubscription();
	if (existing) {
		// Re-send to server in case it was lost (e.g. server restarted with empty store)
		await sendSubscriptionToServer(existing);
		console.log("[push] Existing subscription re-sent to server");
		return;
	}

	// Fetch VAPID public key from server
	const keyRes = await fetch("/api/push/vapid-public-key");
	const { key } = await keyRes.json();
	if (!key) {
		console.log("[push] Server has no VAPID key configured — skipping");
		return;
	}

	// Subscribe
	const subscription = await registration.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: urlBase64ToUint8Array(key).buffer as ArrayBuffer,
	});

	await sendSubscriptionToServer(subscription);
	console.log("[push] Subscribed to push notifications");
}
