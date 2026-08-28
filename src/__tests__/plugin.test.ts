import { describe, it, expect, beforeEach } from "vitest";
import { html } from "@elurjs/core";
import elurJsPlugin from "../index.js";
import {
    __elurGetOrCreateSignal,
    __elurGetOrCreateForm,
    __elurGetOrCreateStore,
    __elurGetOrCreateRouter,
    __elurMount,
    __elurHmrAccept,
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

    it("uses the generic compiled fallback for SVG", () => {
        const code = `
import { html } from "@elurjs/core";
export const icon = (label) => html\`<svg><text>\${() => label.value}</text></svg>\`;
`;
        const out = transform(code)!;
        expect(out).toContain("__elurCompiledTemplate");
        expect(out).not.toContain("__elurCreateTemplatePrototype");
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
