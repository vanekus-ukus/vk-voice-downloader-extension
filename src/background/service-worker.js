const DEBUG = false;
const LOG_PREFIX = "[VK Voice Downloader]";
const STORAGE_KEY = "enabled";

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

function inferFallbackExtension(data) {
  return data?.sourceType === "linkMp3" ? "mp3" : "ogg";
}

function sanitizeDownloadFilename(filename, extension) {
  const normalized = String(filename || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");

  if (normalized) {
    return normalized;
  }

  return `vk-voice-${formatTimestamp(new Date())}.${extension}`;
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
  const NODE_TOKEN_ATTR = "data-vkvd-token";
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

function executeMainWorldExtraction(tabId, token) {
  return new Promise((resolve, reject) => {
    if (!tabId) {
      reject(new Error("Tab ID is missing."));
      return;
    }

    if (!token) {
      reject(new Error("Voice node token is missing."));
      return;
    }

    chrome.scripting.executeScript(
      {
        target: { tabId },
        world: "MAIN",
        func: extractVoiceDataInMainWorld,
        args: [token]
      },
      (results) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        const result = results?.[0]?.result;

        if (!result?.ok) {
          reject(new Error(result?.error || "Voice extraction failed."));
          return;
        }

        resolve(result.data);
      }
    );
  });
}

function downloadVoiceFile(data) {
  return new Promise((resolve, reject) => {
    if (!data?.url || !isAllowedDownloadUrl(data.url)) {
      reject(new Error("Voice URL is missing or invalid."));
      return;
    }

    const extension = inferFallbackExtension(data);
    const filename = sanitizeDownloadFilename(data.filename, extension);

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

async function handleExtractVoiceDataMessage(message, sender) {
  const data = await executeMainWorldExtraction(sender.tab?.id, message.token);
  return { ok: true, data };
}

async function handleDownloadVoiceMessage(message) {
  const downloadId = await downloadVoiceFile(message.data);
  debug("Download started.", downloadId);
  return { ok: true, downloadId };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(STORAGE_KEY, (items) => {
    if (chrome.runtime.lastError) {
      error("Failed to initialize default settings.", chrome.runtime.lastError.message);
      return;
    }

    if (typeof items[STORAGE_KEY] === "undefined") {
      chrome.storage.local.set({ [STORAGE_KEY]: true }, () => {
        if (chrome.runtime.lastError) {
          warn("Failed to persist default settings.", chrome.runtime.lastError.message);
        }
      });
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler =
    message?.type === "extract-voice-data"
      ? () => handleExtractVoiceDataMessage(message, sender)
      : message?.type === "download-voice"
        ? () => handleDownloadVoiceMessage(message)
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
