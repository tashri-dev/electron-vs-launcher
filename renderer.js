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
    throw error;
  }
}

// Export functions that might be needed by other modules
module.exports = {
  loadSolutions,
  clearSelections,
  selectAllCheckboxes,
  handleConfigUpdate
};

document.addEventListener('DOMContentLoaded', function () {
  // Check for table scrollability and add indicator
  const checkTableScroll = () => {
    document.querySelectorAll('.table-responsive').forEach(tableWrapper => {
      if (tableWrapper.scrollWidth > tableWrapper.clientWidth) {
        tableWrapper.classList.add('scrollable');
      } else {
        tableWrapper.classList.remove('scrollable');
      }
    });
  };

  // Create action dropdowns for small screens
  const setupActionDropdowns = () => {
    // Find all action cells
    document.querySelectorAll('.actions-cell').forEach((cell, index) => {
      // Skip if dropdown already exists
      if (cell.querySelector('.actions-dropdown')) return;

      // Create dropdown container
      const dropdown = document.createElement('div');
      dropdown.className = 'actions-dropdown';
      dropdown.id = `actions-dropdown-${index}`;

      // Create toggle button
      const toggle = document.createElement('button');
      toggle.className = 'actions-dropdown-toggle';
      toggle.innerHTML = '<i class="fa fa-ellipsis-v"></i>';
      toggle.setAttribute('aria-label', 'More actions');
      toggle.setAttribute('type', 'button');
      dropdown.appendChild(toggle);

      // Create dropdown menu
      const menu = document.createElement('div');
      menu.className = 'actions-dropdown-menu';
      dropdown.appendChild(menu);

      // Clone buttons for dropdown (excluding high priority ones)
      const visibleButtons = Array.from(cell.querySelectorAll('.btn-sm')).slice(0, 3);
      const hiddenButtons = Array.from(cell.querySelectorAll('.btn-sm')).slice(3);

      // Mark visible buttons as high priority
      visibleButtons.forEach(btn => {
        btn.classList.add('btn-priority-high');
      });

      // Clone and add hidden buttons to dropdown
      hiddenButtons.forEach(btn => {
        const clonedBtn = btn.cloneNode(true);
        clonedBtn.classList.add('dropdown-item');
        menu.appendChild(clonedBtn);

        // Preserve click handler
        clonedBtn.addEventListener('click', (e) => {
          e.preventDefault();
          btn.click(); // Trigger the original button's click event
        });
      });

      // Add dropdown to cell
      cell.appendChild(dropdown);

      // Toggle dropdown on click
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('show');

        // Close other open dropdowns
        document.querySelectorAll('.actions-dropdown.show').forEach(openDropdown => {
          if (openDropdown.id !== dropdown.id) {
            openDropdown.classList.remove('show');
          }
        });
      });
    });

    // Close dropdowns when clicking outside
    document.addEventListener('click', () => {
      document.querySelectorAll('.actions-dropdown.show').forEach(dropdown => {
        dropdown.classList.remove('show');
      });
    });
  };

  // Make main action buttons responsive with priority order
  const setupMainActions = () => {
    const actionsContainer = document.querySelector('.actions-container');
    if (!actionsContainer) return;

    // Set priority classes
    const buttons = actionsContainer.querySelectorAll('.btn');

    // Set priority class for each button based on role
    buttons.forEach(btn => {
      const text = btn.textContent.trim().toLowerCase();

      if (text.includes('run') || text.includes('selected solutions')) {
        btn.classList.add('btn-priority-high');
      } else if (text.includes('select all') || text.includes('get latest')) {
        btn.classList.add('btn-priority-medium');
      } else {
        btn.classList.add('btn-priority-low');
      }
    });
  };

  // Initial setup
  checkTableScroll();
  setupActionDropdowns();
  setupMainActions();

  // Update on window resize
  window.addEventListener('resize', () => {
    checkTableScroll();
    setupActionDropdowns();
  });

  // Update when content changes
  const observer = new MutationObserver(() => {
    checkTableScroll();
    setupActionDropdowns();
  });

  // Observe solutions container for changes
  const solutionsContainer = document.getElementById('solutionsContainer');
  if (solutionsContainer) {
    observer.observe(solutionsContainer, { childList: true, subtree: true });
  }
});