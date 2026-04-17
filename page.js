// page.js — runs in the page's MAIN world (same JS context as Instagram).
// Two jobs:
//   1. Capture real media URLs (mp4/mov and progressive video) by hooking
//      fetch() and XMLHttpRequest. DM videos are fetched from Instagram's CDN;
//      recording those URLs lets us download the actual video instead of
//      guessing at the DOM (which was handing back the poster jpg).
//   2. Convert a blob: URL to a data URL when asked (only the page's own JS
//      context can fetch a blob it created).
//
// Protocol (via window.postMessage):
//   content -> page:  { source:"IGDM", dir:"req",  id, kind:"blob", blobUrl }
//   content -> page:  { source:"IGDM", dir:"req",  id, kind:"recent" }
//   page -> content:  { source:"IGDM", dir:"resp", id, ... }
//   page -> content:  { source:"IGDM", dir:"capture", url, mime, ts }  (push)

(() => {
  "use strict";

  const MAX_BYTES = 300 * 1024 * 1024; // 300 MB cap for blob->dataURL

  // Ring buffer of recently-seen video URLs, newest last.
  const captured = [];
  const CAP_MAX = 40;

  const VIDEO_RE = /\.(mp4|mov|m4v|webm)(\?|$)/i;
  const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp)(\?|$)/i;
  
  function looksLikeVideo(url, mime) {
    if (typeof url !== "string") return false;
    if (url.startsWith("blob:") || url.startsWith("data:")) return false;
    if (mime && /^video\//i.test(mime)) return true;
    if (mime && /^image\//i.test(mime)) return false;
    if (IMAGE_RE.test(url)) return false;
    
    // Instagram progressive videos: path ends in .mp4 (often with query args)
    // or the URL is served from the video CDN with a byte-range.
    return VIDEO_RE.test(url) || /\/v\/t\d|efg=|bytestart=/i.test(url);
  }

  function record(url, mime) {
    if (!looksLikeVideo(url, mime)) return;
    // Normalise: strip range params so re-fetches of the same file dedupe.
    const key = url.split("&bytestart=")[0].split("&byteend=")[0];
    const existing = captured.find((c) => c.key === key);
    if (existing) {
      existing.ts = tick();
      return;
    }
    captured.push({ url, key, mime: mime || "", ts: tick() });
    while (captured.length > CAP_MAX) captured.shift();
    log("captured video url:", url.slice(0, 120));
    // Push to content script so it can enable/flag buttons if it wants.
    window.postMessage(
      { source: "IGDM", dir: "capture", url, mime: mime || "" },
      "*"
    );
  }

  // Monotonic counter instead of Date.now() (not available / for determinism).
  let _t = 0;
  function tick() {
    return ++_t;
  }

  function log(...args) {
    // eslint-disable-next-line no-console
    console.debug("[IGDM/page]", ...args);
  }

  // --- hook fetch ------------------------------------------------------------
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      const req = args[0];
      const url =
        typeof req === "string" ? req : req && req.url ? req.url : "";
      return origFetch.apply(this, args).then((res) => {
        try {
          const ct = res.headers && res.headers.get("content-type");
          if (looksLikeVideo(url, ct)) record(url, ct || "");
        } catch (_) {}
        return res;
      });
    };
  }

  // --- hook XMLHttpRequest ---------------------------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__igdmUrl = url;
    return origOpen.apply(this, arguments);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", () => {
      try {
        const ct = this.getResponseHeader("content-type");
        if (looksLikeVideo(this.__igdmUrl, ct)) record(this.__igdmUrl, ct || "");
      } catch (_) {}
    });
    return origSend.apply(this, arguments);
  };

  // --- also watch <video> elements getting a real src -----------------------
  function scanVideos() {
    document.querySelectorAll("video").forEach((v) => {
      const src =
        (v.currentSrc && !v.currentSrc.startsWith("blob:") && v.currentSrc) ||
        (v.src && !v.src.startsWith("blob:") && v.src) ||
        "";
      if (src) record(src, "");
      const source = v.querySelector("source");
      if (source && source.src && !source.src.startsWith("blob:")) {
        record(source.src, "");
      }
    });
  }
  try {
    const mo = new MutationObserver(() => scanVideos());
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
  } catch (_) {}

  // --- blob conversion -------------------------------------------------------
  function respond(id, payload) {
    window.postMessage(
      Object.assign({ source: "IGDM", dir: "resp", id }, payload),
      "*"
    );
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      reader.readAsDataURL(blob);
    });
  }

  async function handleBlob(id, blobUrl) {
    try {
      let res;
      try {
        res = await fetch(blobUrl);
      } catch (e) {
        return respond(id, { ok: false, error: "STREAM" });
      }
      if (!res.ok) return respond(id, { ok: false, error: "STREAM" });
      const blob = await res.blob();
      if (!blob || blob.size === 0)
        return respond(id, { ok: false, error: "STREAM" });
      if (blob.size > MAX_BYTES)
        return respond(id, { ok: false, error: "TOO_BIG" });
      const dataUrl = await blobToDataUrl(blob);
      respond(id, { ok: true, dataUrl, mime: blob.type || "video/mp4" });
    } catch (e) {
      respond(id, { ok: false, error: (e && e.message) || "unknown" });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== "IGDM" || d.dir !== "req") return;
    if (d.kind === "blob" && typeof d.blobUrl === "string") {
      handleBlob(d.id, d.blobUrl);
    } else if (d.kind === "recent") {
      scanVideos();
      const list = captured
        .slice()
        .sort((a, b) => b.ts - a.ts)
        .map((c) => ({ url: c.url, mime: c.mime }));
      respond(d.id, { ok: true, list });
    }
  });

  log("media capture hooks installed");
})();
