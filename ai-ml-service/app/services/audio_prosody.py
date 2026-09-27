"""
AI Mock Interviewer — speech prosody analysis (spec §10 "Speech: speaking rate, pauses,
pitch/prosody").

interview_nlp.py's existing `analyze_transcript()` already covers speaking rate (via
duration_seconds + word count, when the caller supplies both). This module adds the two
signals that require the actual audio waveform, not just the transcript text:

  - pause detection: energy-based voice-activity detection (VAD) — a legitimate, well
    established DSP baseline (frame RMS vs. a silence threshold), not a trained model.
  - pitch/prosody: fundamental-frequency (F0) tracking via time-domain autocorrelation,
    restricted to the typical human voice range (80-400 Hz) — a standard, textbook pitch-
    estimation technique, not an approximated/fabricated number.

Per spec §33: if a genuinely more accurate model (e.g. a trained VAD or a CREPE/pYIN pitch
tracker) is added later, swap the two `_detect_pauses`/`_estimate_pitch_track` internals —
the public `analyze_prosody()` response shape is designed to stay stable either way.

Decoding depends on the `ffmpeg` binary being on PATH (already required by most audio/video
pipelines; add `ffmpeg` to the Dockerfile's apt-get install list). If it isn't available, or
the audio can't be decoded, this degrades to an explicit `available: False` result — never a
fabricated number — consistent with the rest of this codebase's degrade-gracefully pattern.
"""
import subprocess
import tempfile
import os
from typing import Optional

import numpy as np

TARGET_SR = 16000  # mono 16kHz — plenty for pitch/energy analysis, keeps decoding cheap
FRAME_MS = 30
HOP_MS = 15
SILENCE_DB_THRESHOLD = -40.0  # frames quieter than this are treated as silence
MIN_PAUSE_MS = 300  # a silence run shorter than this is just a natural gap between words, not a "pause"
VOICE_F0_MIN_HZ = 80.0
VOICE_F0_MAX_HZ = 400.0


class ProsodyUnavailable(Exception):
    pass


def _decode_to_pcm(content: bytes, filename: str) -> np.ndarray:
    """Decodes arbitrary audio (webm/mp3/wav/whatever the browser's MediaRecorder produced)
    to a mono float32 PCM array at TARGET_SR via an ffmpeg subprocess. Raises
    ProsodyUnavailable with a clear reason on any failure — never returns fabricated audio."""
    suffix = "." + filename.split(".")[-1] if "." in filename else ".webm"
    src_path = out_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as src:
            src.write(content)
            src_path = src.name
        out_path = src_path + ".pcm.wav"
        proc = subprocess.run(
            ["ffmpeg", "-y", "-i", src_path, "-ac", "1", "-ar", str(TARGET_SR), "-f", "wav", out_path],
            capture_output=True, timeout=30,
        )
        if proc.returncode != 0 or not os.path.exists(out_path):
            raise ProsodyUnavailable(
                f"ffmpeg could not decode this audio (returncode={proc.returncode}): "
                f"{proc.stderr.decode(errors='ignore')[-300:]}"
            )
        import wave
        with wave.open(out_path, "rb") as wf:
            raw = wf.readframes(wf.getnframes())
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        return samples
    except FileNotFoundError as exc:
        raise ProsodyUnavailable("ffmpeg is not installed on this deployment — cannot decode audio for prosody analysis.") from exc
    finally:
        for p in (src_path, out_path):
            if p and os.path.exists(p):
                os.unlink(p)


def _frame_signal(samples: np.ndarray, sr: int, frame_ms: int, hop_ms: int) -> np.ndarray:
    frame_len = int(sr * frame_ms / 1000)
    hop_len = int(sr * hop_ms / 1000)
    if len(samples) < frame_len:
        return np.empty((0, frame_len))
    n_frames = 1 + (len(samples) - frame_len) // hop_len
    idx = np.arange(frame_len)[None, :] + hop_len * np.arange(n_frames)[:, None]
    return samples[idx]


def _rms_db(frames: np.ndarray) -> np.ndarray:
    rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
    return 20 * np.log10(rms + 1e-12)


