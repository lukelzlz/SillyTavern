import { describe, test, expect, beforeEach } from '@jest/globals';
import { SessionEngine, MAX_SESSIONS, MAX_MESSAGE_LENGTH, clonePayload } from '../src/core/session-engine.js';

describe('SessionEngine & UserSession (Server Core State - Hardened)', () => {
    let engine;

    beforeEach(() => {
        engine = new SessionEngine();
    });

    // -------------------------------------------------------------
    // Item 1: userId nullish handling and domain validation
    // -------------------------------------------------------------
    describe('1. userId nullish handling & domain validation', () => {
        test('defaults userId when null or undefined', () => {
            const sNull = engine.getSession(null);
            const sUndef = engine.getSession(undefined);
            const sEmpty = engine.getSession();
            expect(sNull.userId).toBe('default');
            expect(sUndef.userId).toBe('default');
            expect(sEmpty.userId).toBe('default');
            expect(sNull).toBe(sUndef);
        });

        test('accepts valid alphanumeric, hyphen, underscore, dot and at symbols', () => {
            const validIds = ['user_123', 'admin-user', 'user.name', 'test@domain', 'a', '1'];
            for (const id of validIds) {
                const session = engine.getSession(id);
                expect(session.userId).toBe(id);
            }
        });

        test('strictly rejects invalid userId domains with TypeError', () => {
            const invalidIds = [
                '',
                '   ',
                '../traversal',
                'user/slash',
                'user\\backslash',
                'user:colon',
                'user;semi',
                'user name',
                'user<script>',
                'a'.repeat(65), // > 64 chars
                12345, // non-string
                {},
                [],
            ];
            for (const id of invalidIds) {
                expect(() => engine.getSession(id)).toThrow(TypeError);
                expect(engine.deleteSession(id)).toBe(false);
            }
        });
    });

    // -------------------------------------------------------------
    // Item 2: syncFullState true state replacement
    // -------------------------------------------------------------
    describe('2. syncFullState true replacement semantics', () => {
        test('completely replaces state without retaining stale metadata keys or chat messages', () => {
            const session = engine.getSession('user_replace');

            // Setup initial state with custom metadata and chat
            session.syncFullState({
                characterId: 'char_old',
                characterName: 'OldBot',
                chatId: 'chat_old',
                chat: [
                    { name: 'User', is_user: true, mes: 'Old msg 1' },
                    { name: 'OldBot', is_user: false, mes: 'Old msg 2' },
                ],
                metadata: {
                    oldKey1: 'stale_value',
                    oldKey2: { nested: true },
                    variables: { oldVar: 42, score: 100 },
                },
            });

            expect(session.chat).toHaveLength(2);
            expect(session.chatMetadata.oldKey1).toBe('stale_value');
            expect(session.chatMetadata.variables.oldVar).toBe(42);

            // Now perform full sync with new minimal payload
            const res = session.syncFullState({
                characterId: 'char_new',
                characterName: 'NewBot',
                chatId: 'chat_new',
                chat: [{ name: 'User', is_user: true, mes: 'Fresh start' }],
                metadata: {
                    newKey: 'clean',
                    variables: { newVar: 99 },
                },
            });

            expect(res.success).toBe(true);
            expect(session.chat).toHaveLength(1);
            expect(session.chat[0].mes).toBe('Fresh start');
            expect(session.activeCharacterId).toBe('char_new');
            expect(session.chatMetadata.newKey).toBe('clean');
            expect(session.chatMetadata.variables).toEqual({ newVar: 99 });

            // CRITICAL: Stale keys must NOT linger
            expect(session.chatMetadata.oldKey1).toBeUndefined();
            expect(session.chatMetadata.oldKey2).toBeUndefined();
            expect('oldVar' in session.chatMetadata.variables).toBe(false);
            expect('score' in session.chatMetadata.variables).toBe(false);
        });

        test('calling syncFullState with empty object resets chat and metadata', () => {
            const session = engine.getSession('user_reset');
            session.appendMessage({ name: 'User', is_user: true, mes: 'hi' });
            session.updateMetadata({ foo: 'bar', variables: { a: 1 } });

            session.syncFullState({});

            expect(session.chat).toEqual([]);
            expect(session.chatMetadata).toEqual({ variables: {} });
            expect(session.activeCharacterId).toBeNull();
        });
    });

    // -------------------------------------------------------------
    // Item 3: Deep structured clone immutability
    // -------------------------------------------------------------
    describe('3. Immutable structured clone for write, events, patch and snapshot', () => {
        test('caller cannot mutate session state by modifying original input objects', () => {
            const session = engine.getSession('user_input_immut');
            const originalMsg = {
                name: 'User',
                is_user: true,
                mes: 'Original message',
                extra: { tags: ['t1', 't2'] },
            };

            session.appendMessage(originalMsg);

            // Mutate caller's original object
            originalMsg.mes = 'TAMPERED MES';
            originalMsg.extra.tags.push('HACKED');

            // Internal session state must be pristine
            expect(session.chat[0].mes).toBe('Original message');
            expect(session.chat[0].extra.tags).toEqual(['t1', 't2']);
        });

        test('event listeners receiving state:snapshot or state:patch cannot mutate session internal state', () => {
            const session = engine.getSession('user_event_immut');
            let receivedSnapshot = null;
            let receivedPatch = null;

            session.on('state:snapshot', (data) => {
                receivedSnapshot = data.snapshot;
            });
            session.on('state:patch', (data) => {
                receivedPatch = data.patch;
            });

            session.syncFullState({
                chat: [{ name: 'User', is_user: true, mes: 'Snapshot msg', extra: { count: 10 } }],
                metadata: { variables: { token: 'secret' } },
            });

            // Tamper with received snapshot in listener
            receivedSnapshot.chat[0].mes = 'CORRUPTED';
            receivedSnapshot.chatMetadata.variables.token = 'EXPOSED';

            expect(session.chat[0].mes).toBe('Snapshot msg');
            expect(session.chatMetadata.variables.token).toBe('secret');

            session.appendMessage({ name: 'Bot', is_user: false, mes: 'Patch msg', extra: { v: 1 } });
            receivedPatch.message.mes = 'CORRUPTED PATCH';

            expect(session.chat[1].mes).toBe('Patch msg');
        });

        test('getSnapshot and getSummary return isolated copies', () => {
            const session = engine.getSession('user_snap_immut');
            session.appendMessage({ name: 'User', is_user: true, mes: 'Hello' });
            session.updateMetadata({ variables: { x: 1 } });

            const snap1 = session.getSnapshot();
            snap1.chat[0].mes = 'MODIFIED';
            snap1.chatMetadata.variables.x = 999;

            const snap2 = session.getSnapshot();
            expect(snap2.chat[0].mes).toBe('Hello');
            expect(snap2.chatMetadata.variables.x).toBe(1);
        });
    });

    // -------------------------------------------------------------
    // Item 4: Monotonic accessSequence LRU
    // -------------------------------------------------------------
    describe('4. Monotonic accessSequence LRU pruning', () => {
        test('evicts oldest session based on monotonic access order even within the same millisecond', () => {
            // Fill up to 100 sessions
            engine.getSession('default');
            for (let i = 0; i < MAX_SESSIONS - 1; i++) {
                engine.getSession(`user_${i}`);
            }
            expect(engine.sessions.size).toBe(MAX_SESSIONS);

            // Re-access user_0, making user_1 the least-recently-accessed
            engine.getSession('user_0');

            // Creating a new session must evict user_1 (accessSequence = 2), NOT user_0 (accessSequence = 101)
            engine.getSession('user_new');
            expect(engine.sessions.size).toBe(MAX_SESSIONS);
            expect(engine.sessions.has('default')).toBe(true);
            expect(engine.sessions.has('user_1')).toBe(false);
            expect(engine.sessions.has('user_0')).toBe(true);
            expect(engine.sessions.has('user_new')).toBe(true);
        });
    });

    // -------------------------------------------------------------
    // Item 5: Hard max capacity & generating session eviction semantics
    // -------------------------------------------------------------
    describe('5. Hard MAX_SESSIONS capacity & eviction semantics', () => {
        test('evicts oldest generating session if all non-default sessions are generating and aborts controller', () => {
            const abortLog = [];

            // Pre-fill 99 generating sessions
            engine.getSession('default');
            for (let i = 0; i < MAX_SESSIONS - 1; i++) {
                const s = engine.getSession(`gen_${i}`);
                s.generationState = 'generating';
                const ac = new AbortController();
                ac.signal.addEventListener('abort', () => abortLog.push(`gen_${i}`));
                s.activeAbortController = ac;
            }

            expect(engine.sessions.size).toBe(MAX_SESSIONS);

            // Adding one more session must evict gen_0 (the oldest generating session)
            const overflowSession = engine.getSession('gen_overflow');
            expect(engine.sessions.size).toBe(MAX_SESSIONS);
            expect(engine.sessions.has('gen_0')).toBe(false);
            expect(engine.sessions.has('gen_overflow')).toBe(true);
            expect(abortLog).toContain('gen_0');
            expect(overflowSession.userId).toBe('gen_overflow');
        });

        test('deleteSession cleans up active abort controller and listeners', () => {
            const session = engine.getSession('user_abort_test');
            session.generationState = 'generating';
            const ac = new AbortController();
            let aborted = false;
            ac.signal.addEventListener('abort', () => { aborted = true; });
            session.activeAbortController = ac;

            let listenerFired = false;
            session.on('state:updated', () => { listenerFired = true; });

            expect(engine.deleteSession('user_abort_test')).toBe(true);
            expect(aborted).toBe(true);
            expect(session.listenerCount('state:updated')).toBe(0);

            session.emit('state:updated', {});
            expect(listenerFired).toBe(false);
        });
    });

    // -------------------------------------------------------------
    // Item 6: UTF-16 surrogate pairs safety
    // -------------------------------------------------------------
    describe('6. UTF-16 surrogate pairs safety without corruption', () => {
        test('does not break high-low surrogate pairs when truncating oversized messages', () => {
            const session = engine.getSession('user_surrogate');

            // Construct string of length MAX_MESSAGE_LENGTH - 1 followed by emoji (2 code units: \uD83D\uDE00)
            const prefix = 'A'.repeat(MAX_MESSAGE_LENGTH - 1);
            const emoji = '😀'; // \uD83D\uDE00
            const textWithSurrogateAtBoundary = prefix + emoji; // length = MAX_MESSAGE_LENGTH + 1

            session.appendMessage({ name: 'User', is_user: true, mes: textWithSurrogateAtBoundary });

            const storedMes = session.chat[0].mes;
            // The cutoff falls exactly between \uD83D and \uDE00.
            // Rather than leaving orphaned \uD83D, it must safely trim down to MAX_MESSAGE_LENGTH - 1.
            expect(storedMes.length).toBe(MAX_MESSAGE_LENGTH - 1);
            expect(storedMes).toBe(prefix);
            expect(storedMes.charCodeAt(storedMes.length - 1)).not.toBe(0xD83D);
        });

        test('handles surrogate pairs inside syncFullState and updateMessage', () => {
            const session = engine.getSession('user_surrogate_update');
            const prefix = 'X'.repeat(MAX_MESSAGE_LENGTH - 1);
            const emoji = '🚀'; // \uD83D\uDE80
            const overflow = prefix + emoji;

            session.syncFullState({
                chat: [{ name: 'User', is_user: true, mes: overflow }],
            });
            expect(session.chat[0].mes.length).toBe(MAX_MESSAGE_LENGTH - 1);

            session.updateMessage(0, { mes: overflow });
            expect(session.chat[0].mes.length).toBe(MAX_MESSAGE_LENGTH - 1);
        });
    });

    // -------------------------------------------------------------
    // Item 7: Native Array.prototype.splice semantics
    // -------------------------------------------------------------
    describe('7. Native Array.splice negative index and optional deleteCount semantics', () => {
        test('supports negative start indices natively', () => {
            const session = engine.getSession('user_splice_native');
            session.appendMessage({ name: 'User', is_user: true, mes: 'm0' });
            session.appendMessage({ name: 'Bot', is_user: false, mes: 'm1' });
            session.appendMessage({ name: 'User', is_user: true, mes: 'm2' });
            session.appendMessage({ name: 'Bot', is_user: false, mes: 'm3' });

            // Splice with start = -2, deleteCount = 1 (removes m2)
            const res = session.spliceChat(-2, 1);
            expect(res.success).toBe(true);
            expect(res.removed).toHaveLength(1);
            expect(res.removed[0].mes).toBe('m2');
            expect(session.chat.map(m => m.mes)).toEqual(['m0', 'm1', 'm3']);
        });

        test('supports omitted deleteCount (removes all from start to end)', () => {
            const session = engine.getSession('user_splice_omit_del');
            session.appendMessage({ name: 'User', is_user: true, mes: 'm0' });
            session.appendMessage({ name: 'Bot', is_user: false, mes: 'm1' });
            session.appendMessage({ name: 'User', is_user: true, mes: 'm2' });

            // Splice with start = 1 and undefined deleteCount
            const res = session.spliceChat(1);
            expect(res.success).toBe(true);
            expect(res.removed.map(m => m.mes)).toEqual(['m1', 'm2']);
            expect(session.chat).toHaveLength(1);
            expect(session.chat[0].mes).toBe('m0');
        });

        test('supports inserting items at negative index', () => {
            const session = engine.getSession('user_splice_insert');
            session.appendMessage({ name: 'User', is_user: true, mes: 'm0' });
            session.appendMessage({ name: 'Bot', is_user: false, mes: 'm1' });

            // Insert before the last item (start = -1, deleteCount = 0)
            const res = session.spliceChat(-1, 0, [{ name: 'User', is_user: true, mes: 'inserted' }]);
            expect(res.success).toBe(true);
            expect(session.chat.map(m => m.mes)).toEqual(['m0', 'inserted', 'm1']);
        });
    });

    // -------------------------------------------------------------
    // Item 8: applyPatch reentrancy guard & version gap handling
    // -------------------------------------------------------------
    describe('8. applyPatch anti-reentrancy & version checking', () => {
        test('detects and blocks reentrant applyPatch calls without corruption or infinite loops', () => {
            const session = engine.getSession('user_reentrancy');
            let reentrantResult = null;

            // When state:patch fires during applyPatch, try to invoke applyPatch again
            session.once('state:patch', () => {
                reentrantResult = session.applyPatch({
                    op: 'append',
                    message: { name: 'Reentrant', is_user: true, mes: 'nested' },
                });
            });

            const topResult = session.applyPatch({
                op: 'append',
                message: { name: 'Top', is_user: true, mes: 'initial' },
            });

            expect(topResult.success).toBe(true);
            expect(reentrantResult).not.toBeNull();
            expect(reentrantResult.success).toBe(false);
            expect(reentrantResult.error).toContain('Reentrancy detected');
            expect(session.chat).toHaveLength(1);
            expect(session.chat[0].mes).toBe('initial');
        });

        test('drops stale patches and rejects version gap patches', () => {
            const session = engine.getSession('user_version_guard');
            session.syncFullState({ chat: [{ name: 'User', is_user: true, mes: 'v1' }] });
            expect(session.stateVersion).toBe(1);

            // Stale patch (version <= stateVersion)
            const staleRes = session.applyPatch({
                op: 'append',
                message: { name: 'User', is_user: true, mes: 'stale' },
                version: 1,
            });
            expect(staleRes.success).toBe(false);
            expect(staleRes.dropped).toBe(true);
            expect(session.chat).toHaveLength(1);

            // Gap patch (version > stateVersion + 1, e.g. version 3 when current is 1)
            const gapRes = session.applyPatch({
                op: 'append',
                message: { name: 'User', is_user: true, mes: 'future' },
                version: 3,
            });
            expect(gapRes.success).toBe(false);
            expect(gapRes.gap).toBe(true);
            expect(session.chat).toHaveLength(1);

            // In-order patch (version = 2) succeeds
            const nextRes = session.applyPatch({
                op: 'append',
                message: { name: 'User', is_user: true, mes: 'v2' },
                version: 2,
            });
            expect(nextRes.success).toBe(true);
            expect(session.chat).toHaveLength(2);
            expect(session.stateVersion).toBe(2);
        });
    });

    // -------------------------------------------------------------
    // Item 9: Variable deletion semantics
    // -------------------------------------------------------------
    describe('9. Variable deletion semantics verification', () => {
        test('deletes variables on null or undefined updates while keeping others intact', () => {
            const session = engine.getSession('user_var_del');
            session.updateMetadata({
                variables: {
                    keepMe: 'v1',
                    deleteNull: 'v2',
                    deleteUndef: 'v3',
                },
            });

            expect(session.chatMetadata.variables).toEqual({
                keepMe: 'v1',
                deleteNull: 'v2',
                deleteUndef: 'v3',
            });

            session.updateMetadata({
                variables: {
                    deleteNull: null,
                    deleteUndef: undefined,
                    newVar: 'v4',
                },
            });

            expect('deleteNull' in session.chatMetadata.variables).toBe(false);
            expect('deleteUndef' in session.chatMetadata.variables).toBe(false);
            expect(session.chatMetadata.variables.keepMe).toBe('v1');
            expect(session.chatMetadata.variables.newVar).toBe('v4');
        });
    });

    // -------------------------------------------------------------
    // Review Round 2 (RES-01..04) Failure-Reproduction & Hardened Tests
    // -------------------------------------------------------------
    describe('Review Round 2 Tests (RES-01..RES-04)', () => {
        // RES-01: cleanup marks destroyed / unbinds engine, public mutators safely fail and do NOT emit
        test('RES-01: cleanup marks session destroyed, unbinds engine, and prevents any mutator from succeeding or emitting events', () => {
            const session = engine.getSession('res01_user');
            let engineEventsCount = 0;
            let sessionEventsCount = 0;

            engine.on('message:appended', () => { engineEventsCount++; });
            engine.on('state:patch', () => { engineEventsCount++; });
            session.on('message:appended', () => { sessionEventsCount++; });

            session.cleanup();

            expect(session.destroyed).toBe(true);
            expect(session.engine).toBeNull();

            // Mutators must safely fail
            const appendRes = session.appendMessage({ name: 'User', is_user: true, mes: 'after cleanup' });
            expect(appendRes.success).toBe(false);
            expect(appendRes.error).toContain('destroyed');

            const updateRes = session.updateMessage(0, { mes: 'new' });
            expect(updateRes.success).toBe(false);
            expect(updateRes.error).toContain('destroyed');

            const delRes = session.deleteMessage(0);
            expect(delRes.success).toBe(false);
            expect(delRes.error).toContain('destroyed');

            const spliceRes = session.spliceChat(0, 1);
            expect(spliceRes.success).toBe(false);
            expect(spliceRes.error).toContain('destroyed');

            const metaRes = session.updateMetadata({ foo: 'bar' });
            expect(metaRes.success).toBe(false);
            expect(metaRes.error).toContain('destroyed');

            const syncRes = session.syncFullState({});
            expect(syncRes.success).toBe(false);
            expect(syncRes.error).toContain('destroyed');

            const patchRes = session.applyPatch({ op: 'append', message: { name: 'U', is_user: true, mes: 'x' } });
            expect(patchRes.success).toBe(false);
            expect(patchRes.error).toContain('destroyed');

            // Absolutely no event should have fired
            expect(sessionEventsCount).toBe(0);
            expect(engineEventsCount).toBe(0);
        });

        // RES-02: applyPatch starting from version=0 strictly accepts ONLY current+1
        test('RES-02: applyPatch from initial version=0 strictly accepts ONLY version=1, rejecting version=0 and version=2', () => {
            const session = engine.getSession('res02_user');
            expect(session.stateVersion).toBe(0);

            // In version=0, version=0 is stale
            const staleRes = session.applyPatch({
                op: 'append',
                message: { name: 'User', is_user: true, mes: 'v0' },
                version: 0,
            });
            expect(staleRes.success).toBe(false);
            expect(staleRes.stale).toBe(true);
            expect(staleRes.error).toContain('Stale patch version');

            // In version=0, version=2 is a gap
            const gapRes = session.applyPatch({
                op: 'append',
                message: { name: 'User', is_user: true, mes: 'v2' },
                version: 2,
            });
            expect(gapRes.success).toBe(false);
            expect(gapRes.gap).toBe(true);
            expect(gapRes.error).toContain('Version gap detected');

            // Strictly only version=1 succeeds
            const validRes = session.applyPatch({
                op: 'append',
                message: { name: 'User', is_user: true, mes: 'v1' },
                version: 1,
            });
            expect(validRes.success).toBe(true);
            expect(session.stateVersion).toBe(1);
        });

        // RES-03: syncFullState clears patchHistory, records a single authoritative snapshot patch, and prevents replaying old chat
        test('RES-03: syncFullState clears old patch history, emits snapshot patch, and does not replay historical chat items', () => {
            const session = engine.getSession('res03_user');

            // Append messages in initial chat
            session.appendMessage({ name: 'User', is_user: true, mes: 'old chat 1' });
            session.appendMessage({ name: 'Bot', is_user: false, mes: 'old chat 2' });
            expect(session.patchHistory).toHaveLength(2);
            expect(session.patchHistory.map(p => p.message?.mes)).toEqual(['old chat 1', 'old chat 2']);

            const patchesObserved = [];
            session.on('state:patch', (data) => {
                patchesObserved.push(data.patch);
            });

            // Perform syncFullState replacing with brand new chat
            session.syncFullState({
                chat: [{ name: 'User', is_user: true, mes: 'new chat only' }],
                metadata: { room: 'fresh' },
            });

            // Historical patches must be wiped
            expect(session.patchHistory).toHaveLength(1);
            expect(session.patchHistory[0].op).toBe('snapshot');
            expect(session.patchHistory[0].snapshot.chat).toHaveLength(1);
            expect(session.patchHistory[0].snapshot.chat[0].mes).toBe('new chat only');

            // Observed state:patch must be exactly the snapshot op
            expect(patchesObserved).toHaveLength(1);
            expect(patchesObserved[0].op).toBe('snapshot');
            expect(patchesObserved[0].snapshot.chat[0].mes).toBe('new chat only');
        });

        // RES-04: clonePayload returns structured failure for undefined, function, symbol, and cyclic references without throwing
        test('RES-04: clonePayload safely returns structured failure on undefined, function, symbol, and cyclic structures', () => {
            // undefined
            const undefRes = clonePayload(undefined);
            expect(undefRes.success).toBe(false);
            expect(undefRes.error).toContain('Cannot clone undefined');

            // function
            const fnRes = clonePayload(() => { return 42; });
            expect(fnRes.success).toBe(false);
            expect(fnRes.error).toContain('Uncloneable type: function');

            // symbol
            const symRes = clonePayload(Symbol('test'));
            expect(symRes.success).toBe(false);
            expect(symRes.error).toContain('Uncloneable type: symbol');

            // object containing function
            const nestedFnRes = clonePayload({ a: 1, run: () => {} });
            expect(nestedFnRes.success).toBe(false);
            expect(nestedFnRes.error).toContain('Uncloneable type: function');

            // cyclic structure
            const cyclicObj = { name: 'loop' };
            cyclicObj.self = cyclicObj;
            expect(() => {
                const cRes = clonePayload(cyclicObj);
                expect(cRes.success).toBe(false);
                expect(cRes.error).toContain('Cyclic reference detected');
            }).not.toThrow();

            // Mutators must reject payloads with uncloneable structures safely
            const session = engine.getSession('res04_user');
            const badAppend = session.appendMessage({ name: 'Bad', is_user: true, mes: 'x', fn: () => {} });
            expect(badAppend.success).toBe(false);
            expect(badAppend.error).toContain('Uncloneable');

            const badMeta = session.updateMetadata({ run: () => {} });
            expect(badMeta.success).toBe(false);
            expect(badMeta.error).toContain('Uncloneable');
        });
    });
});
