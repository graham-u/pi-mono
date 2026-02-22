import { streamSimple, type ToolResultMessage, type Usage } from "@mariozechner/pi-ai";
import { html, LitElement } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { ModelSelector } from "../dialogs/ModelSelector.js";
import type { MessageEditor } from "./MessageEditor.js";
import "./MessageEditor.js";
import "./MessageList.js";
import "./Messages.js"; // Import for side effects to register the custom elements
import { getAppStorage } from "../storage/app-storage.js";
import "./StreamingMessageContainer.js";
import type { Agent, AgentEvent } from "@mariozechner/pi-agent-core";
import type { Attachment } from "../utils/attachment-utils.js";
import { formatCountdown, formatEstimatedCost, formatUsageWithToolCost } from "../utils/format.js";
import { i18n } from "../utils/i18n.js";
import { createStreamFn } from "../utils/proxy-utils.js";
import type { UserMessageWithAttachments } from "./Messages.js";
import type { StreamingMessageContainer } from "./StreamingMessageContainer.js";

@customElement("agent-interface")
export class AgentInterface extends LitElement {
	// Optional external session: when provided, this component becomes a view over the session
	@property({ attribute: false }) session?: Agent;
	@property({ type: Boolean }) enableAttachments = true;
	@property({ type: Boolean }) enableModelSelector = true;
	@property({ type: Boolean }) enableThinkingSelector = true;
	@property({ type: Boolean }) showThemeToggle = false;
	// Optional custom API key prompt handler - if not provided, uses default dialog
	@property({ attribute: false }) onApiKeyRequired?: (provider: string) => Promise<boolean>;
	// Optional callback called before sending a message
	@property({ attribute: false }) onBeforeSend?: () => void | Promise<void>;
	// Optional callback called before executing a tool call - return false to prevent execution
	@property({ attribute: false }) onBeforeToolCall?: (toolName: string, args: any) => boolean | Promise<boolean>;
	// Optional callback called when cost display is clicked
	@property({ attribute: false }) onCostClick?: () => void;

	// References
	@query("message-editor") private _messageEditor!: MessageEditor;
	@query("streaming-message-container") private _streamingContainer!: StreamingMessageContainer;

	private _autoScroll = true;
	private _lastScrollTop = 0;
	private _lastClientHeight = 0;
	private _scrollContainer?: HTMLElement;
	private _resizeObserver?: ResizeObserver;
	private _unsubscribeSession?: () => void;
	private _cacheTickInterval?: ReturnType<typeof setInterval>;

	public focusInput(): void {
		if (!this._messageEditor) requestAnimationFrame(() => this.focusInput());
		else this._messageEditor.focusInput();
	}

	public getInput(): string {
		return this._messageEditor?.value ?? "";
	}

	public setInput(text: string, attachments?: Attachment[]) {
		const update = () => {
			if (!this._messageEditor) requestAnimationFrame(update);
			else {
				this._messageEditor.value = text;
				this._messageEditor.attachments = attachments || [];
			}
		};
		update();
	}

