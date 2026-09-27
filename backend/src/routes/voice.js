// Adaptive Neural Teacher Voice — HTTP surface.
//   GET  /api/voice/status    -> { enabled, model }   (never exposes keys or the voice id)
//   POST /api/voice/generate  { text, studentLevel?, subject?, language?, voiceId? } -> audio/mpeg
// If ELEVENLABS_API_KEY / TEACHER_VOICE_ID are not set the portal keeps working: status reports
// enabled:false and the frontend falls back to the browser's built-in speech voice.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { generateTeacherVoice } = require('../services/teacherVoice/voicePipeline');
const { isVoiceConfigured } = require('../services/teacherVoice/voiceEngine');

const router = express.Router();
const MAX_TEXT_CHARS = Number(process.env.VOICE_MAX_TEXT_CHARS || 6000);
const LEVELS = ['beginner', 'intermediate', 'advanced'];

// Speech costs real credits, so this limiter is stricter than the /api/ai one.
router.use(rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.VOICE_RATE_LIMIT_PER_MINUTE || 20),
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many voice requests — please wait a moment.' },
}));

router.get('/status', (_req, res) => {
  res.json({ enabled: isVoiceConfigured(), model: (process.env.ELEVENLABS_MODEL_ID || 'eleven_v3') });
});

router.post('/generate', async (req, res) => {
  try {
    if (!isVoiceConfigured()) return res.status(503).json({ error: 'Teacher voice is not configured on the server.', details: 'Set ELEVENLABS_API_KEY and TEACHER_VOICE_ID in backend/.env.' });
    const { text, language = 'en', subject = 'general' } = req.body || {};
    const studentLevel = LEVELS.includes(req.body && req.body.studentLevel) ? req.body.studentLevel : 'intermediate';
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
    if (text.length > MAX_TEXT_CHARS) return res.status(400).json({ error: `text is too long (max ${MAX_TEXT_CHARS} characters)` });

    // A client-chosen voice is ignored unless the operator explicitly allows it.
    const allowClientVoice = String(process.env.VOICE_ALLOW_CLIENT_VOICE_ID || '').toLowerCase() === 'true';
    const voiceId = (allowClientVoice && req.body.voiceId ? String(req.body.voiceId) : process.env.TEACHER_VOICE_ID).trim();

    const result = await generateTeacherVoice({ text, voiceId, language: String(language).slice(0, 8), studentLevel, subject: String(subject).slice(0, 60) });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'inline; filename="ai-teacher-lesson.mp3"');
    res.setHeader('X-Voice-Cached', result.metadata.cached ? '1' : '0');
    res.setHeader('X-Voice-Quality', String(result.metadata.quality.score));
    res.send(result.audio);
  } catch (err) {
    console.error('[voice]', err.message);
    res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 500).json({ error: 'Voice generation failed' });
  }
});

module.exports = router;
