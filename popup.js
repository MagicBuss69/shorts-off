// Popup script for Shorts Off.
// Reads and updates the "enabled" setting in chrome.storage.local and queries
// the active YouTube tab (if open) to show live status.

const STORAGE_KEY = "enabled";

const toggleInput = document.getElementById("enabled-toggle");
const statusText = document.getElementById("status-text");
const tabSummary = document.getElementById("tab-summary");

function renderState(enabled) {
  toggleInput.checked = enabled;
  document.body.classList.toggle("is-disabled", !enabled);
  statusText.textContent = enabled ? "Active on youtube.com" : "Paused";
}

async function refreshActiveTabSummary(enabled) {
  if (!enabled) {
    tabSummary.textContent = "Shorts visible";
    return;
  }

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) {
      tabSummary.textContent = "Ready";
      return;
    }

    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: "GET_SHORTS_STATUS"
    });

    if (response?.isYouTube) {
      const count = Number(response.hiddenCount) || 0;
      tabSummary.textContent = count === 1 ? "1 element hidden" : `${count} elements hidden`;
    } else {
      tabSummary.textContent = "Not on YouTube";
    }
  } catch {
    // sendMessage throws when the active tab is not a YouTube page (or was opened before install).
    tabSummary.textContent = "Open YouTube to apply";
  }
}

// Initialize toggle from chrome.storage.local.
chrome.storage.local.get({ [STORAGE_KEY]: true }, (result) => {
  const enabled = result[STORAGE_KEY] !== false;
  renderState(enabled);
  refreshActiveTabSummary(enabled);
});

// Persist toggle changes immediately; open YouTube tabs react via chrome.storage.onChanged.
toggleInput.addEventListener("change", async () => {
  const enabled = toggleInput.checked;
  renderState(enabled);
  await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
  // Give the content script one animation frame to finish updating its DOM markers.
  setTimeout(() => refreshActiveTabSummary(enabled), 60);
});
