/**
 * Assistant WebSocket server.
 *
 * Wraps coding-agent AgentSessions and exposes them over WebSocket.
 * Each WebSocket client independently binds to a session from a shared pool.
 * This is the server-side counterpart to the RemoteAgent adapter in the frontend.
 */

import { createServer, type Server as HttpServer } from "node:http";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import { WebSocket, WebSocketServer } from "ws";
import { createHttpHandler } from "./http.js";
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
	/** The default AgentSession (created at startup) */
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

	// Create a resource loader that skips project context files (CLAUDE.md, AGENTS.md).
	// The assistant's behavior is controlled by ~/.pi/agent/SYSTEM.md, not project files.
	// This is shared across all sessions (stateless).
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		agentsFilesOverride: () => ({ agentsFiles: [] }),
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

	// Create the default session (resume most recent)
	const { session: defaultSession, modelFallbackMessage } = await createAgentSession({
		cwd,
		resourceLoader,
		sessionManager: SessionManager.continueRecent(cwd),
	});
	await bindSessionExtensions(defaultSession);
	const defaultSessionPath = defaultSession.sessionFile ?? defaultSession.sessionId;
	sessionPool.set(defaultSessionPath, defaultSession);

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
			createHttpHandler(() => defaultSession, wss),
		);
		httpServer.listen(port);
	}

	wss.on("connection", (ws) => {
		console.log("[assistant-server] Client connected");

		// Bind to the default session
		bindClient(ws, defaultSession);

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
				await handleClientMessage(
					ws,
					msg,
					send,
					cwd,
					clientBindings,
					sessionPool,
					getOrCreateSession,
					createNewSession,
					bindClient,
				);
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
		session: defaultSession,
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
 * Handle a single client message.
 */
async function handleClientMessage(
	ws: WebSocket,
	msg: ClientMessage,
	send: (msg: object) => void,
	cwd: string,
	clientBindings: Map<WebSocket, ClientBinding>,
	sessionPool: Map<string, AgentSession>,
	getOrCreateSession: (path: string) => Promise<AgentSession>,
	createNewSession: () => Promise<AgentSession>,
	bindClient: (ws: WebSocket, session: AgentSession) => void,
): Promise<void> {
	// Resolve the client's current session
	const binding = clientBindings.get(ws);
	if (!binding) {
		send({ type: "response", command: msg.type, success: false, error: "Client has no session binding" });
		return;
	}
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

		// =================================================================
		// Session management
		// =================================================================

		case "list_sessions": {
			const sessions = await SessionManager.list(cwd);
			const data: SessionInfoDTO[] = sessions.map((s) => ({
				path: s.path,
				id: s.id,
				cwd: s.cwd,
				name: s.name,
				created: s.created.toISOString(),
				modified: s.modified.toISOString(),
				messageCount: s.messageCount,
				firstMessage: s.firstMessage,
			}));
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
 * Handle a slash command.
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

	// 5. Unknown command
	send({
		type: "command_result",
		command: cmdName,
		success: false,
		output: `Unknown command: ${cmdName}. Type a message to chat with the AI.`,
	});
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
