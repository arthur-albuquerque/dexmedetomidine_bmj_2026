"""Generate overall and RoB-stratified summary JSON outputs."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pandas as pd


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--trials-curated",
        type=Path,
        default=Path("data/processed/trials_curated.json"),
    )
    parser.add_argument(
        "--summary-overall-out",
        type=Path,
        default=Path("data/processed/summary_overall.json"),
    )
    parser.add_argument(
        "--summary-by-rob-out",
        type=Path,
        default=Path("data/processed/summary_by_rob.json"),
    )
    return parser.parse_args()


def dose_band(row: dict[str, Any]) -> str:
    inf_low = row.get("infusion_low")
    inf_high = row.get("infusion_high")
    inf_unit = row.get("infusion_unit")
    inf_weight_norm = bool(row.get("infusion_weight_normalized"))

    if inf_low is None or inf_high is None:
        return "not_reported"
    if not inf_weight_norm or inf_unit != "mcg/kg/h":
        return "not_weight_normalized"

    midpoint = (float(inf_low) + float(inf_high)) / 2.0
    if midpoint <= 0.2:
        return "0-0.2"
    if midpoint <= 0.5:
        return "0.2-0.5"
    if midpoint <= 0.8:
        return "0.5-0.8"
    return ">0.8"


def weighted_distribution(df: pd.DataFrame, column: str) -> list[dict[str, Any]]:
    safe_df = df.copy()
    safe_df["n_total"] = pd.to_numeric(safe_df["n_total"], errors="coerce").fillna(0)
    denom = float(safe_df["n_total"].sum())
    grouped = safe_df.groupby(column, dropna=False)["n_total"].sum().reset_index()

    rows: list[dict[str, Any]] = []
    for _, rec in grouped.iterrows():
        key = rec[column]
        weighted_n = float(rec["n_total"])
        prop = (weighted_n / denom) if denom > 0 else 0.0
        rows.append(
            {
                "category": str(key) if key is not None else "missing",
                "weighted_n": round(weighted_n, 6),
                "weighted_prop": round(prop, 6),
            }
        )
    rows.sort(key=lambda x: x["weighted_n"], reverse=True)
    return rows


def median_iqr_weight_norm_infusion(df: pd.DataFrame) -> dict[str, Any]:
    subset = df[
        (df["infusion_weight_normalized"] == True)
        & (df["infusion_unit"] == "mcg/kg/h")
        & (df["infusion_low"].notna())
        & (df["infusion_high"].notna())
    ].copy()

    if subset.empty:
        return {"median": None, "q1": None, "q3": None, "n_trials": 0}

    subset["midpoint"] = (subset["infusion_low"].astype(float) + subset["infusion_high"].astype(float)) / 2.0
    return {
        "median": round(float(subset["midpoint"].median()), 6),
        "q1": round(float(subset["midpoint"].quantile(0.25)), 6),
        "q3": round(float(subset["midpoint"].quantile(0.75)), 6),
        "n_trials": int(subset.shape[0]),
    }


def missingness(df: pd.DataFrame) -> dict[str, int]:
    return {
        "bolus_missing": int(df["bolus_value"].isna().sum()),
        "infusion_missing": int(df["infusion_low"].isna().sum()),
        "timing_missing": int((df["timing_phase"] == "unknown").sum()),
        "route_missing": int((df["route_std"] == "Unknown").sum()),
    }


def summarize_subset(df: pd.DataFrame) -> dict[str, Any]:
    if df.empty:
        return {
            "n_trials": 0,
            "n_participants": 0,
            "missingness": {
                "bolus_missing": 0,
                "infusion_missing": 0,
                "timing_missing": 0,
                "route_missing": 0,
            },
            "dose_bands_weighted": [],
            "timing_phase_weighted": [],
            "route_weighted": [],
            "infusion_midpoint_distribution": {"median": None, "q1": None, "q3": None, "n_trials": 0},
        }

    temp = df.copy()
    temp["n_total"] = pd.to_numeric(temp["n_total"], errors="coerce").fillna(0).astype(int)
    temp["dose_band"] = temp.to_dict(orient="records")
    temp["dose_band"] = [dose_band(r) for r in temp.to_dict(orient="records")]

    return {
        "n_trials": int(temp.shape[0]),
        "n_participants": int(temp["n_total"].sum()),
        "missingness": missingness(temp),
        "dose_bands_weighted": weighted_distribution(temp, "dose_band"),
        "timing_phase_weighted": weighted_distribution(temp, "timing_phase"),
        "route_weighted": weighted_distribution(temp, "route_std"),
        "infusion_midpoint_distribution": median_iqr_weight_norm_infusion(temp),
    }


def rob_key(raw: str) -> str:
    cleaned = (raw or "").strip().lower()
    if cleaned == "low risk":
        return "low_risk"
    if cleaned == "high risk":
        return "high_risk"
    return "some_concerns"


def main() -> None:
    args = parse_args()
    rows = json.loads(args.trials_curated.read_text(encoding="utf-8"))
    df = pd.DataFrame.from_records(rows)

    overall = summarize_subset(df)
    overall["generated_at_utc"] = datetime.now(UTC).isoformat()

    by_rob: dict[str, Any] = {
        "generated_at_utc": datetime.now(UTC).isoformat(),
    }

    for rob_label in ["Low risk", "Some concerns", "High risk"]:
        key = rob_key(rob_label)
        by_rob[key] = summarize_subset(df[df["rob_overall_std"] == rob_label])

    args.summary_overall_out.parent.mkdir(parents=True, exist_ok=True)
    args.summary_by_rob_out.parent.mkdir(parents=True, exist_ok=True)

    args.summary_overall_out.write_text(json.dumps(overall, indent=2), encoding="utf-8")
    args.summary_by_rob_out.write_text(json.dumps(by_rob, indent=2), encoding="utf-8")

    print(f"[summarize] Overall trials: {overall['n_trials']}")
    print(f"[summarize] Overall participants: {overall['n_participants']}")


if __name__ == "__main__":
    main()
