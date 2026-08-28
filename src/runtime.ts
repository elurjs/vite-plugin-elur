import { effect, mount, type ElurComponent, type ElurMountHandle, type ElurTemplate, type TemplateBindingContext, type TemplateDescriptor } from "@elurjs/core";
import {
  _activateBindingsWithNodes,
  _activateNodeBinding,
  _ensureDelegatedEvent,
  _queueDOMWrite,
  _createKeyedMount,
  _getKeyedSequence,
  _reconcileKeyedList,
  ELUR_RENDER_PROTOCOL,
  ELUR_TEMPLATE_DESCRIPTOR,
  sanitizeUrl,
  type KEntry,
  type KeyedList,
} from "@elurjs/core/template";
import { _captureContextSnapshot, _withContextSnapshot } from "@elurjs/core/context";

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

const runtime = getElurHmrRuntime();

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
  const existing = runtime.mounts.get(id);

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
  runtime.mounts.set(id, record);
  mountInto(record);
}

export function __elurGetOrCreateSignal<T>(id: string, factory: () => T): T {
  const existing = runtime.signals.get(id);
  if (existing) return existing.signal as T;
  const signal = factory();
  runtime.signals.set(id, { id, signal });
  return signal;
}

export function __elurGetOrCreateForm<T>(id: string, factory: () => T): T {
  const existing = runtime.forms.get(id);
  if (existing) return existing.form as T;
  const form = factory();
  runtime.forms.set(id, { id, form });
  return form;
}

export function __elurGetOrCreateStore<T>(id: string, factory: () => T): T {
  const existing = runtime.stores.get(id);
  if (existing) return existing.store as T;
  const store = factory();
  runtime.stores.set(id, { id, store });
  return store;
}

export function __elurGetOrCreateRouter<T>(id: string, factory: () => T): T {
  const existing = runtime.routers.get(id);
  if (existing) return existing.router as T;
  const router = factory();
  runtime.routers.set(id, { id, router });
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
    stores: Array.from(runtime.stores.entries()).map(([id, record]) => [id, record.store]),
  };
}

