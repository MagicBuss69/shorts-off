# Shorts Off

**Shorts Off** is a lightweight cross-browser Manifest V3 extension for **Chrome** and **Firefox** that removes YouTube Shorts across `youtube.com` and keeps them hidden as pages dynamically update.

## Features

- **Hides Shorts everywhere**: Removes Shorts shelves, carousels, cards, and filter chips on Home, Search results, Subscriptions, Channel pages (including the channel `Shorts` tab), and Watch page recommendations.
- **Cleans up navigation**: Hides the `Shorts` button in both the expanded left sidebar and the collapsed mini sidebar.
- **Redirects `/shorts/` URLs**: Automatically redirects `/shorts/<videoId>` links (both full navigations via `declarativeNetRequest` and YouTube SPA transitions) to the standard `/watch?v=<videoId>` player without trapping Back-button history.
- **Stops autoplay into Shorts**: Hides Shorts from endscreens/recommendations, cancels YouTube's Up Next countdown if it targets a Short, and prevents end-of-video autoplay from dropping you into Shorts.
- **Dynamic `MutationObserver`**: Watches YouTube's Polymer/Lit DOM updates so newly loaded Shorts are hidden as you scroll or switch pages, while properly unmarking recycled DOM nodes when YouTube rebinds them to regular videos.
- **Instant On/Off Popup**: Toggle protection on or off from the toolbar popup (`storage.local`), taking effect immediately on open YouTube tabs without reloading.
- **Chrome & Firefox MV3 Compatible**: Uses a single `manifest.json` with `browser_specific_settings.gecko`, dual `background` (`service_worker` for Chrome + `scripts` event page for Firefox), and Promise-based `browser` / `chrome` WebExtension APIs.

## Project Structure

- `manifest.json` — Cross-browser Manifest V3 extension definition (Chrome + Firefox 121+)
- `background.js` — Background worker/event page managing `storage.local`, badge state, and dynamic `declarativeNetRequest` redirect rules
- `content.css` — Scoped CSS rules (`html[data-shorts-off="true"]`) injected at `document_start` to prevent flashes of Shorts
- `content.js` — Content script with URL redirect logic, autoplay protection, and `MutationObserver` DOM scanner
- `popup.html`, `popup.css`, `popup.js` — Toolbar popup UI with persistent On/Off switch and Firefox host-permission check
- `icons/` — Extension icons (`16`, `32`, `48`, `128` px)

## Loading Unpacked in Chrome

No build step is required. Load this folder directly into Chrome:

1. Open Google Chrome and navigate to `chrome://extensions`.
2. Turn on **Developer mode** using the toggle in the top-right corner.
3. Click **Load unpacked** in the top-left toolbar.
4. Select this project directory (the folder containing `manifest.json`).
5. *(Optional)* Click the puzzle-piece **Extensions** icon in Chrome's toolbar and pin **Shorts Off** for quick access to the On/Off toggle.

## Loading Temporarily in Firefox

1. Open Firefox (121 or newer) and navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `manifest.json` inside this project directory.
4. *(Optional)* Click the puzzle-piece **Extensions** button in Firefox's toolbar, open the gear menu next to **Shorts Off**, and click **Pin to Toolbar** (if Firefox prompts for `youtube.com` site access, allow it or click **Allow on youtube.com** inside the popup).

## How to Test

1. Visit `https://www.youtube.com` — verify the Home feed Shorts shelves and the `Shorts` button in both the expanded and collapsed left sidebar are gone.
2. Search on YouTube, open **Subscriptions**, and visit any **Channel** page — verify Shorts shelves, individual Short cards, and the channel `Shorts` tab are hidden.
3. Navigate directly to a Short URL (for example `https://www.youtube.com/shorts/dQw4w9WgXcQ`) — verify it redirects straight to `https://www.youtube.com/watch?v=dQw4w9WgXcQ`.
4. Click the **Shorts Off** toolbar icon and toggle the switch off/on — verify Shorts reappear and disappear immediately without refreshing the page.
