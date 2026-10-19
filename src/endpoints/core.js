import express from 'express';
import WorldInfoEngine from '../core/world-info-engine.js';
import PromptEngine from '../core/prompt-engine.js';

export const router = express.Router();

router.get('/status', (req, res) => {
    // P0 Security: Do not expose default session details or user chat summaries
    res.json({
        ok: true,
        bridgeDisabled: true,
    });
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

export default router;
