// Background service worker (Manifest V3).
// Manages default settings in chrome.storage.local, toolbar badge state, and
// network-level /shorts/ redirects via declarativeNetRequest so direct links
// never even load the Shorts player shell.
// (Client-side YouTube SPA navigations are handled alongside this in content.js.)

const STORAGE_KEY = "enabled";
const REDIRECT_RULE_IDS = [1, 2, 3];

// Dynamic redirect rules installed only while Shorts Off is enabled.
const SHORTS_REDIRECT_RULES = [
  {
    id: 1,
    priority: 2,
    action: {
      type: "redirect",
      redirect: {
        // Preserves optional subdomain (\1), video ID (\2), and query string (\3, e.g. t=15).
        regexSubstitution: "https://\\1youtube.com/watch?v=\\2&\\3"
      }
    },
    condition: {
      regexFilter: "^https?://(www\\.|m\\.)?youtube\\.com/shorts/([A-Za-z0-9_-]+)/?\\?([^#]+)$",
      resourceTypes: ["main_frame"]
    }
  },
  {
    id: 2,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        regexSubstitution: "https://\\1youtube.com/watch?v=\\2"
      }
    },
    condition: {
      regexFilter: "^https?://(www\\.|m\\.)?youtube\\.com/shorts/([A-Za-z0-9_-]+)/?$",
      resourceTypes: ["main_frame"]
    }
  },
  {
    id: 3,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        // Bare /shorts feed URL without a video ID redirects to YouTube Home.
        regexSubstitution: "https://\\1youtube.com/"
      }
    },
    condition: {
      regexFilter: "^https?://(www\\.|m\\.)?youtube\\.com/shorts/?(?:\\?.*)?$",
      resourceTypes: ["main_frame"]
    }
  }
];

// Serialize rule updates so rapid popup toggles cannot interleave and collide on rule IDs.
let syncQueue = Promise.resolve();

function syncExtensionState(enabled) {
  syncQueue = syncQueue
    .then(async () => {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: REDIRECT_RULE_IDS,
        addRules: enabled ? SHORTS_REDIRECT_RULES : []
      });

      await chrome.action.setBadgeText({ text: enabled ? "" : "OFF" });
      if (!enabled) {
        await chrome.action.setBadgeBackgroundColor({ color: "#52525b" });
      }
    })
    .catch((err) => {
      console.error("[Shorts Off] Failed to sync state:", err);
    });

  return syncQueue;
}

async function initState() {
  const stored = await chrome.storage.local.get({ [STORAGE_KEY]: true });
  const enabled = stored[STORAGE_KEY] !== false;
  await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
  await syncExtensionState(enabled);
}

chrome.runtime.onInstalled.addListener(() => {
  initState();
});

chrome.runtime.onStartup.addListener(() => {
  initState();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE_KEY]) {
    syncExtensionState(Boolean(changes[STORAGE_KEY].newValue));
  }
});
