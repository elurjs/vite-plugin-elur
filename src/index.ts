import { parse } from "@babel/parser";
import _generate from "@babel/generator";
import * as t from "@babel/types";
import _traverse, { type NodePath } from "@babel/traverse";
import type { Plugin } from "vite";
import { transformInterpolation } from "./interpolation.js";
import {
  compileTemplate,
  genFactoryCode,
  genCallCode,
  type ExpressionKind,
} from "@deijose/nix-js-compiler";

// @babel/traverse and @babel/generator are CommonJS modules whose default
// export can be nested under `.default` when consumed from an ESM bundle.
const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;
const generate = ((_generate as unknown as { default?: typeof _generate }).default ?? _generate) as typeof _generate;

export interface NixJsPluginOptions {
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
   * Inject Nix.js devtools client.
   * @default false
   */
  devtools?: boolean;
  /**
   * Enable the build-time compiler for html`` templates.
   * When true, templates are compiled into direct DOM manipulation code
   * (firstChild/nextSibling navigation, inline events, specialized effects).
   * When false, templates use the runtime generic path.
   * @default true
   */
  compiler?: boolean;
}

const NIX_IMPORTS = [
  "@deijose/nix-js",
  "@deijose/nix-js/signals",
  "@deijose/nix-js/store",
  "@deijose/nix-js/router",
  "@deijose/nix-js/form",
];

function isNixImport(source: string): boolean {
  return NIX_IMPORTS.some((imp) => source === imp || source.startsWith(`${imp}/`));
}

interface ImportedNames {
  signal: string | null;
  createForm: string | null;
  createStore: string | null;
  createRouter: string | null;
  mount: string | null;
}

function getImportedNames(code: string): ImportedNames {
  const names: ImportedNames = { signal: null, createForm: null, createStore: null, createRouter: null, mount: null };

  let ast: t.File;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: ["typescript", "jsx", "importMeta", "topLevelAwait"],
    });
  } catch {
    return names;
  }

  traverse(ast, {
    ImportDeclaration(nodePath: NodePath<t.ImportDeclaration>) {
      const source = nodePath.node.source.value;
      if (!isNixImport(source)) return;

      for (const specifier of nodePath.node.specifiers) {
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
    },
  });

  return names;
}

