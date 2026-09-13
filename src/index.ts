import { parse } from "@babel/parser";
import _generate from "@babel/generator";
import * as t from "@babel/types";
import _traverse, { type NodePath } from "@babel/traverse";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { transformInterpolationAst } from "./interpolation.js";
import { ELUR_COMPILER_ABI, assertCompilerAbi } from "./runtime/abi.js";
import {
  compileTemplate,
  genFactoryCode,
  genCallCode,
  COMPILER_ABI_VERSION,
  type ExpressionKind,
} from "@elurjs/core-compiler";

// @babel/traverse and @babel/generator are CommonJS modules whose default
// export can be nested under `.default` when consumed from an ESM bundle.
const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;
const generate = ((_generate as unknown as { default?: typeof _generate }).default ?? _generate) as typeof _generate;

export interface ElurJsPluginOptions {
  /**
   * Preserve global state (stores, routers, signals) across HMR updates.
   * @default true
   */
  preserveState?: boolean;
  /**
   * Preserve scroll position and focus across HMR updates.
   * @default true
   */
  preserveDOM?: boolean;
  /**
   * Inject the Elur DevTools client (`@elurjs/devtools-backend`) in dev mode.
   * - `"auto"` (default): inject only during `vite serve` and only when
   *   `@elurjs/devtools-backend` is installed. Ecosystem plugin entry points
   *   (`@elurjs/query/devtools`, `@elurjs/i18n/devtools`, `@elurjs/auth/devtools`,
   *   `@elurjs/ionic/devtools`) are injected too when resolvable.
   * - `true`: always inject in dev; warns when the backend is not installed.
   * - `false`: never inject.
   * Never applies to production builds.
   * @default "auto"
   */
  devtools?: boolean | "auto";
  /**
   * Enable the build-time compiler for html`` templates.
   * When true, templates are compiled into direct DOM manipulation code
   * (firstChild/nextSibling navigation, inline events, specialized effects).
   * When false, templates use the runtime generic path.
   * @default true
   */
  compiler?: boolean;
  /**
   * Emit the compiled hydration renderer for every template.
   * Set to `true` in apps that hydrate SSR markup (Elur Kit does this) —
   * the compiled hydrator activates bindings by position without a marker
   * scan. When false, client bundles skip the hydration/SSR code entirely
   * (roughly half the compiled-helpers runtime); `hydrate()` still works via
   * the generic marker-based fallback.
   * The SSR renderer (`descriptor.ssr`) is emitted automatically only in
   * SSR builds and does not depend on this flag.
   * @default false
   */
  hydration?: boolean;
}

const ELUR_IMPORTS = [
  "@elurjs/core",
  "@elurjs/core/signals",
  "@elurjs/core/store",
  "@elurjs/core/router",
  "@elurjs/core/form",
];

function isElurImport(source: string): boolean {
  return ELUR_IMPORTS.some((imp) => source === imp || source.startsWith(`${imp}/`));
}

interface ImportedNames {
  signal: string | null;
  createForm: string | null;
  createStore: string | null;
  createRouter: string | null;
  mount: string | null;
}

function getImportedNames(ast: t.File): ImportedNames {
  const names: ImportedNames = { signal: null, createForm: null, createStore: null, createRouter: null, mount: null };

  // C.10: los imports viven en el top level — basta un loop sobre
  // program.body, sin traverse.
  for (const node of ast.program.body) {
    if (!t.isImportDeclaration(node)) continue;
    const source = node.source.value;
    if (!isElurImport(source)) continue;
    for (const specifier of node.specifiers) {
      if (t.isImportSpecifier(specifier) && t.isIdentifier(specifier.imported)) {
        const importedName = specifier.imported.name;
        const localName = specifier.local.name;
        if (importedName === "signal") names.signal = localName;
        if (importedName === "createForm") names.createForm = localName;
        if (importedName === "createStore") names.createStore = localName;
        if (importedName === "createRouter") names.createRouter = localName;
        if (importedName === "mount") names.mount = localName;
      }
    }
  }

  return names;
}

