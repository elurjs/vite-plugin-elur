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
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

const flush = () => Promise.resolve();

/**
 * C.13 e2e — el template compilado por el plugin se renderiza en SSR sin
 * `data-elur-*`, se hidrata con la función posicional emitida (sin scan
 * global de markers) y queda completamente reactivo.
 */
describe("C.13 hidratación compilada e2e", () => {
    it("SSR sin data-elur-* + hydrate posicional + reactividad + cleanup", async () => {
        const code = `
import { html } from "@elurjs/core";
export const row = (label, sel) => html\`
  <tr class=\${() => (sel.value === 2 ? "danger" : "")}>
    <td>\${label}</td>
    <td><a @click=\${() => { (globalThis).__clicked = ((globalThis).__clicked ?? 0) + 1; }}>x</a></td>
  </tr>
\`;
`;
        const out = transform(code)!;
        expect(out).toContain("$hydrate");
        const mod = await importTransformed(out);
        const row = mod.row as (label: unknown, sel: unknown) => unknown;

        const label = signal("fila");
        const sel = signal(1);
        const instance = row(label, sel);

        // SSR: sin data-elur-* (el descriptor trae hydrate compilada) pero
        // con los boundaries elur-N que el cursor posicional localiza.
        const htmlOut = await renderToString(instance, { markers: "hydration" });
        expect(htmlOut).not.toContain("data-elur-");
        expect(htmlOut).toContain("<!--elur-");
        expect(htmlOut).toContain("fila");

        // Hidratación: despacha descriptor.hydrate — activación posicional.
        const container = document.createElement("tbody");
        container.innerHTML = htmlOut;
        // La delegación de eventos escucha en document — el árbol debe estar
        // conectado para que el click burbujee hasta el listener global.
        document.body.appendChild(container);
        const handle = hydrate(instance as never, container);

        // Texto T1 reactivo.
        label.value = "nueva";
        await flush();
        expect(container.querySelector("td")!.textContent).toBe("nueva");

        // Attr derivado T2 reactivo.
        sel.value = 2;
        await flush();
        expect(container.querySelector("tr")!.className).toBe("danger");
        sel.value = 5;
        await flush();
        expect(container.querySelector("tr")!.className).toBe("");

        // Evento delegado hidratado.
        (globalThis as Record<string, unknown>).__clicked = 0;
        container.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect((globalThis as Record<string, unknown>).__clicked).toBe(1);

        // Cleanup: tras unmount la reactividad queda desconectada.
        handle.unmount();
        label.value = "post";
        sel.value = 2;
        await flush();
        expect(container.querySelector("td")?.textContent).not.toBe("post");
        container.remove();
    });

    it("repeat compilado: SSR keyed + hidratación adoptiva + reconcile vivo", async () => {
        const code = `
import { html, repeat } from "@elurjs/core";
export const list = (rows) => html\`
  <tbody>\${() => repeat(rows.value, r => r.id, r => html\`<tr><td>\${r.label}</td></tr>\`)}</tbody>
\`;
`;
        const out = transform(code)!;
        const mod = await importTransformed(out);
        const list = mod.list as (rows: unknown) => unknown;

        const rows = signal([
            { id: 1, label: "a" },
            { id: 2, label: "b" },
        ]);
        const instance = list(rows);

        // SSR: markers keyed `elur-ki:` + boundary — sin data-elur-*.
        const htmlOut = await renderToString(instance, { markers: "hydration" });
        expect(htmlOut).toContain("elur-ki:");
        expect(htmlOut).not.toContain("data-elur-");
        expect(htmlOut).toContain(">a<");
        expect(htmlOut).toContain(">b<");

        // El root del template es <tbody> — el container padre es <table>
        // (tbody en div es HTML inválido y el parser lo descarta).
        const container = document.createElement("table");
        container.innerHTML = htmlOut;
        document.body.appendChild(container);
        const trBefore = container.querySelectorAll("tr");

        const handle = hydrate(instance as never, container);
        expect(container.querySelectorAll("tr").length).toBe(2);
        // Adopción: los <tr> SSR son los mismos nodos (no recreados).
        expect(container.querySelectorAll("tr")[0]).toBe(trBefore[0]);

        // Reconcile vivo: reordenar + añadir reusa nodos adoptados.
        rows.value = [
            { id: 2, label: "b" },
            { id: 3, label: "c" },
            { id: 1, label: "a" },
        ];
        await flush();
        const trs = container.querySelectorAll("tr");
        expect(trs.length).toBe(3);
        expect(trs[0].textContent).toBe("b");
        expect(trs[2].textContent).toBe("a");
        // El nodo de id=1 es el SSR original (movido, no recreado).
        expect(trs[2]).toBe(trBefore[0]);

        handle.unmount();
        container.remove();
    });

    it("mismatch estructural → hydrate() remonta (semántica preservada)", async () => {
        const code = `
import { html } from "@elurjs/core";
export const card = (t) => html\`<div><h1>\${t}</h1><p>\${t}</p></div>\`;
`;
        const out = transform(code)!;
        const mod = await importTransformed(out);
        const card = mod.card as (t: unknown) => unknown;

        const t = signal("hi");
        const instance = card(t);
        const container = document.createElement("div");
        // DOM con estructura incompatible: falta el <p>.
        container.innerHTML = "<div><h1>hi</h1></div>";

        const handle = hydrate(instance as never, container, { mismatch: "remount" });
        expect(container.querySelector("p")).not.toBeNull();
        t.value = "bye";
        await flush();
        expect(container.querySelector("h1")!.textContent).toBe("bye");
        handle.unmount();
    });
});

