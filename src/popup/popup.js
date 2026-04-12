const STORAGE_KEY = "enabled";
const LOG_PREFIX = "[VK Voice Downloader]";

function updateStatus(statusElement, enabled) {
  statusElement.textContent = enabled ? "Расширение включено." : "Расширение выключено.";
}

document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("enabledToggle");
  const status = document.getElementById("status");

  chrome.storage.local.get({ [STORAGE_KEY]: true }, (items) => {
    if (chrome.runtime.lastError) {
      status.textContent = "Не удалось прочитать настройки.";
      console.error(LOG_PREFIX, chrome.runtime.lastError.message);
      return;
    }

    const enabled = items[STORAGE_KEY] !== false;
    toggle.checked = enabled;
    updateStatus(status, enabled);
  });

  toggle.addEventListener("change", () => {
    const enabled = toggle.checked;

    chrome.storage.local.set({ [STORAGE_KEY]: enabled }, () => {
      if (chrome.runtime.lastError) {
        status.textContent = "Не удалось сохранить настройки.";
        console.error(LOG_PREFIX, chrome.runtime.lastError.message);
        return;
      }

      updateStatus(status, enabled);
    });
  });
});