// C.17 — subpaths del runtime dividido: el código compilado importa de
// `runtime/compiler` (sin HMR en el bundle de prod) y el transform HMR de
// `runtime/hmr`. `@elurjs/vite-plugin-elur/runtime` sigue existiendo como
// barrel retrocompatible para código emitido por versiones antiguas.
const RUNTIME_COMPILER = "@elurjs/vite-plugin-elur/runtime/compiler";
const RUNTIME_HMR = "@elurjs/vite-plugin-elur/runtime/hmr";

function makeRuntimeImport(needed: string[], from = RUNTIME_COMPILER): t.ImportDeclaration {
  const specifiers = needed.map((name) =>
    t.importSpecifier(t.identifier(name), t.identifier(name))
  );
  return t.importDeclaration(specifiers, t.stringLiteral(from));
}

// Strip TypeScript-only wrappers so we can inspect the underlying expression.
function unwrapExpression(node: t.Node): t.Node {
  if (t.isTSAsExpression(node) || t.isTSSatisfiesExpression(node) || t.isTSTypeAssertion(node)) {
    return unwrapExpression(node.expression);
  }
  if (t.isParenthesizedExpression(node)) {
    return unwrapExpression(node.expression);
  }
  return node;
}

function hmrTransformAst(ast: t.File, names: ImportedNames, fileId: string): boolean {
  const hasElur = names.signal || names.createForm || names.createStore || names.createRouter || names.mount;
  if (!hasElur) return false;

  const runtimeImports: string[] = [];
  let hasMount = false;
  let mountIndex = 0;

  traverse(ast, {
    VariableDeclarator(nodePath: NodePath<t.VariableDeclarator>) {
      const idNode = nodePath.node.id;
      const initNode = nodePath.node.init;
      if (!t.isIdentifier(idNode) || !initNode) return;

      const unwrapped = unwrapExpression(initNode);
      if (!t.isCallExpression(unwrapped) || !t.isIdentifier(unwrapped.callee)) return;

      // Only preserve declarations at module scope. Declarations inside
      // functions are meant to create fresh instances on each call and must
      // not be hoisted into the global HMR registry.
      if (nodePath.getFunctionParent()) return;

      const localName = idNode.name;
      const callee = unwrapped.callee.name;

      if (names.signal && callee === names.signal) {
        const signalId = `${fileId}:${localName}`;
        const arrow = t.arrowFunctionExpression([], t.blockStatement([t.returnStatement(initNode)]));
        nodePath.node.init = t.callExpression(t.identifier("__elurGetOrCreateSignal"), [
          t.stringLiteral(signalId),
          arrow,
        ]);
        if (!runtimeImports.includes("__elurGetOrCreateSignal")) runtimeImports.push("__elurGetOrCreateSignal");
        return;
      }

      if (names.createForm && callee === names.createForm) {
        const formId = `${fileId}:${localName}`;
        const arrow = t.arrowFunctionExpression([], t.blockStatement([t.returnStatement(initNode)]));
        nodePath.node.init = t.callExpression(t.identifier("__elurGetOrCreateForm"), [
          t.stringLiteral(formId),
          arrow,
        ]);
        if (!runtimeImports.includes("__elurGetOrCreateForm")) runtimeImports.push("__elurGetOrCreateForm");
        return;
      }

      if (names.createStore && callee === names.createStore) {
        const storeId = `${fileId}:${localName}`;
        const arrow = t.arrowFunctionExpression([], t.blockStatement([t.returnStatement(initNode)]));
        nodePath.node.init = t.callExpression(t.identifier("__elurGetOrCreateStore"), [
          t.stringLiteral(storeId),
          arrow,
        ]);
        if (!runtimeImports.includes("__elurGetOrCreateStore")) runtimeImports.push("__elurGetOrCreateStore");
        return;
      }

      if (names.createRouter && callee === names.createRouter) {
        const routerId = `${fileId}:${localName}`;
        const arrow = t.arrowFunctionExpression([], t.blockStatement([t.returnStatement(initNode)]));
        nodePath.node.init = t.callExpression(t.identifier("__elurGetOrCreateRouter"), [
          t.stringLiteral(routerId),
          arrow,
        ]);
        if (!runtimeImports.includes("__elurGetOrCreateRouter")) runtimeImports.push("__elurGetOrCreateRouter");
      }
    },
    CallExpression(nodePath: NodePath<t.CallExpression>) {
      const callee = nodePath.node.callee;
      if (!t.isIdentifier(callee) || !names.mount || callee.name !== names.mount) return;
      if (t.isIdentifier(callee, { name: "__elurMount" })) return;
      const args = nodePath.node.arguments;
      const componentArg = t.isExpression(args[0]) ? args[0] : t.identifier("undefined");
      const containerArg = t.isExpression(args[1]) ? args[1] : t.identifier("undefined");
      const optionsArg = t.isExpression(args[2]) ? args[2] : t.identifier("undefined");

      const mountId = `${fileId}#${mountIndex++}`;
      hasMount = true;

      // Support async components: if the mounted expression awaits, the factory
      // must be async so the runtime can await the resolved component.
      const isAsync = t.isAwaitExpression(componentArg);
      const factory = t.arrowFunctionExpression(
        [],
        t.blockStatement([t.returnStatement(componentArg)]),
        isAsync
      );

      nodePath.replaceWith(
        t.callExpression(t.identifier("__elurMount"), [
          t.stringLiteral(mountId),
          factory,
          containerArg,
          optionsArg,
        ])
      );
      nodePath.skip();
      if (!runtimeImports.includes("__elurMount")) runtimeImports.push("__elurMount");
    },
  });

  if (!runtimeImports.length) return false;

  // Check if there's already an hmr runtime import (e.g. from a previous pass)
  const existingRuntimeImport = ast.program.body.find(
    (n): n is t.ImportDeclaration =>
      t.isImportDeclaration(n) && n.source.value === RUNTIME_HMR
  );

  if (existingRuntimeImport) {
    // Merge new specifiers into the existing import
    for (const name of runtimeImports) {
      const exists = existingRuntimeImport.specifiers.some(
        (s) => t.isImportSpecifier(s) && t.isIdentifier(s.imported) && s.imported.name === name
      );
      if (!exists) {
        existingRuntimeImport.specifiers.push(
          t.importSpecifier(t.identifier(name), t.identifier(name))
        );
      }
    }
  } else {
    ast.program.body.unshift(makeRuntimeImport(runtimeImports, RUNTIME_HMR));
  }

  if (hasMount) {
    const importMeta = t.metaProperty(t.identifier("import"), t.identifier("meta"));
    const importMetaHot = t.memberExpression(importMeta, t.identifier("hot"));
    const acceptBlock = t.ifStatement(
      importMetaHot,
      t.blockStatement([
        t.expressionStatement(
          t.callExpression(
            t.memberExpression(importMetaHot, t.identifier("accept")),
            [
              t.arrowFunctionExpression(
                [t.identifier("newModule")],
                t.blockStatement([
                  t.expressionStatement(
                    t.callExpression(t.identifier("__elurHmrAccept"), [
                      t.identifier("newModule"),
                      t.stringLiteral(fileId),
                    ])
                  ),
                ])
              ),
            ]
          )
        ),
      ])
    );
    if (!runtimeImports.includes("__elurHmrAccept")) {
      const imp = ast.program.body.find(
        (n): n is t.ImportDeclaration =>
          t.isImportDeclaration(n) && n.source.value === RUNTIME_HMR
      );
      if (imp) {
        imp.specifiers.push(t.importSpecifier(t.identifier("__elurHmrAccept"), t.identifier("__elurHmrAccept")));
      }
    }
    ast.program.body.push(acceptBlock);
  }

  return true;
}

