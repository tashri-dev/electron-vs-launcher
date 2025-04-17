class ConfigUI {
    constructor() {
        this.configManager = new ConfigManager();
        this.bindEvents();
        this.loadInitialConfig();
    }

    bindEvents() {
        // Import button
        document.getElementById('importConfig')?.addEventListener('click', () => {
            const fileInput = document.getElementById('configFile');
            if (fileInput?.files.length > 0) {
                this.handleImportConfig(fileInput.files[0]);
            } else {
                this.showNotification('Warning', 'Please select a config file to import', 'warning');
            }
        });

        // Root path update
        document.getElementById('updateRootPath')?.addEventListener('click', () => {
            const rootPath = document.getElementById('rootPathInput')?.value;
            if (rootPath) {
                this.handleUpdateRootPath(rootPath);
            } else {
                this.showNotification('Warning', 'Please enter a root path', 'warning');
            }
        });

        // Solution form
        document.getElementById('addSolutionForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleAddSolution(e);
        });

        // File input change
        document.getElementById('configFile')?.addEventListener('change', (e) => {
            const fileInput = e.target;
            if (fileInput.files.length > 0) {
                const file = fileInput.files[0];
                if (file.name.toLowerCase().endsWith('.json')) {
                    // Valid JSON file selected
                    document.getElementById('importConfig')?.removeAttribute('disabled');
                } else {
                    this.showNotification('Error', 'Please select a valid JSON file', 'error');
                    fileInput.value = ''; // Clear the file input
                    document.getElementById('importConfig')?.setAttribute('disabled', 'true');
                }
            }
        });
    }

    loadInitialConfig() {
        try {
            const config = this.configManager.loadConfig();
            this.updateConfigDisplay(config);
            this.showNotification('Success', 'Configuration loaded successfully', 'success');
        } catch (error) {
            this.showNotification('Error', `Failed to load configuration: ${error.message}`, 'error');
        }
    }

    updateConfigDisplay(config) {
        try {
            // Update root path input
            const rootPathInput = document.getElementById('rootPathInput');
            if (rootPathInput && config.rootPath) {
                rootPathInput.value = config.rootPath;
            }

            // Update config display
            const configDisplay = document.getElementById('currentConfig');
            if (configDisplay) {
                configDisplay.textContent = JSON.stringify(config, null, 2);
            }

            // Show config path
            const configPath = this.configManager.getConfigPath();
            const configPathDisplay = document.getElementById('configPath');
            if (configPathDisplay) {
                configPathDisplay.textContent = `Config file location: ${configPath}`;
            }
        } catch (error) {
            this.showNotification('Error', `Failed to update config display: ${error.message}`, 'error');
        }
    }

    handleImportConfig(file) {
        // Create backup before import
        this.configManager.backupConfig();

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const configData = e.target.result;
                if (this.configManager.importConfig(configData)) {
                    const config = this.configManager.loadConfig();
                    this.updateConfigDisplay(config);
                    this.showNotification('Success', 'Configuration imported successfully', 'success');
                    
                    // Reload solutions
                    if (window.solutionManager) {
                        window.solutionManager.loadSolutions();
                    }
                } else {
                    this.showNotification('Error', 'Failed to import configuration', 'error');
                    // Try to restore backup
                    if (this.configManager.restoreBackup()) {
                        this.showNotification('Info', 'Previous configuration restored', 'info');
                        this.loadInitialConfig();
                    }
                }
            } catch (error) {
                this.showNotification('Error', `Failed to import configuration: ${error.message}`, 'error');
                // Try to restore backup
                if (this.configManager.restoreBackup()) {
                    this.showNotification('Info', 'Previous configuration restored', 'info');
                    this.loadInitialConfig();
                }
            }
        };

        reader.onerror = (error) => {
            this.showNotification('Error', `Failed to read configuration file: ${error.message}`, 'error');
        };

        reader.readAsText(file);
    }

    handleUpdateRootPath(rootPath) {
        try {
            if (this.configManager.updateRootPath(rootPath)) {
                this.showNotification('Success', 'Root path updated successfully', 'success');
                this.loadInitialConfig();
                if (window.solutionManager) {
                    window.solutionManager.loadSolutions();
                }
            } else {
                this.showNotification('Error', 'Failed to update root path', 'error');
            }
        } catch (error) {
            this.showNotification('Error', `Failed to update root path: ${error.message}`, 'error');
        }
    }

    handleAddSolution(e) {
        try {
            const formData = new FormData(e.target);
            const solution = {
                name: formData.get('name'),
                path: formData.get('path'),
                type: formData.get('type'),
                dockerPort: formData.get('dockerPort') ? parseInt(formData.get('dockerPort')) : null,
                imageContainerName: formData.get('imageContainerName') || null,
                migratorPath: formData.get('migratorPath') || null,
                contextFolder: formData.get('contextFolder') || null
            };

            if (this.configManager.addSolution(solution)) {
                this.showNotification('Success', 'Solution added successfully', 'success');
                e.target.reset();
                this.loadInitialConfig();
                if (window.solutionManager) {
                    window.solutionManager.loadSolutions();
                }
            } else {
                this.showNotification('Error', 'Failed to add solution', 'error');
            }
        } catch (error) {
            this.showNotification('Error', `Failed to add solution: ${error.message}`, 'error');
        }
    }

    showNotification(title, message, type) {
        if (window.solutionManager) {
            window.solutionManager.showNotification(title, message, type);
        } else {
            console.log(`${type.toUpperCase()}: ${title} - ${message}`);
        }
    }
}

// Initialize when the document is ready
document.addEventListener('DOMContentLoaded', () => {
    window.configUI = new ConfigUI();
});