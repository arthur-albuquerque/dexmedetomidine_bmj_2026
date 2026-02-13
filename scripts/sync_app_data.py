"""Copy processed data artifacts into docs for static hosting."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path


DATA_FILES = [
    "trials_curated.json",
    "summary_overall.json",
    "summary_by_rob.json",
    "review_queue.csv",
    "validation_report.json",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--processed-dir", type=Path, default=Path("data/processed"))
    parser.add_argument("--docs-data-dir", type=Path, default=Path("docs/data"))
    return parser.parse_args()


def copy_files(src_dir: Path, dst_dir: Path) -> None:
    dst_dir.mkdir(parents=True, exist_ok=True)
    for filename in DATA_FILES:
        src = src_dir / filename
        if not src.exists():
            continue
        shutil.copy2(src, dst_dir / filename)


def main() -> None:
    args = parse_args()
    copy_files(args.processed_dir, args.docs_data_dir)
    print("[sync] Data files copied to docs/data")


if __name__ == "__main__":
    main()
