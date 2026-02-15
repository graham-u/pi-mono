/**
 * Server-side input handler chain.
 *
 * Pluggable handlers that inspect user input before it reaches the LLM.
 * Each handler is a .js file in ~/.pi/agent/handlers/ exporting a factory
 * function that returns an InputHandler.
 *
 * Flow: input arrives → slash commands → handler chain → LLM fallthrough.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantMessage, ImageContent } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { WebSocket, type WebSocketServer } from "ws";

/** Reply callback that injects an assistant message into the chat. */
export type ReplyFn = (text: string) => void;

// ============================================================================
// Types
// ============================================================================

export interface InputHandlerResult {
	handled: boolean;
}

export interface HandlerContext {
	/**
	 * Inject an assistant message into the chat. The message is persisted and
	 * broadcast only to WebSocket clients viewing the current session.
	 * Each call produces a separate message. Only call this when you intend to
	 * return `{ handled: true }` — if the handler throws after calling reply(),
	 * the message is already sent but the chain continues to the next handler.
	 */
	reply: ReplyFn;
	/** The current agent session. */
	session: AgentSession;
	/** Images attached to the input, if any. */
	images?: ImageContent[];
}

export interface InputHandler {
	/** Human-readable name for debugging/logging. */
	name: string;
	/** Optional description. */
	description?: string;
	/** Examine input and optionally handle it. Return { handled: true } to stop the chain. */
	handle(input: string, ctx: HandlerContext): Promise<InputHandlerResult>;
}

/** Factory function exported by handler .js files. */
type HandlerFactory = () => InputHandler;

// ============================================================================
// Loading
// ============================================================================

const HANDLERS_DIR = join(getAgentDir(), "handlers");

/**
 * Load all .js handler files from ~/.pi/agent/handlers/.
 * Each file must default-export a factory function that returns an InputHandler.
 */
export const loadHandlers = () => loadHandlersInternal(false);

/**
 * Reload all handlers, cache-busting the module import.
 */
export const reloadHandlers = () => loadHandlersInternal(true);

async function loadHandlersInternal(bustCache: boolean): Promise<InputHandler[]> {
	if (!existsSync(HANDLERS_DIR)) return [];

	const files = readdirSync(HANDLERS_DIR)
		.filter((f) => f.endsWith(".js"))
		.sort(); // deterministic alphabetical order

	const handlers: InputHandler[] = [];
	for (const file of files) {
		try {
			const filePath = join(HANDLERS_DIR, file);
			let fileUrl = pathToFileURL(filePath).href;
			if (bustCache) fileUrl += `?t=${Date.now()}`;
			const mod = await import(fileUrl);
			const factory: HandlerFactory = mod.default;
			if (typeof factory !== "function") {
				console.warn(`[handlers] ${file}: default export is not a function, skipping`);
				continue;
			}
			const handler = factory();
			if (!handler.name || typeof handler.handle !== "function") {
				console.warn(`[handlers] ${file}: factory did not return a valid handler, skipping`);
				continue;
			}
			handlers.push(handler);
			console.log(`[handlers] Loaded: ${handler.name} (${file})`);
		} catch (e: any) {
			console.error(`[handlers] Failed to load ${file}:`, e.message);
		}
	}
	return handlers;
}

// ============================================================================
// Chain runner
// ============================================================================

/**
 * Run the handler chain. Returns { handled: true } if any handler claimed the input.
 *
 * @param reply - Callback that persists an assistant message and broadcasts it
 *   to the appropriate WebSocket clients. Built by the caller (server.ts) which
 *   has access to client routing information.
 */
export async function runHandlerChain(
	input: string,
	images: ImageContent[] | undefined,
	session: AgentSession,
	reply: ReplyFn,
	handlers: InputHandler[],
): Promise<InputHandlerResult> {
	const ctx: HandlerContext = {
		reply,
		session,
		images,
	};

	for (const handler of handlers) {
		try {
			const result = await handler.handle(input, ctx);
			if (result.handled) {
				console.log(`[handlers] "${input.slice(0, 60)}" handled by: ${handler.name}`);
				return { handled: true };
			}
		} catch (e: any) {
			console.error(`[handlers] Error in handler "${handler.name}":`, e.message);
			// Continue to next handler on error
		}
	}
	return { handled: false };
}

// ============================================================================
// Shared inject helper
// ============================================================================

/**
 * Create and persist an assistant message in the session (in-memory + session file).
 * Returns the message for callers that need to broadcast it themselves.
 *
 * Usage is zeroed because injected messages don't go through the LLM.
 * api/provider/model are empty strings — they aren't needed for display but
 * must be present because the type requires them. Usage must be present because
 * the agent's compaction and stats code accesses it without guarding for undefined.
 */
export function persistAssistantMessage(session: AgentSession, text: string): AssistantMessage {
	const msg: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "",
		provider: "",
		model: "",
		timestamp: Date.now(),
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};

	// Add to in-memory message list (LLM sees it on next turn)
	session.agent.appendMessage(msg);

	// Persist to session file (survives server restart)
	session.sessionManager.appendMessage(msg);

	return msg;
}

/**
 * Persist an assistant message and broadcast to ALL connected WS clients.
 * Used by the HTTP /api/inject endpoint (external scripts target the default
 * session and broadcast globally — acceptable since /api/inject is a simple
 * fire-and-forget API for cron jobs and local scripts).
 */
export function persistAndBroadcastAll(session: AgentSession, wss: WebSocketServer, text: string): void {
	const msg = persistAssistantMessage(session, text);

	const data = JSON.stringify({ type: "message_start", message: msg });
	const dataEnd = JSON.stringify({ type: "message_end", message: msg });
	for (const client of wss.clients) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(data);
			client.send(dataEnd);
		}
	}
}
