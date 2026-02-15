/**
 * Push notification support.
 *
 * Uses the Web Push protocol with VAPID authentication.
 * Subscriptions are stored in ~/.pi/agent/push-subscriptions.json.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import webpush from "web-push";

const SUBS_FILE = join(getAgentDir(), "push-subscriptions.json");

interface PushSubscriptionRecord {
	endpoint: string;
	keys: {
		p256dh: string;
		auth: string;
	};
}

let subscriptions: PushSubscriptionRecord[] = [];
let vapidConfigured = false;

/**
 * Initialise VAPID credentials from environment variables.
 * Fails gracefully if not configured — push simply won't work.
 */
export function initVapid(): void {
	const publicKey = process.env.VAPID_PUBLIC_KEY;
	const privateKey = process.env.VAPID_PRIVATE_KEY;
	const subject = process.env.VAPID_SUBJECT;

	if (!publicKey || !privateKey || !subject) {
		console.log("[push] VAPID keys not configured — push notifications disabled");
		return;
	}

	webpush.setVapidDetails(subject, publicKey, privateKey);
	vapidConfigured = true;
	loadSubscriptions();
	console.log(`[push] VAPID configured, ${subscriptions.length} subscription(s) loaded`);
}

export function isVapidConfigured(): boolean {
	return vapidConfigured;
}

function loadSubscriptions(): void {
	if (!existsSync(SUBS_FILE)) {
		subscriptions = [];
		return;
	}
	try {
		subscriptions = JSON.parse(readFileSync(SUBS_FILE, "utf-8"));
	} catch {
		console.error("[push] Failed to parse subscriptions file, starting fresh");
		subscriptions = [];
	}
}

function saveSubscriptions(): void {
	const tmp = `${SUBS_FILE}.tmp`;
	writeFileSync(tmp, JSON.stringify(subscriptions, null, 2));
	renameSync(tmp, SUBS_FILE);
}

/**
 * Add a subscription, de-duplicating by endpoint.
 */
export function addSubscription(sub: PushSubscriptionRecord): void {
	// Replace existing subscription with same endpoint (keys may have rotated)
	subscriptions = subscriptions.filter((s) => s.endpoint !== sub.endpoint);
	subscriptions.push(sub);
	saveSubscriptions();
	console.log(`[push] Subscription added (${subscriptions.length} total)`);
}

/**
 * Remove a subscription by endpoint.
 */
export function removeSubscription(endpoint: string): void {
	const before = subscriptions.length;
	subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint);
	if (subscriptions.length < before) {
		saveSubscriptions();
		console.log(`[push] Subscription removed (${subscriptions.length} total)`);
	}
}

/**
 * Send a push notification to all subscribed devices.
 * Automatically removes expired subscriptions (HTTP 410).
 */
export async function sendPushToAll(payload: { title: string; body: string; url?: string }): Promise<{
	sent: number;
	failed: number;
	removed: number;
}> {
	if (!vapidConfigured) {
		throw new Error("VAPID not configured");
	}

	const data = JSON.stringify(payload);
	let sent = 0;
	let failed = 0;
	let removed = 0;
	const toRemove: string[] = [];

	await Promise.allSettled(
		subscriptions.map(async (sub) => {
			try {
				await webpush.sendNotification(sub, data);
				sent++;
			} catch (err: any) {
				if (err.statusCode === 410 || err.statusCode === 404) {
					// Subscription expired or invalid
					toRemove.push(sub.endpoint);
					removed++;
				} else {
					console.error(`[push] Failed to send to ${sub.endpoint}:`, err.statusCode ?? err.message);
					failed++;
				}
			}
		}),
	);

	// Clean up expired subscriptions
	if (toRemove.length > 0) {
		subscriptions = subscriptions.filter((s) => !toRemove.includes(s.endpoint));
		saveSubscriptions();
		console.log(`[push] Removed ${toRemove.length} expired subscription(s)`);
	}

	return { sent, failed, removed };
}
