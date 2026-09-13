import { describe, it, expect, beforeEach, vi } from "vitest";
import { html } from "@elurjs/core";
import elurJsPlugin from "../index.js";
import {
    __elurGetOrCreateSignal,
    __elurGetOrCreateForm,
    __elurGetOrCreateStore,
    __elurGetOrCreateRouter,
    __elurMount,
    __elurHmrAccept,
    __elurDerive,
    __elurDerive1,
    __elurBindDerivedText,
    __elurBindDerivedAttr,
    __elurGenericAttr,
    __elurGenericEvent,
    getElurHmrRuntime,
} from "../runtime.js";

function transform(code: string, id = "src/app.ts") {
    const plugin = elurJsPlugin();
    const result = (plugin.transform as Function)(code, id);
    return typeof result === "string" ? result : result?.code ?? null;
}

beforeEach(() => {
    const runtime = getElurHmrRuntime();
    runtime.mounts.clear();
    runtime.signals.clear();
    runtime.forms.clear();
    runtime.stores.clear();
    runtime.routers.clear();
});

describe("HMR transform", () => {
    it("wraps top-level signal declarations", () => {
        const code = `
import { signal, mount } from "@elurjs/core";
const count = signal(0);
mount(App, "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).toContain('__elurGetOrCreateSignal("src/app.ts:count"');
        expect(out).toContain("__elurMount");
    });

    it("wraps top-level form declarations", () => {
        const code = `
import { createForm } from "@elurjs/core/form";
const form = createForm({ name: "" });
mount(App, "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).toContain('__elurGetOrCreateForm("src/app.ts:form"');
    });

    it("does not wrap signal declarations inside functions", () => {
        const code = `
import { signal, mount } from "@elurjs/core";
function Counter() {
  const count = signal(0);
}
mount(Counter, "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).not.toContain('__elurGetOrCreateSignal("src/app.ts:count"');
        expect(out).toContain("__elurMount");
    });

    it("returns null when there is nothing to preserve", () => {
        const code = `console.log("hello");`;
        expect(transform(code, "src/util.ts")).toBeNull();
    });

    it("detects signals from @elurjs/core/signals", () => {
        const code = `
import { signal } from "@elurjs/core/signals";
import { mount } from "@elurjs/core";
const count = signal(0);
mount(App, "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).toContain('__elurGetOrCreateSignal("src/app.ts:count"');
    });

    it("detects forms from @elurjs/core/form", () => {
        const code = `
import { createForm } from "@elurjs/core/form";
import { mount } from "@elurjs/core";
const form = createForm({ name: "" });
mount(App, "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).toContain('__elurGetOrCreateForm("src/app.ts:form"');
    });

    it("wraps multiple mount points independently", () => {
        const code = `
import { mount } from "@elurjs/core";
mount(App, "#app");
mount(Widget, "#widget");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).toContain('__elurMount("src/app.ts#0"');
        expect(out).toContain('__elurMount("src/app.ts#1"');
    });

    it("wraps mount assigned to a variable", () => {
        const code = `
import { mount } from "@elurjs/core";
const handle = mount(App, "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).toContain('const handle = __elurMount("src/app.ts#0"');
    });

    it("wraps async component mounts", () => {
        const code = `
import { mount } from "@elurjs/core";
mount(await loadApp(), "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).toContain("async () =>");
        expect(out).toContain("__elurMount");
    });

    it("does not transform non-elur signal-looking calls", () => {
        const code = `
import { mount } from "@elurjs/core";
const signal = customSignalFactory();
const count = signal(0);
mount(App, "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).not.toContain("__elurGetOrCreateSignal");
    });

    it("handles aliased imports", () => {
        const code = `
import { signal as s, createForm as f, mount as m } from "@elurjs/core";
const count = s(0);
const form = f({ name: "" });
m(App, "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).toContain('__elurGetOrCreateSignal("src/app.ts:count"');
        expect(out).toContain('__elurGetOrCreateForm("src/app.ts:form"');
        expect(out).toContain("__elurMount");
    });

    it("supports TypeScript type annotations", () => {
        const code = `
import { signal, mount } from "@elurjs/core";
const count: Signal<number> = signal(0) as any;
mount(App, "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).toContain('__elurGetOrCreateSignal("src/app.ts:count"');
    });
});

describe("compiler transform", () => {
    it("generates an imperative single-root renderer", () => {
        const code = `
import { html } from "@elurjs/core";
export const row = (item, selected) => html\`
  <tr class=\${() => item.id === selected.value ? "danger" : ""}>
    <td>\${item.id}</td>
    <td><a @click=\${() => item.select()}>\${() => item.label.value}</a></td>
  </tr>
\`;
`;
        const out = transform(code)!;
        expect(out).toContain("__elurCreateTemplate");
        expect(out).toContain("__elurCreateTemplatePrototype");
        // Events without modifiers are inlined as __elur_click = handler
        expect(out).toContain(".__elur_click");
        expect(out).toContain("Object.create");
        expect(out).not.toContain("__elurCompiledTemplate(");
    });

    it("lowers a reactive repeat call to a compiled keyed block", () => {
        const code = `
import { html, repeat } from "@elurjs/core";
export const view = (rows) => html\`<tbody>\${() => repeat(rows.value, row => row.id, row => html\`<tr><td>\${row.id}</td></tr>\`)}</tbody>\`;
`;
        const out = transform(code)!;
        expect(out).toContain("__elurCompiledRepeatDirect");
        expect(out).toContain("$mount(parent, before");
        expect(out).toContain("() => rows.value");
    });

    it("C.14: SVG se especializa (namespace-aware en runtime)", () => {
        const code = `
import { html } from "@elurjs/core";
export const icon = (label) => html\`<svg><text>\${() => label.value}</text></svg>\`;
`;
        const out = transform(code)!;
        expect(out).toContain("__elurCreateTemplatePrototype");
        expect(out).not.toContain("__elurCompiledTemplate");
    });

    it("C.14: <template>/<script> con bindings siguen en fallback genérico", () => {
        const code = `
import { html } from "@elurjs/core";
export const t = (x) => html\`<div><script>\${() => x.value}</script></div>\`;
`;
        const out = transform(code)!;
        expect(out).toContain("__elurCompiledTemplate");
    });

    it("T1: lowers () => a.b.value to the signal object and emits __elurBindSignalText", () => {
        const code = `
import { html } from "@elurjs/core";
export const cell = (row) => html\`<td>\${() => row.label.value}</td>\`;
`;
        const out = transform(code)!;
        // The call receives the signal itself, not the getter
        expect(out).toContain("row.label");
        expect(out).not.toContain("() => row.label.value");
        // Factory uses the T1 helper, not the generic node binding
        expect(out).toMatch(/BindSignalText|bindSignalText/i);
        expect(out).not.toMatch(/__elurNode\(.*row\.label/);
    });

    it("T1: lowers () => sig.value in attribute position to the signal object", () => {
        const code = `
import { html } from "@elurjs/core";
export const el = (cls) => html\`<div class=\${() => cls.value}></div>\`;
`;
        const out = transform(code)!;
        expect(out).toMatch(/BindSignalAttr|bindSignalAttr/i);
        expect(out).not.toContain("() => cls.value");
    });

    it("does NOT T1-lower () => getSig().value (call in the chain)", () => {
        const code = `
import { html } from "@elurjs/core";
export const cell = (getSig) => html\`<td>\${() => getSig().value}</td>\`;
`;
        const out = transform(code)!;
        expect(out).toContain("getSig().value");
        expect(out).not.toMatch(/BindSignal/i);
    });

    it("does NOT T1-lower () => a.value.b.value (intermediate .value tracks a)", () => {
        const code = `
import { html } from "@elurjs/core";
export const cell = (a) => html\`<td>\${() => a.value.b.value}</td>\`;
`;
        const out = transform(code)!;
        expect(out).toContain("() => a.value.b.value");
        expect(out).not.toMatch(/BindSignal/i);
    });

    it("does NOT T1-lower computed member reads () => obj[k].value", () => {
        const code = `
import { html } from "@elurjs/core";
export const cell = (obj, k) => html\`<td>\${() => obj[k].value}</td>\`;
`;
        const out = transform(code)!;
        expect(out).toContain("obj[k].value");
        expect(out).not.toMatch(/BindSignal/i);
    });

    it("keeps event-handler arrows as functions even when body reads .value", () => {
        const code = `
import { html } from "@elurjs/core";
export const btn = (sig) => html\`<button @click=\${() => sig.value}>x</button>\`;
`;
        const out = transform(code)!;
        expect(out).toContain("() => sig.value");
        expect(out).not.toMatch(/BindSignal/i);
    });

    it("T2: () => row.id === sel.value ? ... emits __elurDerive1 with static deps", () => {
        const code = `
import { html } from "@elurjs/core";
export const row = (row, sel) => html\`<tr class=\${() => row.id === sel.value ? "danger" : ""}></tr>\`;
`;
        const out = transform(code)!;
        // 1 dep → pack plano sin array: __elurDerive1(dep, get)
        expect(out).toMatch(/__elurDerive1\(.*sel.*=>.*danger/);
        expect(out).toMatch(/BindDerivedAttr|bindDerivedAttr/i);
    });

    it("T2: multi-dep emits __elurDerive with deps array", () => {
        const code = `
import { html } from "@elurjs/core";
export const el = (a, b) => html\`<div class=\${() => a.value + b.value > 3 ? "hot" : "cold"}></div>\`;
`;
        const out = transform(code)!;
        expect(out).toMatch(/__elurDerive\(.*a.*b.*=>/);
        expect(out).toMatch(/BindDerivedAttr|bindDerivedAttr/i);
    });

    it("T2: combines T1 and T2 bindings in the same template", () => {
        const code = `
import { html } from "@elurjs/core";
export const row = (row, sel) => html\`
  <tr class=\${() => row.id === sel.value ? "danger" : ""}>
    <td>\${() => row.label.value}</td>
  </tr>\`;
`;
        const out = transform(code)!;
        expect(out).toMatch(/BindSignalText|bindSignalText/i);
        expect(out).toMatch(/BindDerivedAttr|bindDerivedAttr/i);
    });

    it("does NOT T2-lower expressions containing calls () => getA().value + 1", () => {
        const code = `
import { html } from "@elurjs/core";
export const el = (getA) => html\`<div class=\${() => getA().value + 1}></div>\`;
`;
        const out = transform(code)!;
        expect(out).not.toMatch(/__elurDerive|BindDerived/i);
        expect(out).toContain("getA().value");
    });

    it("does NOT T2-lower expressions with hidden reads () => f(x.value)", () => {
        const code = `
import { html } from "@elurjs/core";
export const el = (f, x) => html\`<div class=\${() => f(x.value)}></div>\`;
`;
        const out = transform(code)!;
        expect(out).not.toMatch(/__elurDerive|BindDerived/i);
    });

    it("does NOT T2-lower assignments () => (a.value = 2)", () => {
        const code = `
import { html } from "@elurjs/core";
export const el = (a) => html\`<div class=\${() => (a.value = 2)}></div>\`;
`;
        const out = transform(code)!;
        expect(out).not.toMatch(/__elurDerive|BindDerived/i);
    });
});

describe("T2 derived bindings runtime", () => {
    it("__elurDerive packs deps + getter", () => {
        const s = { value: 1 };
        const packed = __elurDerive(s, () => s.value * 2);
        expect(packed.deps).toEqual([s]);
        expect(packed.get()).toBe(2);
    });

    it("__elurDerive1 packs a flat dep + getter (no array)", () => {
        const s = { value: 1 };
        const packed = __elurDerive1(s, () => s.value * 2);
        expect(packed.dep).toBe(s);
        expect(packed.deps).toBeUndefined();
        expect(packed.get()).toBe(2);
    });

    it("derived text binding via 1-dep pack follows dep changes", async () => {
        const { signal } = await import("@elurjs/core");
        const s = signal("a");
        const text = document.createTextNode("");
        const dispose = __elurBindDerivedText(text, __elurDerive1(s, () => s.value + "!"));

        expect(text.data).toBe("a!");
        s.value = "b";
        expect(text.data).toBe("b!");
        dispose();
        s.value = "c";
        expect(text.data).toBe("b!");
    });

    it("derived text binding writes once and follows dep changes", async () => {
        const { signal } = await import("@elurjs/core");
        const s = signal("a");
        const text = document.createTextNode("");
        const dispose = __elurBindDerivedText(text, __elurDerive(s, () => s.value + "!"));

        expect(text.data).toBe("a!");
        s.value = "b";
        // stable effect fallback is sync for subs; DOM writes may queue — the
        // text.data write inside the binding is sync in both paths.
        expect(text.data).toBe("b!");
        dispose();
        s.value = "c";
        expect(text.data).toBe("b!");
    });

    it("derived attr binding updates className and dedupes equal values", async () => {
        const { signal } = await import("@elurjs/core");
        const id = signal(1);
        const sel = signal(1);
        const el = document.createElement("tr");
        const dispose = __elurBindDerivedAttr(
            el,
            "class",
            __elurDerive(sel, () => (id.value === sel.value ? "danger" : "")),
            false,
            false,
        );

        expect(el.className).toBe("danger");
        sel.value = 2;
        await Promise.resolve(); // attr writer queues non-first DOM writes
        expect(el.className).toBe("");
        sel.value = 2; // no change → still consistent
        await Promise.resolve();
        expect(el.className).toBe("");
        dispose();
    });
});

describe("HMR runtime", () => {
    it("preserves signal instances across calls", () => {
        const a = __elurGetOrCreateSignal("src/app.ts:count", () => ({ value: 0 }));
        a.value = 5;
        const b = __elurGetOrCreateSignal("src/app.ts:count", () => ({ value: 0 }));
        expect(b.value).toBe(5);
    });

    it("preserves form instances across calls", () => {
        const a = __elurGetOrCreateForm("src/app.ts:form", () => ({ name: "a" }));
        (a as { name: string }).name = "b";
        const b = __elurGetOrCreateForm("src/app.ts:form", () => ({ name: "a" }));
        expect((b as { name: string }).name).toBe("b");
    });

    it("preserves store and router instances across calls", () => {
        const storeA = __elurGetOrCreateStore("src/app.ts:store", () => ({ count: 0 }));
        (storeA as { count: number }).count = 10;
        const storeB = __elurGetOrCreateStore("src/app.ts:store", () => ({ count: 0 }));
        expect((storeB as { count: number }).count).toBe(10);

        const routerA = __elurGetOrCreateRouter("src/app.ts:router", () => ({ path: "/" }));
        (routerA as { path: string }).path = "/about";
        const routerB = __elurGetOrCreateRouter("src/app.ts:router", () => ({ path: "/" }));
        expect((routerB as { path: string }).path).toBe("/about");
    });

    it("remounts a module while preserving its registered signals", () => {
        const container = document.createElement("div");
        document.body.appendChild(container);

        const factory = () => {
            const s = __elurGetOrCreateSignal("src/app.ts:count", () => ({ value: 0 }));
            s.value = 7;
            return html`<span>${() => s.value}</span>`;
        };

        __elurMount("src/app.ts#0", factory, container);
        expect(container.textContent).toBe("7");

        const updatedFactory = () => {
            const s = __elurGetOrCreateSignal("src/app.ts:count", () => ({ value: 0 }));
            return html`<span>${() => s.value}</span>`;
        };

        const runtime = getElurHmrRuntime();
        const record = runtime.mounts.get("src/app.ts#0")!;
        record.factory = updatedFactory;

        __elurHmrAccept({}, "src/app.ts");
        expect(container.textContent).toBe("7");

        container.remove();
    });
});

describe("C.3 per-binding fallback helpers", () => {
    it("__elurGenericAttr ref: asigna y limpia ElurRef", () => {
        const el = document.createElement("div");
        const r = { el: null as Element | null };
        const dispose = __elurGenericAttr(el, "ref", r, false, false);
        expect(r.el).toBe(el);
        dispose();
        expect(r.el).toBeNull();
    });

    it("__elurGenericAttr show/hide: toggle display con valor y función", async () => {
        const { signal } = await import("@elurjs/core");
        const el = document.createElement("div");
        const visible = signal(true);
        const dispose = __elurGenericAttr(el, "show", () => visible.value, false, false);
        expect(el.style.display).not.toBe("none");
        visible.value = false;
        await Promise.resolve();
        expect(el.style.display).toBe("none");
        visible.value = true;
        await Promise.resolve();
        expect(el.style.display).not.toBe("none");
        dispose();
    });

    it("__elurGenericAttr show: acepta Signal directo (T1)", async () => {
        const { signal } = await import("@elurjs/core");
        const el = document.createElement("div");
        const visible = signal(false);
        const dispose = __elurGenericAttr(el, "show", visible, false, false);
        expect(el.style.display).toBe("none");
        visible.value = true;
        await Promise.resolve();
        expect(el.style.display).not.toBe("none");
        dispose();
    });

    it("__elurGenericAttr hide: estático falso → none", () => {
        const el = document.createElement("div");
        __elurGenericAttr(el, "hide", true, false, false);
        expect(el.style.display).toBe("none");
    });

    it("__elurGenericAttr class reactiva via pack derivado", async () => {
        const { signal } = await import("@elurjs/core");
        const s = signal(0);
        const el = document.createElement("div");
        const dispose = __elurGenericAttr(
            el, "class",
            __elurDerive(s, () => (s.value > 0 ? "on" : "off")),
            false, false,
        );
        expect(el.className).toBe("off");
        s.value = 1;
        await Promise.resolve();
        expect(el.className).toBe("on");
        dispose();
    });

    it("__elurGenericEvent: listener directo honra once y stop", () => {
        const el = document.createElement("button");
        document.body.appendChild(el);
        let calls = 0;
        const dispose = __elurGenericEvent(el, "custom-x", ["once"], () => calls++);
        el.dispatchEvent(new Event("custom-x", { bubbles: true }));
        el.dispatchEvent(new Event("custom-x", { bubbles: true }));
        expect(calls).toBe(1);
        dispose();
        el.remove();
    });

    it("__elurGenericEvent: self ignora eventos de hijos", () => {
        const el = document.createElement("div");
        const child = document.createElement("span");
        el.appendChild(child);
        document.body.appendChild(el);
        let calls = 0;
        __elurGenericEvent(el, "custom-y", ["self"], () => calls++);
        child.dispatchEvent(new Event("custom-y", { bubbles: true }));
        el.dispatchEvent(new Event("custom-y", { bubbles: true }));
        expect(calls).toBe(1);
        el.remove();
    });
});

describe("C.17 ABI + runtime split", () => {
    it("el código compilado emite __elurAbi(1) e importa de runtime/compiler", () => {
        const code = `
import { html } from "@elurjs/core";
export const card = (t) => html\`<div><h1>\${t}</h1></div>\`;
`;
        const out = transform(code)!;
        expect(out).toContain('from "@elurjs/vite-plugin-elur/runtime/compiler"');
        expect(out).toContain("__elurAbi(1);");
        expect(out).not.toContain('"@elurjs/vite-plugin-elur/runtime"');
    });

    it("__elurAbi valida la versión soportada sin lanzar en match", async () => {
        const { __elurAbi, ELUR_COMPILER_ABI } = await import("../runtime/compiler.js");
        const err = vi.spyOn(console, "error").mockImplementation(() => { });
        __elurAbi(ELUR_COMPILER_ABI);
        expect(err).not.toHaveBeenCalled();
        __elurAbi(ELUR_COMPILER_ABI + 1);
        expect(err).toHaveBeenCalledOnce();
        expect(err.mock.calls[0][0]).toContain("ABI mismatch");
        err.mockRestore();
    });

    it("assertCompilerAbi lanza en mismatch (check build-time)", async () => {
        const { assertCompilerAbi, ELUR_COMPILER_ABI } = await import("../runtime/abi.js");
        expect(() => assertCompilerAbi(ELUR_COMPILER_ABI, ELUR_COMPILER_ABI)).not.toThrow();
        expect(() => assertCompilerAbi(ELUR_COMPILER_ABI + 1, ELUR_COMPILER_ABI)).toThrow(
            /ABI 2.*soporta 1/,
        );
    });

    it("el transform HMR importa de runtime/hmr, no del barrel", () => {
        const code = `
import { signal, mount } from "@elurjs/core";
const c = signal(0);
mount(() => html\`<div>\${c.value}</div>\`, "#app");
`;
        // hmrTransform solo corre fuera de build — el transform del test es
        // el path dev completo.
        const out = transform(code)!;
        expect(out).toContain('from "@elurjs/vite-plugin-elur/runtime/hmr"');
    });
});

describe("C.10/C.11 — single-pass pipeline + sourcemaps", () => {
    it("el transform devuelve un sourcemap real alineado al archivo", () => {
        const plugin = elurJsPlugin();
        const code = `import { html, signal } from "@elurjs/core";
const c = signal(0);
export const t = () => html\`<div>\${c}</div>\`;
`;
        const out = (plugin.transform as Function)(code, "src/app.ts") as { code: string; map: { mappings: string; sources: string[] } | null };
        expect(out).not.toBeNull();
        expect(out.map).not.toBeNull();
        expect(out.map!.sources[0]).toContain("src/app.ts");
        expect(out.map!.mappings.length).toBeGreaterThan(0);
        // El código transformado sigue siendo válido y compilado.
        expect(out.code).toContain("__elurCreateTemplate");
        expect(out.code).toContain("__elurAbi(1)");
    });

    it("módulo sin elur no se toca (early-out)", () => {
        const plugin = elurJsPlugin();
        const out = (plugin.transform as Function)("export const x = 1;", "src/plain.ts");
        expect(out).toBeNull();
    });
});
