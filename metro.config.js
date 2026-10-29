// https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);

// The kit is never bundled, and its mock rewrites kit/.mock-state.json on
// every request: watched, each write made Metro push a (empty) Fast Refresh
// to the app at every step of an upload.
const kit = path.join(__dirname, "kit").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
config.resolver.blockList = [...config.resolver.blockList, new RegExp(`^${kit}([\\\\/].*)?$`)];

module.exports = config;
