import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { SquareTerminal } from "lucide";
import { i18n } from "../../utils/i18n.js";
import { renderCollapsibleHeader, renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface BashParams {
	command: string;
}

// Bash tool has undefined details (only uses output)
export class BashRenderer implements ToolRenderer<BashParams, undefined> {
	render(params: BashParams | undefined, result: ToolResultMessage<undefined> | undefined): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";

		// With result: show collapsible with command + output
		if (result && params?.command) {
			const contentRef = createRef<HTMLDivElement>();
			const chevronRef = createRef<HTMLSpanElement>();

			const output =
				result.content
					?.filter((c) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || "";
			const combined = output ? `> ${params.command}\n\n${output}` : `> ${params.command}`;

			// Show truncated command in header
			const cmdPreview = params.command.length > 60 ? `${params.command.slice(0, 57)}...` : params.command;

			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, SquareTerminal, cmdPreview, contentRef, chevronRef, false)}
						<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300 space-y-3">
							<console-block .content=${combined} .variant=${result.isError ? "error" : "default"}></console-block>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		// Just params (streaming or waiting): show command, keep expanded so user can see what's running
		if (params?.command) {
			return {
				content: html`
					<div class="space-y-3">
						${renderHeader(state, SquareTerminal, i18n("Running command..."))}
						<console-block .content=${`> ${params.command}`}></console-block>
					</div>
				`,
				isCustom: false,
			};
		}

		// No params yet
		return { content: renderHeader(state, SquareTerminal, i18n("Waiting for command...")), isCustom: false };
	}
}
