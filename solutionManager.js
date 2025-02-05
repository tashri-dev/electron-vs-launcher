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
        table.classList.add('table', 'table-striped', 'table-hover', 'align-middle');

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

    createActionButtons(solution) {
        const container = document.createElement('div');
        container.classList.add('d-flex', 'gap-2');
        let solutionPath = path.join(rootPathGlobal, solution.path);
        // Get Latest button
        const getLatestBtn = document.createElement('button');
        getLatestBtn.classList.add('btn', 'btn-secondary', 'btn-sm');
        getLatestBtn.innerHTML = '<i class="fa fa-download"></i>';
        getLatestBtn.onclick = () => this.getLatest(solutionPath);
        container.appendChild(getLatestBtn);

        // Update DB button
        if (solution.migratorPath) {
            const updateDbBtn = document.createElement('button');
            updateDbBtn.classList.add('btn', 'btn-warning', 'btn-sm');
            updateDbBtn.textContent = 'Update DB';
            updateDbBtn.onclick = () => this.updateDb(path.join(rootPathGlobal, solution.migratorPath));
            container.appendChild(updateDbBtn);
        }

        // Dockerize button
        if (solution.dockerPort) {
            const dockerizeBtn = document.createElement('button');
            dockerizeBtn.classList.add('btn', 'btn-primary', 'btn-sm');
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

        // Previous button
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

        // Next button
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
            console.log(`Found ${selectedCheckboxes.length} selected solutions for update`);

            if (selectedCheckboxes.length === 0) {
                this.showNotification('Warning', 'Please select at least one solution', 'warning');
                return;
            }

            for (const checkbox of selectedCheckboxes) {
                const solutionPath = checkbox.value;
                console.log('Getting latest for:', solutionPath);

                try {
                    const pathArray = solutionPath.split('\\');
                    const name = pathArray[pathArray.length - 1];
                    const directory = pathArray.slice(0, -1).join('\\');

                    await new Promise((resolve, reject) => {
                        exec(`cd "${directory}" && git checkout master_dev && git pull`,
                            (error, stdout, stderr) => {
                                if (error) {
                                    console.error('Git error:', { error, stderr });
                                    reject(error);
                                    return;
                                }
                                console.log('Git output:', stdout);
                                resolve(stdout);
                            });
                    });

                    this.showNotification('Success', `Updated ${name} successfully`, 'success');
                } catch (error) {
                    this.showNotification('Error',
                        `Failed to update ${path.basename(solutionPath)}: ${error.message}`,
                        'error'
                    );
                }
            }
        } catch (error) {
            console.error('Error in getLatestForSelected:', error);
            this.showNotification('Error', `Operation failed: ${error.message}`, 'error');
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

                const ideSelect = checkbox.closest('td').querySelector('select');
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
                args.push('/Run');
            } else {
                args.push('/Run', 'Debug.StartWithoutDebugging');
            }

            console.log('Spawning VS2022:', { devenvPath, args });

            const child = spawn(devenvPath, args, {
                windowsHide: false,
                stdio: 'pipe'
            });

            child.stdout.on('data', (data) => {
                console.log('VS2022 output:', data.toString());
            });

            child.stderr.on('data', (data) => {
                console.error('VS2022 error:', data.toString());
            });

            child.on('error', (error) => {
                console.error('VS2022 process error:', error);
                this.showNotification('Error', `VS2022 launch failed: ${error.message}`, 'error');
            });

            child.on('exit', (code) => {
                if (code !== 0) {
                    console.warn(`VS2022 exited with code ${code}`);
                    this.showNotification('Warning', `VS2022 exited with code ${code}`, 'warning');
                }
            });
        } catch (error) {
            console.error('Error launching VS2022:', error);
            this.showNotification('Error', `Failed to launch VS2022: ${error.message}`, 'error');
        }
    }

    async launchInRider(solutionPath, debug = false) {
        try {
            console.log('Launching Rider:', { solutionPath, debug });
            const riderPaths = [
                'C:\\Program Files\\JetBrains\\JetBrains Rider 2023.3\\bin\\rider64.exe',
                'C:\\Program Files\\JetBrains\\JetBrains Rider 2023.2\\bin\\rider64.exe',
                'C:\\Program Files\\JetBrains\\JetBrains Rider 2023.1\\bin\\rider64.exe'
            ];

            let riderPath = null;
            for (const possiblePath of riderPaths) {
                if (fs.existsSync(possiblePath)) {
                    riderPath = possiblePath;
                    break;
                }
            }

            if (!riderPath) {
                throw new Error('JetBrains Rider installation not found');
            }

            console.log('Found Rider at:', riderPath);

            const args = [solutionPath];
            if (debug) {
                args.push('--debug');
            }

            const child = spawn(riderPath, args, {
                windowsHide: false,
                stdio: 'pipe'
            });

            child.stdout.on('data', (data) => {
                console.log('Rider output:', data.toString());
            });

            child.stderr.on('data', (data) => {
                console.error('Rider error:', data.toString());
            });

            child.on('error', (error) => {
                console.error('Rider process error:', error);
                this.showNotification('Error', `Rider launch failed: ${error.message}`, 'error');
            });
        } catch (error) {
            console.error('Error launching Rider:', error);
            this.showNotification('Error', `Failed to launch Rider: ${error.message}`, 'error');
        }
    }

    async launchInVSCode(solution) {
        try {
            let solutionPath = path.join(rootPathGlobal, solution.path);
            console.log('Launching VS Code:', solution);
            const solutionDir = path.dirname(solutionPath);

            // Launch VS Code
            const vsCodeProcess = spawn('code', [solutionDir], { shell: true });

            vsCodeProcess.on('error', (error) => {
                console.error('VS Code launch error:', error);
                this.showNotification('Error', `Failed to launch VS Code: ${error.message}`, 'error');
            });

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
                    const terminal = spawn('cmd.exe', ['/k', `cd "${solutionDir}" && ${commands.join(' && ')}`], {
                        shell: true,
                        detached: true,
                        stdio: 'inherit'
                    });

                    terminal.on('error', (error) => {
                        console.error('Command execution error:', error);
                        this.showNotification('Error', `Failed to run commands: ${error.message}`, 'error');
                    });
                }
            }
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
                detached: true,
                stdio: 'inherit'
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

            exec(commands.join(' && '), (error, stdout, stderr) => {
                if (error) {
                    console.error('Docker error:', { error, stderr });
                    this.showNotification('Error', `Dockerization failed: ${error.message}`, 'error');
                    return;
                }

                console.log('Docker output:', stdout);
                this.showNotification('Success', 'Application dockerized successfully', 'success');
            });
        } catch (error) {
            console.error('Error dockerizing application:', error);
            this.showNotification('Error', `Failed to dockerize: ${error.message}`, 'error');
        }
    }

    showNotification(title, message, type = 'info') {
        // Log to console with proper formatting
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