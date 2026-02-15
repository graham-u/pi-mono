/**
 * WebSocket protocol types for the assistant server.
 *
 * Based on the coding-agent's RPC protocol, adapted for WebSocket transport.
 */

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ImageContent, Model } from "@mariozechner/pi-ai";

// ============================================================================
// Client → Server Messages
// ============================================================================

export type ClientMessage =
	// Raw user input — server runs handler chain, then falls back to LLM
	| { type: "input"; text: string; images?: ImageContent[] }

	// Direct prompt (bypasses handler chain)
	| { type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }

	// Direct command (bypasses handler chain)
	| { type: "command"; text: string }

	// Interrupt agent mid-run
	| { type: "steer"; message: string; images?: ImageContent[] }

	// Queue for after current run
	| { type: "follow_up"; message: string; images?: ImageContent[] }

	// Cancel current operation
	| { type: "abort" }

	// State queries
	| { type: "get_state" }
	| { type: "get_messages" }
	| { type: "get_commands" }

	// Model control
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "set_thinking_level"; level: ThinkingLevel }
	| { type: "get_available_models" }

	// Session management
	| { type: "list_sessions" }
	| { type: "new_session" }
	| { type: "switch_session"; sessionPath: string }
	| { type: "rename_session"; sessionPath: string; name: string }
	| { type: "delete_session"; sessionPath: string };

// ============================================================================
// Server → Client Messages
// ============================================================================

export type ServerMessage =
	// Command responses
	| { type: "command_result"; command: string; success: boolean; output: string }

	// State sync
	| { type: "state_sync"; state: ServerState }

	// Query responses
	| { type: "response"; command: string; success: boolean; data?: any; error?: string }

	// Agent session events are forwarded directly (AgentSessionEvent types)
	// They include: agent_start, agent_end, turn_start, turn_end,
	// message_start, message_update, message_end,
	// tool_execution_start, tool_execution_update, tool_execution_end,
	// auto_compaction_start, auto_compaction_end,
	// auto_retry_start, auto_retry_end
	| { type: string; [key: string]: any };

// ============================================================================
// Server State
// ============================================================================

export interface ServerState {
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionId: string;
	sessionName?: string;
	sessionPath?: string;
	messageCount: number;
	pendingMessageCount: number;
}

// ============================================================================
// Session Info (wire format — dates as ISO strings)
// ============================================================================

export interface SessionInfoDTO {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
	cacheExpiresAt?: string;
}

// ============================================================================
// Slash Command Info
// ============================================================================

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	location?: "user" | "project" | "path";
	path?: string;
}
