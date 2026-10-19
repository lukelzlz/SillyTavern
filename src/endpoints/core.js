import express from 'express';
import sessionEngine from '../core/session-engine.js';
import WorldInfoEngine from '../core/world-info-engine.js';
import PromptEngine from '../core/prompt-engine.js';

export const router = express.Router();

router.get('/status', (req, res) => {
    const session = sessionEngine.getSession('default');
    res.json({
        ok: true,
        summary: session.getSummary(),
        activeSessions: sessionEngine.sessions.size,
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

router.post('/chat-completions/generate', async (req, res, next) => {
    try {
        const { default: ChatCompletionEngine } = await import('../core/chat-completion-engine.js');
        await ChatCompletionEngine.generate(req, res);
    } catch (err) {
        next(err);
    }
});

export default router;
