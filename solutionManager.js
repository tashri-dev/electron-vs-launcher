const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const Registry = require('winreg');
const ConfigManager = require('./configManager');
const os = require('os');
const { Notification } = require('electron').remote || require('@electron/remote');
let rootPathGlobal = '';
class SolutionManager {
    constructor() {
        this.configManager = new ConfigManager();
        this.itemsPerPage = 10;
        this.currentPage = 1;
        this.solutions = [];
        this.rootPath = '';
        this.env = this.loadEnvironmentConfig();
        this.IDE = this.env.IDE;
        this.ENVIRONMENTS = {
            DEV: { name: 'Dev', branch: 'master_dev' },
            SIT: { name: 'SIT', branch: 'master_sit' },
            UAT: { name: 'UAT', branch: 'master_uat' }
        };
        this.init();
    }

    loadEnvironmentConfig() {
        const platform = process.platform;
        const envFile = platform === 'darwin' ? 'env.mac.json' : 'env.win.json';
        try {
            return JSON.parse(fs.readFileSync(path.join(__dirname, envFile), 'utf8'));
        } catch (error) {
            console.error(`Error loading environment config: ${error.message}`);
            throw error;
        }
    }

    init() {
        console.log('Initializing SolutionManager...');
        this.bindMainActions();
        this.loadSolutions();
    }

    bindMainActions() {
        console.log('Binding main actions...');
        // Main action buttons
        const buttons = {
            'clearBtn': () => this.resetSelections(),
            'selectAllBtn': () => this.selectAll(),
            'launchBtn': () => this.runSelectedSolutions(),
            'get-latest-selected': () => this.getLatestForSelected()
        };

        Object.entries(buttons).forEach(([id, action]) => {
            const button = document.getElementById(id);
            if (button) {
                button.addEventListener('click', action.bind(this));
                console.log(`Bound action to ${id}`);
            } else {
                console.warn(`Button ${id} not found`);
            }
        });
    }

    loadSolutions() {
        try {
            console.log('Loading solutions...');
            const config = this.configManager.loadConfig();
            this.solutions = config.solutions || [];
            rootPathGlobal = this.resolvePath(config.rootPath || '');
            console.log('Resolved root path:', rootPathGlobal);
            this.totalPages = Math.ceil(this.solutions.length / this.itemsPerPage);
            console.log(`Loaded ${this.solutions.length} solutions, ${this.totalPages} pages total`);
            this.displaySolutions();
        } catch (error) {
            console.error('Error loading solutions:', error);
            this.showNotification('Error', 'Failed to load solutions', 'error');
        }
    }

    displaySolutions() {
        const container = document.getElementById("solutionsContainer");
        if (!container) {
            console.error('Solutions container not found');
            return;
        }

        console.log(`Displaying solutions for page ${this.currentPage}`);
        container.innerHTML = '';

        // Calculate page slice
        const startIndex = (this.currentPage - 1) * this.itemsPerPage;
        const endIndex = Math.min(startIndex + this.itemsPerPage, this.solutions.length);
        const currentSolutions = this.solutions.slice(startIndex, endIndex);

        // Group and display solutions
        const groupedSolutions = this.groupSolutionsByParent(currentSolutions);
        Object.entries(groupedSolutions).forEach(([parentDir, solutions]) => {
            container.appendChild(this.createGroupElement(parentDir, solutions));
        });

        // Add pagination controls
        this.addPaginationControls(container);
    }

    createGroupElement(parentDir, solutions) {
        const groupDiv = document.createElement('div');
        groupDiv.classList.add('parent-directory', 'mb-4');

        const header = document.createElement('h3');
        header.textContent = parentDir;
        header.classList.add('mb-3');
        groupDiv.appendChild(header);

        groupDiv.appendChild(this.createSolutionsTable(solutions));
        return groupDiv;
    }

    createSolutionsTable(solutions) {
        const table = document.createElement('table');
        table.classList.add('table', 'table-striped', 'table-hover');

        const thead = document.createElement('thead');
        thead.innerHTML = `
            <tr>
                <th style="width: 60%">Solution Name</th>
                <th style="width: 40%">Actions</th>
            </tr>
        `;
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        solutions.forEach(solution => {
            tbody.appendChild(this.createSolutionRow(solution));
        });
        table.appendChild(tbody);

        return table;
    }

