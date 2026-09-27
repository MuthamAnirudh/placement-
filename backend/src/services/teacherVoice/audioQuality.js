/*
  Quality-control hooks.

  The original starter returned a constant score of 1. This version performs REAL (but simple)
  checks that need no extra services, using the fact that the engine requests constant-bitrate
  MP3 (mp3_44100_128 = 16,000 bytes/second):
    - audio present / not suspiciously tiny
    - speaking-rate sanity: words / estimated duration must be in a plausible range. A far
      too-fast rate means text was skipped/garbled; far too slow means truncation/long silence.
  Pronunciation, loudness and artifact scoring are NOT measured (they would need ASR / DSP);
  they are reported as null so nothing pretends to be verified. The regeneration loop that
  uses this is bounded.
*/

const BYTES_PER_SECOND = 16000; // 128 kbps CBR MP3

const spokenWords = (text) => String(text || '').replace(/\[[^\]]+\]/g, ' ').split(/\s+/).filter(Boolean).length;

async function evaluateVoiceQuality({ audioBuffer, expectedText, bytesPerSecond = BYTES_PER_SECOND }) {
  const audioPresent = Buffer.isBuffer(audioBuffer) && audioBuffer.length > 2048;
  const words = spokenWords(expectedText);
  const durationSec = audioPresent ? audioBuffer.length / bytesPerSecond : 0;
  const wpm = durationSec > 0 ? Math.round((words / durationSec) * 60) : 0;

  let timing = 0;
  if (audioPresent && words > 0) {
    if (words < 6) timing = 1;                       // too short to judge
    else if (wpm >= 90 && wpm <= 230) timing = 1;
    else if (wpm >= 60 && wpm <= 270) timing = 0.7;
    else timing = 0.3;
  }
  const score = audioPresent ? Math.round((0.3 + 0.7 * timing) * 100) / 100 : 0;
  return {
    score,
    metrics: { audioPresent: audioPresent ? 1 : 0, timing, durationSec: Math.round(durationSec * 10) / 10, wordsPerMinute: wpm, pronunciation: null, loudness: null, artifacts: null },
    regenerate: !audioPresent || timing < 0.7,
  };
}

module.exports = { evaluateVoiceQuality, spokenWords, BYTES_PER_SECOND };
