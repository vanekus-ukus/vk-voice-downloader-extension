const DEBUG = false;
const LOG_PREFIX = "[VK Voice & Clips Downloader]";
const STORAGE_KEYS = {
  legacyEnabled: "enabled",
  voiceEnabled: "enabledVoice",
  clipsEnabled: "enabledClips"
};

function debug(...args) {
  if (!DEBUG) {
    return;
  }

  console.debug(LOG_PREFIX, ...args);
}

function warn(...args) {
  console.warn(LOG_PREFIX, ...args);
}

function error(...args) {
  console.error(LOG_PREFIX, ...args);
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("") + "-" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function inferVoiceFallbackExtension(data) {
  return data?.sourceType === "linkMp3" ? "mp3" : "ogg";
}

function inferClipFallbackExtension(data) {
  if (data?.sourceType === "hls") {
    return "m3u8";
  }

  if (data?.sourceType === "dash_sep") {
    return "mpd";
  }

  return "mp4";
}

function sanitizeDownloadFilename(filename, extension, fallbackPrefix) {
  const normalized = String(filename || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");

  if (normalized) {
    return normalized;
  }

  return `${fallbackPrefix}-${formatTimestamp(new Date())}.${extension}`;
}

function isAllowedDownloadUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function extractVoiceDataInMainWorld(nodeToken) {
  const ROOT_SELECTOR = ".AttachVoice";
  const PLAYER_SELECTOR = ".AttachVoice__player";
  const NODE_TOKEN_ATTR = "data-vkvd-voice-token";
  const MAX_FIBER_STEPS = 10;
  const MAX_ANCESTOR_STEPS = 5;
  const MAX_DESCENDANT_SCAN = 80;

  function getReactInternalKey(node, prefixes) {
    if (!node) {
      return null;
    }

    const keys = new Set([
      ...Object.keys(node),
      ...Object.getOwnPropertyNames(node)
    ]);

    for (const key of keys) {
      if (typeof key !== "string") {
        continue;
      }

      for (const prefix of prefixes) {
        if (key.startsWith(prefix)) {
          return key;
        }
      }
    }

    return null;
  }

  function getReactInternals(node) {
    const fiberKey = getReactInternalKey(node, ["__reactFiber$", "__reactContainer$"]);
    const propsKey = getReactInternalKey(node, ["__reactProps$"]);

    return {
      fiber: fiberKey ? node[fiberKey] : null,
      props: propsKey ? node[propsKey] : null
    };
  }

  function collectCandidateNodes(node) {
    if (!(node instanceof Element)) {
      return [];
    }

    const nodes = new Set();
    const addNode = (candidate) => {
      if (candidate instanceof Element) {
        nodes.add(candidate);
      }
    };

    addNode(node);
    addNode(node.querySelector(PLAYER_SELECTOR));

    try {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
      let current = walker.nextNode();
      let scanned = 0;

      while (current && scanned < MAX_DESCENDANT_SCAN) {
        addNode(current);
        current = walker.nextNode();
        scanned += 1;
      }
    } catch {
      // Best-effort traversal only.
    }

    let parent = node.parentElement;
    let depth = 0;

    while (parent && depth < MAX_ANCESTOR_STEPS) {
      addNode(parent);
      parent = parent.parentElement;
      depth += 1;
    }

    return [...nodes];
  }

  function createEmptyVoiceSnapshot() {
    return {
      linkOgg: null,
      linkMp3: null,
      audioTrackUrl: null,
      meta: {
        cmid: null,
        peerId: null,
        authorId: null,
        voiceId: null,
        ownerId: null
      }
    };
  }

  function mergeMeta(baseMeta, nextMeta) {
    const merged = { ...baseMeta };

    for (const [key, value] of Object.entries(nextMeta || {})) {
      if ((merged[key] === null || merged[key] === undefined || merged[key] === "") && value !== null && value !== undefined && value !== "") {
        merged[key] = value;
      }
    }

    return merged;
  }

  function extractMessageData(message) {
    const voice = message?.attaches?.voice;

    if (!voice) {
      return null;
    }

    return {
      linkOgg: voice.linkOgg || null,
      linkMp3: voice.linkMp3 || null,
      meta: {
        cmid: message.cmid ?? null,
        peerId: message.peerId ?? null,
        authorId: message.authorId ?? null,
        voiceId: voice.id ?? null,
        ownerId: voice.ownerId ?? null
      }
    };
  }

  function mergeVoiceSnapshot(baseSnapshot, nextSnapshot) {
    if (!nextSnapshot) {
      return baseSnapshot;
    }

    baseSnapshot.linkOgg = baseSnapshot.linkOgg || nextSnapshot.linkOgg || null;
    baseSnapshot.linkMp3 = baseSnapshot.linkMp3 || nextSnapshot.linkMp3 || null;
    baseSnapshot.audioTrackUrl = baseSnapshot.audioTrackUrl || nextSnapshot.audioTrackUrl || null;
    baseSnapshot.meta = mergeMeta(baseSnapshot.meta, nextSnapshot.meta);

    return baseSnapshot;
  }

  function extractVoiceSnapshot(container) {
    if (!container || typeof container !== "object") {
      return null;
    }

    const snapshot = createEmptyVoiceSnapshot();
    const messageCandidates = [
      container.message,
      container.props?.message,
      container.memoizedProps?.message,
      container.pendingProps?.message,
      container.memoizedProps?.children?.props?.message
    ];

    for (const message of messageCandidates) {
      const extractedMessage = extractMessageData(message);

      if (!extractedMessage) {
        continue;
      }

      snapshot.linkOgg = snapshot.linkOgg || extractedMessage.linkOgg;
      snapshot.linkMp3 = snapshot.linkMp3 || extractedMessage.linkMp3;
      snapshot.meta = mergeMeta(snapshot.meta, extractedMessage.meta);
    }

    snapshot.linkOgg =
      snapshot.linkOgg ||
      container.attaches?.voice?.linkOgg ||
      container.voice?.linkOgg ||
      null;

    snapshot.linkMp3 =
      snapshot.linkMp3 ||
      container.attaches?.voice?.linkMp3 ||
      container.voice?.linkMp3 ||
      null;

    snapshot.audioTrackUrl =
      snapshot.audioTrackUrl ||
      container.memoizedState?.memoizedState?.current?.audioTrack?.url ||
      container.memoizedState?.current?.audioTrack?.url ||
      container.current?.audioTrack?.url ||
      container.audioTrack?.url ||
      null;

    return snapshot;
  }

  function toVoiceData(snapshot) {
    const url = snapshot.linkOgg || snapshot.audioTrackUrl || snapshot.linkMp3;

    if (!url) {
      return null;
    }

    return {
      url,
      linkOgg: snapshot.linkOgg,
      linkMp3: snapshot.linkMp3,
      audioTrackUrl: snapshot.audioTrackUrl,
      sourceType: snapshot.linkOgg ? "linkOgg" : snapshot.audioTrackUrl ? "audioTrack" : "linkMp3",
      meta: snapshot.meta
    };
  }

  const node =
    document.querySelector(`${ROOT_SELECTOR}[${NODE_TOKEN_ATTR}="${nodeToken}"]`) ||
    document.querySelector(`[${NODE_TOKEN_ATTR}="${nodeToken}"]`);

  if (!node) {
    return {
      ok: false,
      error: "Voice node was not found in the page context."
    };
  }

  let foundReactInternals = false;

  for (const candidateNode of collectCandidateNodes(node)) {
    const { fiber, props } = getReactInternals(candidateNode);

    if (!fiber && !props) {
      continue;
    }

    foundReactInternals = true;

    const snapshot = createEmptyVoiceSnapshot();
    mergeVoiceSnapshot(snapshot, extractVoiceSnapshot(props));

    let currentFiber = fiber;
    let currentStep = 0;

    while (currentFiber && currentStep <= MAX_FIBER_STEPS) {
      mergeVoiceSnapshot(snapshot, extractVoiceSnapshot(currentFiber));
      mergeVoiceSnapshot(snapshot, extractVoiceSnapshot(currentFiber.memoizedProps));
      mergeVoiceSnapshot(snapshot, extractVoiceSnapshot(currentFiber.pendingProps));
      mergeVoiceSnapshot(snapshot, extractVoiceSnapshot(currentFiber.memoizedState));

      currentFiber = currentFiber.return;
      currentStep += 1;
    }

    const voiceData = toVoiceData(snapshot);

    if (voiceData?.url) {
      return {
        ok: true,
        data: voiceData
      };
    }
  }

  return {
    ok: false,
    error: foundReactInternals
      ? "Voice URL was not found in nearby React internals."
      : "React internals were not found near the selected voice node."
  };
}

function extractClipDataInMainWorld(nodeToken) {
  const ROOT_SELECTOR = '[data-testid="clips-feed-item"]';
  const NODE_TOKEN_ATTR = "data-vkvd-clip-token";
  const MAX_FIBER_STEPS = 10;
  const MAX_ANCESTOR_STEPS = 5;
  const MAX_DESCENDANT_SCAN = 80;
  const MAX_SCAN_DEPTH = 6;
  const MAX_SCAN_OBJECTS = 140;

  function getReactFiberKey(node) {
    if (!node) {
      return null;
    }

    const keys = new Set([
      ...Object.keys(node),
      ...Object.getOwnPropertyNames(node)
    ]);

    for (const key of keys) {
      if (typeof key === "string" && (key.startsWith("__reactFiber$") || key.startsWith("__reactContainer$"))) {
        return key;
      }
    }

    return null;
  }

  function getReactPropsKey(node) {
    if (!node) {
      return null;
    }

    const keys = new Set([
      ...Object.keys(node),
      ...Object.getOwnPropertyNames(node)
    ]);

    for (const key of keys) {
      if (typeof key === "string" && key.startsWith("__reactProps$")) {
        return key;
      }
    }

    return null;
  }

  function getReactInternals(node) {
    const fiberKey = getReactFiberKey(node);
    const propsKey = getReactPropsKey(node);

    return {
      fiber: fiberKey ? node[fiberKey] : null,
      props: propsKey ? node[propsKey] : null
    };
  }

  function collectCandidateNodes(node) {
    if (!(node instanceof Element)) {
      return [];
    }

    const nodes = new Set();
    const addNode = (candidate) => {
      if (candidate instanceof Element) {
        nodes.add(candidate);
      }
    };

    addNode(node);

    try {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
      let current = walker.nextNode();
      let scanned = 0;

      while (current && scanned < MAX_DESCENDANT_SCAN) {
        addNode(current);
        current = walker.nextNode();
        scanned += 1;
      }
    } catch {
      // Best-effort traversal only.
    }

    let parent = node.parentElement;
    let depth = 0;

    while (parent && depth < MAX_ANCESTOR_STEPS) {
      addNode(parent);
      parent = parent.parentElement;
      depth += 1;
    }

    return [...nodes];
  }

  function getValueByPath(root, path) {
    let current = root;

    for (const key of path) {
      if (current === null || current === undefined) {
        return null;
      }

      current = current[key];
    }

    return current;
  }

  function isClipVideoCandidate(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      value.files &&
      typeof value.files === "object" &&
      (value.owner_id !== undefined || value.id !== undefined || value.united_video_id !== undefined)
    );
  }

  function scanForVideoCandidate(root) {
    const queue = [{ value: root, depth: 0 }];
    const seen = new Set();
    let scanned = 0;

    while (queue.length > 0 && scanned < MAX_SCAN_OBJECTS) {
      const { value, depth } = queue.shift();

      if (!value || typeof value !== "object" || seen.has(value)) {
        continue;
      }

      seen.add(value);
      scanned += 1;

      if (isClipVideoCandidate(value)) {
        return value;
      }

      if (isClipVideoCandidate(value.video)) {
        return value.video;
      }

      if (depth >= MAX_SCAN_DEPTH) {
        continue;
      }

      const preferredKeys = ["video", "props", "children", "memoizedProps", "pendingProps", "memoizedState", "state", "item"];

      for (const key of preferredKeys) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          queue.push({ value: value[key], depth: depth + 1 });
        }
      }

      if (Array.isArray(value)) {
        for (let index = 0; index < Math.min(value.length, 8); index += 1) {
          queue.push({ value: value[index], depth: depth + 1 });
        }

        continue;
      }

      const fallbackKeys = Object.keys(value)
        .filter((key) => /video|clip|props|children|item|data|feed/i.test(key))
        .slice(0, 12);

      for (const key of fallbackKeys) {
        queue.push({ value: value[key], depth: depth + 1 });
      }
    }

    return null;
  }

  function extractVideo(container) {
    if (!container || typeof container !== "object") {
      return null;
    }

    const candidatePaths = [
      ["video"],
      ["props", "video"],
      ["children", 0, "props", "children", "props", "video"],
      ["children", "props", "video"],
      ["props", "children", "props", "video"],
      ["props", "children", 0, "props", "children", "props", "video"],
      ["memoizedProps", "children", 0, "props", "children", "props", "video"],
      ["pendingProps", "children", 0, "props", "children", "props", "video"]
    ];

    for (const path of candidatePaths) {
      const candidate = getValueByPath(container, path);

      if (isClipVideoCandidate(candidate)) {
        return candidate;
      }
    }

    return scanForVideoCandidate(container);
  }

  function pickBestClipUrl(files) {
    if (!files || typeof files !== "object") {
      return null;
    }

    const mp4Sources = [
      { key: "mp4_480", quality: "480p", extension: "mp4" },
      { key: "mp4_360", quality: "360p", extension: "mp4" },
      { key: "mp4_240", quality: "240p", extension: "mp4" },
      { key: "mp4_144", quality: "144p", extension: "mp4" }
    ];

    for (const source of mp4Sources) {
      const url = files[source.key];

      if (typeof url === "string" && url.trim()) {
        return {
          key: source.key,
          quality: source.quality,
          sourceType: source.key,
          extension: source.extension,
          url,
          unsupportedStreamFallback: false
        };
      }
    }

    const streamFallbacks = [
      { key: "hls", extension: "m3u8" },
      { key: "dash_sep", extension: "mpd" }
    ];

    for (const fallback of streamFallbacks) {
      const url = files[fallback.key];

      if (typeof url === "string" && url.trim()) {
        return {
          key: fallback.key,
          quality: null,
          sourceType: fallback.key,
          extension: fallback.extension,
          url,
          unsupportedStreamFallback: true
        };
      }
    }

    return null;
  }

  function toClipData(video) {
    if (!isClipVideoCandidate(video)) {
      return null;
    }

    const pickedUrl = pickBestClipUrl(video.files);

    if (!pickedUrl?.url) {
      return null;
    }

    return {
      url: pickedUrl.url,
      quality: pickedUrl.quality,
      qualityKey: pickedUrl.key,
      sourceType: pickedUrl.sourceType,
      extension: pickedUrl.extension,
      unsupportedStreamFallback: pickedUrl.unsupportedStreamFallback,
      ownerId: video.owner_id ?? null,
      videoId: video.id ?? null,
      unitedVideoId: video.united_video_id ?? null,
      files: video.files || null
    };
  }

  function getClipPriority(clipData) {
    switch (clipData?.qualityKey) {
      case "mp4_480":
        return 500;
      case "mp4_360":
        return 400;
      case "mp4_240":
        return 300;
      case "mp4_144":
        return 200;
      case "hls":
        return 50;
      case "dash_sep":
        return 40;
      default:
        return 0;
    }
  }

  const node =
    document.querySelector(`${ROOT_SELECTOR}[${NODE_TOKEN_ATTR}="${nodeToken}"]`) ||
    document.querySelector(`[${NODE_TOKEN_ATTR}="${nodeToken}"]`);

  if (!node) {
    return {
      ok: false,
      error: "Clip node was not found in the page context."
    };
  }

  let foundReactInternals = false;
  let bestClipData = null;

  for (const candidateNode of collectCandidateNodes(node)) {
    const { fiber, props } = getReactInternals(candidateNode);

    if (!fiber && !props) {
      continue;
    }

    foundReactInternals = true;

    const directClipData = toClipData(extractVideo(props));

    if (directClipData && (!bestClipData || getClipPriority(directClipData) > getClipPriority(bestClipData))) {
      bestClipData = directClipData;
    }

    let currentFiber = fiber;
    let currentStep = 0;

    while (currentFiber && currentStep <= MAX_FIBER_STEPS) {
      const containers = [
        currentFiber,
        currentFiber.memoizedProps,
        currentFiber.pendingProps,
        currentFiber.memoizedState
      ];

      for (const container of containers) {
        const clipData = toClipData(extractVideo(container));

        if (clipData && (!bestClipData || getClipPriority(clipData) > getClipPriority(bestClipData))) {
          bestClipData = clipData;
        }
      }

      if (bestClipData && getClipPriority(bestClipData) >= 500) {
        return {
          ok: true,
          data: bestClipData
        };
      }

      currentFiber = currentFiber.return;
      currentStep += 1;
    }
  }

  if (bestClipData) {
    return {
      ok: true,
      data: bestClipData
    };
  }

  return {
    ok: false,
    error: foundReactInternals
      ? "Clip video data was not found in nearby React internals."
      : "React internals were not found near the selected clip node."
  };
}