    createSolutionRow(solution) {
        const row = document.createElement('tr');

        // Name cell with checkbox
        const nameCell = document.createElement('td');
        const wrapper = document.createElement('div');
        wrapper.classList.add('d-flex', 'align-items-center', 'gap-2');

        const checkboxWrapper = document.createElement('div');
        checkboxWrapper.classList.add('form-check');

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.classList.add('form-check-input');
        checkbox.id = this.getSolutionId(solution);
        checkbox.value = solution.path;

        const label = document.createElement('label');
        label.classList.add('form-check-label');
        label.htmlFor = checkbox.id;
        label.textContent = solution.name;

        checkboxWrapper.appendChild(checkbox);
        checkboxWrapper.appendChild(label);
        wrapper.appendChild(checkboxWrapper);

        // Add IDE selector
        const ideSelector = this.createIdeSelector(solution);
        wrapper.appendChild(ideSelector);

        // Add Environment selector
        const envSelector = this.createEnvironmentSelector(solution);
        wrapper.appendChild(envSelector);

        nameCell.appendChild(wrapper);

        // Actions cell
        const actionsCell = document.createElement('td');
        actionsCell.appendChild(this.createActionButtons(solution));

        row.appendChild(nameCell);
        row.appendChild(actionsCell);

        return row;
    }

    getSolutionId(solution) {
        return `solution-${solution.name.replace(/\s+/g, '-').toLowerCase()}`;
    }

    createIdeSelector(solution) {
        const select = document.createElement('select');
        select.classList.add('form-select', 'form-select-sm', 'w-auto');
        select.id = `ide-${this.getSolutionId(solution)}`;

        Object.entries(this.IDE).forEach(([key, value]) => {
            if (solution.type === 'dotnet' || key === 'VSCODE') {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = value;
                select.appendChild(option);
            }
        });

        // Set default IDE based on solution type and platform
        if (solution.type === 'dotnet') {
            if (process.platform === 'darwin') {
                select.value = this.IDE.RIDER_NO_DEBUG;
            } else {
                select.value = this.IDE.VS2022_NO_DEBUG;
            }
        } else {
            select.value = this.IDE.VSCODE;
        }
        return select;
    }

    createEnvironmentSelector(solution) {
        const select = document.createElement('select');
        select.classList.add('form-select', 'form-select-sm', 'w-auto');
        select.id = `env-${this.getSolutionId(solution)}`;

        Object.entries(this.ENVIRONMENTS).forEach(([key, env]) => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = env.name;
            select.appendChild(option);
        });