	public setAutoScroll(enabled: boolean) {
		this._autoScroll = enabled;
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override willUpdate(changedProperties: Map<string, any>) {
		super.willUpdate(changedProperties);

		// Re-subscribe when session property changes
		if (changedProperties.has("session")) {
			this.setupSessionSubscription();
		}
	}

	override updated() {
		// Manage the 1 Hz cache countdown timer based on whether the cache is warm.
		// Done here rather than in render() to avoid side effects during rendering.
		const cacheExpiresAt: string | undefined = (this.session as any)?.cacheExpiresAt;
		const isWarm = cacheExpiresAt ? new Date(cacheExpiresAt).getTime() > Date.now() : false;
		if (isWarm) {
			this._startCacheTick();
		} else {
			this._stopCacheTick();
		}
	}

	override async connectedCallback() {
		super.connectedCallback();

		this.style.display = "flex";
		this.style.flexDirection = "column";
		this.style.height = "100%";
		this.style.minHeight = "0";

		// Wait for first render to get scroll container
		await this.updateComplete;
		this._scrollContainer = this.querySelector(".overflow-y-auto") as HTMLElement;

		if (this._scrollContainer) {
			// Set up ResizeObserver to detect content changes
			this._resizeObserver = new ResizeObserver(() => {
				if (this._autoScroll && this._scrollContainer) {
					this._scrollContainer.scrollTop = this._scrollContainer.scrollHeight;
				}
			});

			// Observe the content container inside the scroll container
			const contentContainer = this._scrollContainer.querySelector(".max-w-3xl");
			if (contentContainer) {
				this._resizeObserver.observe(contentContainer);
			}

			// Set up scroll listener with better detection
			this._scrollContainer.addEventListener("scroll", this._handleScroll);
		}

		// Subscribe to external session if provided
		this.setupSessionSubscription();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();

		// Clean up observers and listeners
		if (this._resizeObserver) {
			this._resizeObserver.disconnect();
			this._resizeObserver = undefined;
		}

		if (this._scrollContainer) {
			this._scrollContainer.removeEventListener("scroll", this._handleScroll);
		}

		this._stopCacheTick();

		if (this._unsubscribeSession) {
			this._unsubscribeSession();
			this._unsubscribeSession = undefined;
		}
	}

	private _startCacheTick(): void {
		if (this._cacheTickInterval) return;
		this._cacheTickInterval = setInterval(() => this.requestUpdate(), 1000);
	}

	private _stopCacheTick(): void {
		if (this._cacheTickInterval) {
			clearInterval(this._cacheTickInterval);
			this._cacheTickInterval = undefined;
		}
	}

	private setupSessionSubscription() {
		if (this._unsubscribeSession) {
			this._unsubscribeSession();
			this._unsubscribeSession = undefined;
		}
		if (!this.session) return;

		// Set default streamFn with proxy support if not already set
		if (this.session.streamFn === streamSimple) {
			this.session.streamFn = createStreamFn(async () => {
				const enabled = await getAppStorage().settings.get<boolean>("proxy.enabled");
				return enabled ? (await getAppStorage().settings.get<string>("proxy.url")) || undefined : undefined;
			});
		}

		// Set default getApiKey if not already set
		if (!this.session.getApiKey) {
			this.session.getApiKey = async (provider: string) => {
				const key = await getAppStorage().providerKeys.get(provider);
				return key ?? undefined;
			};
		}

		this._unsubscribeSession = this.session.subscribe(async (ev: AgentEvent) => {
			switch (ev.type) {
				case "message_start":
				case "message_end":
				case "turn_start":
				case "turn_end":
				case "agent_start":
					this.requestUpdate();
					break;
				case "agent_end":
					// Clear streaming container when agent finishes
					if (this._streamingContainer) {
						this._streamingContainer.isStreaming = false;
						this._streamingContainer.setMessage(null, true);
					}
					this.requestUpdate();
					break;
				case "message_update":
					if (this._streamingContainer) {
						const isStreaming = this.session?.state.isStreaming || false;
						this._streamingContainer.isStreaming = isStreaming;
						this._streamingContainer.setMessage(ev.message, !isStreaming);
					}
					this.requestUpdate();
					break;
			}
		});
	}

	private _handleScroll = (_ev: any) => {
		if (!this._scrollContainer) return;

		const currentScrollTop = this._scrollContainer.scrollTop;
		const scrollHeight = this._scrollContainer.scrollHeight;
		const clientHeight = this._scrollContainer.clientHeight;
		const distanceFromBottom = scrollHeight - currentScrollTop - clientHeight;

		// Ignore relayout due to message editor getting pushed up by stats
		if (clientHeight < this._lastClientHeight) {
			this._lastClientHeight = clientHeight;
			return;
		}

		// Only disable auto-scroll if user scrolled UP or is far from bottom
		if (currentScrollTop !== 0 && currentScrollTop < this._lastScrollTop && distanceFromBottom > 50) {
			this._autoScroll = false;
		} else if (distanceFromBottom < 10) {
			// Re-enable if very close to bottom
			this._autoScroll = true;
		}

		this._lastScrollTop = currentScrollTop;
		this._lastClientHeight = clientHeight;
	};

	public async sendMessage(input: string, attachments?: Attachment[]) {
		if ((!input.trim() && attachments?.length === 0) || this.session?.state.isStreaming) return;
		const session = this.session;
		if (!session) throw new Error("No session set on AgentInterface");
		if (!session.state.model) throw new Error("No model set on AgentInterface");

		// Check if API key exists for the provider (only needed in direct mode)
		const provider = session.state.model.provider;
		const apiKey = await getAppStorage().providerKeys.get(provider);

		// If no API key, prompt for it
		if (!apiKey) {
			if (!this.onApiKeyRequired) {
				console.error("No API key configured and no onApiKeyRequired handler set");
				return;
			}

			const success = await this.onApiKeyRequired(provider);

			// If still no API key, abort the send
			if (!success) {
				return;
			}
		}

		// Call onBeforeSend hook before sending
		if (this.onBeforeSend) {
			await this.onBeforeSend();
		}

		// Only clear editor after we know we can send
		this._messageEditor.value = "";
		this._messageEditor.attachments = [];
		this._autoScroll = true; // Enable auto-scroll when sending a message

		// Compose message with attachments if any
		if (attachments && attachments.length > 0) {
			const message: UserMessageWithAttachments = {
				role: "user-with-attachments",
				content: input,
				attachments,
				timestamp: Date.now(),
			};
			await this.session?.prompt(message);
		} else {
			await this.session?.prompt(input);
		}
	}

	private renderMessages() {
		if (!this.session)
			return html`<div class="p-4 text-center text-muted-foreground">${i18n("No session available")}</div>`;
		const state = this.session.state;
		// Build a map of tool results to allow inline rendering in assistant messages
		const toolResultsById = new Map<string, ToolResultMessage<any>>();
		for (const message of state.messages) {
			if (message.role === "toolResult") {
				toolResultsById.set(message.toolCallId, message);
			}
		}
		return html`
			<div class="flex flex-col gap-3">
				<!-- Stable messages list - won't re-render during streaming -->
				<message-list
					.messages=${this.session.state.messages}
					.tools=${state.tools}
					.pendingToolCalls=${this.session ? this.session.state.pendingToolCalls : new Set<string>()}
					.isStreaming=${state.isStreaming}
					.onCostClick=${this.onCostClick}
				></message-list>

				<!-- Streaming message container - manages its own updates -->
				<streaming-message-container
					class="${state.isStreaming ? "" : "hidden"}"
					.tools=${state.tools}
					.isStreaming=${state.isStreaming}
					.pendingToolCalls=${state.pendingToolCalls}
					.toolResultsById=${toolResultsById}
					.onCostClick=${this.onCostClick}
				></streaming-message-container>
			</div>
		`;
	}

	private renderStats() {
		if (!this.session) return html`<div class="text-xs h-5"></div>`;

		const state = this.session.state;
		const totals = state.messages
			.filter((m) => m.role === "assistant")
			.reduce(
				(acc, msg: any) => {
					const usage = msg.usage;
					if (usage) {
						acc.input += usage.input;
						acc.output += usage.output;
						acc.cacheRead += usage.cacheRead;
						acc.cacheWrite += usage.cacheWrite;
						acc.cost.total += usage.cost.total;
					}
					return acc;
				},
				{
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				} satisfies Usage,
			);

		// Sum tool-internal usage from toolResult messages (e.g. browser-use)
		const toolCost = state.messages
			.filter((m) => m.role === "toolResult" && (m as any).usage?.cost?.total)
			.reduce((sum, m) => sum + ((m as any).usage.cost.total as number), 0);

		const hasTotals = totals.input || totals.output || totals.cacheRead || totals.cacheWrite;
		const totalsText = hasTotals ? formatUsageWithToolCost(totals, toolCost) : "";

		// Cache cost indicator
		const cacheCostHtml = this.renderCacheCost(state);

		return html`
			<div class="text-xs text-muted-foreground flex justify-between items-center h-5">
				<div class="flex items-center gap-1">
					${this.showThemeToggle ? html`<theme-toggle></theme-toggle>` : html``}
					${cacheCostHtml}
				</div>
				<div class="flex ml-auto items-center gap-3">
					${
						totalsText
							? this.onCostClick
								? html`<span class="cursor-pointer hover:text-foreground transition-colors" @click=${this.onCostClick}>${totalsText}</span>`
								: html`<span>${totalsText}</span>`
							: ""
					}
				</div>
			</div>
		`;
	}

	private renderCacheCost(state: any) {
		// Read cacheExpiresAt from the session (RemoteAgent exposes it as a public property)
		const cacheExpiresAt: string | undefined = (this.session as any)?.cacheExpiresAt;
		const modelCost = state.model?.cost;

		// Need messages and cost data to show anything
		if (!state.messages.length || !modelCost) return html``;

		// Find the last assistant message to get context token count
		let contextTokens = 0;
		for (let i = state.messages.length - 1; i >= 0; i--) {
			const m = state.messages[i] as any;
			if (m.role === "assistant" && m.usage) {
				contextTokens = (m.usage.input || 0) + (m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0);
				break;
			}
		}
		if (contextTokens === 0) return html``;

		const warmCost = (contextTokens * (modelCost.cacheRead || 0)) / 1_000_000;
		// Cold cost uses cacheWrite rate (pessimistic upper bound — assumes all
		// tokens hit the cache-write path, which Anthropic charges at 1.25× input).
		// Falls back to input rate if the provider doesn't expose cacheWrite.
		const coldCost = (contextTokens * (modelCost.cacheWrite || modelCost.input || 0)) / 1_000_000;

		// Determine cache state
		const now = Date.now();
		const expiresMs = cacheExpiresAt ? new Date(cacheExpiresAt).getTime() : 0;
		const remainingSec = cacheExpiresAt ? Math.max(0, Math.floor((expiresMs - now) / 1000)) : 0;
		const isWarm = remainingSec > 0;
		const coldStr = formatEstimatedCost(coldCost);

		if (isWarm) {
			const warmStr = formatEstimatedCost(warmCost);
			const countdown = formatCountdown(remainingSec);
			return html`<span class="text-amber-500">${countdown} ${warmStr}</span><span> / </span><span class="text-sky-400">${coldStr}</span>`;
		}

		return html`<span class="text-sky-400">${coldStr}</span>`;
	}

	override render() {
		if (!this.session)
			return html`<div class="p-4 text-center text-muted-foreground">${i18n("No session set")}</div>`;

		const session = this.session;
		const state = this.session.state;
		return html`
			<div class="flex flex-col h-full bg-background text-foreground">
				<!-- Messages Area -->
				<div class="flex-1 overflow-y-auto">
					<div class="max-w-3xl mx-auto p-4 pb-0">${this.renderMessages()}</div>
				</div>

				<!-- Input Area -->
				<div class="shrink-0">
					<div class="max-w-3xl mx-auto px-2">
						<message-editor
							.isStreaming=${state.isStreaming}
							.currentModel=${state.model}
							.thinkingLevel=${state.thinkingLevel}
							.showAttachmentButton=${this.enableAttachments}
							.showModelSelector=${this.enableModelSelector}
							.showThinkingSelector=${this.enableThinkingSelector}
							.onSend=${(input: string, attachments: Attachment[]) => {
								this.sendMessage(input, attachments);
							}}
							.onAbort=${() => session.abort()}
							.onModelSelect=${() => {
								ModelSelector.open(state.model, (model) => session.setModel(model));
							}}
							.onThinkingChange=${
								this.enableThinkingSelector
									? (level: "off" | "minimal" | "low" | "medium" | "high") => {
											session.setThinkingLevel(level);
										}
									: undefined
							}
						></message-editor>
						${this.renderStats()}
					</div>
				</div>
			</div>
		`;
	}
}

// Register custom element with guard
if (!customElements.get("agent-interface")) {
	customElements.define("agent-interface", AgentInterface);
}
