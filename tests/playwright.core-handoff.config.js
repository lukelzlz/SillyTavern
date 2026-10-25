import { defineConfig } from '@playwright/test';

export default defineConfig({
    testMatch: 'frontend/CorePromptHandoff.real.e2e.js',
    timeout: 60000,
    use: {
        channel: 'chromium',
        headless: true,
        actionTimeout: 10000,
        trace: 'retain-on-failure',
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
    },
    workers: 1,
    fullyParallel: false,
});
