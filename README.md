# @elurjs/vite-plugin-elur

Vite plugin for [Elur](https://elur.dev/) that adds **compile-time partial attribute interpolation** and **Hot Module Replacement (HMR)** with state, scroll, and focus preservation.

## Requirements

- Vite `^8.0.0`
- `@elurjs/core` `^3.5.0`

## Installation

```bash
npm install -D @elurjs/vite-plugin-elur
# or
pnpm add -D @elurjs/vite-plugin-elur
# or
yarn add -D @elurjs/vite-plugin-elur
```

## Usage

```ts
// vite.config.ts
import { defineConfig } from "vite";
import elurJs from "@elurjs/vite-plugin-elur";

export default defineConfig({
  plugins: [elurJs()],
});
```

No extra configuration is required.

## What it does

- **Partial attribute interpolation** — rewrites `class="btn ${size}"` into
  `class=${__elurCompose("btn ", size, "")}` at compile time, so the core
  `html()` function only sees full bindings.
- **Hot-reloads** components without a full page refresh.
- **Preserves state** of module-scoped stores, routers, forms, and signals.
- **Preserves scroll position** and the currently focused element.
- **Works automatically** — no manual `import.meta.hot` wrapping needed.

## Partial attribute interpolation

The plugin includes a state-machine lexer that runs at compile time. It finds
`html` tagged template expressions and rewrites partial attribute
interpolations into full bindings:

```typescript
// Input (author code)
html`<div class="btn btn-${() => size.value}">…</div>`

// Output (after plugin transform)
html`<div class=${__elurCompose("btn btn-", () => size.value, "")}>…</div>`
```

The lexer handles:
- HTML comments, doctype, processing instructions
- Raw-text tags (`<script>`, `<style>`, `<textarea>`)
- Quoted and unquoted attribute values
- Multi-segment interpolations (`class="a ${x} b ${y} c"`)
- Multiple attributes in the same tag
- Validation: rejects partials on `@event`, `ref`/`show`/`hide`, and boolean
  attributes (`checked`, `disabled`, …) with descriptive errors

Templates without partials are left byte-identical (fast path).

## How it works

The plugin transforms source files at build time to wrap stable calls with a small runtime module:

| Call | Wrapped to |
|------|------------|
| `signal(...)` | `__elurGetOrCreateSignal(id, factory)` |
| `createForm(...)` | `__elurGetOrCreateForm(id, factory)` |
| `createStore(...)` | `__elurGetOrCreateStore(id, factory)` |
| `createRouter(...)` | `__elurGetOrCreateRouter(id, factory)` |
| `mount(...)` | `__elurMount(id, factory, ...)` |

For example, this developer-written code:

```ts
import { signal } from "@elurjs/core";
import { createForm } from "@elurjs/core/form";

const count = signal(0);
const form = createForm({ name: "" });
const cart = createStore({ items: [] }, { name: "cart" });
const router = createRouter(routes);
mount(App(), "#app", { router });
```

is transformed into:

```ts
import { __elurGetOrCreateSignal, __elurGetOrCreateForm, __elurGetOrCreateStore, __elurGetOrCreateRouter, __elurMount, __elurHmrAccept } from "@elurjs/vite-plugin-elur/runtime";

const count = __elurGetOrCreateSignal("src/main.ts:count", () => signal(0));
const form = __elurGetOrCreateForm("src/main.ts:form", () => createForm({ name: "" }));
const cart = __elurGetOrCreateStore("src/main.ts:cart", () => createStore({ items: [] }, { name: "cart" }));
const router = __elurGetOrCreateRouter("src/main.ts:router", () => createRouter(routes));
__elurMount("src/main.ts", () => App(), "#app", { router });

if (import.meta.hot) {
  import.meta.hot.accept((newModule) => {
    __elurHmrAccept(newModule, "src/main.ts");
  });
}
```

The runtime keeps a global singleton on `window.__elurHmrRuntime` that re-uses existing stores, routers, and application mounts, while unmounting and re-mounting the changed component and restoring scroll/focus.

## Supported cases

- **Multiple mount points** in the same file.
- **Mount assigned to a variable** (`const handle = mount(...)`) as well as bare `mount(...)` statements.
- **Module-scoped signals, forms, stores, and routers**.
- **Named exports** and **aliased imports**.
- **TypeScript** annotations, `as`, `satisfies` and parenthesized expressions.
- **Async components** (`mount(await loadApp(), "#app")`).

Signals, forms, stores, and routers declared **inside functions** are intentionally left untouched, so they still produce a fresh instance on each call.

## Common patterns

Keep state at module scope so it is preserved across updates:

```ts
import { signal, html } from "@elurjs/core";

// ✅ Preserved
const count = signal(0);

function Counter() {
  return html`<button @click=${() => count.update((v) => v + 1)}>${() => count.value}</button>`;
}
```

Avoid declaring state inside the component if you want it to survive HMR:

```ts
function Counter() {
  // ❌ Reset on every update
  const count = signal(0);
  return html`<button @click=${() => count.update((v) => v + 1)}>${() => count.value}</button>`;
}
```

For class components, store shared state in a module-scoped `createStore` or `signal`.

## Known limitations

- `ElurComponent` class instance state (private properties set in `onInit`/`onMount`) is not preserved across HMR updates.
- HMR is module-granular: when a file changes, every mount point declared in that file is re-mounted.
- Only module-scoped `signal`, `createForm`, `createStore`, `createRouter`, and `mount` calls are tracked; declarations nested inside functions are left untouched.

## Development

```bash
cd vite-plugin-elur
npm install
npm run typecheck
npm run build
```

## License

MIT
