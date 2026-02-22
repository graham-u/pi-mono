/**
 * Assistant WebSocket server.
 *
 * Wraps coding-agent AgentSessions and exposes them over WebSocket.
 * Each WebSocket client independently binds to a session from a shared pool.
 * This is the server-side counterpart to the RemoteAgent adapter in the frontend.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import type { ImageContent, UserMessage } from "@mariozechner/pi-ai";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import { WebSocket, WebSocketServer } from "ws";
import { loadHandlers, persistAssistantMessage, reloadHandlers, runHandlerChain } from "./handlers.js";
import { createHttpHandler } from "./http.js";
import { initVapid } from "./push.js";
import type { ClientMessage, ServerState, SessionInfoDTO, SlashCommandInfo } from "./types.js";

export interface AssistantServerOptions {
	/** Working directory for the agent. Default: process.cwd() */
	cwd?: string;

	/** Port for the WebSocket server. Default: 3001 */
	port?: number;

	/** Optional HTTP server to attach WebSocket to (for serving frontend too) */
	httpServer?: HttpServer;
}

export interface AssistantServer {
	/** The AgentSession created at startup. May become stale if deleted; use for startup checks only. */
	session: AgentSession;

	/** The WebSocket server */
	wss: WebSocketServer;

	/** Stop the server */
	close(): void;
}

/** Tracks which session a WebSocket client is bound to. */
interface ClientBinding {
	sessionPath: string;
	unsubscribe: () => void;
}

/**
 * Create and start the assistant server.
 */
