(function initNespaMigration(global) {
  'use strict';
  const ns = global.PlatoCalendarExt;
  ns.cleanupLegacyNespa = async function cleanupLegacyNespa() {
    const api = ns.nespaSettings;
    const stored = (await chrome.storage.local.get(api.KEY))[api.KEY];
    if (stored && Object.prototype.hasOwnProperty.call(stored, 'autoLogin')) {
      // Re-read under the same write lock as options pages; do not restore a stale snapshot.
      await api.save({});
    }
    await chrome.storage.local.remove(['platoEnhanced.nespa.authState', 'platoEnhanced.nespa.epoch']);
    await chrome.storage.session.remove(['platoEnhanced.nespa.authJob', 'platoEnhanced.nespa.authAttempts', 'platoEnhanced.nespa.loginVisits']);
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('platoEnhancedNespaSecrets');
      request.onsuccess = resolve;
      request.onerror = request.onblocked = () => reject(new Error('이전 NESPA 계정 저장소를 정리하지 못했습니다.'));
    });
  };
})(globalThis);
