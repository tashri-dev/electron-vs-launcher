const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { initUpdater } = require("./updater");
const { getVersionInfo } = require("./version");

const ICON_PATH = path.join(__dirname, "build", "icon.png");
const versionInfo = getVersionInfo();

let mainWindow = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1024,
        height: 720,
        title: `${versionInfo.name} ${versionInfo.shortDisplay}`,
        ...(fs.existsSync(ICON_PATH) ? { icon: ICON_PATH } : {}),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile("index.html");
    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

function setupAboutPanel() {
    app.setAboutPanelOptions({
        applicationName: versionInfo.name,
        applicationVersion: versionInfo.version,
        version: versionInfo.commit
            ? `${versionInfo.version} (${versionInfo.commit})`
            : versionInfo.version,
        copyright: `Copyright © ${new Date().getFullYear()} Amwal Pay`,
    });
}

app.whenReady().then(() => {
    setupAboutPanel();

    if (process.platform === "darwin" && fs.existsSync(ICON_PATH)) {
        app.dock.setIcon(ICON_PATH);
    }
    createWindow();
    initUpdater(() => mainWindow);

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});