// Content script injected at document_start on youtube.com (Chrome & Firefox).
// Handles:
// 1. Syncing the on/off toggle from storage.local
// 2. Redirecting /shorts/<id> URLs (including SPA navigations) to /watch?v=<id>
// 3. Preventing end-of-video autoplay & recommendations from dropping into Shorts
// 4. Watching YouTube's dynamic DOM via MutationObserver to hide newly loaded Shorts

(() => {
  const ext = globalThis.browser ?? globalThis.chrome;
  const STORAGE_KEY = "enabled";
  const ROOT_ATTR = "data-shorts-off";
  const HIDDEN_ATTR = "data-shorts-off-hidden";
  const SHORTS_PATH_RE = /^\/shorts(?:\/([^/?#]+))?\/?$/;

  let isEnabled = true;
  let scanScheduled = false;
  let lastKnownUrl = window.location.href;
  let lastWatchUrl = window.location.pathname === "/watch" ? window.location.href : null;
  let lastUserGestureTime = 0;
  let lastVideoEndTime = 0;
  let cachedNextNormalVideoUrl = null;

  function isElementNode(node) {
    return Boolean(node && node.nodeType === Node.ELEMENT_NODE);
  }

  function isVideoElement(node) {
    return isElementNode(node) && node.tagName.toLowerCase() === "video";
  }

  /**
   * Keeps html[data-shorts-off] synced with isEnabled.
   * Safe at document_start in Firefox, where document.documentElement may be null
   * until the HTML parser inserts the root <html> element.
   */
  function syncRootAttribute() {
    const root = document.documentElement;
    if (!root) return;

    if (isEnabled) {
      if (root.getAttribute(ROOT_ATTR) !== "true") {
        root.setAttribute(ROOT_ATTR, "true");
      }
    } else if (root.hasAttribute(ROOT_ATTR)) {
      root.removeAttribute(ROOT_ATTR);
    }
  }

  // Optimistically enable CSS rules at document_start so Shorts never flash on load.
  syncRootAttribute();

  /**
   * Converts a YouTube /shorts/ URL into a standard /watch?v= URL (or "/" for bare /shorts).
   * Returns null if the URL is not a YouTube Shorts URL.
   */
  function getShortsRedirectUrl(rawUrl) {
    if (!rawUrl) return null;

    let parsed;
    try {
      parsed = new URL(rawUrl, window.location.origin);
    } catch {
      return null;
    }

    if (!parsed.hostname.endsWith("youtube.com")) {
      return null;
    }

    const match = parsed.pathname.match(SHORTS_PATH_RE);
    if (!match) {
      return null;
    }

    const videoId = match[1];
    if (!videoId) {
      return new URL("/", parsed.origin).toString();
    }

    const watchUrl = new URL("/watch", parsed.origin);
    watchUrl.searchParams.set("v", videoId);

    // Preserve timestamp or playlist context if present on the incoming link.
    const startTime = parsed.searchParams.get("t");
    if (startTime) {
      watchUrl.searchParams.set("t", startTime);
    }
    const listId = parsed.searchParams.get("list");
    if (listId) {
      watchUrl.searchParams.set("list", listId);
    }

    return watchUrl.toString();
  }

  /**
   * Finds the first recommended standard /watch?v= video in the Watch sidebar,
   * skipping any Shorts links or hidden items.
   */
  function findNextNormalRecommendationUrl() {
    const relatedRoot =
      document.querySelector("#related") ||
      document.querySelector("ytd-watch-next-secondary-results-renderer");
    if (!relatedRoot) return null;

    const currentVideoId = new URLSearchParams(window.location.search).get("v");
    const links = relatedRoot.querySelectorAll('a[href*="/watch?v="]');

    for (const link of links) {
      if (link.closest(`[${HIDDEN_ATTR}="true"]`)) continue;
      try {
        const url = new URL(link.href, window.location.origin);
        const candidateId = url.searchParams.get("v");
        if (candidateId && candidateId !== currentVideoId) {
          return url.toString();
        }
      } catch {
        // Ignore malformed hrefs.
      }
    }
    return null;
  }

  /**
   * Redirects away from /shorts/ URLs.
   * Distinguishes user-initiated visits (redirect /shorts/ID -> /watch?v=ID) from
   * end-of-video autoplay transitions (skip the Short completely in favor of a normal video).
   */
  function handleShortsUrlIfNeeded() {
    if (!isEnabled) return false;

    const redirectUrl = getShortsRedirectUrl(window.location.href);
    if (!redirectUrl) {
      if (window.location.pathname === "/watch") {
        lastWatchUrl = window.location.href;
      }
      return false;
    }

    const now = Date.now();
    const userClickedRecently = now - lastUserGestureTime < 2500;
    const video = document.querySelector("video.html5-main-video");
    const videoCurrentlyAtEnd = Boolean(
      isVideoElement(video) &&
        (video.ended || (video.duration > 0 && video.duration - video.currentTime <= 3))
    );
    const endedRecently = videoCurrentlyAtEnd || now - lastVideoEndTime < 4000;
    const cameFromAutoplayAfterWatch = Boolean(lastWatchUrl) && endedRecently && !userClickedRecently;

    if (cameFromAutoplayAfterWatch) {
      // Autoplay tried to drop the user into Shorts after finishing a normal video.
      // Route to the next real /watch video (or stay out of Shorts) instead of playing that Short.
      const fallbackUrl =
        findNextNormalRecommendationUrl() ||
        cachedNextNormalVideoUrl ||
        lastWatchUrl ||
        new URL("/", window.location.origin).toString();
      window.location.replace(fallbackUrl);
      return true;
    }

    // Use location.replace so /shorts/ does not remain in Back-button history and cause a loop.
    window.location.replace(redirectUrl);
    return true;
  }

  /**
   * Checks whether a candidate DOM element currently represents Shorts content.
   * Used both to hide newly rendered Shorts and to unhide DOM nodes that YouTube's
   * Polymer router recycled for normal videos on subsequent navigations.
   */
  function isShortsElement(el) {
    if (!isElementNode(el)) return false;
    const tag = el.tagName.toLowerCase();

    // Dedicated Shorts shelves and lockups.
    if (
      tag === "ytd-reel-shelf-renderer" ||
      tag === "ytm-reel-shelf-renderer" ||
      tag === "ytd-reel-item-renderer" ||
      tag === "ytm-shorts-lockup-view-model" ||
      tag === "ytm-shorts-lockup-view-model-v2"
    ) {
      return true;
    }

    if (tag === "ytd-rich-shelf-renderer") {
      return el.hasAttribute("is-shorts") || Boolean(el.querySelector('a[href*="/shorts/"]'));
    }

    if (tag === "ytd-rich-section-renderer") {
      return Boolean(
        el.querySelector(
          "ytd-rich-shelf-renderer[is-shorts], ytd-reel-shelf-renderer, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2"
        )
      );
    }

    if (tag === "ytd-item-section-renderer") {
      // Subscriptions list view wraps single reel shelves inside an item-section.
      const contents = el.querySelector(":scope > #contents");
      return Boolean(
        contents &&
          contents.children.length === 1 &&
          contents.firstElementChild?.tagName.toLowerCase() === "ytd-reel-shelf-renderer"
      );
    }

    if (tag === "grid-shelf-view-model" || tag === "ytd-shelf-renderer") {
      if (
        el.querySelector(
          'ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-reel-item-renderer, a[href*="/shorts/"]'
        )
      ) {
        return true;
      }
      const heading = el.querySelector("#title, h2, .yt-shelf-header-layout__title");
      return heading?.textContent?.trim().toLowerCase() === "shorts";
    }

    // Left sidebar & mini-sidebar guide entries (handles command endpoints without href).
    if (tag === "ytd-guide-entry-renderer" || tag === "ytd-mini-guide-entry-renderer") {
      if (
        el.querySelector('a[href="/shorts"], a[href^="/shorts/"], a[href^="/shorts?"], a[title="Shorts" i]') ||
        el.getAttribute("aria-label")?.trim().toLowerCase() === "shorts"
      ) {
        return true;
      }
      const label = el.querySelector(".title")?.textContent?.trim().toLowerCase();
      return label === "shorts";
    }

    if (tag === "ytm-pivot-bar-item-renderer") {
      return Boolean(el.querySelector(".pivot-shorts")) || el.textContent?.trim().toLowerCase() === "shorts";
    }

    // Channel page "Shorts" tab & feed/search "Shorts" filter chips.
    if (tag === "yt-tab-shape" || tag === "tp-yt-paper-tab") {
      const tabTitle = el.getAttribute("tab-title")?.trim().toLowerCase();
      if (tabTitle === "shorts") return true;
      return el.textContent?.trim().toLowerCase() === "shorts";
    }

    if (tag === "yt-chip-cloud-chip-renderer" || tag === "chip-view-model") {
      return el.textContent?.trim().toLowerCase() === "shorts";
    }

    // Standard video/item cards across Home, Search, Subscriptions, Channels, and Watch sidebar.
    if (
      tag === "ytd-rich-item-renderer" ||
      tag === "ytd-video-renderer" ||
      tag === "ytd-grid-video-renderer" ||
      tag === "ytd-compact-video-renderer" ||
      tag === "yt-lockup-view-model"
    ) {
      return Boolean(
        el.querySelector(
          'ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, a[href*="/shorts/"], ytd-thumbnail-overlay-time-status-renderer[overlay-style="SHORTS"], badge-shape[aria-label="Shorts" i]'
        )
      );
    }

    // Player endscreen tiles, creator endscreen cards, and autoplay up-next overlays.
    if (el.classList.contains("ytp-videowall-still")) {
      return Boolean(el.getAttribute("href")?.includes("/shorts/"));
    }

    if (el.classList.contains("ytp-ce-element") || el.classList.contains("ytp-autonav-endscreen-upnext-container")) {
      return Boolean(el.querySelector('a[href*="/shorts/"]'));
    }

    return false;
  }

  function markHidden(el) {
    if (el.getAttribute(HIDDEN_ATTR) !== "true") {
      el.setAttribute(HIDDEN_ATTR, "true");
    }
  }

  /**
   * Monitors the HTML5 video player and cancels YouTube's Up Next autoplay countdown
   * whenever YouTube queues a Short after a normal video.
   */
  function guardAutoplayAndEndscreen() {
    if (!isEnabled) return;

    const player = document.getElementById("movie_player");
    if (player) {
      const upNextContainer = player.querySelector(".ytp-autonav-endscreen-upnext-container");
      const shortsAutoplayLink = upNextContainer?.querySelector('a[href*="/shorts/"]');

      if (
        upNextContainer &&
        shortsAutoplayLink &&
        upNextContainer.getAttribute(HIDDEN_ATTR) !== "true"
      ) {
        markHidden(upNextContainer);
        const cancelButton = player.querySelector(".ytp-autonav-endscreen-upnext-cancel-button");
        if (cancelButton && typeof cancelButton.click === "function") {
          cancelButton.click();
        }
      }

      player.querySelectorAll('.ytp-videowall-still[href*="/shorts/"]').forEach(markHidden);
      player.querySelectorAll(".ytp-ce-element").forEach((card) => {
        if (isShortsElement(card)) markHidden(card);
      });
    }
  }

  const CANDIDATE_SELECTOR = [
    "ytd-rich-section-renderer",
    "ytd-rich-shelf-renderer",
    "ytd-reel-shelf-renderer",
    "ytm-reel-shelf-renderer",
    "ytd-item-section-renderer",
    "grid-shelf-view-model",
    "ytd-shelf-renderer",
    "ytd-reel-item-renderer",
    "ytm-shorts-lockup-view-model",
    "ytm-shorts-lockup-view-model-v2",
    "ytd-guide-entry-renderer",
    "ytd-mini-guide-entry-renderer",
    "ytm-pivot-bar-item-renderer",
    "yt-tab-shape",
    "tp-yt-paper-tab",
    "yt-chip-cloud-chip-renderer",
    "chip-view-model",
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-compact-video-renderer",
    "yt-lockup-view-model"
  ].join(",");

  /**
   * Scans the current DOM to hide Shorts elements and unhide recycled Polymer nodes.
   */
  function scanPage() {
    scanScheduled = false;
    syncRootAttribute();
    if (!isEnabled) return;

    if (handleShortsUrlIfNeeded()) {
      return;
    }

    // 1. Re-check previously hidden nodes in case YouTube recycled them for normal videos.
    document.querySelectorAll(`[${HIDDEN_ATTR}="true"]`).forEach((el) => {
      if (!isShortsElement(el)) {
        el.removeAttribute(HIDDEN_ATTR);
      }
    });

    // 2. Tag all matching Shorts shelves, cards, sidebar buttons, tabs, and filter chips.
    document.querySelectorAll(CANDIDATE_SELECTOR).forEach((el) => {
      if (isShortsElement(el)) {
        markHidden(el);
      }
    });

    // 3. Guard Watch-page recommendations and end-of-video autoplay.
    if (window.location.pathname === "/watch") {
      cachedNextNormalVideoUrl = findNextNormalRecommendationUrl() || cachedNextNormalVideoUrl;
      guardAutoplayAndEndscreen();
    }
  }

  /**
   * Batches rapid DOM mutations into a single scan per animation frame to keep scrolling smooth.
   */
  function scheduleScan() {
    syncRootAttribute();
    if (!isEnabled || scanScheduled) return;

    // Always run URL redirect checks synchronously so SPA navigations never render /shorts/.
    if (window.location.href !== lastKnownUrl) {
      lastKnownUrl = window.location.href;
      if (handleShortsUrlIfNeeded()) {
        return;
      }
    }

    scanScheduled = true;
    requestAnimationFrame(scanPage);
  }

  function applyEnabledState(enabled) {
    isEnabled = Boolean(enabled);
    syncRootAttribute();

    if (isEnabled) {
      scanPage();
    } else {
      document.querySelectorAll(`[${HIDDEN_ATTR}="true"]`).forEach((el) => {
        el.removeAttribute(HIDDEN_ATTR);
      });
    }
  }

  // Observe `document` (not `document.documentElement`) so MutationObserver never fails at
  // document_start in Firefox before the root <html> element has been parsed.
  const observer = new MutationObserver(() => {
    scheduleScan();
  });

  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href", "is-shorts", "tab-title", "title", "overlay-style"]
  });

  // Track genuine user clicks/keypresses and intercept clicks on any remaining /shorts/ links
  // (such as links inside video descriptions or comments) so they open in /watch?v= directly.
  document.addEventListener(
    "click",
    (event) => {
      if (event.isTrusted) {
        lastUserGestureTime = Date.now();
      }
      if (!isEnabled) return;

      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const target = isElementNode(event.target) ? event.target.closest("a[href]") : null;
      if (!target) return;

      const watchUrl = getShortsRedirectUrl(target.href);
      if (watchUrl) {
        event.preventDefault();
        event.stopPropagation();
        window.location.assign(watchUrl);
      }
    },
    true
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.isTrusted) {
        lastUserGestureTime = Date.now();
      }
    },
    true
  );

  // Capture-phase media listeners catch playback end on any <video> element, even when swapped dynamically.
  document.addEventListener(
    "timeupdate",
    (event) => {
      if (!isEnabled || !isVideoElement(event.target)) return;
      const video = event.target;
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;
      const remaining = video.duration - video.currentTime;
      if (remaining <= 10) {
        cachedNextNormalVideoUrl = findNextNormalRecommendationUrl() || cachedNextNormalVideoUrl;
        if (remaining <= 2.5) {
          lastVideoEndTime = Date.now();
        }
        guardAutoplayAndEndscreen();
      }
    },
    true
  );

  document.addEventListener(
    "ended",
    (event) => {
      if (!isEnabled || !isVideoElement(event.target)) return;
      lastVideoEndTime = Date.now();
      cachedNextNormalVideoUrl = findNextNormalRecommendationUrl() || cachedNextNormalVideoUrl;
      guardAutoplayAndEndscreen();
    },
    true
  );

  document.addEventListener("DOMContentLoaded", () => {
    scheduleScan();
  });

  // Listen to YouTube's SPA router custom events and browser history navigation.
  for (const eventName of [
    "yt-navigate-start",
    "yt-navigate-finish",
    "yt-page-data-updated",
    "popstate"
  ]) {
    window.addEventListener(eventName, () => {
      lastKnownUrl = window.location.href;
      if (!handleShortsUrlIfNeeded()) {
        scheduleScan();
      }
    });
  }

  // Load saved toggle state from storage.local (Promise API works in both Firefox & Chrome MV3).
  ext.storage.local.get({ [STORAGE_KEY]: true }).then((result) => {
    applyEnabledState(result[STORAGE_KEY] !== false);
  });

  ext.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[STORAGE_KEY]) {
      applyEnabledState(changes[STORAGE_KEY].newValue !== false);
    }
  });

  // Allow the popup to query how many Shorts elements are currently hidden on this tab.
  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_SHORTS_STATUS") {
      const hiddenCount = isEnabled
        ? document.querySelectorAll(`[${HIDDEN_ATTR}="true"]`).length
        : 0;
      sendResponse({
        enabled: isEnabled,
        hiddenCount,
        isYouTube: true
      });
    }
  });
})();