function executeMainWorldExtraction(tabId, token, extractor, missingTokenError) {
  return new Promise((resolve, reject) => {
    if (!tabId) {
      reject(new Error("Tab ID is missing."));
      return;
    }

    if (!token) {
      reject(new Error(missingTokenError));
      return;
    }

    chrome.scripting.executeScript(
      {
        target: { tabId },
        world: "MAIN",
        func: extractor,
        args: [token]
      },
      (results) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        const result = results?.[0]?.result;

        if (!result?.ok) {
          reject(new Error(result?.error || "Page extraction failed."));
          return;
        }

        resolve(result.data);
      }
    );
  });
}

function downloadFile(data, extension, fallbackPrefix) {
  return new Promise((resolve, reject) => {
    if (!data?.url || !isAllowedDownloadUrl(data.url)) {
      reject(new Error("Download URL is missing or invalid."));
      return;
    }

    const filename = sanitizeDownloadFilename(data.filename, extension, fallbackPrefix);

    chrome.downloads.download(
      {
        url: data.url,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(downloadId);
      }
    );
  });
}

function downloadVoiceFile(data) {
  return downloadFile(data, inferVoiceFallbackExtension(data), "vk-voice");
}

function downloadClipFile(data) {
  return downloadFile(data, inferClipFallbackExtension(data), "vk-clip");
}

