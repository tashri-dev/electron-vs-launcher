const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');
const fs = require('fs');
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
            icon: path.join(__dirname, 'assets', 'icons', 'macos', 'app.icns'),
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                enableRemoteModule: true,
                webSecurity: false
            },
            title: "AP - Solution Launcher"
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

// Handle terminal launching in main process
ipcMain.handle('launch-terminal', async (event, { solutionPath, solutionName, platform, solutionType, dockerPort, startupProject, runArgs }) => {
    console.log(`[Main Process] Launching terminal for: ${solutionName} at ${solutionPath}`);
    console.log(`[Main Process] Solution type: ${solutionType}`);

    try {
        const result = await launchTerminalInMainProcess(solutionPath, solutionName, platform, solutionType, dockerPort, startupProject, runArgs);
        console.log(`[Main Process] Terminal launch result:`, result);
        return result;
    } catch (error) {
        console.error(`[Main Process] Terminal launch error:`, error);
        return { success: false, error: error.message };
    }
});

// Terminal launching function in main process
async function launchTerminalInMainProcess(solutionPath, solutionName, platform, solutionType, dockerPort, startupProject, runArgs) {
    return new Promise((resolve, reject) => {
        console.log(`[Main Process] Platform: ${platform}, Solution: ${solutionName}, Type: ${solutionType}`);

        // Check if solution path exists
        if (!fs.existsSync(solutionPath)) {
            const error = `Solution path does not exist: ${solutionPath}`;
            console.error(`[Main Process] ${error}`);
            resolve({ success: false, error });
            return;
        }

        // Determine the solution directory based on solution type
        let solutionDir;
        if (solutionType === 'dotnet') {
            // For .NET solutions, the path is a .sln file, so get the directory
            solutionDir = path.dirname(solutionPath);
        } else {
            // For Angular, Node.js, etc., the path is already a directory
            // Check if it's a file or directory
            try {
                const stats = fs.statSync(solutionPath);
                if (stats.isFile()) {
                    solutionDir = path.dirname(solutionPath);
                } else {
                    solutionDir = solutionPath;
                }
            } catch (error) {
                // If we can't stat it, assume it's a directory
                solutionDir = solutionPath;
            }
        }
        
        console.log(`[Main Process] Solution directory: ${solutionDir}`);

        // Generate startup command based on solution type
        const startupCommand = generateStartupCommand(solutionType, solutionDir, solutionPath, startupProject, runArgs, dockerPort);
        console.log(`[Main Process] Startup command: ${startupCommand}`);

        let command, args;

        if (platform === 'darwin') {
            // macOS - Use AppleScript to open Terminal
            const escapedPath = solutionDir.replace(/'/g, "'\"'\"'");
            // Escape the command more carefully for AppleScript
            const escapedCommand = startupCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "'\"'\"'");
            const script = `
                tell application "Terminal"
                    if not (exists window 1) then reopen
                    activate
                    do script "cd '${escapedPath}' && echo 'Starting ${solutionName} (${solutionType})...' && ${escapedCommand}"
                end tell
            `;

            console.log(`[Main Process] Executing AppleScript...`);
            command = 'osascript';
            args = ['-e', script];

        } else if (platform === 'win32') {
            // Windows
            console.log(`[Main Process] Opening Windows CMD...`);
            command = 'cmd';
            args = ['/c', 'start', 'cmd', '/k', `cd /d "${solutionDir}" && echo Starting ${solutionName} (${solutionType})... && ${startupCommand}`];

        } else {
            // Linux
            console.log(`[Main Process] Opening Linux terminal...`);
            command = 'gnome-terminal';
            args = ['--working-directory', solutionDir, '--', 'bash', '-c', `echo "Starting ${solutionName} (${solutionType})..." && ${startupCommand}; exec bash`];
        }

        console.log(`[Main Process] Spawning: ${command} ${args.join(' ')}`);

        const child = spawn(command, args, {
            detached: true,
            stdio: 'ignore'
        });

        child.on('error', (error) => {
            console.error(`[Main Process] Spawn error:`, error);
            resolve({ success: false, error: error.message });
        });

        child.on('spawn', () => {
            console.log(`[Main Process] Process spawned successfully`);
            child.unref(); // Allow the main process to exit
            resolve({ success: true, message: `Terminal opened for ${solutionName}` });
        });

        child.on('exit', (code, signal) => {
            console.log(`[Main Process] Process exited with code ${code}, signal ${signal}`);
            if (code === 0) {
                resolve({ success: true, message: `Terminal opened for ${solutionName}` });
            } else {
                resolve({ success: false, error: `Process exited with code ${code}` });
            }
        });

        // Timeout fallback
        setTimeout(() => {
            console.log(`[Main Process] Terminal launch timeout - assuming success`);
            resolve({ success: true, message: `Terminal launched for ${solutionName} (timeout)` });
        }, 2000);
    });
}

