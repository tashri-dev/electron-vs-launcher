const { getVersionInfo } = require("../src/version");

const info = getVersionInfo();
console.log(info.display);
if (info.commit) {
  console.log(`  commit: ${info.commit}`);
}
if (info.builtAt) {
  console.log(`  built:  ${info.builtAt}`);
}
