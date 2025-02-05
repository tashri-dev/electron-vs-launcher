const path = require('path');
const ConfigManager = require('./configManager');

class SolutionLoader {
    constructor() {
        this.configManager = new ConfigManager();
        this.itemsPerPage = 10;
        this.currentPage = 1;
        this.loadSolutions();
    }

    loadSolutions() {
        try {
            const config = this.configManager.loadConfig();
            this.solutions = config.solutions || [];
            this.totalPages = Math.ceil(this.solutions.length / this.itemsPerPage);
            this.displaySolutions();
        } catch (error) {
            console.error('Error loading solutions:', error);
        }
    }

    displaySolutions() {
        const solutionsContainer = document.getElementById("solutionsContainer");
        if (!solutionsContainer) return;

        solutionsContainer.innerHTML = ''; // Clear existing content

        // Get solutions for current page
        const startIndex = (this.currentPage - 1) * this.itemsPerPage;
        const endIndex = startIndex + this.itemsPerPage;
        const currentSolutions = this.solutions.slice(startIndex, endIndex);

        // Group solutions by parent directory
        const groupedSolutions = this.groupSolutionsByParent(currentSolutions);

        // Create and append each group
        Object.entries(groupedSolutions).forEach(([parentDir, solutions]) => {
            const groupElement = this.createGroupElement(parentDir, solutions);
            solutionsContainer.appendChild(groupElement);
        });

        // Add pagination controls
        this.addPaginationControls(solutionsContainer);
    }

    addPaginationControls(container) {
        const paginationDiv = document.createElement('div');
        paginationDiv.classList.add('pagination-controls', 'd-flex', 'justify-content-between', 'align-items-center', 'mt-4');

        // Add page info
        const pageInfo = document.createElement('div');
        pageInfo.classList.add('page-info');
        pageInfo.textContent = `Page ${this.currentPage} of ${this.totalPages}`;
        paginationDiv.appendChild(pageInfo);

        // Add buttons container
        const buttonsContainer = document.createElement('div');
        buttonsContainer.classList.add('buttons-container');

        // Previous button
        if (this.currentPage > 1) {
            const prevButton = document.createElement('button');
            prevButton.classList.add('btn', 'btn-secondary', 'me-2');
            prevButton.textContent = 'Previous';
            prevButton.onclick = () => {
                this.currentPage--;
                this.displaySolutions();
            };
            buttonsContainer.appendChild(prevButton);
        }

        // Next button
        if (this.currentPage < this.totalPages) {
            const nextButton = document.createElement('button');
            nextButton.classList.add('btn', 'btn-secondary');
            nextButton.textContent = 'Next';
            nextButton.onclick = () => {
                this.currentPage++;
                this.displaySolutions();
            };
            buttonsContainer.appendChild(nextButton);
        }

        paginationDiv.appendChild(buttonsContainer);
        container.appendChild(paginationDiv);
    }

    groupSolutionsByParent(solutions) {
        return solutions.reduce((acc, solution) => {
            const parentDir = solution.path.split('\\')[0];
            if (!acc[parentDir]) {
                acc[parentDir] = [];
            }
            acc[parentDir].push(solution);
            return acc;
        }, {});
    }

    createGroupElement(parentDir, solutions) {
        const groupDiv = document.createElement('div');
        groupDiv.classList.add('parent-directory');

        // Add group header
        const header = document.createElement('h3');
        header.textContent = parentDir;
        groupDiv.appendChild(header);

        // Add solutions table
        const table = this.createSolutionsTable(solutions);
        groupDiv.appendChild(table);

        return groupDiv;
    }

    createSolutionsTable(solutions) {
        const table = document.createElement('table');
        table.classList.add('table', 'table-striped', 'table-hover', 'align-middle');

        // Create header
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        headerRow.innerHTML = `
            <th>Solution Name</th>
            <th>Actions</th>
        `;
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Create body
        const tbody = document.createElement('tbody');
        solutions.forEach(solution => {
            const row = this.createSolutionRow(solution);
            tbody.appendChild(row);
        });
        table.appendChild(tbody);

        return table;
    }

    createSolutionRow(solution) {
        const row = document.createElement('tr');

        // Checkbox and name cell
        const nameTd = document.createElement('td');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.classList.add('form-check-input');
        checkbox.id = solution.name.replace(/\s/g, '');
        checkbox.value = path.join(solution.path);

        const label = document.createElement('label');
        label.classList.add('form-check-label', 'ms-2');
        label.htmlFor = checkbox.id;
        label.textContent = solution.name;

        nameTd.appendChild(checkbox);
        nameTd.appendChild(label);

        // Add IDE selector
        this.createIdeSelector(solution, nameTd);

        // Actions cell
        const actionsTd = document.createElement('td');

        // Get Latest button
        const getLatestBtn = document.createElement('button');
        getLatestBtn.classList.add('btn', 'btn-secondary', 'btn-sm', 'me-2');
        getLatestBtn.innerHTML = '<i class="fa fa-solid fa-download"></i>';
        getLatestBtn.onclick = () => this.getLatest(solution.path);
        actionsTd.appendChild(getLatestBtn);

        // Update DB button (if applicable)
        if (solution.migratorPath) {
            const updateDbBtn = document.createElement('button');
            updateDbBtn.classList.add('btn', 'btn-warning', 'btn-sm', 'ms-1');
            updateDbBtn.textContent = 'Update DB';
            updateDbBtn.onclick = () => this.updateDb(solution.migratorPath);
            actionsTd.appendChild(updateDbBtn);
        }

        // Dockerize button (if applicable)
        if (solution.dockerPort) {
            const dockerizeBtn = document.createElement('button');
            dockerizeBtn.classList.add('btn', 'btn-primary', 'btn-sm', 'ms-1');
            dockerizeBtn.textContent = 'Dockerize';
            dockerizeBtn.onclick = () => this.dockerizeApp(solution);
            actionsTd.appendChild(dockerizeBtn);
        }

        row.appendChild(nameTd);
        row.appendChild(actionsTd);
        return row;
    }

    createIdeSelector(solution, containerElement) {
        const IDE = {
            VS2022_DEBUG: 'Visual Studio 2022 (Debug)',
            VS2022_NO_DEBUG: 'Visual Studio 2022 (Without Debug)',
            RIDER_DEBUG: 'Rider (Debug)',
            RIDER_NO_DEBUG: 'Rider (Without Debug)',
            VSCODE: 'VS Code'
        };

        const selectContainer = document.createElement('div');
        selectContainer.classList.add('ide-selector', 'ms-2');

        const select = document.createElement('select');
        select.classList.add('form-select', 'form-select-sm');
        select.style.width = 'auto';
        select.style.display = 'inline-block';

        Object.values(IDE).forEach(value => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value;
            select.appendChild(option);
        });

        selectContainer.appendChild(select);
        containerElement.appendChild(selectContainer);
    }
    // Action handlers
    getLatest(solutionPath) {
        console.log('Getting latest for:', solutionPath);
        // Implement your get latest logic here
    }

    updateDb(migratorPath) {
        console.log('Updating DB for:', migratorPath);
        // Implement your update DB logic here
    }

    dockerizeApp(solution) {
        console.log('Dockerizing:', solution);
        // Implement your dockerize logic here
    }
}

// Initialize when the document is ready
document.addEventListener('DOMContentLoaded', () => {
    window.solutionLoader = new SolutionLoader();
});

module.exports = SolutionLoader;