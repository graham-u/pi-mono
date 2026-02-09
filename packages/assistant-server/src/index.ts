/**
 * @mariozechner/pi-assistant-server
 *
 * WebSocket server that wraps the pi-coding-agent SDK.
 * Used by the assistant frontend to communicate with the agent.
 */

export { type AssistantServer, type AssistantServerOptions, createAssistantServer } from "./server.js";
export type { ClientMessage, ServerMessage, ServerState, SlashCommandInfo } from "./types.js";
