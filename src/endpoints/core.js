import express from 'express';
import crypto from 'node:crypto';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import WorldInfoEngine from '../core/world-info-engine.js';
import PromptEngine from '../core/prompt-engine.js';
import ticketManager from '../core/ticket-manager.js';
import jobManager from '../core/generation/job-manager.js';
import { getConfigValue } from '../util.js';
import { getIpAddress } from '../express-common.js';

/**
 * Safe configuration reader that falls back gracefully when CLI args are not initialized.
 * @param {string} key
 * @param {any} defaultValue
 * @param {'boolean'|'number'|null} [typeConverter]
 * @returns {any}
 */
function getCoreConfig(key, defaultValue, typeConverter = null) {
    const envKey = 'SILLYTAVERN_' + String(key).toUpperCase().replace(/\./g, '_');
    if (envKey in process.env) {
        const val = process.env[envKey];
        if (typeConverter === 'boolean') {
            return String(val).toLowerCase() === 'true';
        }
        if (typeConverter === 'number') {
            const num = parseFloat(val);
            return isNaN(num) ? defaultValue : num;
        }
        return val;
    }
    if (!globalThis.COMMAND_LINE_ARGS) {
        return defaultValue;
    }
    return getConfigValue(key, defaultValue, typeConverter);
}

function getAccountVersion(user) {
    if (!user) return '';
    return crypto.createHash('shake256', { outputLength: 8 })
        .update(JSON.stringify([user.handle, user.password, user.salt]))
        .digest('hex');
}

export const router = express.Router();

let lastLimiterConfig = { points: 10, duration: 60 };
let ticketLimiter = new RateLimiterMemory(lastLimiterConfig);

function getLimiter() {
    const points = getCoreConfig('core.transport.rateLimitPoints', 10, 'number');
    const duration = getCoreConfig('core.transport.rateLimitDurationSeconds', 60, 'number');
    if (lastLimiterConfig.points !== points || lastLimiterConfig.duration !== duration) {
        lastLimiterConfig = { points, duration };
        ticketLimiter = new RateLimiterMemory({ points, duration });
    }
    return ticketLimiter;
}

router.get('/status', (req, res) => {
    const isEnabled = getCoreConfig('core.transport.enabled', false, 'boolean');
    // P0 Security: Do not expose default session details or user chat summaries
    res.json({
        ok: true,
        bridgeDisabled: !isEnabled,
        transportEnabled: isEnabled,
    });
});

/**
 * Issues a short-lived single-use ticket for authenticated WebSocket upgrade.
 * Protected by setUserDataMiddleware + csrfSyncProtection + requireLoginMiddleware.
 */
router.post('/auth/ticket', async (req, res) => {
    try {
        const isEnabled = getCoreConfig('core.transport.enabled', false, 'boolean');
        if (!isEnabled) {
            return res.status(403).json({
                ok: false,
                error: 'Core WebSocket transport is disabled.',
            });
        }

        if (!req.user || !req.user.profile) {
            return res.status(403).json({
                ok: false,
                error: 'Unauthorized: User not authenticated.',
            });
        }

        const user = req.user.profile;
        if (user.enabled === false) {
            return res.status(403).json({
                ok: false,
                error: 'Unauthorized: User is disabled.',
            });
        }

        const ip = getIpAddress(req, false) || 'unknown';
        const rateLimitKey = `${user.handle || 'default'}:${ip}`;
        try {
            await getLimiter().consume(rateLimitKey);
        } catch {
            return res.status(429).json({
                ok: false,
                error: 'Too many ticket requests. Please try again later.',
            });
        }

        const accountVersion = typeof getAccountVersion === 'function' ? getAccountVersion(user) : undefined;
        const result = ticketManager.issueTicket({
            userHandle: user.handle || 'default',
            accountVersion,
            ip,
        });

        return res.json({
            ok: true,
            ticket: result.ticket,
            expiresIn: result.expiresIn,
        });
    } catch (err) {
        console.error('[Core Auth Ticket] Error issuing ticket:', err);
        return res.status(500).json({
            ok: false,
            error: err.message || 'Failed to issue ticket',
        });
    }
});

