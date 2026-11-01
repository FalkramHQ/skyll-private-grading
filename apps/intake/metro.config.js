const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const sharedRoot = path.resolve(workspaceRoot, 'shared');
const webLibRoot = path.resolve(workspaceRoot, 'src', 'lib');
const config = getDefaultConfig(projectRoot);

config.watchFolders = [sharedRoot, webLibRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;
config.resolver.extraNodeModules = {
  '@skyll/shared': sharedRoot,
  '@skyll/web-lib': webLibRoot,
};

module.exports = config;
