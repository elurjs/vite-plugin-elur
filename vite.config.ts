import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve("src/index.ts"),
        runtime: resolve("src/runtime.ts"),
        // C.17 — runtime dividido: el código generado importa
        // `runtime/compiler` (sin HMR en prod); el transform HMR usa
        // `runtime/hmr`. `runtime` queda como barrel retrocompatible.
        "runtime/compiler": resolve("src/runtime/compiler.ts"),
        "runtime/hmr": resolve("src/runtime/hmr.ts"),
      },
      formats: ["es", "cjs"],
      fileName: (format, entryName) =>
        `${entryName}.${format === "es" ? "js" : "cjs"}`,
    },
    rollupOptions: {
      external: [
        /^@elurjs\/core(\/.*)?$/,
        "@babel/core", "@babel/parser", "@babel/traverse", "@babel/generator", "@babel/types",
        "vite",
        "node:module", "node:path",
      ],
    },
    sourcemap: true,
    minify: false,
  },
});
