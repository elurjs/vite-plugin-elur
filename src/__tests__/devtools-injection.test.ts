import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import elurJsPlugin from "../index.js";

// Tests run with cwd = the vite-plugin-elur package root.
const here = process.cwd();
// The elur-devtools workspace has @elurjs/devtools-backend installed.
const rootWithBackend = resolve(here, "../elur-devtools");
// This package itself does NOT depend on the backend.
const rootWithoutBackend = here;

interface FakePluginContext {
    warn: (msg: string) => void;
}

function runConfigResolved(plugin: Plugin, root: string, command: "serve" | "build") {
    const warnings: string[] = [];
    const ctx: FakePluginContext = { warn: (msg) => warnings.push(msg) };
    const hook = plugin.configResolved;
    if (typeof hook === "function") {
        hook.call(ctx as never, { root, command } as never);
    }
    return warnings;
}

function runTransformIndexHtml(plugin: Plugin): unknown[] {
    const hook = plugin.transformIndexHtml;
    if (!hook || typeof hook === "function") return [];
    const handler = typeof hook.handler === "function" ? hook.handler : null;
    if (!handler) return [];
    const result = handler.call({} as never, "<html></html>", {} as never);
    return Array.isArray(result) ? result : [];
}

describe("devtools injection", () => {
    it("injects nothing when devtools is false", () => {
        const plugin = elurJsPlugin({ devtools: false });
        runConfigResolved(plugin, rootWithBackend, "serve");
        expect(runTransformIndexHtml(plugin)).toEqual([]);
    });

    it("injects nothing on build even when the backend is resolvable", () => {
        const plugin = elurJsPlugin({ devtools: true });
        runConfigResolved(plugin, rootWithBackend, "build");
        expect(runTransformIndexHtml(plugin)).toEqual([]);
    });

    it("warns and injects nothing with devtools:true when the backend is missing", () => {
        const plugin = elurJsPlugin({ devtools: true });
        const warnings = runConfigResolved(plugin, rootWithoutBackend, "serve");
        expect(warnings.length).toBe(1);
        expect(runTransformIndexHtml(plugin)).toEqual([]);
    });

    it("auto-injects the backend in dev when it is resolvable", () => {
        const plugin = elurJsPlugin(); // default: "auto"
        const warnings = runConfigResolved(plugin, rootWithBackend, "serve");
        expect(warnings).toEqual([]);

        const tags = runTransformIndexHtml(plugin) as Array<{
            tag: string;
            attrs?: Record<string, string>;
            injectTo?: string;
        }>;
        expect(tags.length).toBe(1);
        expect(tags[0]?.tag).toBe("script");
        expect(tags[0]?.injectTo).toBe("head-prepend");
        expect(tags[0]?.attrs?.src).toContain("virtual:elur-devtools");

        // The virtual module resolves and loads the backend import.
        const resolved = (plugin.resolveId as (id: string) => string | null).call(
            {} as never,
            "virtual:elur-devtools",
        );
        expect(resolved).toBe("virtual:elur-devtools");
        const code = (plugin.load as (id: string) => string | null).call(
            {} as never,
            resolved!,
        );
        expect(code).toContain('import "@elurjs/devtools-backend/auto";');
    });
});
