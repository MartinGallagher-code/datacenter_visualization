"""Stand-in (see README.md): topology.json, read as the real one is."""
import json
from pathlib import Path


def topology():
    return json.loads((Path(__file__).resolve().parents[1] / "topology.json").read_text())
