# Changelog

All notable changes to this project will be documented in this file.

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
