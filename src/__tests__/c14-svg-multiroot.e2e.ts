import { describe, it, expect } from "vitest";
import { signal } from "@elurjs/core";
import { renderToString } from "@elurjs/core/server";
import { hydrate } from "@elurjs/core/hydrate";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import elurJsPlugin from "../index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.join(here, ".e2e-tmp");

function transform(code: string, id = "src/app.ts") {
    const plugin = elurJsPlugin({ hydration: true });
    const result = (plugin.transform as Function)(code, id);
    return typeof result === "string" ? result : result?.code ?? null;
}

async function importTransformed(code: string): Promise<Record<string, unknown>> {
    mkdirSync(tmpDir, { recursive: true });
    const file = path.join(tmpDir, `mod-${Date.now()}.mjs`);
    writeFileSync(file, code);
    try {
        return await import(file);
    } finally {
        rmSync(file, { force: true });
    }
}

function flush() {
    return new Promise((r) => setTimeout(r, 0));
}

describe("C.14 svg + multi-root", () => {
    it("svg: bindings especializados + class via setAttribute", async () => {
        const out = transform(`
import { html, signal } from "@elurjs/core";
export const r = signal(5);
export const cls = signal("a");
export const t = () => html\`<svg viewBox="0 0 10 10"><circle class=\${cls} r=\${r}></circle><use xlink:href=\${cls}></use><text>\${r}</text></svg>\`;
`, "src/svg.ts")!;
        expect(out).toContain("__elurCreateTemplate"); // especializado
        const mod = await importTransformed(out);
        const inst = (mod as { t: () => { mount: (c: Element) => { unmount(): void } } }).t();
        const host = document.createElement("div");
        document.body.appendChild(host);
        const handle = inst.mount(host);
        const circle = host.querySelector("circle")!;
        expect(circle.namespaceURI).toContain("svg");
        expect(circle.getAttribute("class")).toBe("a");
        expect(circle.getAttribute("r")).toBe("5");
        const use = host.querySelector("use")!;
        expect(
            use.getAttribute("xlink:href") ??
            use.getAttributeNS("http://www.w3.org/1999/xlink", "href"),
        ).toBe("a");
        expect(host.querySelector("text")!.textContent).toBe("5");
        const s = (mod as unknown as { r: { value: number }; cls: { value: string } });
        s.cls.value = "b";
        s.r.value = 9;
        await flush();
        expect(circle.getAttribute("class")).toBe("b");
        expect(circle.getAttribute("r")).toBe("9");
        handle.unmount();
        host.remove();
    });

    it("multi-root: factory de fragmento + remove por rango", async () => {
        const out = transform(`
import { html, signal } from "@elurjs/core";
export const a = signal("A");
export const t = () => html\`<div>\${a}</div><span>mid</span><b>\${a}</b>\`;
`, "src/multi.ts")!;
        expect(out).toContain("__elurCreateFragment");
        const mod = await importTransformed(out);
        const inst = (mod as { t: () => { mount: (c: Element) => { unmount(): void } } }).t();
        const host = document.createElement("div");
        document.body.appendChild(host);
        const handle = inst.mount(host);
        expect(host.querySelector("div")!.textContent).toBe("A");
        expect(host.querySelector("b")!.textContent).toBe("A");
        expect(host.textContent).toContain("mid");
        (mod as unknown as { a: { value: string } }).a.value = "B";
        await flush();
        expect(host.querySelector("div")!.textContent).toBe("B");
        expect(host.querySelector("b")!.textContent).toBe("B");
        handle.unmount();
        expect(host.childNodes.length).toBe(0); // rango completo removido
        host.remove();
    });

    it("multi-root SSR + hydrate genérico (data-elur-*)", async () => {
        const out = transform(`
import { html, signal } from "@elurjs/core";
export const a = signal("A");
export const t = () => html\`<div>\${a}</div><span>\${a}</span>\`;
`, "src/multi-ssr.ts")!;
        const mod = await importTransformed(out);
        const inst = (mod as { t: () => unknown }).t();
        const htmlStr = await renderToString(inst as never, { markers: "hydration" });
        expect(htmlStr).toContain("A");
        const host = document.createElement("div");
        host.innerHTML = htmlStr;
        document.body.appendChild(host);
        const handle = hydrate(inst as never, host);
        (mod as unknown as { a: { value: string } }).a.value = "C";
        await flush();
        expect(host.querySelector("div")!.textContent).toBe("C");
        expect(host.querySelector("span")!.textContent).toBe("C");
        handle.unmount();
        host.remove();
    });
});