// =============================================================================
// --- Compiler transform: html`` → __elurCompiledTemplate calls ---
// =============================================================================

/**
 * Detects `html` tagged template expressions and compiles them into
 * pre-computed __elurCompiledTemplate factory calls.
 *
 * For each unique template strings array, emits a module-level factory constant
 * and replaces the html`` expression with a factory call.
 */
function lowerCompiledExpression(
  node: t.Expression,
  repeatLocalName: string | null,
  specializedFactories: ReadonlySet<string>,
): { code: string; runtimeImport?: string } {
  if (
    repeatLocalName &&
    t.isArrowFunctionExpression(node) &&
    t.isCallExpression(node.body) &&
    t.isIdentifier(node.body.callee, { name: repeatLocalName }) &&
    node.body.arguments.length === 3 &&
    node.body.arguments.every((argument) => t.isExpression(argument))
  ) {
    const [items, key, render] = node.body.arguments as t.Expression[];
    if (
      t.isArrowFunctionExpression(render) &&
      t.isCallExpression(render.body) &&
      t.isIdentifier(render.body.callee) &&
      specializedFactories.has(render.body.callee.name) &&
      render.body.arguments.every((argument) => t.isExpression(argument)) &&
      render.params.every((parameter) => t.isIdentifier(parameter))
    ) {
      const factoryName = render.body.callee.name;
      const params = render.params.map((parameter) => generate(parameter).code);
      const args = (render.body.arguments as t.Expression[]).map((argument) => generate(argument).code);
      // 4º arg: itemFactory → instancia compilada por fila. Hace el objeto
      // dual (KeyedList+protocol): SSR keyed con markers elur-ki: y
      // hidratación adoptiva — mismo artefacto en los tres mundos (C.12).
      return {
        code: `__elurCompiledRepeatDirect(()=>(${generate(items).code}),${generate(key).code},(parent,before,${params.join(",")})=>${factoryName}$mount(parent,before,${args.join(",")}),(${params.join(",")})=>${factoryName}(${args.join(",")}))`,
        runtimeImport: "__elurCompiledRepeatDirect",
      };
    }
    return {
      code: `__elurCompiledRepeat(()=>(${generate(items).code}),${generate(key).code},${generate(render).code})`,
      runtimeImport: "__elurCompiledRepeat",
    };
  }
  return { code: generate(node).code };
}

