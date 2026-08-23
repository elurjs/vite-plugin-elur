import { describe, it, expect, beforeEach } from "vitest";
import { html } from "@deijose/nix-js";
import nixPlugin from "../index.js";
import {
    __nixGetOrCreateSignal,
    __nixGetOrCreateForm,
    __nixGetOrCreateStore,
    __nixGetOrCreateRouter,
    __nixMount,
    __nixHmrAccept,
    getNixHmrRuntime,
} from "../runtime.js";

function transform(code: string, id = "src/app.ts") {
    const plugin = nixPlugin();
    const result = (plugin.transform as Function)(code, id);
    return typeof result === "string" ? result : result?.code ?? null;
}

beforeEach(() => {
    const runtime = getNixHmrRuntime();
    runtime.mounts.clear();
    runtime.signals.clear();
    runtime.forms.clear();
    runtime.stores.clear();
    runtime.routers.clear();
});

describe("HMR transform", () => {
    it("wraps top-level signal declarations", () => {
        const code = `
import { signal, mount } from "@deijose/nix-js";
const count = signal(0);
mount(App, "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).toContain('__nixGetOrCreateSignal("src/app.ts:count"');
        expect(out).toContain("__nixMount");
    });

    it("wraps top-level form declarations", () => {
        const code = `
import { createForm } from "@deijose/nix-js/form";
const form = createForm({ name: "" });
mount(App, "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).toContain('__nixGetOrCreateForm("src/app.ts:form"');
    });

    it("does not wrap signal declarations inside functions", () => {
        const code = `
import { signal, mount } from "@deijose/nix-js";
function Counter() {
  const count = signal(0);
}
mount(Counter, "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).not.toContain('__nixGetOrCreateSignal("src/app.ts:count"');
        expect(out).toContain("__nixMount");
    });

    it("returns null when there is nothing to preserve", () => {
        const code = `console.log("hello");`;
        expect(transform(code, "src/util.ts")).toBeNull();
    });

    it("detects signals from @deijose/nix-js/signals", () => {
        const code = `
import { signal } from "@deijose/nix-js/signals";
import { mount } from "@deijose/nix-js";
const count = signal(0);
mount(App, "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).toContain('__nixGetOrCreateSignal("src/app.ts:count"');
    });

    it("detects forms from @deijose/nix-js/form", () => {
        const code = `
import { createForm } from "@deijose/nix-js/form";
import { mount } from "@deijose/nix-js";
const form = createForm({ name: "" });
mount(App, "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).toContain('__nixGetOrCreateForm("src/app.ts:form"');
    });

    it("wraps multiple mount points independently", () => {
        const code = `
import { mount } from "@deijose/nix-js";
mount(App, "#app");
mount(Widget, "#widget");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).toContain('__nixMount("src/app.ts#0"');
        expect(out).toContain('__nixMount("src/app.ts#1"');
    });

    it("wraps mount assigned to a variable", () => {
        const code = `
import { mount } from "@deijose/nix-js";
const handle = mount(App, "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).toContain('const handle = __nixMount("src/app.ts#0"');
    });

    it("wraps async component mounts", () => {
        const code = `
import { mount } from "@deijose/nix-js";
mount(await loadApp(), "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).toContain("async () =>");
        expect(out).toContain("__nixMount");
    });

    it("does not transform non-nix signal-looking calls", () => {
        const code = `
import { mount } from "@deijose/nix-js";
const signal = customSignalFactory();
const count = signal(0);
mount(App, "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).not.toContain("__nixGetOrCreateSignal");
    });

    it("handles aliased imports", () => {
        const code = `
import { signal as s, createForm as f, mount as m } from "@deijose/nix-js";
const count = s(0);
const form = f({ name: "" });
m(App, "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).toContain('__nixGetOrCreateSignal("src/app.ts:count"');
        expect(out).toContain('__nixGetOrCreateForm("src/app.ts:form"');
        expect(out).toContain("__nixMount");
    });

    it("supports TypeScript type annotations", () => {
        const code = `
import { signal, mount } from "@deijose/nix-js";
const count: Signal<number> = signal(0) as any;
mount(App, "#app");
`;
        const out = transform(code, "src/app.ts")!;
        expect(out).toContain('__nixGetOrCreateSignal("src/app.ts:count"');
    });
});

describe("HMR runtime", () => {
    it("preserves signal instances across calls", () => {
        const a = __nixGetOrCreateSignal("src/app.ts:count", () => ({ value: 0 }));
        a.value = 5;
        const b = __nixGetOrCreateSignal("src/app.ts:count", () => ({ value: 0 }));
        expect(b.value).toBe(5);
    });

    it("preserves form instances across calls", () => {
        const a = __nixGetOrCreateForm("src/app.ts:form", () => ({ name: "a" }));
        (a as { name: string }).name = "b";
        const b = __nixGetOrCreateForm("src/app.ts:form", () => ({ name: "a" }));
        expect((b as { name: string }).name).toBe("b");
    });

    it("preserves store and router instances across calls", () => {
        const storeA = __nixGetOrCreateStore("src/app.ts:store", () => ({ count: 0 }));
        (storeA as { count: number }).count = 10;
        const storeB = __nixGetOrCreateStore("src/app.ts:store", () => ({ count: 0 }));
        expect((storeB as { count: number }).count).toBe(10);

        const routerA = __nixGetOrCreateRouter("src/app.ts:router", () => ({ path: "/" }));
        (routerA as { path: string }).path = "/about";
        const routerB = __nixGetOrCreateRouter("src/app.ts:router", () => ({ path: "/" }));
        expect((routerB as { path: string }).path).toBe("/about");
    });

    it("remounts a module while preserving its registered signals", () => {
        const container = document.createElement("div");
        document.body.appendChild(container);

        const factory = () => {
            const s = __nixGetOrCreateSignal("src/app.ts:count", () => ({ value: 0 }));
            s.value = 7;
            return html`<span>${() => s.value}</span>`;
        };

        __nixMount("src/app.ts#0", factory, container);
        expect(container.textContent).toBe("7");

        const updatedFactory = () => {
            const s = __nixGetOrCreateSignal("src/app.ts:count", () => ({ value: 0 }));
            return html`<span>${() => s.value}</span>`;
        };

        const runtime = getNixHmrRuntime();
        const record = runtime.mounts.get("src/app.ts#0")!;
        record.factory = updatedFactory;

        __nixHmrAccept({}, "src/app.ts");
        expect(container.textContent).toBe("7");

        container.remove();
    });
});