router.post('/world-info/scan', (req, res) => {
    try {
        const result = WorldInfoEngine.scan(req.body);
        res.json({ ok: true, result });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.post('/prompt/assemble', (req, res) => {
    try {
        const result = PromptEngine.assemble(req.body);
        res.json({ ok: true, result });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.post('/chat-completions/generate', async (req, res) => {
    // P0 Security: Core generation routing is disabled by default to prevent SSRF and multi-user data leak.
    res.status(403).json({
        error: {
            message: 'Core generation routing is disabled by default for security.',
        },
    });
});

/**
 * Creates and enqueues a background generation job.
 * Protected by setUserDataMiddleware + csrfSyncProtection + requireLoginMiddleware.
 */
router.post('/generation/jobs', async (req, res) => {
    try {
        const isEnabled = getCoreConfig('core.generation.orchestratorEnabled', true, 'boolean');
        if (!isEnabled) {
            return res.status(403).json({
                ok: false,
                error: 'Generation orchestrator is disabled.',
            });
        }

        if (!req.user || !req.user.profile) {
            return res.status(403).json({
                ok: false,
                error: 'Unauthorized: User not authenticated.',
            });
        }

        const user = req.user.profile;
        if (user.enabled === false) {
            return res.status(403).json({
                ok: false,
                error: 'Unauthorized: User is disabled.',
            });
        }

        const userId = user.handle || 'default';

        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({
                ok: false,
                error: 'Invalid request body.',
            });
        }

        if (jobManager.hasActiveJob(userId)) {
            return res.status(409).json({
                ok: false,
                error: 'Another generation job is currently in progress.',
            });
        }

        const job = await jobManager.createJob({
            userId,
            body: req.body,
            req,
        });

        return res.status(201).json({
            ok: true,
            jobId: job.id,
            status: job.status,
            createdAt: job.createdAt,
        });
    } catch (err) {
        if (err.statusCode === 409 || err.status === 409 || err.name === 'ActiveJobConflictError') {
            return res.status(409).json({
                ok: false,
                error: 'Another generation job is currently in progress.',
            });
        }
        console.error('[Core Generation Jobs] Error creating job:', err);
        return res.status(500).json({
            ok: false,
            error: err.message || 'Failed to create generation job',
        });
    }
});

/**
 * Retrieves generation job status, full/partial text, and optional catchup chunks for reconnection.
 */
router.get('/generation/jobs/:jobId', (req, res) => {
    try {
        const isEnabled = getCoreConfig('core.generation.orchestratorEnabled', true, 'boolean');
        if (!isEnabled) {
            return res.status(403).json({
                ok: false,
                error: 'Generation orchestrator is disabled.',
            });
        }

        if (!req.user || !req.user.profile) {
            return res.status(403).json({
                ok: false,
                error: 'Unauthorized: User not authenticated.',
            });
        }

        const user = req.user.profile;
        if (user.enabled === false) {
            return res.status(403).json({
                ok: false,
                error: 'Unauthorized: User is disabled.',
            });
        }

        const userId = user.handle || 'default';
        const jobId = req.params.jobId;

        const job = jobManager.getJob(jobId);
        if (!job) {
            return res.status(404).json({
                ok: false,
                error: 'Job not found.',
            });
        }

        // Multi-user isolation
        if (job.userId !== userId && user.admin !== true) {
            return res.status(403).json({
                ok: false,
                error: 'Unauthorized: You do not have access to this job.',
            });
        }

        const responseData = {
            ok: true,
            job: job.toJSON(),
        };

        if (req.query.lastSeq !== undefined) {
            const catchupInfo = job.getCatchupChunks(req.query.lastSeq);
            responseData.catchup = catchupInfo.chunks;
            responseData.catchupInfo = catchupInfo;
        }

        return res.json(responseData);
    } catch (err) {
        console.error('[Core Generation Jobs] Error retrieving job:', err);
        return res.status(500).json({
            ok: false,
            error: err.message || 'Failed to retrieve generation job',
        });
    }
});

/**
 * Explicitly aborts an active generation job.
 */
router.post('/generation/jobs/:jobId/abort', (req, res) => {
    try {
        const isEnabled = getCoreConfig('core.generation.orchestratorEnabled', true, 'boolean');
        if (!isEnabled) {
            return res.status(403).json({
                ok: false,
                error: 'Generation orchestrator is disabled.',
            });
        }

        if (!req.user || !req.user.profile) {
            return res.status(403).json({
                ok: false,
                error: 'Unauthorized: User not authenticated.',
            });
        }

        const user = req.user.profile;
        if (user.enabled === false) {
            return res.status(403).json({
                ok: false,
                error: 'Unauthorized: User is disabled.',
            });
        }

        const userId = user.handle || 'default';
        const jobId = req.params.jobId;

        const job = jobManager.getJob(jobId);
        if (!job) {
            return res.status(404).json({
                ok: false,
                error: 'Job not found.',
            });
        }

        if (job.userId !== userId && user.admin !== true) {
            return res.status(403).json({
                ok: false,
                error: 'Unauthorized: You cannot abort this job.',
            });
        }

        const reason = req.body?.reason || 'User aborted';
        jobManager.abortJob(jobId, reason);

        return res.json({
            ok: true,
            jobId: job.id,
            status: job.status,
            abortReason: job.abortReason,
        });
    } catch (err) {
        console.error('[Core Generation Jobs] Error aborting job:', err);
        return res.status(500).json({
            ok: false,
            error: err.message || 'Failed to abort generation job',
        });
    }
});

export default router;
