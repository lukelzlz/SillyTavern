import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import storage from 'node-persist';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

/**
 * Find an available ephemeral TCP port on 127.0.0.1
 * @returns {Promise<number>}
 */
export async function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close((err) => {
                if (err) return reject(err);
                resolve(port);
            });
        });
    });
}

/**
 * Spawns a real SillyTavern server.js instance in an isolated sandbox.
 */
export class CoreAuthServerFixture {
    constructor() {
        this.tempDir = null;
        this.configPath = null;
        this.dataRoot = null;
        this.port = null;
        this.baseUrl = null;
        this.wsUrl = null;
        this.child = null;
    }

    /**
     * Initializes temporary config & data sandbox and starts real server.js process.
     * @param {object} [options]
     * @param {boolean} [options.enableUserAccounts=true]
     * @param {boolean} [options.disableCsrf=false]
     * @param {boolean} [options.browserHandoff=false] Enable isolated browser handoff tests with default UI content.
     * @returns {Promise<CoreAuthServerFixture>}
     */
    async start({ enableUserAccounts = true, disableCsrf = false, browserHandoff = false } = {}) {
        this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-core-auth-subproc-'));
        this.configPath = path.join(this.tempDir, 'config.yaml');
        this.dataRoot = path.join(this.tempDir, 'data');
        fs.mkdirSync(this.dataRoot, { recursive: true });

        // Copy default config and apply test sandbox settings
        const defaultConfigPath = path.join(projectRoot, 'default/config.yaml');
        let configContent = fs.readFileSync(defaultConfigPath, 'utf8');
        if (enableUserAccounts) {
            configContent = configContent.replace(/enableUserAccounts:\s*false/, 'enableUserAccounts: true');
        }
        // Speed up startup in tests by skipping unnecessary content copy
        if (!browserHandoff) {
            configContent = configContent.replace(/skipContentCheck:\s*false/, 'skipContentCheck: true');
        } else {
            configContent = configContent.replace(/browserPromptHandoffEnabled:\s*false/, 'browserPromptHandoffEnabled: true');
            configContent = configContent.replace(/pluginInterceptionEnabled:\s*false/, 'pluginInterceptionEnabled: true');
        }

        // Configure Core transport settings according to PROPOSAL-002
        if (/core:\s*\n\s*transport:/.test(configContent)) {
            configContent = configContent.replace(/(core:\s*\n\s*transport:\s*\n[\s\S]*?enabled:\s*)(false|true)/, '$1true');
            configContent = configContent.replace(/(ticketTtlSeconds:\s*)\d+/, '$12');
            configContent = configContent.replace(/(maxConnectionsPerUser:\s*)\d+/, '$15');
        } else {
            configContent += `
core:
  transport:
    enabled: true
    ticketTtlSeconds: 2
    maxConnectionsPerUser: 5
    maxTotalConnections: 100
    rateLimitPoints: 10
    trustedOrigins: []
`;
        }
        fs.writeFileSync(this.configPath, configContent, 'utf8');

        this.port = await getFreePort();
        this.baseUrl = `http://127.0.0.1:${this.port}`;
        this.wsUrl = `ws://127.0.0.1:${this.port}`;

        const cliArgs = [
            'server.js',
            '--configPath', this.configPath,
            '--dataRoot', this.dataRoot,
            '--port', String(this.port),
            '--browserLaunchEnabled', 'false',
            '--listen', 'false',
            '--disableCsrf', String(disableCsrf),
            '--whitelist', 'false',
        ];

        return new Promise((resolve, reject) => {
            let startupFinished = false;
            let stdoutAccum = '';
            let stderrAccum = '';

            const timeoutTimer = setTimeout(() => {
                if (!startupFinished) {
                    startupFinished = true;
                    this.stop().catch(() => {});
                    reject(new Error(`Server startup timed out after 60s. Output:\nSTDOUT:\n${stdoutAccum}\nSTDERR:\n${stderrAccum}`));
                }
            }, 60000);

            this.child = spawn(process.execPath, cliArgs, {
                cwd: projectRoot,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    NODE_ENV: 'test',
                },
            });

            this.child.stdout.on('data', (chunk) => {
                const text = chunk.toString();
                stdoutAccum += text;
                if (!startupFinished && (text.includes('SillyTavern is listening') || stdoutAccum.includes('SillyTavern is listening'))) {
                    startupFinished = true;
                    clearTimeout(timeoutTimer);
                    resolve(this);
                }
            });

            this.child.stderr.on('data', (chunk) => {
                stderrAccum += chunk.toString();
            });

            this.child.on('error', (err) => {
                if (!startupFinished) {
                    startupFinished = true;
                    clearTimeout(timeoutTimer);
                    reject(err);
                }
            });

            this.child.on('exit', (code, signal) => {
                if (!startupFinished) {
                    startupFinished = true;
                    clearTimeout(timeoutTimer);
                    reject(new Error(`Server child process exited prematurely with code ${code} / ${signal}.\nSTDOUT:\n${stdoutAccum}\nSTDERR:\n${stderrAccum}`));
                }
            });
        });
    }

    /**
     * Seeds a user directly into the isolated sandbox storage.
     * @param {object} user
     * @param {string} user.handle
     * @param {string} user.name
     * @param {string} user.password
     * @param {boolean} [user.admin=false]
     */
    async seedUser({ handle, name, password, admin = false }) {
        const crypto = await import('node:crypto');
        const userStorage = storage.create({
            dir: path.join(this.dataRoot, '_storage'),
            ttl: false,
            expiredInterval: 0,
        });
        await userStorage.init();

        const salt = crypto.randomBytes(16).toString('base64');
        const hashedPassword = crypto.scryptSync(password.normalize(), salt, 64).toString('base64');
        const userData = {
            handle,
            name: name || handle,
            password: hashedPassword,
            salt,
            admin,
            enabled: true,
            created: Date.now(),
        };

        await userStorage.setItem(`user:${handle}`, userData);
    }

    /**
     * Helper to extract and join cookies from response
     * @param {Response} res
     * @param {string} [prevCookie='']
     * @returns {string}
     */
    extractCookies(res, prevCookie = '') {
        const setCookies = typeof res.headers.getSetCookie === 'function'
            ? res.headers.getSetCookie()
            : [res.headers.get('set-cookie')].filter(Boolean);

        if (!setCookies.length) return prevCookie;

        const cookieMap = new Map();
        if (prevCookie) {
            for (const part of prevCookie.split('; ')) {
                const idx = part.indexOf('=');
                if (idx !== -1) {
                    const k = part.slice(0, idx);
                    const v = part.slice(idx + 1);
                    cookieMap.set(k, v);
                }
            }
        }
        for (const item of setCookies) {
            const firstPart = item.split(';')[0];
            const idx = firstPart.indexOf('=');
            if (idx !== -1) {
                const k = firstPart.slice(0, idx);
                const v = firstPart.slice(idx + 1);
                cookieMap.set(k, v);
            }
        }
        return Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    /**
     * Obtains CSRF token and session cookies
     * @param {string} [existingCookies='']
     * @returns {Promise<{ csrfToken: string, cookie: string }>}
     */
    async getSessionContext(existingCookies = '') {
        const headers = {};
        if (existingCookies) {
            headers.cookie = existingCookies;
        }
        const res = await fetch(`${this.baseUrl}/csrf-token`, { headers });
        const mergedCookie = this.extractCookies(res, existingCookies);
        const data = await res.json();
        return {
            csrfToken: data.token,
            cookie: mergedCookie,
        };
    }

    /**
     * Executes real login flow against server.js
     * @param {string} handle
     * @param {string} password
     * @returns {Promise<{ status: number, cookie: string, csrfToken: string }>}
     */
    async login(handle, password) {
        const ctx = await this.getSessionContext();
        const res = await fetch(`${this.baseUrl}/api/users/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': ctx.csrfToken,
                cookie: ctx.cookie,
            },
            body: JSON.stringify({ handle, password }),
        });
        const loginCookie = this.extractCookies(res, ctx.cookie);
        return {
            status: res.status,
            cookie: loginCookie,
            csrfToken: ctx.csrfToken,
        };
    }

    /**
     * Helper to request an authenticated ticket from POST /api/core/auth/ticket
     * @param {string} [cookie]
     * @param {string} [csrfToken]
     * @returns {Promise<Response>}
     */
    async requestTicket(cookie, csrfToken) {
        const headers = { 'Content-Type': 'application/json' };
        if (csrfToken !== undefined) {
            headers['x-csrf-token'] = csrfToken;
        }
        if (cookie !== undefined) {
            headers.cookie = cookie;
        }
        return fetch(`${this.baseUrl}/api/core/auth/ticket`, {
            method: 'POST',
            headers,
        });
    }

    /**
     * Helper to initiate a WebSocket upgrade connection to /api/bridge/ws
     * @param {object} [options]
     * @param {string} [options.ticket]
     * @param {string|string[]} [options.protocols]
     * @param {string} [options.origin]
     * @param {string} [options.query]
     * @param {Record<string, string>} [options.headers]
     * @param {number} [options.timeout=5000]
     * @returns {Promise<{ ws: import('ws').WebSocket | null, status: number, protocol: string | null, error: Error | null, handshake?: Promise<any> }>}
     */
    async connectWs({ ticket, protocols, origin, query, headers = {}, timeout = 5000 } = {}) {
        const WebSocketModule = (await import('ws')).default;
        const url = `${this.wsUrl}/api/bridge/ws${query ? `?${query}` : ''}`;

        let subprotocols;
        if (protocols !== undefined) {
            subprotocols = protocols;
        } else if (ticket !== undefined) {
            subprotocols = ['st-core.v1', `ticket.${ticket}`];
        }

        const reqHeaders = { ...headers };
        if (origin !== undefined) {
            if (origin !== null) {
                reqHeaders.Origin = origin;
            }
        }

        return new Promise((resolve) => {
            let settled = false;
            let timer = null;

            const cleanup = () => {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
            };

            timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    try {
                        ws?.terminate();
                    } catch (e) {
                        // Ignore termination error
                    }
                    resolve({
                        ws: null,
                        status: 0,
                        protocol: null,
                        error: new Error(`WebSocket connection timed out after ${timeout}ms`),
                    });
                }
            }, timeout);

            let ws;
            try {
                ws = new WebSocketModule(url, subprotocols, { headers: reqHeaders });
            } catch (err) {
                cleanup();
                return resolve({ ws: null, status: 0, protocol: null, error: err });
            }

            ws.on('unexpected-response', (req, res) => {
                if (!settled) {
                    settled = true;
                    cleanup();
                    resolve({
                        ws: null,
                        status: res.statusCode,
                        protocol: null,
                        error: null,
                    });
                }
            });

            ws.on('open', () => {
                if (!settled) {
                    settled = true;
                    cleanup();
                    // Listen before returning: ws can emit the first frame in the same turn as open.
                    const handshake = waitForWsMessage(ws, 2000);
                    // Some callers only test the upgrade or revocation, not the handshake.
                    handshake.catch(() => {});
                    resolve({
                        ws,
                        status: 101,
                        protocol: ws.protocol,
                        error: null,
                        handshake,
                    });
                }
            });

            ws.on('error', (err) => {
                if (!settled) {
                    settled = true;
                    cleanup();
                    resolve({
                        ws: null,
                        status: 0,
                        protocol: null,
                        error: err,
                    });
                }
            });
        });
    }

    /**
     * Admin disables a user account via POST /api/users/disable
     * @param {{ cookie: string }} adminAuth
     * @param {string} handle
     * @returns {Promise<Response>}
     */
    async disableUser(adminAuth, handle) {
        const ctx = await this.getSessionContext(adminAuth.cookie);
        return fetch(`${this.baseUrl}/api/users/disable`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': ctx.csrfToken,
                cookie: adminAuth.cookie,
            },
            body: JSON.stringify({ handle }),
        });
    }

    /**
     * Stops the real server.js child process and removes all temporary files.
     */
    async stop() {
        if (this.child) {
            const childRef = this.child;
            this.child = null;
            await new Promise((resolve) => {
                let exited = false;
                const forceTimer = setTimeout(() => {
                    if (!exited) {
                        try {
                            childRef.kill('SIGKILL');
                        } catch {
                            // Process might have already exited
                        }
                        resolve();
                    }
                }, 3000);

                childRef.on('exit', () => {
                    exited = true;
                    clearTimeout(forceTimer);
                    resolve();
                });

                try {
                    childRef.kill('SIGTERM');
                } catch {
                    exited = true;
                    clearTimeout(forceTimer);
                    resolve();
                }
            });
        }

        if (this.tempDir) {
            try {
                fs.rmSync(this.tempDir, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors
            }
            this.tempDir = null;
        }
    }
}

/**
 * Waits for a message on a WebSocket connection
 * @param {import('ws').WebSocket} ws
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<any>}
 */
export function waitForWsMessage(ws, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms`));
        }, timeoutMs);

        ws.once('message', (data) => {
            clearTimeout(timer);
            try {
                resolve(JSON.parse(data.toString()));
            } catch {
                resolve(data.toString());
            }
        });
        ws.once('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        ws.once('close', (code) => {
            clearTimeout(timer);
            reject(new Error(`WebSocket closed (code: ${code}) before message received`));
        });
    });
}

/**
 * Waits for WebSocket connection to close (for logout/revocation assertions)
 * @param {import('ws').WebSocket} ws
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<{ code: number, reason: string }>}
 */
export function waitForWsClose(ws, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        if (!ws || ws.readyState === 2 || ws.readyState === 3) {
            return resolve({ code: ws?.closeCode ?? 1000, reason: ws?.closeReason ?? '' });
        }
        const timer = setTimeout(() => {
            reject(new Error(`WebSocket did not close within ${timeoutMs}ms (current readyState: ${ws.readyState})`));
        }, timeoutMs);

        ws.once('close', (code, reason) => {
            clearTimeout(timer);
            resolve({ code, reason: reason ? reason.toString() : '' });
        });
        ws.once('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
