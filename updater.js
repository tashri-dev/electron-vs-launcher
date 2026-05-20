const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const { getVersionInfo } = require("./version");
const userSettings = require("./user-settings");

const UPDATE_CHANNELS = {
  STATUS: "updater:status",
  PROGRESS: "updater:progress",
};

let mainWindow = null;
let autoUpdater = null;
/** Avoid follow-up updater events overwriting UI after download is finished. */
let updateReadyToInstall = false;

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

function notifyStatusUnlessInstallPending(status, details = {}) {
  if (
    updateReadyToInstall &&
    (status === "checking" ||
      status === "not-available" ||
      status === "available" ||
      status === "downloading")
  ) {
    return;
  }
  setStatus(status, details);
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
      if (!updateReadyToInstall) {
        setStatus("error", { message: error.message });
      }
      return { status: "error", message: error.message };
    }
  });

  ipcMain.handle("updater:install", () => {
    if (!app.isPackaged) {
      return { ok: false, reason: "dev" };
    }

    if (process.platform === "darwin") {
      const fsSync = require("fs");
      const helper = autoUpdater.downloadedUpdateHelper;
      const zipPath = helper && helper.file ? String(helper.file).trim() : "";

      if (zipPath && fsSync.existsSync(zipPath)) {
        try {
          const { launchReplaceFromZip } = require("./mac-install-update");
          launchReplaceFromZip(zipPath);
          setImmediate(() => {
            for (const w of BrowserWindow.getAllWindows()) {
              try {
                if (!w.isDestroyed()) {
                  w.destroy();
                }
              } catch {
                /* ignore */
              }
            }
            app.quit();
          });
          return { ok: true };
        } catch (error) {
          setStatus("error", { message: error.message });
          return { ok: false, message: error.message };
        }
      }

      /*
       * Fallback: Squirrel / native install (typically needs code signing).
       */
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    }

    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  });

  ipcMain.handle("app:get-version", () => ({
    ...getVersionInfo(),
    isPackaged: app.isPackaged,
  }));

  ipcMain.handle("app:get-user-settings", () =>
    userSettings.getUserSettingsForRenderer()
  );

  ipcMain.handle("app:set-user-settings", (_event, patch) => {
    if (patch && Object.prototype.hasOwnProperty.call(patch, "rootPath")) {
      userSettings.setRootPathOverride(patch.rootPath);
    }
    return userSettings.getUserSettingsForRenderer();
  });

  ipcMain.handle("app:open-directory-dialog", async () => {
    const parentWindow =
      typeof mainWindow === "function" ? mainWindow() : mainWindow;
    const parent =
      parentWindow && !parentWindow.isDestroyed()
        ? parentWindow
        : BrowserWindow.getFocusedWindow() || undefined;

    const result = await dialog.showOpenDialog(parent, {
      properties: ["openDirectory", "createDirectory"],
    });

    if (result.canceled || !result.filePaths?.length) {
      return { canceled: true, path: null };
    }

    return { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle("updater:get-version", () => app.getVersion());
}

function bindAutoUpdaterEvents() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    notifyStatusUnlessInstallPending("checking");
  });

  autoUpdater.on("update-available", (info) => {
    notifyStatusUnlessInstallPending("available", {
      version: info.version,
      releaseDate: info.releaseDate,
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    notifyStatusUnlessInstallPending("not-available", { version: info.version });
  });

  autoUpdater.on("download-progress", (progress) => {
    if (updateReadyToInstall) {
      return;
    }
    sendToRenderer(UPDATE_CHANNELS.PROGRESS, {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
    setStatus("downloading", { percent: progress.percent });
  });

  autoUpdater.on("update-downloaded", (info) => {
    updateReadyToInstall = true;
    setStatus("downloaded", { version: info.version });
  });

  autoUpdater.on("error", (error) => {
    if (updateReadyToInstall) {
      return;
    }
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
      if (!updateReadyToInstall) {
        setStatus("error", { message: error.message });
      }
    });
  }, 3000);
}

module.exports = {
  initUpdater,
  UPDATE_CHANNELS,
};
