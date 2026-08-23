# @deijose/vite-plugin-nix-js

Vite plugin for [Nix.js](https://nix-js.dev/) that adds Hot Module Replacement (HMR) with state, scroll, and focus preservation.

## Requirements

- Vite `^8.0.0`
- `@deijose/nix-js` `^3.2.1`

## Installation

```bash
npm install -D @deijose/vite-plugin-nix-js
# or
pnpm add -D @deijose/vite-plugin-nix-js
# or
yarn add -D @deijose/vite-plugin-nix-js
```

## Usage

```ts
// vite.config.ts
import { defineConfig } from "vite";
import nix from "@deijose/vite-plugin-nix-js";

export default defineConfig({
  plugins: [nix()],
});
```

No extra configuration is required.

## What it does

- **Hot-reloads** components without a full page refresh.
- **Preserves state** of module-scoped stores, routers, forms, and signals.
- **Preserves scroll position** and the currently focused element.
- **Works automatically** — no manual `import.meta.hot` wrapping needed.

## How it works

The plugin transforms source files at build time to wrap stable calls with a small runtime module:

| Call | Wrapped to |
|------|------------|
| `signal(...)` | `__nixGetOrCreateSignal(id, factory)` |
| `createForm(...)` | `__nixGetOrCreateForm(id, factory)` |
| `createStore(...)` | `__nixGetOrCreateStore(id, factory)` |
| `createRouter(...)` | `__nixGetOrCreateRouter(id, factory)` |
| `mount(...)` | `__nixMount(id, factory, ...)` |

For example, this developer-written code:

```ts
import { signal } from "@deijose/nix-js";
import { createForm } from "@deijose/nix-js/form";

const count = signal(0);
const form = createForm({ name: "" });
const cart = createStore({ items: [] }, { name: "cart" });
const router = createRouter(routes);
mount(App(), "#app", { router });
```

is transformed into:

```ts
import { __nixGetOrCreateSignal, __nixGetOrCreateForm, __nixGetOrCreateStore, __nixGetOrCreateRouter, __nixMount, __nixHmrAccept } from "@deijose/vite-plugin-nix-js/runtime";

const count = __nixGetOrCreateSignal("src/main.ts:count", () => signal(0));
const form = __nixGetOrCreateForm("src/main.ts:form", () => createForm({ name: "" }));
const cart = __nixGetOrCreateStore("src/main.ts:cart", () => createStore({ items: [] }, { name: "cart" }));
const router = __nixGetOrCreateRouter("src/main.ts:router", () => createRouter(routes));
__nixMount("src/main.ts", () => App(), "#app", { router });

if (import.meta.hot) {
  import.meta.hot.accept((newModule) => {
    __nixHmrAccept(newModule, "src/main.ts");
  });
}
```

The runtime keeps a global singleton on `window.__nixHmrRuntime` that re-uses existing stores, routers, and application mounts, while unmounting and re-mounting the changed component and restoring scroll/focus.

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
import { signal, html } from "@deijose/nix-js";

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

- `NixComponent` class instance state (private properties set in `onInit`/`onMount`) is not preserved across HMR updates.
- HMR is module-granular: when a file changes, every mount point declared in that file is re-mounted.
- Only module-scoped `signal`, `createForm`, `createStore`, `createRouter`, and `mount` calls are tracked; declarations nested inside functions are left untouched.

## Development

```bash
cd vite-plugin-nix
npm install
npm run typecheck
npm run build
```

## License

MIT
