"""
Unit tests for the speech-prosody analysis added in audio_prosody.py (spec §10 "Speech:
pauses, pitch/prosody").

Builds synthetic WAV audio in-memory (known tones + known silences) so pause-detection and
pitch-estimation are checked against ground truth, not just "did it run". Requires the
`ffmpeg` binary on PATH (same requirement as the module itself) and numpy — no network, no
trained models. Run from ai-ml-service/:

    pytest tests/test_audio_prosody.py -v
"""
import io
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.audio_prosody import analyze_prosody  # noqa: E402

SR = 16000


def _tone(freq, dur, amp=0.3):
    t = np.linspace(0, dur, int(SR * dur), endpoint=False)
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def _silence(dur):
    return np.zeros(int(SR * dur), dtype=np.float32)


def _wav_bytes(signal: np.ndarray) -> bytes:
    pcm16 = (signal * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(pcm16.tobytes())
    return buf.getvalue()


def test_detects_the_expected_number_of_pauses():
    signal = np.concatenate([_tone(150, 0.5), _silence(0.4), _tone(150, 0.5), _silence(0.4), _tone(150, 0.5)])
    result = analyze_prosody(_wav_bytes(signal), "test.wav")
    assert result["available"] is True
    assert result["pauses"]["pause_count"] == 2


def test_pause_shorter_than_min_threshold_is_not_counted():
    # A 100ms gap is below MIN_PAUSE_MS (300ms) — should NOT be counted as a pause.
    signal = np.concatenate([_tone(150, 0.5), _silence(0.1), _tone(150, 0.5)])
    result = analyze_prosody(_wav_bytes(signal), "test.wav")
    assert result["pauses"]["pause_count"] == 0


def test_pitch_mean_is_close_to_the_synthetic_tone_frequency():
    signal = _tone(180, 1.0)
    result = analyze_prosody(_wav_bytes(signal), "test.wav")
    assert result["pitch"]["pitch_mean_hz"] is not None
    assert abs(result["pitch"]["pitch_mean_hz"] - 180) < 10


def test_pure_single_tone_is_flagged_as_relatively_monotone():
    signal = _tone(180, 1.0)
    result = analyze_prosody(_wav_bytes(signal), "test.wav")
    assert result["pitch"]["relatively_monotone_delivery"] is True


def test_too_short_clip_reports_unavailable_not_a_fabricated_result():
    signal = _tone(150, 0.05)  # 50ms — below the 0.3s minimum
    result = analyze_prosody(_wav_bytes(signal), "test.wav")
    assert result["available"] is False
    assert "reason" in result


def test_undecodable_audio_reports_unavailable_with_reason():
    result = analyze_prosody(b"not actually audio data", "test.wav")
    assert result["available"] is False
    assert "reason" in result


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-v"]))
