import { defineConfig } from '@playwright/test';

export default defineConfig({
    testMatch: 'frontend/CorePromptHandoff.real.e2e.js',
    use: {
        baseURL: process.env.ST_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8000',
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
    },
    workers: 1,
    fullyParallel: false,
});
