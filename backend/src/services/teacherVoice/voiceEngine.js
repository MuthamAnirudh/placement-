/*
  ElevenLabs text-to-speech client. Uses the public REST API through Node's built-in fetch, so
  the backend needs NO new npm dependency (the standalone engine used the JS SDK; the request
  is identical: model eleven_v3, mp3_44100_128).

  Environment:
    ELEVENLABS_API_KEY   required
    TEACHER_VOICE_ID     required (use only a voice you are authorized to use)
    ELEVENLABS_MODEL_ID  optional, default eleven_v3
    VOICE_STABILITY      optional 0..1 (v3 accepts 0 creative / 0.5 natural / 1 robust), default 0.5
    VOICE_TIMEOUT_MS     optional, default 45000
*/

const API = 'https://api.elevenlabs.io/v1/text-to-speech';

const isVoiceConfigured = () => !!(process.env.ELEVENLABS_API_KEY || '').trim() && !!(process.env.TEACHER_VOICE_ID || '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function synthesizeVoice({ text, voiceId, fetchImpl = fetch }) {
  const key = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!key) throw Object.assign(new Error('ELEVENLABS_API_KEY is missing. Add it to backend/.env.'), { status: 503 });
  if (!voiceId) throw Object.assign(new Error('TEACHER_VOICE_ID is missing. Add it to backend/.env.'), { status: 503 });
  if (!/^[A-Za-z0-9]{10,40}$/.test(voiceId)) throw Object.assign(new Error('Invalid voice id.'), { status: 400 });

  const model = (process.env.ELEVENLABS_MODEL_ID || 'eleven_v3').trim();
  const stability = Number.isFinite(Number(process.env.VOICE_STABILITY)) && process.env.VOICE_STABILITY !== undefined && process.env.VOICE_STABILITY !== '' ? Number(process.env.VOICE_STABILITY) : 0.5;
  const timeoutMs = Number(process.env.VOICE_TIMEOUT_MS || 45000);
  const body = JSON.stringify({ text, model_id: model, voice_settings: { stability, similarity_boost: 0.75 } });

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(`${API}/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body, signal: ctrl.signal,
      });
      if (resp.ok) return Buffer.from(await resp.arrayBuffer());
      const detail = (await resp.text().catch(() => '')).slice(0, 300);
      lastErr = Object.assign(new Error(`ElevenLabs ${resp.status}: ${detail || resp.statusText}`), { status: resp.status === 401 || resp.status === 403 ? 502 : resp.status });
      if (resp.status !== 429 && resp.status < 500) break;    // do not retry client errors
    } catch (e) {
      lastErr = Object.assign(new Error(e.name === 'AbortError' ? 'Voice provider timed out.' : `Voice provider unreachable: ${e.message}`), { status: 504 });
    } finally { clearTimeout(timer); }
    await sleep(600 * 2 ** attempt);
  }
  throw lastErr;
}

module.exports = { synthesizeVoice, isVoiceConfigured };
