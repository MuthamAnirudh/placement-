/*
  Semantic teaching-script planner (ported from the Adaptive Neural Teacher Voice Engine).

  Deterministic, no extra API key. Splits an explanation into sentences, decides a delivery
  style + pause per sentence, adapts pace to the student level, and renders the result for
  ElevenLabs v3 with light audio tags. Audio tags can be switched off (VOICE_AUDIO_TAGS=off)
  for voices/models that would read them aloud.
*/

function splitSentences(text) {
  const clean = String(text || '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, ' ¶ ').replace(/\n/g, ' ').trim();
  if (!clean) return [];
  return clean
    .split(/(?<=[.!?])\s+(?=[A-Z"'\[(¶0-9])/)
    .map((s) => s.replace(/¶/g, '').trim())
    .filter(Boolean);
}

function createTeachingSegments(text, { studentLevel = 'intermediate', subject = 'general' } = {}) {
  const sentences = splitSentences(text);
  return sentences.map((sentence, index) => {
    const lower = sentence.toLowerCase();
    let delivery = 'conversational';
    let pauseAfter = 350;
    let pace = 0.98;

    if (sentence.includes('?') || /^(why|how|what if)\b/i.test(sentence)) { delivery = 'curious'; pauseAfter = 480; }
    if (/important|key point|remember|main idea|in summary|therefore|common mistake/i.test(lower)) { delivery = 'thoughtful'; pauseAfter = 650; pace = 0.93; }
    if (/great|excellent|notice|interesting|nice/i.test(lower)) delivery = 'warm';

    if (studentLevel === 'beginner') { pace = Math.min(pace, 0.94); pauseAfter += 80; }
    if (index === 0) pauseAfter += 120;

    return { text: sentence, delivery, pace, pauseAfter, studentLevel, subject };
  });
}

const TAGS = { conversational: '[conversational]', curious: '[curious]', thoughtful: '[thoughtful]', warm: '[warm]' };

function renderForElevenV3(segments, { audioTags = true } = {}) {
  return segments.map((segment) => {
    const tag = audioTags ? `${TAGS[segment.delivery] || TAGS.conversational} ` : '';
    const pause = segment.pauseAfter >= 600 ? '\n\n' : segment.pauseAfter >= 450 ? ' ... ' : ' ';
    return `${tag}${segment.text}${pause}`;
  }).join('').trim();
}

module.exports = { createTeachingSegments, renderForElevenV3, splitSentences };