/**
 * C.8 tier T1 (C.6): `() => <path>.value` con path estable — Identifiers,
 * `this` y member-access puros; sin llamadas (un CallExpression puede
 * devolver señales distintas entre corridas → el binding T1 fijaría la
 * primera — aliasing desconocido, C.7). TS-unwraps (`!`, `as`, parens) OK.
 */
function isStableSignalPath(node: t.Node): boolean {
  if (t.isIdentifier(node) || t.isThisExpression(node)) return true;
  if (
    t.isMemberExpression(node) &&
    !node.computed &&
    t.isIdentifier(node.property) &&
    node.property.name !== "value"
  ) return isStableSignalPath(node.object);
  if (
    t.isTSNonNullExpression(node) ||
    t.isTSAsExpression(node) ||
    t.isTSTypeAssertion(node) ||
    t.isParenthesizedExpression(node)
  ) return isStableSignalPath(node.expression);
  return false;
}

function signalReadObject(node: t.Expression): t.Expression | null {
  if (
    t.isArrowFunctionExpression(node) &&
    t.isMemberExpression(node.body) &&
    !node.body.computed &&
    t.isIdentifier(node.body.property, { name: "value" }) &&
    isStableSignalPath(node.body.object)
  ) return node.body.object;
  return null;
}

/**
 * C.7 tier T2: nodos que pueden esconder lecturas de señal o mutar estado —
 * si aparecen en la expresión, el set de deps no es probable → rechazo.
 * (Un CallExpression puede leer señales internamente; una nested function
 * declara reads que sólo corren si alguien la invoca.)
 */
const T2_REJECT = new Set([
  "CallExpression",
  "OptionalCallExpression",
  "NewExpression",
  "AssignmentExpression",
  "UpdateExpression",
  "SequenceExpression",
  "AwaitExpression",
  "YieldExpression",
  "TaggedTemplateExpression",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ClassExpression",
]);

/**
 * Colecta los objetos de toda lectura `.value` del cuerpo de un arrow cuyo
 * objeto es un path estable (isStableSignalPath — la cadena no trackea en
 * runtime, sólo el `.value` final suscribe). Devuelve los dep-expressions
 * deduplicados por código, o null si la expresión no es T2-segura.
 *
 * Superset seguro: `cond ? a.value : b.value` → {a, b} — wakeups extra
 * pero el writer compara antes de tocar DOM.
 */
