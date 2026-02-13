"""Stage-1 and optional stage-2 extraction for dexmedetomidine trial dosing data."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

import openpyxl
import pandas as pd
import pdfplumber

from pipeline_utils import (
    adjust_implausible_dex_units,
    calculate_extraction_confidence,
    classify_comparator,
    classify_route,
    classify_timing_phase,
    clean_study_label,
    clean_text,
    extract_dex_arm_text,
    normalize_study_key,
    parse_dose,
    parse_n_total,
    parse_simple_yaml_lists,
    rob_category_with_precedence,
    write_dataframe_with_parquet_fallback,
)

RAW_COLUMNS = [
    "study",
    "sample_size",
    "country",
    "intervention_arm",
    "intervention_events",
    "control_arm",
    "control_events",
    "timing",
    "mode",
    "assessment_tool",
    "postop_icu_care",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--articles-pdf",
        type=Path,
        default=Path("data/raw/delirium_list_of_articles.pdf"),
    )
    parser.add_argument(
        "--rob-xlsx",
        type=Path,
        default=Path("data/raw/delirium_rob.xlsx"),
    )
    parser.add_argument(
        "--comparator-rules",
        type=Path,
        default=Path("scripts/comparator_rules.yml"),
    )
    parser.add_argument(
        "--trial-pdfs-dir",
        type=Path,
        default=Path("data/raw/trial_pdfs"),
    )
    parser.add_argument(
        "--manual-adjudications",
        type=Path,
        default=Path("data/raw/manual_adjudications.json"),
    )
    parser.add_argument(
        "--interim-raw-out",
        type=Path,
        default=Path("data/interim/interim_trials_raw.parquet"),
    )
    parser.add_argument(
        "--interim-parsed-out",
        type=Path,
        default=Path("data/interim/interim_trials_parsed.parquet"),
    )
    parser.add_argument(
        "--unmatched-rob-out",
        type=Path,
        default=Path("data/interim/unmatched_rob_keys.json"),
    )
    return parser.parse_args()


def is_header_row(cells: list[str]) -> bool:
    if not cells:
        return False
    first = clean_text(cells[0]).lower()
    second = clean_text(cells[1]).lower() if len(cells) > 1 else ""
    return "study" in first and "sample" in second


def normalize_row_length(row: list[Any], size: int) -> list[str]:
    cells = [clean_text(c) for c in row]
    if len(cells) < size:
        cells += [""] * (size - len(cells))
    if len(cells) > size:
        cells = cells[:size]
    return cells


def row_is_continuation(cells: list[str]) -> bool:
    first = clean_text(cells[0])
    if first:
        return False
    return any(clean_text(c) for c in cells[1:])


def parse_articles_table(pdf_path: Path) -> pd.DataFrame:
    records: list[dict[str, Any]] = []
    last_record: dict[str, Any] | None = None

    with pdfplumber.open(pdf_path) as pdf:
        for page_idx, page in enumerate(pdf.pages, start=1):
            tables = page.extract_tables() or []
            for table in tables:
                for raw_row in table:
                    if raw_row is None:
                        continue

                    cells = normalize_row_length(list(raw_row), len(RAW_COLUMNS))
                    if is_header_row(cells):
                        continue

                    if row_is_continuation(cells):
                        if last_record is None:
                            continue
                        for col_idx, col_name in enumerate(RAW_COLUMNS):
                            append_text = clean_text(cells[col_idx])
                            if not append_text:
                                continue
                            existing = clean_text(last_record[col_name])
                            joined = f"{existing} {append_text}" if existing else append_text
                            last_record[col_name] = clean_text(joined)
                        continue

                    study_cell = clean_text(cells[0])
                    # Require a plausible year in study label to avoid malformed rows.
                    if not re.search(r"\d{4}", study_cell):
                        continue

                    record = {
                        "study": study_cell,
                        "sample_size": clean_text(cells[1]),
                        "country": clean_text(cells[2]),
                        "intervention_arm": clean_text(cells[3]),
                        "intervention_events": clean_text(cells[4]),
                        "control_arm": clean_text(cells[5]),
                        "control_events": clean_text(cells[6]),
                        "timing": clean_text(cells[7]),
                        "mode": clean_text(cells[8]),
                        "assessment_tool": clean_text(cells[9]),
                        "postop_icu_care": clean_text(cells[10]),
                        "source_page": page_idx,
                        "source_file": str(pdf_path),
                    }
                    records.append(record)
                    last_record = record

    if not records:
        return pd.DataFrame(columns=[*RAW_COLUMNS, "source_page", "source_file"])
    return pd.DataFrame.from_records(records)


def parse_rob_table(rob_path: Path) -> tuple[pd.DataFrame, dict[str, str]]:
    workbook = openpyxl.load_workbook(rob_path, data_only=True)
    worksheet = workbook.active
    rows: list[dict[str, Any]] = []
    raw_to_norm_key: dict[str, str] = {}

    for row in worksheet.iter_rows(min_row=2, values_only=True):
        study_id = clean_text(row[0] if len(row) > 0 else "")
        if not study_id:
            continue

        rob_std, rob_raw_used, flags = rob_category_with_precedence(
            row[9] if len(row) > 9 else None,
            row[12] if len(row) > 12 else None,
        )
        norm_key = normalize_study_key(study_id)
        raw_to_norm_key[study_id] = norm_key

        rows.append(
            {
                "rob_study_id": study_id,
                "rob_study_key": norm_key,
                "rob_overall_std": rob_std,
                "rob_overall_raw": rob_raw_used,
                "rob_flags": ";".join(flags),
            }
        )

    return pd.DataFrame.from_records(rows), raw_to_norm_key


def parse_optional_fulltext_trial_pdfs(trial_pdfs_dir: Path) -> dict[str, dict[str, Any]]:
    """Parse optional per-trial PDFs for stage-2 enrichment if files are available."""
    enrichment: dict[str, dict[str, Any]] = {}
    if not trial_pdfs_dir.exists():
        return enrichment

    for pdf_path in sorted(trial_pdfs_dir.glob("*.pdf")):
        norm_key = normalize_study_key(pdf_path.stem)
        try:
            with pdfplumber.open(pdf_path) as pdf:
                text = "\n".join(clean_text(page.extract_text() or "") for page in pdf.pages[:5])
        except Exception:
            continue

        dose = parse_dose(text)
        if dose.bolus_value is None and dose.infusion_low is None:
            continue

        enrichment[norm_key] = {
            "fulltext_bolus_value": dose.bolus_value,
            "fulltext_bolus_unit": dose.bolus_unit,
            "fulltext_infusion_low": dose.infusion_low,
            "fulltext_infusion_high": dose.infusion_high,
            "fulltext_infusion_unit": dose.infusion_unit,
            "fulltext_infusion_weight_normalized": dose.infusion_weight_normalized,
            "fulltext_source_file": str(pdf_path),
        }

    return enrichment


def load_manual_adjudications(path: Path) -> dict[str, dict[str, Any]]:
    """Load optional manual trial-level adjudications keyed by normalized study key."""
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Manual adjudications file must be an object: {path}")
    adjudications: dict[str, dict[str, Any]] = {}
    for key, value in payload.items():
        if not isinstance(value, dict):
            continue
        adjudications[key.lower()] = value
    return adjudications


def derive_trial_id(study_key: str, source_page: int) -> str:
    return f"{study_key}_p{source_page}"


def build_canonical_rows(
    articles_df: pd.DataFrame,
    rob_df: pd.DataFrame,
    comparator_rules: dict[str, list[str]],
    fulltext_enrichment: dict[str, dict[str, Any]],
    manual_adjudications: dict[str, dict[str, Any]],
) -> tuple[pd.DataFrame, list[str]]:
    include_terms = comparator_rules.get("include_terms", [])
    exclude_terms = comparator_rules.get("exclude_terms", [])

    dex_candidates = articles_df[
        articles_df["intervention_arm"].str.contains(r"dexmedetomidine|\bdex\b", case=False, na=False, regex=True)
    ].copy()

    records: list[dict[str, Any]] = []
    matched_keys: set[str] = set()

    rob_df_dedup = rob_df.drop_duplicates(subset=["rob_study_key"], keep="first")
    rob_lookup = rob_df_dedup.set_index("rob_study_key").to_dict(orient="index")

    for row in dex_candidates.to_dict(orient="records"):
        study_label = clean_study_label(row["study"])
        study_key = normalize_study_key(study_label)

        dex_arm_text = extract_dex_arm_text(row["intervention_arm"])
        control_text = clean_text(row["control_arm"])
        control_class = classify_comparator(control_text, include_terms, exclude_terms)

        # Scope is locked to dexmedetomidine vs placebo/saline controls only.
        if control_class != "placebo_or_saline":
            continue

        parsed_dose = parse_dose(dex_arm_text)
        parsed_dose, unit_flags = adjust_implausible_dex_units(parsed_dose)

        fulltext_row = fulltext_enrichment.get(study_key)
        source_file = row["source_file"]
        flags: list[str] = list(unit_flags)

        bolus_value = parsed_dose.bolus_value
        bolus_unit = parsed_dose.bolus_unit
        infusion_low = parsed_dose.infusion_low
        infusion_high = parsed_dose.infusion_high
        infusion_unit = parsed_dose.infusion_unit
        infusion_weight_normalized = parsed_dose.infusion_weight_normalized

        if fulltext_row:
            if fulltext_row.get("fulltext_bolus_value") is not None:
                bolus_value = fulltext_row["fulltext_bolus_value"]
                bolus_unit = fulltext_row["fulltext_bolus_unit"]
                flags.append("dose_from_fulltext")
            if fulltext_row.get("fulltext_infusion_low") is not None:
                infusion_low = fulltext_row["fulltext_infusion_low"]
                infusion_high = fulltext_row["fulltext_infusion_high"]
                infusion_unit = fulltext_row["fulltext_infusion_unit"]
                infusion_weight_normalized = fulltext_row["fulltext_infusion_weight_normalized"]
                flags.append("infusion_from_fulltext")
            source_file = f"{source_file};{fulltext_row['fulltext_source_file']}"

        timing_raw = clean_text(row["timing"])
        route_raw = clean_text(row["mode"])
        timing_phase = classify_timing_phase(timing_raw, dex_arm_text)
        route_std = classify_route(route_raw, dex_arm_text)

        adjudication = manual_adjudications.get(study_key)
        if adjudication:
            if "bolus_value" in adjudication:
                bolus_value = adjudication["bolus_value"]
                bolus_unit = adjudication.get("bolus_unit", bolus_unit)
            if "infusion_low" in adjudication:
                infusion_low = adjudication["infusion_low"]
                infusion_high = adjudication.get("infusion_high", infusion_low)
                infusion_unit = adjudication.get("infusion_unit", infusion_unit)
                infusion_weight_normalized = adjudication.get(
                    "infusion_weight_normalized", infusion_weight_normalized
                )
            if "timing_phase" in adjudication:
                timing_phase = adjudication["timing_phase"]
            flags.append("manual_adjudication_applied")

        rob_info = rob_lookup.get(study_key)
        if rob_info:
            matched_keys.add(study_key)
            rob_std = clean_text(rob_info["rob_overall_std"]) or "Some concerns"
            rob_raw = clean_text(rob_info["rob_overall_raw"])
            rob_flags = clean_text(rob_info["rob_flags"])
            if rob_flags:
                flags.extend(rob_flags.split(";"))
        else:
            rob_std = "Some concerns"
            rob_raw = ""
            flags.append("rob_unmatched_defaulted")

        n_total = parse_n_total(row["sample_size"])
        confidence_input = parsed_dose.__class__(
            bolus_value=bolus_value,
            bolus_unit=bolus_unit,
            bolus_unit_raw=parsed_dose.bolus_unit_raw,
            infusion_low=infusion_low,
            infusion_high=infusion_high,
            infusion_unit=infusion_unit,
            infusion_unit_raw=parsed_dose.infusion_unit_raw,
            infusion_weight_normalized=infusion_weight_normalized,
        )
        confidence = calculate_extraction_confidence(confidence_input, timing_phase, route_std)

        if bolus_value is None:
            flags.append("bolus_missing")
        if infusion_low is None:
            flags.append("infusion_missing")
        if timing_phase == "unknown":
            flags.append("timing_unclear")
        if route_std == "Unknown":
            flags.append("route_unclear")

        year_match = re.search(r"(\d{4})", study_label)
        year = int(year_match.group(1)) if year_match else None

        records.append(
            {
                "trial_id": derive_trial_id(study_key, int(row["source_page"])),
                "study_label": study_label,
                "year": year,
                "country": clean_text(row["country"]),
                "n_total": n_total,
                "dex_arm_text_raw": dex_arm_text,
                "control_arm_text_raw": control_text,
                "control_class": control_class,
                "bolus_value": bolus_value,
                "bolus_unit": bolus_unit,
                "infusion_low": infusion_low,
                "infusion_high": infusion_high,
                "infusion_unit": infusion_unit,
                "infusion_weight_normalized": infusion_weight_normalized,
                "timing_raw": timing_raw,
                "timing_phase": timing_phase,
                "route_raw": route_raw,
                "route_std": route_std,
                "rob_overall_raw": rob_raw,
                "rob_overall_std": rob_std,
                "extraction_confidence": confidence,
                "validation_flags": sorted(set(flags)),
                "source_page": int(row["source_page"]),
                "source_file": source_file,
                "intervention_events": clean_text(row["intervention_events"]),
                "control_events": clean_text(row["control_events"]),
                "assessment_tool": clean_text(row["assessment_tool"]),
                "postop_icu_care": clean_text(row["postop_icu_care"]),
            }
        )

    canonical_df = pd.DataFrame.from_records(records)

    unmatched_keys = sorted(set(rob_df_dedup["rob_study_key"]) - matched_keys)
    return canonical_df, unmatched_keys


def main() -> None:
    args = parse_args()

    print("[extract] Loading comparator rules...", flush=True)
    rules = parse_simple_yaml_lists(args.comparator_rules)
    print("[extract] Parsing supplementary trial table PDF...", flush=True)
    articles_df = parse_articles_table(args.articles_pdf)
    print("[extract] Parsing RoB workbook...", flush=True)
    rob_df, _ = parse_rob_table(args.rob_xlsx)
    print("[extract] Parsing optional full-text trial PDFs...", flush=True)
    fulltext_enrichment = parse_optional_fulltext_trial_pdfs(args.trial_pdfs_dir)
    print("[extract] Loading optional manual adjudications...", flush=True)
    manual_adjudications = load_manual_adjudications(args.manual_adjudications)
    print("[extract] Building canonical rows...", flush=True)

    canonical_df, unmatched_keys = build_canonical_rows(
        articles_df=articles_df,
        rob_df=rob_df,
        comparator_rules=rules,
        fulltext_enrichment=fulltext_enrichment,
        manual_adjudications=manual_adjudications,
    )

    raw_meta = write_dataframe_with_parquet_fallback(articles_df, args.interim_raw_out)
    parsed_meta = write_dataframe_with_parquet_fallback(canonical_df, args.interim_parsed_out)

    args.unmatched_rob_out.parent.mkdir(parents=True, exist_ok=True)
    args.unmatched_rob_out.write_text(
        json.dumps(
            {
                "unmatched_rob_keys": unmatched_keys,
                "raw_write": raw_meta,
                "parsed_write": parsed_meta,
                "n_articles_rows": int(articles_df.shape[0]),
                "n_canonical_rows": int(canonical_df.shape[0]),
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"[extract] Source rows: {articles_df.shape[0]}")
    print(f"[extract] Canonical dex-placebo rows: {canonical_df.shape[0]}")
    print(f"[extract] Unmatched RoB keys: {len(unmatched_keys)}")


if __name__ == "__main__":
    main()
