/**
 * RemoteAgent — implements the Agent interface but proxies everything
 * to a backend server over WebSocket.
 *
 * This is the bridge between pi-web-ui components (which expect an Agent)
 * and the assistant server (which wraps the coding-agent SDK).
 */

import { Agent, type AgentEvent, type AgentMessage, type AgentState, type AgentTool, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getModel, type ImageContent, type Model, streamSimple } from "@mariozechner/pi-ai";

/** Connection state */
export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

/** Connection state change listener */
export type ConnectionListener = (state: ConnectionState, error?: string) => void;

/**
 * RemoteAgent extends Agent for type compatibility with pi-web-ui components.
 * All LLM calls and tool execution happen on the server — this adapter just
 * proxies actions over WebSocket and reflects server state locally.
 */
export class RemoteAgent extends Agent {
	private wsUrl: string;
	private ws: WebSocket | null = null;
	private _connectionState: ConnectionState = "disconnected";
	private connectionListeners = new Set<ConnectionListener>();

	// Our own state, independent of the parent Agent's private _state
	private _remoteState: AgentState = {
		systemPrompt: "",
		model: getModel("google", "gemini-2.5-flash-lite-preview-06-17"),
		thinkingLevel: "off" as ThinkingLevel,
		tools: [],
		messages: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Set<string>(),
	};

	// Our own listener set, independent of parent Agent
	private _remoteListeners = new Set<(e: AgentEvent) => void>();

	constructor(wsUrl: string) {
		// Call parent constructor with minimal config
		super({
			getApiKey: async () => "backend-managed",
		});

		this.wsUrl = wsUrl;

		// Override streamFn so AgentInterface won't replace it with proxy logic
		this.streamFn = ((..._args: any[]) => {
			throw new Error("LLM calls are handled by the server");
		}) as any;

		// Set getApiKey to return a truthy value so the API key check passes
		this.getApiKey = async () => "backend-managed";
	}

	// =========================================================================
	// State — override to use our remote-synced state
	// =========================================================================

	override get state(): AgentState {
		return this._remoteState;
	}

	get connectionState(): ConnectionState {
		return this._connectionState;
	}

	// =========================================================================
	// Subscription — override to use our own listener set
	// =========================================================================

	override subscribe(fn: (e: AgentEvent) => void): () => void {
		this._remoteListeners.add(fn);
		return () => this._remoteListeners.delete(fn);
	}

	/** Subscribe to connection state changes */
	onConnectionChange(fn: ConnectionListener): () => void {
		this.connectionListeners.add(fn);
		return () => this.connectionListeners.delete(fn);
	}

	// =========================================================================
	// Actions — override to send over WebSocket
	// =========================================================================

