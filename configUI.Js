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
            }
        });

        // Root path update
        document.getElementById('updateRootPath')?.addEventListener('click', () => {
            const rootPath = document.getElementById('rootPathInput')?.value;
            if (rootPath) {
                this.handleUpdateRootPath(rootPath);
            }
        });

        // Solution form
        document.getElementById('addSolutionForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleAddSolution(e);
        });

        // File input change
        document.getElementById('configFile')?.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.handleImportConfig(e.target.files[0]);
            }
        });
    }

    loadInitialConfig() {
        const config = this.configManager.loadConfig();
        this.updateConfigDisplay(config);
    }

    updateConfigDisplay(config) {
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
    }

    handleImportConfig(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const config = JSON.parse(e.target.result);
                if (this.configManager.saveConfig(config)) {
                    this.updateConfigDisplay(config);
                    this.showNotification('Success', 'Configuration imported successfully', 'success');
                    // Reload solutions
                    if (window.solutionLoader) {
                        window.solutionLoader.loadSolutions();
                    }
                }
            } catch (error) {
                this.showNotification('Error', 'Failed to import configuration', 'error');
            }
        };
        reader.readAsText(file);
    }

    handleUpdateRootPath(rootPath) {
        if (this.configManager.updateRootPath(rootPath)) {
            this.showNotification('Success', 'Root path updated successfully', 'success');
            this.loadInitialConfig();
            if (window.solutionLoader) {
                window.solutionLoader.loadSolutions();
            }
        }
    }

    handleAddSolution(e) {
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
            if (window.solutionLoader) {
                window.solutionLoader.loadSolutions();
            }
        }
    }

    showNotification(title, message, type) {
        if ('Notification' in window) {
            new window.Notification(title, {
                body: message,
                icon: type === 'success' ? '/assets/check.png' : '/assets/close.png'
            });
        }
    }
}

// Initialize when the document is ready
document.addEventListener('DOMContentLoaded', () => {
    window.configUI = new ConfigUI();
});