function collectSignalDeps(node: t.Expression): t.Expression[] | null {
  if (!t.isArrowFunctionExpression(node)) return null;
  const body = node.body;
  if (body.type === "BlockStatement") return null;
  const deps: t.Expression[] = [];
  const seen = new Set<string>();
  let rejected = false;

  const visit = (n: t.Node | null | undefined): void => {
    if (!n || rejected) return;
    if (t.isMemberExpression(n) || t.isOptionalMemberExpression(n)) {
      if (!n.computed && t.isIdentifier(n.property, { name: "value" })) {
        if (isStableSignalPath(n.object)) {
          const key = generate(n.object).code;
          if (!seen.has(key)) {
            seen.add(key);
            deps.push(n.object);
          }
          // El objeto es un path estable: sus links internos son reads
          // planos (nunca `.value`) — no hace falta descender.
          return;
        }
        rejected = true;
        return;
      }
      // Member no-.value: el object puede contener reads (`a[b.value]`)
      // — descender a object y property.
    }
    if (T2_REJECT.has(n.type)) {
      rejected = true;
      return;
    }
    if (t.isUnaryExpression(n) && n.operator === "delete") {
      rejected = true;
      return;
    }
    const keys = t.VISITOR_KEYS[n.type] ?? [];
    for (const key of keys) {
      const child = (n as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const c of child) visit(c as t.Node);
      } else {
        visit(child as t.Node);
      }
    }
  };
  visit(body);
  if (rejected || deps.length === 0) return null;
  return deps;
}

function classifyExpression(node: t.Expression): ExpressionKind {
  if (signalReadObject(node)) return "signal";
  if (t.isArrowFunctionExpression(node) && collectSignalDeps(node)) return "derived";
  // Mismo shape pero path no estable (calls, computed, etc.) → getter normal.
  if (
    t.isArrowFunctionExpression(node) &&
    t.isMemberExpression(node.body) &&
    !node.body.computed &&
    t.isIdentifier(node.body.property, { name: "value" })
  ) return "reactive-text";
  if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) return "reactive";
  if (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node) ||
    t.isBigIntLiteral(node)
  ) return "static";
  return "generic";
}