describe("C.16 — compiled repeat fast paths (prefix/suffix)", () => {
    it("append/prepend/window-remove preservan nodos", async () => {
        const { __elurCompiledRepeatDirect } = await import("../runtime/compiler.js");
        const { ELUR_RENDER_PROTOCOL } = await import("@elurjs/core/template");
        const items = signal([{ id: 1 }, { id: 2 }, { id: 3 }]);
        const parent = document.createElement("div");
        const rep = __elurCompiledRepeatDirect(
            () => items.value,
            (it: { id: number }) => it.id,
            (p: Node, b: Node | null, it: { id: number }) => {
                const li = document.createElement("li");
                li.textContent = String(it.id);
                p.insertBefore(li, b);
                return () => li.remove();
            },
        ) as Record<symbol, { mountDom(c: { parent: Node; before: Node | null }): () => void }>;
        const dispose = rep[ELUR_RENDER_PROTOCOL].mountDom({ parent, before: null });
        const lis = () => [...parent.querySelectorAll("li")];
        const ids = () => lis().map((l) => l.textContent);

        const n1 = lis();
        items.value = [...items.value, { id: 4 }]; // append
        await flush();
        expect(ids()).toEqual(["1", "2", "3", "4"]);
        expect(lis()[0]).toBe(n1[0]);
        expect(lis()[2]).toBe(n1[2]);

        items.value = [{ id: 0 }, ...items.value]; // prepend
        await flush();
        expect(ids()).toEqual(["0", "1", "2", "3", "4"]);
        expect(lis()[1]).toBe(n1[0]);

        const n2 = lis();
        items.value = items.value.filter((x) => x.id !== 2 && x.id !== 3); // window remove
        await flush();
        expect(ids()).toEqual(["0", "1", "4"]);
        expect(lis()[0]).toBe(n2[0]);
        expect(lis()[1]).toBe(n2[1]);
        expect(lis()[2]).toBe(n2[4]);

        items.value = []; // clear — bulk
        await flush();
        expect(ids()).toEqual([]);
        dispose();
    });
});

describe("C.9 constant folding e2e", () => {
    it("literales se hornean en optimizedHtml sin perder paridad SSR", async () => {
        const out = transform(`
import { html, signal } from "@elurjs/core";
const s = signal("x");
export const t = () => html\`<div class=\${"active"} id="s-\${s}">\${42} <b>\${s}</b></div>\`;
`)!;
        expect(out).toContain('class=\\"active\\"');
        expect(out).toContain('>42 <b>');
        expect(out).toContain('"active"'); // arg conservado para SSR

        // e2e real: SSR renderiza el literal + hydrate conecta lo reactivo
        const mod = await importTransformed(out);
        const inst = (mod as { t: () => unknown }).t();
        const htmlStr = await renderToString(inst as never, { markers: "hydration" });
        expect(htmlStr).toContain('class="active"');
        expect(htmlStr).toContain("42");
        expect(htmlStr).toContain('id="s-x"'); // compose desenvuelve el signal

        const host = document.createElement("div");
        host.innerHTML = htmlStr;
        document.body.appendChild(host);
        const handle = hydrate(inst as never, host);
        const div = host.querySelector("div")!;
        expect(div.className).toBe("active");
        expect(div.textContent).toContain("42");

        handle.unmount();
        host.remove();
    });
});
