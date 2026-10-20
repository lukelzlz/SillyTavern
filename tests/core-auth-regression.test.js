import WebSocket from 'ws';
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import {
    CoreAuthServerFixture,
    waitForWsMessage,
    waitForWsClose,
} from './util/core-auth-fixture.js';

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
        charlie: {
            handle: 'charlie',
            name: 'Charlie RateLimit',
            password: 'charlie-pass-789',
            admin: false,
        },
        dave: {
            handle: 'dave',
            name: 'Dave Concurrency',
            password: 'dave-pass-123',
            admin: false,
        },
        eve: {
            handle: 'eve',
            name: 'Eve Revocation',
            password: 'eve-pass-456',
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
        await fixture.seedUser(testUsers.charlie);
        await fixture.seedUser(testUsers.dave);
        await fixture.seedUser(testUsers.eve);
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

        test('POST /api/core/auth/ticket without session cookie returns 403 Forbidden', async () => {
            const ctx = await fixture.getSessionContext();
            const res = await fixture.requestTicket(undefined, ctx.csrfToken);
            expect(res.status).toBe(403);
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

        test('POST /api/core/auth/ticket without x-csrf-token returns 403 Invalid CSRF token', async () => {
            const auth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            expect(auth.status).toBe(200);

            const res = await fixture.requestTicket(auth.cookie, undefined);
            expect(res.status).toBe(403);
        });

        test('POST /api/core/auth/ticket with mismatched x-csrf-token returns 403 Forbidden', async () => {
            const auth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            expect(auth.status).toBe(200);

            const res = await fixture.requestTicket(auth.cookie, 'attacker-forged-csrf-token');
            expect(res.status).toBe(403);
        });
    });

    // 3. 跨 Origin 与反向代理策略 (Cross-Origin and Reverse Proxy Policy)
    describe('3. Cross-Origin and Reverse Proxy Policy (CSWSH Protection)', () => {
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

        test('WebSocket upgrade with forged Origin to Core WS is rejected with 403', async () => {
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

        test('WebSocket upgrade with untrusted Origin is rejected with 403 even with valid subprotocol ticket', async () => {
            const auth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            const ctx = await fixture.getSessionContext(auth.cookie);
            const ticketRes = await fixture.requestTicket(auth.cookie, ctx.csrfToken);
            expect(ticketRes.status).toBe(200);
            const { ticket } = await ticketRes.json();

            const conn = await fixture.connectWs({
                ticket,
                origin: 'http://malicious-attacker.com',
            });
            expect(conn.status).toBe(403);
            expect(conn.ws).toBeNull();
        });

        test('WebSocket upgrade with valid ticket but missing Origin header is rejected with 403', async () => {
            const auth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            const ctx = await fixture.getSessionContext(auth.cookie);
            const ticketRes = await fixture.requestTicket(auth.cookie, ctx.csrfToken);
            expect(ticketRes.status).toBe(200);
            const { ticket } = await ticketRes.json();

            // Explicitly connect with null Origin via fixture helper (no Origin header in upgrade request)
            const conn = await fixture.connectWs({
                ticket,
                origin: null,
            });
            expect(conn.status).toBe(403);
            expect(conn.ws).toBeNull();
        });

        test('Raw WebSocket upgrade with valid ticket and completely omitted Origin is rejected with 403', async () => {
            const auth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            const ctx = await fixture.getSessionContext(auth.cookie);
            const ticketRes = await fixture.requestTicket(auth.cookie, ctx.csrfToken);
            expect(ticketRes.status).toBe(200);
            const { ticket } = await ticketRes.json();

            // Direct raw WebSocket instantiation without any headers object (ensuring no Origin header is sent)
            const ws = new WebSocket(`${fixture.wsUrl}/api/bridge/ws`, ['st-core.v1', `ticket.${ticket}`]);
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

    // 6. 受会话+CSRF保护发票 (Session + CSRF Protected Ticket Issuing)
    describe('6. Session + CSRF Protected Ticket Issuing Contract', () => {
        test('POST /api/core/auth/ticket with valid session and CSRF generates single-use ticket', async () => {
            const auth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            const ctx = await fixture.getSessionContext(auth.cookie);

            const res = await fixture.requestTicket(auth.cookie, ctx.csrfToken);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.ok).toBe(true);
            expect(typeof data.ticket).toBe('string');
            expect(data.ticket.length).toBeGreaterThanOrEqual(24);
            expect(typeof data.expiresIn).toBe('number');
            expect(data.expiresIn).toBeGreaterThan(0);
        });
    });

    // 7. Sec-WebSocket-Protocol 协商与仅 st-core.v1 回显 (Protocol Negotiation Contract)
    describe('7. Sec-WebSocket-Protocol Negotiation & Echo Contract', () => {
        test('WebSocket upgrade with valid ticket completes 101 Switching Protocols and echoes ONLY st-core.v1', async () => {
            const auth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            const ctx = await fixture.getSessionContext(auth.cookie);
            const ticketRes = await fixture.requestTicket(auth.cookie, ctx.csrfToken);
            expect(ticketRes.status).toBe(200);
            const { ticket } = await ticketRes.json();

            // Client sends subprotocol array: ['st-core.v1', `ticket.${ticket}`]
            const conn = await fixture.connectWs({ ticket, origin: fixture.baseUrl });
            expect(conn.status).toBe(101);
            expect(conn.ws).not.toBeNull();

            // RFC subprotocol contract: Server must echo ONLY 'st-core.v1', NEVER the ticket token
            expect(conn.protocol).toBe('st-core.v1');

            // Server must emit initial authenticated handshake frame bound to alice
            const msg = await waitForWsMessage(conn.ws, 2000);
            expect(msg).toMatchObject({
                type: 'handshake',
                status: 'authenticated',
            });
            expect(msg.user || msg.userId).toBe('alice');

            conn.ws.close();
        });

        test('WebSocket upgrade with missing ticket (only st-core.v1) is rejected with 403', async () => {
            const conn = await fixture.connectWs({ protocols: ['st-core.v1'] });
            expect(conn.status).toBe(403);
            expect(conn.ws).toBeNull();
        });

        test('WebSocket upgrade with arbitrary unverified subprotocol is rejected with 403', async () => {
            const conn = await fixture.connectWs({ protocols: ['st-ticket.arbitrary-unverified-ticket'] });
            expect(conn.status).toBe(403);
            expect(conn.ws).toBeNull();
        });

        test('WebSocket upgrade with bogus ticket in st-core.v1 is rejected with 403', async () => {
            const conn = await fixture.connectWs({
                protocols: ['st-core.v1', 'ticket.invalid-bogus-token-random-xyz-123'],
            });
            expect(conn.status).toBe(403);
            expect(conn.ws).toBeNull();
        });
    });

    // 8. 票据防重放 (Ticket Replay Prevention)
    describe('8. Single-Use Ticket Replay Prevention', () => {
        test('Single-use ticket is invalidated immediately upon first consumption and cannot be replayed', async () => {
            const auth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            const ctx = await fixture.getSessionContext(auth.cookie);
            const ticketRes = await fixture.requestTicket(auth.cookie, ctx.csrfToken);
            expect(ticketRes.status).toBe(200);
            const { ticket } = await ticketRes.json();

            // First upgrade consumption must succeed
            const conn1 = await fixture.connectWs({ ticket, origin: fixture.baseUrl });
            expect(conn1.status).toBe(101);

            // Immediate second consumption with the same ticket must be rejected with 403
            const conn2 = await fixture.connectWs({ ticket, origin: fixture.baseUrl });
            expect(conn2.status).toBe(403);
            expect(conn2.ws).toBeNull();

            conn1.ws?.close();
        });
    });

    // 9. 票据超期失效 (Ticket Expiration / TTL)
    describe('9. Ticket Expiration (TTL)', () => {
        test('Ticket past TTL expiration is rejected with 403', async () => {
            const auth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            const ctx = await fixture.getSessionContext(auth.cookie);
            const ticketRes = await fixture.requestTicket(auth.cookie, ctx.csrfToken);
            expect(ticketRes.status).toBe(200);
            const { ticket, expiresIn } = await ticketRes.json();
            expect(expiresIn).toBeGreaterThan(0);

            // Wait until ticket has expired (fixture sets TTL to 2s)
            const waitTimeMs = (expiresIn * 1000) + 300;
            await new Promise((resolve) => setTimeout(resolve, waitTimeMs));

            // Upgrade attempt with expired ticket must be rejected with 403
            const conn = await fixture.connectWs({ ticket, origin: fixture.baseUrl });
            expect(conn.status).toBe(403);
            expect(conn.ws).toBeNull();
        });
    });

    // 10. 非法 URL 参数严格拒绝 (Strict URL Cleanliness - No Query Ticket)
    describe('10. Strict URL Cleanliness & No Query Parameters', () => {
        test('WebSocket upgrade with ?ticket=... query parameter is strictly rejected with 403', async () => {
            const auth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            const ctx = await fixture.getSessionContext(auth.cookie);
            const ticketRes = await fixture.requestTicket(auth.cookie, ctx.csrfToken);
            expect(ticketRes.status).toBe(200);
            const { ticket } = await ticketRes.json();

            // Even if a valid ticket is supplied, query parameter delivery is forbidden (OWASP CWE-598)
            const conn = await fixture.connectWs({ query: `ticket=${ticket}`, origin: fixture.baseUrl });
            expect(conn.status).toBe(403);
            expect(conn.ws).toBeNull();
        });

        test('WebSocket upgrade with ?userId=alice query parameter is rejected with 403', async () => {
            const conn = await fixture.connectWs({ query: 'userId=alice' });
            expect(conn.status).toBe(403);
            expect(conn.ws).toBeNull();
        });

        test('WebSocket upgrade with arbitrary query parameters (?token=xyz&auth=1) is rejected with 403', async () => {
            const conn = await fixture.connectWs({ query: 'token=xyz&auth=1' });
            expect(conn.status).toBe(403);
            expect(conn.ws).toBeNull();
        });
    });

    // 11. 容量与速率限制防护 (Capacity & Rate Limiting Guard)
    describe('11. Capacity & Rate Limiting Guard (DoS Protection)', () => {
        test('Burst requests to POST /api/core/auth/ticket trigger rate limiting (429)', async () => {
            const auth = await fixture.login(testUsers.charlie.handle, testUsers.charlie.password);
            const ctx = await fixture.getSessionContext(auth.cookie);

            // Rapid burst of 20 ticket requests in tight succession (rateLimitPoints = 10)
            const requests = Array.from({ length: 20 }, () =>
                fixture.requestTicket(auth.cookie, ctx.csrfToken),
            );
            const responses = await Promise.all(requests);
            const statuses = responses.map((r) => r.status);
            expect(statuses).toContain(429);
        });

        test('Default rate duration configuration semantics conform to 60 seconds window', async () => {
            const fs = await import('node:fs');
            const path = await import('node:path');
            const yaml = await import('yaml');

            // Static configuration semantic verification (fast & deterministic, avoids waiting 60s)
            const defaultConfigPath = path.resolve(process.cwd(), '../default/config.yaml');
            const defaultYaml = yaml.parse(fs.readFileSync(defaultConfigPath, 'utf8'));

            expect(defaultYaml.core?.transport?.rateLimitDurationSeconds).toBe(60);
            expect(defaultYaml.core?.transport?.rateLimitPoints).toBe(10);
            expect(defaultYaml.core?.transport?.allowMissingOrigin).toBe(false);
        });

        test('Exceeding max concurrent connections per user is rejected with 429 or 403', async () => {
            const auth = await fixture.login(testUsers.dave.handle, testUsers.dave.password);
            const ctx = await fixture.getSessionContext(auth.cookie);

            const activeConnections = [];
            // Dave creates up to max concurrent connections (5)
            for (let i = 0; i < 5; i++) {
                const ticketRes = await fixture.requestTicket(auth.cookie, ctx.csrfToken);
                expect(ticketRes.status).toBe(200);
                const { ticket } = await ticketRes.json();
                const conn = await fixture.connectWs({ ticket, origin: fixture.baseUrl });
                expect(conn.status).toBe(101);
                activeConnections.push(conn.ws);
            }

            // The 6th connection (exceeding maxConnectionsPerUser = 5) must be rejected
            const overflowTicketRes = await fixture.requestTicket(auth.cookie, ctx.csrfToken);
            expect(overflowTicketRes.status).toBe(200);
            const { ticket: overflowTicket } = await overflowTicketRes.json();
            const overflowConn = await fixture.connectWs({ ticket: overflowTicket, origin: fixture.baseUrl });
            expect([403, 429]).toContain(overflowConn.status);

            // Cleanup
            overflowConn.ws?.close();
            for (const ws of activeConnections) {
                try {
                    ws.close();
                } catch (e) {
                    // Ignore
                }
            }
        });
    });

    // 12. 多用户票据不可互换与隔离 (Multi-User Ticket Non-Interchangeability)
    describe('12. Multi-User Ticket Non-Interchangeability', () => {
        test('Ticket issued to Alice strictly binds to Alice and Bob ticket binds to Bob', async () => {
            const aliceAuth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            const aliceCtx = await fixture.getSessionContext(aliceAuth.cookie);
            const bobAuth = await fixture.login(testUsers.bob.handle, testUsers.bob.password);
            const bobCtx = await fixture.getSessionContext(bobAuth.cookie);

            const aliceTicketRes = await fixture.requestTicket(aliceAuth.cookie, aliceCtx.csrfToken);
            expect(aliceTicketRes.status).toBe(200);
            const { ticket: aliceTicket } = await aliceTicketRes.json();

            const bobTicketRes = await fixture.requestTicket(bobAuth.cookie, bobCtx.csrfToken);
            expect(bobTicketRes.status).toBe(200);
            const { ticket: bobTicket } = await bobTicketRes.json();

            expect(aliceTicket).not.toBe(bobTicket);

            // Alice connects with Alice ticket
            const aliceConn = await fixture.connectWs({ ticket: aliceTicket, origin: fixture.baseUrl });
            expect(aliceConn.status).toBe(101);
            const aliceMsg = await waitForWsMessage(aliceConn.ws, 2000);
            expect(aliceMsg.user || aliceMsg.userId).toBe('alice');

            // Bob connects with Bob ticket
            const bobConn = await fixture.connectWs({ ticket: bobTicket, origin: fixture.baseUrl });
            expect(bobConn.status).toBe(101);
            const bobMsg = await waitForWsMessage(bobConn.ws, 2000);
            expect(bobMsg.user || bobMsg.userId).toBe('bob');

            aliceConn.ws?.close();
            bobConn.ws?.close();
        });
    });

    // 13. 登出与禁用即时主动撤销 (Active Revocation & Lifecycle Termination)
    describe('13. Active Revocation & Lifecycle Termination (Logout & User Disable)', () => {
        // [AUDIT DEFECT REPORT - MISSING BUS HOOKS]
        // In current business route implementations:
        // 1. `src/endpoints/users.js` (/api/users/logout) does not invoke wsBridge.terminateUserConnections(userHandle)
        //    nor ticketManager.revokeUserTickets(userHandle).
        // 2. `src/endpoints/users-admin.js` (/api/users/disable) does not invoke wsBridge.terminateUserConnections(userHandle).
        // Per directive: "测试如发现无法测试的 hook 必须失败/skip并报告，不得接受松散 code".
        // These tests enforce the strict 4001 close code and immediate ticket revocation contracts,
        // and are marked with test.skip pending wiring of the revocation hooks into users routes.

        test('Active WebSocket connection is actively closed (code 4001) when user logs out', async () => {
            const auth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            const ctx = await fixture.getSessionContext(auth.cookie);
            const ticketRes = await fixture.requestTicket(auth.cookie, ctx.csrfToken);
            expect(ticketRes.status).toBe(200);
            const { ticket } = await ticketRes.json();

            const conn = await fixture.connectWs({ ticket, origin: fixture.baseUrl });
            expect(conn.status).toBe(101);
            expect(conn.ws).not.toBeNull();

            // Perform logout via HTTP POST /api/users/logout
            const logoutRes = await fetch(`${fixture.baseUrl}/api/users/logout`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': ctx.csrfToken,
                    cookie: auth.cookie,
                },
            });
            expect(logoutRes.status).toBe(204);

            // Active connection MUST be terminated by server with code 4001
            // Real hook check: Without wsBridge.terminateUserConnections in logout handler, connection hangs.
            const closeInfo = await waitForWsClose(conn.ws, 2000);
            expect(closeInfo.code).toBe(4001);
        });

        test('Active WebSocket connection is actively closed (code 4001) when user is disabled by admin', async () => {
            const aliceAuth = await fixture.login(testUsers.alice.handle, testUsers.alice.password);
            const bobAuth = await fixture.login(testUsers.bob.handle, testUsers.bob.password);
            const bobCtx = await fixture.getSessionContext(bobAuth.cookie);

            const bobTicketRes = await fixture.requestTicket(bobAuth.cookie, bobCtx.csrfToken);
            expect(bobTicketRes.status).toBe(200);
            const { ticket: bobTicket } = await bobTicketRes.json();

            const conn = await fixture.connectWs({ ticket: bobTicket, origin: fixture.baseUrl });
            expect(conn.status).toBe(101);
            expect(conn.ws).not.toBeNull();

            // Admin Alice disables user Bob
            const disableRes = await fixture.disableUser(aliceAuth, testUsers.bob.handle);
            expect(disableRes.status).toBe(204);

            // Active connection for Bob MUST be terminated by server with code 4001
            // Real hook check: Without wsBridge.terminateUserConnections in disable handler, connection hangs.
            const closeInfo = await waitForWsClose(conn.ws, 2000);
            expect(closeInfo.code).toBe(4001);
        });

        test('Unredeemed ticket issued prior to logout is invalidated after logout and rejected with 403', async () => {
            const auth = await fixture.login(testUsers.eve.handle, testUsers.eve.password);
            const ctx = await fixture.getSessionContext(auth.cookie);
            const ticketRes = await fixture.requestTicket(auth.cookie, ctx.csrfToken);
            expect(ticketRes.status).toBe(200);
            const { ticket } = await ticketRes.json();

            // User logs out before consuming the ticket
            const logoutRes = await fetch(`${fixture.baseUrl}/api/users/logout`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': ctx.csrfToken,
                    cookie: auth.cookie,
                },
            });
            expect(logoutRes.status).toBe(204);

            // Attempting to upgrade with ticket after logout MUST be rejected with 403
            const conn = await fixture.connectWs({ ticket, origin: fixture.baseUrl });
            expect(conn.status).toBe(403);
            expect(conn.ws).toBeNull();
        });
    });
});
