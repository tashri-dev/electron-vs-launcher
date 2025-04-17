const fs = require('fs');
const path = require('path');
const { app } = require('electron').remote || require('@electron/remote');

class ConfigManager {
    constructor() {
        // Initialize paths
        this.appDir = app.getPath('userData'); // Use Electron's user data directory
        this.configPath = path.join(this.appDir, 'config.json');
        this.templatePath = path.join(__dirname, 'config.template.json');
        
        // Ensure user data directory exists
        if (!fs.existsSync(this.appDir)) {
            fs.mkdirSync(this.appDir, { recursive: true });
        }
        
        // Ensure config exists
        this.initializeConfig();
    }

    initializeConfig() {
        try {
            if (!fs.existsSync(this.configPath)) {
                console.log('Config file not found, creating from template...');
                const defaultConfig = this.createConfigFromTemplate();
                this.saveConfig(defaultConfig);
            }
        } catch (error) {
            console.error('Error initializing config:', error);
        }
    }

    loadConfig() {
        try {
            // Check if config exists
            if (!fs.existsSync(this.configPath)) {
                console.log('Config file not found, creating from template...');
                return this.createConfigFromTemplate();
            }

            // Read existing config
            const configData = fs.readFileSync(this.configPath, 'utf8');
            const config = JSON.parse(configData);
            
            // Normalize paths in the config
            if (config.rootPath) {
                config.rootPath = this.normalizePath(config.rootPath);
            }
            if (config.solutions) {
                config.solutions = config.solutions.map(solution => ({
                    ...solution,
                    path: this.normalizePath(solution.path),
                    migratorPath: solution.migratorPath ? this.normalizePath(solution.migratorPath) : solution.migratorPath
                }));
            }
            
            console.log('Successfully loaded config from:', this.configPath);
            return config;
        } catch (error) {
            console.error('Error loading config:', error);
            return { rootPath: '', solutions: [] };
        }
    }

    createConfigFromTemplate() {
        try {
            const defaultConfig = {
                rootPath: '',
                solutions: []
            };

            // Try to load from template if it exists
            if (fs.existsSync(this.templatePath)) {
                console.log('Using template file from:', this.templatePath);
                const templateData = fs.readFileSync(this.templatePath, 'utf8');
                const templateConfig = JSON.parse(templateData);
                this.saveConfig(templateConfig);
                return templateConfig;
            }

            // Create default config if no template exists
            console.log('No template found, creating default config at:', this.configPath);
            this.saveConfig(defaultConfig);
            return defaultConfig;
        } catch (error) {
            console.error('Error creating config from template:', error);
            return { rootPath: '', solutions: [] };
        }
    }

