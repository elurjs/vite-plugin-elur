# Changelog

All notable changes to this project will be documented in this file.

## v2.2.0-beta.0

Prerelease del canal beta — emite el artefacto compilado de Elur Next
(descriptors con IR compartida cliente/SSR/hidratación). Requiere
`@elurjs/core >= 3.6.2` (estable) o `3.7.0-beta.x`.

### Added

- **`descriptor.ssr` (C.12 fase 2)** — el codegen emite
  `_f$ssr(emit, v0…vN)` con los strings pre-cortados en build; el core
  lo despacha con `makeSsrEmit` (paridad byte a byte con el intérprete).
- **`descriptor.blocks` + `descriptor.dev`** — el plugin clasifica
  `repeat(...)` como `each` y `portal(...)`/`portalOutlet(...)` como
  `portal`, y serializa un `dev.id` estable por template.
- **Hidratación compilada (C.13)** — `descriptor.hydrate` activa
  bindings por posición; SSR emite markers `elur-N`/`elur-ki:` sólo en
  boundaries variables.
- **Constant folding parcial (C.9)** — literales `string`/`number` se
  hornean en `optimizedHtml` (`class=${"active"}` → `class="active"`)
  con escape dedicado; conservador con directivas, urls y `table`-family.
- **SVG/MathML + multi-root (C.14)** — namespaces ya especializan
  (`className` readonly en SVG → `setAttribute`; `xlink:`/`xml:` →
  `setAttributeNS`); multi-root emite factory de fragmento con bounds
  `elur-fs`/`elur-fe` y dismount por rango único.
- **`childNodes[i]` O(1) (C.15)** — paths DOM emitidos indexados en vez
  de cadenas `nextSibling` cuadráticas.
- **Sourcemaps reales (C.11)** + **pipeline de una pasada (C.10)** —
  un parse, mutaciones sobre el mismo AST, un solo `generate` con
  `sourceMaps: true`.
- **ABI versionado (C.17)** — `COMPILER_ABI_VERSION` ↔
  `ELUR_COMPILER_ABI` en runtime; split `runtime/compiler|hmr|abi`.
- **Fast paths de reconcile (C.16.2)** — prefix/suffix/ventanas
  contiguas en `__elurCompiledRepeat`/`Direct`; sibling-walk en vez de
  `Range.deleteContents` (patológico en happy-dom).

### Fixed

- `__elurCompose`/`__elurAttr` desenvuelven signals (antes `[object Object]`).
- Reconcile compilado difiere `onMount` hasta el commit vía
  `_postMountScope`.

## v2.1.0

### Added

- **DevTools injection (`devtools` option, now implemented)** — the previously
  declared-but-unused `devtools` option now injects the Elur DevTools client
  into `index.html` during `vite serve` via a virtual module
  (`virtual:elur-devtools`, `head-prepend`, so the backend installs before any
  app module runs):
  - `"auto"` (new default): injects only in dev and only when
    `@elurjs/devtools-backend` is installed. Ecosystem plugin entry points
    (`@elurjs/query/devtools`, `@elurjs/i18n/devtools`, `@elurjs/auth/devtools`,
    `@elurjs/ionic/devtools`) are injected as well when resolvable.
  - `true`: always inject in dev; warns when the backend is not installed.
  - `false`: never inject.
  Never applies to production builds, so bundles are unaffected.

## v1.1.0

### Added

- **Compile-time partial attribute interpolation** — the plugin now includes
  a state-machine lexer (moved from `@deijose/nix-js` core) that rewrites
  partial attribute interpolations in `html` tagged templates at build time:

  ```typescript
  // Input (author code)
  html`<div class="btn btn-${() => size.value}">…</div>`

  // Output (after plugin transform)
  html`<div class=${__nixCompose("btn btn-", () => size.value, "")}>…</div>`
  ```

  - The lexer handles HTML comments, doctype, processing instructions,
    raw-text tags (`<script>`, `<style>`, `<textarea>`), quoted and unquoted
    attribute values, and multi-segment interpolations.
  - Partial interpolation on `@event` bindings, `ref`/`show`/`hide` directives
    and HTML boolean attributes throws a descriptive compile-time error.
  - The `__nixCompose` runtime helper is injected from
    `@deijose/vite-plugin-nix-js/runtime` only when partials are detected.
  - Templates without partials are byte-identical (fast path, no transform).
  - 17 new tests covering the lexer and transform.

### Changed

- `peerDependencies`: `@deijose/nix-js` updated from `^^3.2.1` to `^3.4.0`
  (the core no longer ships the lexer).
- The `transform` hook now runs interpolation first, then HMR — both are
  no-ops when the source has no `html` templates or Nix.js imports.

## v1.0.2

- Initial HMR plugin: signal, store, form, router preservation and mount
  remount with scroll/focus restoration.
