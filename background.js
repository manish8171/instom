// background.js — service worker
// Receives download requests from the content script and uses the
// chrome.downloads API to save media directly to the local Downloads folder.

const recentVideos = [];
const MAX_VIDEOS = 40;

const VIDEO_RE = /\.(mp4|mov|m4v|webm)(\?|$)/i;
const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp)(\?|$)/i;

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.type !== "media" && details.type !== "xmlhttprequest") return;
    
    let isVideo = false;
    let mime = "";
    for (const h of details.responseHeaders || []) {
      if (h.name.toLowerCase() === "content-type") {
        mime = h.value.toLowerCase();
        if (mime.startsWith("video/")) isVideo = true;
        break;
      }
    }

    const url = details.url;
    if (mime.startsWith("image/") || IMAGE_RE.test(url)) return;

    if (isVideo || VIDEO_RE.test(url) || /\/v\/t\d.*mp4/i.test(url) || /bytestart=/i.test(url)) {
      let cleanUrl = url;
      try {
        const u = new URL(url);
        u.searchParams.delete("bytestart");
        u.searchParams.delete("byteend");
        cleanUrl = u.toString();
      } catch(e) {}

      const key = cleanUrl;
      const existing = recentVideos.find(v => v.key === key);
      if (existing) {
        existing.ts = Date.now();
      } else {
        recentVideos.push({ url: cleanUrl, key, mime, ts: Date.now() });
        if (recentVideos.length > MAX_VIDEOS) recentVideos.shift();
      }
    }
  },
  {
    urls: [
      "https://*.cdninstagram.com/*",
      "https://*.fbcdn.net/*",
      "https://*.instagram.com/*"
    ]
  },
  ["responseHeaders"]
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_RECENT_VIDEOS") {
    // Sort by timestamp so the newest is at the end
    const sorted = [...recentVideos].sort((a, b) => a.ts - b.ts);
    sendResponse({ ok: true, list: sorted });
    return false;
  }

  if (message?.type === "DOWNLOAD_MEDIA") {
    const { url, filename } = message;
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: false,
        conflictAction: "uniquify"
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, downloadId });
        }
      }
    );
    return true; // Keep channel open for async response
  }
});
