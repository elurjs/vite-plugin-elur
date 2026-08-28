import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve("src/index.ts"),
        runtime: resolve("src/runtime.ts"),
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
      ],
    },
    sourcemap: true,
    minify: false,
  },
});