// Check if a .csproj file is actually runnable (not a library)
function isRunnableProject(projectPath) {
    try {
        if (!fs.existsSync(projectPath)) {
            return false;
        }
        
        const projectContent = fs.readFileSync(projectPath, 'utf8');
        
        // Check if it's a library (OutputType Library) - these are NOT runnable
        if (projectContent.includes('<OutputType>Library</OutputType>')) {
            return false;
        }
        
        // Check if it's explicitly an executable (OutputType Exe or WinExe)
        if (projectContent.includes('<OutputType>Exe</OutputType>') || 
            projectContent.includes('<OutputType>WinExe</OutputType>')) {
            return true;
        }
        
        // If no OutputType is specified, check if it has Program.cs (likely runnable)
        const projectDir = path.dirname(projectPath);
        const programPath = path.join(projectDir, 'Program.cs');
        
        if (fs.existsSync(programPath)) {
            // Has Program.cs, likely runnable unless explicitly marked as Library
            return true;
        }
        
        // Default: if no OutputType specified and no Program.cs, assume it might be runnable
        return true;
    } catch (error) {
        console.warn(`[Main Process] Error checking if project is runnable: ${projectPath}`, error);
        return false;
    }
}

// Find a runnable .NET project in the solution directory
function findRunnableProject(solutionDir) {
    try {
        const runnableProjects = [];
        
        // Search for projects with common patterns
        function searchDirectory(dir, depth = 0) {
            if (depth > 4) return; // Limit search depth
            
            try {
                const items = fs.readdirSync(dir);
                
                for (const item of items) {
                    const itemPath = path.join(dir, item);
                    
                    try {
                        const stats = fs.statSync(itemPath);
                        
                        if (stats.isDirectory()) {
                            // Look for .csproj files in this directory
                            const csprojFiles = fs.readdirSync(itemPath).filter(f => f.endsWith('.csproj'));
                            
                            for (const csprojFile of csprojFiles) {
                                const projectPath = path.join(itemPath, csprojFile);
                                
                                // Only add if it's actually runnable (not a library)
                                if (isRunnableProject(projectPath)) {
                                    if (!runnableProjects.includes(projectPath)) {
                                        runnableProjects.push(projectPath);
                                    }
                                }
                            }
                            
                            // Recurse into subdirectories (but skip common non-project directories)
                            if (!item.startsWith('.') && 
                                item !== 'bin' && 
                                item !== 'obj' && 
                                item !== 'node_modules' &&
                                item !== 'packages') {
                                searchDirectory(itemPath, depth + 1);
                            }
                        }
                    } catch (error) {
                        // Ignore permission errors
                    }
                }
            } catch (error) {
                // Ignore permission errors
            }
        }
        
        searchDirectory(solutionDir);
        
        // Sort by preference: Services.Api first, then other API projects, then Web, then Host, then App
        runnableProjects.sort((a, b) => {
            const aName = path.basename(a).toLowerCase();
            const bName = path.basename(b).toLowerCase();
            const aDir = path.dirname(a).toLowerCase();
            const bDir = path.dirname(b).toLowerCase();
            const aFullPath = a.toLowerCase();
            const bFullPath = b.toLowerCase();
            
            // Highest priority: Services.Api projects
            const aIsServicesApi = aFullPath.includes('services.api') || aDir.includes('services.api');
            const bIsServicesApi = bFullPath.includes('services.api') || bDir.includes('services.api');
            if (aIsServicesApi && !bIsServicesApi) return -1;
            if (!aIsServicesApi && bIsServicesApi) return 1;
            
            // Second priority: Other API projects (but not Application which are libraries)
            const aIsApi = (aName.includes('api') || aDir.includes('api')) && !aIsServicesApi && !aName.includes('application');
            const bIsApi = (bName.includes('api') || bDir.includes('api')) && !bIsServicesApi && !bName.includes('application');
            if (aIsApi && !bIsApi) return -1;
            if (!aIsApi && bIsApi) return 1;
            
            // Third priority: Web projects
            if ((aName.includes('web') || aDir.includes('web')) && !(bName.includes('web') || bDir.includes('web'))) return -1;
            if (!(aName.includes('web') || aDir.includes('web')) && (bName.includes('web') || bDir.includes('web'))) return 1;
            
            // Fourth priority: Host projects
            if ((aName.includes('host') || aDir.includes('host')) && !(bName.includes('host') || bDir.includes('host'))) return -1;
            if (!(aName.includes('host') || aDir.includes('host')) && (bName.includes('host') || bDir.includes('host'))) return 1;
            
            // Fifth priority: App projects (but not Application which are usually libraries)
            const aIsApp = (aName.includes('app') || aDir.includes('app')) && !aName.includes('application');
            const bIsApp = (bName.includes('app') || bDir.includes('app')) && !bName.includes('application');
            if (aIsApp && !bIsApp) return -1;
            if (!aIsApp && bIsApp) return 1;
            
            return 0;
        });
        
        if (runnableProjects.length > 0) {
            console.log(`[Main Process] Found ${runnableProjects.length} runnable projects, using: ${runnableProjects[0]}`);
            return runnableProjects[0];
        }
        
        return null;
    } catch (error) {
        console.error(`[Main Process] Error finding runnable project:`, error);
        return null;
    }
}

