/**
 * HTTP handler for the assistant server.
 *
 * Provides REST endpoints alongside the WebSocket server.
 * Currently supports message injection and user prompt submission
 * for cron jobs and local scripts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { WebSocket, type WebSocketServer } from "ws";
import { addSubscription, removeSubscription, sendPushToAll } from "./push.js";

/**
 * Create the HTTP request handler.
 *
 * Routes:
 *   POST /api/inject — inject an assistant message into the default session
 *   POST /api/prompt — send a user prompt and get an AI response
 *
 * @param getDefaultSession - callback returning the default (startup) session
 * @param wss - WebSocket server for broadcasting events
 */
export function createHttpHandler(
	getDefaultSession: () => AgentSession,
	wss: WebSocketServer,
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
			handlePrompt(req, res, getDefaultSession());
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

			// Create an assistant message with zeroed usage. A full AssistantMessage
			// requires api/provider/model but those aren't needed for display. Usage
			// must be present because the agent's compaction and stats code accesses
			// it without guarding for undefined.
			const msg = {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: body.content }],
				timestamp: Date.now(),
				stopReason: "stop" as const,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as AssistantMessage;

			// Add to in-memory message list (LLM sees it on next turn)
			session.agent.appendMessage(msg);

			// Persist to session file (survives server restart)
			session.sessionManager.appendMessage(msg as Message);

			// Broadcast to all connected WebSocket clients
			broadcast(wss, { type: "message_start", message: msg });
			broadcast(wss, { type: "message_end", message: msg });

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
 * Accepts: { "text": "message text" }
 * Sends the text as a user prompt through session.prompt(). The AI response
 * streams to connected WebSocket clients via the normal event subscription.
 * Returns 200 immediately — the response is async.
 */
function handlePrompt(req: IncomingMessage, res: ServerResponse, session: AgentSession): void {
	const chunks: Buffer[] = [];

	req.on("data", (chunk: Buffer) => chunks.push(chunk));

	req.on("end", () => {
		try {
			const body = JSON.parse(Buffer.concat(chunks).toString());

			if (!body.text || typeof body.text !== "string") {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Missing or invalid 'text' field" }));
				return;
			}

			// Fire and forget — response streams via WebSocket events
			session
				.prompt(body.text, { source: "rpc" })
				.catch((e) => console.error("[assistant-server] Prompt error:", e.message));

			console.log(`[assistant-server] Prompt submitted (${body.text.length} chars): ${body.text.slice(0, 80)}`);

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ success: true }));
		} catch (e: any) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: `Invalid JSON: ${e.message}` }));
		}
	});
}

/**
 * Broadcast a message to all connected WebSocket clients.
 */
function broadcast(wss: WebSocketServer, msg: object): void {
	const data = JSON.stringify(msg);
	for (const client of wss.clients) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(data);
		}
	}
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
