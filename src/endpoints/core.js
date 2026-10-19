import express from 'express';
import sessionEngine from '../core/session-engine.js';

export const router = express.Router();

router.get('/status', (req, res) => {
    const session = sessionEngine.getSession('default');
    res.json({
        ok: true,
        summary: session.getSummary(),
        activeSessions: sessionEngine.sessions.size,
    });
});

export default router;
