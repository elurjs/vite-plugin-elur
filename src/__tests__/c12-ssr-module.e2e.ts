// @vitest-environment node
import { describe, it, expect } from "vitest";
import { renderToString } from "@elurjs/core/server";
import { signal } from "@elurjs/core/signals";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import elurJsPlugin from "../index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.join(here, ".e2e-tmp");

function transform(code: string, ssr = false) {
    const plugin = elurJsPlugin({ hydration: true });
    const result = (plugin.transform as Function)(code, "src/app.ts", { ssr });
    return typeof result === "string" ? result : result?.code ?? null;
}

async function importTransformed(code: string): Promise<Record<string, unknown>> {
    mkdirSync(tmpDir, { recursive: true });
    const file = path.join(tmpDir, `ssr-${Date.now()}.mjs`);
    writeFileSync(file, code);
    try {
        return await import(file);
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

/**
 * C.12 — el mismo artefacto compilado corre en SSR (Node puro, sin DOM):
 * el módulo carga sin `document`/`window` y `renderToString` emite el
 * HTML con boundaries elur-N y sin `data-elur-*`.
 */
describe("C.12 artefacto compilado en SSR", () => {
    it("el módulo compilado carga en Node sin DOM y renderiza SSR", async () => {
        const code = `
import { html, repeat } from "@elurjs/core";
export const list = (rows) => html\`
  <ul>\${() => repeat(rows.value, r => r.id, r => html\`<li class=\${r.c}>\${r.label}</li>\`)}</ul>
\`;
`;
        const out = transform(code, true)!; // transform en modo SSR
        expect(out).toContain("$hydrate");
        const mod = await importTransformed(out); // Node puro — sin document

        const rows = signal([
            { id: 1, label: "a", c: "x" },
            { id: 2, label: "b", c: "y" },
        ]);
        const instance = (mod.list as (r: unknown) => unknown)(rows);
        const htmlOut = await renderToString(instance, { markers: "hydration" });

        expect(htmlOut).toContain("<ul>");
        expect(htmlOut).toContain("elur-ki:");
        expect(htmlOut).toContain(">a<");
        expect(htmlOut).not.toContain("data-elur-");
        // class estático por fila renderizado directo.
        expect(htmlOut).toContain('class="x"');
    });
});