export async function createAssistantServer(options: AssistantServerOptions = {}): Promise<AssistantServer> {
	const cwd = options.cwd ?? process.cwd();
	const port = options.port ?? 3001;

	// Replace project context files (CLAUDE.md, AGENTS.md) with assistant-specific
	// context files from ~/.pi/agent/. SYSTEM.md is handled separately by the SDK.
	// These are read once at startup and baked into the system prompt.
	const agentDir = getAgentDir();
	const contextFileNames = ["USER.md", "ASSISTANT.md"];
	const agentsFiles = contextFileNames
		.map((name) => {
			const filePath = join(agentDir, name);
			if (!existsSync(filePath)) return null;
			return { path: name, content: readFileSync(filePath, "utf-8") };
		})
		.filter((f): f is { path: string; content: string } => f !== null);

	// Initialise push notifications (VAPID keys from .env)
	initVapid();

	// Load input handlers from ~/.pi/agent/handlers/
	let inputHandlers = await loadHandlers();

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		agentsFilesOverride: () => ({ agentsFiles }),
	});
	await resourceLoader.reload();

	// --- Session pool & client bindings ---
	const sessionPool = new Map<string, AgentSession>();
	const clientBindings = new Map<WebSocket, ClientBinding>();

	/** Look up or lazily create a session for a given file path. */
	async function getOrCreateSession(path: string): Promise<AgentSession> {
		const existing = sessionPool.get(path);
		if (existing) return existing;

		const { session: newSession } = await createAgentSession({
			cwd,
			resourceLoader,
			sessionManager: SessionManager.open(path),
		});
		await bindSessionExtensions(newSession);
		sessionPool.set(path, newSession);
		return newSession;
	}

	/** Create a brand-new session and add it to the pool. */
	async function createNewSession(): Promise<AgentSession> {
		const { session: newSession } = await createAgentSession({
			cwd,
			resourceLoader,
			sessionManager: SessionManager.create(cwd),
		});
		await bindSessionExtensions(newSession);
		const key = newSession.sessionFile ?? newSession.sessionId;
		sessionPool.set(key, newSession);
		return newSession;
	}

	/** Bind extensions for a session (same config used for all sessions). */
	async function bindSessionExtensions(session: AgentSession): Promise<void> {
		await session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (opts) => {
					const success = await session.newSession(opts);
					return { cancelled: !success };
				},
				fork: async (entryId) => {
					const result = await session.fork(entryId);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navOpts) => {
					const result = await session.navigateTree(targetId, {
						summarize: navOpts?.summarize,
						customInstructions: navOpts?.customInstructions,
						replaceInstructions: navOpts?.replaceInstructions,
						label: navOpts?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath) => {
					const success = await session.switchSession(sessionPath);
					return { cancelled: !success };
				},
			},
		});
	}

	/**
	 * Bind a client to a session: unsubscribe from old session, subscribe to new,
	 * and send state_sync + messages to this client only.
	 */
	function bindClient(ws: WebSocket, session: AgentSession): void {
		// Unbind from previous session if any
		const oldBinding = clientBindings.get(ws);
		if (oldBinding) {
			oldBinding.unsubscribe();
		}

		const send = (msg: object) => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify(msg));
			}
		};

		// Subscribe to this session's events
		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			send(event);
		});

		const sessionPath = session.sessionFile ?? session.sessionId;
		clientBindings.set(ws, { sessionPath, unsubscribe });

		// Send current state + messages to this client
		send({ type: "state_sync", state: getServerState(session) });
		send({
			type: "response",
			command: "get_messages",
			success: true,
			data: { messages: session.messages },
		});
	}

	/**
	 * Handle a single client message.
	 *
	 * Defined as a closure so it can access the server's shared state
	 * (sessionPool, clientBindings, wss, inputHandlers, etc.) directly.
	 */
	async function handleClientMessage(ws: WebSocket, msg: ClientMessage, send: (msg: object) => void): Promise<void> {
		// Resolve the client's current binding
		const binding = clientBindings.get(ws);
		if (!binding) {
			send({ type: "response", command: msg.type, success: false, error: "Client has no session binding" });
			return;
		}

		// Session-management commands don't require the current session to
		// be in the pool (the bound session may have been deleted).
		switch (msg.type) {
			// =================================================================
			// Session management (no active session required)
			// =================================================================

			case "list_sessions": {
				const sessions = await SessionManager.list(cwd);
				const cacheRetention =
					process.env.PI_CACHE_RETENTION === "long"
						? "long"
						: process.env.PI_CACHE_RETENTION === "none"
							? "none"
							: "short";
				const now = Date.now();
				const data: SessionInfoDTO[] = sessions.map((s) => {
					const dto: SessionInfoDTO = {
						path: s.path,
						id: s.id,
						cwd: s.cwd,
						name: s.name,
						created: s.created.toISOString(),
						modified: s.modified.toISOString(),
						messageCount: s.messageCount,
						firstMessage: s.firstMessage,
					};

					// Compute cache expiry for sessions loaded in the pool
					const pooled = sessionPool.get(s.path);
					if (pooled) {
						const ttl = getCacheTtlMs(pooled.model?.provider, pooled.model?.baseUrl, cacheRetention);
						if (ttl !== null) {
							// Find the last assistant message timestamp
							const msgs = pooled.messages;
							for (let i = msgs.length - 1; i >= 0; i--) {
								const m = msgs[i] as any;
								if (m.role === "assistant" && m.timestamp) {
									const expiresAt = m.timestamp + ttl;
									if (expiresAt > now) {
										dto.cacheExpiresAt = new Date(expiresAt).toISOString();
									}
									break;
								}
							}
						}
					}

					return dto;
				});
				send({
					type: "response",
					command: "list_sessions",
					success: true,
					data: { sessions: data },
				});
				return;
			}

			case "new_session": {
				const newSession = await createNewSession();
				bindClient(ws, newSession);
				send({ type: "response", command: "new_session", success: true });
				return;
			}

			case "switch_session": {
				try {
					const targetSession = await getOrCreateSession(msg.sessionPath);
					bindClient(ws, targetSession);
					send({ type: "response", command: "switch_session", success: true });
				} catch (e: any) {
					send({
						type: "response",
						command: "switch_session",
						success: false,
						error: `Failed to open session: ${e.message}`,
					});
				}
				return;
			}

			case "rename_session": {
				try {
					const targetSession = await getOrCreateSession(msg.sessionPath);
					targetSession.setSessionName(msg.name);
					send({ type: "response", command: "rename_session", success: true });
				} catch (e: any) {
					send({
						type: "response",
						command: "rename_session",
						success: false,
						error: `Failed to rename session: ${e.message}`,
					});
				}
				return;
			}

			case "delete_session": {
				try {
					const result = await deleteSessionFile(msg.sessionPath);
					if (!result.ok) {
						send({
							type: "response",
							command: "delete_session",
							success: false,
							error: `Failed to delete session: ${result.error}`,
						});
						return;
					}

					// Abort streaming and dispose pooled session if any
					const pooled = sessionPool.get(msg.sessionPath);
					if (pooled) {
						if (pooled.isStreaming) {
							await pooled.abort();
						}
						pooled.dispose();
						sessionPool.delete(msg.sessionPath);
					}

					// Find all clients bound to this session and rebind them
					const affectedClients: WebSocket[] = [];
					for (const [client, clientBinding] of clientBindings) {
						if (clientBinding.sessionPath === msg.sessionPath) {
							affectedClients.push(client);
						}
					}

					if (affectedClients.length > 0) {
						// List remaining sessions and pick the most recent, or create new
						const remaining = await SessionManager.list(cwd);
						let targetSession: AgentSession;
						if (remaining.length > 0) {
							targetSession = await getOrCreateSession(remaining[0].path);
						} else {
							targetSession = await createNewSession();
						}
						for (const client of affectedClients) {
							bindClient(client, targetSession);
						}
					}

					send({ type: "response", command: "delete_session", success: true });
				} catch (e: any) {
					send({
						type: "response",
						command: "delete_session",
						success: false,
						error: `Failed to delete session: ${e.message}`,
					});
				}
				return;
			}
		}

		// All remaining commands require a valid session in the pool.
		const session = sessionPool.get(binding.sessionPath);
		if (!session) {
			send({ type: "response", command: msg.type, success: false, error: "Bound session not found in pool" });
			return;
		}

		switch (msg.type) {
			// =================================================================
			// Input (handler chain → fallback to LLM)
			// =================================================================

			case "input": {
				const text = msg.text;

				// Slash commands: route directly without LLM
				if (text.startsWith("/")) {
					await handleCommand(session, text, send);
					return;
				}

				// Input handler chain: first handler to claim the input wins
				if (await runInputHandlers(text, msg.images, session, binding.sessionPath)) {
					send({ type: "response", command: "input", success: true });
					return;
				}

				// Default: send to LLM
				session
					.prompt(text, { images: msg.images, source: "rpc" })
					.catch((e) => send({ type: "response", command: "input", success: false, error: e.message }));
				send({ type: "response", command: "input", success: true });
				return;
			}

			// =================================================================
			// Direct prompt (bypass handler chain)
			// =================================================================

			case "prompt": {
				session
					.prompt(msg.message, {
						images: msg.images,
						streamingBehavior: msg.streamingBehavior,
						source: "rpc",
					})
					.catch((e) => send({ type: "response", command: "prompt", success: false, error: e.message }));
				send({ type: "response", command: "prompt", success: true });
				return;
			}

			// =================================================================
			// Direct command (bypass handler chain)
			// =================================================================

			case "command": {
				await handleCommand(session, msg.text, send);
				return;
			}

			// =================================================================
			// Steering & follow-up
			// =================================================================

			case "steer": {
				await session.steer(msg.message, msg.images);
				send({ type: "response", command: "steer", success: true });
				return;
			}

			case "follow_up": {
				await session.followUp(msg.message, msg.images);
				send({ type: "response", command: "follow_up", success: true });
				return;
			}

			// =================================================================
			// Abort
			// =================================================================

			case "abort": {
				await session.abort();
				send({ type: "response", command: "abort", success: true });
				return;
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				send({ type: "state_sync", state: getServerState(session) });
				return;
			}

			case "get_messages": {
				send({
					type: "response",
					command: "get_messages",
					success: true,
					data: { messages: session.messages },
				});
				return;
			}

			case "get_commands": {
				const commands: SlashCommandInfo[] = [];

				// Extension commands
				for (const { command, extensionPath } of session.extensionRunner?.getRegisteredCommandsWithPaths() ?? []) {
					commands.push({
						name: command.name,
						description: command.description,
						source: "extension",
						path: extensionPath,
					});
				}

				// Prompt templates
				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						location: template.source as SlashCommandInfo["location"],
						path: template.filePath,
					});
				}

				// Skills
				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						location: skill.source as SlashCommandInfo["location"],
						path: skill.filePath,
					});
				}

				send({
					type: "response",
					command: "get_commands",
					success: true,
					data: { commands },
				});
				return;
			}

			// =================================================================
			// Model control
			// =================================================================

			case "set_model": {
				const models = await session.modelRegistry.getAvailable();
				const model = models.find((m) => m.provider === msg.provider && m.id === msg.modelId);
				if (!model) {
					send({
						type: "response",
						command: "set_model",
						success: false,
						error: `Model not found: ${msg.provider}/${msg.modelId}`,
					});
					return;
				}
				await session.setModel(model);
				send({ type: "response", command: "set_model", success: true, data: model });
				send({ type: "state_sync", state: getServerState(session) });
				return;
			}

			case "set_thinking_level": {
				session.setThinkingLevel(msg.level);
				send({ type: "response", command: "set_thinking_level", success: true });
				send({ type: "state_sync", state: getServerState(session) });
				return;
			}

			case "get_available_models": {
				const models = await session.modelRegistry.getAvailable();
				send({
					type: "response",
					command: "get_available_models",
					success: true,
					data: { models },
				});
				return;
			}

			default: {
				const unknownMsg = msg as { type: string };
				send({
					type: "response",
					command: unknownMsg.type,
					success: false,
					error: `Unknown message type: ${unknownMsg.type}`,
				});
			}
		}
	}

	/**
	 * Handle a slash command. Uses closure-captured `inputHandlers` for /reload.
	 */
	async function handleCommand(session: AgentSession, text: string, send: (msg: object) => void): Promise<void> {
		// Strip leading slash
		const withoutSlash = text.startsWith("/") ? text.slice(1) : text;
		const cmdName = withoutSlash.split(" ")[0];
		const cmdArgs = withoutSlash.slice(cmdName.length).trim();

		// 1. Check if it's a skill invocation (/skill:name args)
		if (text.startsWith("/skill:") || text.startsWith("skill:")) {
			// Skills go through the LLM — the session expands the skill content
			session
				.prompt(text, { source: "rpc" })
				.catch((e) => send({ type: "command_result", command: cmdName, success: false, output: e.message }));
			send({ type: "response", command: cmdName, success: true });
			return;
		}

		// 2. Bash shorthand: /bash command or /! command
		if (cmdName === "bash" || cmdName === "!") {
			try {
				const result = await session.executeBash(cmdArgs);
				send({
					type: "command_result",
					command: "bash",
					success: result.exitCode === 0,
					output: result.output,
				});
			} catch (e: any) {
				send({ type: "command_result", command: "bash", success: false, output: e.message });
			}
			return;
		}

		// 3. Built-in commands mapped to AgentSession API
		if (cmdName === "reload") {
			try {
				await session.reload();
				inputHandlers = await reloadHandlers();
				const parts = ["Reloaded extensions, skills, prompts, and themes."];
				if (inputHandlers.length > 0) {
					parts.push(`${inputHandlers.length} input handler${inputHandlers.length === 1 ? "" : "s"} loaded.`);
				}
				send({
					type: "command_result",
					command: "reload",
					success: true,
					output: parts.join(" "),
				});
				send({ type: "state_sync", state: getServerState(session) });
			} catch (e: any) {
				send({ type: "command_result", command: "reload", success: false, output: e.message });
			}
			return;
		}

		if (cmdName === "compact") {
			try {
				const result = await session.compact(cmdArgs || undefined);
				send({
					type: "command_result",
					command: "compact",
					success: true,
					output: `Compacted session (${result.tokensBefore.toLocaleString()} tokens before compaction).`,
				});
				send({ type: "state_sync", state: getServerState(session) });
			} catch (e: any) {
				send({ type: "command_result", command: "compact", success: false, output: e.message });
			}
			return;
		}

		if (cmdName === "name") {
			if (!cmdArgs) {
				send({
					type: "command_result",
					command: "name",
					success: false,
					output: "Usage: /name <session name>",
				});
				return;
			}
			try {
				session.setSessionName(cmdArgs);
				send({
					type: "command_result",
					command: "name",
					success: true,
					output: `Session renamed to "${cmdArgs}".`,
				});
				send({ type: "state_sync", state: getServerState(session) });
			} catch (e: any) {
				send({ type: "command_result", command: "name", success: false, output: e.message });
			}
			return;
		}

		if (cmdName === "session") {
			const stats = session.getSessionStats();
			const lines = [
				`Session: ${session.sessionName ?? session.sessionId}`,
				`Messages: ${stats.totalMessages} (${stats.userMessages} user, ${stats.assistantMessages} assistant)`,
				`Tool calls: ${stats.toolCalls}`,
				`Tokens: ${stats.tokens.input.toLocaleString()} in / ${stats.tokens.output.toLocaleString()} out`,
				`Cache: ${stats.tokens.cacheRead.toLocaleString()} read / ${stats.tokens.cacheWrite.toLocaleString()} write`,
				`Cost: $${stats.cost.toFixed(4)}`,
			];
			send({ type: "command_result", command: "session", success: true, output: lines.join("\n") });
			return;
		}

		if (cmdName === "export") {
			try {
				const outputPath = await session.exportToHtml(cmdArgs || undefined);
				send({
					type: "command_result",
					command: "export",
					success: true,
					output: `Exported to ${outputPath}`,
				});
			} catch (e: any) {
				send({ type: "command_result", command: "export", success: false, output: e.message });
			}
			return;
		}

		// 4. Prompt templates — check if the command name matches a prompt template
		const template = session.promptTemplates.find((t) => t.name === cmdName);
		if (template) {
			// Expand and send through LLM
			session
				.prompt(text, { source: "rpc" })
				.catch((e) => send({ type: "command_result", command: cmdName, success: false, output: e.message }));
			send({ type: "response", command: cmdName, success: true });
			return;
		}

		// 5. Extension commands — check if an extension registered this command
		const extCommand = session.extensionRunner?.getCommand(cmdName);
		if (extCommand) {
			try {
				const ctx = session.extensionRunner!.createCommandContext();
				// Intercept notify() to capture output for the WebSocket client
				const outputLines: string[] = [];
				let hadError = false;
				ctx.ui = {
					...ctx.ui,
					notify: (message: string, type?: "info" | "warning" | "error") => {
						outputLines.push(message);
						if (type === "error") hadError = true;
					},
				};
				await extCommand.handler(cmdArgs, ctx);
				send({
					type: "command_result",
					command: cmdName,
					success: !hadError,
					output: outputLines.join("\n"),
				});
			} catch (e: any) {
				send({
					type: "command_result",
					command: cmdName,
					success: false,
					output: e.message ?? String(e),
				});
			}
			return;
		}

		// 6. Unknown command
		send({
			type: "command_result",
			command: cmdName,
			success: false,
			output: `Unknown command: ${cmdName}. Type a message to chat with the AI.`,
		});
	}

	/**
	 * Run the input handler chain with session-scoped persistence and broadcast.
	 * Returns true if a handler claimed the input.
	 *
	 * When a handler claims input, the user's message is persisted and broadcast
	 * to clients viewing this session (normally session.prompt() does this, but
	 * handlers bypass the LLM). The user message is lazily persisted on first
	 * reply() call, ensuring it appears before the handler's response.
	 */
	async function runInputHandlers(
		text: string,
		images: ImageContent[] | undefined,
		session: AgentSession,
		sessionPath: string,
	): Promise<boolean> {
		if (inputHandlers.length === 0) return false;

		// Broadcast message_start + message_end to clients viewing this session.
		const broadcastToSession = (message: object) => {
			const data = JSON.stringify({ type: "message_start", message });
			const dataEnd = JSON.stringify({ type: "message_end", message });
			for (const [client, cb] of clientBindings) {
				if (cb.sessionPath === sessionPath && client.readyState === WebSocket.OPEN) {
					client.send(data);
					client.send(dataEnd);
				}
			}
		};

		// Lazily persist and broadcast the user message on first call.
		// When a handler claims input we bypass session.prompt(), so the user
		// message must be added manually. Lazy so it only happens when a handler
		// actually claims the input (if none do, session.prompt() adds its own).
		let userMessagePersisted = false;
		const persistUserMessage = () => {
			if (userMessagePersisted) return;
			userMessagePersisted = true;
			const userMsg: UserMessage = {
				role: "user",
				content: images?.length ? [{ type: "text", text }, ...images] : [{ type: "text", text }],
				timestamp: Date.now(),
			};
			session.agent.appendMessage(userMsg);
			session.sessionManager.appendMessage(userMsg);
			broadcastToSession(userMsg);
		};

		// Reply callback: ensures user message appears first, then persists and
		// broadcasts the assistant reply — scoped to this session's clients only.
		const reply = (replyText: string) => {
			persistUserMessage();
			const injected = persistAssistantMessage(session, replyText);
			broadcastToSession(injected);
		};

		const result = await runHandlerChain(text, images, session, reply, inputHandlers);
		if (result.handled) {
			// Ensure user message appears even if handler claimed input without
			// calling reply() (e.g. a handler that silently consumes input).
			persistUserMessage();
			return true;
		}
		return false;
	}

	// Create the initial session (resume most recent)
	const { session: initialSession, modelFallbackMessage } = await createAgentSession({
		cwd,
		resourceLoader,
		sessionManager: SessionManager.continueRecent(cwd),
	});
	await bindSessionExtensions(initialSession);
	const initialSessionPath = initialSession.sessionFile ?? initialSession.sessionId;
	sessionPool.set(initialSessionPath, initialSession);

	/** Return the initial session if still alive, otherwise the first available pooled session. */
	function getActiveSession(): AgentSession {
		// Prefer the initial session if still in the pool
		const initial = sessionPool.get(initialSessionPath);
		if (initial) return initial;
		// Otherwise pick the first available pooled session
		for (const s of sessionPool.values()) return s;
		// Should not happen — createNewSession is called during delete cleanup
		throw new Error("No sessions in pool");
	}

	// Create WebSocket server. In standalone mode, wrap in an HTTP server so we
	// can serve REST endpoints (e.g. /api/inject) on the same port.
	let httpServer: HttpServer | undefined;
	let wss: WebSocketServer;

	if (options.httpServer) {
		wss = new WebSocketServer({ server: options.httpServer });
	} else {
		httpServer = createServer();
		wss = new WebSocketServer({ server: httpServer });
		httpServer.on(
			"request",
			createHttpHandler(() => getActiveSession(), wss),
		);
		httpServer.listen(port);
	}

	wss.on("connection", async (ws) => {
		console.log("[assistant-server] Client connected");

		// Bind to the most recent active session (may differ from initial
		// session if it was deleted after server startup).
		let activeSession: AgentSession;
		try {
			activeSession = getActiveSession();
		} catch {
			activeSession = await createNewSession();
		}
		bindClient(ws, activeSession);

		// If model couldn't be resolved, notify client
		if (modelFallbackMessage) {
			const send = (msg: object) => {
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify(msg));
				}
			};
			send({
				type: "command_result",
				command: "init",
				success: false,
				output: modelFallbackMessage,
			});
		}

		ws.on("message", async (data) => {
			const send = (msg: object) => {
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify(msg));
				}
			};
			try {
				const msg: ClientMessage = JSON.parse(data.toString());
				await handleClientMessage(ws, msg, send);
			} catch (e: any) {
				send({
					type: "response",
					command: "parse",
					success: false,
					error: `Failed to parse message: ${e.message}`,
				});
			}
		});

		ws.on("close", () => {
			console.log("[assistant-server] Client disconnected");
			const binding = clientBindings.get(ws);
			if (binding) {
				binding.unsubscribe();
				clientBindings.delete(ws);
			}
		});

		ws.on("error", (err) => {
			console.error("[assistant-server] WebSocket error:", err.message);
		});
	});

	if (!options.httpServer) {
		console.log(`[assistant-server] Listening on http://localhost:${port} (HTTP + WebSocket)`);
	}

	return {
		session: initialSession,
		wss,
		close() {
			wss.close();
			httpServer?.close();
			for (const session of sessionPool.values()) {
				session.dispose();
			}
		},
	};
}

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink.
 * Duplicated from the TUI's session-selector (no shared/exported delete API exists).
 */