def _detect_pauses(samples: np.ndarray, sr: int) -> dict:
    frames = _frame_signal(samples, sr, FRAME_MS, HOP_MS)
    if len(frames) == 0:
        return {"pause_count": 0, "avg_pause_ms": None, "longest_pause_ms": None, "speech_ratio": None}

    db = _rms_db(frames)
    is_silent = db < SILENCE_DB_THRESHOLD
    hop_s = HOP_MS / 1000.0

    pauses_ms = []
    run_len = 0
    for silent in is_silent:
        if silent:
            run_len += 1
        else:
            if run_len > 0:
                run_ms = run_len * HOP_MS
                if run_ms >= MIN_PAUSE_MS:
                    pauses_ms.append(run_ms)
            run_len = 0
    if run_len > 0:
        run_ms = run_len * HOP_MS
        if run_ms >= MIN_PAUSE_MS:
            pauses_ms.append(run_ms)

    total_s = len(samples) / sr
    speech_frames = int(np.sum(~is_silent))
    speech_ratio = round(speech_frames * hop_s / total_s, 3) if total_s > 0 else None

    return {
        "pause_count": len(pauses_ms),
        "avg_pause_ms": round(sum(pauses_ms) / len(pauses_ms), 1) if pauses_ms else None,
        "longest_pause_ms": round(max(pauses_ms), 1) if pauses_ms else None,
        "speech_ratio": speech_ratio,  # fraction of total duration that wasn't silence
    }


def _autocorr_pitch(frame: np.ndarray, sr: int) -> Optional[float]:
    frame = frame - np.mean(frame)
    if np.max(np.abs(frame)) < 1e-4:
        return None  # essentially silent frame — no pitch to report
    corr = np.correlate(frame, frame, mode="full")[len(frame) - 1:]
    min_lag = int(sr / VOICE_F0_MAX_HZ)
    max_lag = int(sr / VOICE_F0_MIN_HZ)
    if max_lag >= len(corr):
        return None
    segment = corr[min_lag:max_lag]
    if len(segment) == 0 or np.max(segment) <= 0:
        return None
    peak_lag = min_lag + int(np.argmax(segment))
    if peak_lag == 0:
        return None
    return sr / peak_lag


def _estimate_pitch_track(samples: np.ndarray, sr: int) -> dict:
    frames = _frame_signal(samples, sr, FRAME_MS, HOP_MS)
    pitches = [p for p in (_autocorr_pitch(f, sr) for f in frames) if p is not None]
    if not pitches:
        return {"pitch_mean_hz": None, "pitch_std_hz": None, "pitch_range_hz": None,
                "voiced_frame_ratio": 0.0, "delivery_note": "No voiced pitch could be detected (very quiet or noisy audio)."}
    arr = np.array(pitches)
    mean_hz = float(np.mean(arr))
    std_hz = float(np.std(arr))
    voiced_ratio = round(len(arr) / max(1, len(frames)), 3)
    # A low coefficient of variation means pitch barely moves across the answer — flagged as
    # a monotone-delivery observation, not a personality/competence judgment.
    monotone = (std_hz / mean_hz) < 0.08 if mean_hz > 0 else False
    return {
        "pitch_mean_hz": round(mean_hz, 1),
        "pitch_std_hz": round(std_hz, 1),
        "pitch_range_hz": round(float(np.max(arr) - np.min(arr)), 1),
        "voiced_frame_ratio": voiced_ratio,
        "relatively_monotone_delivery": monotone,
    }


def analyze_prosody(content: bytes, filename: str, duration_seconds: Optional[float] = None) -> dict:
    """Full prosody analysis for one answer's audio. Returns `available: False` with a plain
    `reason` (never fabricated numbers) if decoding fails for any reason."""
    try:
        samples = _decode_to_pcm(content, filename)
    except ProsodyUnavailable as exc:
        return {"available": False, "reason": str(exc)}

    if len(samples) < TARGET_SR * 0.3:  # less than ~0.3s of audio — too short to analyze meaningfully
        return {"available": False, "reason": "Audio clip is too short to analyze (need at least ~0.3s)."}

    pauses = _detect_pauses(samples, TARGET_SR)
    pitch = _estimate_pitch_track(samples, TARGET_SR)
    duration_s = duration_seconds if duration_seconds else round(len(samples) / TARGET_SR, 2)

    return {
        "available": True,
        "duration_seconds": duration_s,
        "pauses": pauses,
        "pitch": pitch,
        "method": "Energy-based voice-activity detection for pauses (frame RMS vs. a fixed "
                  "-40dB threshold); time-domain autocorrelation for pitch (80-400Hz voice "
                  "range). Both are standard DSP baselines, not trained/learned models.",
        "caveats": [
            "These are acoustic signal measurements, not a judgment of the candidate's "
            "competence, honesty, or personality.",
            "Background noise or a low-quality microphone can affect pause and pitch readings.",
        ],
    }
