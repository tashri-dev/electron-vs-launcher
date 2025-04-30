const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
require('@electron/remote/main').initialize();

// Enable error handling
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

function createWindow() {
    try {
        const win = new BrowserWindow({
            width: 1200,
            height: 800,
            icon: path.join(__dirname, 'assets', 'MyIcon.iconset', 'icon_256x256.png'),
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                enableRemoteModule: true,
                webSecurity: false
            },
            title: "Make it Easy - Solution Launcher"
        });

        require('@electron/remote/main').enable(win.webContents);

        // Load the index.html file
        win.loadFile('index.html');

        // Open DevTools in development
        if (process.env.NODE_ENV === 'development') {
            win.webContents.openDevTools();
        }

        // Log window creation
        console.log('Main window created successfully');

        // Handle window errors
        win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
            console.error('Window failed to load:', errorCode, errorDescription);
        });

        return win;
    } catch (error) {
        console.error('Error creating window:', error);
        throw error;
    }
}

app.whenReady().then(() => {
    try {
        console.log('App is ready, creating window...');
        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    } catch (error) {
        console.error('Error in app ready handler:', error);
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Add IPC handlers for debugging
ipcMain.on('debug-log', (event, message) => {
    console.log('Renderer Debug:', message);
});

// Handle any uncaught errors
app.on('error', (error) => {
    console.error('App Error:', error);
});
