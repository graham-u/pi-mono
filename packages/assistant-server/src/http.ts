/**
 * HTTP handler for the assistant server.
 *
 * Provides REST endpoints alongside the WebSocket server.
 * Currently supports message injection and user prompt submission
 * for cron jobs and local scripts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { WebSocketServer } from "ws";
import { persistAndBroadcastAll } from "./handlers.js";
import { addSubscription, removeSubscription, sendPushToAll } from "./push.js";

/**
 * Create the HTTP request handler.
 *
 * Routes:
 *   POST /api/inject — inject an assistant message into the default session
 *   POST /api/prompt — send a user prompt and get an AI response
 *
 * @param getDefaultSession - callback returning the default (startup) session
 * @param createNewSession - factory to create a fresh session in the pool
 * @param wss - WebSocket server for broadcasting events
 */
export function createHttpHandler(
	getDefaultSession: () => AgentSession,
	createNewSession: () => Promise<AgentSession>,
	wss: WebSocketServer,
	processInput: (text: string, images: undefined, session: AgentSession, sessionPath: string) => Promise<boolean>,
): (req: IncomingMessage, res: ServerResponse) => void {
	return (req, res) => {
		// Localhost-only guard
		const addr = req.socket.remoteAddress;
		if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Forbidden" }));
			return;
		}

		if (req.method === "POST" && req.url === "/api/inject") {
			handleInject(req, res, getDefaultSession(), wss);
			return;
		}

		if (req.method === "POST" && req.url === "/api/prompt") {
			handlePrompt(req, res, getDefaultSession, createNewSession, processInput);
			return;
		}

		// --- Push notification routes ---

		if (req.method === "GET" && req.url === "/api/push/vapid-public-key") {
			const key = process.env.VAPID_PUBLIC_KEY ?? "";
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ key }));
			return;
		}

		if (req.method === "POST" && req.url === "/api/push/subscribe") {
			handlePushSubscribe(req, res);
			return;
		}

		if (req.method === "POST" && req.url === "/api/push/unsubscribe") {
			handlePushUnsubscribe(req, res);
			return;
		}

		if (req.method === "POST" && req.url === "/api/push/send") {
			handlePushSend(req, res);
			return;
		}

		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Not found" }));
	};
}

/**
 * POST /api/inject
 *
 * Accepts: { "content": "message text" }
 * Creates an assistant message, persists it, and broadcasts to all WS clients.
 */
function handleInject(req: IncomingMessage, res: ServerResponse, session: AgentSession, wss: WebSocketServer): void {
	const chunks: Buffer[] = [];

	req.on("data", (chunk: Buffer) => chunks.push(chunk));

	req.on("end", () => {
		try {
			const body = JSON.parse(Buffer.concat(chunks).toString());

			if (!body.content || typeof body.content !== "string") {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Missing or invalid 'content' field" }));
				return;
			}

			persistAndBroadcastAll(session, wss, body.content);
			console.log(`[assistant-server] Injected message (${body.content.length} chars)`);

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ success: true }));
		} catch (e: any) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: `Invalid JSON: ${e.message}` }));
		}
	});
}

/**
 * POST /api/prompt
 *
 * Accepts: { "text": "message text", "newSession"?: boolean, "sessionName"?: string, "model"?: string }
 * Sends the text as a user prompt through session.prompt(). The AI response
 * streams to connected WebSocket clients via the normal event subscription.
 *
 * When `newSession` is true, a fresh session is created before prompting.
 * This is useful for cron jobs (e.g. daily planner) that should not pollute
 * interactive sessions. An optional `sessionName` labels the new session.
 *
 * When `model` is provided (e.g. "claude-opus-4-6"), the session's model is
 * switched before prompting. The model is matched by ID across all providers.
 *
 * Returns 200 immediately — the response is async.
 */
function handlePrompt(
	req: IncomingMessage,
	res: ServerResponse,
	getDefaultSession: () => AgentSession,
	createNewSession: () => Promise<AgentSession>,
	processInput: (text: string, images: undefined, session: AgentSession, sessionPath: string) => Promise<boolean>,
): void {
	const chunks: Buffer[] = [];

	req.on("data", (chunk: Buffer) => chunks.push(chunk));

	req.on("end", async () => {
		let body: any;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString());
		} catch (e: any) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: `Invalid JSON: ${e.message}` }));
			return;
		}

		try {
			if (!body.text || typeof body.text !== "string") {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Missing or invalid 'text' field" }));
				return;
			}

			let session: AgentSession;
			if (body.newSession) {
				session = await createNewSession();
				if (body.sessionName) {
					session.setSessionName(body.sessionName);
				}
			} else {
				session = getDefaultSession();
			}

			if (body.model) {
				const models = await session.modelRegistry.getAvailable();
				const match = models.find((m) => m.id === body.model);
				if (!match) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: `Model not found: ${body.model}` }));
					return;
				}
				await session.setModel(match);
			}

			const sessionPath = session.sessionFile ?? session.sessionId;
			const handled = await processInput(body.text, undefined, session, sessionPath);

			console.log(
				`[assistant-server] Prompt ${handled ? "handled" : "submitted"} (${body.text.length} chars): ${body.text.slice(0, 80)}`,
			);

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ success: true, handled, sessionPath }));
		} catch (e: any) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: e.message }));
		}
	});
}

// ============================================================================
// Push notification handlers
// ============================================================================

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
		req.on("error", reject);
	});
}

async function handlePushSubscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const body = JSON.parse(await readBody(req));
		if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Invalid subscription object" }));
			return;
		}
		addSubscription({
			endpoint: body.endpoint,
			keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
		});
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ success: true }));
	} catch (e: any) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: e.message }));
	}
}

async function handlePushUnsubscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const body = JSON.parse(await readBody(req));
		if (!body.endpoint) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Missing 'endpoint' field" }));
			return;
		}
		removeSubscription(body.endpoint);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ success: true }));
	} catch (e: any) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: e.message }));
	}
}

async function handlePushSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const body = JSON.parse(await readBody(req));
		if (!body.title || !body.body) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Missing 'title' or 'body' field" }));
			return;
		}
		const result = await sendPushToAll({ title: body.title, body: body.body, url: body.url });
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ success: true, ...result }));
	} catch (e: any) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: e.message }));
	}
}
