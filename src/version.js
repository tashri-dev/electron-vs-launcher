const fs = require("fs");
const path = require("path");

const pkg = require("../package.json");

function loadBuildMeta() {
  const metaPath = path.join(__dirname, "..", "version-meta.json");
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return {};
  }
}

const buildMeta = loadBuildMeta();

function getVersionInfo() {
  const version = pkg.version;
  const name = pkg.build?.productName || pkg.name;
  const commit = buildMeta.commit || null;
  const builtAt = buildMeta.builtAt || null;

  return {
    version,
    name,
    appId: pkg.build?.appId || null,
    commit,
    builtAt,
    display: commit ? `v${version} (${commit})` : `v${version}`,
    shortDisplay: `v${version}`,
  };
}

module.exports = {
  getVersionInfo,
  version: pkg.version,
};
