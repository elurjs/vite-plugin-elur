import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const coreSrc = path.resolve(dir, "../elur-core/src");

/**
 * Suite e2e del plugin: el código transformado por el compilador corre
 * contra el core de FUENTE local (../elur-core/src), no contra el paquete
 * npm de node_modules — así se ejercitan los paths nuevos (hidratación
 * compilada, _bindSignal/_bindDerived) antes de publicar core.
 * La suite principal (vitest.config.ts) sigue corriendo contra npm core.
 */
export default defineConfig({
    resolve: {
        alias: [
            { find: "@elurjs/core/signals", replacement: path.join(coreSrc, "elur/reactivity.ts") },
            { find: "@elurjs/core/hydrate", replacement: path.join(coreSrc, "elur/hydrate/index.ts") },
            { find: "@elurjs/core/server", replacement: path.join(coreSrc, "elur/server/index.ts") },
            { find: "@elurjs/core/template", replacement: path.join(coreSrc, "elur/template/index.ts") },
            { find: "@elurjs/core/context", replacement: path.join(coreSrc, "elur/context.ts") },
            { find: "@elurjs/core/component", replacement: path.join(coreSrc, "elur/component.ts") },
            { find: "@elurjs/core", replacement: path.join(coreSrc, "index.ts") },
            {
                find: "@elurjs/core-compiler",
                replacement: path.resolve(dir, "../elur-core-compiler/src/index.ts"),
            },
            {
                find: "@elurjs/vite-plugin-elur/runtime/compiler",
                replacement: path.join(dir, "src/runtime/compiler.ts"),
            },
            {
                find: "@elurjs/vite-plugin-elur/runtime/hmr",
                replacement: path.join(dir, "src/runtime/hmr.ts"),
            },
            {
                find: "@elurjs/vite-plugin-elur/runtime",
                replacement: path.join(dir, "src/runtime.ts"),
            },
        ],
    },
    test: {
        environment: "happy-dom",
        globals: true,
        include: ["src/**/*.e2e.ts"],
    },
});