async function handleExtractVoiceDataMessage(message, sender) {
  const data = await executeMainWorldExtraction(
    sender.tab?.id,
    message.token,
    extractVoiceDataInMainWorld,
    "Voice node token is missing."
  );
  return { ok: true, data };
}

async function handleExtractClipDataMessage(message, sender) {
  const data = await executeMainWorldExtraction(
    sender.tab?.id,
    message.token,
    extractClipDataInMainWorld,
    "Clip node token is missing."
  );
  return { ok: true, data };
}

async function handleDownloadVoiceMessage(message) {
  const downloadId = await downloadVoiceFile(message.data);
  debug("Voice download started.", downloadId);
  return { ok: true, downloadId };
}

async function handleDownloadClipMessage(message) {
  if (message.data?.unsupportedStreamFallback) {
    warn("Clip download falls back to a raw HLS/DASH URL. This is a best-effort download, not an MP4 remux.");
  }

  const downloadId = await downloadClipFile(message.data);
  debug("Clip download started.", downloadId);
  return { ok: true, downloadId };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(
    {
      [STORAGE_KEYS.legacyEnabled]: true,
      [STORAGE_KEYS.voiceEnabled]: null,
      [STORAGE_KEYS.clipsEnabled]: null
    },
    (items) => {
      if (chrome.runtime.lastError) {
        error("Failed to initialize default settings.", chrome.runtime.lastError.message);
        return;
      }

      const legacyEnabled = items[STORAGE_KEYS.legacyEnabled] !== false;
      const patch = {};

      if (typeof items[STORAGE_KEYS.voiceEnabled] !== "boolean") {
        patch[STORAGE_KEYS.voiceEnabled] = legacyEnabled;
      }

      if (typeof items[STORAGE_KEYS.clipsEnabled] !== "boolean") {
        patch[STORAGE_KEYS.clipsEnabled] = legacyEnabled;
      }

      if (Object.keys(patch).length > 0) {
        chrome.storage.local.set(patch, () => {
          if (chrome.runtime.lastError) {
            warn("Failed to persist default settings.", chrome.runtime.lastError.message);
          }
        });
      }
    }
  );
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler =
    message?.type === "extract-voice-data"
      ? () => handleExtractVoiceDataMessage(message, sender)
      : message?.type === "extract-clip-data"
        ? () => handleExtractClipDataMessage(message, sender)
        : message?.type === "download-voice"
          ? () => handleDownloadVoiceMessage(message)
          : message?.type === "download-clip"
            ? () => handleDownloadClipMessage(message)
            : null;

  if (!handler) {
    return false;
  }

  handler()
    .then((response) => {
      sendResponse(response);
    })
    .catch((err) => {
      error("Runtime message handler failed.", err);
      sendResponse({ ok: false, error: err.message || "Unknown extension error." });
    });

  return true;
});
