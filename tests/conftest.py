"""Shared pytest setup: put backend/ on sys.path and isolate the data dir per test session."""
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
os.environ["SGPT_DATA_DIR"] = tempfile.mkdtemp(prefix="sgpt_test_")
os.environ.setdefault("SGPT_AI_FALLBACKS", "true")
