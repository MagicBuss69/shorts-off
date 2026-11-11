// Popup script for Shorts Off (Chrome & Firefox MV3).
// Reads and updates the "enabled" setting in storage.local, checks YouTube host
// permissions (which users can toggle in Firefox MV3), and queries the active tab.

const ext = globalThis.browser ?? globalThis.chrome;
const STORAGE_KEY = "enabled";
const YOUTUBE_ORIGINS = ["*://*.youtube.com/*"];

const toggleInput = document.getElementById("enabled-toggle");
const statusText = document.getElementById("status-text");
const tabSummary = document.getElementById("tab-summary");
const permissionBanner = document.getElementById("permission-banner");
const grantPermissionBtn = document.getElementById("grant-permission-btn");

function renderState(enabled) {
  toggleInput.checked = enabled;
  document.body.classList.toggle("is-disabled", !enabled);
  statusText.textContent = enabled ? "Active on youtube.com" : "Paused";
}

async function checkHostPermission() {
  if (!ext.permissions?.contains) return true;
  try {
    const granted = await ext.permissions.contains({ origins: YOUTUBE_ORIGINS });
    permissionBanner.hidden = granted;
    return granted;
  } catch {
    permissionBanner.hidden = true;
    return true;
  }
}

async function refreshActiveTabSummary(enabled) {
  const hasPermission = await checkHostPermission();
  if (!hasPermission) {
    tabSummary.textContent = "Permission needed";
    return;
  }

  if (!enabled) {
    tabSummary.textContent = "Shorts visible";
    return;
  }

  try {
    const [activeTab] = await ext.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) {
      tabSummary.textContent = "Ready";
      return;
    }

    const response = await ext.tabs.sendMessage(activeTab.id, {
      type: "GET_SHORTS_STATUS"
    });

    if (response?.isYouTube) {
      const count = Number(response.hiddenCount) || 0;
      tabSummary.textContent = count === 1 ? "1 element hidden" : `${count} elements hidden`;
    } else {
      tabSummary.textContent = "Not on YouTube";
    }
  } catch {
    // sendMessage rejects when the active tab is not a YouTube page (or was opened before install).
    tabSummary.textContent = "Open YouTube to apply";
  }
}

// Initialize toggle from storage.local.
ext.storage.local.get({ [STORAGE_KEY]: true }).then((result) => {
  const enabled = result[STORAGE_KEY] !== false;
  renderState(enabled);
  refreshActiveTabSummary(enabled);
});

// Persist toggle changes immediately; open YouTube tabs react via storage.onChanged.
toggleInput.addEventListener("change", async () => {
  const enabled = toggleInput.checked;
  renderState(enabled);
  await ext.storage.local.set({ [STORAGE_KEY]: enabled });
  // Give the content script one animation frame to finish updating its DOM markers.
  setTimeout(() => refreshActiveTabSummary(enabled), 60);
});

// Allow granting youtube.com host access directly from the popup if revoked in Firefox MV3.
grantPermissionBtn.addEventListener("click", async () => {
  if (!ext.permissions?.request) return;
  const granted = await ext.permissions.request({ origins: YOUTUBE_ORIGINS });
  permissionBanner.hidden = granted;
  if (granted) {
    refreshActiveTabSummary(toggleInput.checked);
  }
});
