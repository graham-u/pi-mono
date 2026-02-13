/**
 * Merged list of built-in + dynamic slash commands for autocomplete.
 */

export interface CommandInfo {
	name: string;
	description?: string;
	source: "builtin" | "extension" | "prompt" | "skill";
}

const BUILTIN_COMMANDS: CommandInfo[] = [
	{ name: "reload", description: "Reload extensions, skills, and prompt templates", source: "builtin" },
	{ name: "compact", description: "Compact the current session", source: "builtin" },
	{ name: "name", description: "Rename the current session", source: "builtin" },
	{ name: "session", description: "Show current session info", source: "builtin" },
	{ name: "export", description: "Export session as HTML", source: "builtin" },
	{ name: "bash", description: "Run a shell command", source: "builtin" },
];

export class CommandStore {
	private _dynamicCommands: CommandInfo[] = [];

	get allCommands(): CommandInfo[] {
		return [...BUILTIN_COMMANDS, ...this._dynamicCommands];
	}

	setDynamicCommands(commands: Array<{ name: string; description?: string; source: string }>): void {
		this._dynamicCommands = commands.map((c) => ({
			name: c.name,
			description: c.description,
			source: c.source as CommandInfo["source"],
		}));
	}
}