function compilerTransformAst(ast: t.File, fileId: string, emit?: { hydrate?: boolean; ssr?: boolean }): boolean {
  // Find the local name for the `html` import
  let htmlLocalName: string | null = null;
  let repeatLocalName: string | null = null;
  const portalLocalNames = new Set<string>();

  traverse(ast, {
    ImportDeclaration(nodePath: NodePath<t.ImportDeclaration>) {
      const source = nodePath.node.source.value;
      if (!isElurImport(source)) return;
      for (const specifier of nodePath.node.specifiers) {
        if (!t.isImportSpecifier(specifier) || !t.isIdentifier(specifier.imported)) continue;
        if (specifier.imported.name === "html") htmlLocalName = specifier.local.name;
        if (specifier.imported.name === "repeat") repeatLocalName = specifier.local.name;
        if (specifier.imported.name === "portal" || specifier.imported.name === "portalOutlet") {
          portalLocalNames.add(specifier.local.name);
        }
      }
    },
  });

  if (!htmlLocalName) return false;

  // Collect all html`` tagged template expressions at module scope or inside functions
  const factories: Array<{
    id: string;
    strings: string[];
    exprNodes: t.Expression[];
    expressionKinds: ExpressionKind[];
    path: NodePath<t.TaggedTemplateExpression>;
  }> = [];
  let factoryCounter = 0;

  traverse(ast, {
    TaggedTemplateExpression(nodePath: NodePath<t.TaggedTemplateExpression>) {
      const tag = nodePath.node.tag;
      if (!t.isIdentifier(tag) || tag.name !== htmlLocalName) return;

      const quasi = nodePath.node.quasi;
      const strings: string[] = [];
      for (let i = 0; i < quasi.quasis.length; i++) {
        strings.push(quasi.quasis[i].value.cooked ?? quasi.quasis[i].value.raw);
      }

      // Skip templates with no interpolations (pure static HTML — no bindings)
      if (quasi.expressions.length === 0) return;

      // Skip templates where any expression is not a simple expression
      // (e.g. we can't compile dynamic template compositions)
      const exprNodes: t.Expression[] = [];
      for (const expr of quasi.expressions) {
        if (!t.isExpression(expr)) return;
        exprNodes.push(expr);
      }

      const id = `_elurFactory$${factoryCounter++}`;
      factories.push({
        id,
        strings,
        exprNodes,
        expressionKinds: exprNodes.map(classifyExpression),
        path: nodePath,
      });
    },
  });

  if (factories.length === 0) return false;

  // Sort factories by AST position in DESCENDING order (innermost first).
  // This ensures that nested html`` expressions (e.g. inside repeat() calls
  // that are themselves expressions of an outer html``) are compiled before
  // their parent template. Otherwise, serializing the parent's expressions
  // would stringify the inner html`` before it gets compiled.
  factories.sort((a, b) => {
    const aStart = a.path.node.start ?? 0;
    const bStart = b.path.node.start ?? 0;
    return bStart - aStart;
  });

  // Generate factory declarations and replace html`` expressions
  const factoryDecls: t.Statement[] = [];
  const runtimeImports: string[] = [];
  const specializedFactories = new Set<string>();

  for (const { id, strings, exprNodes, expressionKinds, path } of factories) {
    // C.9: valores literales para constant folding — el compiler hornea el
    // literal en optimizedHtml y omite el binding (el arg se conserva para
    // paridad del descriptor SSR).
    const staticValues = exprNodes.map((node, index) => {
      if (expressionKinds[index] !== "static") return undefined;
      const n = unwrapExpression(node);
      if (t.isStringLiteral(n) || t.isNumericLiteral(n)) return n.value;
      if (t.isBooleanLiteral(n)) return n.value;
      if (t.isNullLiteral(n)) return null;
      return undefined;
    });
    // C.12: hints de bloque — `repeat(…)` (each) y `portal(…)`/`portalOutlet(…)`
    // (portal). Van al descriptor como metadata estructural serializable.
    const blockKinds = exprNodes.map((node) => {
      const inner = unwrapExpression(node);
      const call = t.isArrowFunctionExpression(inner) && t.isExpression(inner.body)
        ? inner.body
        : inner;
      if (
        repeatLocalName &&
        t.isCallExpression(call) &&
        t.isIdentifier(call.callee, { name: repeatLocalName }) &&
        call.arguments.length === 3
      ) return "each" as const;
      if (
        t.isCallExpression(call) &&
        t.isIdentifier(call.callee) &&
        portalLocalNames.has(call.callee.name)
      ) return "portal" as const;
      return null;
    });
    // Compile the template
    const compiled = compileTemplate(strings, expressionKinds, staticValues, {
      blockKinds,
      devId: `${fileId}:${id}`,
    });
    if (compiled.specialized) specializedFactories.add(id);

    // Generate factory code string and parse it into an AST node
    const generatedFactory = genFactoryCode(id, compiled, emit);
    const factoryAst = parse(generatedFactory.code, {
      sourceType: "module",
      plugins: ["typescript"],
    });
    // genFactoryCode may produce multiple declarations (resolver + factory)
    for (const decl of factoryAst.program.body) {
      // C.11: los nodos parseados de snippets llevan locs del snippet, no del
      // módulo — si se conservan, el sourcemap apunta a líneas falsas.
      t.removePropertiesDeep(decl);
      factoryDecls.push(decl as t.Statement);
    }

    // C.6 T1: bindings "signal" en contexto node/attr reciben la SEÑAL como
    // arg (el objeto de `() => <path>.value`), no el getter. En otros
    // contextos (ej. eventos) el arrow es un handler/valor — no se toca.
    const t1Indices = new Set(
      compiled.bindings
        .filter(
          (b) =>
            b.expressionKind === "signal" &&
            (b.context.type === "node" || b.context.type === "attr"),
        )
        .map((b) => b.index),
    );
    // C.7 T2: bindings "derived" en node/attr reciben el pack
    // `__elurDerive(dep1,…,getter)` — deps estáticas evaluadas por instancia.
    const t2Indices = new Set(
      compiled.bindings
        .filter(
          (b) =>
            b.expressionKind === "derived" &&
            (b.context.type === "node" || b.context.type === "attr"),
        )
        .map((b) => b.index),
    );
    const loweredExpressions = exprNodes.map((node, index) => {
      const sigPath = t1Indices.has(index) ? signalReadObject(node) : null;
      if (sigPath) return { code: generate(sigPath).code };
      if (t2Indices.has(index)) {
        const deps = collectSignalDeps(node);
        if (deps) {
          const get = generate(node).code;
          // 1 dep → `__elurDerive1(dep, get)`: pack sin array — el caso
          // común no paga rest+slice por instancia.
          if (deps.length === 1) {
            return {
              code: `__elurDerive1(${generate(deps[0]).code},${get})`,
              runtimeImport: "__elurDerive1",
            };
          }
          const parts = deps.map((dep) => generate(dep).code);
          parts.push(get);
          return {
            code: `__elurDerive(${parts.join(",")})`,
            runtimeImport: "__elurDerive",
          };
        }
      }
      return lowerCompiledExpression(node, repeatLocalName, specializedFactories);
    });
    const exprSourceStrings = loweredExpressions.map((expression) => expression.code);
    for (const expression of loweredExpressions) {
      if (expression.runtimeImport && !runtimeImports.includes(expression.runtimeImport)) {
        runtimeImports.push(expression.runtimeImport);
      }
    }
    const callCode = genCallCode(id, exprSourceStrings);
    const callAst = parse(callCode, {
      sourceType: "module",
      plugins: ["typescript"],
    });
    const callExpr = (callAst.program.body[0] as t.ExpressionStatement).expression;
    t.removePropertiesDeep(callExpr);
    path.replaceWith(callExpr);

    for (const runtimeImport of generatedFactory.runtimeImports) {
      if (!runtimeImports.includes(runtimeImport)) runtimeImports.push(runtimeImport);
    }
  }

  // C.17 — marca ABI: el módulo compilado declara la versión de runtime
  // que necesita; `runtime/compiler` valida en carga (console.error fuerte).
  if (factoryDecls.length > 0) {
    if (!runtimeImports.includes("__elurAbi")) runtimeImports.push("__elurAbi");
    factoryDecls.unshift(
      t.expressionStatement(
        t.callExpression(t.identifier("__elurAbi"), [t.numericLiteral(COMPILER_ABI_VERSION)])
      )
    );
  }

  // Insert factory declarations at the top of the module (after imports)
  const firstNonImport = ast.program.body.findIndex(
    (n) => !t.isImportDeclaration(n)
  );
  const insertIndex = firstNonImport === -1 ? ast.program.body.length : firstNonImport;
  ast.program.body.splice(insertIndex, 0, ...factoryDecls);

  // Add runtime import for compiler helpers
  if (runtimeImports.length > 0) {
    // Check if there's already a compiler runtime import
    const existingRuntimeImport = ast.program.body.find(
      (n): n is t.ImportDeclaration =>
        t.isImportDeclaration(n) && n.source.value === RUNTIME_COMPILER
    );

    if (existingRuntimeImport) {
      for (const name of runtimeImports) {
        const exists = existingRuntimeImport.specifiers.some(
          (s) => t.isImportSpecifier(s) && t.isIdentifier(s.imported) && s.imported.name === name
        );
        if (!exists) {
          existingRuntimeImport.specifiers.push(
            t.importSpecifier(t.identifier(name), t.identifier(name))
          );
        }
      }
    } else {
      ast.program.body.unshift(makeRuntimeImport(runtimeImports, RUNTIME_COMPILER));
    }
  }

  return true;
}

