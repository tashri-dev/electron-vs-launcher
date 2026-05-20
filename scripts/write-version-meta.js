const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkg = require(path.join(root, "package.json"));

let commit = null;
try {
  commit = execSync("git rev-parse --short HEAD", {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // Not a git repo or git unavailable
}

const meta = {
  version: pkg.version,
  commit,
  builtAt: new Date().toISOString(),
};

const outPath = path.join(root, "version-meta.json");
fs.writeFileSync(outPath, `${JSON.stringify(meta, null, 2)}\n`);
console.log(`Wrote ${path.relative(root, outPath)}: v${meta.version}${commit ? ` @ ${commit}` : ""}`);