async function deleteSessionFile(
	sessionPath: string,
): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	// If trash reports success, or the file is gone afterwards, treat it as successful
	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return { ok: true, method: "trash" };
	}

	// Fallback to permanent deletion
	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashHint = trashResult.error?.message || trashResult.stderr?.trim().split("\n")[0];
		const error = trashHint ? `${unlinkError} (trash: ${trashHint})` : unlinkError;
		return { ok: false, method: "unlink", error };
	}
}

/**
 * Get the cache TTL in milliseconds for a given provider and retention setting.
 * Returns null if the provider doesn't support prompt caching.
 */
function getCacheTtlMs(provider: string | undefined, baseUrl: string | undefined, retention: string): number | null {
	if (retention === "none") return null;
	if (provider === "anthropic") {
		// Mirrors the upstream check in anthropic.ts getCacheControl():
		// the 1-hour TTL is only sent when hitting api.anthropic.com directly.
		if (retention === "long" && baseUrl?.includes("api.anthropic.com")) return 3600000;
		return 300000;
	}
	if (provider === "amazon-bedrock") {
		return retention === "long" ? 3600000 : 300000;
	}
	if (provider === "openai") {
		return retention === "long" ? 86400000 : null;
	}
	return null;
}

/**
 * Get the current server state for sync.
 */
function getServerState(session: AgentSession): ServerState {
	return {
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		sessionPath: session.sessionFile,
		messageCount: session.messages.length,
		pendingMessageCount: session.pendingMessageCount,
	};
}
