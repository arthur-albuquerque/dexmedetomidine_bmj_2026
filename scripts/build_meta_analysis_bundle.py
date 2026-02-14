"""Build a browser-ready meta-analysis bundle for the static app.

The app should not fit models client-side. Instead, this script reads:
1) arm-level counts from the curated extraction table, and
2) model summaries from scripts/model4_brms.R outputs.

It then writes one JSON payload that contains:
- study rows with counts + shrinkage + observed estimates
- precomputed normalized density curves for each study (normal approx on log-OR)
- overall estimate from the fitted model
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TRIAL_SUFFIX_RE = re.compile(r"_p\d+$")
Z_975 = 1.959963984540054


@dataclass(frozen=True)
class ComparisonKey:
    """Join key shared across extraction and model outputs."""

    trial_id: str
    dex_arm_index: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--arm-level-csv",
        type=Path,
        default=Path("data/processed/delirium_prevalence_arm_level.csv"),
    )
    parser.add_argument(
        "--shrinkage-logor-csv",
        type=Path,
        default=Path("data/processed/model4_brms/model4_study_specific_logor_shrinkage_hdi.csv"),
    )
    parser.add_argument(
        "--crude-csv",
        type=Path,
        default=Path("data/processed/model4_brms/model4_study_specific_or_crude_escalc.csv"),
    )
    parser.add_argument(
        "--overall-csv",
        type=Path,
        default=Path("data/processed/model4_brms/model4_overall_or_summary.csv"),
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("data/processed/meta_analysis_bundle.json"),
    )
    parser.add_argument("--x-min-or", type=float, default=0.1)
    parser.add_argument("--x-max-or", type=float, default=3.5)
    parser.add_argument("--grid-points", type=int, default=181)
    return parser.parse_args()


def canonical_trial_id(trial_id: str) -> str:
    """Remove page-like suffixes so IDs can match app trial IDs."""

    return TRIAL_SUFFIX_RE.sub("", str(trial_id).strip())


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        raise FileNotFoundError(f"Required file not found: {path}")
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader)


def require_columns(rows: list[dict[str, str]], columns: list[str], path: Path) -> None:
    if not rows:
        raise ValueError(f"CSV is empty: {path}")
    missing = [name for name in columns if name not in rows[0]]
    if missing:
        raise ValueError(f"Missing required columns in {path}: {', '.join(missing)}")


def parse_int(value: str, field: str) -> int:
    try:
        parsed = int(str(value).strip())
    except Exception as exc:  # pragma: no cover - defensive branch
        raise ValueError(f"Invalid integer for {field}: {value!r}") from exc
    return parsed


def parse_float(value: str, field: str) -> float:
    try:
        parsed = float(str(value).strip())
    except Exception as exc:  # pragma: no cover - defensive branch
        raise ValueError(f"Invalid float for {field}: {value!r}") from exc
    if not math.isfinite(parsed):
        raise ValueError(f"Non-finite float for {field}: {value!r}")
    return parsed


def make_key(trial_id: str, dex_arm_index: str | int) -> ComparisonKey:
    return ComparisonKey(canonical_trial_id(trial_id), parse_int(str(dex_arm_index), "dex_arm_index"))


def normal_pdf(x: float, mu: float, sigma: float) -> float:
    z = (x - mu) / sigma
    return math.exp(-0.5 * z * z) / (sigma * math.sqrt(2.0 * math.pi))


def sigma_from_interval(lower: float, upper: float) -> float:
    sigma = (upper - lower) / (2.0 * Z_975)
    # Small floor avoids flat/degenerate curves in UI.
    return max(sigma, 1e-4)


def build_log_or_grid(x_min_or: float, x_max_or: float, n_points: int) -> list[float]:
    if x_min_or <= 0 or x_max_or <= 0 or x_max_or <= x_min_or:
        raise ValueError("x-axis limits must satisfy 0 < x_min_or < x_max_or.")
    if n_points < 31:
        raise ValueError("grid_points must be at least 31.")
    lower = math.log(x_min_or)
    upper = math.log(x_max_or)
    step = (upper - lower) / (n_points - 1)
    return [lower + i * step for i in range(n_points)]


def build_density_norm(log_or_grid: list[float], mu: float, sigma: float) -> list[float]:
    densities = [normal_pdf(x, mu, sigma) for x in log_or_grid]
    peak = max(densities) if densities else 1.0
    if peak <= 0:
        return [0.0 for _ in densities]
    return [value / peak for value in densities]


def join_model_outputs(
    arm_rows: list[dict[str, str]],
    shrinkage_rows: list[dict[str, str]],
    crude_rows: list[dict[str, str]],
    log_or_grid: list[float],
) -> tuple[list[dict[str, Any]], list[str]]:
    shrinkage_by_key: dict[ComparisonKey, dict[str, str]] = {}
    crude_by_key: dict[ComparisonKey, dict[str, str]] = {}

    for row in shrinkage_rows:
        key = make_key(row["trial_id"], row["dex_arm_index"])
        if key in shrinkage_by_key:
            raise ValueError(f"Duplicate shrinkage row for {key}")
        shrinkage_by_key[key] = row

    for row in crude_rows:
        key = make_key(row["trial_id"], row["dex_arm_index"])
        if key in crude_by_key:
            raise ValueError(f"Duplicate crude row for {key}")
        crude_by_key[key] = row

    rows_out: list[dict[str, Any]] = []
    missing_model_rows: list[str] = []
    seen_keys: set[ComparisonKey] = set()

    for row in arm_rows:
        key = make_key(row["trial_id"], row["dex_arm_index"])
        if key in seen_keys:
            raise ValueError(f"Duplicate arm row for {key}")
        seen_keys.add(key)

        dex_events = parse_int(row["dex_events"], "dex_events")
        dex_total = parse_int(row["dex_total"], "dex_total")
        control_events = parse_int(row["control_events"], "control_events")
        control_total = parse_int(row["control_total"], "control_total")

        if not (0 <= dex_events <= dex_total):
            raise ValueError(f"dex counts invalid for {key}: {dex_events}/{dex_total}")
        if not (0 <= control_events <= control_total):
            raise ValueError(f"control counts invalid for {key}: {control_events}/{control_total}")

        shrinkage = shrinkage_by_key.get(key)
        crude = crude_by_key.get(key)
        has_model = shrinkage is not None and crude is not None

        record: dict[str, Any] = {
            "comparison_id": f"{key.trial_id}__arm{key.dex_arm_index}",
            "trial_id": key.trial_id,
            "trial_id_canonical": key.trial_id,
            "study_label": str(row.get("study_label", "")).strip() or key.trial_id.replace("_", " "),
            "dex_arm_index": key.dex_arm_index,
            "dex_arm_label": str(row.get("dex_arm_label", "")).strip(),
            "dex_events": dex_events,
            "dex_total": dex_total,
            "control_events": control_events,
            "control_total": control_total,
            "has_model": has_model,
        }

        if has_model:
            median_log_or = parse_float(shrinkage["median_log_or"], "median_log_or")
            lower_log_or = parse_float(shrinkage["lower_log_or"], "lower_log_or")
            upper_log_or = parse_float(shrinkage["upper_log_or"], "upper_log_or")
            sigma = sigma_from_interval(lower_log_or, upper_log_or)
            density_norm = build_density_norm(log_or_grid, median_log_or, sigma)

            record.update(
                {
                    "shrinkage_log_or": median_log_or,
                    "shrinkage_log_or_low": lower_log_or,
                    "shrinkage_log_or_high": upper_log_or,
                    "shrinkage_or": math.exp(median_log_or),
                    "shrinkage_or_low": math.exp(lower_log_or),
                    "shrinkage_or_high": math.exp(upper_log_or),
                    "crude_or": parse_float(crude["crude_or"], "crude_or"),
                    "crude_or_low": parse_float(crude["crude_or_ci_low"], "crude_or_ci_low"),
                    "crude_or_high": parse_float(crude["crude_or_ci_high"], "crude_or_ci_high"),
                    "density_norm": density_norm,
                }
            )
        else:
            missing_model_rows.append(record["comparison_id"])
            record.update(
                {
                    "shrinkage_log_or": None,
                    "shrinkage_log_or_low": None,
                    "shrinkage_log_or_high": None,
                    "shrinkage_or": None,
                    "shrinkage_or_low": None,
                    "shrinkage_or_high": None,
                    "crude_or": None,
                    "crude_or_low": None,
                    "crude_or_high": None,
                    "density_norm": [],
                }
            )

        rows_out.append(record)

    return rows_out, missing_model_rows


def parse_overall(overall_rows: list[dict[str, str]], log_or_grid: list[float]) -> dict[str, Any]:
    if len(overall_rows) != 1:
        raise ValueError(
            "Overall summary CSV should contain exactly one row "
            "(model4_overall_or_summary.csv)."
        )
    row = overall_rows[0]
    median_or = parse_float(row["median"], "overall median")
    lower_or = parse_float(row["q2.5"], "overall q2.5")
    upper_or = parse_float(row["q97.5"], "overall q97.5")

    if min(median_or, lower_or, upper_or) <= 0:
        raise ValueError("Overall OR summary contains non-positive values.")

    median_log_or = math.log(median_or)
    lower_log_or = math.log(lower_or)
    upper_log_or = math.log(upper_or)
    sigma = sigma_from_interval(lower_log_or, upper_log_or)
    density_norm = build_density_norm(log_or_grid, median_log_or, sigma)

    return {
        "median_or": median_or,
        "lower_or": lower_or,
        "upper_or": upper_or,
        "median_log_or": median_log_or,
        "lower_log_or": lower_log_or,
        "upper_log_or": upper_log_or,
        "density_norm": density_norm,
    }


def to_jsonable(obj: Any) -> Any:
    """Round long float tails for compact stable JSON output."""

    if isinstance(obj, float):
        return round(obj, 10)
    if isinstance(obj, list):
        return [to_jsonable(item) for item in obj]
    if isinstance(obj, dict):
        return {key: to_jsonable(value) for key, value in obj.items()}
    return obj


def main() -> None:
    args = parse_args()

    arm_rows = read_csv_rows(args.arm_level_csv)
    shrinkage_rows = read_csv_rows(args.shrinkage_logor_csv)
    crude_rows = read_csv_rows(args.crude_csv)
    overall_rows = read_csv_rows(args.overall_csv)

    require_columns(
        arm_rows,
        [
            "trial_id",
            "study_label",
            "dex_arm_index",
            "dex_arm_label",
            "dex_events",
            "dex_total",
            "control_events",
            "control_total",
        ],
        args.arm_level_csv,
    )
    require_columns(
        shrinkage_rows,
        ["trial_id", "dex_arm_index", "median_log_or", "lower_log_or", "upper_log_or"],
        args.shrinkage_logor_csv,
    )
    require_columns(
        crude_rows,
        ["trial_id", "dex_arm_index", "crude_or", "crude_or_ci_low", "crude_or_ci_high"],
        args.crude_csv,
    )
    require_columns(overall_rows, ["median", "q2.5", "q97.5"], args.overall_csv)

    log_or_grid = build_log_or_grid(args.x_min_or, args.x_max_or, args.grid_points)
    rows_out, missing_model_rows = join_model_outputs(
        arm_rows=arm_rows,
        shrinkage_rows=shrinkage_rows,
        crude_rows=crude_rows,
        log_or_grid=log_or_grid,
    )
    overall = parse_overall(overall_rows, log_or_grid=log_or_grid)

    all_counts = {
        "dex_events": sum(int(row["dex_events"]) for row in rows_out),
        "dex_total": sum(int(row["dex_total"]) for row in rows_out),
        "control_events": sum(int(row["control_events"]) for row in rows_out),
        "control_total": sum(int(row["control_total"]) for row in rows_out),
    }

    # Deterministic ordering improves diffs and cache invalidation behavior.
    rows_out.sort(key=lambda row: (str(row["study_label"]).lower(), int(row["dex_arm_index"])))

    payload = {
        "schema_version": 1,
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "x_limits_or": [args.x_min_or, args.x_max_or],
        "x_ticks_or": [0.1, 0.3, 1.0, 3.0],
        "grid_or": [math.exp(x) for x in log_or_grid],
        "overall": overall,
        "all_counts": all_counts,
        "coverage": {
            "n_arm_rows": len(rows_out),
            "n_unique_trials": len({row["trial_id"] for row in rows_out}),
            "n_rows_with_model": sum(1 for row in rows_out if row["has_model"]),
            "n_rows_missing_model": len(missing_model_rows),
            "missing_model_comparison_ids": missing_model_rows,
        },
        "rows": rows_out,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(to_jsonable(payload), indent=2), encoding="utf-8")
    print(f"[meta-bundle] Wrote {args.out}")
    if missing_model_rows:
        print(
            "[meta-bundle] WARNING: missing model summaries for "
            f"{len(missing_model_rows)} arm(s): {', '.join(missing_model_rows)}"
        )


if __name__ == "__main__":
    main()
