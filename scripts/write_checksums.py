"""Write deterministic SHA256 checksums for processed artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--processed-dir", type=Path, default=Path("data/processed"))
    parser.add_argument("--out", type=Path, default=Path("data/processed/checksums.json"))
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(8192)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    args = parse_args()
    files = [
        "trials_curated.json",
        "summary_overall.json",
        "summary_by_rob.json",
        "review_queue.csv",
        "validation_report.json",
    ]

    hashes = {}
    for name in files:
        path = args.processed_dir / name
        if path.exists():
            hashes[name] = sha256(path)

    args.out.write_text(json.dumps(hashes, indent=2), encoding="utf-8")
    print(f"[checksums] Wrote {args.out}")


if __name__ == "__main__":
    main()
