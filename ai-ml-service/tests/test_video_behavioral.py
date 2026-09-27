"""
Unit tests for the video behavioral-indicators layer added in video_behavioral.py (spec §10
"Video: posture, gaze/engagement indicators").

IMPORTANT SCOPE NOTE: these tests use a synthetic (non-face) video, so they verify the
module's *contract* — honest "no face detected" reporting, response shape, graceful
degrade when opencv isn't installed, no exceptions on a real (if faceless) video file —
not face/eye detection *accuracy* on a real human face, which would require a sample face
video this offline sandbox has no way to source. Detection accuracy against real footage
should be checked manually/in CI with an actual sample clip before relying on this in a
live mock-interview session.

Requires opencv-python + numpy, no network. Run from ai-ml-service/:

    pytest tests/test_video_behavioral.py -v
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.services.video_behavioral as vb  # noqa: E402

try:
    import cv2
    _CV2_INSTALLED = True
except ImportError:
    _CV2_INSTALLED = False


def _synthetic_faceless_video_bytes(tmp_path, n_frames=30, w=320, h=240, fps=10) -> bytes:
    path = str(tmp_path / "synthetic.mp4")
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(path, fourcc, fps, (w, h))
    for i in range(n_frames):
        frame = np.zeros((h, w, 3), dtype=np.uint8)
        cv2.circle(frame, (50 + i * 3, 100), 20, (200, 200, 200), -1)  # moving blob, not a face
        writer.write(frame)
    writer.release()
    with open(path, "rb") as f:
        return f.read()


def test_faceless_video_reports_zero_face_presence_honestly(tmp_path):
    if not _CV2_INSTALLED:
        return  # environment doesn't have opencv — covered by the fallback test below
    content = _synthetic_faceless_video_bytes(tmp_path)
    result = vb.analyze_video_behavior(content, "test.mp4")
    assert result["available"] is True
    assert result["face_presence_ratio"] == 0.0
    assert result["frames_with_face_detected"] == 0
    # No face detected at all -> posture/gaze fields must stay None, never a fabricated number.
    assert result["posture_stability_score"] is None
    assert result["gaze_toward_camera_ratio"] is None


def test_response_always_includes_the_ethical_caveats(tmp_path):
    if not _CV2_INSTALLED:
        return
    content = _synthetic_faceless_video_bytes(tmp_path)
    result = vb.analyze_video_behavior(content, "test.mp4")
    caveats_text = " ".join(result["caveats"]).lower()
    assert "not measure intelligence" in caveats_text or "honesty" in caveats_text


def test_missing_opencv_degrades_honestly_instead_of_fabricating(monkeypatch):
    monkeypatch.setattr(vb, "_CV2_OK", False)
    result = vb.analyze_video_behavior(b"irrelevant bytes", "test.mp4")
    assert result == {"available": False, "reason": "Required package 'opencv-python' is not installed on this deployment."}


def test_undecodable_video_reports_unavailable_with_reason():
    if not _CV2_INSTALLED:
        return
    result = vb.analyze_video_behavior(b"not actually a video file", "test.mp4")
    assert result["available"] is False
    assert "reason" in result


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-v"]))