export function __elurRestoreSnapshot(snapshot: ReturnType<typeof __elurSaveSnapshot>): void {
  runtime.pendingScroll = snapshot.scroll;
  runtime.pendingFocus = snapshot.focus;

  // Schedule scroll/focus restoration after the next paint
  requestAnimationFrame(() => {
    if (runtime.pendingScroll) {
      window.scrollTo(runtime.pendingScroll.x, runtime.pendingScroll.y);
      runtime.pendingScroll = null;
    }
    if (runtime.pendingFocus) {
      const el = document.querySelector(runtime.pendingFocus) as HTMLElement | null;
      el?.focus();
      runtime.pendingFocus = null;
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
export function __elurCompose(...parts: unknown[]): unknown {
  let hasFn = false;
  for (let i = 0; i < parts.length; i++) {
    if (typeof parts[i] === "function") {
      hasFn = true;
      break;
    }
  }

  if (!hasFn) {
    let out = "";
    for (let i = 0; i < parts.length; i++) {
      out += String(parts[i]);
    }
    return out;
  }

  return () => {
    let out = "";
    for (let i = 0; i < parts.length; i++) {
      const v = parts[i];
      out += String(typeof v === "function" ? (v as () => unknown)() : v);
    }
    return out;
  };
}

export function __elurHmrAccept(_newModule: unknown, moduleId: string): void {
  // A module may declare several mount points. Each is registered with an id
  // shaped like `${moduleId}#${index}`, so re-mount every record that belongs
  // to this module.
  const prefix = `${moduleId}#`;
  const records: ElurMountRecord[] = [];
  for (const [id, record] of runtime.mounts) {
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

// =============================================================================
// --- __elurCompiledTemplate: compiled template factory ---
// =============================================================================
// Creates a ElurTemplate from pre-computed static data (html, contexts, pathMap,
// accessPaths). Eliminates detectContext, buildHTML, and both TreeWalkers.

interface CompiledPathMapEntry {
  nodeIndex: number;
  name: string | null;
}

export function __elurCompiledTemplate(
  strings: readonly string[],
  html: string,
  contexts: readonly unknown[],
  pathMap: readonly (CompiledPathMapEntry | null)[],
  resolveNodes: ((frag: DocumentFragment) => Array<Node | null>) | null,
): (values: unknown[]) => ElurTemplate {
  let tpl: HTMLTemplateElement | null = null;

  // Pre-compute maxNodeIndex from pathMap (fallback for when resolveNodes is null)
  let maxNodeIndex = -1;
  for (let i = 0; i < pathMap.length; i++) {
    if (pathMap[i] && pathMap[i]!.nodeIndex > maxNodeIndex) {
      maxNodeIndex = pathMap[i]!.nodeIndex;
    }
  }

  function getTemplate(): HTMLTemplateElement {
    if (tpl) return tpl;
    if (typeof document === "undefined") {
      throw new Error("[elur] DOM rendering requires a document. Use @elurjs/core/server on the server.");
    }
    tpl = document.createElement("template");
    tpl.innerHTML = html;
    return tpl;
  }

  return function (values: unknown[]): ElurTemplate {
    function _render(parent: Node, before: Node | null): () => void {
      const frag = getTemplate().content.cloneNode(true) as DocumentFragment;

      // Resolve nodes — use custom resolver if available, otherwise TreeWalker
      let resolvedNodes: Array<Node | null>;
      if (resolveNodes) {
        resolvedNodes = resolveNodes(frag);
      } else {
        // Fallback: TreeWalker with pre-computed pathMap
        const numBindings = pathMap.length;
        resolvedNodes = new Array(numBindings);
        if (maxNodeIndex > 0) {
          const flatNodes: Node[] = new Array(maxNodeIndex + 1);
          flatNodes[0] = frag;
          const walker = document.createTreeWalker(
            frag,
            NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT
          );
          let fi = 1;
          let currentNode: Node | null;
          while (fi <= maxNodeIndex && (currentNode = walker.nextNode())) {
            flatNodes[fi++] = currentNode;
          }
          for (let i = 0; i < numBindings; i++) {
            const info = pathMap[i];
            resolvedNodes[i] = info ? flatNodes[info.nodeIndex] : null;
          }
        } else if (maxNodeIndex === 0) {
          for (let i = 0; i < numBindings; i++) {
            resolvedNodes[i] = pathMap[i] ? frag : null;
          }
        } else {
          resolvedNodes = new Array(numBindings).fill(null);
        }
      }

      // Activate bindings with pre-resolved nodes — NO second TreeWalker
      const { disposes, postMountHooks } = _activateBindingsWithNodes(
        frag,
        contexts as any[],
        values,
        pathMap as any[],
        resolvedNodes,
      );

      const startMarker = document.createTextNode("");
      const endMarker = document.createTextNode("");
      parent.insertBefore(startMarker, before);
      parent.insertBefore(frag, before);
      parent.insertBefore(endMarker, before);
      postMountHooks.forEach((cb: () => void) => cb());

      return () => {
        for (let i = disposes.length - 1; i >= 0; i--) disposes[i]();
        let node = startMarker.nextSibling;
        while (node && node !== endMarker) {
          const next = node.nextSibling;
          node.parentNode?.removeChild(node);
          node = next;
        }
        startMarker.parentNode?.removeChild(startMarker);
        endMarker.parentNode?.removeChild(endMarker);
      };
    }

    const descriptor: TemplateDescriptor = { version: 1, strings, values, contexts: contexts as TemplateBindingContext[] };

    const elurTemplate: ElurTemplate = {
      __isElurTemplate: true,
      [ELUR_TEMPLATE_DESCRIPTOR]: descriptor,
      _render,
      mount(container: Element | string): ElurMountHandle {
        const el =
          typeof container === "string"
            ? (document.querySelector(container) as Element)
            : container;
        if (!el) {
          throw new Error(`[elur] mount: contenedor no encontrado: ${container}`);
        }
        const cleanup = _render(el, null);
        return { unmount() { cleanup(); } };
      },
    };

    return elurTemplate;
  };
}

type CompiledInstance = ElurTemplate & Record<string, unknown>;
type CompiledRender = (this: CompiledInstance, parent: Node, before: Node | null) => () => void;

export function __elurCreateTemplate(html: string): () => Node {
  let source: Node | null = null;
  return () => {
    if (!source) {
      if (typeof document === "undefined") {
        throw new Error("[elur] DOM rendering requires a document. Use @elurjs/core/server on the server.");
      }
      const template = document.createElement("template");
      template.innerHTML = html;
      source = template.content.firstChild;
      if (!source || source.nextSibling) {
        throw new Error("[elur] Compiled template expected one root node.");
      }
    }
    return source.cloneNode(true);
  };
}

export function __elurCreateTemplatePrototype(
  render: CompiledRender,
  strings: readonly string[],
  contexts: readonly TemplateBindingContext[],
  valueKeys: readonly string[],
): CompiledInstance {
  const prototype = {
    __isElurTemplate: true as const,
    _render: render,
    mount(this: CompiledInstance, container: Element | string): ElurMountHandle {
      const element = typeof container === "string"
        ? document.querySelector(container) as Element | null
        : container;
      if (!element) throw new Error(`[elur] mount: contenedor no encontrado: ${container}`);
      const cleanup = this._render(element, null);
      return { unmount: cleanup };
    },
  } as CompiledInstance;

  Object.defineProperty(prototype, ELUR_TEMPLATE_DESCRIPTOR, {
    get(this: CompiledInstance): TemplateDescriptor {
      const values = new Array<unknown>(valueKeys.length);
      for (let i = 0; i < valueKeys.length; i++) values[i] = this[valueKeys[i]];
      return { version: 1, strings, values, contexts: contexts as TemplateBindingContext[] };
    },
  });

  return prototype;
}

export function __elurDelegateEvents(events: readonly string[]): void {
  if (typeof document === "undefined") return;
  for (let i = 0; i < events.length; i++) _ensureDelegatedEvent(events[i]);
}

export function __elurEvent(
  element: Node,
  eventName: string,
  modifiers: readonly string[],
  handler: unknown,
): void {
  if (typeof handler !== "function") return;
  (element as any)[`__elur_${eventName}`] = handler;
  if (modifiers.length > 0) (element as any)[`__elur_${eventName}_mods`] = modifiers;
}

export function __elurClearEvent(element: Node, eventName: string): void {
  (element as any)[`__elur_${eventName}`] = null;
  (element as any)[`__elur_${eventName}_mods`] = null;
}

export function __elurAttr(
  element: Node,
  attrName: string,
  value: unknown,
  isUrl: boolean,
  executable: boolean,
): (() => void) | null {
  const target = element as Element;
  if (executable) {
    console.warn(
      `[elur] Dynamic binding on executable attribute "${attrName}". Use @event for handlers; avoid binding untrusted values here.`,
    );
  }

  const isDomProp = (
    attrName === "value" || attrName === "checked" || attrName === "selected"
  ) && attrName in target;

  const write = (next: unknown): void => {
    if (isDomProp) {
      (target as any)[attrName] = next ?? "";
    } else if (next == null || next === false) {
      target.removeAttribute(attrName);
    } else {
      const text = String(next);
      if (attrName === "class") (target as HTMLElement).className = text;
      else target.setAttribute(attrName, isUrl ? sanitizeUrl(text) : text);
    }
  };

  if (typeof value !== "function") {
    write(value);
    return null;
  }

  let first = true;
  let queued = false;
  let pending: unknown;
  return effect(() => {
    pending = (value as () => unknown)();
    if (first) {
      first = false;
      write(pending);
    } else if (!queued) {
      queued = true;
      _queueDOMWrite(() => {
        queued = false;
        write(pending);
      });
    }
  });
}

export function __elurNode(
  target: Node,
  value: unknown,
  targetIsAnchor: boolean,
  postMountHooks: Array<() => void> | null,
): { dispose: (() => void) | null; hooks: Array<() => void> } | null {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value);
    if (targetIsAnchor) target.parentNode!.replaceChild(document.createTextNode(text), target);
    else target.textContent = text;
    return null;
  }
  if (value == null || value === false) {
    if (targetIsAnchor) target.parentNode?.removeChild(target);
    return null;
  }

  const anchor = document.createTextNode("");
  if (targetIsAnchor) {
    target.parentNode!.replaceChild(anchor, target);
  } else {
    target.appendChild(anchor);
  }

  const disposes: Array<() => void> = [];
  const hooks = postMountHooks ?? [];
  _activateNodeBinding(anchor, value, disposes, hooks);
  const dispose = disposes.length === 0 ? null : () => {
    for (let i = disposes.length - 1; i >= 0; i--) disposes[i]();
  };
  return { dispose, hooks: postMountHooks ? [] : hooks };
}

export function __elurEffect(fn: () => void): () => void {
  return effect(fn);
}

export function __elurQueue(fn: () => void): void {
  _queueDOMWrite(fn);
}

export function __elurSetAttr(
  element: Node,
  attrName: string,
  value: unknown,
  isUrl: boolean,
  executable: boolean,
): void {
  const target = element as Element;
  if (executable) {
    console.warn(
      `[elur] Dynamic binding on executable attribute "${attrName}". Use @event for handlers; avoid binding untrusted values here.`,
    );
  }
  const isDomProp = (
    attrName === "value" || attrName === "checked" || attrName === "selected"
  ) && attrName in target;
  if (isDomProp) {
    (target as any)[attrName] = value ?? "";
  } else if (value == null || value === false) {
    target.removeAttribute(attrName);
  } else {
    const text = String(value);
    if (attrName === "class") (target as HTMLElement).className = text;
    else target.setAttribute(attrName, isUrl ? sanitizeUrl(text) : text);
  }
}

export function __elurNodeFallback(
  text: Text,
  getter: () => unknown,
  postMountHooks: Array<() => void>,
): () => void {
  const connected = text.isConnected;
  const anchor = document.createTextNode("");
  text.parentNode!.replaceChild(anchor, text);
  const disposes: Array<() => void> = [];
  const hooks = connected ? [] : postMountHooks;
  _activateNodeBinding(anchor, getter, disposes, hooks);
  if (connected) {
    for (let i = 0; i < hooks.length; i++) hooks[i]();
  }
  return () => {
    for (let i = disposes.length - 1; i >= 0; i--) disposes[i]();
  };
}

export function __elurAttrWriter(
  element: Node,
  attrName: string,
  isUrl: boolean,
  executable: boolean,
): (value: unknown) => void {
  const target = element as Element;
  if (executable) {
    console.warn(
      `[elur] Dynamic binding on executable attribute "${attrName}". Use @event for handlers; avoid binding untrusted values here.`,
    );
  }
  const isDomProp = (
    attrName === "value" || attrName === "checked" || attrName === "selected"
  ) && attrName in target;
  let first = true;
  let queued = false;
  let pending: unknown;

  const write = (): void => {
    if (isDomProp) {
      (target as any)[attrName] = pending ?? "";
    } else if (pending == null || pending === false) {
      target.removeAttribute(attrName);
    } else {
      const text = String(pending);
      if (attrName === "class") (target as HTMLElement).className = text;
      else target.setAttribute(attrName, isUrl ? sanitizeUrl(text) : text);
    }
  };

  return (value: unknown): void => {
    pending = value;
    if (first) {
      first = false;
      write();
    } else if (!queued) {
      queued = true;
      _queueDOMWrite(() => {
        queued = false;
        write();
      });
    }
  };
}

export function __elurNodeWriter(
  target: Node,
  getter: () => unknown,
  targetIsAnchor: boolean,
  postMountHooks: Array<() => void>,
): { active: boolean; write: (value: unknown) => void; dispose: () => void; mounted: () => void } {
  const text = document.createTextNode("");
  if (targetIsAnchor) target.parentNode!.replaceChild(text, target);
  else target.appendChild(text);

  let mounted = false;
  let first = true;
  let queued = false;
  let pending = "";
  const fallbackDisposes: Array<() => void> = [];
  const writer = {
    active: true,
    write(value: unknown) {
      if (typeof value !== "string" && typeof value !== "number") {
        writer.active = false;
        const anchor = document.createTextNode("");
        text.parentNode!.replaceChild(anchor, text);
        const hooks = mounted ? [] : postMountHooks;
        _activateNodeBinding(anchor, getter, fallbackDisposes, hooks);
        if (mounted) {
          for (let i = 0; i < hooks.length; i++) hooks[i]();
        }
        return;
      }
      pending = String(value);
      if (first) {
        first = false;
        text.data = pending;
      } else if (!queued) {
        queued = true;
        _queueDOMWrite(() => {
          queued = false;
          text.data = pending;
        });
      }
    },
    dispose() {
      for (let i = fallbackDisposes.length - 1; i >= 0; i--) fallbackDisposes[i]();
    },
    mounted() {
      mounted = true;
    },
  };
  return writer;
}

export function __elurReactiveText(
  target: Node,
  getter: () => unknown,
  targetMode: "node" | "parent" | "text",
  postMountHooks: Array<() => void>,
): { dispose: () => void; mounted: () => void } {
  const text = targetMode === "text" ? target as Text : document.createTextNode("");
  if (targetMode === "node") target.parentNode!.replaceChild(text, target);
  else if (targetMode === "parent") target.appendChild(text);

  let mounted = false;
  let fast = true;
  let first = true;
  let queued = false;
  let pending = "";
  const fallbackDisposes: Array<() => void> = [];

  const disposeEffect = effect(() => {
    if (!fast) return;
    const value = getter();
    if (typeof value !== "string" && typeof value !== "number") {
      fast = false;
      const anchor = document.createTextNode("");
      text.parentNode!.replaceChild(anchor, text);
      const hooks = mounted ? [] : postMountHooks;
      _activateNodeBinding(anchor, getter, fallbackDisposes, hooks);
      if (mounted) {
        for (let i = 0; i < hooks.length; i++) hooks[i]();
      }
      return;
    }

    pending = String(value);
    if (first) {
      first = false;
      text.data = pending;
    } else if (!queued) {
      queued = true;
      _queueDOMWrite(() => {
        queued = false;
        text.data = pending;
      });
    }
  });

  return {
    dispose() {
      disposeEffect();
      for (let i = fallbackDisposes.length - 1; i >= 0; i--) fallbackDisposes[i]();
    },
    mounted() {
      mounted = true;
    },
  };
}

interface DirectKeyedEntry {
  node: Node;
  cleanup: () => void;
}

export function __elurCompiledRepeatDirect<T>(
  readItems: () => T[],
  keyFn: (item: T, index: number) => string | number,
  mountRow: (parent: Node, before: Node | null, item: T, index: number) => () => void,
): { [ELUR_RENDER_PROTOCOL]: { mountDom(context: { parent: Node; before: Node | null }): () => void } } {
  return {
    [ELUR_RENDER_PROTOCOL]: {
      mountDom({ parent, before }) {
        const anchor = before ?? document.createTextNode("");
        if (!before) parent.appendChild(anchor);
        const zoneStart = document.createTextNode("");
        parent.insertBefore(zoneStart, anchor);
        const state = new Map<string | number, DirectKeyedEntry>();
        const prevOrder: Array<string | number> = [];
        const contextSnapshot = _captureContextSnapshot();

        const createEntry = (
          container: Node,
          insertionPoint: Node | null,
          item: T,
          index: number,
        ): DirectKeyedEntry => {
          const cleanup = contextSnapshot.length === 0
            ? mountRow(container, insertionPoint, item, index)
            : _withContextSnapshot(
              contextSnapshot,
              () => mountRow(container, insertionPoint, item, index),
            );
          const node = (insertionPoint ? insertionPoint.previousSibling : container.lastChild)!;
          return { node, cleanup };
        };

        const reconcile = (items: T[]): void => {
          if (state.size === 0) {
            prevOrder.length = items.length;
            if (items.length > 0) {
              const fragment = document.createDocumentFragment();
              for (let i = 0; i < items.length; i++) {
                const key = keyFn(items[i], i);
                prevOrder[i] = key;
                if (state.has(key)) {
                  console.warn(`[elur] repeat(): duplicate key "${key}". Keys must be unique; the previous entry leaks (orphaned nodes + live effects).`);
                }
                state.set(key, createEntry(fragment, null, items[i], i));
              }
              parent.insertBefore(fragment, anchor);
            }
            return;
          }

          const keyedState = state;
          const newOrder = new Array<string | number>(items.length);
          for (let i = 0; i < items.length; i++) newOrder[i] = keyFn(items[i], i);
          const newKeys = new Set<string | number>(newOrder);
          let anySurvive = false;
          for (const key of keyedState.keys()) {
            if (newKeys.has(key)) {
              anySurvive = true;
              break;
            }
          }

          if (!anySurvive) {
            if (keyedState.size > 0) {
              const range = document.createRange();
              range.setStartAfter(zoneStart);
              range.setEndBefore(anchor);
              range.deleteContents();
              for (const entry of keyedState.values()) entry.cleanup();
              keyedState.clear();
            }
            if (items.length > 0) {
              const fragment = document.createDocumentFragment();
              for (let i = 0; i < items.length; i++) {
                const key = newOrder[i];
                const mounted = createEntry(fragment, null, items[i], i);
                if (keyedState.has(key)) {
                  console.warn(`[elur] repeat(): duplicate key "${key}". Keys must be unique; the previous entry leaks (orphaned nodes + live effects).`);
                }
                keyedState.set(key, mounted);
              }
              parent.insertBefore(fragment, anchor);
            }
            prevOrder.length = 0;
            prevOrder.push(...newOrder);
            return;
          }

          const keyToNewIndex = new Map<string | number, number>();
          for (let i = 0; i < newOrder.length; i++) keyToNewIndex.set(newOrder[i], i);
          const newToOld = new Int32Array(newOrder.length);
          let moved = false;
          let maxNewIndex = 0;

          for (let i = 0; i < prevOrder.length; i++) {
            const key = prevOrder[i];
            const newIndex = keyToNewIndex.get(key);
            if (newIndex === undefined) {
              const entry = keyedState.get(key)!;
              entry.cleanup();
              keyedState.delete(key);
            } else {
              newToOld[newIndex] = i + 1;
              if (newIndex >= maxNewIndex) maxNewIndex = newIndex;
              else moved = true;
            }
          }

          const sequence = moved ? _getKeyedSequence(newToOld) : [];
          let sequenceIndex = sequence.length - 1;
          let insertionPoint: Node = anchor;

          for (let i = newOrder.length - 1; i >= 0; i--) {
            const key = newOrder[i];
            if (newToOld[i] === 0) {
              const mounted = createEntry(parent, insertionPoint, items[i], i);
              keyedState.set(key, mounted);
              insertionPoint = mounted.node;
            } else {
              const entry = keyedState.get(key)!;
              if (moved) {
                if (sequenceIndex < 0 || i !== sequence[sequenceIndex]) {
                  parent.insertBefore(entry.node, insertionPoint);
                } else {
                  sequenceIndex--;
                }
              }
              insertionPoint = entry.node;
            }
          }

          prevOrder.length = 0;
          prevOrder.push(...newOrder);
        };

        const disposeEffect = effect(() => reconcile(readItems()));
        return () => {
          disposeEffect();
          for (const entry of state.values()) entry.cleanup();
          state.clear();
          zoneStart.parentNode?.removeChild(zoneStart);
          if (!before) anchor.parentNode?.removeChild(anchor);
        };
      },
    },
  };
}

export function __elurCompiledRepeat<T>(
  readItems: () => T[],
  keyFn: (item: T, index: number) => string | number,
  renderFn: (item: T, index: number) => ElurTemplate | ElurComponent,
): { [ELUR_RENDER_PROTOCOL]: { mountDom(context: { parent: Node; before: Node | null }): () => void } } {
  return {
    [ELUR_RENDER_PROTOCOL]: {
      mountDom({ parent, before }) {
        const anchor = before ?? document.createTextNode("");
        if (!before) parent.appendChild(anchor);
        const zoneStart = document.createTextNode("");
        parent.insertBefore(zoneStart, anchor);
        const state = new Map<string | number, KEntry>();
        const prevOrder: Array<string | number> = [];
        const contextSnapshot = _captureContextSnapshot();
        const mountItem = _createKeyedMount(contextSnapshot);
        const list = {
          __isKeyedList: true as const,
          items: [] as T[],
          keyFn,
          renderFn,
        };

        const disposeEffect = effect(() => {
          list.items = readItems();
          _reconcileKeyedList({
            zoneStart,
            anchor,
            state,
            prevOrder,
            list: list as KeyedList,
            mount: mountItem,
            ctxSnapshot: contextSnapshot,
            onDuplicateKey: (key) => {
              console.warn(`[elur] repeat(): duplicate key "${key}". Keys must be unique; the previous entry leaks (orphaned nodes + live effects).`);
            },
          });
        });

        return () => {
          disposeEffect();
          for (const entry of state.values()) entry.cleanup();
          state.clear();
          let node = zoneStart.nextSibling;
          while (node && node !== anchor) {
            const next = node.nextSibling;
            node.parentNode?.removeChild(node);
            node = next;
          }
          zoneStart.parentNode?.removeChild(zoneStart);
          if (!before) anchor.parentNode?.removeChild(anchor);
        };
      },
    },
  };
}
