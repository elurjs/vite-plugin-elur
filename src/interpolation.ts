// =============================================================================
// --- Partial attribute interpolation — compile-time transform ---
// =============================================================================
//
// Moved from nix-js-microframework/src/nix/template/attribute-interpolation.ts.
//
// This module runs in the Vite plugin at compile time. It finds `html```
// tagged template expressions, runs the state-machine lexer over the cooked
// strings, and rewrites partial attribute interpolations into full bindings
// using a runtime helper (`__nixCompose`).
//
//   html`<a class="btn ${size} size-${n}">`
//
// becomes:
//
//   html`<a class=${__nixCompose("btn ", size, " size-", n, "")}>`
//
// The core `html()` function never sees partials — it receives a canonical
// template with only full bindings, exactly as it did before the lexer existed.

import { parse } from "@babel/parser";
import _generate from "@babel/generator";
import * as t from "@babel/types";
import _traverse, { type NodePath } from "@babel/traverse";

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;
const generate = ((_generate as unknown as { default?: typeof _generate }).default ?? _generate) as typeof _generate;

// =============================================================================
// --- Reserved attribute semantics ---
// =============================================================================

const BOOLEAN_ATTRS = new Set([
    "allowfullscreen", "async", "autofocus", "autoplay", "checked",
    "controls", "default", "defer", "disabled", "formnovalidate",
    "hidden", "inert", "ismap", "itemscope", "loop", "multiple",
    "muted", "nomodule", "novalidate", "open", "playsinline",
    "readonly", "required", "reversed", "selected",
]);

const DIRECTIVE_ATTRS = new Set(["ref", "show", "hide"]);

function validateCompositeAttr(attrName: string, index: number): void {
    if (attrName.startsWith("@")) {
        throw new Error(
            `[nix-js] Partial attribute interpolation is not supported on event bindings: "${attrName}" (binding index ${index}). ` +
            `Event handlers must be a single full interpolation: ${attrName}=\${"\${handler}"}`,
        );
    }
    if (DIRECTIVE_ATTRS.has(attrName.toLowerCase())) {
        throw new Error(
            `[nix-js] Partial attribute interpolation is not supported on directive "${attrName}" (binding index ${index}). ` +
            `Directives must be a single full interpolation: ${attrName}=\${"\${value}"}`,
        );
    }
    if (BOOLEAN_ATTRS.has(attrName.toLowerCase())) {
        throw new Error(
            `[nix-js] Partial attribute interpolation is not supported on boolean attribute "${attrName}" (binding index ${index}). ` +
            `Boolean attributes depend on presence, not on their value: ${attrName}=\${"\${condition}"}`,
        );
    }
}

// =============================================================================
// --- Lexer (state machine) ---
// =============================================================================

type LexState =
    | "text"
    | "tag-open"
    | "tag-name"
    | "tag-body"
    | "attr-name"
    | "attr-ws"
    | "after-eq"
    | "value-dq"
    | "value-sq"
    | "value-unq"
    | "comment"
    | "doctype"
    | "pi"
    | "raw-text";

const RAW_TEXT_TAGS = new Set(["script", "style", "textarea"]);

function isSpace(c: string): boolean {
    return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
}

