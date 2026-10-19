import WebSocket from 'ws';
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { CoreAuthServerFixture } from './util/core-auth-fixture.js';

describe('Core Authentication & Reverse Proxy Security Regression (Live Server Subprocess)', () => {
    /** @type {CoreAuthServerFixture} */
    let fixture;

    const testUsers = {
        alice: {
            handle: 'alice',
            name: 'Alice Admin',
            password: 'alice-secure-pass-123',
            admin: true,
        },
        bob: {
            handle: 'bob',
            name: 'Bob User',
            password: 'bob-secure-pass-456',
            admin: false,
        },
    };

    beforeAll(async () => {
        fixture = new CoreAuthServerFixture();
        // Start live server.js subprocess with accounts enabled, CSRF strictly enforced, browser auto-launch disabled
        await fixture.start({ enableUserAccounts: true, disableCsrf: false });

        // Seed test accounts directly into isolated subprocess sandbox data storage
        await fixture.seedUser(testUsers.alice);
        await fixture.seedUser(testUsers.bob);
    }, 90000);

    afterAll(async () => {
        if (fixture) {
            await fixture.stop();
        }
    });

    // 1. 无认证请求防护 (Unauthenticated Access Protection)
    describe('1. Unauthenticated Access Protection', () => {
        test('GET /api/users/me without cookie session returns 403 Forbidden', async () => {
            const res = await fetch(`${fixture.baseUrl}/api/users/me`);
            expect(res.status).toBe(403);
        });

        test('POST /api/core/prompt/assemble without session returns 403 Forbidden', async () => {
            const ctx = await fixture.getSessionContext();
            const res = await fetch(`${fixture.baseUrl}/api/core/prompt/assemble`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': ctx.csrfToken,
                    cookie: ctx.cookie,
                },
                body: JSON.stringify({ messages: [] }),
            });
            expect(res.status).toBe(403);
        });

        test('Core WebSocket upgrade /api/bridge/ws without credentials returns 403 Forbidden', async () => {
            const ws = new WebSocket(`${fixture.wsUrl}/api/bridge/ws`);
            const status = await new Promise((resolve) => {
                ws.on('unexpected-response', (req, res) => {
                    resolve(res.statusCode);
                });
                ws.on('error', () => resolve(null));
                ws.on('open', () => {
                    ws.close();
                    resolve(101);
                });
            });
            expect(status).toBe(403);
        });
    });

    // 2. CSRF 防护与跨站请求拦截 (CSRF Protection & Token Validation)
    describe('2. CSRF Protection (Never Disabled)', () => {
        test('State-changing POST without x-csrf-token header returns 403 Invalid CSRF token', async () => {
            const auth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            expect(auth.status).toBe(200);

            const res = await fetch(`${fixture.baseUrl}/api/core/world-info/scan`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    cookie: auth.cookie,
                    // Deliberately omit x-csrf-token
                },
                body: JSON.stringify({ text: 'attack' }),
            });
            expect(res.status).toBe(403);
        });

        test('State-changing POST with mismatched x-csrf-token returns 403 Forbidden', async () => {
            const auth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            expect(auth.status).toBe(200);

            const res = await fetch(`${fixture.baseUrl}/api/core/world-info/scan`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': 'forged-attacker-token-abc-123',
                    cookie: auth.cookie,
                },
                body: JSON.stringify({ text: 'attack' }),
            });
            expect(res.status).toBe(403);
        });

        test('State-changing POST with valid CSRF token passes to protected endpoint', async () => {
            const auth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            const ctx = await fixture.getSessionContext(auth.cookie);

            const res = await fetch(`${fixture.baseUrl}/api/core/world-info/scan`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': ctx.csrfToken,
                    cookie: auth.cookie,
                },
                body: JSON.stringify({ text: 'normal scan', worldInfo: [] }),
            });
            expect(res.status).toBe(200);
            const json = await res.json();
            expect(json.ok).toBe(true);
        });
    });

    // 3. 跨 Origin 与反向代理策略 (Cross-Origin and Reverse Proxy Policy)
    describe('3. Cross-Origin and Reverse Proxy Policy', () => {
        test('CORS preflight from untrusted Origin returns null or does not reflect untrusted origin', async () => {
            const res = await fetch(`${fixture.baseUrl}/api/users/me`, {
                method: 'OPTIONS',
                headers: {
                    Origin: 'http://malicious-attacker.com',
                    'Access-Control-Request-Method': 'GET',
                },
            });
            const allowOrigin = res.headers.get('access-control-allow-origin');
            expect(allowOrigin).not.toBe('http://malicious-attacker.com');
        });

        test('WebSocket upgrade with forged Origin to disabled Core WS is rejected with 403', async () => {
            const ws = new WebSocket(`${fixture.wsUrl}/api/bridge/ws`, {
                headers: {
                    Origin: 'http://malicious-attacker.com',
                },
            });

            const status = await new Promise((resolve) => {
                ws.on('unexpected-response', (req, res) => {
                    resolve(res.statusCode);
                });
                ws.on('error', () => resolve(null));
                ws.on('open', () => {
                    ws.close();
                    resolve(101);
                });
            });

            expect(status).toBe(403);
        });
    });

    // 4. 多用户身份隔离 (Multi-User Identity Isolation)
    describe('4. Multi-User Session & Data Isolation', () => {
        test('User Alice cannot view or manipulate session as User Bob', async () => {
            const aliceAuth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            const bobAuth = await fixture.login(testUsers.bob.handle, testUsers.bob.password);

            const aliceMe = await fetch(`${fixture.baseUrl}/api/users/me`, {
                headers: { cookie: aliceAuth.cookie },
            });
            const aliceData = await aliceMe.json();
            expect(aliceData.handle).toBe('alice');

            const bobMe = await fetch(`${fixture.baseUrl}/api/users/me`, {
                headers: { cookie: bobAuth.cookie },
            });
            const bobData = await bobMe.json();
            expect(bobData.handle).toBe('bob');
            expect(bobData.handle).not.toBe(aliceData.handle);
        });

        test('Query parameter userId spoofing on Core WS upgrade fails and cannot bypass 403', async () => {
            const ws = new WebSocket(`${fixture.wsUrl}/api/bridge/ws?userId=alice`);
            const status = await new Promise((resolve) => {
                ws.on('unexpected-response', (req, res) => {
                    resolve(res.statusCode);
                });
                ws.on('error', () => resolve(null));
                ws.on('open', () => {
                    ws.close();
                    resolve(101);
                });
            });
            expect(status).toBe(403);
        });
    });

    // 5. 退出登录后的连接策略 (Post-Logout Invalidation & Disconnection Policy)
    describe('5. Post-Logout Invalidation & Disconnection Policy', () => {
        test('Terminating session via /api/users/logout invalidates session cookie', async () => {
            const auth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            const ctx = await fixture.getSessionContext(auth.cookie);

            // Verified logged in
            const checkBefore = await fetch(`${fixture.baseUrl}/api/users/me`, {
                headers: { cookie: auth.cookie },
            });
            expect(checkBefore.status).toBe(200);

            // Execute logout
            const logoutRes = await fetch(`${fixture.baseUrl}/api/users/logout`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': ctx.csrfToken,
                    cookie: auth.cookie,
                },
            });
            expect(logoutRes.status).toBe(204);

            const logoutCookie = fixture.extractCookies(logoutRes, auth.cookie);

            // Attempting to access protected endpoint with the post-logout cookie
            const checkAfter = await fetch(`${fixture.baseUrl}/api/users/me`, {
                headers: { cookie: logoutCookie },
            });
            expect(checkAfter.status).toBe(403);
        });
    });

    // 6. 票据重放与过期 (Ticket Replay / Expiration / Sec-WebSocket-Protocol Ticket Contract)
    describe('6. Formal Core Ticket API & Sec-WebSocket-Protocol Contract (Replay & Expiration)', () => {
        // Contract Specification for Future Ticket API:
        // Target Protocol: Sec-WebSocket-Protocol: st-ticket.<single_use_ticket>
        // Note: Query parameter (?ticket=...) is NOT permitted to avoid URL leak in proxy logs.

        test.skip('Acquire ticket: POST /api/core/auth/ticket generates single-use ticket [TICKET_API_NOT_IMPLEMENTED]', async () => {
            // Target Specification:
            // 1. Authenticated user requests a short-lived ticket:
            //    POST /api/core/auth/ticket with CSRF token and session cookie
            // 2. Returns { ok: true, ticket: string, expiresIn: 60 }
            const auth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            const ctx = await fixture.getSessionContext(auth.cookie);
            const res = await fetch(`${fixture.baseUrl}/api/core/auth/ticket`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': ctx.csrfToken,
                    cookie: auth.cookie,
                },
            });
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.ticket).toBeDefined();
        });

        test.skip('Ticket consumption via Sec-WebSocket-Protocol: Upgrade completes handshake and binds user [TICKET_API_NOT_IMPLEMENTED]', async () => {
            // Target Specification:
            // WebSocket upgrade to /api/bridge/ws with subprotocol:
            // Sec-WebSocket-Protocol: st-ticket.<single_use_ticket>
            // Returns HTTP 101 Switching Protocols, sets Sec-WebSocket-Protocol: st-ticket,
            // and emits handshake event bound to the authenticated user handle.
            // Pending implementation:
            // const fakeTicket = 'test-ticket-sample';
            // const ws = new WebSocket(`${fixture.wsUrl}/api/bridge/ws`, [`st-ticket.${fakeTicket}`]);
        });

        test.skip('Ticket replay prevention via Sec-WebSocket-Protocol: Replay rejected with 403 [TICKET_API_NOT_IMPLEMENTED]', async () => {
            // Target Specification:
            // Single-use ticket is invalidated immediately upon first consumption.
            // A second upgrade attempt using the same Sec-WebSocket-Protocol is rejected with HTTP 403.
        });

        test.skip('Ticket expiration: Expired ticket after TTL is rejected with 403 [TICKET_API_NOT_IMPLEMENTED]', async () => {
            // Target Specification:
            // Tickets older than TTL (e.g. 60 seconds) must be rejected with HTTP 403.
        });

        test('Verifies that unimplemented /api/core/auth/ticket returns 404/403 rather than false positive', async () => {
            const auth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            const ctx = await fixture.getSessionContext(auth.cookie);
            const res = await fetch(`${fixture.baseUrl}/api/core/auth/ticket`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': ctx.csrfToken,
                    cookie: auth.cookie,
                },
            });
            // Formal endpoint is not yet mounted; must return 404 or 403, definitely not 200
            expect([403, 404]).toContain(res.status);
        });

        test('Verifies that Sec-WebSocket-Protocol subprotocol without valid ticket is rejected with 403', async () => {
            const ws = new WebSocket(`${fixture.wsUrl}/api/bridge/ws`, ['st-ticket.arbitrary-unverified-ticket']);
            const status = await new Promise((resolve) => {
                ws.on('unexpected-response', (req, res) => {
                    resolve(res.statusCode);
                });
                ws.on('error', () => resolve(null));
                ws.on('open', () => {
                    ws.close();
                    resolve(101);
                });
            });
            expect(status).toBe(403);
        });
    });
});
