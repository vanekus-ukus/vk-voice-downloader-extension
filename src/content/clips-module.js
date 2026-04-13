(function () {
  const runtime = globalThis.VKVD;

  if (!runtime?.registerContentModule || !runtime.shared) {
    return;
  }

  runtime.registerContentModule((shared) => {
    const SELECTORS = {
      clipItem: '[data-testid="clips-feed-item"]',
      button: '[data-vk-clip-download-button="1"]'
    };

    const ATTRIBUTES = {
      token: "data-vkvd-clip-token",
      host: "data-vkvd-clip-host"
    };

    const MP4_SOURCES = [
      { key: "mp4_480", quality: "480p", extension: "mp4" },
      { key: "mp4_360", quality: "360p", extension: "mp4" },
      { key: "mp4_240", quality: "240p", extension: "mp4" },
      { key: "mp4_144", quality: "144p", extension: "mp4" }
    ];

    const STREAM_FALLBACKS = [
      { key: "hls", quality: null, extension: "m3u8" },
      { key: "dash_sep", quality: null, extension: "mpd" }
    ];

    let clipObserver = null;

    function findClipNodes(root = document) {
      return shared.findNodes(root, SELECTORS.clipItem);
    }

    function collectClipNodes(root = document) {
      return shared.collectNodes(root, SELECTORS.clipItem);
    }

    function pickBestClipUrl(files) {
      if (!files || typeof files !== "object") {
        return null;
      }

      for (const source of MP4_SOURCES) {
        const url = files[source.key];

        if (typeof url === "string" && url.trim()) {
          return {
            url,
            quality: source.quality,
            sourceType: source.key,
            extension: source.extension,
            unsupportedStreamFallback: false
          };
        }
      }

      for (const fallback of STREAM_FALLBACKS) {
        const url = files[fallback.key];

        if (typeof url === "string" && url.trim()) {
          return {
            url,
            quality: null,
            sourceType: fallback.key,
            extension: fallback.extension,
            unsupportedStreamFallback: true
          };
        }
      }

      return null;
    }

    function inferClipExtension(clipData) {
      const pickedSource = pickBestClipUrl(clipData?.files);

      if (pickedSource?.extension) {
        return pickedSource.extension;
      }

      if (clipData?.sourceType === "hls") {
        return "m3u8";
      }

      if (clipData?.sourceType === "dash_sep") {
        return "mpd";
      }

      return shared.inferFileExtension(clipData?.url, "mp4");
    }

    function buildClipFilename(clipData) {
      const ownerId = shared.sanitizeFilePart(clipData?.ownerId);
      const videoId = shared.sanitizeFilePart(clipData?.videoId);
      const quality = shared.sanitizeFilePart(clipData?.quality);
      const extension = inferClipExtension(clipData);

      if (ownerId && videoId) {
        const suffix = quality ? `-${quality}` : clipData?.unsupportedStreamFallback ? `-${clipData.sourceType}` : "";
        return `vk-clip-${ownerId}_${videoId}${suffix}.${extension}`;
      }

      return `vk-clip-${shared.formatTimestamp(new Date())}.${extension}`;
    }

    async function extractClipData(node) {
      if (!node) {
        return null;
      }

      const token = shared.markNode(node, ATTRIBUTES.token);

      try {
        const response = await shared.requestRuntime({
          type: "extract-clip-data",
          token
        });

        if (!response?.ok) {
          shared.warn("Clip extraction failed.", response?.error || "Unknown error");
          return null;
        }

        return response.data || null;
      } catch (err) {
        shared.error("Failed to request clip extraction.", err);
        return null;
      } finally {
        shared.unmarkNode(node, ATTRIBUTES.token, token);
      }
    }

    function createClipDownloadButton(node) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "vkvd-download-button vkvd-download-button--clip";
      button.title = "Скачать клип";
      button.setAttribute("aria-label", "Скачать клип");
      button.setAttribute("data-vk-clip-download-button", "1");
      button.appendChild(shared.createDownloadIcon());

      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();

        shared.setButtonBusy(button, true);

        try {
          const clipData = await extractClipData(node);

          if (!clipData?.url) {
            shared.warn("Clip data could not be resolved for the selected node.", node);
            return;
          }

          if (clipData.unsupportedStreamFallback) {
            // Best-effort fallback: if VK only exposes HLS/DASH in React props, the extension
            // downloads that URL as-is instead of trying to remux it into MP4 in-browser.
            shared.warn("Clip resolved only to a stream fallback URL. Downloading it as-is.", clipData);
          }

          const response = await shared.requestRuntime({
            type: "download-clip",
            data: {
              url: clipData.url,
              filename: buildClipFilename(clipData),
              sourceType: clipData.sourceType,
              quality: clipData.quality,
              unsupportedStreamFallback: clipData.unsupportedStreamFallback
            }
          });

          if (!response?.ok) {
            shared.warn("Clip download request was rejected.", response?.error || "Unknown error");
            return;
          }

          shared.debug("Clip download started.", response.downloadId);
        } catch (err) {
          shared.error("Clip download flow failed.", err);
        } finally {
          shared.setButtonBusy(button, false);
        }
      });

      return button;
    }

    function injectClipDownloadButton(node) {
      if (!shared.isEnabled("clips") || !node || node.querySelector(SELECTORS.button)) {
        return;
      }

      node.setAttribute(ATTRIBUTES.host, "1");
      node.appendChild(createClipDownloadButton(node));
    }

    function processClipNodes(root = document) {
      for (const node of collectClipNodes(root)) {
        injectClipDownloadButton(node);
      }
    }

    function removeInjectedClipButtons() {
      shared.removeNodes(SELECTORS.button);

      for (const hostNode of document.querySelectorAll(`[${ATTRIBUTES.host}="1"]`)) {
        hostNode.removeAttribute(ATTRIBUTES.host);
      }
    }

    function observeClipFeed() {
      if (clipObserver || !document.body) {
        return;
      }

      clipObserver = new MutationObserver((mutations) => {
        if (!shared.isEnabled("clips")) {
          return;
        }

        for (const mutation of mutations) {
          for (const addedNode of mutation.addedNodes) {
            if (!(addedNode instanceof Element)) {
              continue;
            }

            processClipNodes(addedNode);
          }
        }
      });

      clipObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
    }

    return {
      id: "clips",
      start() {
        observeClipFeed();

        if (shared.isEnabled("clips")) {
          processClipNodes(document);
        }
      },
      applyEnabledState(enabled) {
        if (enabled) {
          processClipNodes(document);
          return;
        }

        removeInjectedClipButtons();
      }
    };
  });
})();
