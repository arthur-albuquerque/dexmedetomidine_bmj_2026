"""Pass-B validation and adjudication queue generation for extracted trial data."""

from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path
from typing import Any

import pandas as pd

from pipeline_utils import clean_text, read_dataframe_with_parquet_fallback

CRITICAL_FLAGS = {
    "comparator_not_placebo",
    "infusion_range_invalid",
    "bolus_out_of_range",
    "infusion_out_of_range",
    "missing_study_or_year",
    "missing_n_total",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--interim-parsed",
        type=Path,
        default=Path("data/interim/interim_trials_parsed.parquet"),
    )
    parser.add_argument(
        "--trials-curated-out",
        type=Path,
        default=Path("data/processed/trials_curated.json"),
    )
    parser.add_argument(
        "--review-queue-out",
        type=Path,
        default=Path("data/processed/review_queue.csv"),
    )
    parser.add_argument(
        "--validation-report-out",
        type=Path,
        default=Path("data/processed/validation_report.json"),
    )
    parser.add_argument(
        "--allow-unresolved",
        action="store_true",
        help="Allow unresolved critical flags without failing the command.",
    )
    return parser.parse_args()


def parse_flag_list(raw_flags: Any) -> list[str]:
    if raw_flags is None:
        return []
    if isinstance(raw_flags, list):
        return [clean_text(flag) for flag in raw_flags if clean_text(flag)]
    text = clean_text(raw_flags)
    if not text:
        return []
    if text.startswith("[") and text.endswith("]"):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return [clean_text(flag) for flag in parsed if clean_text(flag)]
        except json.JSONDecodeError:
            try:
                parsed_literal = ast.literal_eval(text)
                if isinstance(parsed_literal, list):
                    return [clean_text(flag) for flag in parsed_literal if clean_text(flag)]
            except (ValueError, SyntaxError):
                pass
    return [clean_text(flag) for flag in text.split(";") if clean_text(flag)]


def sanitize_json_value(value: Any) -> Any:
    if isinstance(value, float) and pd.isna(value):
        return None
    if isinstance(value, dict):
        return {str(k): sanitize_json_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize_json_value(v) for v in value]
    return value


def append_flag(flags: list[str], flag: str) -> None:
    if flag not in flags:
        flags.append(flag)


def validate_row(row: dict[str, Any]) -> tuple[list[str], list[str]]:
    flags = parse_flag_list(row.get("validation_flags"))
    critical: list[str] = []

    control_class = clean_text(row.get("control_class"))
    if control_class != "placebo_or_saline":
        append_flag(flags, "comparator_not_placebo")
        critical.append("comparator_not_placebo")

    bolus_value = row.get("bolus_value")
    if bolus_value is not None and pd.notna(bolus_value):
        if not (0.01 <= float(bolus_value) <= 10.0):
            append_flag(flags, "bolus_out_of_range")
            critical.append("bolus_out_of_range")

    inf_low = row.get("infusion_low")
    inf_high = row.get("infusion_high")
    inf_unit = clean_text(row.get("infusion_unit"))
    inf_weight_norm = bool(row.get("infusion_weight_normalized"))

    if inf_low is not None and pd.notna(inf_low) and inf_high is not None and pd.notna(inf_high):
        if float(inf_low) > float(inf_high):
            append_flag(flags, "infusion_range_invalid")
            critical.append("infusion_range_invalid")

    if inf_low is not None and pd.notna(inf_low):
        val_low = float(inf_low)
        if inf_weight_norm and inf_unit == "mcg/kg/h" and not (0.01 <= val_low <= 5.0):
            append_flag(flags, "infusion_out_of_range")
            critical.append("infusion_out_of_range")

    if not clean_text(row.get("study_label")) or row.get("year") in (None, ""):
        append_flag(flags, "missing_study_or_year")
        critical.append("missing_study_or_year")

    n_total = row.get("n_total")
    if n_total in (None, "") or (pd.notna(n_total) and int(float(n_total)) <= 0):
        append_flag(flags, "missing_n_total")
        critical.append("missing_n_total")

    timing_phase = clean_text(row.get("timing_phase"))
    route_std = clean_text(row.get("route_std"))
    if timing_phase == "unknown":
        append_flag(flags, "timing_unclear")
    if route_std == "Unknown":
        append_flag(flags, "route_unclear")

    return sorted(set(flags)), sorted(set(critical))


def main() -> None:
    args = parse_args()

    df = read_dataframe_with_parquet_fallback(args.interim_parsed)
    records = df.to_dict(orient="records")

    curated_rows: list[dict[str, Any]] = []
    review_rows: list[dict[str, Any]] = []

    unresolved_critical = 0
    for row in records:
        flags, critical_flags = validate_row(row)
        row["validation_flags"] = flags
        row["critical_flags"] = critical_flags
        row["needs_adjudication"] = bool(flags)
        row["has_critical_issues"] = bool(critical_flags)
        curated_rows.append(sanitize_json_value(row))

        if flags:
            review_rows.append(
                {
                    "trial_id": row.get("trial_id"),
                    "study_label": row.get("study_label"),
                    "rob_overall_std": row.get("rob_overall_std"),
                    "validation_flags": ";".join(flags),
                    "critical_flags": ";".join(critical_flags),
                    "source_page": row.get("source_page"),
                    "source_file": row.get("source_file"),
                }
            )

        if critical_flags:
            unresolved_critical += 1

    args.trials_curated_out.parent.mkdir(parents=True, exist_ok=True)
    args.review_queue_out.parent.mkdir(parents=True, exist_ok=True)
    args.validation_report_out.parent.mkdir(parents=True, exist_ok=True)

    with args.trials_curated_out.open("w", encoding="utf-8") as handle:
        json.dump(curated_rows, handle, indent=2)

    review_df = pd.DataFrame.from_records(review_rows)
    if review_df.empty:
        review_df = pd.DataFrame(
            columns=[
                "trial_id",
                "study_label",
                "rob_overall_std",
                "validation_flags",
                "critical_flags",
                "source_page",
                "source_file",
            ]
        )
    review_df.to_csv(args.review_queue_out, index=False)

    report = {
        "n_trials_curated": len(curated_rows),
        "n_review_queue": len(review_rows),
        "n_unresolved_critical": unresolved_critical,
        "critical_flags": sorted(CRITICAL_FLAGS),
        "allow_unresolved": args.allow_unresolved,
    }
    args.validation_report_out.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"[validate] Curated trials: {len(curated_rows)}")
    print(f"[validate] Review queue rows: {len(review_rows)}")
    print(f"[validate] Unresolved critical rows: {unresolved_critical}")

    if unresolved_critical > 0 and not args.allow_unresolved:
        raise SystemExit("Validation failed: unresolved critical flags detected.")


if __name__ == "__main__":
    main()