        return select;
    }

    createActionButtons(solution) {
        const container = document.createElement('div');
        container.classList.add('d-flex', 'gap-2');
        let directory = this.getSolutionDirectory(solution);

        // Get Latest button
        const getLatestBtn = document.createElement('button');
        getLatestBtn.classList.add('btn', 'btn-secondary', 'btn-sm', 'btn-priority-high');
        getLatestBtn.innerHTML = '<i class="fa fa-download"></i>';
        getLatestBtn.onclick = () => {
            const envSelector = document.getElementById(`env-${this.getSolutionId(solution)}`);
            const selectedEnv = envSelector ? envSelector.value : 'DEV';
            const targetBranch = this.ENVIRONMENTS[selectedEnv].branch;
            this.getLatest(directory, solution.name, solution.type, targetBranch);
        };
        container.appendChild(getLatestBtn);

        // Run Solution button
        const runBtn = document.createElement('button');
        runBtn.classList.add('btn', 'btn-primary', 'btn-sm', 'btn-priority-high');
        runBtn.innerHTML = '<i class="fa fa-play"></i>';
        runBtn.onclick = () => {
            const ideSelect = document.getElementById(`ide-${this.getSolutionId(solution)}`);
            const selectedIde = ideSelect ? ideSelect.value : this.IDE.VSCODE;
            this.launchSolution(solution, selectedIde);
        };
        container.appendChild(runBtn);

        // Update DB button
        if (solution.migratorPath) {
            const updateDbBtn = document.createElement('button');
            updateDbBtn.classList.add('btn', 'btn-warning', 'btn-sm', 'btn-priority-medium');
            updateDbBtn.textContent = 'Update DB';
            updateDbBtn.onclick = () => this.updateDb(solution);
            container.appendChild(updateDbBtn);
        }

        // Dockerize button
        if (solution.dockerPort) {
            const dockerizeBtn = document.createElement('button');
            dockerizeBtn.classList.add('btn', 'btn-primary', 'btn-sm', 'btn-priority-medium');
            dockerizeBtn.textContent = 'Dockerize';
            dockerizeBtn.onclick = () => this.dockerizeApp(solution);
            container.appendChild(dockerizeBtn);
        }

        return container;
    }

    addPaginationControls(container) {
        const paginationDiv = document.createElement('div');
        paginationDiv.classList.add(
            'pagination-controls',
            'd-flex',
            'justify-content-between',
            'align-items-center',
            'mt-4'
        );

        // Page information
        const pageInfo = document.createElement('div');
        pageInfo.textContent = `Page ${this.currentPage} of ${this.totalPages}`;
        paginationDiv.appendChild(pageInfo);

        // Navigation buttons
        const buttonsDiv = document.createElement('div');
        buttonsDiv.classList.add('d-flex', 'gap-2');

        if (this.currentPage > 1) {
            const prevBtn = document.createElement('button');
            prevBtn.classList.add('btn', 'btn-secondary');
            prevBtn.textContent = 'Previous';
            prevBtn.onclick = () => {
                this.currentPage--;
                this.displaySolutions();
            };
            buttonsDiv.appendChild(prevBtn);
        }

        if (this.currentPage < this.totalPages) {
            const nextBtn = document.createElement('button');
            nextBtn.classList.add('btn', 'btn-secondary');
            nextBtn.textContent = 'Next';
            nextBtn.onclick = () => {
                this.currentPage++;
                this.displaySolutions();
            };
            buttonsDiv.appendChild(nextBtn);
        }

        paginationDiv.appendChild(buttonsDiv);
        container.appendChild(paginationDiv);
    }

    groupSolutionsByParent(solutions) {
        return solutions.reduce((acc, solution) => {
            try {
                // Normalize the path and split it properly
                const normalizedPath = path.normalize(solution.path.replace(/\\/g, '/'));
                const parts = normalizedPath.split('/');
                const parentDir = parts[0];

                if (!acc[parentDir]) acc[parentDir] = [];
                acc[parentDir].push(solution);
                return acc;
            } catch (error) {
                console.error('Error grouping solution:', error);
                return acc;
            }
        }, {});
    }

    resetSelections() {
        console.log('Resetting all selections');
        document.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
            checkbox.checked = false;
        });
    }

    selectAll() {
        console.log('Selecting all solutions');
        document.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
            checkbox.checked = true;
        });
    }

    async getLatestForSelected() {
        try {
            const selectedCheckboxes = document.querySelectorAll('input[type="checkbox"]:checked');

            if (selectedCheckboxes.length === 0) {
                this.showNotification('Warning', 'Please select at least one solution', 'warning');
                return;
            }

            for (const checkbox of selectedCheckboxes) {
                try {
                    const solutionPath = checkbox.value;
                    const solution = this.solutions.find(s => s.path === solutionPath);
                    if (!solution) {
                        console.error(`Solution not found for path: ${solutionPath}`);
                        continue;
                    }
                    const directory = this.getSolutionDirectory(solution);
                    console.log('Getting latest for directory:', directory);

                    // Get the environment selector for this solution
                    const envSelector = document.getElementById(`env-${this.getSolutionId(solution)}`);
                    const selectedEnv = envSelector ? envSelector.value : 'DEV';
                    const targetBranch = this.ENVIRONMENTS[selectedEnv].branch;

                    await this.getLatest(directory, solution.name, solution.type, targetBranch);
                } catch (error) {
                    console.error(`Error updating solution ${checkbox.value}:`, error);
                    this.showNotification('Error', `Failed to update ${checkbox.value}: ${error.message}`, 'error');
                    // Continue with next solution
                    continue;
                }
            }
        } catch (error) {
            console.error('Error in getLatestForSelected:', error);
            this.showNotification('Error', `Operation failed: ${error.message}`, 'error');
        }
    }

    getSolutionDirectory(solution) {
        try {
            // First normalize the solution path
            const normalizedSolutionPath = path.normalize(solution.path.replace(/\\/g, '/'));
            // Then join with the root path
            let fullPath = path.join(rootPathGlobal, normalizedSolutionPath);
            console.log('Full solution path:', fullPath);

            // For .NET solutions, use the parent directory of the .sln file
            if (solution.type === 'dotnet') {
                return path.dirname(fullPath);
            }

            // For Node.js, Angular, etc., use the solution path directly
            try {
                const stats = fs.statSync(fullPath);
                return stats.isFile() ? path.dirname(fullPath) : fullPath;
            } catch (error) {
                console.warn(`Error checking file stats: ${error.message}`);
                return fullPath;
            }
        } catch (error) {
            console.error('Error in getSolutionDirectory:', error);
            return path.join(rootPathGlobal, solution.path);
        }
    }

    async getLatest(directory, name, solutionType, targetBranch) {
        try {
            console.log(`Getting latest for ${name} in directory: ${directory}`);

            // First, verify the directory exists and is a git repository
            if (!fs.existsSync(directory)) {
                throw new Error(`Directory not found: ${directory}`);
            }

            // Check if it's a git repository
            try {
                await new Promise((resolve, reject) => {
                    const cmd = process.platform === 'win32' ?
                        `cd /d "${directory}" && git rev-parse --git-dir` :
                        `cd "${directory}" && git rev-parse --git-dir`;

                    exec(cmd, {
                        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
                    }, (error, stdout, stderr) => {
                        if (error) {
                            reject(new Error(`Not a git repository or git not installed`));
                            return;
                        }
                        resolve(stdout.trim());
                    });
                });
            } catch (error) {
                throw new Error(`${directory} is not a git repository or git is not installed`);
            }

            // First, try to detect the current branch
            let currentBranch;
            try {
                currentBranch = await new Promise((resolve, reject) => {
                    const cmd = process.platform === 'win32' ?
                        `cd /d "${directory}" && git rev-parse --abbrev-ref HEAD` :
                        `cd "${directory}" && git rev-parse --abbrev-ref HEAD`;

                    exec(cmd, {
                        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
                    }, (error, stdout, stderr) => {
                        if (error) {
                            reject(new Error(`Failed to get current branch: ${error.message}`));
                            return;
                        }
                        resolve(stdout.trim());
                    });
                });
                console.log(`Detected current branch: ${currentBranch}`);
            } catch (error) {
                console.warn(`Could not detect current branch: ${error.message}`);
                currentBranch = targetBranch;
            }

            // Execute git commands with proper error handling
            await new Promise((resolve, reject) => {
                // Construct the git command based on platform
                const cdCommand = process.platform === 'win32' ? `cd /d "${directory}"` : `cd "${directory}"`;
                const gitCommand = `${cdCommand} && git fetch --all && ${currentBranch !== targetBranch ? `git checkout ${targetBranch} && ` : ''}git pull`;

                console.log(`Executing git command: ${gitCommand}`);

                exec(gitCommand, {
                    shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
                    maxBuffer: 1024 * 1024 * 10 // 10MB buffer
                }, (error, stdout, stderr) => {
                    if (error) {
                        // Parse git error messages for better error reporting
                        let errorMsg = '';
                        if (stderr) {
                            // Common git error patterns
                            if (stderr.includes('Please commit your changes or stash them')) {
                                errorMsg = 'You have uncommitted changes. Please commit or stash them first.';
                            } else if (stderr.includes('Please, commit your changes or stash them')) {
                                errorMsg = 'You have uncommitted changes. Please commit or stash them first.';
                            } else if (stderr.includes('Authentication failed')) {
                                errorMsg = 'Git authentication failed. Please check your credentials.';
                            } else if (stderr.includes('Could not resolve host')) {
                                errorMsg = 'Network error: Could not connect to remote repository.';
                            } else if (stderr.includes('not found')) {
                                errorMsg = `Branch '${targetBranch}' not found.`;
                            } else {
                                // Use the first line of stderr as it usually contains the most relevant error
                                errorMsg = stderr.split('\n')[0];
                            }
                        } else {
                            errorMsg = error.message;
                        }

                        // If checkout fails, try to pull on the current branch
                        if (error.message.includes('checkout') || error.message.includes('not found')) {
                            console.warn(`Could not checkout ${targetBranch}, trying to pull on current branch ${currentBranch}`);

                            const pullCommand = `${cdCommand} && git pull`;
                            exec(pullCommand, {
                                shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
                                maxBuffer: 1024 * 1024 * 10
                            }, (err2, stdout2, stderr2) => {
                                if (err2) {
                                    let pullErrorMsg = '';
                                    if (stderr2) {
                                        if (stderr2.includes('Authentication failed')) {
                                            pullErrorMsg = 'Git authentication failed. Please check your credentials.';
                                        } else if (stderr2.includes('Could not resolve host')) {
                                            pullErrorMsg = 'Network error: Could not connect to remote repository.';
                                        } else {
                                            pullErrorMsg = stderr2.split('\n')[0];
                                        }
                                    } else {
                                        pullErrorMsg = err2.message;
                                    }
                                    reject(new Error(pullErrorMsg));
                                    return;
                                }
                                console.log('Git pull output:', stdout2);
                                if (stderr2) console.log('Git pull stderr:', stderr2);
                                resolve(stdout2);
                            });
                            return;
                        }
                        reject(new Error(errorMsg));
                        return;
                    }
                    console.log('Git output:', stdout);
                    if (stderr) {
                        console.log('Git stderr:', stderr);
                    }
                    resolve(stdout);
                });
            });

            this.showNotification('Success', `Updated ${name} successfully on branch ${targetBranch}`, 'success');
        } catch (error) {
            console.error('Git error:', error);
            this.showNotification('Error', `Failed to update ${name}: ${error.message}`, 'error');
            throw error;
        }
    }

    runSelectedSolutions() {
        try {
            const selectedCheckboxes = document.querySelectorAll('input[type="checkbox"]:checked');
            console.log(`Found ${selectedCheckboxes.length} selected solutions`);

            if (selectedCheckboxes.length === 0) {
                this.showNotification('Warning', 'Please select at least one solution', 'warning');
                return;
            }

            selectedCheckboxes.forEach(checkbox => {
                const solutionPath = checkbox.value;
                const solution = this.solutions.find(s => s.path === solutionPath);

                if (!solution) {
                    console.error(`Solution not found for path: ${solutionPath}`);
                    return;
                }

                const ideSelect = document.getElementById(`ide-${this.getSolutionId(solution)}`);
                const selectedIde = ideSelect ? ideSelect.value : this.IDE.VSCODE;

                console.log(`Launching solution: ${solution.name} with IDE: ${selectedIde}`);
                this.launchSolution(solution, selectedIde);
            });
        } catch (error) {
            console.error('Error in runSelectedSolutions:', error);
            this.showNotification('Error', `Failed to run solutions: ${error.message}`, 'error');
        }
    }

    async launchSolution(solution, selectedIde) {
        try {
            let solutionPath = path.join(rootPathGlobal, solution.path);
            switch (selectedIde) {
                case this.IDE.VS2022_DEBUG:
                case this.IDE.VS2022_NO_DEBUG:
                    await this.launchInVS2022(
                        solutionPath,
                        selectedIde === this.IDE.VS2022_DEBUG
                    );
                    break;
                case this.IDE.RIDER_DEBUG:
                case this.IDE.RIDER_NO_DEBUG:
                    await this.launchInRider(
                        solutionPath,
                        selectedIde === this.IDE.RIDER_DEBUG
                    );
                    break;
                case this.IDE.VSCODE:
                    await this.launchInVSCode(solution);
                    break;
                default:
                    throw new Error(`Unknown IDE: ${selectedIde}`);
            }
        } catch (error) {
            console.error('Error launching solution:', error);
            this.showNotification('Error', `Failed to launch solution: ${error.message}`, 'error');
        }
    }

    async findVisualStudioPath() {
        if (process.platform === 'darwin') {
            throw new Error('Visual Studio is not supported on macOS');
        }

        for (const vsPath of this.env.paths.vs2022) {
            if (fs.existsSync(vsPath)) {
                return vsPath;
            }
        }
        throw new Error('Visual Studio 2022 installation not found');
    }

    async launchInVS2022(solutionPath, debug = false) {
        try {
            console.log('Launching VS2022:', { solutionPath, debug });
            const devenvPath = await this.findVisualStudioPath();
            const args = [solutionPath];

            if (debug) {
                // For debug mode, just use /Run
                args.push('/Run');
            } else {
                // For no-debug mode, use the command to start without debugging
                args.push('/Command', 'Debug.StartWithoutDebugging');
            }

            console.log('Spawning VS2022:', { devenvPath, args });

            // The key changes are here - using detached: true and stdio: 'ignore'
            const child = spawn(devenvPath, args, {
                windowsHide: false,
                stdio: 'ignore', // Changed from 'pipe' to 'ignore' 
                detached: true,  // Set detached: true to detach from parent
                shell: false     // Don't use shell
            });

            // Unref to allow parent to exit independently
            child.unref();

            // Don't set up listeners that would maintain references
            this.showNotification('Success', 'Visual Studio launched successfully', 'success');
        } catch (error) {
            console.error('Error launching VS2022:', error);
            this.showNotification('Error', `Failed to launch VS2022: ${error.message}`, 'error');
        }
    }

    async findRiderPath() {
        const riderPaths = this.env.paths.rider;

        for (const riderPath of riderPaths) {
            const resolvedPath = this.resolvePath(riderPath);

            // Handle glob patterns in paths
            if (resolvedPath.includes('*')) {
                try {
                    const { glob } = require('glob');
                    const matches = await glob(resolvedPath);
                    if (matches.length > 0) {
                        // Use the most recent version (last in sorted array)
                        const sortedMatches = matches.sort();
                        return sortedMatches[sortedMatches.length - 1];
                    }
                } catch (error) {
                    console.warn(`Error resolving glob pattern: ${error.message}`);
                }
            } else if (fs.existsSync(resolvedPath)) {
                return resolvedPath;
            }
        }
        throw new Error('JetBrains Rider installation not found');
    }

    async launchInRider(solutionPath, debug = false) {
        try {
            // Ensure the solution path is absolute and normalized
            const absoluteSolutionPath = path.resolve(solutionPath);
            console.log('Launching Rider:', { absoluteSolutionPath, debug });

            // First try to find Rider through paths
            let riderPath = await this.findRiderPath();
            if (!riderPath) {
                throw new Error('JetBrains Rider installation not found');
            }

            console.log('Found Rider at:', riderPath);

            // Prepare launch arguments
            const args = [];
            if (debug) {
                args.push('--wait');
                args.push('--line');
                args.push('1');
                args.push('--debug');
            }

            // Always add the solution path last
            args.push(absoluteSolutionPath);

            console.log('Launching Rider with args:', args);

            // Launch Rider with detached:true and stdio:ignore to prevent closing with app
            const child = spawn(riderPath, args, {
                windowsHide: false,
                stdio: 'ignore',
                shell: process.platform === 'win32', // Use shell only on Windows
                detached: true
            });

            child.unref();
            this.showNotification('Success', 'Rider launched successfully', 'success');
        } catch (error) {
            console.error('Error launching Rider:', error);
            this.showNotification('Error', `Failed to launch Rider: ${error.message}`, 'error');
        }
    }

    async launchInVSCode(solution) {
        try {
            const dirToOpen = this.getSolutionDirectory(solution);
            console.log('Opening VS Code in directory:', dirToOpen);

            // Get VS Code path from environment config
            let vscodePath = 'code'; // default fallback
            if (process.platform === 'darwin' && this.env.paths.vscode) {
                // Try each possible VS Code path
                for (const possiblePath of this.env.paths.vscode) {
                    const resolvedPath = possiblePath.replace(/^~/, os.homedir());
                    if (fs.existsSync(resolvedPath)) {
                        vscodePath = resolvedPath;
                        break;
                    }
                }
            }

            console.log('Using VS Code path:', vscodePath);

            // Launch VS Code
            const vsCodeProcess = spawn(vscodePath, [dirToOpen], {
                shell: true,
                detached: true,
                stdio: 'ignore'
            });
            vsCodeProcess.unref();

            // For non-dotnet solutions, run additional setup in a new terminal
            if (solution.type !== 'dotnet') {
                // Wait for VS Code to open
                await new Promise(resolve => setTimeout(resolve, 2000));

                let commands = [];
                const packageManager = await this.detectPackageManager(dirToOpen);

                switch (solution.type) {
                    case 'angular':
                        commands = [
                            `cd "${dirToOpen}"`,
                            `${packageManager} install`,
                            'npx ng serve'
                        ];
                        break;
                    case 'nodejs':
                        commands = [
                            `cd "${dirToOpen}"`,
                            `${packageManager} install`,
                            `${packageManager} run start`
                        ];
                        break;
                }

                if (commands.length > 0) {
                    console.log('Running additional commands:', commands);

                    // Platform-specific command joining
                    const commandSeparator = process.platform === 'win32' ? ' && ' : ' && ';
                    const fullCommand = commands.join(commandSeparator);

                    if (process.platform === 'win32') {
                        // For Windows, open a new Command Prompt
                        spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', fullCommand], {
                            shell: true,
                            detached: true,
                            stdio: 'ignore'
                        }).unref();
                    } else {
                        // For macOS/Linux, open a new terminal window
                        const terminalApp = process.platform === 'darwin' ? 'Terminal' : 'gnome-terminal';
                        if (process.platform === 'darwin') {
                            const osascriptCommand = `tell application "Terminal"
                                do script "${fullCommand}"
                                activate
                            end tell`;
                            spawn('osascript', ['-e', osascriptCommand], {
                                shell: true,
                                detached: true,
                                stdio: 'ignore'
                            }).unref();
                        } else {
                            // Linux
                            spawn('gnome-terminal', ['--', 'bash', '-c', `${fullCommand}; exec bash`], {
                                shell: true,
                                detached: true,
                                stdio: 'ignore'
                            }).unref();
                        }
                    }
                }
            }

            this.showNotification('Success', `Development environment launched for ${solution.name}`, 'success');
        } catch (error) {
            console.error('Error launching VS Code:', error);
            this.showNotification('Error', `Failed to launch development environment: ${error.message}`, 'error');
        }
    }

    async detectPackageManager(directory) {
        try {
            // Check for yarn.lock
            if (fs.existsSync(path.join(directory, 'yarn.lock'))) {
                return 'yarn';
            }
            // Check for pnpm-lock.yaml
            if (fs.existsSync(path.join(directory, 'pnpm-lock.yaml'))) {
                return 'pnpm';
            }
            // Default to npm
            return 'npm';
        } catch (error) {
            console.warn('Error detecting package manager:', error);
            return 'npm';
        }
    }

    async updateDb(solution) {
        try {
            const directory = this.getSolutionDirectory(solution);
            const migratorPath = path.join(directory, 'Database', 'Migrator', 'Migrator.csproj');

            if (!fs.existsSync(migratorPath)) {
                throw new Error(`Migrator project not found at: ${migratorPath}`);
            }

            // Find dotnet executable
            let dotnetPath = 'dotnet';
            const possiblePaths = [
                '/usr/local/bin/dotnet',
                '/opt/dotnet/dotnet',
                '/usr/bin/dotnet',
                process.env.DOTNET_ROOT ? path.join(process.env.DOTNET_ROOT, 'dotnet') : null
            ].filter(Boolean);

            for (const possiblePath of possiblePaths) {
                if (fs.existsSync(possiblePath)) {
                    dotnetPath = possiblePath;
                    break;
                }
            }

            console.log('Using dotnet path:', dotnetPath);
            console.log('Migrator path:', migratorPath);

            const command = `${dotnetPath} run --project "${migratorPath}"`;
            console.log('Executing command:', command);

            const { stdout, stderr } = await execAsync(command);

            if (stderr) {
                console.error('Migration stderr:', stderr);
                if (!stderr.includes('Build succeeded')) {
                    throw new Error(`Migration failed: ${stderr}`);
                }
            }

            console.log('Migration stdout:', stdout);
            this.showNotification('Success', `Database updated successfully for ${solution.name}`, 'success');
        } catch (error) {
            console.error('Error updating database:', error);
            this.showNotification('Error', `Failed to update database: ${error.message}`, 'error');
        }
    }

    dockerizeApp(solution) {
        try {
            console.log('Dockerizing application:', solution);
            const dockerFilePath = path.join(solution.contextFolder, "dev-dockerfile");
            const commands = [
                `docker buildx build --pull --rm -t ${solution.imageContainerName}:latest -f ${dockerFilePath} ${solution.contextFolder}`,
                `docker run -d -p ${solution.dockerPort}:${solution.dockerPort} --name ${solution.imageContainerName} ${solution.imageContainerName}`,
                'docker image prune -f'
            ];

            const child = spawn(this.env.shell.name, [...this.env.shell.args, commands.join(' && ')], {
                shell: true,
                detached: true,
                stdio: 'pipe'
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('exit', (code) => {
                if (code === 0) {
                    console.log('Docker output:', stdout);
                    this.showNotification('Success', 'Application dockerized successfully', 'success');
                } else {
                    console.error('Docker error:', { code, stderr });
                    this.showNotification('Error', `Dockerization failed with code ${code}`, 'error');
                }

                stdout = null;
                stderr = null;
            });
        } catch (error) {
            console.error('Error dockerizing application:', error);
            this.showNotification('Error', `Failed to dockerize: ${error.message}`, 'error');
        }
    }

    showNotification(title, message, type = 'info') {
        try {
            // Log to console first
            const timestamp = new Date().toISOString();
            const logMessage = `[${timestamp}] [${type.toUpperCase()}] ${title}: ${message}`;

            switch (type) {
                case 'error':
                    console.error(logMessage);
                    break;
                case 'warning':
                    console.warn(logMessage);
                    break;
                default:
                    console.log(logMessage);
            }

            // Create and show Electron notification
            try {
                const notification = new Notification({
                    title: title,
                    body: message,
                    icon: type === 'success' ? path.join(__dirname, 'assets', 'check.png') : path.join(__dirname, 'assets', 'close.png'),
                    silent: false
                });

                notification.show();

                // Auto close after 4 seconds
                setTimeout(() => notification.close(), 4000);
            } catch (notificationError) {
                console.error('Failed to show Electron notification:', notificationError);
            }
        } catch (error) {
            console.error('Error in showNotification:', error);
        }
    }

    resolvePath(inputPath) {
        if (!inputPath) return '';

        try {
            let resolvedPath = inputPath;

            // Expand ~ to home directory
            if (resolvedPath.startsWith('~')) {
                resolvedPath = path.join(os.homedir(), resolvedPath.slice(1));
            }

            // Handle environment variables
            if (process.platform === 'win32') {
                resolvedPath = resolvedPath.replace(/%([^%]+)%/g, (_, n) => process.env[n] || '');
            } else {
                resolvedPath = resolvedPath
                    .replace(/\$HOME/g, os.homedir())
                    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, n) => process.env[n] || '');
            }

            // Convert to absolute path and normalize
            resolvedPath = path.resolve(resolvedPath);

            // Ensure the path exists
            if (!fs.existsSync(resolvedPath)) {
                console.warn(`Path does not exist: ${resolvedPath}`);
            }

            console.log('Resolved path:', resolvedPath);
            return resolvedPath;
        } catch (error) {
            console.error('Error resolving path:', error);
            return inputPath;
        }
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('Initializing SolutionManager...');
    try {
        window.solutionManager = new SolutionManager();
    } catch (error) {
        console.error('Failed to initialize SolutionManager:', error);
    }
});

module.exports = SolutionManager;