	override async prompt(input: string | AgentMessage | AgentMessage[]): Promise<void> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("Not connected to server");
		}

		const text = typeof input === "string" ? input : this.extractText(input);
		this.send({ type: "input", text });
	}

	override abort(): void {
		this.send({ type: "abort" });
	}

	override setModel(m: Model<any>): void {
		this._remoteState.model = m;
		this.send({ type: "set_model", provider: m.provider, modelId: m.id });
	}

	override setThinkingLevel(l: ThinkingLevel): void {
		this._remoteState.thinkingLevel = l;
		this.send({ type: "set_thinking_level", level: l });
	}

	override steer(m: AgentMessage): void {
		const text = this.extractText(m);
		this.send({ type: "steer", message: text });
	}

	override followUp(m: AgentMessage): void {
		const text = this.extractText(m);
		this.send({ type: "follow_up", message: text });
	}

	override setTools(_t: AgentTool<any>[]): void {
		// Tools are managed server-side; this is a no-op
	}

	// =========================================================================
	// Connection Management
	// =========================================================================

	/** Connect to the server */
	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.setConnectionState("connecting");

			this.ws = new WebSocket(this.wsUrl);

			this.ws.onopen = () => {
				this.setConnectionState("connected");
				resolve();
			};

			this.ws.onclose = () => {
				this.setConnectionState("disconnected");
			};

			this.ws.onerror = (event) => {
				console.error("[RemoteAgent] WebSocket error:", event);
				if (this._connectionState === "connecting") {
					this.setConnectionState("error", "Failed to connect");
					reject(new Error("Failed to connect to server"));
				} else {
					this.setConnectionState("error", "Connection error");
				}
			};

			this.ws.onmessage = (event) => {
				try {
					const msg = JSON.parse(event.data);
					this.handleServerMessage(msg);
				} catch (e) {
					console.error("[RemoteAgent] Failed to parse server message:", e);
				}
			};
		});
	}

	/** Disconnect from the server */
	disconnect(): void {
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}

	/** Request available models from the server */
	requestAvailableModels(): void {
		this.send({ type: "get_available_models" });
	}

	/** Request available commands from the server */
	requestCommands(): void {
		this.send({ type: "get_commands" });
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private send(msg: object): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	private setConnectionState(state: ConnectionState, error?: string): void {
		this._connectionState = state;
		for (const fn of this.connectionListeners) {
			fn(state, error);
		}
	}

	/**
	 * Handle a message from the server.
	 * Events from AgentSession are forwarded directly — we update local state
	 * and re-emit them so the UI components react.
	 */
	private handleServerMessage(msg: any): void {
		switch (msg.type) {
			// =============================================================
			// State sync (bulk update from server)
			// =============================================================
			case "state_sync":
				this.applyStateSync(msg.state);
				break;

			// =============================================================
			// Agent lifecycle events — update local state and emit
			// =============================================================
			case "agent_start":
				this._remoteState = { ...this._remoteState, isStreaming: true };
				this.emitEvent(msg);
				break;

			case "agent_end":
				this._remoteState = {
					...this._remoteState,
					isStreaming: false,
					streamMessage: null,
					pendingToolCalls: new Set(),
					messages: msg.messages ?? this._remoteState.messages,
				};
				this.emitEvent(msg);
				break;

			// =============================================================
			// Turn lifecycle
			// =============================================================
			case "turn_start":
				this.emitEvent(msg);
				break;

			case "turn_end":
				// The turn_end message contains the final assistant message
				if (msg.message) {
					const messages = [...this._remoteState.messages];
					// Check if this message is already in the list (from message_end)
					const lastMsg = messages[messages.length - 1];
					if (!lastMsg || lastMsg !== msg.message) {
						// Don't add duplicates — message_end already added it
					}
					this._remoteState = { ...this._remoteState, messages };
				}
				this.emitEvent(msg);
				break;

			// =============================================================
			// Message lifecycle
			// =============================================================
			case "message_start":
				if (msg.message?.role === "assistant") {
					this._remoteState = { ...this._remoteState, streamMessage: msg.message };
				} else if (msg.message) {
					// User messages or other types — add to messages
					this._remoteState = {
						...this._remoteState,
						messages: [...this._remoteState.messages, msg.message],
					};
				}
				this.emitEvent(msg);
				break;

			case "message_update":
				if (msg.message) {
					this._remoteState = { ...this._remoteState, streamMessage: msg.message };
				}
				this.emitEvent(msg);
				break;

			case "message_end":
				if (msg.message) {
					this._remoteState = {
						...this._remoteState,
						messages: [...this._remoteState.messages, msg.message],
						streamMessage: null,
					};
				}
				this.emitEvent(msg);
				break;

			// =============================================================
			// Tool execution
			// =============================================================
			case "tool_execution_start": {
				const pending = new Set(this._remoteState.pendingToolCalls);
				pending.add(msg.toolCallId);
				this._remoteState = { ...this._remoteState, pendingToolCalls: pending };
				this.emitEvent(msg);
				break;
			}

			case "tool_execution_update":
				this.emitEvent(msg);
				break;

			case "tool_execution_end": {
				const pending = new Set(this._remoteState.pendingToolCalls);
				pending.delete(msg.toolCallId);
				this._remoteState = { ...this._remoteState, pendingToolCalls: pending };
				this.emitEvent(msg);
				break;
			}

			// =============================================================
			// Auto-compaction / retry events
			// =============================================================
			case "auto_compaction_start":
			case "auto_compaction_end":
			case "auto_retry_start":
			case "auto_retry_end":
				this.emitEvent(msg);
				break;

			// =============================================================
			// Command results
			// =============================================================
			case "command_result":
				// Add as a system message so it appears in the chat
				console.log(`[RemoteAgent] Command result (${msg.command}):`, msg.output);
				break;

			// =============================================================
			// Response to queries
			// =============================================================
			case "response":
				this.handleQueryResponse(msg);
				break;

			default:
				// Forward unknown events
				console.log("[RemoteAgent] Unknown server message:", msg.type);
				break;
		}
	}

	/**
	 * Apply a bulk state sync from the server.
	 */
	private applyStateSync(serverState: any): void {
		if (serverState.model) {
			this._remoteState = { ...this._remoteState, model: serverState.model };
		}
		if (serverState.thinkingLevel !== undefined) {
			this._remoteState = { ...this._remoteState, thinkingLevel: serverState.thinkingLevel };
		}
		if (serverState.isStreaming !== undefined) {
			this._remoteState = { ...this._remoteState, isStreaming: serverState.isStreaming };
		}
		// Trigger a re-render
		this.emitEvent({ type: "agent_start" } as any);
		this.emitEvent({ type: "agent_end", messages: this._remoteState.messages } as any);
	}

	/**
	 * Handle query response messages.
	 */
	private handleQueryResponse(msg: any): void {
		if (!msg.success) {
			console.error(`[RemoteAgent] Command '${msg.command}' failed:`, msg.error);
			return;
		}

		switch (msg.command) {
			case "get_available_models":
				// Could dispatch to a models listener
				console.log("[RemoteAgent] Available models:", msg.data?.models?.length);
				break;

			case "get_messages":
				if (msg.data?.messages) {
					this._remoteState = { ...this._remoteState, messages: msg.data.messages };
				}
				break;

			case "set_model":
				if (msg.data) {
					this._remoteState = { ...this._remoteState, model: msg.data };
				}
				break;

			default:
				break;
		}
	}

	/**
	 * Emit an event to all subscribers.
	 */
	private emitEvent(event: AgentEvent): void {
		for (const fn of this._remoteListeners) {
			fn(event);
		}
	}

	/**
	 * Extract text content from an AgentMessage.
	 */
	private extractText(input: AgentMessage | AgentMessage[]): string {
		if (Array.isArray(input)) {
			return input.map((m) => this.extractTextFromMessage(m)).join("\n");
		}
		return this.extractTextFromMessage(input);
	}

	private extractTextFromMessage(msg: AgentMessage): string {
		if (typeof msg === "string") return msg;
		if ("content" in msg) {
			const content = msg.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				return content
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n");
			}
		}
		return JSON.stringify(msg);
	}
}
