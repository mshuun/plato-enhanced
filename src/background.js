'use strict';
importScripts('nespa-settings.js', 'nespa-migration.js', 'schedule-background.js', 'nespa-background.js');
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  PlatoCalendarExt.cleanupLegacyNespa().catch(() => {});
});
