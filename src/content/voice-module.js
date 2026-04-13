(function () {
  const runtime = globalThis.VKVD;

  if (!runtime?.registerContentModule || !runtime.shared) {
    return;
  }

  runtime.registerContentModule((shared) => {
    const SELECTORS = {
      voiceMessage: ".AttachVoice",
      player: ".AttachVoice__player",
      button: ".vkvd-download-button--voice"
    };

    const ATTRIBUTES = {
      token: "data-vkvd-voice-token"
    };

    let voiceObserver = null;

    function findVoiceNodes(root = document) {
      return shared.findNodes(root, SELECTORS.voiceMessage);
    }

    function collectVoiceNodes(root = document) {
      return shared.collectNodes(root, SELECTORS.voiceMessage);
    }

    function buildVoiceFilename(voiceData) {
      const meta = voiceData?.meta || {};
      const extension = shared.inferFileExtension(
        voiceData?.url,
        voiceData?.sourceType === "linkMp3" ? "mp3" : "ogg"
      );
      const primaryParts = [meta.peerId, meta.cmid, meta.voiceId]
        .map(shared.sanitizeFilePart)
        .filter(Boolean);

      if (primaryParts.length > 0) {
        return `vk-voice-${primaryParts.join("-")}.${extension}`;
      }

      const fallbackParts = [meta.authorId, meta.ownerId]
        .map(shared.sanitizeFilePart)
        .filter(Boolean);

      if (fallbackParts.length > 0) {
        return `vk-voice-${fallbackParts.join("-")}.${extension}`;
      }

      return `vk-voice-${shared.formatTimestamp(new Date())}.${extension}`;
    }

    async function extractVoiceData(node) {
      if (!node) {
        return null;
      }

      const token = shared.markNode(node, ATTRIBUTES.token);

      try {
        const response = await shared.requestRuntime({
          type: "extract-voice-data",
          token
        });

        if (!response?.ok) {
          shared.warn("Voice extraction failed.", response?.error || "Unknown error");
          return null;
        }

        return response.data || null;
      } catch (err) {
        shared.error("Failed to request voice extraction.", err);
        return null;
      } finally {
        shared.unmarkNode(node, ATTRIBUTES.token, token);
      }
    }

    function createVoiceDownloadButton(node) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "vkvd-download-button vkvd-download-button--voice";
      button.title = "Скачать голосовое сообщение";
      button.setAttribute("aria-label", "Скачать голосовое сообщение");
      button.appendChild(shared.createDownloadIcon());

      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();

        shared.setButtonBusy(button, true);

        try {
          const voiceData = await extractVoiceData(node);

          if (!voiceData?.url) {
            shared.warn("Voice data could not be resolved for the selected node.", node);
            return;
          }

          const response = await shared.requestRuntime({
            type: "download-voice",
            data: {
              url: voiceData.url,
              filename: buildVoiceFilename(voiceData),
              meta: voiceData.meta,
              sourceType: voiceData.sourceType
            }
          });

          if (!response?.ok) {
            shared.warn("Voice download request was rejected.", response?.error || "Unknown error");
            return;
          }

          shared.debug("Voice download started.", response.downloadId);
        } catch (err) {
          shared.error("Voice download flow failed.", err);
        } finally {
          shared.setButtonBusy(button, false);
        }
      });

      return button;
    }

    function injectDownloadButton(node) {
      if (!shared.isEnabled() || !node || node.querySelector(SELECTORS.button)) {
        return;
      }

      const playerElement = node.querySelector(SELECTORS.player);

      if (!playerElement) {
        return;
      }

      playerElement.appendChild(createVoiceDownloadButton(node));
    }

    function processVoiceNodes(root = document) {
      for (const node of collectVoiceNodes(root)) {
        injectDownloadButton(node);
      }
    }

    function removeInjectedButtons() {
      shared.removeNodes(SELECTORS.button);
    }

    function observeVoiceMessages() {
      if (voiceObserver || !document.body) {
        return;
      }

      voiceObserver = new MutationObserver((mutations) => {
        if (!shared.isEnabled()) {
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

    return {
      id: "voice",
      start() {
        observeVoiceMessages();

        if (shared.isEnabled()) {
          processVoiceNodes(document);
        }
      },
      applyEnabledState(enabled) {
        if (enabled) {
          processVoiceNodes(document);
          return;
        }

        removeInjectedButtons();
      }
    };
  });
})();
