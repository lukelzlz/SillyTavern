import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const eventSource = { emit: jest.fn().mockResolvedValue(undefined) };
jest.unstable_mockModule('../public/script.js', () => ({ eventSource, token: '' }));
// Import the browser singleton without scheduling its real network connection in Node.
const initQueue = jest.spyOn(global, 'queueMicrotask').mockImplementation(() => {});
const { BridgeClient } = await import('../public/scripts/core/bridge-client.js');
initQueue.mockRestore();

describe('BridgeClient active generation identity', () => {
    let client;

    const handshake = (activeJob) => client.handleMessage(JSON.stringify({ type: 'handshake', activeJob }));
    const event = (name, data) => client.handleMessage(JSON.stringify({ type: 'event', event: name, data }));

    beforeEach(() => {
        jest.spyOn(BridgeClient.prototype, 'init').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
        eventSource.emit.mockClear();
        client = new BridgeClient();
    });

    afterEach(() => jest.restoreAllMocks());

    test.each([
        { id: 'active-job' },
        { jobId: 'active-job' },
        { id: 'active-job', jobId: '' },
        { id: 'active-job', jobId: 123 },
        { id: 'legacy-id', jobId: 'active-job' },
    ])('normalizes handshake identity and preserves metadata: %j', async (identity) => {
        const snapshot = { ...identity, status: 'STREAMING', fullText: 'partial', lastSeq: 4, chatId: 'chat-1' };
        await handshake(snapshot);

        expect(client.activeGenerationJob).toEqual({ ...snapshot, jobId: 'active-job' });
        expect(eventSource.emit).toHaveBeenCalledWith('generation:active', { ...snapshot, jobId: 'active-job' });
        expect(client.isReady).toBe(true);
    });

    test.each([null, undefined, {}, { id: '' }, { id: ' ' }, { id: 123 }, { jobId: {} }])(
        'clears stale state and cannot stop a handshake without a valid identity: %j',
        async (snapshot) => {
            client.activeGenerationJob = { jobId: 'stale-job' };
            const abort = jest.spyOn(client, 'abortGeneration').mockResolvedValue({});
            await handshake(snapshot);

            expect(client.activeGenerationJob).toBeNull();
            expect(eventSource.emit).not.toHaveBeenCalled();
            await expect(client.stopActiveGeneration()).resolves.toBeNull();
            expect(abort).not.toHaveBeenCalled();
        },
    );

    test('updates a restored task on token events without discarding snapshot metadata', async () => {
        await handshake({ id: 'active-job', status: 'PREPARING', chatId: 'chat-1', lastSeq: 0 });
        await event('generation:token', { jobId: 'active-job', fullText: 'Hello', seq: 1 });

        expect(client.activeGenerationJob).toMatchObject({
            id: 'active-job', jobId: 'active-job', status: 'STREAMING', chatId: 'chat-1', fullText: 'Hello', seq: 1,
        });
    });

    test.each(['completed', 'aborted', 'failed'])('clears a restored task on generation:%s', async (terminal) => {
        await handshake({ id: 'active-job', status: 'STREAMING' });
        const enqueue = jest.fn();
        client.generationListeners.set('active-job', { enqueue });
        await event(`generation:${terminal}`, { jobId: 'active-job' });

        expect(client.activeGenerationJob).toBeNull();
        expect(enqueue).toHaveBeenCalledWith(`generation:${terminal}`, { jobId: 'active-job' });
        const abort = jest.spyOn(client, 'abortGeneration').mockResolvedValue({});
        await expect(client.stopActiveGeneration()).resolves.toBeNull();
        expect(abort).not.toHaveBeenCalled();
    });

    test.each(['token', 'completed', 'aborted', 'failed'])('ignores generation:%s for another task', async (name) => {
        const snapshot = { id: 'active-job', status: 'STREAMING', fullText: 'partial' };
        await handshake(snapshot);
        const restored = client.activeGenerationJob;
        await event(`generation:${name}`, { jobId: 'other-job', fullText: 'unrelated' });

        expect(client.activeGenerationJob).toBe(restored);
        expect(client.activeGenerationJob).toEqual({ ...snapshot, jobId: 'active-job' });
    });

    test('normalizes the snapshot before reconnect recovery observes readiness', async () => {
        let recovered;
        jest.spyOn(client, 'recoverGenerationListeners').mockImplementation(async () => {
            recovered = { ready: client.isReady, job: client.activeGenerationJob };
        });
        await handshake({ id: 'active-job', status: 'STREAMING' });

        expect(recovered).toEqual({
            ready: true,
            job: { id: 'active-job', jobId: 'active-job', status: 'STREAMING' },
        });
    });

    test('deduplicates remote stop for a restored task and releases the in-flight request', async () => {
        await handshake({ id: 'active-job', status: 'STREAMING' });
        let finishAbort;
        const abort = jest.spyOn(client, 'abortGeneration').mockImplementation(() => new Promise(resolve => {
            finishAbort = resolve;
        }));
        const first = client.stopActiveGeneration('first stop');
        const second = client.stopActiveGeneration('second stop');

        expect(second).toBe(first);
        expect(abort).toHaveBeenCalledTimes(1);
        expect(abort).toHaveBeenCalledWith('active-job', 'first stop', 5000);
        finishAbort({ status: 'ABORTED' });
        await expect(first).resolves.toEqual({ status: 'ABORTED' });
        expect(client.activeGenerationAbortPromise).toBeNull();
        await event('generation:aborted', { jobId: 'active-job' });
        expect(client.activeGenerationJob).toBeNull();
    });

    test('keeps the live started path working without a handshake snapshot', async () => {
        await handshake(null);
        await event('generation:started', { jobId: 'live-job', status: 'PREPARING' });
        expect(client.activeGenerationJob).toEqual({ jobId: 'live-job', status: 'PREPARING' });
        await event('generation:token', { jobId: 'live-job', fullText: 'Hello' });
        expect(client.activeGenerationJob).toMatchObject({ jobId: 'live-job', status: 'STREAMING', fullText: 'Hello' });
        await event('generation:completed', { jobId: 'live-job' });
        expect(client.activeGenerationJob).toBeNull();
    });

    test('reports a matching chat failure once and still delivers it to the stream', async () => {
        const onGenerationError = jest.fn();
        await client.bindState({ chat: [], chatId: 'chat-1', onGenerationError, bootstrap: false });
        await event('generation:started', { jobId: 'job-1', chatId: 'chat-1', characterId: '0' });
        const enqueue = jest.fn();
        client.generationListeners.set('job-1', { enqueue });
        await event('generation:failed', { jobId: 'job-1', error: 'failure' });
        await event('generation:failed', { jobId: 'job-1', error: 'duplicate' });
        expect(onGenerationError).toHaveBeenCalledTimes(1);
        expect(onGenerationError).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', chatId: 'chat-1', error: 'failure' }));
        expect(enqueue).toHaveBeenCalledWith('generation:failed', { jobId: 'job-1', error: 'failure' });
        expect(client.activeGenerationJob).toBeNull();
    });

    test('does not notify another chat or an unrelated job and isolates callback errors', async () => {
        const onGenerationError = jest.fn(() => { throw new Error('UI callback'); });
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        await client.bindState({ chat: [], chatId: 'chat-2', onGenerationError, bootstrap: false });
        await handshake({ id: 'job-1', chatId: 'chat-1' });
        await event('generation:failed', { jobId: 'unrelated' });
        await event('generation:failed', { jobId: 'job-1' });
        expect(onGenerationError).not.toHaveBeenCalled();
        await handshake({ id: 'job-2', chatId: 'chat-2' });
        const enqueue = jest.fn();
        client.generationListeners.set('job-2', { enqueue });
        await event('generation:failed', { jobId: 'job-2' });
        expect(onGenerationError).toHaveBeenCalledTimes(1);
        expect(enqueue).toHaveBeenCalled();
        expect(client.activeGenerationJob).toBeNull();
    });

    test.each(['snapshot', 'catchup', 'live'])('tags %s failures for local placeholder rollback', async (source) => {
        jest.spyOn(client, 'getGenerationJob').mockResolvedValue({
            job: { status: source === 'snapshot' ? 'FAILED' : 'STREAMING', error: 'failed' },
        });
        jest.spyOn(client, 'reconnectGeneration').mockImplementation(async () => {
            if (source === 'live') client.dispatchGenerationEvent('generation:failed', { jobId: 'job-1', error: 'failed' });
            return source === 'catchup' ? { status: 'FAILED', error: 'failed' } : null;
        });
        const stream = client.followGeneration('job-1');
        await expect(stream.next()).rejects.toMatchObject({ code: 'CORE_GENERATION_FAILED' });
        expect(client.generationListeners.size).toBe(0);
    });
});