function makeRuntimeImport(needed: string[]): t.ImportDeclaration {
  const specifiers = needed.map((name) =>
    t.importSpecifier(t.identifier(name), t.identifier(name))
  );
  return t.importDeclaration(specifiers, t.stringLiteral("@deijose/vite-plugin-nix-js/runtime"));
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

function hmrTransform(code: string, fileId: string): string | null {
  const names = getImportedNames(code);
  const hasNix = names.signal || names.createForm || names.createStore || names.createRouter || names.mount;
  if (!hasNix) return null;

  let ast: t.File;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: ["typescript", "jsx", "importMeta", "topLevelAwait"],
    });
  } catch (err) {
    console.warn(`[nix-plugin] Could not parse ${fileId}:`, err);
    return null;
  }

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
        nodePath.node.init = t.callExpression(t.identifier("__nixGetOrCreateSignal"), [
          t.stringLiteral(signalId),
          arrow,
        ]);
        if (!runtimeImports.includes("__nixGetOrCreateSignal")) runtimeImports.push("__nixGetOrCreateSignal");
        return;
      }

      if (names.createForm && callee === names.createForm) {
        const formId = `${fileId}:${localName}`;
        const arrow = t.arrowFunctionExpression([], t.blockStatement([t.returnStatement(initNode)]));
        nodePath.node.init = t.callExpression(t.identifier("__nixGetOrCreateForm"), [
          t.stringLiteral(formId),
          arrow,
        ]);
        if (!runtimeImports.includes("__nixGetOrCreateForm")) runtimeImports.push("__nixGetOrCreateForm");
        return;
      }

      if (names.createStore && callee === names.createStore) {
        const storeId = `${fileId}:${localName}`;
        const arrow = t.arrowFunctionExpression([], t.blockStatement([t.returnStatement(initNode)]));
        nodePath.node.init = t.callExpression(t.identifier("__nixGetOrCreateStore"), [
          t.stringLiteral(storeId),
          arrow,
        ]);
        if (!runtimeImports.includes("__nixGetOrCreateStore")) runtimeImports.push("__nixGetOrCreateStore");
        return;
      }

      if (names.createRouter && callee === names.createRouter) {
        const routerId = `${fileId}:${localName}`;
        const arrow = t.arrowFunctionExpression([], t.blockStatement([t.returnStatement(initNode)]));
        nodePath.node.init = t.callExpression(t.identifier("__nixGetOrCreateRouter"), [
          t.stringLiteral(routerId),
          arrow,
        ]);
        if (!runtimeImports.includes("__nixGetOrCreateRouter")) runtimeImports.push("__nixGetOrCreateRouter");
      }
    },
    CallExpression(nodePath: NodePath<t.CallExpression>) {
      const callee = nodePath.node.callee;
      if (!t.isIdentifier(callee) || !names.mount || callee.name !== names.mount) return;
      if (t.isIdentifier(callee, { name: "__nixMount" })) return;
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
        t.callExpression(t.identifier("__nixMount"), [
          t.stringLiteral(mountId),
          factory,
          containerArg,
          optionsArg,
        ])
      );
      nodePath.skip();
      if (!runtimeImports.includes("__nixMount")) runtimeImports.push("__nixMount");
    },
  });

  if (!runtimeImports.length) return null;

  // Check if there's already a runtime import (e.g. from compilerTransform)
  const existingRuntimeImport = ast.program.body.find(
    (n): n is t.ImportDeclaration =>
      t.isImportDeclaration(n) && n.source.value === "@deijose/vite-plugin-nix-js/runtime"
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
    ast.program.body.unshift(makeRuntimeImport(runtimeImports));
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
                    t.callExpression(t.identifier("__nixHmrAccept"), [
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
    if (!runtimeImports.includes("__nixHmrAccept")) {
      const imp = ast.program.body.find(
        (n): n is t.ImportDeclaration =>
          t.isImportDeclaration(n) && n.source.value === "@deijose/vite-plugin-nix-js/runtime"
      );
      if (imp) {
        imp.specifiers.push(t.importSpecifier(t.identifier("__nixHmrAccept"), t.identifier("__nixHmrAccept")));
      }
    }
    ast.program.body.push(acceptBlock);
  }

  const result = generate(ast, { sourceMaps: true, sourceFileName: fileId });
  return result.code;
}

// =============================================================================
// --- Compiler transform: html`` → __nixCompiledTemplate calls ---
// =============================================================================

/**
 * Detects `html` tagged template expressions and compiles them into
 * pre-computed __nixCompiledTemplate factory calls.
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
      return {
        code: `__nixCompiledRepeatDirect(()=>(${generate(items).code}),${generate(key).code},(parent,before,${params.join(",")})=>${factoryName}$mount(parent,before,${args.join(",")}))`,
        runtimeImport: "__nixCompiledRepeatDirect",
      };
    }
    return {
      code: `__nixCompiledRepeat(()=>(${generate(items).code}),${generate(key).code},${generate(render).code})`,
      runtimeImport: "__nixCompiledRepeat",
    };
  }
  return { code: generate(node).code };
}

function classifyExpression(node: t.Expression): ExpressionKind {
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

function compilerTransform(code: string, fileId: string): string | null {
  let ast: t.File;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: ["typescript", "jsx", "importMeta", "topLevelAwait"],
    });
  } catch {
    return null;
  }

  // Find the local name for the `html` import
  let htmlLocalName: string | null = null;
  let repeatLocalName: string | null = null;

  traverse(ast, {
    ImportDeclaration(nodePath: NodePath<t.ImportDeclaration>) {
      const source = nodePath.node.source.value;
      if (!isNixImport(source)) return;
      for (const specifier of nodePath.node.specifiers) {
        if (!t.isImportSpecifier(specifier) || !t.isIdentifier(specifier.imported)) continue;
        if (specifier.imported.name === "html") htmlLocalName = specifier.local.name;
        if (specifier.imported.name === "repeat") repeatLocalName = specifier.local.name;
      }
    },
  });

  if (!htmlLocalName) return null;

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

      const id = `_nixFactory$${factoryCounter++}`;
      factories.push({
        id,
        strings,
        exprNodes,
        expressionKinds: exprNodes.map(classifyExpression),
        path: nodePath,
      });
    },
  });

  if (factories.length === 0) return null;

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
    // Compile the template
    const compiled = compileTemplate(strings, expressionKinds);
    if (compiled.specialized) specializedFactories.add(id);

    // Generate factory code string and parse it into an AST node
    const generatedFactory = genFactoryCode(id, compiled);
    const factoryAst = parse(generatedFactory.code, {
      sourceType: "module",
      plugins: ["typescript"],
    });
    // genFactoryCode may produce multiple declarations (resolver + factory)
    for (const decl of factoryAst.program.body) {
      factoryDecls.push(decl as t.Statement);
    }

    // Generate the call expression to replace html``
    const loweredExpressions = exprNodes.map((node) =>
      lowerCompiledExpression(node, repeatLocalName, specializedFactories)
    );
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
    path.replaceWith(callExpr);

    for (const runtimeImport of generatedFactory.runtimeImports) {
      if (!runtimeImports.includes(runtimeImport)) runtimeImports.push(runtimeImport);
    }
  }

  // Insert factory declarations at the top of the module (after imports)
  const firstNonImport = ast.program.body.findIndex(
    (n) => !t.isImportDeclaration(n)
  );
  const insertIndex = firstNonImport === -1 ? ast.program.body.length : firstNonImport;
  ast.program.body.splice(insertIndex, 0, ...factoryDecls);

  // Add runtime import for __nixCompiledTemplate
  if (runtimeImports.length > 0) {
    // Check if there's already a runtime import
    const existingRuntimeImport = ast.program.body.find(
      (n): n is t.ImportDeclaration =>
        t.isImportDeclaration(n) && n.source.value === "@deijose/vite-plugin-nix-js/runtime"
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
      ast.program.body.unshift(makeRuntimeImport(runtimeImports));
    }
  }

  const result = generate(ast, { sourceMaps: true, sourceFileName: fileId });
  return result.code;
}

export default function nixJsPlugin(options: NixJsPluginOptions = {}): Plugin {
  const opts = {
    preserveState: true,
    preserveDOM: true,
    devtools: false,
    compiler: true,
    ...options,
  };

  return {
    name: "vite-plugin-nix-js",
    enforce: "pre",

    transform(code, id, transformOptions) {
      if (!id.endsWith(".ts") && !id.endsWith(".tsx") && !id.endsWith(".js") && !id.endsWith(".jsx")) {
        return null;
      }
      if (id.includes("node_modules")) return null;
      // Skip the plugin's own runtime files (both source and dist)
      if (id.includes("vite-plugin-nix-js/runtime")) return null;
      if (id.includes("vite-plugin-nix/dist/runtime")) return null;
      if (id.includes("vite-plugin-nix/src/runtime")) return null;

      // Detect SSR: Vite 5-7 passes options.ssr, Vite 8 uses this.environment.
      // In SSR mode, skip compiler and HMR transforms — they produce browser-only
      // code (document.createElement, window). The original html`` with buildHTML()
      // is server-safe and produces HTML strings for SSR.
      // Interpolation transform is syntactic only and safe for both paths.
      const isSSR = transformOptions?.ssr === true ||
        (this as any)?.environment?.config?.consumer === "server";

      const cwd = process.cwd();
      const fileId = id.startsWith(cwd) ? id.slice(cwd.length + 1) : id;

      // Phase 1: Interpolation transform — rewrite partial attribute
      // interpolations in html`` templates into full bindings.
      // Safe for SSR: it only rewrites syntax, no runtime impact.
      let currentCode = code;
      const interpResult = transformInterpolation(currentCode, fileId);
      if (interpResult) {
        currentCode = interpResult;
      }

      // Phase 2: Compiler transform — compile html`` templates into
      // pre-computed factory calls (eliminates detectContext, buildHTML,
      // and both TreeWalkers at runtime). Browser-only: skip in SSR.
      if (opts.compiler && !isSSR) {
        const compilerResult = compilerTransform(currentCode, fileId);
        if (compilerResult) {
          currentCode = compilerResult;
        }
      }

      // Phase 3: HMR transform — preserve signals/stores/forms/routers/mounts.
      // Browser-only: the HMR runtime accesses window, skip in SSR.
      if (!isSSR) {
        const hmrResult = hmrTransform(currentCode, fileId);
        if (hmrResult) {
          currentCode = hmrResult;
        }
      }

      if (currentCode === code) return null;

      return { code: currentCode, map: null };
    },
  };
}