    saveConfig(config) {
        try {
            // Validate config structure
            if (!this.validateConfig(config)) {
                throw new Error('Invalid configuration structure');
            }

            // Normalize paths before saving
            const normalizedConfig = {
                ...config,
                rootPath: this.normalizePath(config.rootPath),
                solutions: config.solutions.map(solution => ({
                    ...solution,
                    path: this.normalizePath(solution.path),
                    migratorPath: solution.migratorPath ? this.normalizePath(solution.migratorPath) : solution.migratorPath
                }))
            };

            // Ensure directory exists
            const configDir = path.dirname(this.configPath);
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }

            // Save config to file
            fs.writeFileSync(this.configPath, JSON.stringify(normalizedConfig, null, 2));
            console.log('Config saved successfully to:', this.configPath);
            return true;
        } catch (error) {
            console.error('Error saving config:', error);
            return false;
        }
    }

    importConfig(configData) {
        try {
            // Parse the imported config
            let importedConfig;
            if (typeof configData === 'string') {
                importedConfig = JSON.parse(configData);
            } else {
                importedConfig = configData;
            }

            // Validate the imported config
            if (!this.validateConfig(importedConfig)) {
                throw new Error('Invalid imported configuration structure');
            }

            // Save the imported config
            return this.saveConfig(importedConfig);
        } catch (error) {
            console.error('Error importing config:', error);
            return false;
        }
    }

    updateRootPath(rootPath) {
        try {
            const config = this.loadConfig();
            config.rootPath = rootPath;
            return this.saveConfig(config);
        } catch (error) {
            console.error('Error updating root path:', error);
            return false;
        }
    }

    addSolution(solution) {
        try {
            // Validate solution structure
            if (!this.validateSolution(solution)) {
                throw new Error('Invalid solution structure');
            }

            const config = this.loadConfig();
            config.solutions.push(solution);
            return this.saveConfig(config);
        } catch (error) {
            console.error('Error adding solution:', error);
            return false;
        }
    }

    removeSolution(solutionPath) {
        try {
            const config = this.loadConfig();
            config.solutions = config.solutions.filter(s => s.path !== solutionPath);
            return this.saveConfig(config);
        } catch (error) {
            console.error('Error removing solution:', error);
            return false;
        }
    }

    validateConfig(config) {
        return (
            config &&
            typeof config === 'object' &&
            typeof config.rootPath === 'string' &&
            Array.isArray(config.solutions) &&
            config.solutions.every(this.validateSolution)
        );
    }

    validateSolution(solution) {
        const requiredFields = ['name', 'path', 'type'];
        return (
            solution &&
            typeof solution === 'object' &&
            requiredFields.every(field =>
                solution.hasOwnProperty(field) &&
                typeof solution[field] === 'string' &&
                solution[field].trim() !== ''
            )
        );
    }

    getAllSolutions() {
        try {
            const config = this.loadConfig();
            return config.solutions || [];
        } catch (error) {
            console.error('Error getting solutions:', error);
            return [];
        }
    }

    getSolutionByPath(solutionPath) {
        try {
            const config = this.loadConfig();
            return config.solutions.find(s => s.path === solutionPath);
        } catch (error) {
            console.error('Error getting solution by path:', error);
            return null;
        }
    }

    updateSolution(solutionPath, updatedSolution) {
        try {
            const config = this.loadConfig();
            const index = config.solutions.findIndex(s => s.path === solutionPath);
            if (index !== -1) {
                config.solutions[index] = { ...config.solutions[index], ...updatedSolution };
                return this.saveConfig(config);
            }
            return false;
        } catch (error) {
            console.error('Error updating solution:', error);
            return false;
        }
    }

    clearConfig() {
        try {
            const emptyConfig = { rootPath: '', solutions: [] };
            return this.saveConfig(emptyConfig);
        } catch (error) {
            console.error('Error clearing config:', error);
            return false;
        }
    }

    normalizePath(inputPath) {
        if (!inputPath) return '';
        
        // Convert Windows-style paths to forward slashes
        let normalizedPath = inputPath.replace(/\\/g, '/');
        
        // Remove any duplicate slashes
        normalizedPath = normalizedPath.replace(/\/+/g, '/');
        
        // Remove trailing slash if present (unless it's just "/")
        if (normalizedPath.length > 1 && normalizedPath.endsWith('/')) {
            normalizedPath = normalizedPath.slice(0, -1);
        }
        
        return normalizedPath;
    }

    getConfigPath() {
        return this.configPath;
    }

    backupConfig() {
        try {
            const backupPath = `${this.configPath}.backup`;
            fs.copyFileSync(this.configPath, backupPath);
            console.log('Config backup created at:', backupPath);
            return true;
        } catch (error) {
            console.error('Error creating config backup:', error);
            return false;
        }
    }

    restoreBackup() {
        try {
            const backupPath = `${this.configPath}.backup`;
            if (fs.existsSync(backupPath)) {
                fs.copyFileSync(backupPath, this.configPath);
                console.log('Config restored from backup');
                return true;
            }
            return false;
        } catch (error) {
            console.error('Error restoring config from backup:', error);
            return false;
        }
    }
}

module.exports = ConfigManager;