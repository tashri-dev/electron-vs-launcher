const fs = require("fs");
const path = require("path");
const { app } = require("electron");

function getSettingsPath() {
  return path.join(app.getPath("userData"), "user-settings.json");
}

function readRawSettings() {
  const filePath = getSettingsPath();
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeRawSettings(data) {
  const filePath = getSettingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function getUserSettingsForRenderer() {
  const data = readRawSettings();
  const rootPath =
    typeof data.rootPath === "string" && data.rootPath.trim() !== ""
      ? data.rootPath.trim()
      : null;
  return { rootPath };
}

function setRootPathOverride(rootPath) {
  const data = readRawSettings();
  if (rootPath == null || String(rootPath).trim() === "") {
    delete data.rootPath;
  } else {
    data.rootPath = String(rootPath).trim();
  }
  writeRawSettings(data);
}

module.exports = {
  getUserSettingsForRenderer,
  setRootPathOverride,
};
