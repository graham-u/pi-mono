#!/usr/bin/env node

/**
 * CLI entry point for the assistant server.
 *
 * Usage: pi-assistant-server [--port 3001] [--cwd /path/to/project]
 */

import "dotenv/config";
import { createAssistantServer } from "./server.js";

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
	const index = args.indexOf(`--${name}`);
	return index !== -1 ? args[index + 1] : undefined;
}

const port = Number(getArg("port")) || 3001;
const cwd = getArg("cwd") || process.cwd();

console.log(`[assistant-server] Starting...`);
console.log(`[assistant-server] cwd: ${cwd}`);

createAssistantServer({ port, cwd })
	.then((server) => {
		process.on("SIGINT", () => {
			console.log("\n[assistant-server] Shutting down...");
			server.close();
			process.exit(0);
		});

		process.on("SIGTERM", () => {
			server.close();
			process.exit(0);
		});
	})
	.catch((err) => {
		console.error("[assistant-server] Failed to start:", err);
		process.exit(1);
	});
