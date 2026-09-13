import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "happy-dom",
        globals: true,
        // Los e2e (*.e2e.ts) corren con vitest.e2e.config.ts — usan el core
        // de fuente local, no el npm.
        exclude: ["**/node_modules/**", "src/**/*.e2e.ts"],
    },
});
