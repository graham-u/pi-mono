/**
 * Pi Assistant — Web frontend for local coding-agent backend.
 *
 * Structurally follows packages/web-ui/example/ but replaces the local Agent
 * with a RemoteAgent that proxies to the assistant server over WebSocket.
 */

import "@mariozechner/mini-lit/dist/ThemeToggle.js";

import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import {
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	IndexedDBStorageBackend,
	ProviderKeysStore,
	ProvidersModelsTab,
	ProxyTab,
	SessionsStore,
	SettingsDialog,
	SettingsStore,
	setAppStorage,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { Settings } from "lucide";
import "./app.css";

import { type ConnectionState, RemoteAgent } from "./remote-agent.js";

// ============================================================================
// Store Setup (required by pi-web-ui components)
// ============================================================================

const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

const configs = [
	settings.getConfig(),
	SessionsStore.getMetadataConfig(),
	providerKeys.getConfig(),
	customProviders.getConfig(),
	sessions.getConfig(),
];

const backend = new IndexedDBStorageBackend({
	dbName: "pi-assistant",
	version: 2,
	stores: configs,
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);

// ============================================================================
// State
// ============================================================================

let chatPanel: ChatPanel;
let agent: RemoteAgent;
let connectionState: ConnectionState = "disconnected";

// ============================================================================
// Determine WebSocket URL
// ============================================================================

function getWsUrl(): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

	// In dev mode, Vite proxies /ws to the backend server.
	// This works both on localhost:3000 and via Tailscale/reverse proxy.
	return `${protocol}//${window.location.host}/ws`;
}

// ============================================================================
// Render
// ============================================================================

function renderApp() {
	const app = document.getElementById("app");
	if (!app) return;

	const statusColor =
		connectionState === "connected"
			? "text-green-500"
			: connectionState === "connecting" || connectionState === "reconnecting"
				? "text-yellow-500"
				: "text-red-500";

	const statusText =
		connectionState === "connected"
			? "Connected"
			: connectionState === "connecting"
				? "Connecting..."
				: connectionState === "reconnecting"
					? "Reconnecting..."
					: connectionState === "error"
						? "Connection failed"
						: "Disconnected";

	const appHtml = html`
		<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-2 px-4 py-2">
					<span class="text-base font-semibold text-foreground">Pi Assistant</span>
					<span class="text-xs ${statusColor}">${statusText}</span>
				</div>
				<div class="flex items-center gap-1 px-2">
					<theme-toggle></theme-toggle>
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: () => SettingsDialog.open([new ProvidersModelsTab(), new ProxyTab()]),
						title: "Settings",
					})}
				</div>
			</div>

			<!-- Chat Panel -->
			${chatPanel}
		</div>
	`;

	render(appHtml, app);
}

// ============================================================================
// Initialize
// ============================================================================

async function initApp() {
	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	// Loading state
	render(
		html`
			<div class="w-full h-screen flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground">Connecting to server...</div>
			</div>
		`,
		app,
	);

	// Create ChatPanel
	chatPanel = new ChatPanel();

	// Create RemoteAgent and connect
	const wsUrl = getWsUrl();
	agent = new RemoteAgent(wsUrl);

	// Track connection state
	agent.onConnectionChange((state) => {
		connectionState = state;
		renderApp();
	});

	try {
		await agent.connect();
	} catch (e) {
		console.error("Failed to connect to server:", e);
		connectionState = "error";
		render(
			html`
				<div class="w-full h-screen flex items-center justify-center bg-background text-foreground">
					<div class="text-center">
						<div class="text-destructive text-lg mb-2">Failed to connect</div>
						<div class="text-muted-foreground text-sm mb-4">
							Make sure the assistant server is running on ${wsUrl}
						</div>
						<button
							class="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90"
							@click=${() => window.location.reload()}
						>
							Retry
						</button>
					</div>
				</div>
			`,
			app,
		);
		return;
	}

	// Seed a dummy API key so AgentInterface's sendMessage() doesn't block.
	// The real key lives on the server; this just bypasses the browser-side check.
	const model = agent.state?.model;
	if (model) {
		await storage.providerKeys.set(model.provider, "backend-managed");
	}

	// Wire up ChatPanel with the RemoteAgent
	await chatPanel.setAgent(agent as any, {
		// API keys are on the server — always allow sending
		onApiKeyRequired: async (provider: string) => {
			// Seed the key for this provider so future checks pass
			await storage.providerKeys.set(provider, "backend-managed");
			return true;
		},
		// No local tools — tools are on the server
	});

	renderApp();
}

initApp();
