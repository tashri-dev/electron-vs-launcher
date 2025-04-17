const { app, BrowserWindow } = require('electron');
const path = require('path');
require('@electron/remote/main').initialize();

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        icon: path.join(__dirname, 'assets', 'MyIcon.iconset', 'icon_256x256.png'), 
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        },
        title: "Make it Easy - Solution Launcher"
    });

    require('@electron/remote/main').enable(win.webContents);
    win.loadFile('index.html');

    if (process.env.NODE_ENV === 'development') {
        win.webContents.openDevTools();
    }
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
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
