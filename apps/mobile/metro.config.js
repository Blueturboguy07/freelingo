// Metro in a pnpm monorepo: watch the workspace root so edits in packages/* trigger a
// reload, and resolve modules from both the app and the hoisted root node_modules.
// See https://docs.expo.dev/guides/monorepos/
//
// Two things here are load-bearing and were both found by bundling on a real device, not
// by typechecking:
//
// 1. `disableHierarchicalLookup` is deliberately NOT set. That flag is for a *hoisted*
//    (npm/yarn) monorepo; under pnpm every package's own dependencies live beside it in
//    `node_modules/.pnpm/<pkg>@<version>/node_modules/`, which only the hierarchical
//    (walk-up) resolver can reach. With it on, bundling dies at the first transitive
//    import: `Unable to resolve "expo-modules-core" from expo/src/Expo.ts`.
//
// 2. The workspace packages are ESM TypeScript and import each other with explicit
//    `.js` extensions (`export * from './db.js'`), which is what NodeNext requires of
//    source that will be run by Node. Metro resolves extensions itself and has no such
//    rewrite, so those specifiers are rewritten below — and only for files inside
//    `packages/`, so nothing in node_modules changes resolution.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const packagesRoot = path.join(workspaceRoot, 'packages') + path.sep;

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolveRequest ?? context.resolveRequest;
  const from = context.originModulePath ?? '';
  if (from.startsWith(packagesRoot) && moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    return resolve(context, moduleName.slice(0, -'.js'.length), platform);
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
