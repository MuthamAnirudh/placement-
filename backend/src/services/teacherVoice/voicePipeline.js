/*
  Adaptive Neural Teacher Voice pipeline:
    raw text / AI Markdown -> speakable text -> semantic segments -> ElevenLabs v3 script
    -> pronunciation normalization -> chunking (v3 request limit) -> synthesis with a bounded
    quality-control loop -> concatenated MP3, with an in-memory LRU cache to save credits.
*/
const crypto = require('crypto');
const { createTeachingSegments, renderForElevenV3 } = require('./teacherScript');
const { normalizePronunciation, toSpeakable } = require('./pronunciation');
const { synthesizeVoice: realSynthesize } = require('./voiceEngine');
const { evaluateVoiceQuality } = require('./audioQuality');

const MAX_CHUNK_CHARS = 2400;   // comfortably below the per-request character limit of eleven_v3

const CACHE_TTL_MS = Number(process.env.VOICE_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const CACHE_MAX = Number(process.env.VOICE_CACHE_MAX_ENTRIES || 60);
const cache = new Map();   // key -> { audio, metadata, at }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  cache.delete(key); cache.set(key, hit);      // refresh LRU position
  return hit;
}
function cacheSet(key, value) {
  cache.set(key, { ...value, at: Date.now() });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/** Groups segments into chunks that respect the request limit, always breaking on sentence boundaries. */
function chunkSegments(segments, renderOpts) {
  const chunks = []; let cur = [];
  const len = (arr) => renderForElevenV3(arr, renderOpts).length;
  for (const seg of segments) {
    if (cur.length && len([...cur, seg]) > MAX_CHUNK_CHARS) { chunks.push(cur); cur = []; }
    cur.push(seg);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function generateTeacherVoice({ text, voiceId, language = 'en', studentLevel = 'intermediate', subject = 'general', synthesize = realSynthesize, useCache = true }) {
  const speakable = toSpeakable(text);
  if (!speakable) throw Object.assign(new Error('Text cannot be empty.'), { status: 400 });

  const audioTags = String(process.env.VOICE_AUDIO_TAGS || 'on').toLowerCase() !== 'off';
  const key = crypto.createHash('sha1').update([speakable, voiceId, studentLevel, subject, audioTags, process.env.ELEVENLABS_MODEL_ID || ''].join('|')).digest('hex');
  if (useCache) { const hit = cacheGet(key); if (hit) return { audio: hit.audio, metadata: { ...hit.metadata, cached: true } }; }

  // 1-2. semantic teaching segments (sentence-level delivery + pause plan)
  const segments = createTeachingSegments(speakable, { studentLevel, subject });
  const maxAttempts = Math.max(1, Math.min(3, Number(process.env.VOICE_MAX_ATTEMPTS || 2)));
  const buffers = []; const qualities = [];

  for (const group of chunkSegments(segments, { audioTags })) {
    // 3. render for v3, then 4. pronunciation normalization
    const script = normalizePronunciation(renderForElevenV3(group, { audioTags }));
    // 5. bounded quality-control loop (each retry costs credits, so the bound is small)
    let audio = null, evaluation = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      audio = await synthesize({ text: script, voiceId });
      evaluation = await evaluateVoiceQuality({ audioBuffer: audio, expectedText: script });
      if (!evaluation.regenerate) break;
    }
    buffers.push(audio); qualities.push(evaluation);
  }

  const audio = Buffer.concat(buffers);
  const metadata = {
    language, studentLevel, subject, chunks: buffers.length, segments: segments.length,
    quality: { score: Math.min(...qualities.map((q) => q.score)), regenerate: qualities.some((q) => q.regenerate), perChunk: qualities },
    cached: false,
  };
  if (useCache) cacheSet(key, { audio, metadata });
  return { audio, metadata };
}

module.exports = { generateTeacherVoice, chunkSegments, MAX_CHUNK_CHARS };
