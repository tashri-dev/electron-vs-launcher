const { loadSolutions, clearSelections, selectAllCheckboxes, handleConfigUpdate } = require('./solutionManager');

// Add event listeners once DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  try {
    // Initialize event listeners
    initializeEventListeners();

    // Load initial solutions
    loadSolutions();
  } catch (error) {
    console.error('Failed to initialize application:', error);
    // Could add UI feedback here for initialization failure
  }
});

function initializeEventListeners() {
  try {
    console.log('Event listeners will be initialized by SolutionManager');
    // Note: SolutionManager handles all button bindings in bindMainActions()
    // No need to duplicate the bindings here
  } catch (error) {
    console.error('Failed to initialize event listeners:', error);
    throw error;
  }
}

// Note: All button event handlers are managed by SolutionManager
// No duplicate functions needed here

// Output management functions
function addOutputEntry(message, type = 'info', timestamp = new Date()) {
  const outputContainer = document.getElementById('outputContainer');
  if (!outputContainer) return;

  const entry = document.createElement('div');
  entry.className = `output-entry ${type}`;

  const timestampDiv = document.createElement('div');
  timestampDiv.className = 'output-timestamp';
  timestampDiv.textContent = `[${timestamp.toLocaleTimeString()}]`;

  const messageDiv = document.createElement('div');
  messageDiv.textContent = message;

  entry.appendChild(timestampDiv);
  entry.appendChild(messageDiv);
  outputContainer.appendChild(entry);

  // Auto-scroll to bottom
  outputContainer.scrollTop = outputContainer.scrollHeight;
}

function clearOutput() {
  const outputContainer = document.getElementById('outputContainer');
  if (outputContainer) {
    outputContainer.innerHTML = `
      <div class="output-entry">
        <div class="output-timestamp">[${new Date().toLocaleTimeString()}]</div>
        <div>Output cleared by user.</div>
      </div>
    `;
  }
}

function exportOutput() {
  const outputContainer = document.getElementById('outputContainer');
  if (!outputContainer) return;

  const outputText = Array.from(outputContainer.children).map(entry => {
    const timestamp = entry.querySelector('.output-timestamp')?.textContent || '';
    const message = entry.querySelector('div:not(.output-timestamp)')?.textContent || '';
    return `${timestamp} ${message}`;
  }).join('\n');

  const blob = new Blob([outputText], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `output-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Terminal management functions
function createTerminalTab(solutionName, solutionId) {
  const terminalTabs = document.getElementById('terminalTabs');
  const terminalTabsContent = document.getElementById('terminalTabsContent');
  const noTerminalsMessage = document.getElementById('noTerminalsMessage');

  if (!terminalTabs || !terminalTabsContent) return;

  // Hide no terminals message
  if (noTerminalsMessage) {
    noTerminalsMessage.style.display = 'none';
  }

  // Create tab button
  const tabId = `terminal-${solutionId}`;
  const tabButton = document.createElement('li');
  tabButton.className = 'nav-item terminal-tab';
  tabButton.innerHTML = `
    <button class="nav-link" id="${tabId}-tab" data-bs-toggle="pill" data-bs-target="#${tabId}" 
            type="button" role="tab" aria-controls="${tabId}">
      ${solutionName}
      <span class="close-tab" onclick="closeTerminalTab('${solutionId}')">&times;</span>
    </button>
  `;
  terminalTabs.appendChild(tabButton);

  // Create tab content
  const tabContent = document.createElement('div');
  tabContent.className = 'tab-pane fade';
  tabContent.id = tabId;
  tabContent.innerHTML = `
    <div class="terminal-output" id="terminal-output-${solutionId}">
      <div class="text-success">[${new Date().toLocaleTimeString()}] Starting ${solutionName}...</div>
    </div>
  `;
  terminalTabsContent.appendChild(tabContent);

  // Make it active if it's the first tab
  if (terminalTabs.children.length === 1) {
    tabButton.querySelector('.nav-link').classList.add('active');
    tabContent.classList.add('show', 'active');
  }

  return tabId;
}

function closeTerminalTab(solutionId) {
  const tabId = `terminal-${solutionId}`;
  const tabButton = document.querySelector(`#${tabId}-tab`);
  const tabContent = document.getElementById(tabId);
  const terminalTabs = document.getElementById('terminalTabs');
  const noTerminalsMessage = document.getElementById('noTerminalsMessage');

  if (tabButton) tabButton.parentElement.remove();
  if (tabContent) tabContent.remove();

  // Show no terminals message if no tabs left
  if (terminalTabs && terminalTabs.children.length === 0 && noTerminalsMessage) {
    noTerminalsMessage.style.display = 'block';
  }

  // Stop the solution if it's running
  if (window.solutionManager) {
    window.solutionManager.stopSolution(solutionId);
  }
}

function appendToTerminal(solutionId, message, type = 'info') {
  const terminalOutput = document.getElementById(`terminal-output-${solutionId}`);
  if (!terminalOutput) return;

  const timestamp = new Date().toLocaleTimeString();
  const messageDiv = document.createElement('div');
  messageDiv.className = type === 'error' ? 'text-danger' : type === 'success' ? 'text-success' : 'text-light';
  messageDiv.innerHTML = `<span class="text-muted">[${timestamp}]</span> ${message}`;

  terminalOutput.appendChild(messageDiv);
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

// Initialize output tab event listeners
document.addEventListener('DOMContentLoaded', () => {
  // Clear output button
  const clearOutputBtn = document.getElementById('clearOutput');
  if (clearOutputBtn) {
    clearOutputBtn.addEventListener('click', clearOutput);
  }

  // Export output button
  const exportOutputBtn = document.getElementById('exportOutput');
  if (exportOutputBtn) {
    exportOutputBtn.addEventListener('click', exportOutput);
  }

  // Make functions globally available
  window.addOutputEntry = addOutputEntry;
  window.createTerminalTab = createTerminalTab;
  window.closeTerminalTab = closeTerminalTab;
  window.appendToTerminal = appendToTerminal;
});

// Export functions that might be needed by other modules
module.exports = {
  loadSolutions,
  clearSelections,
  selectAllCheckboxes,
  handleConfigUpdate,
  runSelectedInCli,
  launchSelectedSolutions,
  getLatestFromSelected,
  addOutputEntry,
  createTerminalTab,
  closeTerminalTab,
  appendToTerminal
};