// content.js — injected into instagram.com (isolated world)
// Overlays a download button on DM photos and videos.
//
// Videos are the hard part: Instagram shows a poster <img>, and the real video
// is a blob:/MediaSource <video> that only exists after playback. Guessing at
// the DOM kept handing back the poster jpg. So the real video URL is captured
// from the network in page.js (MAIN world) and pushed here; the button just
// downloads the most recent captured .mp4. Blob conversion is the fallback.

(() => {
  "use strict";

  const BTN_CLASS = "igdm-dl-btn";
  const WRAP_ATTR = "data-igdm-wrapped";
  const IDLE_LABEL = "⬇";
  const DEBUG = true;

  function log(...a) {
    if (DEBUG) console.debug("[IGDM/content]", ...a);
  }

  // --- captured video URLs (pushed from page.js) -----------------------------
  // Newest last. These are real https CDN URLs that chrome.downloads can save.
  const capturedVideos = [];

  // --- MAIN-world bridge -----------------------------------------------------
  let bridgeSeq = 0;
  const bridgePending = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== "IGDM") return;

    if (d.dir === "capture" && d.url) {
      if (!capturedVideos.some((c) => c.url === d.url)) {
        capturedVideos.push({ url: d.url, mime: d.mime || "" });
        if (capturedVideos.length > 40) capturedVideos.shift();
        log("captured video url", d.url.slice(0, 100));
      }
      return;
    }

    if (d.dir === "resp") {
      const resolver = bridgePending.get(d.id);
      if (!resolver) return;
      bridgePending.delete(d.id);
      resolver(d);
    }
  });

  function askPage(payload, timeoutMs = 30000) {
    return new Promise((resolve) => {
      const id = ++bridgeSeq;
      const timer = setTimeout(() => {
        if (bridgePending.has(id)) {
          bridgePending.delete(id);
          resolve({ ok: false, error: "TIMEOUT" });
        }
      }, timeoutMs);
      bridgePending.set(id, (d) => {
        clearTimeout(timer);
        resolve(d);
      });
      window.postMessage(
        Object.assign({ source: "IGDM", dir: "req", id }, payload),
        "*"
      );
    });
  }

  // --- filename / download ---------------------------------------------------
  function extFromUrl(url, fallback) {
    try {
      const path = new URL(url).pathname;
      const m = path.match(/\.(jpg|jpeg|png|webp|mp4|mov|m4v|gif)(?:$|\?)/i);
      if (m) return m[1].toLowerCase();
    } catch (_) {}
    return fallback;
  }

  function buildFilename(url, isVideo, mime) {
    let ext = extFromUrl(url, null);
    if (!ext) {
      if (mime && mime.includes("webm")) ext = "webm";
      else ext = isVideo ? "mp4" : "jpg";
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `instagram-dm/ig-dm-${stamp}.${ext}`;
  }

  function download(url, filename, btn) {
    log("download ->", filename, url.slice(0, 80));
    chrome.runtime.sendMessage(
      { type: "DOWNLOAD_MEDIA", url, filename },
      (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) {
          log("download failed", chrome.runtime.lastError, resp);
          flash(btn, "✕");
        } else {
          flash(btn, "✓");
        }
      }
    );
  }

  // --- status glyphs ---------------------------------------------------------
  function flash(btn, text) {
    btn.textContent = text;
    if (btn._t) clearTimeout(btn._t);
    btn._t = setTimeout(() => {
      btn.textContent = IDLE_LABEL;
      btn._t = null;
    }, 1400);
  }
  function setStatus(btn, text) {
    if (btn._t) {
      clearTimeout(btn._t);
      btn._t = null;
    }
    btn.textContent = text;
  }

  // --- image url resolution --------------------------------------------------
  function resolveImgUrl(img) {
    if (img.srcset) {
      const best = img.srcset
        .split(",")
        .map((s) => {
          const [u, d] = s.trim().split(/\s+/);
          return { u, d: parseFloat(d) || 1 };
        })
        .sort((a, b) => b.d - a.d)[0];
      if (best?.u) return best.u;
    }
    return img.src || null;
  }

  // --- video download strategy ----------------------------------------------
  // 1. Prefer a captured https CDN url (from network hook) — most reliable.
  // 2. Else a non-blob src on the <video> element.
  // 3. Else convert the blob: url via page.js.
  // 4. Else ask the user to press play (no video/url exists yet).
  async function downloadVideo(bubble, btn) {
    setStatus(btn, "…");

    // 1: Ask background script for webRequest-captured URLs
    const bgResp = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: "GET_RECENT_VIDEOS" }, (resp) => {
        resolve(resp);
      });
    });
    
    const recent = (bgResp && bgResp.ok && bgResp.list) ? bgResp.list : [];
    
    // 2: Fallback to page.js captured URLs if any
    const best = recent.length ? recent[recent.length - 1] : 
                 (capturedVideos.length ? capturedVideos[capturedVideos.length - 1] : null);

    if (best) {
      download(best.url, buildFilename(best.url, true, best.mime), btn);
      return;
    }

    const video = bubble ? bubble.querySelector("video") : null;

    // 2: direct src on the element.
    if (video) {
      const direct =
        (video.src && !video.src.startsWith("blob:") && video.src) ||
        (video.currentSrc &&
          !video.currentSrc.startsWith("blob:") &&
          video.currentSrc);
      if (direct) {
        download(direct, buildFilename(direct, true), btn);
        return;
      }
    }

    // 3: blob conversion via the page.
    const blobUrl =
      video && (video.currentSrc || video.src);
    if (blobUrl && blobUrl.startsWith("blob:")) {
      setStatus(btn, "…");
      const resp = await askPage({ kind: "blob", blobUrl });
      if (resp.ok && resp.dataUrl) {
        download(resp.dataUrl, buildFilename("", true, resp.mime), btn);
        return;
      }
      // STREAM = MediaSource; there's no single file at the blob url. Fall
      // through to the play hint, since capture may still pick it up.
      log("blob convert failed", resp.error);
    }

    // 4: nothing yet.
    setStatus(btn, "▶");
    btn.title = "Press play on the video, let it start, then click again";
    setTimeout(() => setStatus(btn, IDLE_LABEL), 2000);
  }

  // --- button + injection ----------------------------------------------------
  function makeButton(kind, opts) {
    const btn = document.createElement("button");
    btn.className = BTN_CLASS;
    btn.type = "button";
    btn.textContent = IDLE_LABEL;
    btn.title = kind === "video" ? "Download video" : "Download photo";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (kind === "photo") {
        const url = resolveImgUrl(opts.img);
        if (!url) return flash(btn, "✕");
        download(url, buildFilename(url, false), btn);
      } else {
        downloadVideo(opts.bubble, btn);
      }
    });
    return btn;
  }

  function inDirectThread(el) {
    if (!location.pathname.startsWith("/direct/")) return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 80 && rect.height >= 80;
  }

  function attachButton(host, btn) {
    if (getComputedStyle(host).position === "static") {
      host.style.position = "relative";
    }
    host.classList.add("igdm-host");
    host.appendChild(btn);
  }

  function hostFor(el) {
    return el.closest("[role='button']") || el.parentElement || el;
  }

  // Nearest ancestor that groups the poster <img> and the <video>/play overlay.
  function getBubble(el) {
    let node = el.parentElement;
    for (let i = 0; i < 8 && node; i++) {
      if (
        node.querySelector("video") ||
        node.querySelector(
          'svg[aria-label*="Play" i], svg[aria-label*="Video" i], [aria-label*="video" i]'
        )
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return hostFor(el);
  }

  function bubbleHasVideoIndicator(bubble) {
    if (!bubble || !bubble.querySelector) return false;
    if (bubble.querySelector("video")) return true;
    
    // Fallbacks for Instagram's video play buttons if aria-label is localized or removed
    const svgs = bubble.querySelectorAll("svg");
    for (const svg of svgs) {
      const label = (svg.getAttribute("aria-label") || "").toLowerCase();
      if (label.includes("play") || label.includes("video") || label.includes("clip")) return true;
      
      const paths = svg.querySelectorAll("path");
      for (const path of paths) {
        const d = path.getAttribute("d") || "";
        // Common paths for Play triangles on Instagram
        if (d.includes("16.3 36.8") || d.includes("35.8 24") || d.includes("16 11l16 13") || d.includes("16 4.996")) {
          return true;
        }
      }
      
      if (svg.querySelector("polygon")) return true;
    }
    
    // Secondary fallback: specific classes often used for play icons
    if (bubble.querySelector('[class*="play" i], [class*="video" i]')) return true;

    return false;
  }

  function wrapVideo(video) {
    if (video.getAttribute(WRAP_ATTR)) return;
    if (!inDirectThread(video)) return;
    video.setAttribute(WRAP_ATTR, "1");
    const bubble = getBubble(video);
    if (bubble.setAttribute) bubble.setAttribute("data-igdm-video", "1");
    attachButton(hostFor(video), makeButton("video", { bubble }));
  }

  function wrapImg(img) {
    if (img.getAttribute(WRAP_ATTR)) return;
    if (!inDirectThread(img)) return;

    const bubble = getBubble(img);

    // Poster whose bubble already has a video button — skip.
    if (bubble.getAttribute && bubble.getAttribute("data-igdm-video")) {
      img.setAttribute(WRAP_ATTR, "1");
      return;
    }

    img.setAttribute(WRAP_ATTR, "1");

    if (bubbleHasVideoIndicator(bubble)) {
      if (bubble.setAttribute) bubble.setAttribute("data-igdm-video", "1");
      attachButton(hostFor(img), makeButton("video", { bubble }));
      return;
    }

    attachButton(hostFor(img), makeButton("photo", { img }));
  }

  function scan() {
    document.querySelectorAll("video").forEach(wrapVideo);
    document.querySelectorAll("img").forEach(wrapImg);
  }

  let queued = false;
  function queueScan() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  }

  new MutationObserver(queueScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  queueScan();
  log("content script ready");
})();
