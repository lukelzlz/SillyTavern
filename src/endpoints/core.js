import express from 'express';
import sessionEngine from '../core/session-engine.js';
import WorldInfoEngine from '../core/world-info-engine.js';

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

export default router;
