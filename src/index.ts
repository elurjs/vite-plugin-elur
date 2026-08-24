import { parse } from "@babel/parser";
import _generate from "@babel/generator";
import * as t from "@babel/types";
import _traverse, { type NodePath } from "@babel/traverse";
import type { Plugin } from "vite";
import { transformInterpolation } from "./interpolation.js";

// @babel/traverse and @babel/generator are CommonJS modules whose default
// export can be nested under `.default` when consumed from an ESM bundle.
const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;
const generate = ((_generate as unknown as { default?: typeof _generate }).default ?? _generate) as typeof _generate;

export interface NixPluginOptions {
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
   * Inject Nix devtools client.
   * @default false
   */
  devtools?: boolean;
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

  ast.program.body.unshift(makeRuntimeImport(runtimeImports));

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

export default function nixPlugin(options: NixPluginOptions = {}): Plugin {
  const opts = {
    preserveState: true,
    preserveDOM: true,
    devtools: false,
    ...options,
  };

  return {
    name: "vite-plugin-nix-js",
    enforce: "pre",

    transform(code, id) {
      if (!id.endsWith(".ts") && !id.endsWith(".tsx") && !id.endsWith(".js") && !id.endsWith(".jsx")) {
        return null;
      }
      if (id.includes("node_modules")) return null;
      if (id.includes("vite-plugin-nix-js/runtime")) return null;

      const cwd = process.cwd();
      const fileId = id.startsWith(cwd) ? id.slice(cwd.length + 1) : id;

      // Phase 1: Interpolation transform — rewrite partial attribute
      // interpolations in html`` templates into full bindings.
      let currentCode = code;
      const interpResult = transformInterpolation(currentCode, fileId);
      if (interpResult) {
        currentCode = interpResult;
      }

      // Phase 2: HMR transform — preserve signals/stores/forms/routers/mounts.
      const hmrResult = hmrTransform(currentCode, fileId);
      if (hmrResult) {
        currentCode = hmrResult;
      }

      if (currentCode === code) return null;

      return { code: currentCode, map: null };
    },
  };
}
