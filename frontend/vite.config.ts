import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    server: {
        proxy: {
            "/api": {
                target: "http://localhost:3000",
                changeOrigin: true,
            },
        },
        host: "0.0.0.0",
        allowedHosts: [
            "d138364d-7f62-462b-b93d-75d5933deeb3-00-bb9r8rw8nelt.janeway.replit.dev",
        ], // Allow all hosts to connect
    },
    build: {
        outDir: "../public",
        emptyOutDir: true,
    },
});