export default function elurJsPlugin(options: ElurJsPluginOptions = {}): Plugin {
  const opts = {
    preserveState: true,
    preserveDOM: true,
    devtools: "auto" as boolean | "auto",
    compiler: true,
    ...options,
  };

  // C.17: el ABI que emite el compilador instalado debe ser exactamente el
  // que soporta este runtime. Un par plugin↔compiler desalineado falla aquí,
  // en el arranque de Vite — no con un console.error dentro del bundle del
  // usuario.
  assertCompilerAbi(COMPILER_ABI_VERSION, ELUR_COMPILER_ABI);

  // --- DevTools injection (dev only) ---------------------------------------
  // A virtual module imported from index.html via transformIndexHtml. It is
  // injected with `head-prepend`, and module scripts execute in document
  // order, so the backend installs before any app module runs.
  const DEVTOOLS_VIRTUAL_ID = "virtual:elur-devtools";

  const DEVTOOLS_CANDIDATES = [
    "@elurjs/devtools-backend/auto",
    "@elurjs/query/devtools",
    "@elurjs/i18n/devtools",
    "@elurjs/auth/devtools",
    "@elurjs/ionic/devtools",
  ];

  let viteCommand: "serve" | "build" = "serve";
  let devtoolsModules: string[] = [];

  return {
    name: "vite-plugin-elur",
    enforce: "pre",

    configResolved(config) {
      viteCommand = config.command;
      if (opts.devtools === false || config.command !== "serve") return;

      const req = createRequire(resolve(config.root, "package.json"));
      const resolvable = DEVTOOLS_CANDIDATES.filter((specifier) => {
        try {
          req.resolve(specifier);
          return true;
        } catch {
          return false;
        }
      });

      const backendFound = resolvable.includes(DEVTOOLS_CANDIDATES[0]!);
      if (!backendFound) {
        if (opts.devtools === true) {
          this.warn(
            "[vite-plugin-elur] `devtools: true` but @elurjs/devtools-backend is not installed. " +
            "Install it to enable the browser extension integration."
          );
        }
        devtoolsModules = [];
        return;
      }
      devtoolsModules = resolvable;
    },

    resolveId(id) {
      if (id === DEVTOOLS_VIRTUAL_ID) return DEVTOOLS_VIRTUAL_ID;
      return null;
    },

    load(id) {
      if (id !== DEVTOOLS_VIRTUAL_ID) return null;
      return devtoolsModules.map((m) => `import ${JSON.stringify(m)};`).join("\n");
    },

    transformIndexHtml: {
      order: "pre",
      handler() {
        if (viteCommand !== "serve" || devtoolsModules.length === 0) return [];
        return [
          {
            tag: "script",
            attrs: {
              type: "module",
              src: `/@id/${DEVTOOLS_VIRTUAL_ID}`,
            },
            injectTo: "head-prepend",
          },
        ];
      },
    },

    transform(code, id, transformOptions) {
      if (!id.endsWith(".ts") && !id.endsWith(".tsx") && !id.endsWith(".js") && !id.endsWith(".jsx")) {
        return null;
      }
      if (id.includes("node_modules")) return null;
      // Skip the plugin's own runtime files (both source and dist)
      if (id.includes("vite-plugin-elur/runtime")) return null;
      if (id.includes("vite-plugin-elur/dist/runtime")) return null;
      if (id.includes("vite-plugin-elur/src/runtime")) return null;

      // Detect SSR: Vite 5-7 passes options.ssr, Vite 8 uses this.environment.
      // In SSR mode, skip compiler and HMR transforms — they produce browser-only
      // code (document.createElement, window). The original html`` with buildHTML()
      // is server-safe and produces HTML strings for SSR.
      // Interpolation transform is syntactic only and safe for both paths.
      const isSSR = transformOptions?.ssr === true ||
        (this as any)?.environment?.config?.consumer === "server";

      const cwd = process.cwd();
      const fileId = id.startsWith(cwd) ? id.slice(cwd.length + 1) : id;

      // C.10/C.11 — pipeline de una sola pasada: un parse del módulo, las
      // tres fases mutan el mismo AST, un solo generate con sourcemap real.
      // (Antes: 4 parses del módulo + 3 generates y `map: null`.)
      let ast: t.File;
      try {
        ast = parse(code, {
          sourceType: "module",
          plugins: ["typescript", "jsx", "importMeta", "topLevelAwait"],
          sourceFilename: fileId,
        });
      } catch (err) {
        console.warn(`[elur-plugin] Could not parse ${fileId}:`, err);
        return null;
      }

      const names = getImportedNames(ast);
      let changed = false;

      // Phase 1: Interpolation — partial attr interpolations → full bindings.
      if (transformInterpolationAst(ast, fileId)) changed = true;

      // Phase 2: Compiler — html`` → factory calls. C.12: también en SSR —
      // el módulo compilado es SSR-safe en carga y el mismo artefacto
      // alimenta cliente, SSR e hidratación.
      // `hydration: true` = app isomórfica (kit): emite hydrate + ssr en
      // ambos bundles para que markers y hydrator compilado concuerden.
      // Build SSR puro: solo ssr. CSR por defecto: ninguno.
      const emitHydration = opts.hydration === true;
      if (opts.compiler && compilerTransformAst(ast, fileId, { hydrate: emitHydration, ssr: isSSR || emitHydration })) changed = true;

      // Phase 3: HMR — preserve signals/stores/forms/routers/mounts.
      // Browser-only: the HMR runtime accesses window, skip in SSR/build.
      const isBuild = this?.environment?.config?.command === "build";
      if (!isSSR && !isBuild && hmrTransformAst(ast, names, fileId)) changed = true;

      if (!changed) return null;

      const result = generate(ast, {
        sourceMaps: true,
        sourceFileName: fileId,
      });
      return { code: result.code, map: result.map };
    },
  };
}