// Generate startup command based on solution type
function generateStartupCommand(solutionType, solutionDir, solutionPath, startupProject, runArgs, dockerPort) {
    console.log(`[Main Process] Generating startup command for type: ${solutionType}`);

    switch (solutionType?.toLowerCase()) {
        case 'dotnet':
            // For .NET solutions, use dotnet run with startup project if specified
            if (startupProject) {
                // If startupProject is relative, resolve it from the root Work directory, not solutionDir
                let projectPath;
                if (path.isAbsolute(startupProject)) {
                    projectPath = startupProject;
                } else {
                    // Extract root path from solutionDir (assuming it contains 'Work')
                    const workIndex = solutionDir.indexOf('/Work/');
                    if (workIndex !== -1) {
                        const rootPath = solutionDir.substring(0, workIndex + 6); // Include '/Work/'
                        projectPath = path.join(rootPath, startupProject);
                    } else {
                        projectPath = path.join(solutionDir, startupProject);
                    }
                }

                console.log(`[Main Process] Using startup project: ${projectPath}`);

                if (runArgs) {
                    return `dotnet run --project "${projectPath}" ${runArgs}`;
                } else {
                    return `dotnet run --project "${projectPath}"`;
                }
            } else {
                // Auto-detect a runnable project if no startupProject is specified
                const detectedProject = findRunnableProject(solutionDir);
                if (detectedProject) {
                    console.log(`[Main Process] Auto-detected project: ${detectedProject}`);
                    if (runArgs) {
                        return `dotnet run --project "${detectedProject}" ${runArgs}`;
                    } else {
                        return `dotnet run --project "${detectedProject}"`;
                    }
                } else {
                    // Fallback to dotnet run in solution directory (might fail if multiple projects)
                    console.warn(`[Main Process] No runnable project detected, using dotnet run in solution directory`);
                    if (runArgs) {
                        return `dotnet run ${runArgs}`;
                    } else {
                        return `dotnet run`;
                    }
                }
            }

        case 'nodejs':
            // For Node.js projects, check for package.json and run appropriate command
            return `if [ -f "package.json" ]; then if [ -f "package-lock.json" ]; then echo "Starting with npm..." && npm start; elif [ -f "yarn.lock" ]; then echo "Starting with yarn..." && yarn start; else echo "Starting with npm..." && npm start; fi; else echo "No package.json found in $(pwd)"; fi`;

        case 'angular':
            // For Angular projects, try ng serve
            return `if [ -f "angular.json" ] || [ -f ".angular-cli.json" ]; then echo "Starting Angular project..." && ng serve; elif [ -f "package.json" ]; then echo "Starting with npm..." && npm start; else echo "No Angular or package.json found in $(pwd)"; fi`;

        case 'docker':
            // For Docker projects
            if (dockerPort) {
                return `echo "Starting Docker project..." && docker-compose up -d || docker run -p ${dockerPort}:${dockerPort} .`;
            } else {
                return `echo "Starting Docker project..." && docker-compose up -d || docker run .`;
            }

        default:
            // Generic fallback - just show directory contents and leave terminal open
            return `echo "Solution type: ${solutionType || 'Unknown'}" && echo "Directory: $(pwd)" && echo "Manual startup required. Available files:" && ls -la`;
    }
}

// Handle any uncaught errors
app.on('error', (error) => {
    console.error('App Error:', error);
});
