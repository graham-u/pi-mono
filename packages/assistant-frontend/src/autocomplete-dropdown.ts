/**
 * Autocomplete dropdown for slash commands.
 * Renders as a fixed-position overlay above the textarea.
 * No shadow DOM — uses Tailwind classes from the host page.
 */

import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { CommandInfo } from "./command-store.js";

@customElement("autocomplete-dropdown")
export class AutocompleteDropdown extends LitElement {
	@property({ type: Array }) items: CommandInfo[] = [];
	@property({ type: Number }) selectedIndex = 0;
	@property({ type: Boolean }) visible = false;

	/** Callback when an item is selected (keyboard or click) */
	onSelect?: (item: CommandInfo) => void;

	// Position state
	private _bottom = 0;
	private _left = 0;
	private _width = 0;

	// Render into light DOM so Tailwind classes work
	override createRenderRoot() {
		return this;
	}

	/** Show the dropdown with the given items, positioned above the textarea. */
	show(items: CommandInfo[], textarea: HTMLElement): void {
		this.items = items;
		this.selectedIndex = 0;
		this.visible = true;
		const rect = textarea.getBoundingClientRect();
		this._bottom = window.innerHeight - rect.top + 4;
		this._left = rect.left;
		this._width = rect.width;
		this.requestUpdate();
	}

	/** Hide the dropdown. */
	hide(): void {
		this.visible = false;
		this.requestUpdate();
	}

	moveSelection(delta: number): void {
		if (this.items.length === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + this.items.length) % this.items.length;
		// Scroll selected item into view after Lit re-renders
		requestAnimationFrame(() => {
			this.querySelector(`[data-idx="${this.selectedIndex}"]`)?.scrollIntoView({ block: "nearest" });
		});
	}

	getSelectedItem(): CommandInfo | undefined {
		return this.items[this.selectedIndex];
	}

	/** Reposition relative to a textarea (e.g. on window resize). */
	updatePosition(textarea: HTMLElement): void {
		const rect = textarea.getBoundingClientRect();
		this._bottom = window.innerHeight - rect.top + 4;
		this._left = rect.left;
		this._width = rect.width;
		this.requestUpdate();
	}

	override render() {
		if (!this.visible || this.items.length === 0) return nothing;

		return html`
			<div
				class="fixed z-[9999] bg-popover border border-border rounded-lg shadow-lg max-h-[240px] overflow-y-auto"
				style="bottom: ${this._bottom}px; left: ${this._left}px; width: ${this._width}px;"
			>
				${this.items.map(
					(item, i) => html`
						<div
							data-idx=${i}
							class="flex items-baseline gap-2 px-3 py-1.5 cursor-pointer text-sm ${i === this.selectedIndex ? "bg-accent text-accent-foreground" : "text-popover-foreground"}"
							@mouseenter=${() => {
								this.selectedIndex = i;
							}}
							@click=${(e: Event) => {
								e.preventDefault();
								e.stopPropagation();
								this.onSelect?.(item);
							}}
						>
							<span class="font-medium shrink-0">/${item.name}</span>
							${item.description ? html`<span class="text-muted-foreground truncate text-xs">${item.description}</span>` : nothing}
						</div>
					`,
				)}
			</div>
		`;
	}
}
