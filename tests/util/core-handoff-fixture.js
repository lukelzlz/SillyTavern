import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import { CoreAuthServerFixture } from './core-auth-fixture.js';

// No existing server, user data directory, browser profile, or fixed port is reused.
export const test = base.extend({
    // Playwright requires destructured parameters even for a fixture without dependencies.
    // eslint-disable-next-line no-empty-pattern
    handoff: [async ({}, use) => {
        const server = new CoreAuthServerFixture();
        const provider = fork(fileURLToPath(new URL('./core-handoff-provider.js', import.meta.url)), [], {
            env: { ...process.env, ST_CORE_PROVIDER_PORT: '0' },
            stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
        try {
            const port = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Provider startup timed out')), 10000);
                provider.once('message', message => { clearTimeout(timer); resolve(message.port); });
                provider.once('error', error => { clearTimeout(timer); reject(error); });
                provider.once('exit', code => { clearTimeout(timer); reject(new Error(`Provider exited: ${code}`)); });
            });
            await server.start({ enableUserAccounts: false, browserHandoff: true });
            await use({ baseUrl: server.baseUrl, providerUrl: `http://127.0.0.1:${port}` });
        } finally {
            try {
                await server.stop();
            } finally {
                if (provider.exitCode === null && provider.signalCode === null) {
                    await new Promise(resolve => {
                        const timer = setTimeout(() => provider.kill('SIGKILL'), 3000);
                        provider.once('exit', () => { clearTimeout(timer); resolve(); });
                        provider.kill('SIGTERM');
                    });
                }
            }
        }
    }, { scope: 'worker', timeout: 90000 }],
    baseURL: async ({ handoff }, use) => use(handoff.baseUrl),
});

export { expect };
