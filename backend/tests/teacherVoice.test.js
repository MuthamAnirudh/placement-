// Plain-Node tests for the Adaptive Neural Teacher Voice pipeline (no network, no API key:
// the ElevenLabs call is replaced by a fake synthesizer). Run: node tests/teacherVoice.test.js
const assert = require('assert');
const { toSpeakable, normalizePronunciation, speakBigO } = require('../src/services/teacherVoice/pronunciation');
const { createTeachingSegments, renderForElevenV3 } = require('../src/services/teacherVoice/teacherScript');
const { evaluateVoiceQuality } = require('../src/services/teacherVoice/audioQuality');
const { generateTeacherVoice, chunkSegments, MAX_CHUNK_CHARS } = require('../src/services/teacherVoice/voicePipeline');
const { synthesizeVoice } = require('../src/services/teacherVoice/voiceEngine');

(async () => {
  // Markdown -> speech
  const md = '## Approach\n1. Use a `hash map`\n2. Loop once\n\n- Time: O(n log n)\n- Space: O(1)\n\n```python\nprint(1)\n```\n**Remember** this.';
  const sp = toSpeakable(md);
  assert(!/[#`*]/.test(sp), 'no markdown symbols: ' + sp);
  assert(/Step 1\. Use a hash map/.test(sp));
  assert(/O of n log n/.test(sp) && /O of one/.test(sp));
  assert(/shown on screen/.test(sp), 'code fence replaced');
  assert.strictEqual(speakBigO('O(n^2)'), 'O of n squared');
  assert.strictEqual(normalizePronunciation('Use BFS and an API'), 'Use B F S and an A P I');
  assert.strictEqual(normalizePronunciation('[curious] OS'), '[curious] O S');

  // Script planning
  const segs = createTeachingSegments('Why does this work? Remember the key point. Great job. Plain sentence.', { studentLevel: 'beginner' });
  assert.deepStrictEqual(segs.map((s) => s.delivery), ['curious', 'thoughtful', 'warm', 'conversational']);
  assert(segs.every((s) => s.pace <= 0.94), 'beginner pace');
  assert(renderForElevenV3(segs).startsWith('[curious]'));
  assert(!renderForElevenV3(segs, { audioTags: false }).includes('['));
  assert.strictEqual(createTeachingSegments('Pi is 3.14 today. Next.').length, 2, 'decimals are not sentence ends');

  // Quality heuristic (16,000 bytes/s): 30 words in 12 s = 150 wpm OK; in 2 s = too fast
  const words = Array(30).fill('word').join(' ');
  assert(!(await evaluateVoiceQuality({ audioBuffer: Buffer.alloc(16000 * 12), expectedText: words })).regenerate);
  assert((await evaluateVoiceQuality({ audioBuffer: Buffer.alloc(16000 * 2), expectedText: words })).regenerate);
  assert((await evaluateVoiceQuality({ audioBuffer: Buffer.alloc(0), expectedText: words })).regenerate);

  // Pipeline with a fake synthesizer: chunking, retry bound, cache
  let calls = 0;
  const long = Array.from({ length: 120 }, (_, i) => `This is teaching sentence number ${i} about binary search and arrays.`).join(' ');
  const fake = async ({ text }) => { calls++; return Buffer.alloc(Math.round((text.split(/\s+/).length / 150) * 60 * 16000)); };
  const r = await generateTeacherVoice({ text: long, voiceId: 'abcdefghij1234', synthesize: fake, useCache: false });
  assert(r.metadata.chunks >= 3, 'long text is chunked: ' + r.metadata.chunks);
  assert.strictEqual(calls, r.metadata.chunks, 'one call per chunk when quality passes');
  for (const g of chunkSegments(createTeachingSegments(long), {})) assert(renderForElevenV3(g).length <= MAX_CHUNK_CHARS + 200);

  calls = 0;
  const bad = async () => { calls++; return Buffer.alloc(3000); };   // always too fast => retries but bounded
  await generateTeacherVoice({ text: 'Short lesson about arrays and pointers in memory today.', voiceId: 'abcdefghij1234', synthesize: bad, useCache: false });
  assert(calls <= 2, 'retries are bounded, got ' + calls);

  calls = 0;
  const a = await generateTeacherVoice({ text: 'Cache me please, this is a sentence.', voiceId: 'abcdefghij1234', synthesize: fake });
  const b = await generateTeacherVoice({ text: 'Cache me please, this is a sentence.', voiceId: 'abcdefghij1234', synthesize: fake });
  assert(!a.metadata.cached && b.metadata.cached && calls === 1, 'second call served from cache');

  // Engine guards
  delete process.env.ELEVENLABS_API_KEY;
  await assert.rejects(() => synthesizeVoice({ text: 'x', voiceId: 'abcdefghij1234' }), /ELEVENLABS_API_KEY/);
  process.env.ELEVENLABS_API_KEY = 'k';
  await assert.rejects(() => synthesizeVoice({ text: 'x', voiceId: '../etc' }), /Invalid voice id/);
  let seen;
  const okFetch = async (url, opt) => { seen = { url, opt }; return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; };
  const out = await synthesizeVoice({ text: 'hi', voiceId: 'abcdefghij1234', fetchImpl: okFetch });
  assert.deepStrictEqual([...out], [1, 2, 3]);
  assert(seen.url.includes('/abcdefghij1234?output_format=mp3_44100_128'));
  assert.strictEqual(JSON.parse(seen.opt.body).model_id, 'eleven_v3');
  assert.strictEqual(seen.opt.headers['xi-api-key'], 'k');

  console.log('teacherVoice tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