describe("C.14 svg SSR + hydrate compilada", () => {
    it("markers dentro de svg + attrs namespace-aware", async () => {
        const out = transform(`
import { html, signal } from "@elurjs/core";
export const r = signal(5);
export const cls = signal("a");
export const t = () => html\`<svg viewBox="0 0 10 10"><circle class=\${cls}></circle><text>\${r}</text></svg>\`;
`, "src/svg-hyd.ts")!;
        expect(out).toContain("$hydrate");
        const mod = await importTransformed(out);
        const inst = (mod as { t: () => unknown }).t();
        const htmlStr = await renderToString(inst as never, { markers: "hydration" });
        const host = document.createElement("div");
        host.innerHTML = htmlStr;
        document.body.appendChild(host);
        const circle = host.querySelector("circle")!;
        expect(circle.getAttribute("class")).toBe("a");
        const handle = hydrate(inst as never, host);
        (mod as unknown as { r: { value: number }; cls: { value: string } }).r.value = 7;
        (mod as unknown as { cls: { value: string } }).cls.value = "z";
        await flush();
        expect(host.querySelector("text")!.textContent).toBe("7");
        expect(circle.getAttribute("class")).toBe("z");
        handle.unmount();
        host.remove();
    });
});

describe("C.12 fase 2 — SSR especializado", () => {
    it("el renderer especializado produce el mismo HTML que el intérprete", async () => {
        const out = transform(`
import { html, signal } from "@elurjs/core";
export const s = signal("val");
export const t = () => html\`<div class="pre \${s}" id="x-\${s}"><a href=\${() => "/u/" + s.value} @click=\${() => 1}>go</a><b>\${s}</b>\${"tail"}</div>\`;
`, "src/ssr-spec.ts")!;
        expect(out).toContain("$ssr");
        const mod = await importTransformed(out);
        const inst = (mod as { t: () => unknown }).t();
        const specialized = await renderToString(inst as never, { markers: "hydration" });

        // Referencia: descriptor intérprete — construir un descriptor igual
        // sin ssr para comparar chunk a chunk.
        const proto = Object.getPrototypeOf(inst);
        const desc = (inst as Record<symbol, any>)[Symbol.for("@elurjs/core/template-descriptor")];
        const { ssr, ...rest } = desc;
        const generic = await renderToString({ [Symbol.for("@elurjs/core/template-descriptor")]: rest, __isElurTemplate: true } as never, { markers: "hydration" });
        expect(specialized).toBe(generic);
        expect(specialized).toContain("pre val");
        expect(specialized).toContain('href="/u/val"');
        // data-elur-e omitido: el descriptor trae hydrate compilada (C.13)
        expect(specialized).not.toContain("data-elur-e-");
        expect(specialized).toContain("<!--elur-4-->");
        void proto; void ssr;
    });
});

describe("C.12 restante — IR blocks + dev metadata", () => {
    it("descriptor.blocks describe each/portal; dev.id ubica el template", async () => {
        const out = transform(`
import { html, repeat, portal } from "@elurjs/core";
export const t = (items, outlet) => html\`<ul>\${() => repeat(items, i => i.id, i => html\`<li>\${i.name}</li>\`)}</ul><div>\${() => portal(outlet, html\`<p>x</p>\`)}</div>\`;
`, "src/ir.ts")!;
        const mod = await importTransformed(out);
        const inst = (mod as { t: (a: unknown[], b: unknown) => unknown }).t([], null);
        const desc = (inst as Record<symbol, {
            blocks?: Array<{ index: number; kind: string }>;
            dev?: { id: string };
        }>)[Symbol.for("@elurjs/core/template-descriptor")];
        expect(desc.blocks).toContainEqual({ index: 0, kind: "each" });
        expect(desc.blocks).toContainEqual({ index: 1, kind: "portal" });
        expect(desc.dev?.id).toBe("src/ir.ts:_elurFactory$0");
    });
});
