import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, "../../", "VITE_");
	const allowedHosts: string[] = [];
	if (env.VITE_ALLOWED_HOSTS) {
		allowedHosts.push(...env.VITE_ALLOWED_HOSTS.split(","));
	}

	return {
		plugins: [tailwindcss()],
		server: {
			port: 3000,
			allowedHosts,
			proxy: {
				"/ws": {
					target: "ws://localhost:3001",
					ws: true,
				},
				"/api": {
					target: "http://localhost:3001",
					changeOrigin: true,
				},
			},
		},
	};
});
