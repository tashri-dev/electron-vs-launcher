const { app, BrowserWindow, ipcMain } = require("electron");
const { getVersionInfo } = require("./version");

const UPDATE_CHANNELS = {
  STATUS: "updater:status",
  PROGRESS: "updater:progress",
};

let mainWindow = null;
let autoUpdater = null;

function sendToRenderer(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function setStatus(status, details = {}) {
  sendToRenderer(UPDATE_CHANNELS.STATUS, { status, ...details });
}

function registerIpcHandlers() {
  ipcMain.handle("updater:check", async () => {
    if (!app.isPackaged) {
      return { status: "dev" };
    }

    try {
      const result = await autoUpdater.checkForUpdates();
      return { status: "checking", updateInfo: result?.updateInfo ?? null };
    } catch (error) {
      setStatus("error", { message: error.message });
      return { status: "error", message: error.message };
    }
  });

  ipcMain.handle("updater:install", () => {
    if (!app.isPackaged) {
      return { ok: false, reason: "dev" };
    }

    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  });

  ipcMain.handle("app:get-version", () => ({
    ...getVersionInfo(),
    isPackaged: app.isPackaged,
  }));

  ipcMain.handle("updater:get-version", () => app.getVersion());
}

function bindAutoUpdaterEvents() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    setStatus("checking");
  });

  autoUpdater.on("update-available", (info) => {
    setStatus("available", {
      version: info.version,
      releaseDate: info.releaseDate,
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    setStatus("not-available", { version: info.version });
  });

  autoUpdater.on("download-progress", (progress) => {
    sendToRenderer(UPDATE_CHANNELS.PROGRESS, {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
    setStatus("downloading", { percent: progress.percent });
  });

  autoUpdater.on("update-downloaded", (info) => {
    setStatus("downloaded", { version: info.version });
  });

  autoUpdater.on("error", (error) => {
    setStatus("error", { message: error.message });
  });
}

function initUpdater(getMainWindow) {
  mainWindow = getMainWindow;
  registerIpcHandlers();

  if (!app.isPackaged) {
    setStatus("dev");
    return;
  }

  ({ autoUpdater } = require("electron-updater"));
  bindAutoUpdaterEvents();

  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((error) => {
      setStatus("error", { message: error.message });
    });
  }, 3000);
}

module.exports = {
  initUpdater,
  UPDATE_CHANNELS,
};
