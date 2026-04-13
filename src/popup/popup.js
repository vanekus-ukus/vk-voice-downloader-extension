const STORAGE_KEYS = {
  legacyEnabled: "enabled",
  voiceEnabled: "enabledVoice",
  clipsEnabled: "enabledClips"
};
const LOG_PREFIX = "[VK Voice & Clips Downloader]";

function getNormalizedSettings(items) {
  const legacyEnabled = items?.[STORAGE_KEYS.legacyEnabled] !== false;

  return {
    voice: typeof items?.[STORAGE_KEYS.voiceEnabled] === "boolean" ? items[STORAGE_KEYS.voiceEnabled] : legacyEnabled,
    clips: typeof items?.[STORAGE_KEYS.clipsEnabled] === "boolean" ? items[STORAGE_KEYS.clipsEnabled] : legacyEnabled
  };
}

function updateStatus(statusElement, settings) {
  if (settings.voice && settings.clips) {
    statusElement.textContent = "Голосовые и клипы включены.";
    return;
  }

  if (!settings.voice && !settings.clips) {
    statusElement.textContent = "Все кнопки скачивания выключены.";
    return;
  }

  if (settings.voice) {
    statusElement.textContent = "Включены только голосовые сообщения.";
    return;
  }

  statusElement.textContent = "Включены только VK Clips.";
}

function syncToggles(voiceToggle, clipsToggle, settings) {
  voiceToggle.checked = settings.voice;
  clipsToggle.checked = settings.clips;
}

document.addEventListener("DOMContentLoaded", () => {
  const voiceToggle = document.getElementById("voiceToggle");
  const clipsToggle = document.getElementById("clipsToggle");
  const status = document.getElementById("status");

  chrome.storage.local.get(
    {
      [STORAGE_KEYS.legacyEnabled]: true,
      [STORAGE_KEYS.voiceEnabled]: null,
      [STORAGE_KEYS.clipsEnabled]: null
    },
    (items) => {
      if (chrome.runtime.lastError) {
        status.textContent = "Не удалось прочитать настройки.";
        console.error(LOG_PREFIX, chrome.runtime.lastError.message);
        return;
      }

      const settings = getNormalizedSettings(items);
      syncToggles(voiceToggle, clipsToggle, settings);
      updateStatus(status, settings);

      const patch = {};

      if (typeof items[STORAGE_KEYS.voiceEnabled] !== "boolean") {
        patch[STORAGE_KEYS.voiceEnabled] = settings.voice;
      }

      if (typeof items[STORAGE_KEYS.clipsEnabled] !== "boolean") {
        patch[STORAGE_KEYS.clipsEnabled] = settings.clips;
      }

      if (Object.keys(patch).length > 0) {
        chrome.storage.local.set(patch, () => {
          if (chrome.runtime.lastError) {
            console.error(LOG_PREFIX, chrome.runtime.lastError.message);
          }
        });
      }
    }
  );

  function saveSetting(key, value) {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        status.textContent = "Не удалось сохранить настройки.";
        console.error(LOG_PREFIX, chrome.runtime.lastError.message);
        return;
      }

      updateStatus(status, {
        voice: voiceToggle.checked,
        clips: clipsToggle.checked
      });
    });
  }

  voiceToggle.addEventListener("change", () => {
    saveSetting(STORAGE_KEYS.voiceEnabled, voiceToggle.checked);
  });

  clipsToggle.addEventListener("change", () => {
    saveSetting(STORAGE_KEYS.clipsEnabled, clipsToggle.checked);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    const nextSettings = {
      voice: voiceToggle.checked,
      clips: clipsToggle.checked
    };

    if (changes[STORAGE_KEYS.voiceEnabled]) {
      nextSettings.voice = changes[STORAGE_KEYS.voiceEnabled].newValue !== false;
    }

    if (changes[STORAGE_KEYS.clipsEnabled]) {
      nextSettings.clips = changes[STORAGE_KEYS.clipsEnabled].newValue !== false;
    }

    if (!changes[STORAGE_KEYS.voiceEnabled] && !changes[STORAGE_KEYS.clipsEnabled] && changes[STORAGE_KEYS.legacyEnabled]) {
      const legacyEnabled = changes[STORAGE_KEYS.legacyEnabled].newValue !== false;
      nextSettings.voice = legacyEnabled;
      nextSettings.clips = legacyEnabled;
    }

    syncToggles(voiceToggle, clipsToggle, nextSettings);
    updateStatus(status, nextSettings);
  });
});
