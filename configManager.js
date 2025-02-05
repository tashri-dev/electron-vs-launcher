const fs = require('fs');
const path = require('path');

class ConfigManager {
    constructor() {
        // Initialize paths
        this.appDir = __dirname;
        this.configPath = './config.json';
        this.templatePath = './config.template.json';

        console.log('ConfigManager initialized with paths:', {
            configPath: this.configPath,
            templatePath: this.templatePath
        });

        // Ensure config exists
        this.initializeConfig();
    }

    initializeConfig() {
        try {
            if (!fs.existsSync(this.configPath)) {
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
            console.log('Successfully loaded config:', config);
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
                console.log('Using template file');
                const templateData = fs.readFileSync(this.templatePath, 'utf8');
                const templateConfig = JSON.parse(templateData);
                fs.writeFileSync(this.configPath, JSON.stringify(templateConfig, null, 2));
                return templateConfig;
            }

            // Create default config if no template exists
            console.log('No template found, creating default config');
            fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2));
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

            // Save config to file
            fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
            console.log('Config saved successfully:', config);
            return true;
        } catch (error) {
            console.error('Error saving config:', error);
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
}

module.exports = ConfigManager;