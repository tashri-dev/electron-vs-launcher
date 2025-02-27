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
    // Get buttons
    const buttons = {
      clearBtn: { handler: clearSelections },
      selectAllBtn: { handler: selectAllCheckboxes },
      launchBtn: { handler: launchSelectedSolutions },
      'get-latest-selected': { handler: getLatestFromSelected }
    };

    // Add event listeners with error handling
    Object.entries(buttons).forEach(([id, { handler }]) => {
      const button = document.getElementById(id);
      if (button) {
        button.addEventListener("click", async (e) => {
          try {
            // Disable button during operation
            button.disabled = true;
            await handler(e);
          } catch (error) {
            console.error(`Error in ${id} handler:`, error);
            // Could add UI feedback here for operation failure
          } finally {
            button.disabled = false;
          }
        });
      } else {
        console.warn(`Button with id '${id}' not found in the DOM`);
      }
    });
  } catch (error) {
    console.error('Failed to initialize event listeners:', error);
    throw error; // Re-throw to be caught by the parent try-catch
  }
}

// Export functions that might be needed by other modules
module.exports = {
  loadSolutions,
  clearSelections,
  selectAllCheckboxes,
  handleConfigUpdate
};