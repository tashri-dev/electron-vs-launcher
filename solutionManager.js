const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const Registry = require('winreg');
const ConfigManager = require('./configManager');
let rootPathGlobal = '';
class SolutionManager {
    constructor() {
        this.configManager = new ConfigManager();
        this.itemsPerPage = 10;
        this.currentPage = 1;
        this.solutions = [];
        this.rootPath = '';
        this.IDE = {
            VS2022_DEBUG: 'Visual Studio 2022 (Debug)',
            VS2022_NO_DEBUG: 'Visual Studio 2022 (Without Debug)',
            RIDER_DEBUG: 'Rider (Debug)',
            RIDER_NO_DEBUG: 'Rider (Without Debug)',
            VSCODE: 'VS Code'
        };
        this.ENVIRONMENTS = {
            DEV: { name: 'Dev', branch: 'master_dev' },
            SIT: { name: 'SIT', branch: 'master_sit' },
            UAT: { name: 'UAT', branch: 'master_uat' }
        };
        this.init();
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
            rootPathGlobal = config.rootPath || '';
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

        // Set default IDE based on solution type
        select.value = solution.type === 'dotnet' ? this.IDE.VS2022_NO_DEBUG : this.IDE.VSCODE;
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
            updateDbBtn.onclick = () => this.updateDb(path.join(rootPathGlobal, solution.migratorPath));
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
            const parentDir = solution.path.split('\\')[0];
            if (!acc[parentDir]) acc[parentDir] = [];
            acc[parentDir].push(solution);
            return acc;
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
                const solutionPath = checkbox.value;
                const solution = this.solutions.find(s => s.path === solutionPath);
                if (!solution) {
                    console.error(`Solution not found for path: ${solutionPath}`);
                    continue;
                }
                const directory = this.getSolutionDirectory(solution);

                // Get the environment selector for this solution
                const envSelector = document.getElementById(`env-${this.getSolutionId(solution)}`);
                const selectedEnv = envSelector ? envSelector.value : 'DEV';
                const targetBranch = this.ENVIRONMENTS[selectedEnv].branch;

                await this.getLatest(directory, solution.name, solution.type, targetBranch);
            }
        } catch (error) {
            console.error('Error updating selected solutions:', error);
            this.showNotification('Error', `Operation failed: ${error.message}`, 'error');
        }
    }

    getSolutionDirectory(solution) {
        let solutionPath = path.join(rootPathGlobal, solution.path);

        // For .NET solutions, use the parent directory of the .sln file
        if (solution.type === 'dotnet') {
            return path.dirname(solutionPath);
        }

        // For Node.js, Angular, etc., use the solution path directly
        // If the path is a file, use its directory, otherwise use the path itself
        try {
            return fs.statSync(solutionPath).isFile() ? path.dirname(solutionPath) : solutionPath;
        } catch (error) {
            console.warn(`Error checking file stats: ${error.message}`);
            return solutionPath;
        }
    }

    async getLatest(directory, name, solutionType, targetBranch) {
        try {
            // First, try to detect the current branch
            let currentBranch;
            try {
                currentBranch = await new Promise((resolve, reject) => {
                    exec(`cd "${directory}" && git rev-parse --abbrev-ref HEAD`, (error, stdout, stderr) => {
                        if (error) {
                            reject(error);
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
                // If we're already on the target branch, just pull. Otherwise, checkout the target branch first
                const gitCommand = `cd "${directory}" && git fetch --all && ${currentBranch !== targetBranch ? `git checkout ${targetBranch} && ` : ''}git pull`;

                console.log(`Executing git command: ${gitCommand}`);

                exec(gitCommand, (error, stdout, stderr) => {
                    if (error) {
                        // If checkout fails, try to pull on the current branch
                        if (error.message.includes('checkout') || error.message.includes('not found')) {
                            console.warn(`Could not checkout ${targetBranch}, trying to pull on current branch ${currentBranch}`);
                            exec(`cd "${directory}" && git pull`, (err2, stdout2, stderr2) => {
                                if (err2) {
                                    reject(err2);
                                    return;
                                }
                                console.log('Git pull output:', stdout2);
                                resolve(stdout2);
                            });
                            return;
                        }
                        reject(error);
                        return;
                    }
                    console.log('Git output:', stdout);
                    resolve(stdout);
                });
            });

            this.showNotification('Success', `Updated ${name} successfully`, 'success');
        } catch (error) {
            console.error('Git error:', error);
            this.showNotification('Error', `Failed to update ${name}: ${error.message}`, 'error');
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
                const selectedIde = ideSelect ? ideSelect.value : this.IDE.VS2022_NO_DEBUG;

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
        const registryPaths = [
            {
                key: '\\SOFTWARE\\Microsoft\\VisualStudio\\SxS\\VS7',
                value: '17.0',
                arch: 'x64'
            },
            {
                key: '\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\SxS\\VS7',
                value: '17.0',
                arch: 'x32'
            }
        ];

        for (const regPath of registryPaths) {
            try {
                const reg = new Registry({
                    hive: Registry.HKLM,
                    key: regPath.key,
                    arch: regPath.arch
                });

                const vsPath = await new Promise((resolve, reject) => {
                    reg.get(regPath.value, (err, item) => {
                        if (err) reject(err instanceof Error ? err : new Error(err.message || String(err)));
                        else resolve(item.value);
                    });
                });

                const devenvPath = path.join(vsPath, 'Common7', 'IDE', 'devenv.exe');
                if (fs.existsSync(devenvPath)) {
                    return devenvPath;
                }
            } catch (error) {
                console.warn(`Failed to find VS in ${regPath.key}:`, error);
            }
        }

        // Fallback to default paths
        const defaultPaths = [
            'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\Common7\\IDE\\devenv.exe',
            'C:\\Program Files\\Microsoft Visual Studio\\2022\\Preview\\Common7\\IDE\\devenv.exe',
            'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\IDE\\devenv.exe',
            'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\IDE\\devenv.exe'
        ];

        for (const defaultPath of defaultPaths) {
            if (fs.existsSync(defaultPath)) {
                return defaultPath;
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
        try {
            // Try to find Rider through Windows Registry
            const registryPaths = [
                {
                    key: '\\SOFTWARE\\JetBrains\\Rider',
                    arch: 'x64'
                },
                {
                    key: '\\SOFTWARE\\JetBrains\\Rider',
                    arch: 'x32'
                }
            ];

            for (const regPath of registryPaths) {
                try {
                    const reg = new Registry({
                        hive: Registry.HKLM,
                        key: regPath.key,
                        arch: regPath.arch
                    });

                    // List all values in the key to find the latest version
                    const items = await new Promise((resolve, reject) => {
                        reg.values((err, items) => {
                            if (err) reject(err);
                            else resolve(items);
                        });
                    });

                    if (items && items.length > 0) {
                        // Sort items by version number (assuming version is in the name)
                        const sortedItems = items.sort((a, b) => {
                            const versionA = a.name.match(/\d+\.\d+/);
                            const versionB = b.name.match(/\d+\.\d+/);
                            if (versionA && versionB) {
                                return parseFloat(versionB[0]) - parseFloat(versionA[0]);
                            }
                            return 0;
                        });

                        // Get the latest version's installation path
                        const latestVersion = sortedItems[0];
                        if (latestVersion) {
                            const installPath = await new Promise((resolve, reject) => {
                                reg.get(latestVersion.name, (err, item) => {
                                    if (err) reject(err);
                                    else resolve(item.value);
                                });
                            });

                            const riderPath = path.join(installPath, 'bin', 'rider64.exe');
                            if (fs.existsSync(riderPath)) {
                                return riderPath;
                            }
                        }
                    }
                } catch (regError) {
                    console.warn(`Registry search failed for ${regPath.key}:`, regError);
                }
            }
        } catch (error) {
            console.warn('Error searching for Rider in registry:', error);
        }
        return null;
    }

    async launchInRider(solutionPath, debug = false) {
        try {
            console.log('Launching Rider:', { solutionPath, debug });

            // First try to find Rider through registry
            let riderPath = await this.findRiderPath();

            if (!riderPath) {
                // Fallback to common installation paths
                const riderPaths = [
                    'C:\\Program Files\\JetBrains\\JetBrains Rider 2023.3\\bin\\rider64.exe',
                    'C:\\Program Files\\JetBrains\\JetBrains Rider 2023.2\\bin\\rider64.exe',
                    'C:\\Program Files\\JetBrains\\JetBrains Rider 2023.1\\bin\\rider64.exe',
                    "C:\\Users\\tahaa\\AppData\\Local\\Programs\\Rider\\bin\\rider64.exe"
                    // Add more potential path
                ];

                for (const possiblePath of riderPaths) {
                    if (fs.existsSync(possiblePath)) {
                        riderPath = possiblePath;
                        break;
                    }
                }
            }

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
            args.push(solutionPath);

            console.log('Launching Rider with args:', args);

            // Launch Rider with detached:true and stdio:ignore to prevent closing with app
            const child = spawn(riderPath, args, {
                windowsHide: false,
                stdio: 'ignore', // Changed from 'pipe' to 'ignore'
                shell: true,
                detached: true    // Ensure process is detached
            });

            // Unref the child to allow the parent process to exit independently
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

            // Launch VS Code with detached process
            const vsCodeProcess = spawn('code', [dirToOpen], {
                shell: true,
                detached: true,  // Ensure detached is true
                stdio: 'ignore'  // Changed from default to 'ignore'
            });

            // Unref to allow parent to exit independently
            vsCodeProcess.unref();

            // For non-dotnet solutions, run additional setup
            if (solution.type !== 'dotnet') {
                const commands = [];

                switch (solution.type) {
                    case 'angular':
                        commands.push('yarn', 'ng serve');
                        break;
                    case 'nodejs':
                        commands.push('npm i', 'npm run start');
                        break;
                }

                if (commands.length > 0) {
                    console.log('Running additional commands:', commands);
                    const terminal = spawn('cmd.exe', ['/k', `cd "${dirToOpen}" && ${commands.join(' && ')}`], {
                        shell: true,
                        detached: true,  // Ensure detached is true
                        stdio: 'ignore'  // Changed from 'inherit' to 'ignore'
                    });

                    // Unref terminal too
                    terminal.unref();
                }
            }

            this.showNotification('Success', `${solution.type === 'dotnet' ? 'VS Code' : 'Development environment'} launched successfully`, 'success');
        } catch (error) {
            console.error('Error launching VS Code:', error);
            this.showNotification('Error', `Failed to launch VS Code: ${error.message}`, 'error');
        }
    }

    updateDb(migratorPath) {
        try {
            console.log('Running database update:', migratorPath);
            const args = ['run', '--project', migratorPath];

            const child = spawn('dotnet', args, {
                shell: true,
                detached: false, // Keep this false since we want to wait for DB update to complete
                stdio: 'inherit'  // Keep this as 'inherit' so user can see output
            });

            child.on('error', (error) => {
                console.error('Database update error:', error);
                this.showNotification('Error', `Failed to update database: ${error.message}`, 'error');
            });

            child.on('exit', (code) => {
                if (code === 0) {
                    this.showNotification('Success', 'Database updated successfully', 'success');
                } else {
                    this.showNotification('Error', `Database update failed with code ${code}`, 'error');
                }
            });
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

            // Use spawn instead of exec for better process management
            const child = spawn('cmd.exe', ['/c', commands.join(' && ')], {
                shell: true,
                detached: true,  // Set detached to true
                stdio: 'pipe'    // Keep as pipe to capture output
            });

            // Capture output but don't keep references that prevent GC
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

                // Remove references to allow garbage collection
                stdout = null;
                stderr = null;
            });

            // No need to unref since we want to capture output
            // But we still keep the process detached
        } catch (error) {
            console.error('Error dockerizing application:', error);
            this.showNotification('Error', `Failed to dockerize: ${error.message}`, 'error');
        }
    }

    showNotification(title, message, type = 'info') {
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

        // Show system notification
        if ('Notification' in window) {
            try {
                const notification = new window.Notification(title, {
                    body: message,
                    icon: type === 'success' ? './assets/check.png' : './assets/close.png'
                });
                notification.onclick = () => {
                    notification.close();
                };
            } catch (error) {
                console.error('Failed to show notification:', error);
            }
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