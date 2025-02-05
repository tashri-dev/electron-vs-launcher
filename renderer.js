const { loadSolutions, clearSelections, selectAllCheckboxes, handleConfigUpdate } = require('./solutionManager');

// Add event listeners once DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  // Initialize event listeners
  initializeEventListeners();

  // Load initial solutions
  loadSolutions();
});

function initializeEventListeners() {
  // Get buttons
  const clearBtn = document.getElementById("clearBtn");
  const selectAllBtn = document.getElementById("selectAllBtn");
  const launchBtn = document.getElementById("launchBtn");
  const getLatestSelectedBtn = document.getElementById("get-latest-selected");

  // Add event listeners
  if (clearBtn) clearBtn.addEventListener("click", clearSelections);
  if (selectAllBtn) selectAllBtn.addEventListener("click", selectAllCheckboxes);
  if (launchBtn) launchBtn.addEventListener("click", launchSelectedSolutions);
  if (getLatestSelectedBtn) getLatestSelectedBtn.addEventListener("click", getLatestFromSelected);
}

// Export functions that might be needed by other modules
module.exports = {
  loadSolutions,
  clearSelections,
  selectAllCheckboxes,
  handleConfigUpdate
};