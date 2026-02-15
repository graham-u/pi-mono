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

import "./autocomplete-dropdown.js";
import type { AutocompleteDropdown } from "./autocomplete-dropdown.js";
import { CommandStore } from "./command-store.js";
import { fuzzyFilter } from "./fuzzy.js";
import { registerPushNotifications } from "./push.js";
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
const sessionDrafts = new Map<string, string>();

// Cache countdown tick (driven by sessionList data from server)
let cacheTickInterval: ReturnType<typeof setInterval> | null = null;

// Autocomplete
const commandStore = new CommandStore();
let autocompleteDropdown: AutocompleteDropdown | null = null;

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
	const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

	// Same calendar day — just show time
	if (
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate()
	) {
		return time;
	}

	// Older — show date + time
	const dateStr = date.toLocaleDateString([], { month: "short", day: "numeric" });
	return `${dateStr}, ${time}`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen)}...`;
}

function focusPromptInput(): void {
	(chatPanel as any)?.agentInterface?.focusInput();
}

function saveDraft(): void {
	const path = agent?.sessionPath;
	const text = (chatPanel as any)?.agentInterface?.getInput() ?? "";
	if (path) {
		if (text) sessionDrafts.set(path, text);
		else sessionDrafts.delete(path);
	}
}

function restoreDraft(): void {
	const path = agent?.sessionPath;
	const draft = path ? (sessionDrafts.get(path) ?? "") : "";
	(chatPanel as any)?.agentInterface?.setInput(draft);
}

async function handleNewSession(): Promise<void> {
	saveDraft();
	await agent.newSession();
	await refreshSessionList();
	sidebarOpen = false;
	renderApp();
	restoreDraft();
	focusPromptInput();
}

async function handleSwitchSession(sessionPath: string): Promise<void> {
	if (sessionPath === agent.sessionPath) {
		sidebarOpen = false;
		renderApp();
		focusPromptInput();
		return;
	}
	saveDraft();
	await agent.switchSession(sessionPath);
	await refreshSessionList();
	sidebarOpen = false;
	renderApp();
	restoreDraft();
	focusPromptInput();
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
// Cache Countdown (driven by server-provided cacheExpiresAt in session list)
// ============================================================================

function getCacheRemaining(session: SessionInfoDTO): number {
	if (!session.cacheExpiresAt) return 0;
	const expiresAt = new Date(session.cacheExpiresAt).getTime();
	return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

function formatCountdown(seconds: number): string {
	if (seconds >= 3600) {
		const h = Math.floor(seconds / 3600);
		const m = Math.ceil((seconds % 3600) / 60);
		return `${h}h ${m}m`;
	}
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Start or stop the 1 Hz tick based on whether any session has an active countdown. */
function ensureCacheTick(): void {
	const hasActive = sessionList.some((s) => getCacheRemaining(s) > 0);
	if (hasActive && !cacheTickInterval) {
		cacheTickInterval = setInterval(() => {
			if (!sessionList.some((s) => getCacheRemaining(s) > 0)) {
				clearInterval(cacheTickInterval!);
				cacheTickInterval = null;
			}
			renderApp();
		}, 1000);
	} else if (!hasActive && cacheTickInterval) {
		clearInterval(cacheTickInterval);
		cacheTickInterval = null;
	}
}

// ============================================================================
// Slash Command Autocomplete
// ============================================================================

function fetchDynamicCommands(): void {
	agent.requestCommands().then(
		(cmds) => commandStore.setDynamicCommands(cmds),
		(err) => console.error("[autocomplete] Failed to fetch commands:", err),
	);
}

function hideAutocomplete(): void {
	if (autocompleteDropdown) {
		autocompleteDropdown.visible = false;
	}
}

function applyCompletion(name: string): void {
	const editor = document.querySelector("message-editor") as any;
	if (editor) {
		editor.value = `/${name} `;
		// Defer cursor placement until after Lit re-renders the textarea
		requestAnimationFrame(() => {
			const textarea = editor.querySelector("textarea") as HTMLTextAreaElement | null;
			if (textarea) {
				const len = textarea.value.length;
				textarea.setSelectionRange(len, len);
				textarea.focus();
			}
		});
	}
	hideAutocomplete();
}

function updateAutocomplete(inputText: string): void {
	if (!autocompleteDropdown) return;

	// Only activate when input starts with "/" and has no space yet
	if (!inputText.startsWith("/") || inputText.includes(" ")) {
		hideAutocomplete();
		return;
	}

	const prefix = inputText.slice(1); // strip the leading "/"
	const filtered = fuzzyFilter(commandStore.allCommands, prefix, (c) => c.name);

	if (filtered.length === 0) {
		hideAutocomplete();
		return;
	}

	autocompleteDropdown.items = filtered;
	autocompleteDropdown.selectedIndex = 0;
	autocompleteDropdown.visible = true;

	// Position relative to the textarea
	const editor = document.querySelector("message-editor");
	const textarea = editor?.querySelector("textarea");
	if (textarea) {
		autocompleteDropdown.updatePosition(textarea);
	}
}

function setupAutocomplete(): void {
	if (autocompleteDropdown) return; // already set up

	// Wait for message-editor to appear in DOM
	const trySetup = () => {
		const editor = document.querySelector("message-editor");
		if (!editor) {
			requestAnimationFrame(trySetup);
			return;
		}

		// Create dropdown and append to body
		autocompleteDropdown = document.createElement("autocomplete-dropdown") as AutocompleteDropdown;
		autocompleteDropdown.onSelect = (item) => applyCompletion(item.name);
		document.body.appendChild(autocompleteDropdown);

		// Capture-phase keydown on message-editor — intercepts before Lit's handlers
		editor.addEventListener(
			"keydown",
			(e: Event) => {
				const ke = e as KeyboardEvent;
				if (!autocompleteDropdown?.visible) return;

				switch (ke.key) {
					case "ArrowDown":
						ke.preventDefault();
						ke.stopPropagation();
						autocompleteDropdown.moveSelection(1);
						break;
					case "ArrowUp":
						ke.preventDefault();
						ke.stopPropagation();
						autocompleteDropdown.moveSelection(-1);
						break;
					case "Tab":
					case "Enter": {
						const selected = autocompleteDropdown.getSelectedItem();
						if (selected) {
							ke.preventDefault();
							ke.stopPropagation();
							applyCompletion(selected.name);
						}
						break;
					}
					case "Escape":
						ke.preventDefault();
						ke.stopPropagation();
						hideAutocomplete();
						break;
				}
			},
			true, // capture phase
		);

		// Listen for input changes on the textarea
		const textarea = editor.querySelector("textarea");
		if (textarea) {
			textarea.addEventListener("input", () => {
				updateAutocomplete(textarea.value);
			});
		}

		// Reposition on window resize
		window.addEventListener("resize", () => {
			if (autocompleteDropdown?.visible && textarea) {
				autocompleteDropdown.updatePosition(textarea);
			}
		});

		// Dismiss on click outside
		document.addEventListener("click", (e) => {
			if (!autocompleteDropdown?.visible) return;
			const target = e.target as HTMLElement;
			if (!target.closest("autocomplete-dropdown") && !target.closest("message-editor")) {
				hideAutocomplete();
			}
		});
	};

	trySetup();
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
										${
											getCacheRemaining(s) > 0
												? html`<span class="text-xs text-amber-500/80">(${formatCountdown(getCacheRemaining(s))})</span>`
												: nothing
										}
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
		ensureCacheTick();
		renderApp();
	});

	// Refresh sidebar after each agent turn (new messages change previews/counts)
	agent.subscribe((event) => {
		if (event.type === "agent_end") {
			refreshSessionList().then(() => {
				ensureCacheTick();
				renderApp();
			});
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

	// Register for push notifications (fire-and-forget)
	registerPushNotifications().catch((err) => console.error("[push] Registration failed:", err));

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
	ensureCacheTick();

	// Fetch dynamic commands for autocomplete
	fetchDynamicCommands();

	// Re-fetch commands after /reload
	agent.onCommandResult((cmd) => {
		if (cmd === "reload") fetchDynamicCommands();
	});

	renderApp();

	// Set up autocomplete after first render places message-editor in DOM
	setupAutocomplete();
}

initApp();
