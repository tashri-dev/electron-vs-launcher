"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

function currentMacBundlePath() {
  const resolved = path.resolve(path.join(process.execPath, "..", "..", ".."));
  if (!resolved.endsWith(".app")) {
    return null;
  }
  return resolved;
}

function findAppInsideDir(dir, depth = 0, maxDepth = 5) {
  if (depth > maxDepth) {
    return null;
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name.endsWith(".app")) {
      return full;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    const nested = findAppInsideDir(full, depth + 1, maxDepth);
    if (nested) {
      return nested;
    }
  }

  return null;
}

/**
 * Unsigned / non-Squirrel macOS builds: replace the running .app using the ZIP
 * electron-updater already downloaded (downloadedUpdateHelper.file).
 */
function launchReplaceFromZip(zipPath) {
  const bundleTarget = currentMacBundlePath();
  if (!bundleTarget || !fs.existsSync(bundleTarget)) {
    throw new Error("Could not locate the running application bundle (.app)");
  }

  if (!fs.existsSync(zipPath)) {
    throw new Error(`Update ZIP not found: ${zipPath}`);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evl-mac-up-"));

  const unzip = spawnSync("/usr/bin/unzip", ["-o", "-q", zipPath, "-d", tmpRoot]);
  if (unzip.status !== 0) {
    const detail =
      unzip.stderr?.toString() || unzip.stdout?.toString() || unzip.error?.message || "unknown error";
    throw new Error(`Failed to unzip update: ${detail.trim()}`);
  }

  const newApp = findAppInsideDir(tmpRoot);
  if (!newApp || !fs.existsSync(newApp)) {
    throw new Error("Update ZIP did not contain a .app bundle");
  }

  const scriptBody = `set -eu
WAIT_PID="$1"
TARGET="$2"
SOURCE="$3"
i=0
while [ "$i" -lt 600 ] && kill -0 "$WAIT_PID" 2>/dev/null; do
  i=$((i + 1))
  sleep 0.1
done
/bin/rm -rf "$TARGET"
/usr/bin/ditto "$SOURCE" "$TARGET"
/usr/bin/open "$TARGET"
`;

  const scriptPath = path.join(tmpRoot, "evl-mac-replace-app.sh");
  fs.writeFileSync(scriptPath, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o755 });

  spawn("/bin/sh", [scriptPath, String(process.pid), bundleTarget, newApp], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

module.exports = { launchReplaceFromZip };
