(function () {
  if (globalThis.VKVD?.bootstrapContentModules) {
    return;
  }

  const DEBUG = false;
  const LOG_PREFIX = "[VK Voice & Clips Downloader]";
  const STORAGE_KEY = "enabled";
  const ICON_URL = chrome.runtime.getURL("assets/ui/download-icon.svg");

  const moduleFactories = [];
  let activeModules = [];
  let extensionEnabled = true;
  let started = false;
  let bootstrapped = false;
  let settingsInitialized = false;

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

  function findNodes(root = document, selector) {
    const nodes = [];

    if (!root || !selector) {
      return nodes;
    }

    try {
      if (root.nodeType === Node.ELEMENT_NODE && root.matches?.(selector)) {
        nodes.push(root);
      }

      if (root.querySelectorAll) {
        nodes.push(...root.querySelectorAll(selector));
      }
    } catch (err) {
      error(`Failed to query nodes for selector "${selector}".`, err);
    }

    return nodes;
  }

  function collectNodes(root = document, selector) {
    const nodes = new Set(findNodes(root, selector));

    if (root instanceof Element) {
      const closestNode = root.closest(selector);

      if (closestNode) {
        nodes.add(closestNode);
      }
    }

    return [...nodes];
  }

  function removeNodes(selector) {
    for (const node of document.querySelectorAll(selector)) {
      node.remove();
    }
  }

  function sanitizeFilePart(value) {
    return String(value ?? "")
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "");
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

  function inferFileExtension(url, fallbackExtension) {
    try {
      const parsedUrl = new URL(url, window.location.href);
      const extensionMatch = parsedUrl.pathname.match(/\.([a-z0-9]{2,5})$/i);

      if (extensionMatch) {
        return extensionMatch[1].toLowerCase();
      }
    } catch (err) {
      warn("Failed to infer file extension from URL.", err);
    }

    return fallbackExtension;
  }

  function createNodeToken(prefix = "vkvd") {
    if (crypto?.randomUUID) {
      return crypto.randomUUID().replace(/[^a-zA-Z0-9_-]/g, "");
    }

    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function markNode(node, attributeName) {
    const existingToken = node?.getAttribute(attributeName);

    if (existingToken) {
      return existingToken;
    }

    const token = createNodeToken();
    node?.setAttribute(attributeName, token);
    return token;
  }

  function unmarkNode(node, attributeName, token) {
    if (node?.getAttribute(attributeName) === token) {
      node.removeAttribute(attributeName);
    }
  }

  function setButtonBusy(button, isBusy) {
    if (!button) {
      return;
    }

    button.disabled = isBusy;
    button.classList.toggle("vkvd-download-button--busy", isBusy);
  }

  function createDownloadIcon(size = 18) {
    const icon = document.createElement("img");
    icon.className = "vkvd-download-button__icon";
    icon.src = ICON_URL;
    icon.alt = "";
    icon.width = size;
    icon.height = size;
    icon.decoding = "async";
    return icon;
  }

  function applyEnabledState(nextState) {
    extensionEnabled = Boolean(nextState);

    for (const module of activeModules) {
      try {
        module.applyEnabledState?.(extensionEnabled);
      } catch (err) {
        error(`Module "${module.id || "unknown"}" failed to apply enabled state.`, err);
      }
    }
  }

  function initializeSettings() {
    if (settingsInitialized) {
      return;
    }

    settingsInitialized = true;

    chrome.storage.local.get({ [STORAGE_KEY]: true }, (items) => {
      if (chrome.runtime.lastError) {
        error("Failed to read extension settings.", chrome.runtime.lastError.message);
        applyEnabledState(true);
        return;
      }

      applyEnabledState(items[STORAGE_KEY] !== false);
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes[STORAGE_KEY]) {
        applyEnabledState(changes[STORAGE_KEY].newValue !== false);
      }
    });
  }

  function start() {
    if (started) {
      return;
    }

    started = true;

    activeModules = moduleFactories
      .map((factory) => {
        try {
          return factory(shared);
        } catch (err) {
          error("Failed to initialize content module.", err);
          return null;
        }
      })
      .filter(Boolean);

    for (const module of activeModules) {
      try {
        module.start?.();
      } catch (err) {
        error(`Module "${module.id || "unknown"}" failed to start.`, err);
      }
    }

    initializeSettings();
  }

  const shared = {
    constants: {
      DEBUG,
      LOG_PREFIX,
      STORAGE_KEY,
      ICON_URL
    },
    debug,
    warn,
    error,
    requestRuntime,
    findNodes,
    collectNodes,
    removeNodes,
    sanitizeFilePart,
    formatTimestamp,
    inferFileExtension,
    createNodeToken,
    markNode,
    unmarkNode,
    setButtonBusy,
    createDownloadIcon,
    isEnabled: () => extensionEnabled
  };

  globalThis.VKVD = {
    shared,
    registerContentModule(factory) {
      if (typeof factory !== "function") {
        warn("Ignored invalid content module registration.");
        return;
      }

      if (started) {
        warn("Ignored late content module registration.");
        return;
      }

      moduleFactories.push(factory);
    },
    bootstrapContentModules() {
      if (bootstrapped) {
        return;
      }

      bootstrapped = true;

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
      } else {
        start();
      }
    }
  };
})();
