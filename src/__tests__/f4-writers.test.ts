import { describe, it, expect } from "vitest";
import { signal } from "@elurjs/core";
import {
    __elurAttrWriterHtml,
    __elurBindSignalAttrHtml,
    __elurBindDerivedAttrHtml,
    __elurBindSignalText,
    __elurDerive1,
} from "../runtime.js";

// F4: writers HTML resueltos en build — el codegen sólo los emite para
// ns=html + attr no-URL + no-ejecutable, así que aquí se valida la semántica
// idéntica al path genérico: class→className, props DOM, null/false → remove.

const flush = () => new Promise<void>((r) => queueMicrotask(r));

describe("F4: __elurAttrWriterHtml — writers especializados por tipo", () => {
    it("class → className; null/false → removeAttribute", async () => {
        const el = document.createElement("div");
        const write = __elurAttrWriterHtml(el, "class");
        write("a b"); // primera escritura: síncrona
        expect(el.className).toBe("a b");

        write(null);
        await flush();
        expect(el.hasAttribute("class")).toBe(false);

        write("x");
        await flush();
        expect(el.className).toBe("x");

        write(false);
        await flush();
        expect(el.hasAttribute("class")).toBe(false);
    });

    it("class coacciona no-strings igual que el writer genérico", async () => {
        const el = document.createElement("div");
        const write = __elurAttrWriterHtml(el, "class");
        write(5 as unknown as string);
        expect(el.className).toBe("5");
        write(true as unknown as string);
        await flush();
        expect(el.className).toBe("true");
    });

    it("attr plano → setAttribute/removeAttribute", async () => {
        const el = document.createElement("div");
        const write = __elurAttrWriterHtml(el, "title");
        write("hello");
        expect(el.getAttribute("title")).toBe("hello");

        write(undefined);
        await flush();
        expect(el.hasAttribute("title")).toBe(false);
    });

    it("prop DOM conocida (checked) → asignación de propiedad", async () => {
        const el = document.createElement("input");
        el.type = "checkbox";
        const write = __elurAttrWriterHtml(el, "checked");
        write(true);
        expect(el.checked).toBe(true);
        expect(el.hasAttribute("checked")).toBe(false);

        write(null); // null ?? "" → falsy (happy-dom guarda "", browser → false)
        await flush();
        expect(el.checked).toBeFalsy();
    });

    it("dedup: writes múltiples antes del flush ejecutan sólo el último", async () => {
        const el = document.createElement("div");
        const write = __elurAttrWriterHtml(el, "class");
        write("first");
        write("second");
        write("third");
        await flush();
        await flush();
        expect(el.className).toBe("third");
    });
});

describe("F4: binds T1/T2 con writer HTML", () => {
    it("__elurBindSignalAttrHtml sigue la señal en className", async () => {
        const el = document.createElement("div");
        const sig = signal("off");
        __elurBindSignalAttrHtml(el, "class", sig);
        expect(el.className).toBe("off");

        sig.value = "on";
        await flush();
        expect(el.className).toBe("on");

        sig.value = null as unknown as string;
        await flush();
        expect(el.hasAttribute("class")).toBe(false);
    });

    it("__elurBindDerivedAttrHtml evalúa el pack derivado en className", async () => {
        const el = document.createElement("div");
        const sig = signal(false);
        __elurBindDerivedAttrHtml(
            el,
            "class",
            __elurDerive1(sig, () => (sig.value ? "active" : "idle")),
        );
        expect(el.className).toBe("idle");

        sig.value = true;
        await flush();
        expect(el.className).toBe("active");
    });

    it("__elurBindSignalText escribe text.data sin String() extra", async () => {
        const text = document.createTextNode("");
        const sig = signal<unknown>(1);
        __elurBindSignalText(text, sig);
        expect(text.data).toBe("1");

        sig.value = "hola";
        await flush();
        expect(text.data).toBe("hola");

        sig.value = null;
        await flush();
        expect(text.data).toBe("");
    });
});
