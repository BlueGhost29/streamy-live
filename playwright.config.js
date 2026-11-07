// playwright.config.js
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 45000,
  retries: 0,
  workers: 1, // Sequential execution for predictable WebRTC and port management
  use: {
    baseURL: 'http://127.0.0.1:4000',
    headless: true,
    channel: 'chrome',
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies'
      ]
    }
  },
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:4000',
    reuseExistingServer: true,
    timeout: 15000
  }
});
