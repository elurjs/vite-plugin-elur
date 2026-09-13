// Runtime HMR del plugin: registro de mounts/signals/stores/routers para
// preservar estado entre hot-swaps. Separado de `runtime/compiler` para que
// el bundle de producción no arrastre este código (C.17).
import { mount, type ElurComponent, type ElurMountHandle, type ElurTemplate } from "@elurjs/core";

export type ElurComponentFactory = () =>
  | ElurTemplate
  | ElurComponent
  | Promise<ElurTemplate | ElurComponent>;

export interface ElurMountRecord {
  id: string;
  factory: ElurComponentFactory;
  container: Element | string;
  options?: Record<string, unknown>;
  handle?: ElurMountHandle;
}

export interface ElurSignalRecord {
  id: string;
  signal: unknown;
}

export interface ElurFormRecord {
  id: string;
  form: unknown;
}

export interface ElurStoreRecord {
  id: string;
  store: unknown;
}

export interface ElurRouterRecord {
  id: string;
  router: unknown;
}

export interface ElurHmrRuntime {
  mounts: Map<string, ElurMountRecord>;
  signals: Map<string, ElurSignalRecord>;
  forms: Map<string, ElurFormRecord>;
  stores: Map<string, ElurStoreRecord>;
  routers: Map<string, ElurRouterRecord>;
  pendingScroll: { x: number; y: number } | null;
  pendingFocus: string | null;
}

declare global {
  interface Window {
    __elurHmrRuntime?: ElurHmrRuntime;
  }
}

export function getElurHmrRuntime(): ElurHmrRuntime {
  // SSR guard: if window doesn't exist (server-side render), return a no-op
  // runtime. The HMR transform is skipped in SSR via the plugin's transform
  // hook, but this guard prevents crashes if the runtime module is imported
  // during SSR for any reason.
  if (typeof window === "undefined") {
    return {
      mounts: new Map(),
      signals: new Map(),
      forms: new Map(),
      stores: new Map(),
      routers: new Map(),
      pendingScroll: null,
      pendingFocus: null,
    };
  }
  if (!window.__elurHmrRuntime) {
    window.__elurHmrRuntime = {
      mounts: new Map(),
      signals: new Map(),
      forms: new Map(),
      stores: new Map(),
      routers: new Map(),
      pendingScroll: null,
      pendingFocus: null,
    };
  }
  return window.__elurHmrRuntime;
}

let runtime: ElurHmrRuntime | null = null;
function getRuntime(): ElurHmrRuntime {
  if (!runtime) runtime = getElurHmrRuntime();
  return runtime;
}

function mountInto(record: ElurMountRecord): void {
  const result = record.factory();
  if (result instanceof Promise) {
    result.then((component) => {
      record.handle = mount(component, record.container, record.options);
    });
  } else {
    record.handle = mount(result, record.container, record.options);
  }
}

export function __elurMount(
  id: string,
  factory: ElurComponentFactory,
  container: Element | string,
  options?: Record<string, unknown>
): void {
  const existing = getRuntime().mounts.get(id);

  if (existing) {
    existing.factory = factory;
    existing.container = container;
    existing.options = options;
    existing.handle?.unmount();
    mountInto(existing);
    return;
  }

  const record: ElurMountRecord = {
    id,
    factory,
    container,
    options,
  };
  getRuntime().mounts.set(id, record);
  mountInto(record);
}

export function __elurGetOrCreateSignal<T>(id: string, factory: () => T): T {
  const existing = getRuntime().signals.get(id);
  if (existing) return existing.signal as T;
  const signal = factory();
  getRuntime().signals.set(id, { id, signal });
  return signal;
}

export function __elurGetOrCreateForm<T>(id: string, factory: () => T): T {
  const existing = getRuntime().forms.get(id);
  if (existing) return existing.form as T;
  const form = factory();
  getRuntime().forms.set(id, { id, form });
  return form;
}

export function __elurGetOrCreateStore<T>(id: string, factory: () => T): T {
  const existing = getRuntime().stores.get(id);
  if (existing) return existing.store as T;
  const store = factory();
  getRuntime().stores.set(id, { id, store });
  return store;
}

export function __elurGetOrCreateRouter<T>(id: string, factory: () => T): T {
  const existing = getRuntime().routers.get(id);
  if (existing) return existing.router as T;
  const router = factory();
  getRuntime().routers.set(id, { id, router });
  return router;
}

export function __elurSaveSnapshot(): {
  scroll: { x: number; y: number };
  focus: string | null;
  router: unknown;
  stores: Array<[string, unknown]>;
} {
  const activeElement = document.activeElement;
  return {
    scroll: {
      x: window.scrollX,
      y: window.scrollY,
    },
    focus: activeElement && activeElement.id ? `#${activeElement.id}` : null,
    router: null,
    stores: Array.from(getRuntime().stores.entries()).map(([id, record]) => [id, record.store]),
  };
}

export function __elurRestoreSnapshot(snapshot: ReturnType<typeof __elurSaveSnapshot>): void {
  getRuntime().pendingScroll = snapshot.scroll;
  getRuntime().pendingFocus = snapshot.focus;

  // Schedule scroll/focus restoration after the next paint
  requestAnimationFrame(() => {
    if (getRuntime().pendingScroll) {
      window.scrollTo(getRuntime()?.pendingScroll?.x || 0, getRuntime()?.pendingScroll?.y || 0);
      getRuntime().pendingScroll = null;
    }
    if (getRuntime().pendingFocus) {
      const el = document.querySelector(getRuntime()?.pendingFocus || '') as HTMLElement | null;
      el?.focus();
      getRuntime().pendingFocus = null;
    }
  });
}

/**
 * Composes a partial attribute value from static literals and dynamic segments.
 *
 * - If no segment is a function, the string is composed once (no effect, no
 *   closure).
 * - If at least one segment is a function (reactive getter), a single reactive
 *   getter is returned. The getter invokes only the function segments and
 *   coerces every segment with `String()`.
 *
 * Generated by the Vite plugin's interpolation transform for partial attribute
 * interpolations like `class="btn ${size} size-${n}"`.
 */

export function __elurHmrAccept(_newModule: unknown, moduleId: string): void {
  // A module may declare several mount points. Each is registered with an id
  // shaped like `${moduleId}#${index}`, so re-mount every record that belongs
  // to this module.
  const prefix = `${moduleId}#`;
  const records: ElurMountRecord[] = [];
  for (const [id, record] of getRuntime().mounts) {
    if (id === moduleId || id.startsWith(prefix)) records.push(record);
  }
  if (!records.length) return;

  const snapshot = __elurSaveSnapshot();
  for (const record of records) {
    record.handle?.unmount();
    mountInto(record);
  }
  __elurRestoreSnapshot(snapshot);
}
