(function () {
  const DEBUG = false;
  const LOG_PREFIX = "[VK Voice Downloader]";
  const STORAGE_KEY = "enabled";
  const ICON_URL = chrome.runtime.getURL("assets/ui/download-icon.svg");

  const SELECTORS = {
    voiceMessage: ".AttachVoice",
    player: ".AttachVoice__player",
    button: ".vkvd-download-button"
  };

  const ATTRIBUTES = {
    nodeToken: "data-vkvd-token"
  };

  let extensionEnabled = true;
  let voiceObserver = null;

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

  function requestRuntime(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(response);
      });
    });
  }

  function findVoiceNodes(root = document) {
    const nodes = [];

    if (!root) {
      return nodes;
    }

    try {
      if (root.nodeType === Node.ELEMENT_NODE && root.matches?.(SELECTORS.voiceMessage)) {
        nodes.push(root);
      }

      if (root.querySelectorAll) {
        nodes.push(...root.querySelectorAll(SELECTORS.voiceMessage));
      }
    } catch (err) {
      error("Failed to query voice message nodes.", err);
    }

    return nodes;
  }

  function collectVoiceNodes(root = document) {
    const nodes = new Set(findVoiceNodes(root));

    if (root instanceof Element) {
      const closestVoiceNode = root.closest(SELECTORS.voiceMessage);

      if (closestVoiceNode) {
        nodes.add(closestVoiceNode);
      }
    }

    return [...nodes];
  }

  function sanitizeFilePart(value) {
    return String(value ?? "")
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "");
  }

  function inferFileExtension(url, sourceType) {
    try {
      const parsedUrl = new URL(url, window.location.href);
      const extensionMatch = parsedUrl.pathname.match(/\.([a-z0-9]{2,5})$/i);

      if (extensionMatch) {
        return extensionMatch[1].toLowerCase();
      }
    } catch (err) {
      warn("Failed to infer file extension from URL.", err);
    }

    return sourceType === "linkMp3" ? "mp3" : "ogg";
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

  function buildDownloadFilename(voiceData) {
    const meta = voiceData?.meta || {};
    const extension = inferFileExtension(voiceData?.url, voiceData?.sourceType);
    const primaryParts = [meta.peerId, meta.cmid, meta.voiceId]
      .map(sanitizeFilePart)
      .filter(Boolean);

    if (primaryParts.length > 0) {
      return `vk-voice-${primaryParts.join("-")}.${extension}`;
    }

    const fallbackParts = [meta.authorId, meta.ownerId]
      .map(sanitizeFilePart)
      .filter(Boolean);

    if (fallbackParts.length > 0) {
      return `vk-voice-${fallbackParts.join("-")}.${extension}`;
    }

    return `vk-voice-${formatTimestamp(new Date())}.${extension}`;
  }

  function createNodeToken() {
    if (crypto?.randomUUID) {
      return crypto.randomUUID().replace(/[^a-zA-Z0-9_-]/g, "");
    }

    return `vkvd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function markVoiceNode(node) {
    const existingToken = node.getAttribute(ATTRIBUTES.nodeToken);

    if (existingToken) {
      return existingToken;
    }

    const token = createNodeToken();
    node.setAttribute(ATTRIBUTES.nodeToken, token);
    return token;
  }

  function unmarkVoiceNode(node, token) {
    if (node?.getAttribute(ATTRIBUTES.nodeToken) === token) {
      node.removeAttribute(ATTRIBUTES.nodeToken);
    }
  }

  async function extractVoiceData(node) {
    if (!node) {
      return null;
    }

    const token = markVoiceNode(node);

    try {
      // React internals are not reliably visible from the isolated content-script world,
      // so the actual extraction runs in the page's MAIN world via the service worker.
      const response = await requestRuntime({
        type: "extract-voice-data",
        token
      });

      if (!response?.ok) {
        warn("Voice extraction failed.", response?.error || "Unknown error");
        return null;
      }

      return response.data || null;
    } catch (err) {
      error("Failed to request voice extraction.", err);
      return null;
    } finally {
      unmarkVoiceNode(node, token);
    }
  }

  function setButtonBusy(button, isBusy) {
    if (!button) {
      return;
    }

    button.disabled = isBusy;
    button.classList.toggle("vkvd-download-button--busy", isBusy);
  }

  function createDownloadButton(node) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vkvd-download-button";
    button.title = "Скачать голосовое сообщение";
    button.setAttribute("aria-label", "Скачать голосовое сообщение");

    const icon = document.createElement("img");
    icon.className = "vkvd-download-button__icon";
    icon.src = ICON_URL;
    icon.alt = "";
    icon.width = 18;
    icon.height = 18;
    icon.decoding = "async";
    button.appendChild(icon);

    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      setButtonBusy(button, true);

      try {
        const voiceData = await extractVoiceData(node);

        if (!voiceData?.url) {
          warn("Voice data could not be resolved for the selected node.", node);
          return;
        }

        const response = await requestRuntime({
          type: "download-voice",
          data: {
            url: voiceData.url,
            filename: buildDownloadFilename(voiceData),
            meta: voiceData.meta,
            sourceType: voiceData.sourceType
          }
        });

        if (!response?.ok) {
          warn("Download request was rejected.", response?.error || "Unknown error");
          return;
        }

        debug("Download started.", response.downloadId);
      } catch (err) {
        error("Voice download flow failed.", err);
      } finally {
        setButtonBusy(button, false);
      }
    });

    return button;
  }

  function injectDownloadButton(node) {
    if (!extensionEnabled || !node || node.querySelector(SELECTORS.button)) {
      return;
    }

    const playerElement = node.querySelector(SELECTORS.player);

    if (!playerElement) {
      return;
    }

    playerElement.appendChild(createDownloadButton(node));
  }

  function processVoiceNodes(root = document) {
    for (const node of collectVoiceNodes(root)) {
      injectDownloadButton(node);
    }
  }

  function removeInjectedButtons() {
    for (const button of document.querySelectorAll(SELECTORS.button)) {
      button.remove();
    }
  }

  function observeVoiceMessages() {
    if (voiceObserver || !document.body) {
      return;
    }

    voiceObserver = new MutationObserver((mutations) => {
      if (!extensionEnabled) {
        return;
      }

      for (const mutation of mutations) {
        for (const addedNode of mutation.addedNodes) {
          if (!(addedNode instanceof Element)) {
            continue;
          }

          processVoiceNodes(addedNode);
        }
      }
    });

    voiceObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function applyEnabledState(nextState) {
    extensionEnabled = Boolean(nextState);

    if (extensionEnabled) {
      processVoiceNodes(document);
      return;
    }

    removeInjectedButtons();
  }

  function initializeSettings(onReady) {
    chrome.storage.local.get({ [STORAGE_KEY]: true }, (items) => {
      if (chrome.runtime.lastError) {
        error("Failed to read extension settings.", chrome.runtime.lastError.message);
        applyEnabledState(true);
      } else {
        applyEnabledState(items[STORAGE_KEY] !== false);
      }

      if (typeof onReady === "function") {
        onReady();
      }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes[STORAGE_KEY]) {
        applyEnabledState(changes[STORAGE_KEY].newValue !== false);
      }
    });
  }

  function start() {
    initializeSettings(() => {
      observeVoiceMessages();
      processVoiceNodes(document);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