function isNameStart(c: string): boolean {
    return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

interface ValueRegion {
    attrName: string;
    attrStart: number;
    quote: '"' | "'" | null;
    holes: number[];
    literals: string[];
    literal: string;
}

interface CompositeGroup {
    firstHole: number;
    lastHole: number;
    attrName: string;
    attrStart: number;
    quote: '"' | "'" | null;
    literals: string[];
    sourceIndices: number[];
}

interface LexResult {
    groups: CompositeGroup[];
    /** One plan per original interpolation hole. */
    holeTypes: ("passthrough" | CompositeGroup)[];
}

function lexTemplate(strings: readonly string[]): LexResult {
    const holeCount = strings.length - 1;
    const holeTypes: ("passthrough" | CompositeGroup)[] = new Array(holeCount).fill("passthrough");

    let state: LexState = "text";
    let rawTag: string | null = null;
    let tagIsClosing = false;
    let tagName = "";
    let attrName = "";
    let attrStart = -1;
    let region: ValueRegion | null = null;

    const groups: CompositeGroup[] = [];

    const closeRegion = (atEnd = false): void => {
        const r = region;
        region = null;
        if (!r) return;
        if (atEnd && r.quote !== null && r.holes.length > 0) {
            throw new Error(
                `[nix-js] Unclosed quoted attribute value for "${r.attrName}" (binding index ${r.holes[0]}). ` +
                `Add the closing ${r.quote}: ${r.attrName}=${r.quote}...${r.quote}`,
            );
        }
        r.literals.push(r.literal);
        r.literal = "";
        if (r.holes.length === 0) return;
        const hasStatic = r.literals.some((l) => l.length > 0);
        if (r.holes.length === 1 && !hasStatic) {
            holeTypes[r.holes[0]] = "passthrough";
            return;
        }
        validateCompositeAttr(r.attrName, r.holes[0]);
        const group: CompositeGroup = {
            firstHole: r.holes[0],
            lastHole: r.holes[r.holes.length - 1],
            attrName: r.attrName,
            attrStart: r.attrStart,
            quote: r.quote,
            literals: r.literals,
            sourceIndices: r.holes,
        };
        for (const h of r.holes) holeTypes[h] = group;
        groups.push(group);
    };

    const recordHole = (hole: number): void => {
        switch (state) {
            case "value-dq":
            case "value-sq":
            case "value-unq":
                if (!region) {
                    holeTypes[hole] = "passthrough";
                    break;
                }
                region.literals.push(region.literal);
                region.literal = "";
                region.holes.push(hole);
                break;
            case "after-eq": {
                region = {
                    attrName,
                    attrStart,
                    quote: null,
                    holes: [hole],
                    literals: [""],
                    literal: "",
                };
                state = "value-unq";
                break;
            }
            case "tag-open":
            case "tag-name":
                throw new Error(
                    `[nix-js] Interpolation inside a tag name (binding index ${hole}) is not supported. ` +
                    "Dynamic tag names are not part of Nix templates.",
                );
            case "tag-body":
            case "attr-name":
            case "attr-ws":
                throw new Error(
                    `[nix-js] Interpolation inside an attribute name or in the tag body (binding index ${hole}) is not supported. ` +
                    "Attribute names must be static: class=\${value}",
                );
            default:
                holeTypes[hole] = "passthrough";
        }
    };

    const maybeEnterRawText = (): LexState => {
        if (!tagIsClosing && RAW_TEXT_TAGS.has(tagName.toLowerCase())) {
            rawTag = tagName.toLowerCase();
            return "raw-text";
        }
        return "text";
    };

    for (let si = 0; si < strings.length; si++) {
        const s = strings[si];
        const n = s.length;
        let j = 0;

        while (j < n) {
            const c = s[j];
            const st: LexState = state;

            switch (st) {
                case "text":
                    if (c === "<") state = "tag-open";
                    j++;
                    break;

                case "tag-open":
                    if (c === "/") {
                        tagIsClosing = true;
                        tagName = "";
                        state = "tag-name";
                    } else if (c === "!") {
                        if (s[j + 1] === "-" && s[j + 2] === "-") {
                            state = "comment";
                            j += 3;
                            break;
                        }
                        state = "doctype";
                    } else if (c === "?") {
                        state = "pi";
                    } else if (isNameStart(c)) {
                        tagIsClosing = false;
                        tagName = "";
                        state = "tag-name";
                    } else {
                        state = "text";
                    }
                    j++;
                    break;

                case "tag-name":
                    if (c === ">") {
                        state = maybeEnterRawText();
                        j++;
                        break;
                    }
                    if (isSpace(c) || c === "/") {
                        state = "tag-body";
                        j++;
                        break;
                    }
                    tagName += c;
                    j++;
                    break;

                case "tag-body":
                    if (c === ">") {
                        state = maybeEnterRawText();
                    } else if (isSpace(c) || c === "/") {
                        // whitespace or stray slash
                    } else if (c === "<") {
                        state = "tag-open";
                    } else {
                        attrStart = j;
                        attrName = "";
                        state = "attr-name";
                        break;
                    }
                    j++;
                    break;

                case "attr-name":
                    if (c === "=") {
                        attrName = s.slice(attrStart, j);
                        state = "after-eq";
                    } else if (isSpace(c)) {
                        attrName = s.slice(attrStart, j);
                        state = "attr-ws";
                    } else if (c === ">") {
                        state = maybeEnterRawText();
                    } else {
                        // part of the name
                    }
                    j++;
                    break;

                case "attr-ws":
                    if (c === "=") {
                        state = "after-eq";
                    } else if (isSpace(c)) {
                        // keep waiting
                    } else if (c === ">") {
                        state = maybeEnterRawText();
                    } else {
                        attrStart = j;
                        attrName = "";
                        state = "attr-name";
                        break;
                    }
                    j++;
                    break;

                case "after-eq":
                    if (c === '"' || c === "'") {
                        region = {
                            attrName,
                            attrStart,
                            quote: c,
                            holes: [],
                            literals: [],
                            literal: "",
                        };
                        state = c === '"' ? "value-dq" : "value-sq";
                    } else if (isSpace(c)) {
                        // whitespace before value
                    } else if (c === ">") {
                        state = maybeEnterRawText();
                    } else {
                        region = {
                            attrName,
                            attrStart,
                            quote: null,
                            holes: [],
                            literals: [],
                            literal: c,
                        };
                        state = "value-unq";
                    }
                    j++;
                    break;

                case "value-dq":
                    if (c === '"') {
                        closeRegion();
                        state = "tag-body";
                    } else {
                        region!.literal += c;
                    }
                    j++;
                    break;

                case "value-sq":
                    if (c === "'") {
                        closeRegion();
                        state = "tag-body";
                    } else {
                        region!.literal += c;
                    }
                    j++;
                    break;

                case "value-unq":
                    if (isSpace(c)) {
                        closeRegion();
                        state = "tag-body";
                    } else if (c === ">") {
                        closeRegion();
                        state = maybeEnterRawText();
                    } else {
                        region!.literal += c;
                    }
                    j++;
                    break;

                case "comment":
                    if (c === "-" && s[j + 1] === "-" && s[j + 2] === ">") {
                        state = "text";
                        j += 3;
                        break;
                    }
                    j++;
                    break;

                case "doctype":
                case "pi":
                    if (c === ">") state = "text";
                    j++;
                    break;

                case "raw-text": {
                    const raw = rawTag!;
                    if (c === "<" && s[j + 1] === "/") {
                        let m = 2;
                        let ok = true;
                        for (let k = 0; k < raw.length; k++) {
                            const ch = s[j + m];
                            if (ch === undefined || ch.toLowerCase() !== raw[k]) {
                                ok = false;
                                break;
                            }
                            m++;
                        }
                        if (ok) {
                            while (s[j + m] !== undefined && isSpace(s[j + m])) m++;
                            if (s[j + m] === ">") {
                                state = "text";
                                rawTag = null;
                                j += m + 1;
                                break;
                            }
                        }
                    }
                    j++;
                    break;
                }
            }
        }

        if (si < holeCount) {
            recordHole(si);
        }
    }

    closeRegion(true);

    return { groups, holeTypes };
}

// =============================================================================
// --- Normalized strings construction ---
// =============================================================================

function buildNormalizedStrings(
    strings: readonly string[],
    groups: CompositeGroup[],
): string[] {
    const n = strings.length - 1;
    const leadTrim = new Uint32Array(n + 1);
    const tailTrim = new Uint32Array(n + 1);
    const consumed = new Set<number>();
    const headInfo = new Array<CompositeGroup | null>(n + 1).fill(null);

    for (const g of groups) {
        headInfo[g.firstHole] = g;
        tailTrim[g.firstHole] = g.literals[0].length;
        leadTrim[g.lastHole + 1] = g.literals[g.literals.length - 1].length;
        for (let k = g.firstHole + 1; k <= g.lastHole; k++) consumed.add(k);
    }

    const normalized: string[] = [];
    for (let i = 0; i <= n; i++) {
        if (consumed.has(i)) continue;
        let s = strings[i];
        const lt = leadTrim[i];
        if (lt) s = s.slice(lt);
        const head = headInfo[i];
        if (head) {
            s = s.slice(0, head.attrStart - lt) + head.attrName + "=" + (head.quote ?? "");
        } else {
            const tt = tailTrim[i];
            if (tt) s = s.slice(0, s.length - tt);
        }
        normalized.push(s);
    }
    return normalized;
}

// =============================================================================
// --- AST transform ---
// =============================================================================

/**
 * Finds `html\`...\`` tagged template expressions in `code` and rewrites
 * partial attribute interpolations into full bindings using `__nixCompose`.
 *
 * Returns the transformed code, or `null` if no changes were made.
 */
export function transformInterpolation(code: string, fileId: string): string | null {
    let ast: t.File;
    try {
        ast = parse(code, {
            sourceType: "module",
            plugins: ["typescript", "jsx", "importMeta", "topLevelAwait"],
        });
    } catch {
        return null;
    }

    let changed = false;
    let needsComposeImport = false;

    traverse(ast, {
        TaggedTemplateExpression(path: NodePath<t.TaggedTemplateExpression>) {
            const tag = path.node.tag;
            if (!t.isIdentifier(tag) || tag.name !== "html") return;

            const quasi = path.node.quasi;
            const cooked: string[] = quasi.quasis.map((q) => q.value.cooked ?? q.value.raw);

            if (cooked.length <= 1) return;

            const { groups, holeTypes } = lexTemplate(cooked);

            if (groups.length === 0) return;

            const normalizedStrings = buildNormalizedStrings(cooked, groups);

            // Build new expressions array
            const newExpressions: t.Expression[] = [];
            for (let h = 0; h < holeTypes.length; h++) {
                const plan = holeTypes[h];
                if (plan === "passthrough") {
                    newExpressions.push(quasi.expressions[h] as t.Expression);
                } else if (h === plan.firstHole) {
                    // Build __nixCompose(literal0, expr0, literal1, expr1, ...)
                    const args: (t.Expression | t.StringLiteral)[] = [];
                    args.push(t.stringLiteral(plan.literals[0]));
                    for (let i = 0; i < plan.sourceIndices.length; i++) {
                        args.push(quasi.expressions[plan.sourceIndices[i]] as t.Expression);
                        args.push(t.stringLiteral(plan.literals[i + 1]));
                    }
                    const callExpr = t.callExpression(t.identifier("__nixCompose"), args);
                    newExpressions.push(callExpr);
                    needsComposeImport = true;
                }
                // else: consumed by composite group — skip
            }

            // Build new template literal
            const newQuasi = t.templateLiteral(
                normalizedStrings.map((s, i) =>
                    t.templateElement({ raw: s, cooked: s }, i === 0)
                ),
                newExpressions
            );

            path.node.quasi = newQuasi;
            changed = true;
        },
    });

    if (!changed) return null;

    // Inject __nixCompose import if needed
    if (needsComposeImport) {
        const importDecl = t.importDeclaration(
            [t.importSpecifier(t.identifier("__nixCompose"), t.identifier("__nixCompose"))],
            t.stringLiteral("@deijose/vite-plugin-nix-js/runtime")
        );
        ast.program.body.unshift(importDecl);
    }

    const result = generate(ast, { sourceMaps: true, sourceFileName: fileId });
    return result.code;
}
