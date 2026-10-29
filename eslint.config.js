// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // The kit is the unchanged candidate kit; it is linted by nobody but its authors.
    ignores: ["dist/*", "kit/*"],
  },
  {
    rules: {
      // React Compiler is on (app.json experiments.reactCompiler) and silently
      // skips any component containing syntax it can't lower. Surface it.
      "react-hooks/todo": "warn",
      "react-hooks/unsupported-syntax": "warn",
    },
  },
]);
