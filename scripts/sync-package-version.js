#!/usr/bin/env node
/**
 * Align package.json (and package-lock.json via npm) with a release version.
 * Used by CI after github-tag-action computes the next version.
 */
const { execSync } = require("child_process");

const version = process.argv[2];
if (!version) {
  console.error("Usage: node scripts/sync-package-version.js <version>");
  process.exit(1);
}

execSync(`npm version ${version} --no-git-tag-version --allow-same-version`, {
  stdio: "inherit",
});

console.log(`package.json version set to ${version}`);
