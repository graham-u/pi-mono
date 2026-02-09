import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss()],
	server: {
		port: 3000,
		proxy: {
			"/ws": {
				target: "ws://localhost:3001",
				ws: true,
			},
		},
	},
});
