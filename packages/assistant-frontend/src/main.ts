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
import { html, nothing, render } from "lit";
import { Menu, MessageSquare, Pencil, Plus, Settings, X } from "lucide";
import "./app.css";

import { type ConnectionState, RemoteAgent, type SessionInfoDTO } from "./remote-agent.js";

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
let sessionList: SessionInfoDTO[] = [];
let sidebarOpen = false;
let renamingSessionPath: string | null = null;
let renameValue = "";

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
// Session helpers
// ============================================================================

async function refreshSessionList(): Promise<void> {
	try {
		sessionList = await agent.listSessions();
	} catch (e) {
		console.error("Failed to list sessions:", e);
	}
}

function formatSessionDate(isoDate: string): string {
	const date = new Date(isoDate);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

	if (diffDays === 0) {
		return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}
	if (diffDays === 1) return "Yesterday";
	if (diffDays < 7) return `${diffDays}d ago`;
	return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen)}...`;
}

async function handleNewSession(): Promise<void> {
	await agent.newSession();
	await refreshSessionList();
	sidebarOpen = false;
	renderApp();
}

async function handleSwitchSession(sessionPath: string): Promise<void> {
	if (sessionPath === agent.sessionPath) {
		sidebarOpen = false;
		renderApp();
		return;
	}
	await agent.switchSession(sessionPath);
	await refreshSessionList();
	sidebarOpen = false;
	renderApp();
}

function startRename(sessionPath: string, currentName: string): void {
	renamingSessionPath = sessionPath;
	renameValue = currentName;
	renderApp();
	// Focus the input after render
	requestAnimationFrame(() => {
		const input = document.getElementById("rename-input") as HTMLInputElement | null;
		if (input) {
			input.focus();
			input.select();
		}
	});
}

async function commitRename(): Promise<void> {
	const path = renamingSessionPath;
	const name = renameValue.trim();
	renamingSessionPath = null;
	renameValue = "";
	if (path && name) {
		await agent.renameSession(path, name);
		await refreshSessionList();
	}
	renderApp();
}

function cancelRename(): void {
	renamingSessionPath = null;
	renameValue = "";
	renderApp();
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

	const currentPath = agent?.sessionPath;

	const sidebarContent = html`
		<div class="flex flex-col h-full">
			<!-- New Chat button -->
			<div class="p-3 border-b border-border shrink-0">
				${Button({
					variant: "outline",
					size: "sm",
					children: html`<span class="flex items-center gap-2">${icon(Plus, "sm")} New Chat</span>`,
					onClick: () => handleNewSession(),
					className: "w-full justify-center",
				})}
			</div>

			<!-- Session list -->
			<div class="flex-1 overflow-y-auto">
				${
					sessionList.length === 0
						? html`<div class="p-4 text-sm text-muted-foreground text-center">No sessions</div>`
						: sessionList.map((s) => {
								const isActive = s.path === currentPath;
								const isRenaming = renamingSessionPath === s.path;
								const displayName = s.name || truncate(s.firstMessage, 40) || "Empty session";

								return html`
						<button
							class="w-full text-left px-3 py-2.5 border-b border-border/50 hover:bg-muted/50 transition-colors ${isActive ? "bg-muted" : ""}"
							@click=${() => {
								if (!isRenaming) handleSwitchSession(s.path);
							}}
						>
							<div class="flex items-start gap-2">
								<span class="mt-0.5 shrink-0 text-muted-foreground">${icon(MessageSquare, "xs")}</span>
								<div class="min-w-0 flex-1">
									${
										isRenaming
											? html`<input
											id="rename-input"
											type="text"
											class="text-sm w-full bg-background border border-border rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-ring"
											.value=${renameValue}
											@input=${(e: InputEvent) => {
												renameValue = (e.target as HTMLInputElement).value;
											}}
											@keydown=${(e: KeyboardEvent) => {
												if (e.key === "Enter") {
													e.preventDefault();
													commitRename();
												}
												if (e.key === "Escape") {
													e.preventDefault();
													cancelRename();
												}
											}}
											@blur=${() => commitRename()}
											@click=${(e: Event) => e.stopPropagation()}
										/>`
											: html`<div class="flex items-center gap-1">
											<div class="text-sm truncate flex-1">${displayName}</div>
											${
												isActive
													? html`<button
													class="shrink-0 p-0.5 rounded hover:bg-muted-foreground/20 text-muted-foreground"
													title="Rename session"
													@click=${(e: Event) => {
														e.stopPropagation();
														startRename(s.path, displayName);
													}}
												>${icon(Pencil, "xs")}</button>`
													: nothing
											}
										</div>`
									}
									<div class="flex items-center gap-2 mt-0.5">
										<span class="text-xs text-muted-foreground">${formatSessionDate(s.modified)}</span>
										<span class="text-xs text-muted-foreground">${s.messageCount} msg${s.messageCount !== 1 ? "s" : ""}</span>
									</div>
								</div>
							</div>
						</button>
					`;
							})
				}
			</div>
		</div>
	`;

	const appHtml = html`
		<div class="w-full h-screen flex bg-background text-foreground overflow-hidden">
			<!-- Sidebar: desktop (always visible) -->
			<div class="hidden md:flex w-[260px] shrink-0 flex-col border-r border-border bg-background">
				${sidebarContent}
			</div>

			<!-- Sidebar: mobile overlay -->
			${
				sidebarOpen
					? html`
					<!-- Backdrop -->
					<div
						class="md:hidden fixed inset-0 bg-black/40 z-40"
						@click=${() => {
							sidebarOpen = false;
							renderApp();
						}}
					></div>
					<!-- Drawer -->
					<div class="md:hidden fixed inset-y-0 left-0 w-[280px] z-50 bg-background border-r border-border shadow-lg flex flex-col">
						<div class="flex items-center justify-between px-3 py-2 border-b border-border">
							<span class="text-sm font-semibold">Sessions</span>
							${Button({
								variant: "ghost",
								size: "sm",
								children: icon(X, "sm"),
								onClick: () => {
									sidebarOpen = false;
									renderApp();
								},
							})}
						</div>
						${sidebarContent}
					</div>
				`
					: nothing
			}

			<!-- Main content -->
			<div class="flex-1 flex flex-col min-w-0">
				<!-- Header -->
				<div class="flex items-center justify-between border-b border-border shrink-0">
					<div class="flex items-center gap-2 px-4 py-2">
						<!-- Mobile hamburger -->
						${Button({
							variant: "ghost",
							size: "sm",
							children: icon(Menu, "sm"),
							onClick: () => {
								sidebarOpen = !sidebarOpen;
								renderApp();
							},
							className: "md:hidden",
							title: "Toggle sessions",
						})}
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

	// Track session changes (from other tabs or server-side switches)
	agent.onSessionChange(async () => {
		await refreshSessionList();
		renderApp();
	});

	// Refresh sidebar after each agent turn (new messages change previews/counts)
	agent.subscribe((event) => {
		if (event.type === "agent_end") {
			refreshSessionList().then(() => renderApp());
		}
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

	// Load initial session list
	await refreshSessionList();

	renderApp();
}

initApp();
