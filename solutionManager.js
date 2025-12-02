const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const Registry = require('winreg');
const ConfigManager = require('./configManager');
const os = require('os');
const { Notification, ipcRenderer } = require('electron').remote || require('@electron/remote');
const { ipcRenderer: directIpcRenderer } = require('electron');
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
        this.collapsedGroups = new Set(); // Track collapsed groups
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
        console.log('🔗 Binding main actions...');

        // Add a small delay to ensure DOM is fully loaded
        setTimeout(() => {
            console.log('🔗 Starting button binding process...');

            // Debug: Check DOM state
            const allButtons = document.querySelectorAll('button');
            console.log(`🔍 Found ${allButtons.length} total buttons in DOM`);

            // Bind buttons individually to avoid reference issues
            this.bindButton('clearBtn', () => this.resetSelections());
            this.bindButton('selectAllBtn', () => this.selectAll());
            this.bindButton('launchBtn', () => this.runSelectedSolutions());
            this.bindButton('get-latest-selected', () => this.getLatestForSelected());
            this.bindButton('runCliBtn', () => this.runSelectedInCli());

            console.log('🔗 Button binding process completed');

            // Additional verification for CLI button
            setTimeout(() => {
                const cliBtn = document.getElementById('runCliBtn');
                if (cliBtn) {
                    console.log('✅ CLI button verification: FOUND');
                    console.log('   Button text:', cliBtn.textContent.trim());
                    console.log('   Button class:', cliBtn.className);
                    console.log('   Button disabled:', cliBtn.disabled);
                } else {
                    console.error('❌ CLI button verification: NOT FOUND');
                }
            }, 100);

        }, 500); // Increased delay to ensure DOM is ready
    }

    bindButton(buttonId, action) {
        console.log(`🔗 Attempting to bind button: ${buttonId}`);
        const button = document.getElementById(buttonId);
        if (button) {
            console.log(`   ✅ Found button: ${buttonId}`);
            console.log(`   📝 Button text: "${button.textContent.trim()}"`);
            console.log(`   🎨 Button classes: ${button.className}`);

            // Remove all existing listeners by cloning the element
            const newButton = button.cloneNode(true);
            button.parentNode.replaceChild(newButton, button);
            console.log(`   🔄 Cloned and replaced button: ${buttonId}`);

            // Add the new listener
            newButton.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log(`🖱️ Button clicked: ${buttonId}`);
                console.log(`   🎯 Calling action function...`);
                try {
                    action.call(this);
                    console.log(`   ✅ Action completed for ${buttonId}`);
                } catch (error) {
                    console.error(`   ❌ Error in action for ${buttonId}:`, error);
                }
            });
            console.log(`   ✅ Event listener added to ${buttonId}`);
        } else {
            console.warn(`   ❌ Button ${buttonId} not found in DOM`);
            // Debug: List all buttons with IDs
            const allButtonsWithIds = document.querySelectorAll('button[id]');
            console.log(`   🔍 Available buttons with IDs:`, Array.from(allButtonsWithIds).map(b => b.id));
        }
    }

    loadSolutions() {
        try {
            console.log('Loading solutions...');
            const config = this.configManager.loadConfig();
            this.solutions = config.solutions || [];
            rootPathGlobal = this.resolvePath(config.rootPath || '');
            console.log('Resolved root path:', rootPathGlobal);
            
            // Reset collapsed groups and pagination on load
            this.collapsedGroups.clear();
            this.currentPage = 1;
            
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

        // Get all groups with their solutions, showing headers for all but only visible solutions
        const { groupsToShow, visibleCount } = this.calculateGroupsToDisplay();

        // Display all groups (collapsed or not) with their solutions
        groupsToShow.forEach(({ parentDir, solutions, isCollapsed }) => {
            container.appendChild(this.createGroupElement(parentDir, solutions, isCollapsed));
        });

        // Add pagination controls only if no groups are expanded
        // When groups are expanded, we show all solutions, so no pagination needed
        const hasExpandedGroups = this.collapsedGroups.size < Object.keys(this.groupSolutionsByParent(this.solutions)).length;
        if (!hasExpandedGroups) {
            this.addPaginationControls(container, visibleCount);
        }

        // Set up checkbox listeners and update counter
        setTimeout(() => {
            this.setupCheckboxListeners();
            this.updateSelectedCount();
            this.updateGroupCheckboxes();
        }, 100);
    }

    calculateGroupsToDisplay() {
        const grouped = this.groupSolutionsByParent(this.solutions);
        const allGroups = Object.entries(grouped);
        const groupsToShow = [];
        let visibleCount = 0;
        
        // Collect all expanded groups
        const expandedGroups = [];
        for (const [parentDir, solutions] of allGroups) {
            if (!this.collapsedGroups.has(parentDir)) {
                expandedGroups.push({ parentDir, solutions });
            }
        }
        
        // If we have expanded groups, show ALL solutions from ALL expanded groups
        // Don't paginate within groups - show complete groups
        if (expandedGroups.length > 0) {
            // Show all groups (expanded and collapsed)
            for (const [parentDir, solutions] of allGroups) {
                const isCollapsed = this.collapsedGroups.has(parentDir);
                
                if (isCollapsed) {
                    // Collapsed group: show header, but no solutions
                    groupsToShow.push({
                        parentDir,
                        solutions: [],
                        isCollapsed: true
                    });
                } else {
                    // Expanded group: show ALL solutions from this group
                    groupsToShow.push({
                        parentDir,
                        solutions: solutions, // Show all solutions, not paginated
                        isCollapsed: false
                    });
                    visibleCount += solutions.length;
                }
            }
        } else {
            // No groups expanded - show all groups as collapsed
            for (const [parentDir, solutions] of allGroups) {
                groupsToShow.push({
                    parentDir,
                    solutions: [],
                    isCollapsed: true
                });
            }
        }
        
        return { groupsToShow, visibleCount };
    }

    createGroupElement(parentDir, solutions, isCollapsed = false) {
        const groupDiv = document.createElement('div');
        groupDiv.classList.add('parent-directory', 'mb-4');
        groupDiv.dataset.groupName = parentDir;

        // Create header with checkbox, title, and collapse/expand button
        const header = document.createElement('div');
        header.classList.add('group-header', 'd-flex', 'justify-content-between', 'align-items-center', 'mb-3');
        
        // Left side: Checkbox and title
        const leftSection = document.createElement('div');
        leftSection.classList.add('d-flex', 'align-items-center', 'gap-2');
        
        // Add "Select All" checkbox for this group
        const groupCheckboxWrapper = document.createElement('div');
        groupCheckboxWrapper.classList.add('form-check');
        
        const groupCheckbox = document.createElement('input');
        groupCheckbox.type = 'checkbox';
        groupCheckbox.classList.add('form-check-input', 'group-select-all');
        groupCheckbox.id = `group-checkbox-${parentDir}`;
        groupCheckbox.dataset.groupName = parentDir;
        groupCheckbox.onchange = () => this.toggleGroupSelection(parentDir, groupCheckbox);
        groupCheckboxWrapper.appendChild(groupCheckbox);
        
        const groupCheckboxLabel = document.createElement('label');
        groupCheckboxLabel.classList.add('form-check-label');
        groupCheckboxLabel.htmlFor = groupCheckbox.id;
        groupCheckboxLabel.textContent = 'Select All';
        groupCheckboxLabel.style.cursor = 'pointer';
        groupCheckboxWrapper.appendChild(groupCheckboxLabel);
        
        leftSection.appendChild(groupCheckboxWrapper);
        
        const title = document.createElement('h3');
        title.textContent = parentDir;
        title.classList.add('mb-0', 'ms-2');
        leftSection.appendChild(title);
        
        header.appendChild(leftSection);

        // Right side: Collapse/expand button
        const collapseBtn = document.createElement('button');
        collapseBtn.classList.add('btn', 'btn-sm', 'btn-secondary', 'collapse-toggle');
        collapseBtn.innerHTML = isCollapsed 
            ? '<i class="fa fa-chevron-right"></i>' 
            : '<i class="fa fa-chevron-down"></i>';
        collapseBtn.onclick = () => this.toggleGroupCollapse(groupDiv, collapseBtn, parentDir);
        header.appendChild(collapseBtn);

        groupDiv.appendChild(header);

        // Create table wrapper that can be collapsed
        const tableWrapper = document.createElement('div');
        tableWrapper.classList.add('group-content');
        if (isCollapsed) {
            tableWrapper.classList.add('collapsed');
        }
        
        // Always create table structure, even if empty (for expanded groups)
        // This ensures the group looks properly expanded even if no solutions on current page
        if (!isCollapsed) {
            // Wrap table in table-responsive for better scrolling
            const tableResponsive = document.createElement('div');
            tableResponsive.classList.add('table-responsive');
            
            if (solutions.length > 0) {
                tableResponsive.appendChild(this.createSolutionsTable(solutions));
            } else {
                // Create empty table structure to show the group is expanded
                const emptyTable = document.createElement('table');
                emptyTable.classList.add('table', 'table-striped', 'table-hover');
                emptyTable.innerHTML = `
                    <thead>
                        <tr>
                            <th style="width: 60%">Solution Name</th>
                            <th style="width: 40%">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td colspan="2" style="text-align: center; padding: 2rem; color: var(--text-secondary);">
                                No solutions on this page. Navigate to next page to see solutions.
                            </td>
                        </tr>
                    </tbody>
                `;
                tableResponsive.appendChild(emptyTable);
            }
            tableWrapper.appendChild(tableResponsive);
        }
        
        groupDiv.appendChild(tableWrapper);

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

        // Run in CLI button
        const runCliBtn = document.createElement('button');
        runCliBtn.classList.add('btn', 'btn-info', 'btn-sm', 'btn-priority-high');
        runCliBtn.innerHTML = '<i class="fa fa-terminal"></i>';
        runCliBtn.title = 'Run this solution in external terminal';
        runCliBtn.onclick = () => {
            this.runSolutionInExternalTerminal(solution);
        };
        container.appendChild(runCliBtn);

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

    addPaginationControls(container, visibleCount = null) {
        const paginationDiv = document.createElement('div');
        paginationDiv.classList.add(
            'pagination-controls',
            'd-flex',
            'justify-content-between',
            'align-items-center',
            'mt-4'
        );

        // Calculate total pages based on visible (non-collapsed) solutions
        const totalVisibleSolutions = this.getTotalVisibleSolutions();
        const totalPages = Math.ceil(totalVisibleSolutions / this.itemsPerPage);

        // Page information
        const pageInfo = document.createElement('div');
        pageInfo.textContent = `Page ${this.currentPage} of ${totalPages} (${visibleCount || this.itemsPerPage} items)`;
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

        if (this.currentPage < totalPages) {
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

    getTotalVisibleSolutions() {
        // Count only solutions in non-collapsed groups
        let count = 0;
        const grouped = this.groupSolutionsByParent(this.solutions);
        
        for (const [parentDir, solutions] of Object.entries(grouped)) {
            if (!this.collapsedGroups.has(parentDir)) {
                count += solutions.length;
            }
        }
        
        return count;
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

    toggleGroupCollapse(groupDiv, button, parentDir) {
        const content = groupDiv.querySelector('.group-content');
        const isCollapsed = content.classList.contains('collapsed');
        const groupSolutions = this.getGroupSolutions(parentDir);
        const groupSolutionCount = groupSolutions.length;

        if (isCollapsed) {
            // Expanding the group
            this.collapsedGroups.delete(parentDir);
        } else {
            // Collapsing the group
            this.collapsedGroups.add(parentDir);
        }
        
        // Don't reset pagination - just recalculate and redisplay
        // This allows multiple groups to be expanded at the same time
        this.displaySolutions();
    }

    toggleGroupSelection(parentDir, checkbox) {
        // Get all solutions in this group
        const groupSolutions = this.getGroupSolutions(parentDir);
        
        // Get all checkboxes for solutions in this group
        const allCheckboxes = document.querySelectorAll('input[type="checkbox"]:not(.group-select-all)');
        const groupCheckboxes = Array.from(allCheckboxes).filter(cb => {
            const solution = this.solutions.find(s => {
                const normalizedPath = path.normalize(s.path.replace(/\\/g, '/'));
                const parts = normalizedPath.split('/');
                return parts[0] === parentDir && cb.value === s.path;
            });
            return solution !== undefined;
        });
        
        // Set all group checkboxes to match the group checkbox
        groupCheckboxes.forEach(cb => {
            cb.checked = checkbox.checked;
        });
        
        // Update the selected count
        this.updateSelectedCount();
    }

    getGroupSolutions(parentDir) {
        return this.solutions.filter(solution => {
            const normalizedPath = path.normalize(solution.path.replace(/\\/g, '/'));
            return normalizedPath.split('/')[0] === parentDir;
        });
    }

    getCurrentVisibleCount() {
        const container = document.getElementById("solutionsContainer");
        if (!container) return 0;
        
        let count = 0;
        const groups = container.querySelectorAll('.parent-directory');
        groups.forEach(group => {
            const isCollapsed = group.querySelector('.group-content.collapsed');
            if (!isCollapsed) {
                const rows = group.querySelectorAll('tbody tr');
                count += rows.length;
            }
        });
        return count;
    }

    resetSelections() {
        console.log('Resetting all selections');
        document.querySelectorAll('input[type="checkbox"]:not(.group-select-all)').forEach(checkbox => {
            checkbox.checked = false;
        });
        this.updateSelectedCount();
        this.updateGroupCheckboxes();
    }

    selectAll() {
        console.log('Selecting all solutions');
        document.querySelectorAll('input[type="checkbox"]:not(.group-select-all)').forEach(checkbox => {
            checkbox.checked = true;
        });
        this.updateSelectedCount();
        this.updateGroupCheckboxes();
    }

    async getLatestForSelected() {
        try {
            const selectedCheckboxes = document.querySelectorAll('input[type="checkbox"]:checked:not(.group-select-all)');

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

    async runSelectedSolutions() {
        try {
            const selectedCheckboxes = document.querySelectorAll('input[type="checkbox"]:checked:not(.group-select-all)');
            console.log(`Found ${selectedCheckboxes.length} selected solutions`);

            if (selectedCheckboxes.length === 0) {
                this.showNotification('Warning', 'Please select at least one solution', 'warning');
                return;
            }

            // Track Rider solutions separately to handle them properly
            const riderSolutions = [];
            const otherSolutions = [];

            // Separate Rider and non-Rider solutions
            for (const checkbox of selectedCheckboxes) {
                const solutionPath = checkbox.value;
                const solution = this.solutions.find(s => s.path === solutionPath);

                if (!solution) {
                    console.error(`Solution not found for path: ${solutionPath}`);
                    continue;
                }

                const ideSelect = document.getElementById(`ide-${this.getSolutionId(solution)}`);
                const selectedIde = ideSelect ? ideSelect.value : this.IDE.VSCODE;

                if (selectedIde.includes('Rider')) {
                    riderSolutions.push({ solution, ide: selectedIde });
                } else {
                    otherSolutions.push({ solution, ide: selectedIde });
                }
            }

            // Launch non-Rider solutions first (they start faster)
            for (const { solution, ide } of otherSolutions) {
                console.log(`Launching solution: ${solution.name} with IDE: ${ide}`);
                await this.launchSolution(solution, ide);
            }

            // Handle Rider solutions with proper timing and singleton logic
            if (riderSolutions.length > 0) {
                console.log(`🔥 Launching ${riderSolutions.length} Rider solutions with proper sequencing...`);
                await this.launchRiderSolutions(riderSolutions);
            }

        } catch (error) {
            console.error('Error in runSelectedSolutions:', error);
            this.showNotification('Error', `Failed to run solutions: ${error.message}`, 'error');
        }
    }

    async launchRiderSolutions(riderSolutions) {
        try {
            console.log(`🔥 Launching ${riderSolutions.length} Rider solutions...`);

            // Launch all Rider solutions with a small delay between them
            for (let i = 0; i < riderSolutions.length; i++) {
                const { solution, ide } = riderSolutions[i];

                console.log(`🔥 Launching Rider solution ${i + 1}/${riderSolutions.length}: ${solution.name}`);

                // Add small delay between solutions to prevent conflicts
                if (i > 0) {
                    console.log('⏱️ Brief pause before next Rider solution...');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }

                await this.launchSolution(solution, ide);
            }

            console.log('✅ All Rider solutions launched successfully');

        } catch (error) {
            console.error('❌ Error launching Rider solutions:', error);
            this.showNotification('Error', `Failed to launch Rider solutions: ${error.message}`, 'error');
        }
    }

    // Debug method for testing CLI functionality
    debugTestCli(solutionName = null) {
        console.log('🧪 DEBUG: Testing CLI functionality...');

        if (solutionName) {
            // Test specific solution
            const solution = this.solutions.find(s => s.name.includes(solutionName));
            if (solution) {
                console.log('🎯 Testing specific solution:', solution.name);
                this.runSolutionInExternalTerminal(solution);
            } else {
                console.log('❌ Solution not found:', solutionName);
                console.log('Available solutions:', this.solutions.map(s => s.name));
            }
        } else {
            // Test with first available solution
            if (this.solutions.length > 0) {
                const testSolution = this.solutions[0];
                console.log('🎯 Testing with first solution:', testSolution.name);
                this.runSolutionInExternalTerminal(testSolution);
            } else {
                console.log('❌ No solutions available');
            }
        }
    }

    // Debug method to test IPC communication
    async debugTestIpc() {
        console.log('🧪 DEBUG: Testing IPC communication...');

        try {
            const ipcRendererInstance = directIpcRenderer || ipcRenderer;

            if (!ipcRendererInstance) {
                console.error('❌ IPC Renderer not available');
                return;
            }

            console.log('✅ IPC Renderer found');

            // Test with a simple terminal launch
            const testPath = '/Users/taha/Work';
            console.log(`📡 Testing IPC with path: ${testPath}`);

            const result = await ipcRendererInstance.invoke('launch-terminal', {
                solutionPath: testPath + '/test.sln',
                solutionName: 'IPC Test',
                platform: process.platform
            });

            console.log('📡 IPC Test Result:', result);

            if (result.success) {
                console.log('✅ IPC communication working!');
                this.showNotification('Success', 'IPC test successful - terminal should have opened', 'success');
            } else {
                console.error('❌ IPC test failed:', result.error);
                this.showNotification('Error', `IPC test failed: ${result.error}`, 'error');
            }

        } catch (error) {
            console.error('❌ IPC test error:', error);
            this.showNotification('Error', `IPC test error: ${error.message}`, 'error');
        }
    }

    // Debug method to simulate checkbox selection and run CLI
    debugSimulateCli() {
        console.log('🧪 DEBUG: Simulating CLI execution...');

        // Check current checkbox states
        const allCheckboxes = document.querySelectorAll('input[type="checkbox"]:not(.group-select-all)');
        const checkedBoxes = document.querySelectorAll('input[type="checkbox"]:checked:not(.group-select-all)');

        console.log(`📊 Found ${allCheckboxes.length} total checkboxes, ${checkedBoxes.length} checked`);

        if (checkedBoxes.length === 0 && allCheckboxes.length > 0) {
            // Auto-select first checkbox for testing
            console.log('🔧 Auto-selecting first checkbox for testing...');
            allCheckboxes[0].checked = true;
            console.log('✅ First checkbox selected');
        }

        // Now run the CLI method
        this.runSelectedInCli();
    }

    async runSelectedInCli() {
        console.log('🚀 runSelectedInCli method called!');
        console.log('🔍 Debug: Method execution started');

        try {
            console.log('🔍 Querying for checkboxes...');
            const selectedCheckboxes = document.querySelectorAll('input[type="checkbox"]:checked:not(.group-select-all)');
            console.log(`Found ${selectedCheckboxes.length} selected solutions for CLI execution`);
            console.log('Selected checkboxes:', Array.from(selectedCheckboxes).map(cb => ({
                id: cb.id,
                value: cb.value,
                checked: cb.checked
            })));

            if (selectedCheckboxes.length === 0) {
                console.log('⚠️ No solutions selected - showing warning');
                this.showNotification('Warning', 'Please select at least one solution to run', 'warning');
                return;
            }

            // Show confirmation for multiple solutions
            if (selectedCheckboxes.length >= 5) {
                console.log(`🤔 Many solutions selected (${selectedCheckboxes.length}), showing confirmation`);
                const confirmed = confirm(`You are about to start ${selectedCheckboxes.length} solutions in external terminals. This may use significant system resources. Continue?`);
                if (!confirmed) {
                    console.log('User cancelled running multiple solutions');
                    return;
                }
            }

            console.log(`✅ Starting ${selectedCheckboxes.length} solutions in external terminals...`);

            // Initialize terminal tracking if not exists
            if (!this.runningTerminals) {
                this.runningTerminals = new Set();
            }

            // Start solutions in external terminals with tracking
            let successCount = 0;
            for (const checkbox of selectedCheckboxes) {
                const solutionPath = checkbox.value;
                const solution = this.solutions.find(s => s.path === solutionPath);

                if (!solution) {
                    console.error(`Solution not found for path: ${solutionPath}`);
                    continue;
                }

                // Check if this solution is already running
                const terminalKey = `${solution.name}-${solution.path}`;
                if (this.runningTerminals.has(terminalKey)) {
                    console.log(`⚠️ ${solution.name} is already running in a terminal, skipping...`);
                    this.showNotification('Info', `${solution.name} is already running`, 'info');
                    continue;
                }

                try {
                    console.log(`🖥️ Starting external terminal for: ${solution.name}`);

                    // Mark as running before starting
                    this.runningTerminals.add(terminalKey);

                    await this.runSolutionInExternalTerminal(solution);
                    successCount++;
                    console.log(`✅ Successfully started ${solution.name}`);

                    // Remove from tracking after a delay (assuming it starts properly)
                    setTimeout(() => {
                        this.runningTerminals.delete(terminalKey);
                    }, 5000);

                } catch (error) {
                    console.error(`❌ Failed to start ${solution.name}:`, error);
                    this.runningTerminals.delete(terminalKey); // Remove from tracking on error
                    this.showNotification('Error', `Failed to start ${solution.name}: ${error.message}`, 'error');
                }

                // Small delay between terminal launches to prevent resource conflicts
                if (successCount < selectedCheckboxes.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            if (successCount > 0) {
                console.log(`🎉 Started ${successCount} of ${selectedCheckboxes.length} solution(s) successfully`);
                this.showNotification('Success', `Started ${successCount} of ${selectedCheckboxes.length} solution(s) in external terminals`, 'success');
            } else {
                this.showNotification('Warning', 'No new terminals were started (solutions may already be running)', 'warning');
            }
        } catch (error) {
            console.error('❌ Error in runSelectedInCli:', error);
            this.showNotification('Error', `Failed to run solutions in CLI: ${error.message}`, 'error');
        }
    }

    async runSolutionInExternalTerminal(solution) {
        try {
            console.log(`🖥️ [Renderer] Setting up external terminal for ${solution.name}...`);

            const solutionPath = path.resolve(rootPathGlobal, solution.path);
            const platform = process.platform;

            console.log(`� [Renderer] Solution path: ${solutionPath}`);
            console.log(`🔧 [Renderer] Platform: ${platform}`);

            // Get the correct ipcRenderer instance
            const ipcRendererInstance = directIpcRenderer || ipcRenderer;

            if (!ipcRendererInstance) {
                throw new Error('IPC Renderer not available');
            }

            console.log(`� [Renderer] Sending terminal launch request to main process...`);

            // Send IPC message to main process to launch terminal
            // Support both 'args' and 'runArgs' for backward compatibility
            const result = await ipcRendererInstance.invoke('launch-terminal', {
                solutionPath: solutionPath,
                solutionName: solution.name,
                platform: platform,
                solutionType: solution.type,
                dockerPort: solution.dockerPort,
                startupProject: solution.startupProject,
                runArgs: solution.runArgs || solution.args, // Support both 'args' and 'runArgs'
                args: solution.args || solution.runArgs, // Support both 'args' and 'runArgs'
                startup: solution.startup // Optional: full command override
            });

            console.log(`� [Renderer] Received response from main process:`, result);

            if (result.success) {
                console.log(`✅ [Renderer] Terminal launched successfully for ${solution.name}`);
                this.showNotification('Success', result.message || `Terminal opened for ${solution.name}`, 'success');
            } else {
                console.error(`❌ [Renderer] Terminal launch failed for ${solution.name}:`, result.error);
                this.showNotification('Error', `Failed to open terminal: ${result.error}`, 'error');
                throw new Error(result.error);
            }

        } catch (error) {
            console.error(`❌ [Renderer] Error running solution ${solution.name} in external terminal:`, error);
            this.showNotification('Error', `Failed to start ${solution.name}: ${error.message}`, 'error');
            throw error;
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
            console.log('🔥 Launching Rider:', { absoluteSolutionPath, debug });

            // Clean up any lock files that might cause conflicts
            await this.killRiderLockFiles(absoluteSolutionPath);

            // First try to find Rider through paths
            let riderPath = await this.findRiderPath();
            if (!riderPath) {
                throw new Error('JetBrains Rider installation not found');
            }

            console.log('🔥 Found Rider at:', riderPath);

            // NEW: Use a different approach - always use the "open with Rider" approach
            // This ensures we don't get multiple Rider windows
            const args = [];

            // Always add the solution path first
            args.push(absoluteSolutionPath);

            if (debug) {
                // For debug mode, we'll handle this within Rider
                console.log('🔥 Debug mode will be handled within Rider');
            }

            console.log('🔥 Opening solution in Rider with args:', args);

            // Use detached spawn to avoid keeping the process tied to our app
            const child = spawn(riderPath, args, {
                windowsHide: false,
                stdio: 'ignore',
                shell: process.platform === 'win32', // Use shell only on Windows
                detached: true
            });

            child.unref();

            console.log('✅ Rider launch command executed');
            this.showNotification('Success', 'Rider launched successfully', 'success');

        } catch (error) {
            console.error('❌ Error launching Rider:', error);
            this.showNotification('Error', `Failed to launch Rider: ${error.message}`, 'error');
        }
    }

    async isRiderRunning() {
        return new Promise((resolve) => {
            const platform = process.platform;
            let command, args;

            if (platform === 'darwin') {
                // macOS
                command = 'pgrep';
                args = ['-f', 'rider'];
            } else if (platform === 'win32') {
                // Windows
                command = 'tasklist';
                args = ['/FI', 'IMAGENAME eq rider64.exe'];
            } else {
                // Linux
                command = 'pgrep';
                args = ['-f', 'rider'];
            }

            exec(`${command} ${args.join(' ')}`, (error, stdout) => {
                if (error) {
                    resolve(false);
                } else {
                    resolve(stdout.trim().length > 0);
                }
            });
        });
    }

    async waitForRiderToStart(maxWaitTime = 10000) {
        const startTime = Date.now();
        while (Date.now() - startTime < maxWaitTime) {
            if (await this.isRiderRunning()) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        return false;
    }

    async killRiderLockFiles(solutionPath) {
        try {
            const solutionDir = path.dirname(solutionPath);
            const ideaDir = path.join(solutionDir, '.idea');

            if (fs.existsSync(ideaDir)) {
                // Remove lock files that can cause Rider conflicts
                const lockFiles = [
                    path.join(ideaDir, '.lock'),
                    path.join(ideaDir, 'shelf'),
                    path.join(ideaDir, 'workspace.xml.lock')
                ];

                for (const lockFile of lockFiles) {
                    if (fs.existsSync(lockFile)) {
                        try {
                            if (fs.lstatSync(lockFile).isDirectory()) {
                                fs.rmSync(lockFile, { recursive: true, force: true });
                            } else {
                                fs.unlinkSync(lockFile);
                            }
                            console.log(`Removed lock file: ${lockFile}`);
                        } catch (error) {
                            console.warn(`Could not remove lock file ${lockFile}:`, error.message);
                        }
                    }
                }
            }
        } catch (error) {
            console.warn('Error cleaning Rider lock files:', error.message);
        }
    }

    async startRiderEmpty() {
        return new Promise((resolve, reject) => {
            const riderPath = this.findRiderPath();
            if (!riderPath) {
                reject(new Error('Rider path not found'));
                return;
            }

            // Start Rider without any project
            const child = spawn(riderPath, [], {
                windowsHide: false,
                stdio: 'ignore',
                shell: process.platform === 'win32',
                detached: true
            });

            child.unref();
            resolve();
        });
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
            // Switch to output tab and clear it for migration output
            const outputTab = document.getElementById('output-tab');
            if (outputTab) {
                outputTab.click();
            }

            if (window.addOutputEntry) {
                window.addOutputEntry(`Starting database migration for ${solution.name}...`, 'info');
            }

            // Use solution's migratorPath if available, otherwise try default location
            let migratorPath;
            if (solution.migratorPath) {
                migratorPath = path.join(rootPathGlobal, solution.migratorPath);
            } else {
                const directory = this.getSolutionDirectory(solution);
                migratorPath = path.join(directory, 'Database', 'Migrator', 'Migrator.csproj');
            }

            if (!fs.existsSync(migratorPath)) {
                const errorMsg = `Migrator project not found at: ${migratorPath}`;
                if (window.addOutputEntry) {
                    window.addOutputEntry(errorMsg, 'error');
                }
                throw new Error(errorMsg);
            }

            // Find dotnet executable
            let dotnetPath = 'dotnet';
            if (this.env.paths.dotnet && this.env.paths.dotnet.length > 0) {
                dotnetPath = this.env.paths.dotnet[0];
            }

            console.log('Using dotnet path:', dotnetPath);
            console.log('Migrator path:', migratorPath);

            if (window.addOutputEntry) {
                window.addOutputEntry(`Running: ${dotnetPath} run --project "${migratorPath}"`, 'info');
            }

            return new Promise((resolve, reject) => {
                const child = spawn(dotnetPath, ['run', '--project', migratorPath], {
                    cwd: path.dirname(migratorPath),
                    stdio: 'pipe'
                });

                let outputBuffer = '';
                let errorBuffer = '';

                child.stdout.on('data', (data) => {
                    const text = data.toString();
                    outputBuffer += text;
                    console.log('Migration stdout:', text);
                    if (window.addOutputEntry) {
                        // Split by lines and add each line separately
                        text.split('\n').filter(line => line.trim()).forEach(line => {
                            window.addOutputEntry(line, 'info');
                        });
                    }
                });

                child.stderr.on('data', (data) => {
                    const text = data.toString();
                    errorBuffer += text;
                    console.error('Migration stderr:', text);
                    if (window.addOutputEntry) {
                        // Split by lines and add each line separately
                        text.split('\n').filter(line => line.trim()).forEach(line => {
                            window.addOutputEntry(line, 'error');
                        });
                    }
                });

                child.on('close', (code) => {
                    if (code === 0) {
                        const successMsg = `Database migration completed successfully for ${solution.name}`;
                        console.log(successMsg);
                        if (window.addOutputEntry) {
                            window.addOutputEntry(successMsg, 'success');
                        }
                        this.showNotification('Success', successMsg, 'success');
                        resolve();
                    } else {
                        const errorMsg = `Database migration failed for ${solution.name} (exit code: ${code})`;
                        console.error(errorMsg);
                        if (window.addOutputEntry) {
                            window.addOutputEntry(errorMsg, 'error');
                            if (errorBuffer) {
                                window.addOutputEntry(`Error details: ${errorBuffer}`, 'error');
                            }
                        }
                        this.showNotification('Error', errorMsg, 'error');
                        reject(new Error(errorMsg));
                    }
                });

                child.on('error', (error) => {
                    const errorMsg = `Failed to start migration process: ${error.message}`;
                    console.error(errorMsg);
                    if (window.addOutputEntry) {
                        window.addOutputEntry(errorMsg, 'error');
                    }
                    this.showNotification('Error', errorMsg, 'error');
                    reject(error);
                });
            });

        } catch (error) {
            console.error('Error in updateDb:', error);
            if (window.addOutputEntry) {
                window.addOutputEntry(`Migration error: ${error.message}`, 'error');
            }
            this.showNotification('Error', `Migration failed: ${error.message}`, 'error');
            throw error;
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

    updateSelectedCount() {
        const selectedCheckboxes = document.querySelectorAll('input[type="checkbox"]:checked:not(.group-select-all)');
        const countElement = document.getElementById('selectedCount');
        if (countElement) {
            countElement.textContent = selectedCheckboxes.length;
            countElement.className = selectedCheckboxes.length > 0 ? 'badge bg-primary' : 'badge bg-secondary';
        }
    }

    setupCheckboxListeners() {
        // Add event listeners to all checkboxes to update the counter
        const checkboxes = document.querySelectorAll('input[type="checkbox"]:not(.group-select-all)');
        checkboxes.forEach(checkbox => {
            checkbox.addEventListener('change', () => {
                this.updateSelectedCount();
                this.updateGroupCheckboxes();
            });
        });
        
        // Update group checkboxes state
        this.updateGroupCheckboxes();
    }

    updateGroupCheckboxes() {
        // Update each group checkbox based on whether all solutions in that group are selected
        const grouped = this.groupSolutionsByParent(this.solutions);
        
        for (const [parentDir, solutions] of Object.entries(grouped)) {
            const groupCheckbox = document.getElementById(`group-checkbox-${parentDir}`);
            if (!groupCheckbox) continue;
            
            // Get all solution checkboxes in this group
            const allCheckboxes = document.querySelectorAll('input[type="checkbox"]:not(.group-select-all)');
            const groupCheckboxes = Array.from(allCheckboxes).filter(cb => {
                const solution = solutions.find(s => cb.value === s.path);
                return solution !== undefined;
            });
            
            if (groupCheckboxes.length === 0) {
                groupCheckbox.indeterminate = false;
                groupCheckbox.checked = false;
                continue;
            }
            
            const checkedCount = groupCheckboxes.filter(cb => cb.checked).length;
            
            if (checkedCount === 0) {
                groupCheckbox.indeterminate = false;
                groupCheckbox.checked = false;
            } else if (checkedCount === groupCheckboxes.length) {
                groupCheckbox.indeterminate = false;
                groupCheckbox.checked = true;
            } else {
                groupCheckbox.indeterminate = true;
                groupCheckbox.checked = false;
            }
        }
    }

    findRunnableProjects(solutionFilePath) {
        try {
            const solutionDir = path.dirname(solutionFilePath);
            const runnableProjects = [];

            // Look for common runnable project patterns
            const searchPatterns = [
                '**/Program.cs',
                '**/*.Api/*.csproj',
                '**/*.Web/*.csproj',
                '**/*.WebApi/*.csproj',
                '**/*.App/*.csproj',
                '**/*.Console/*.csproj'
            ];

            // Search for projects with these patterns
            function searchDirectory(dir, depth = 0) {
                if (depth > 3) return; // Limit search depth

                try {
                    const items = fs.readdirSync(dir);

                    for (const item of items) {
                        const itemPath = path.join(dir, item);
                        const stat = fs.statSync(itemPath);

                        if (stat.isDirectory()) {
                            // Check if this directory contains a Program.cs (likely runnable)
                            const programPath = path.join(itemPath, 'Program.cs');
                            if (fs.existsSync(programPath)) {
                                // Look for a .csproj file in the same directory
                                const csprojFiles = fs.readdirSync(itemPath).filter(f => f.endsWith('.csproj'));
                                if (csprojFiles.length > 0) {
                                    const projectPath = path.join(itemPath, csprojFiles[0]);
                                    runnableProjects.push(projectPath);
                                }
                            }

                            // Also check for API/Web/Console project patterns
                            if (item.toLowerCase().includes('api') ||
                                item.toLowerCase().includes('web') ||
                                item.toLowerCase().includes('console') ||
                                item.toLowerCase().includes('app')) {
                                const csprojFiles = fs.readdirSync(itemPath).filter(f => f.endsWith('.csproj'));
                                if (csprojFiles.length > 0) {
                                    const projectPath = path.join(itemPath, csprojFiles[0]);
                                    if (!runnableProjects.includes(projectPath)) {
                                        runnableProjects.push(projectPath);
                                    }
                                }
                            }

                            // Recurse into subdirectories
                            searchDirectory(itemPath, depth + 1);
                        }
                    }
                } catch (error) {
                    // Ignore permission errors or other issues
                }
            }

            searchDirectory(solutionDir);

            // Sort by preference: API projects first, then Web, then others
            runnableProjects.sort((a, b) => {
                const aName = path.basename(a).toLowerCase();
                const bName = path.basename(b).toLowerCase();

                if (aName.includes('api') && !bName.includes('api')) return -1;
                if (!aName.includes('api') && bName.includes('api')) return 1;
                if (aName.includes('web') && !bName.includes('web')) return -1;
                if (!aName.includes('web') && bName.includes('web')) return 1;

                return 0;
            });

            console.log(`Found ${runnableProjects.length} runnable projects:`, runnableProjects);
            return runnableProjects;
        } catch (error) {
            console.error('Error finding runnable projects:', error);
            return [];
        }
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 SolutionManager DOMContentLoaded event fired');

    // Add a small delay to ensure all other scripts have loaded
    setTimeout(() => {
        console.log('Initializing SolutionManager...');
        try {
            // Check if already initialized
            if (window.solutionManager) {
                console.log('⚠️ SolutionManager already exists, skipping initialization');
                return;
            }

            window.solutionManager = new SolutionManager();
            console.log('✅ SolutionManager initialized successfully');

            // Test the CLI button binding after initialization
            setTimeout(() => {
                const runCliBtn = document.getElementById('runCliBtn');
                if (runCliBtn) {
                    console.log('✅ CLI button found after initialization');
                } else {
                    console.warn('❌ CLI button NOT found after initialization');
                }
            }, 100);

        } catch (error) {
            console.error('Failed to initialize SolutionManager:', error);
        }
    }, 200); // Small delay to ensure all scripts are loaded
});

module.exports = SolutionManager;