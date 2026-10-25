import http from 'node:http';
import express from 'express';
import cookieSession from 'cookie-session';
import { csrfSync } from 'csrf-sync';
import WebSocket from 'ws';
import storage from 'node-persist';
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, jest } from '@jest/globals';
import { GenerationJob, JOB_STATUS } from '../src/core/generation/job.js';
import {
    SyntheticResponse,
    createSyntheticRequest,
    extractDelta,
    extractFullTextFromBody,
    extractFinishReason,
    extractReasoningDelta,
    extractToolCallDeltas,
} from '../src/core/generation/synthetic-response.js';
import { JobManager } from '../src/core/generation/job-manager.js';
import sessionEngine, { SessionEngine } from '../src/core/session-engine.js';
import { WebSocketBridge } from '../src/core/ws-bridge.js';
import ticketManager from '../src/core/ticket-manager.js';
import coreRouter from '../src/endpoints/core.js';

describe('Generation Orchestrator & Server Job Manager Test Suite', () => {
    // -------------------------------------------------------------
    // 1. GenerationJob 状态机与生命周期单元测试
    // -------------------------------------------------------------
    describe('1. GenerationJob Strict State Machine & Ring Buffer', () => {
        test('Follows normal lifecycle: QUEUED -> PREPARING -> STREAMING -> COMPLETED', () => {
            const job = new GenerationJob({ userId: 'test-user' });
            expect(job.status).toBe(JOB_STATUS.QUEUED);
            expect(job.isTerminal()).toBe(false);

            job.transition(JOB_STATUS.PREPARING);
            expect(job.status).toBe(JOB_STATUS.PREPARING);

            job.transition(JOB_STATUS.STREAMING);
            expect(job.status).toBe(JOB_STATUS.STREAMING);

            job.appendChunk('Hello ');
            job.appendChunk('world!');
            expect(job.fullText).toBe('Hello world!');

            job.complete({ promptTokens: 10, completionTokens: 2 });
            expect(job.status).toBe(JOB_STATUS.COMPLETED);
            expect(job.isTerminal()).toBe(true);
            expect(job.tokenStats).toEqual({ promptTokens: 10, completionTokens: 2 });
        });

        test('Supports optional plugin interception: QUEUED -> PREPARING -> INTERCEPTING_PLUGINS -> STREAMING', () => {
            const job = new GenerationJob({ userId: 'test-user' });
            job.transition(JOB_STATUS.PREPARING);
            job.transition(JOB_STATUS.INTERCEPTING_PLUGINS);
            expect(job.status).toBe(JOB_STATUS.INTERCEPTING_PLUGINS);

            job.transition(JOB_STATUS.STREAMING);
            expect(job.status).toBe(JOB_STATUS.STREAMING);
        });

        test('Rejects illegal state transitions with IllegalStateTransitionError', () => {
            const job = new GenerationJob({ userId: 'test-user' });
            // Cannot jump from QUEUED directly to COMPLETED
            expect(() => job.transition(JOB_STATUS.COMPLETED)).toThrow(/Illegal state transition/);

            // Cannot jump from QUEUED directly to STREAMING
            expect(() => job.transition(JOB_STATUS.STREAMING)).toThrow(/Illegal state transition/);

            job.transition(JOB_STATUS.PREPARING);
            job.transition(JOB_STATUS.STREAMING);
            job.complete();

            // Terminal state COMPLETED cannot transition to anything
            expect(() => job.transition(JOB_STATUS.STREAMING)).toThrow(/Illegal state transition/);
            expect(() => job.transition(JOB_STATUS.PREPARING)).toThrow(/Illegal state transition/);
            expect(() => job.transition(JOB_STATUS.ABORTED)).toThrow(/Illegal state transition/);
        });

        test('Transitions to FAILED on error and becomes terminal', () => {
            const job = new GenerationJob({ userId: 'test-user' });
            job.transition(JOB_STATUS.PREPARING);
            job.fail(new Error('Gateway timeout'));

            expect(job.status).toBe(JOB_STATUS.FAILED);
            expect(job.error).toBe('Gateway timeout');
            expect(job.isTerminal()).toBe(true);
            expect(() => job.transition(JOB_STATUS.STREAMING)).toThrow(/Illegal state transition/);
        });

        test('Monotonic sequence and ring buffer chunk append', () => {
            const job = new GenerationJob({ userId: 'test-user', capacity: 4 });
            const c1 = job.appendChunk('A');
            const c2 = job.appendChunk('B');
            const c3 = job.appendChunk('C');

            expect(c1.seq).toBe(1);
            expect(c2.seq).toBe(2);
            expect(c3.seq).toBe(3);
            expect(job.lastSeq).toBe(3);
            expect(job.fullText).toBe('ABC');

            // Catch-up from seq 1 gets chunks 2 and 3
            const catchup = job.getCatchupChunks(1);
            expect(catchup.chunks.map((c) => c.delta)).toEqual(['B', 'C']);
            expect(catchup.fromSeq).toBe(2);
            expect(catchup.toSeq).toBe(3);
            expect(catchup.hasMissedChunks).toBe(false);
        });

        test('Ring buffer evicts oldest chunks when capacity is exceeded', () => {
            const job = new GenerationJob({ userId: 'test-user', capacity: 3 });
            job.appendChunk('1'); // seq 1
            job.appendChunk('2'); // seq 2
            job.appendChunk('3'); // seq 3
            job.appendChunk('4'); // seq 4 (evicts seq 1)
            job.appendChunk('5'); // seq 5 (evicts seq 2)

            expect(job.ringBuffer.length).toBe(3);
            expect(job.ringBuffer.map((c) => c.seq)).toEqual([3, 4, 5]);

            // Requesting from seq 1 when min available is 3 detects missed chunks
            const catchup = job.getCatchupChunks(1);
            expect(catchup.hasMissedChunks).toBe(true);
            expect(catchup.chunks.map((c) => c.seq)).toEqual([3, 4, 5]);
        });

        test('Catch-up from seq 0 reports a missing prefix after ring eviction', () => {
            const job = new GenerationJob({ userId: 'test-user', capacity: 2 });
            job.appendChunk('1');
            job.appendChunk('2');
            job.appendChunk('3');

            const catchup = job.getCatchupChunks(0);
            expect(catchup.chunks.map((chunk) => chunk.seq)).toEqual([2, 3]);
            expect(catchup.minSeq).toBe(2);
            expect(catchup.hasMissedChunks).toBe(true);
        });

        test('toJSON produces sanitized serializable snapshot', () => {
            const job = new GenerationJob({ userId: 'alice', chatId: 'chat_1' });
            job.appendChunk('hi');
            const json = job.toJSON();
            expect(json.id).toBe(job.id);
            expect(json.userId).toBe('alice');
            expect(json.chatId).toBe('chat_1');
            expect(json.fullText).toBe('hi');
            expect(json.lastSeq).toBe(1);
            expect(typeof json.createdAt).toBe('number');
        });
    });

    // -------------------------------------------------------------
    // 2. SyntheticResponse 伪装对象与流解析
    // -------------------------------------------------------------
    describe('2. SyntheticResponse Stream Capture & Disconnect Resilience', () => {
        test('Extracts deltas from diverse provider SSE payloads', () => {
            // OpenAI format
            expect(extractDelta({ choices: [{ delta: { content: 'chunk1' } }] })).toBe('chunk1');
            // Claude format
            expect(extractDelta({ delta: { text: 'claude_chunk' } })).toBe('claude_chunk');
            // Vertex / MakerSuite format
            expect(extractDelta({ candidates: [{ content: { parts: [{ text: 'gemini_part' }] } }] })).toBe('gemini_part');
            // Cohere format
            expect(extractDelta({ delta: { message: { content: { text: 'cohere_text' } } } })).toBe('cohere_text');
            // Empty / invalid
            expect(extractDelta(null)).toBe('');
            expect(extractDelta({})).toBe('');
        });

        test('Extracts reasoning, tool-call, and finish metadata without mixing visible text', () => {
            const chunk = {
                choices: [{
                    delta: {
                        content: 'visible',
                        reasoning_content: 'private thought',
                        tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{' } }],
                    },
                    finish_reason: 'tool_calls',
                }],
                usage: { prompt_tokens: 11, completion_tokens: 4 },
            };

            expect(extractReasoningDelta(chunk)).toBe('private thought');
            expect(extractToolCallDeltas(chunk)).toHaveLength(1);
            expect(extractFinishReason(chunk)).toBe('tool_calls');
            expect(extractDelta(chunk)).toBe('visible');
        });

        test('Extracts full text from non-streaming response body', () => {
            expect(extractFullTextFromBody({ choices: [{ message: { content: 'Full message' } }] })).toBe('Full message');
            expect(extractFullTextFromBody({ content: [{ type: 'text', text: 'Claude full' }] })).toBe('Claude full');
            expect(extractFullTextFromBody('Plain string')).toBe('Plain string');
        });

        test('createSyntheticRequest creates properly structured mock request with socket abort bridge', () => {
            const job = new GenerationJob({ userId: 'alice', requestBody: { model: 'gpt-4' } });
            const originalReq = { headers: { 'x-custom': '123' }, session: { id: 'sess_1' } };
            const synReq = createSyntheticRequest(job, originalReq);

            expect(synReq.body.model).toBe('gpt-4');
            expect(synReq.user.profile.handle).toBe('alice');
            expect(synReq.get('x-custom')).toBe('123');

            let socketClosed = false;
            synReq.socket.on('close', () => {
                socketClosed = true;
            });

            job.abort();
            expect(socketClosed).toBe(true);
        });

        test('Pipes SSE chunks, updates job text, and completes on stream end', async () => {
            const job = new GenerationJob({ userId: 'test-user' });
            job.transition(JOB_STATUS.PREPARING);
            job.transition(JOB_STATUS.STREAMING);

            const res = new SyntheticResponse(job);

            res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
            res.write('data: {"choices":[{"delta":{"content":"lo "}}]}\n\n');
            res.write('data: {"choices":[{"delta":{"content":"world!"}}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();

            await new Promise((resolve) => {
                res.on('finish', resolve);
            });

            expect(job.fullText).toBe('Hello world!');
            expect(job.status).toBe(JOB_STATUS.COMPLETED);
            expect(job.lastSeq).toBe(3);
        });

        test('Captures reasoning, tool calls, usage, and finish reason from SSE', async () => {
            const job = new GenerationJob({ userId: 'test-user' });
            job.transition(JOB_STATUS.PREPARING);
            job.transition(JOB_STATUS.STREAMING);

            const res = new SyntheticResponse(job);
            res.write('data: {"choices":[{"delta":{"reasoning_content":"think "}}]}\n\n');
            res.write('data: {"choices":[{"delta":{"content":"answer","tool_calls":[{"index":0,"function":{"name":"lookup"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":8,"completion_tokens":2}}\n\n');
            res.end();

            await new Promise((resolve) => res.on('finish', resolve));

            expect(job.fullText).toBe('answer');
            expect(job.reasoningText).toBe('think ');
            expect(job.toolCallDeltas).toHaveLength(1);
            expect(job.tokenStats).toEqual({ promptTokens: 8, completionTokens: 2 });
            expect(job.finishReason).toBe('tool_calls');
        });

        test('Handles split/fragmented SSE lines across TCP chunks', async () => {
            const job = new GenerationJob({ userId: 'test-user' });
            job.transition(JOB_STATUS.PREPARING);
            job.transition(JOB_STATUS.STREAMING);

            const res = new SyntheticResponse(job);

            // Fragmented line split across two writes
            res.write('data: {"choices":[{"delta":{"con');
            res.write('tent":"Fragmented"}}]}\n\n');
            res.end();

            await new Promise((resolve) => {
                res.on('finish', resolve);
            });

            expect(job.fullText).toBe('Fragmented');
            expect(job.status).toBe(JOB_STATUS.COMPLETED);
        });

        test('Handles non-streaming response via send()', () => {
            const job = new GenerationJob({ userId: 'test-user' });
            job.transition(JOB_STATUS.PREPARING);
            job.transition(JOB_STATUS.STREAMING);

            const res = new SyntheticResponse(job);
            res.send({
                choices: [{ message: { content: 'Non-streaming reply' } }],
                usage: { prompt_tokens: 15, completion_tokens: 3 },
            });

            expect(job.fullText).toBe('Non-streaming reply');
            expect(job.status).toBe(JOB_STATUS.COMPLETED);
            expect(job.tokenStats).toEqual({ promptTokens: 15, completionTokens: 3 });
        });

        test('Upstream HTTP error fails the job', async () => {
            const job = new GenerationJob({ userId: 'test-user' });
            job.transition(JOB_STATUS.PREPARING);
            job.transition(JOB_STATUS.STREAMING);

            const res = new SyntheticResponse(job);
            res.status(500);
            res.write(JSON.stringify({ error: { message: 'Upstream rate limit exceeded' } }));
            res.end();

            await new Promise((resolve) => {
                res.on('finish', resolve);
            });

            expect(job.status).toBe(JOB_STATUS.FAILED);
            expect(job.error).toMatch(/Upstream rate limit exceeded/);
        });

        for (const [name, payload] of [
            ['object error', '{"error":{"message":"secret provider details"}}\n\n'],
            ['string error', '{"error":"secret provider details"}\n\n'],
            ['final line', '{"error":{"message":"secret provider details"}}'],
            ['quota error', '{"quota_error":true}\n\n'],
            ['trailing frames', '{"error":true}\n\ndata: {"choices":[{"delta":{"content":"must not appear"}}]}\n\ndata: [DONE]\n\n'],
        ]) {
            test(`HTTP 200 ${name} fails once and never settles partial output`, async () => {
                const job = new GenerationJob({ userId: 'test-user' });
                job.transition(JOB_STATUS.PREPARING);
                job.transition(JOB_STATUS.STREAMING);
                const failed = jest.fn();
                const completed = jest.fn();
                job.on('failed', failed);
                job.on('completed', completed);
                const res = new SyntheticResponse(job);
                res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
                res.write(`data: ${payload.slice(0, 5)}`);
                res.end(payload.slice(5));
                await new Promise(resolve => res.on('finish', resolve));
                expect(job.status).toBe(JOB_STATUS.FAILED);
                expect(job.fullText).toBe('partial');
                expect(job.abortController.signal.aborted).toBe(true);
                expect(job.error).not.toContain('secret');
                expect(failed).toHaveBeenCalledTimes(1);
                expect(completed).not.toHaveBeenCalled();
            });
        }

        test('Disconnect resilience: synthetic socket stays open and does not abort upstream', async () => {
            const job = new GenerationJob({ userId: 'test-user' });
            job.transition(JOB_STATUS.PREPARING);
            job.transition(JOB_STATUS.STREAMING);

            const res = new SyntheticResponse(job);
            let socketClosed = false;
            res.socket.on('close', () => {
                socketClosed = true;
            });

            // Even if client simulates disconnection by doing nothing, synthetic socket stays alive
            setTimeout(() => {
                expect(socketClosed).toBe(false);
                res.write('data: {"choices":[{"delta":{"content":"Background token"}}]}\n\n');
                res.end();
            }, 30);

            await new Promise((resolve) => {
                res.on('finish', resolve);
            });

            expect(socketClosed).toBe(false);
            expect(job.fullText).toBe('Background token');
            expect(job.status).toBe(JOB_STATUS.COMPLETED);
        });
    });

    // -------------------------------------------------------------
    // 3. JobManager 单用户并发互斥锁与后台常驻管理
    // -------------------------------------------------------------
    describe('3. JobManager Concurrency Lock & Daemon Management', () => {
        let mockSessionEngine;
        let mockWsBridge;
        let jobManager;

        beforeEach(() => {
            mockSessionEngine = new SessionEngine();
            mockWsBridge = {
                broadcastEvent: () => {},
                requestInterception: async (_user, _event, payload) => payload,
            };
        });

        afterEach(() => {
            if (jobManager) {
                jobManager.close();
            }
        });

        test('Single-user concurrency lock blocks second simultaneous job with 409 Conflict', async () => {
            let finishGateway = () => {};
            const hangingGateway = (_req, res) => {
                return new Promise((resolve) => {
                    finishGateway = () => {
                        res.send({ choices: [{ message: { content: 'Done' } }] });
                        resolve();
                    };
                });
            };

            jobManager = new JobManager({
                generateHandler: hangingGateway,
                sessionEngine: mockSessionEngine,
                wsBridge: mockWsBridge,
            });

            // First job starts successfully
            const job1 = await jobManager.createJob({ userId: 'alice', body: { model: 'gpt-4' } });
            expect(job1).toBeDefined();
            expect(jobManager.hasActiveJob('alice')).toBe(true);

            // Second concurrent job for alice is strictly rejected (Fail-Closed)
            await expect(jobManager.createJob({ userId: 'alice', body: { model: 'gpt-4' } }))
                .rejects.toMatchObject({ status: 409, message: /Another generation job is currently in progress/ });

            // Finish first job
            finishGateway();
            await new Promise((resolve) => setTimeout(resolve, 20));

            // Lock released; alice can now create job2
            expect(jobManager.hasActiveJob('alice')).toBe(false);
            const job2 = await jobManager.createJob({ userId: 'alice', body: { model: 'gpt-4' } });
            expect(job2.id).not.toBe(job1.id);
            finishGateway();
        });

        test('Multi-user isolation: Alice and Bob run jobs concurrently without blocking each other', async () => {
            const resolves = [];
            const delayGateway = (_req, res) => {
                return new Promise((resolve) => {
                    resolves.push(() => {
                        res.send({ choices: [{ message: { content: 'Hello' } }] });
                        resolve();
                    });
                });
            };

            jobManager = new JobManager({
                generateHandler: delayGateway,
                sessionEngine: mockSessionEngine,
                wsBridge: mockWsBridge,
            });

            const aliceJob = await jobManager.createJob({ userId: 'alice', body: {} });
            const bobJob = await jobManager.createJob({ userId: 'bob', body: {} });

            expect(jobManager.hasActiveJob('alice')).toBe(true);
            expect(jobManager.hasActiveJob('bob')).toBe(true);
            expect(aliceJob.id).not.toBe(bobJob.id);

            // Resolve both
            resolves.forEach((fn) => fn());
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(jobManager.hasActiveJob('alice')).toBe(false);
            expect(jobManager.hasActiveJob('bob')).toBe(false);
        });

        test('SessionEngine settlement: completed assistant message appended to UserSession', async () => {
            const streamGateway = async (_req, res) => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                res.write('data: {"choices":[{"delta":{"content":"Settled "}}]}\n\n');
                res.write('data: {"choices":[{"delta":{"content":"Message"}}]}\n\n');
                res.end();
            };

            jobManager = new JobManager({
                generateHandler: streamGateway,
                sessionEngine: mockSessionEngine,
                wsBridge: mockWsBridge,
            });

            const session = mockSessionEngine.getSession('alice');
            session.activeCharacterName = 'Seraphina';
            expect(session.chat.length).toBe(0);

            const job = await jobManager.createJob({
                userId: 'alice',
                body: { characterName: 'Seraphina' },
            });

            await new Promise((resolve) => {
                job.on('completed', resolve);
            });

            expect(session.chat.length).toBe(1);
            expect(session.chat[0].name).toBe('Seraphina');
            expect(session.chat[0].mes).toBe('Settled Message');
            expect(session.generationState).toBe('idle');
            expect(session.activeAbortController).toBeNull();
        });

        test('PREPARING assembles an explicit server-owned prompt context before gateway dispatch', async () => {
            const gatewayBodies = [];
            const gateway = async (req, res) => {
                gatewayBodies.push(req.body);
                res.send({ choices: [{ message: { content: 'Server assembled response' } }] });
            };

            jobManager = new JobManager({
                generateHandler: gateway,
                sessionEngine: mockSessionEngine,
                wsBridge: mockWsBridge,
            });

            const job = await jobManager.createJob({
                userId: 'alice',
                body: {
                    model: 'test-model',
                    core_prompt_mode: 'server_context',
                    messages: [{ role: 'user', content: 'client fallback prompt' }],
                    core_prompt_context: {
                        schemaVersion: 1,
                        settings: {
                            source: 'openai',
                            model: 'test-model',
                            maxContext: 1000,
                            maxTokens: 100,
                            newChatPrompt: '[Chat begins]',
                        },
                        generationControl: { type: 'normal', dryRun: false },
                        characterContext: {
                            name1: 'Alice',
                            name2: 'Seraphina',
                            charDescription: 'A server-owned character description.',
                        },
                        worldInfo: { worldInfoBefore: '', worldInfoAfter: '' },
                        promptOrder: ['main', 'charDescription', 'chatHistory'],
                        prompts: [],
                        extensionPrompts: {},
                        chatHistory: [{ role: 'user', content: 'Hello from server context.' }],
                        messageExamples: [],
                        toolsContext: { canPerformToolCalls: false },
                        recordedTokenCounts: {
                            main: 1,
                            charDescription: 5,
                            newMainChat: 1,
                            'chatHistory-1': 2,
                        },
                    },
                },
            });

            await new Promise((resolve) => job.on('completed', resolve));

            expect(gatewayBodies).toHaveLength(1);
            expect(gatewayBodies[0].core_prompt_context).toBeUndefined();
            expect(gatewayBodies[0].core_prompt_mode).toBeUndefined();
            expect(gatewayBodies[0].messages[0]).toEqual({ role: 'system', content: 'You are Seraphina.' });
            expect(gatewayBodies[0].messages).toEqual(expect.arrayContaining([
                expect.objectContaining({ content: 'A server-owned character description.' }),
                expect.objectContaining({ content: 'Hello from server context.' }),
            ]));
        });

        test('PREPARING preserves canonical World Info slots through the gateway boundary', async () => {
            const gatewayBodies = [];
            const gateway = async (req, res) => {
                gatewayBodies.push(req.body);
                res.send({ choices: [{ message: { content: 'World Info response' } }] });
            };

            jobManager = new JobManager({
                generateHandler: gateway,
                sessionEngine: mockSessionEngine,
                wsBridge: mockWsBridge,
            });

            const job = await jobManager.createJob({
                userId: 'alice',
                body: {
                    model: 'test-model',
                    core_prompt_mode: 'server_context',
                    messages: [{ role: 'user', content: 'stale client prompt' }],
                    core_prompt_context: {
                        schemaVersion: 1,
                        settings: {
                            source: 'openai',
                            model: 'test-model',
                            maxContext: 1000,
                            maxTokens: 100,
                            newChatPrompt: '[Example Chat]',
                        },
                        generationControl: { type: 'normal', dryRun: false },
                        characterContext: { name2: 'Seraphina' },
                        worldInfo: {
                            worldInfoBefore: 'stale browser world info',
                            worldInfoAfter: '',
                            entries: [
                                { uid: 'before', key: ['signal'], position: 0, content: 'Canonical before.' },
                                { uid: 'an-top', key: ['signal'], position: 2, content: 'Canonical AN top.' },
                                { uid: 'em-top', key: ['signal'], position: 5, content: 'Canonical EM top.' },
                                { uid: 'em-bottom', key: ['signal'], position: 6, content: 'Canonical EM bottom.' },
                                { uid: 'an-bottom', key: ['signal'], position: 3, content: 'Canonical AN bottom.' },
                                { uid: 'outlet', key: ['signal'], position: 7, outletName: 'lore', content: 'Canonical outlet.' },
                            ],
                            options: { budget: 0 },
                        },
                        promptOrder: ['worldInfoBefore', 'main', 'authorsNote', 'outletPrompt', 'dialogueExamples', 'chatHistory'],
                        prompts: [
                            { identifier: 'authorsNote', role: 'system', content: 'Base note.' },
                            { identifier: 'outletPrompt', role: 'system', content: 'Lore: {{outlet::lore}}' },
                        ],
                        extensionPrompts: {},
                        chatHistory: [{ role: 'user', content: 'The signal is active.' }],
                        messageExamples: [[{ role: 'system', content: 'Example dialogue.' }]],
                        toolsContext: { canPerformToolCalls: false },
                        recordedTokenCounts: {},
                    },
                },
            });

            await new Promise((resolve) => job.on('completed', resolve));

            expect(gatewayBodies).toHaveLength(1);
            const contents = gatewayBodies[0].messages.map((message) => message.content);
            expect(contents).not.toContain('stale browser world info');
            expect(contents).toContain('Canonical before.');
            expect(contents).toContain('Lore: Canonical outlet.');
            expect(contents).toContain('Canonical EM top.');
            expect(contents).toContain('Canonical EM bottom.');
            expect(contents).toContain('Canonical AN top.\nBase note.\nCanonical AN bottom.');
        });

        test('Request ids make duplicate generate:start delivery idempotent', async () => {
            const gateway = (_req, _res) => new Promise(() => { });
            jobManager = new JobManager({
                generateHandler: gateway,
                sessionEngine: mockSessionEngine,
                wsBridge: mockWsBridge,
            });

            const first = await jobManager.createJob({
                userId: 'alice',
                body: {
                    core_request_id: 'request-idempotency-1',
                    core_prompt_mode: 'client_final',
                    messages: [{ role: 'user', content: 'hello' }],
                },
            });
            const duplicate = await jobManager.createJob({
                userId: 'alice',
                body: {
                    core_request_id: 'request-idempotency-1',
                    core_prompt_mode: 'client_final',
                    messages: [{ role: 'user', content: 'hello' }],
                },
            });

            expect(duplicate.id).toBe(first.id);
            expect(jobManager.jobs.size).toBe(1);
        });

        test('Rejects contradictory prompt ownership modes before creating a job', async () => {
            jobManager = new JobManager({
                generateHandler: async () => {},
                sessionEngine: mockSessionEngine,
                wsBridge: mockWsBridge,
            });

            await expect(jobManager.createJob({
                userId: 'alice',
                body: {
                    core_prompt_mode: 'client_final',
                    core_prompt_context: {},
                    messages: [{ role: 'user', content: 'hello' }],
                },
            })).rejects.toMatchObject({
                name: 'InvalidGenerationRequestError',
                status: 400,
            });
        });

        test('Rejects malformed server prompt contexts before creating a job', async () => {
            jobManager = new JobManager({
                generateHandler: async () => {},
                sessionEngine: mockSessionEngine,
                wsBridge: mockWsBridge,
            });

            await expect(jobManager.createJob({
                userId: 'alice',
                body: {
                    core_prompt_mode: 'server_context',
                    core_prompt_context: {
                        schemaVersion: 1,
                        settings: {},
                        generationControl: { type: 'normal' },
                        characterContext: {},
                        worldInfo: {},
                        promptOrder: [],
                        prompts: [],
                        extensionPrompts: {},
                        chatHistory: [{ role: 'user', content: 123 }],
                        messageExamples: [],
                        toolsContext: {},
                        recordedTokenCounts: {},
                    },
                },
            })).rejects.toMatchObject({
                name: 'InvalidGenerationRequestError',
                status: 400,
                message: expect.stringContaining('chatHistory[0].content'),
            });
            expect(jobManager.jobs.size).toBe(0);
        });

        test('Executes server-context plugin interception exactly once before gateway dispatch', async () => {
            const previousPluginFlag = process.env.SILLYTAVERN_CORE_GENERATION_PLUGININTERCEPTIONENABLED;
            process.env.SILLYTAVERN_CORE_GENERATION_PLUGININTERCEPTIONENABLED = 'true';

            try {
                const interceptionPayloads = [];
                const gatewayBodies = [];
                const gateway = async (req, res) => {
                    gatewayBodies.push(req.body);
                    res.send({ choices: [{ message: { content: 'Plugin-aware response' } }] });
                };
                mockWsBridge.requestInterception = async (_user, eventName, payload) => {
                    interceptionPayloads.push({ eventName, payload });
                    return {
                        ...payload,
                        chat: [...payload.chat, { role: 'system', content: 'PLUGIN_MARKER' }],
                    };
                };
                jobManager = new JobManager({
                    generateHandler: gateway,
                    sessionEngine: mockSessionEngine,
                    wsBridge: mockWsBridge,
                });

                const job = await jobManager.createJob({
                    userId: 'alice',
                    body: {
                        core_prompt_mode: 'server_context',
                        core_prompt_context: {
                            schemaVersion: 1,
                            settings: {
                                source: 'openai',
                                model: 'test-model',
                                maxContext: 1000,
                                maxTokens: 100,
                                newChatPrompt: '[Chat begins]',
                            },
                            generationControl: { type: 'normal', dryRun: false },
                            characterContext: { name1: 'Alice', name2: 'Seraphina' },
                            worldInfo: { worldInfoBefore: '', worldInfoAfter: '' },
                            promptOrder: ['main', 'chatHistory'],
                            prompts: [{ identifier: 'chatHistory', role: 'system', content: '' }],
                            extensionPrompts: {},
                            chatHistory: [{ role: 'user', content: 'Hello' }],
                            messageExamples: [],
                            toolsContext: { canPerformToolCalls: false },
                            recordedTokenCounts: {
                                main: 1,
                                newMainChat: 1,
                                'chatHistory-1': 1,
                            },
                        },
                    },
                });

                await new Promise((resolve) => job.once('completed', resolve));

                expect(interceptionPayloads).toHaveLength(1);
                expect(interceptionPayloads[0].eventName).toBe('chat_completion_prompt_ready');
                expect(gatewayBodies).toHaveLength(1);
                expect(gatewayBodies[0].messages).toEqual(expect.arrayContaining([
                    { role: 'system', content: 'PLUGIN_MARKER' },
                ]));
                expect(gatewayBodies[0].core_prompt_context).toBeUndefined();
            } finally {
                if (previousPluginFlag === undefined) {
                    delete process.env.SILLYTAVERN_CORE_GENERATION_PLUGININTERCEPTIONENABLED;
                } else {
                    process.env.SILLYTAVERN_CORE_GENERATION_PLUGININTERCEPTIONENABLED = previousPluginFlag;
                }
            }
        });

        test('Skips server-context plugin interception when the browser reports no listeners', async () => {
            const previousPluginFlag = process.env.SILLYTAVERN_CORE_GENERATION_PLUGININTERCEPTIONENABLED;
            process.env.SILLYTAVERN_CORE_GENERATION_PLUGININTERCEPTIONENABLED = 'true';

            try {
                const interceptionPayloads = [];
                const gateway = async (_req, res) => {
                    res.send({ choices: [{ message: { content: 'No interception response' } }] });
                };
                mockWsBridge.requestInterception = async (_user, _eventName, payload) => {
                    interceptionPayloads.push(payload);
                    return payload;
                };
                jobManager = new JobManager({
                    generateHandler: gateway,
                    sessionEngine: mockSessionEngine,
                    wsBridge: mockWsBridge,
                });

                const job = await jobManager.createJob({
                    userId: 'alice',
                    body: {
                        core_prompt_mode: 'server_context',
                        core_prompt_interception: false,
                        core_prompt_context: {
                            schemaVersion: 1,
                            settings: {
                                source: 'openai',
                                model: 'test-model',
                                maxContext: 1000,
                                maxTokens: 100,
                            },
                            generationControl: { type: 'normal' },
                            characterContext: {},
                            worldInfo: {},
                            promptOrder: ['main', 'chatHistory'],
                            prompts: [],
                            extensionPrompts: {},
                            chatHistory: [{ role: 'user', content: 'Hello' }],
                            messageExamples: [],
                            toolsContext: { canPerformToolCalls: false },
                            recordedTokenCounts: {},
                        },
                    },
                });

                await new Promise((resolve) => job.once('completed', resolve));
                expect(interceptionPayloads).toHaveLength(0);
            } finally {
                if (previousPluginFlag === undefined) {
                    delete process.env.SILLYTAVERN_CORE_GENERATION_PLUGININTERCEPTIONENABLED;
                } else {
                    process.env.SILLYTAVERN_CORE_GENERATION_PLUGININTERCEPTIONENABLED = previousPluginFlag;
                }
            }
        });

        test('Does not settle a completed job into a different active chat', async () => {
            const gateway = async (_req, res) => {
                res.send({ choices: [{ message: { content: 'chat A response' } }] });
            };
            jobManager = new JobManager({
                generateHandler: gateway,
                sessionEngine: mockSessionEngine,
                wsBridge: mockWsBridge,
            });

            const session = mockSessionEngine.getSession('alice');
            session.activeChatId = 'chat-B';
            const job = await jobManager.createJob({
                userId: 'alice',
                body: { chatId: 'chat-A', characterName: 'Seraphina' },
                deferStart: true,
            });
            const completed = new Promise((resolve) => job.once('completed', resolve));
            jobManager.startJob(job);
            await completed;

            expect(session.chat).toHaveLength(0);
            expect(session.generationState).toBe('idle');
        });

        test('Core generation marker reconciles an existing client placeholder without duplication', async () => {
            const session = mockSessionEngine.getSession('alice');
            const marker = 'core-client-generation-1';
            session.syncFullState({
                chat: [{
                    name: 'Seraphina',
                    is_user: false,
                    is_system: false,
                    mes: 'Partial client placeholder',
                    extra: { core_generation_job_id: marker },
                }],
                metadata: {},
            });

            const gateway = async (_req, res) => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                res.send({ choices: [{ message: { content: 'Final server result' } }] });
            };

            jobManager = new JobManager({
                generateHandler: gateway,
                sessionEngine: mockSessionEngine,
                wsBridge: mockWsBridge,
            });

            const job = await jobManager.createJob({
                userId: 'alice',
                body: {
                    characterName: 'Seraphina',
                    core_generation_job_id: marker,
                },
            });

            await new Promise((resolve) => job.on('completed', resolve));

            expect(session.chat).toHaveLength(1);
            expect(session.chat[0].mes).toBe('Final server result');
            expect(session.chat[0].extra.core_generation_job_id).toBe(marker);
        });

        test('Explicit abort cascades to AbortController, closes socket, and frees concurrency lock', async () => {
            let socketClosed = false;
            const longGateway = (req) => {
                return new Promise((resolve) => {
                    req.socket.on('close', () => {
                        socketClosed = true;
                        resolve();
                    });
                });
            };

            jobManager = new JobManager({
                generateHandler: longGateway,
                sessionEngine: mockSessionEngine,
                wsBridge: mockWsBridge,
            });

            const job = await jobManager.createJob({ userId: 'alice' });
            job.appendChunk('Partial generated text...');

            expect(jobManager.hasActiveJob('alice')).toBe(true);

            // Explicit abort
            jobManager.abortJob(job.id, 'User clicked stop');

            expect(job.status).toBe(JOB_STATUS.ABORTED);
            expect(job.abortReason).toBe('User clicked stop');
            expect(socketClosed).toBe(true);
            expect(jobManager.hasActiveJob('alice')).toBe(false);

            // Session receives partial text
            const session = mockSessionEngine.getSession('alice');
            expect(session.chat.length).toBe(1);
            expect(session.chat[0].mes).toBe('Partial generated text...');
            expect(session.generationState).toBe('idle');
        });

        test('Failed jobs roll back partial output instead of appending an assistant message', async () => {
            const failingGateway = async (_req, res) => {
                res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
                throw new Error('upstream failed after partial output');
            };

            jobManager = new JobManager({
                generateHandler: failingGateway,
                sessionEngine: mockSessionEngine,
                wsBridge: mockWsBridge,
            });

            const job = await jobManager.createJob({
                userId: 'alice',
                body: { core_generation_job_id: 'failed-generation-1' },
            });
            const session = mockSessionEngine.getSession('alice');
            await new Promise((resolve) => job.on('failed', resolve));

            expect(job.status).toBe(JOB_STATUS.FAILED);
            expect(job.fullText).toBe('partial');
            expect(session.chat).toHaveLength(0);
            expect(session.generationState).toBe('idle');
            expect(session.activeAbortController).toBeNull();
        });
    });

    // -------------------------------------------------------------
    // 4. HTTP 端点鉴权、CSRF 门禁与多端协同集成测试
    // -------------------------------------------------------------
    describe('4. Controlled HTTP Endpoints & CSRF Gate Regression', () => {
        let server;
        let baseUrl;

        beforeAll(async () => {
            const app = express();
            app.use(express.json());
            app.use(cookieSession({
                name: 'session',
                keys: ['test-cookie-session-key-1', 'test-cookie-session-key-2'],
                sameSite: 'lax',
                httpOnly: true,
            }));

            const csrfProtection = csrfSync({
                ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
                getTokenFromState: (req) => req.session?.csrfToken,
                getTokenFromRequest: (req) => req.headers['x-csrf-token']?.toString(),
                storeTokenInState: (req, token) => {
                    if (req.session) {
                        req.session.csrfToken = token;
                    }
                },
            });

            // Test token dispenser
            app.get('/test/csrf-token', (req, res) => {
                const token = csrfProtection.generateToken(req);
                res.json({ token });
            });

            // Mock user auth injector
            app.use((req, _res, next) => {
                const userHandle = req.headers['x-test-user'] || 'alice';
                if (req.headers['x-test-unauth'] === 'true') {
                    req.user = undefined;
                } else if (req.headers['x-test-disabled'] === 'true') {
                    req.user = { profile: { handle: userHandle, enabled: false }, directories: {} };
                } else {
                    req.user = {
                        profile: { handle: userHandle, enabled: true, admin: userHandle === 'admin' },
                        directories: {},
                    };
                }
                next();
            });

            // Global CSRF Protection
            app.use(csrfProtection.csrfSynchronisedProtection);

            // Core router mount
            app.use('/api/core', coreRouter);

            // Inject controlled test generator into global jobManager for deterministic HTTP test execution
            const { jobManager: globalJobManager } = await import('../src/core/generation/job-manager.js');
            globalJobManager.generateHandler = async (req, res) => {
                await new Promise((resolve) => {
                    const timer = setTimeout(() => {
                        res.send({ choices: [{ message: { content: 'Generated response' } }] });
                        resolve();
                    }, 500);

                    req.socket.on('close', () => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
            };

            // Error handling middleware
            app.use((err, _req, res, _next) => {
                const status = err.status || err.statusCode || 403;
                res.status(status).json({ ok: false, error: err.message || 'Forbidden' });
            });

            server = http.createServer(app);
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;
        });

        afterAll(async () => {
            if (server && server.listening) {
                await new Promise((resolve) => server.close(resolve));
            }
        });

        async function getCsrfTokenAndCookie() {
            const res = await fetch(`${baseUrl}/test/csrf-token`);
            const data = await res.json();
            const setCookies = typeof res.headers.getSetCookie === 'function'
                ? res.headers.getSetCookie()
                : [res.headers.get('set-cookie')].filter(Boolean);
            const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
            return { token: data.token, cookie };
        }

        test('POST /api/core/generation/jobs without CSRF token returns 403 Forbidden', async () => {
            const { cookie } = await getCsrfTokenAndCookie();
            const res = await fetch(`${baseUrl}/api/core/generation/jobs`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    cookie,
                    // Omit x-csrf-token
                },
                body: JSON.stringify({ model: 'gpt-4' }),
            });
            expect(res.status).toBe(403);
        });

        test('POST /api/core/generation/jobs with mismatched CSRF token returns 403 Forbidden', async () => {
            const { cookie } = await getCsrfTokenAndCookie();
            const res = await fetch(`${baseUrl}/api/core/generation/jobs`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': 'attacker-forged-token-xyz',
                    cookie,
                },
                body: JSON.stringify({ model: 'gpt-4' }),
            });
            expect(res.status).toBe(403);
        });

        test('POST /api/core/generation/jobs without user auth returns 403 Forbidden', async () => {
            const { token, cookie } = await getCsrfTokenAndCookie();
            const res = await fetch(`${baseUrl}/api/core/generation/jobs`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': token,
                    'x-test-unauth': 'true',
                    cookie,
                },
                body: JSON.stringify({ model: 'gpt-4' }),
            });
            expect(res.status).toBe(403);
            const data = await res.json();
            expect(data.error).toMatch(/Unauthorized/);
        });

        test('POST /api/core/generation/jobs with disabled user returns 403 Forbidden', async () => {
            const { token, cookie } = await getCsrfTokenAndCookie();
            const res = await fetch(`${baseUrl}/api/core/generation/jobs`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': token,
                    'x-test-disabled': 'true',
                    cookie,
                },
                body: JSON.stringify({ model: 'gpt-4' }),
            });
            expect(res.status).toBe(403);
            const data = await res.json();
            expect(data.error).toMatch(/disabled/);
        });

        test('Creates generation job with valid CSRF & session, and rejects second concurrent job with 409', async () => {
            const { token, cookie } = await getCsrfTokenAndCookie();
            const user = 'charlie_' + Date.now();

            const res1 = await fetch(`${baseUrl}/api/core/generation/jobs`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': token,
                    'x-test-user': user,
                    cookie,
                },
                body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] }),
            });

            expect(res1.status).toBe(201);
            const data1 = await res1.json();
            expect(data1.ok).toBe(true);
            expect(typeof data1.jobId).toBe('string');

            // Immediate second job from same user returns 409 Conflict
            const res2 = await fetch(`${baseUrl}/api/core/generation/jobs`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': token,
                    'x-test-user': user,
                    cookie,
                },
                body: JSON.stringify({ model: 'gpt-4' }),
            });

            expect(res2.status).toBe(409);
            const data2 = await res2.json();
            expect(data2.error).toMatch(/in progress/);
        });

        test('GET /api/core/generation/jobs/:jobId enforces user isolation and supports lastSeq catch-up', async () => {
            const { token, cookie } = await getCsrfTokenAndCookie();
            const owner = 'dave_' + Date.now();

            const createRes = await fetch(`${baseUrl}/api/core/generation/jobs`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': token,
                    'x-test-user': owner,
                    cookie,
                },
                body: JSON.stringify({ model: 'gpt-4' }),
            });
            const { jobId } = await createRes.json();

            // Other user (eve) cannot read dave's job
            const eveRes = await fetch(`${baseUrl}/api/core/generation/jobs/${jobId}`, {
                headers: {
                    'x-test-user': 'eve',
                    cookie,
                },
            });
            expect(eveRes.status).toBe(403);

            // Owner dave can read their job
            const daveRes = await fetch(`${baseUrl}/api/core/generation/jobs/${jobId}`, {
                headers: {
                    'x-test-user': owner,
                    cookie,
                },
            });
            expect(daveRes.status).toBe(200);
            const daveData = await daveRes.json();
            expect(daveData.ok).toBe(true);
            expect(daveData.job.id).toBe(jobId);

            // Catchup query returns catchup array
            const catchupRes = await fetch(`${baseUrl}/api/core/generation/jobs/${jobId}?lastSeq=0`, {
                headers: {
                    'x-test-user': owner,
                    cookie,
                },
            });
            const catchupData = await catchupRes.json();
            expect(catchupData.ok).toBe(true);
            expect(Array.isArray(catchupData.catchup)).toBe(true);
        });

        test('POST /api/core/generation/jobs/:jobId/abort aborts job and requires valid CSRF and ownership', async () => {
            const { token, cookie } = await getCsrfTokenAndCookie();
            const owner = 'frank_' + Date.now();

            const createRes = await fetch(`${baseUrl}/api/core/generation/jobs`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': token,
                    'x-test-user': owner,
                    cookie,
                },
                body: JSON.stringify({ model: 'gpt-4' }),
            });
            const { jobId } = await createRes.json();

            // Attacker without CSRF cannot abort
            const noCsrfRes = await fetch(`${baseUrl}/api/core/generation/jobs/${jobId}/abort`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    cookie,
                },
                body: JSON.stringify({ reason: 'Malicious stop' }),
            });
            expect(noCsrfRes.status).toBe(403);

            // Another user cannot abort owner's job
            const otherUserRes = await fetch(`${baseUrl}/api/core/generation/jobs/${jobId}/abort`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': token,
                    'x-test-user': 'other_intruder',
                    cookie,
                },
                body: JSON.stringify({ reason: 'Stop someone else' }),
            });
            expect(otherUserRes.status).toBe(403);

            // Owner can successfully abort
            const abortRes = await fetch(`${baseUrl}/api/core/generation/jobs/${jobId}/abort`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': token,
                    'x-test-user': owner,
                    cookie,
                },
                body: JSON.stringify({ reason: 'Finished early' }),
            });
            expect(abortRes.status).toBe(200);
            const abortData = await abortRes.json();
            expect(abortData.ok).toBe(true);
            expect(abortData.status).toBe(JOB_STATUS.ABORTED);
        });
    });

    describe('5. WebSocket Generation Authorization Guards', () => {
        let server;
        let bridge;
        let aliceWs;
        let bobWs;
        let port;
        let originalGetItem;
        let originalTransportEnabled;
        let originalOrchestratorEnabled;
        let originalJobWsBridge;
        let originalGenerateHandler;

        const waitForOpen = (ws) => new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket open')), 3000);
            ws.once('open', () => {
                clearTimeout(timeout);
                resolve();
            });
            ws.once('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });

        const waitForMessage = (ws, predicate) => new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                ws.off('message', onMessage);
                reject(new Error('Timed out waiting for WebSocket message'));
            }, 3000);

            const onMessage = (data) => {
                let message;
                try {
                    message = JSON.parse(data.toString());
                } catch {
                    return;
                }

                if (!predicate(message)) {
                    return;
                }

                clearTimeout(timeout);
                ws.off('message', onMessage);
                resolve(message);
            };

            ws.on('message', onMessage);
        });

        const connectUser = async (userHandle) => {
            const { ticket } = ticketManager.issueTicket({ userHandle });
            const ws = new WebSocket(
                `ws://127.0.0.1:${port}/api/bridge/ws`,
                ['st-core.v1', `ticket.${ticket}`],
                { headers: { Origin: `http://127.0.0.1:${port}` } },
            );
            const handshake = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Timed out waiting for handshake')), 3000);
                const onMessage = (data) => {
                    let message;
                    try {
                        message = JSON.parse(data.toString());
                    } catch {
                        return;
                    }
                    if (message.type !== 'handshake') {
                        return;
                    }
                    clearTimeout(timeout);
                    ws.off('message', onMessage);
                    resolve(message);
                };
                ws.on('message', onMessage);
            });
            await waitForOpen(ws);
            ws.handshake = await handshake;
            return ws;
        };

        beforeAll(async () => {
            originalTransportEnabled = process.env.SILLYTAVERN_CORE_TRANSPORT_ENABLED;
            originalOrchestratorEnabled = process.env.SILLYTAVERN_CORE_GENERATION_ORCHESTRATORENABLED;
            process.env.SILLYTAVERN_CORE_TRANSPORT_ENABLED = 'true';
            process.env.SILLYTAVERN_CORE_GENERATION_ORCHESTRATORENABLED = 'true';

            originalGetItem = storage.getItem;
            storage.getItem = async (key) => {
                if (key === 'user:alice' || key === 'user:bob') {
                    return { handle: key.slice('user:'.length), enabled: true };
                }
                return null;
            };

            bridge = new WebSocketBridge();
            const { jobManager } = await import('../src/core/generation/job-manager.js');
            originalJobWsBridge = jobManager.wsBridge;
            originalGenerateHandler = jobManager.generateHandler;
            jobManager.wsBridge = bridge;
            server = http.createServer();
            bridge.attachServer(server);
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            port = server.address().port;

            aliceWs = await connectUser('alice');
            bobWs = await connectUser('bob');
        });

        afterAll(async () => {
            for (const ws of [aliceWs, bobWs]) {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.close();
                }
            }
            if (bridge) {
                bridge.close();
            }
            if (server?.listening) {
                await new Promise((resolve) => server.close(resolve));
            }

            storage.getItem = originalGetItem;
            const { jobManager } = await import('../src/core/generation/job-manager.js');
            jobManager.wsBridge = originalJobWsBridge;
            jobManager.generateHandler = originalGenerateHandler;
            if (originalTransportEnabled === undefined) {
                delete process.env.SILLYTAVERN_CORE_TRANSPORT_ENABLED;
            } else {
                process.env.SILLYTAVERN_CORE_TRANSPORT_ENABLED = originalTransportEnabled;
            }
            if (originalOrchestratorEnabled === undefined) {
                delete process.env.SILLYTAVERN_CORE_GENERATION_ORCHESTRATORENABLED;
            } else {
                process.env.SILLYTAVERN_CORE_GENERATION_ORCHESTRATORENABLED = originalOrchestratorEnabled;
            }
        });

        test('publishes job creation before fast generation events and broadcasts terminal state', async () => {
            const { jobManager } = await import('../src/core/generation/job-manager.js');
            const previousHandler = jobManager.generateHandler;
            jobManager.generateHandler = async (_req, res) => {
                res.write('data: {"choices":[{"delta":{"content":"fast"}}]}\n\n');
                res.end();
            };

            const createdPromise = waitForMessage(
                aliceWs,
                (message) => message.type === 'job:created' && message.requestId === 'fast-generation-request',
            );
            const tokenPromise = waitForMessage(
                aliceWs,
                (message) => message.type === 'event' && message.event === 'generation:token',
            );
            const completedPromise = waitForMessage(
                aliceWs,
                (message) => message.type === 'event' && message.event === 'generation:completed',
            );

            aliceWs.send(JSON.stringify({
                type: 'generate:start',
                id: 'fast-generation-request',
                payload: {
                    messages: [{ role: 'user', content: 'hello' }],
                    stream: true,
                    chat_completion_source: 'openai',
                    model: 'test-model',
                },
            }));

            const created = await createdPromise;
            expect(created.jobId).toEqual(expect.any(String));

            const tokenEvent = await tokenPromise;
            expect(tokenEvent.data.jobId).toBe(created.jobId);
            expect(tokenEvent.data.seq).toBe(1);
            expect(tokenEvent.data.fullText).toBe('fast');

            const completedEvent = await completedPromise;
            expect(completedEvent.data.jobId).toBe(created.jobId);
            expect(completedEvent.data.fullText).toBe('fast');

            jobManager.generateHandler = previousHandler;
        });

        test('runs a real authenticated server_context generation through PromptAssembler and gateway', async () => {
            const { jobManager } = await import('../src/core/generation/job-manager.js');
            const previousHandler = jobManager.generateHandler;
            const gatewayBodies = [];
            jobManager.generateHandler = async (req, res) => {
                gatewayBodies.push(req.body);
                res.write('data: {"choices":[{"delta":{"content":"server"}}]}\n\n');
                res.write('data: [DONE]\n\n');
                res.end();
            };

            try {
                const requestId = 'server-context-ws-request';
                const createdPromise = waitForMessage(
                    aliceWs,
                    (message) => message.type === 'job:created' && message.requestId === requestId,
                );
                const completedPromise = waitForMessage(
                    aliceWs,
                    (message) => message.type === 'event'
                        && message.event === 'generation:completed'
                        && message.data?.fullText === 'server',
                );

                aliceWs.send(JSON.stringify({
                    type: 'generate:start',
                    id: requestId,
                    payload: {
                        core_prompt_mode: 'server_context',
                        core_prompt_interception: false,
                        stream: true,
                        chat_completion_source: 'openai',
                        model: 'test-model',
                        core_prompt_context: {
                            schemaVersion: 1,
                            settings: {
                                source: 'openai',
                                model: 'test-model',
                                maxContext: 1000,
                                maxTokens: 100,
                                newChatPrompt: '[Chat begins]',
                                newExampleChatPrompt: '[Example Chat]',
                            },
                            generationControl: { type: 'normal', dryRun: false },
                            characterContext: { name1: 'Alice', name2: 'Seraphina' },
                            worldInfo: {
                                worldInfoBefore: 'stale browser value',
                                worldInfoAfter: '',
                                entries: [
                                    {
                                        uid: 'ws-before',
                                        constant: true,
                                        position: 0,
                                        content: 'WS canonical World Info.',
                                    },
                                    {
                                        uid: 'ws-an',
                                        constant: true,
                                        position: 2,
                                        content: 'WS canonical Author Note.',
                                    },
                                    {
                                        uid: 'ws-outlet',
                                        constant: true,
                                        position: 7,
                                        outletName: 'lore',
                                        content: 'WS canonical outlet.',
                                    },
                                ],
                                options: { budget: 0 },
                            },
                            promptOrder: ['worldInfoBefore', 'main', 'authorsNote', 'outletPrompt', 'chatHistory'],
                            prompts: [
                                { identifier: 'authorsNote', role: 'system', content: 'WS base note.' },
                                { identifier: 'outletPrompt', role: 'system', content: 'WS lore: {{outlet::lore}}' },
                            ],
                            extensionPrompts: {},
                            chatHistory: [{ role: 'user', content: 'The signal is active.' }],
                            messageExamples: [],
                            toolsContext: { canPerformToolCalls: false },
                            recordedTokenCounts: {},
                        },
                    },
                }));

                const created = await createdPromise;
                const completed = await completedPromise;

                expect(completed.data.jobId).toBe(created.jobId);
                expect(completed.data.fullText).toBe('server');
                expect(gatewayBodies).toHaveLength(1);
                expect(gatewayBodies[0].core_prompt_context).toBeUndefined();
                expect(gatewayBodies[0].core_prompt_mode).toBeUndefined();
                expect(gatewayBodies[0].messages).toEqual(expect.arrayContaining([
                    { role: 'system', content: 'WS canonical World Info.' },
                    { role: 'system', content: 'WS canonical Author Note.\nWS base note.' },
                    { role: 'system', content: 'WS lore: WS canonical outlet.' },
                    { role: 'user', content: 'The signal is active.' },
                ]));
                expect(gatewayBodies[0].messages).not.toEqual(expect.arrayContaining([
                    { role: 'system', content: 'stale browser value' },
                ]));
            } finally {
                jobManager.generateHandler = previousHandler;
            }
        });

        test('runs authenticated server_context interception without duplicating World Info slots', async () => {
            const { jobManager } = await import('../src/core/generation/job-manager.js');
            const previousHandler = jobManager.generateHandler;
            const previousPluginFlag = process.env.SILLYTAVERN_CORE_GENERATION_PLUGININTERCEPTIONENABLED;
            const gatewayBodies = [];
            process.env.SILLYTAVERN_CORE_GENERATION_PLUGININTERCEPTIONENABLED = 'true';
            jobManager.generateHandler = async (req, res) => {
                gatewayBodies.push(req.body);
                res.write('data: {"choices":[{"delta":{"content":"intercepted"}}]}\n\n');
                res.write('data: [DONE]\n\n');
                res.end();
            };

            try {
                const requestId = 'server-context-ws-interception-request';
                const createdPromise = waitForMessage(
                    aliceWs,
                    (message) => message.type === 'job:created' && message.requestId === requestId,
                );
                const interceptionPromise = waitForMessage(
                    aliceWs,
                    (message) => message.type === 'intercept_req'
                        && message.event === 'chat_completion_prompt_ready',
                );
                const completedPromise = waitForMessage(
                    aliceWs,
                    (message) => message.type === 'event'
                        && message.event === 'generation:completed'
                        && message.data?.fullText === 'intercepted',
                );

                aliceWs.send(JSON.stringify({
                    type: 'generate:start',
                    id: requestId,
                    payload: {
                        core_prompt_mode: 'server_context',
                        core_prompt_interception: true,
                        core_request_id: 'server-context-ws-interception-core-request',
                        stream: true,
                        chat_completion_source: 'openai',
                        model: 'test-model',
                        core_prompt_context: {
                            schemaVersion: 1,
                            settings: {
                                source: 'openai',
                                model: 'test-model',
                                maxContext: 1000,
                                maxTokens: 100,
                                newChatPrompt: '[Chat begins]',
                            },
                            generationControl: { type: 'normal', dryRun: false },
                            characterContext: { name1: 'Alice', name2: 'Seraphina' },
                            worldInfo: {
                                worldInfoBefore: 'stale browser before',
                                worldInfoAfter: 'stale browser after',
                                entries: [
                                    {
                                        uid: 'ws-intercept-before',
                                        constant: true,
                                        position: 0,
                                        content: 'Intercept canonical before.',
                                    },
                                    {
                                        uid: 'ws-intercept-an-top',
                                        constant: true,
                                        position: 2,
                                        content: 'Intercept canonical AN top.',
                                    },
                                    {
                                        uid: 'ws-intercept-an-bottom',
                                        constant: true,
                                        position: 3,
                                        content: 'Intercept canonical AN bottom.',
                                    },
                                    {
                                        uid: 'ws-intercept-outlet',
                                        constant: true,
                                        position: 7,
                                        outletName: 'lore',
                                        content: 'Intercept canonical outlet.',
                                    },
                                ],
                                options: { budget: 0 },
                            },
                            promptOrder: ['worldInfoBefore', 'main', 'authorsNote', 'outletPrompt', 'chatHistory'],
                            prompts: [
                                { identifier: 'authorsNote', role: 'system', content: 'Intercept base note.' },
                                { identifier: 'outletPrompt', role: 'system', content: 'Intercept lore: {{outlet::lore}}' },
                            ],
                            extensionPrompts: {},
                            chatHistory: [{ role: 'user', content: 'The signal is active.' }],
                            messageExamples: [],
                            toolsContext: { canPerformToolCalls: false },
                            recordedTokenCounts: {},
                        },
                    },
                }));

                const created = await createdPromise;
                const interception = await interceptionPromise;
                expect(interception.jobId).toBe(created.jobId);
                expect(interception.payload.chat).toEqual(expect.arrayContaining([
                    { role: 'system', content: 'Intercept canonical before.' },
                    { role: 'system', content: 'Intercept canonical AN top.\nIntercept base note.\nIntercept canonical AN bottom.' },
                    { role: 'system', content: 'Intercept lore: Intercept canonical outlet.' },
                ]));
                expect(interception.payload.chat).not.toEqual(expect.arrayContaining([
                    { role: 'system', content: 'stale browser before' },
                    { role: 'system', content: 'stale browser after' },
                ]));

                const interceptedChat = [
                    ...interception.payload.chat,
                    { role: 'system', content: 'PLUGIN_MARKER' },
                ];
                aliceWs.send(JSON.stringify({
                    type: 'intercept_ack',
                    interceptId: interception.interceptId,
                    jobId: interception.jobId,
                    coreRequestId: interception.coreRequestId,
                    payload: {
                        ...interception.payload,
                        chat: interceptedChat,
                    },
                }));

                const completed = await completedPromise;
                expect(completed.data.jobId).toBe(created.jobId);
                expect(gatewayBodies).toHaveLength(1);
                const messages = gatewayBodies[0].messages;
                const countContent = (content) => messages.filter((message) => message.content === content).length;
                expect(countContent('Intercept canonical before.')).toBe(1);
                expect(countContent('Intercept canonical AN top.\nIntercept base note.\nIntercept canonical AN bottom.')).toBe(1);
                expect(countContent('Intercept lore: Intercept canonical outlet.')).toBe(1);
                expect(countContent('PLUGIN_MARKER')).toBe(1);
                expect(messages).not.toEqual(expect.arrayContaining([
                    { role: 'system', content: 'stale browser before' },
                    { role: 'system', content: 'stale browser after' },
                ]));
            } finally {
                jobManager.generateHandler = previousHandler;
                if (previousPluginFlag === undefined) {
                    delete process.env.SILLYTAVERN_CORE_GENERATION_PLUGININTERCEPTIONENABLED;
                } else {
                    process.env.SILLYTAVERN_CORE_GENERATION_PLUGININTERCEPTIONENABLED = previousPluginFlag;
                }
            }
        });

        test('broadcasts reasoning, tool-call, and usage metadata from the provider stream', async () => {
            const { jobManager } = await import('../src/core/generation/job-manager.js');
            const previousHandler = jobManager.generateHandler;
            jobManager.generateHandler = async (_req, res) => {
                res.write('data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n');
                res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup"}}]}}]}\n\n');
                res.write('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n');
                res.end();
            };

            const createdPromise = waitForMessage(
                aliceWs,
                (message) => message.type === 'job:created' && message.requestId === 'metadata-generation-request',
            );
            const reasoningPromise = waitForMessage(
                aliceWs,
                (message) => message.type === 'event' && message.event === 'generation:reasoning',
            );
            const toolCallPromise = waitForMessage(
                aliceWs,
                (message) => message.type === 'event' && message.event === 'generation:tool_call',
            );
            const usagePromise = waitForMessage(
                aliceWs,
                (message) => message.type === 'event' && message.event === 'generation:usage',
            );
            const completedPromise = waitForMessage(
                aliceWs,
                (message) => message.type === 'event' && message.event === 'generation:completed',
            );

            aliceWs.send(JSON.stringify({
                type: 'generate:start',
                id: 'metadata-generation-request',
                payload: {
                    messages: [{ role: 'user', content: 'hello' }],
                    stream: true,
                    chat_completion_source: 'openai',
                    model: 'test-model',
                },
            }));

            const created = await createdPromise;
            const reasoning = await reasoningPromise;
            const toolCall = await toolCallPromise;
            const usage = await usagePromise;
            const completed = await completedPromise;

            expect(reasoning.data.jobId).toBe(created.jobId);
            expect(reasoning.data.delta).toBe('think');
            expect(toolCall.data.jobId).toBe(created.jobId);
            expect(toolCall.data.delta.function.name).toBe('lookup');
            expect(usage.data.jobId).toBe(created.jobId);
            expect(usage.data.tokenStats).toEqual({ promptTokens: 7, completionTokens: 2 });
            expect(completed.data.finishReason).toBe('stop');
            expect(completed.data.reasoningText).toBe('think');
            expect(completed.data.toolCallDeltas).toHaveLength(1);

            jobManager.generateHandler = previousHandler;
        });

        test('rejects cross-user WebSocket job abort and reconnect attempts', async () => {
            const { jobManager } = await import('../src/core/generation/job-manager.js');
            const aliceJob = new GenerationJob({ userId: 'alice' });
            aliceJob.appendChunk('Alice-only output');
            jobManager.jobs.set(aliceJob.id, aliceJob);

            bobWs.send(JSON.stringify({
                type: 'generate:reconnect',
                payload: { jobId: aliceJob.id, lastSeq: 0 },
            }));
            const reconnectResult = await waitForMessage(bobWs, (message) => message.type === 'job:failed');
            expect(reconnectResult.error).toMatch(/Unauthorized/);
            expect(aliceJob.status).toBe(JOB_STATUS.QUEUED);

            bobWs.send(JSON.stringify({
                type: 'generate:abort',
                payload: { jobId: aliceJob.id, reason: 'cross-user attack' },
            }));
            const abortResult = await waitForMessage(bobWs, (message) => message.type === 'job:failed');
            expect(abortResult.error).toMatch(/Unauthorized/);
            expect(aliceJob.status).toBe(JOB_STATUS.QUEUED);

            jobManager.jobs.delete(aliceJob.id);
        });

        test('allows the owner to reconnect and abort their own job', async () => {
            const { jobManager } = await import('../src/core/generation/job-manager.js');
            const aliceJob = new GenerationJob({ userId: 'alice' });
            aliceJob.appendChunk('Owner output');
            jobManager.jobs.set(aliceJob.id, aliceJob);

            aliceWs.send(JSON.stringify({
                type: 'generate:reconnect',
                id: 'owner-reconnect-request',
                payload: { jobId: aliceJob.id, lastSeq: 0 },
            }));
            const reconnectResult = await waitForMessage(aliceWs, (message) => message.type === 'job:catchup');
            expect(reconnectResult.chunks.map((chunk) => chunk.delta)).toEqual(['Owner output']);
            expect(reconnectResult.requestId).toBe('owner-reconnect-request');

            aliceWs.send(JSON.stringify({
                type: 'generate:abort',
                id: 'owner-abort-request',
                payload: { jobId: aliceJob.id, reason: 'owner stop' },
            }));
            const abortResult = await waitForMessage(aliceWs, (message) => message.type === 'job:aborted');
            expect(abortResult.status).toBe(JOB_STATUS.ABORTED);
            expect(abortResult.requestId).toBe('owner-abort-request');
            expect(aliceJob.status).toBe(JOB_STATUS.ABORTED);

            jobManager.jobs.delete(aliceJob.id);
        });

        test('replays missed generation chunks after an authenticated WebSocket reconnect', async () => {
            const { jobManager } = await import('../src/core/generation/job-manager.js');
            const previousHandler = jobManager.generateHandler;
            let releaseSecondChunk;
            const secondChunkReleased = new Promise((resolve) => {
                releaseSecondChunk = resolve;
            });

            jobManager.generateHandler = async (_req, res) => {
                res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
                await secondChunkReleased;
                res.write('data: {"choices":[{"delta":{"content":" second"}}]}\n\n');
                res.end();
            };

            try {
                const requestId = 'authenticated-reconnect-catchup-request';
                const createdPromise = waitForMessage(
                    aliceWs,
                    (message) => message.type === 'job:created' && message.requestId === requestId,
                );
                const firstTokenPromise = waitForMessage(
                    aliceWs,
                    (message) => message.type === 'event' && message.event === 'generation:token',
                );

                aliceWs.send(JSON.stringify({
                    type: 'generate:start',
                    id: requestId,
                    payload: {
                        messages: [{ role: 'user', content: 'reconnect me' }],
                        stream: true,
                        chat_completion_source: 'openai',
                        model: 'test-model',
                    },
                }));

                const created = await createdPromise;
                const firstToken = await firstTokenPromise;
                expect(firstToken.data.fullText).toBe('first');

                const disconnected = aliceWs;
                const closedPromise = new Promise((resolve) => disconnected.once('close', resolve));
                disconnected.close();
                await closedPromise;

                aliceWs = await connectUser('alice');
                const completedPromise = waitForMessage(
                    aliceWs,
                    (message) => message.type === 'event'
                        && message.event === 'generation:completed'
                        && message.data?.jobId === created.jobId,
                );
                releaseSecondChunk();
                await completedPromise;

                aliceWs.send(JSON.stringify({
                    type: 'generate:reconnect',
                    id: 'authenticated-reconnect-catchup-replay',
                    payload: { jobId: created.jobId, lastSeq: 1 },
                }));
                const catchup = await waitForMessage(
                    aliceWs,
                    (message) => message.type === 'job:catchup'
                        && message.requestId === 'authenticated-reconnect-catchup-replay',
                );

                expect(catchup.status).toBe(JOB_STATUS.COMPLETED);
                expect(catchup.chunks.map((chunk) => chunk.delta)).toEqual([' second']);
                expect(catchup.fullText).toBe('first second');
            } finally {
                releaseSecondChunk();
                jobManager.generateHandler = previousHandler;
            }
        });

        test('rejects WebSocket generation start when the orchestrator is disabled', async () => {
            process.env.SILLYTAVERN_CORE_GENERATION_ORCHESTRATORENABLED = 'false';
            bobWs.send(JSON.stringify({ type: 'generate:start', payload: {} }));

            const result = await waitForMessage(bobWs, (message) => message.type === 'job:failed');
            expect(result.error).toMatch(/disabled/);

            process.env.SILLYTAVERN_CORE_GENERATION_ORCHESTRATORENABLED = 'true';
        });

        test('advertises authenticated Core capabilities in the handshake', () => {
            expect(aliceWs.handshake.status).toBe('authenticated');
            expect(aliceWs.handshake.capabilities).toMatchObject({
                orchestrator: true,
                serverPromptAssembly: true,
                browserPromptHandoff: false,
                promptInterception: false,
            });
        });

        test('does not accept a plugin interception acknowledgement from another user', async () => {
            const interception = bridge.requestInterception('alice', 'test-interception', { prompt: 'secret' }, 1000);
            const request = await waitForMessage(aliceWs, (message) => message.type === 'intercept_req');

            bobWs.send(JSON.stringify({
                type: 'intercept_ack',
                interceptId: request.interceptId,
                payload: { prompt: 'tampered by bob' },
            }));

            const resolvedByBob = await Promise.race([
                interception.then(() => true),
                new Promise((resolve) => setTimeout(() => resolve(false), 50)),
            ]);
            expect(resolvedByBob).toBe(false);

            aliceWs.send(JSON.stringify({
                type: 'intercept_ack',
                interceptId: request.interceptId,
                payload: { prompt: 'approved by alice' },
            }));

            await expect(interception).resolves.toEqual({ prompt: 'approved by alice' });
        });

        test('binds plugin interception acknowledgements to the target connection and request', async () => {
            const interception = bridge.requestInterception(
                'alice',
                'chat_completion_prompt_ready',
                { chat: [{ role: 'user', content: 'targeted' }], dryRun: false },
                1000,
                {
                    targetWs: [...bridge.userClients.get('alice')][0],
                    jobId: 'job-targeted',
                    coreRequestId: 'request-targeted',
                },
            );
            const request = await waitForMessage(aliceWs, (message) => message.type === 'intercept_req');

            expect(request.jobId).toBe('job-targeted');
            expect(request.coreRequestId).toBe('request-targeted');

            bobWs.send(JSON.stringify({
                type: 'intercept_ack',
                interceptId: request.interceptId,
                jobId: request.jobId,
                coreRequestId: request.coreRequestId,
                payload: { chat: [{ role: 'user', content: 'wrong connection' }] },
            }));

            await expect(Promise.race([
                interception.then(() => 'resolved'),
                new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
            ])).resolves.toBe('pending');

            aliceWs.send(JSON.stringify({
                type: 'intercept_ack',
                interceptId: request.interceptId,
                jobId: request.jobId,
                coreRequestId: request.coreRequestId,
                payload: {
                    chat: [{ role: 'user', content: 'approved connection' }],
                    dryRun: false,
                },
            }));

            await expect(interception).resolves.toEqual({
                chat: [{ role: 'user', content: 'approved connection' }],
                dryRun: false,
            });
        });

        test('uses the mutable CHAT_COMPLETION_PROMPT_READY payload for plugin interception', async () => {
            const interception = bridge.requestInterception(
                'alice',
                'chat_completion_prompt_ready',
                { chat: [{ role: 'user', content: 'original' }], dryRun: false },
                1000,
            );
            const request = await waitForMessage(aliceWs, (message) => message.type === 'intercept_req');

            expect(request.event).toBe('chat_completion_prompt_ready');
            expect(request.payload.chat[0].content).toBe('original');

            request.payload.chat[0].content = 'modified by plugin';
            aliceWs.send(JSON.stringify({
                type: 'intercept_ack',
                interceptId: request.interceptId,
                payload: request.payload,
            }));

            await expect(interception).resolves.toEqual({
                chat: [{ role: 'user', content: 'modified by plugin' }],
                dryRun: false,
            });
        });

        test('falls back to the original prompt when plugin interception times out', async () => {
            const originalPayload = { chat: [{ role: 'user', content: 'original' }], dryRun: false };
            const interception = bridge.requestInterception('alice', 'chat_completion_prompt_ready', originalPayload, 20);
            await waitForMessage(aliceWs, (message) => message.type === 'intercept_req');

            await expect(interception).resolves.toBe(originalPayload);
        });

        test('serves and broadcasts the authenticated user state snapshot', async () => {
            const session = sessionEngine.getSession('alice');
            session.syncFullState({
                characterName: 'Alice Assistant',
                chatId: 'chat-state-test',
                chat: [{ name: 'Alice', is_user: true, is_system: false, send_date: 'now', mes: 'Hello' }],
                metadata: { variables: { mood: 'calm' } },
            });

            const patchPromise = waitForMessage(
                aliceWs,
                (message) => message.type === 'event'
                    && message.event === 'state:patch'
                    && message.data?.patch?.op === 'append',
            );

            session.appendMessage({
                name: 'Alice Assistant',
                is_user: false,
                is_system: false,
                send_date: 'now',
                mes: 'Reply',
            });

            const patchEvent = await patchPromise;
            expect(patchEvent.data.patch.version).toBe(session.stateVersion);
            expect(patchEvent.data.patch.message.mes).toBe('Reply');

            aliceWs.send(JSON.stringify({
                type: 'rpc',
                id: 'state-snapshot-test',
                method: 'getStateSnapshot',
                params: {},
            }));

            const rpcResult = await waitForMessage(
                aliceWs,
                (message) => message.type === 'rpc_result' && message.id === 'state-snapshot-test',
            );
            expect(rpcResult.error).toBeFalsy();
            expect(rpcResult.result.chatId).toBe('chat-state-test');
            expect(rpcResult.result.chat).toHaveLength(2);
            expect(rpcResult.result.chatMetadata.variables.mood).toBe('calm');
        });

        test('supports metadata and splice mutations through authenticated RPC', async () => {
            const metadataRpcId = 'state-metadata-test';
            aliceWs.send(JSON.stringify({
                type: 'rpc',
                id: metadataRpcId,
                method: 'updateMetadata',
                params: { updates: { variables: { mood: 'focused', temporary: 'yes' } } },
            }));
            const metadataResult = await waitForMessage(
                aliceWs,
                (message) => message.type === 'rpc_result' && message.id === metadataRpcId,
            );
            expect(metadataResult.error).toBeFalsy();
            expect(metadataResult.result.success).toBe(true);

            const spliceRpcId = 'state-splice-test';
            aliceWs.send(JSON.stringify({
                type: 'rpc',
                id: spliceRpcId,
                method: 'spliceChat',
                params: {
                    start: 0,
                    deleteCount: 1,
                    items: [{ name: 'Replacement', is_user: true, is_system: false, send_date: 'now', mes: 'Updated' }],
                },
            }));
            const spliceResult = await waitForMessage(
                aliceWs,
                (message) => message.type === 'rpc_result' && message.id === spliceRpcId,
            );
            expect(spliceResult.error).toBeFalsy();
            expect(spliceResult.result.success).toBe(true);

            const session = sessionEngine.getSession('alice');
            expect(session.chat[0].name).toBe('Replacement');
            expect(session.chatMetadata.variables.mood).toBe('focused');
            expect(session.chatMetadata.variables.temporary).toBe('yes');
        });
    });
});
