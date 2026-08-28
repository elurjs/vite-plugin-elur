import { describe, it, expect } from "vitest";
import { transformInterpolation } from "../interpolation.js";

function transform(code: string): string | null {
    return transformInterpolation(code, "src/test.ts");
}

describe("transformInterpolation", () => {
    it("returns null when no html`` template", () => {
        expect(transform(`const x = 1;`)).toBeNull();
    });

    it("returns null when no partials", () => {
        const code = "const t = html`<div class=${cls}>${body}</div>`;";
        expect(transform(code)).toBeNull();
    });

    it("transforms simple partial: class=\"btn ${size}\"", () => {
        const code = "const t = html`<div class=\"btn ${size}\">hello</div>`;";
        const out = transform(code);
        expect(out).not.toBeNull();
        expect(out!).toContain("__elurCompose");
        expect(out!).toContain('"btn "');
        expect(out!).toContain("size");
        expect(out!).toContain('""');
    });

    it("transforms multi-segment partial: class=\"btn ${a} size-${b}\"", () => {
        const code = "const t = html`<div class=\"btn ${a} size-${b}\">x</div>`;";
        const out = transform(code);
        expect(out).not.toBeNull();
        expect(out!).toContain("__elurCompose");
        expect(out!).toContain('"btn "');
        expect(out!).toContain('" size-"');
        expect(out!).toContain('""');
    });

    it("transforms full interpolation with static: class=\"${a}\"", () => {
        const code = "const t = html`<div class=\"${a}\">x</div>`;";
        // Full interpolation in quotes — no static segments — passthrough
        expect(transform(code)).toBeNull();
    });

    it("transforms unquoted partial: class=btn-${size}", () => {
        const code = "const t = html`<div class=btn-${size}>x</div>`;";
        const out = transform(code);
        expect(out).not.toBeNull();
        expect(out!).toContain("__elurCompose");
        expect(out!).toContain('"btn-"');
    });

    it("transforms multiple attributes in same tag", () => {
        const code = "const t = html`<a href=\"/x/${id}\" class=\"link ${cls}\">x</a>`;";
        const out = transform(code);
        expect(out).not.toBeNull();
        expect(out!).toContain("__elurCompose");
        expect(out!).toContain('"/x/"');
        expect(out!).toContain('"link "');
    });

    it("preserves full bindings alongside partials", () => {
        const code = "const t = html`<div class=\"btn ${size}\" id=${id}>x</div>`;";
        const out = transform(code);
        expect(out).not.toBeNull();
        // id=${id} should remain as a direct expression
        expect(out!).toContain("id");
    });

    it("rejects partial on @event", () => {
        const code = "const t = html`<button @click=\"btn ${handler}\">x</button>`;";
        expect(() => transform(code)).toThrow(/event binding/);
    });

    it("rejects partial on boolean attribute", () => {
        const code = "const t = html`<input checked=\"x ${val}\">`;";
        expect(() => transform(code)).toThrow(/boolean attribute/);
    });

    it("rejects partial on ref directive", () => {
        const code = "const t = html`<div ref=\"x ${val}\">x</div>`;";
        expect(() => transform(code)).toThrow(/directive/);
    });

    it("handles multiple html`` templates in same file", () => {
        const code = `
const a = html\`<div class="btn $\{size}">x</div>\`;
const b = html\`<span class="label $\{cls}">y</span>\`;
`;
        const out = transform(code);
        expect(out).not.toBeNull();
        // Count calls (exclude the import statement)
        const composeCount = (out!.match(/__elurCompose\(/g) || []).length;
        expect(composeCount).toBe(2);
    });

    it("injects __elurCompose import", () => {
        const code = "const t = html`<div class=\"btn ${size}\">x</div>`;";
        const out = transform(code);
        expect(out).not.toBeNull();
        expect(out!).toContain('import { __elurCompose } from "@elurjs/vite-plugin-elur/runtime"');
    });

    it("does not inject import when no partials", () => {
        const code = "const t = html`<div class=${cls}>x</div>`;";
        expect(transform(code)).toBeNull();
    });

    it("handles comments in template", () => {
        const code = "const t = html`<!-- comment --><div class=\"btn ${size}\">x</div>`;";
        const out = transform(code);
        expect(out).not.toBeNull();
        expect(out!).toContain("__elurCompose");
    });

    it("handles raw-text tags (script/style)", () => {
        const code = "const t = html`<style>.x{}</style><div class=\"btn ${size}\">x</div>`;";
        const out = transform(code);
        expect(out).not.toBeNull();
        expect(out!).toContain("__elurCompose");
    });

    it("handles nested quotes in attribute value", () => {
        const code = "const t = html`<div data-x=\"a'b ${val}\">x</div>`;";
        const out = transform(code);
        expect(out).not.toBeNull();
        expect(out!).toContain("__elurCompose");
    });
});
