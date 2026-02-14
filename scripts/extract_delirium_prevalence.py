"""Extract counts-only delirium event data for curated dexmedetomidine trials.

This script links curated trial rows to an event-count CSV and writes:
1) Arm-level dex vs control counts (no derived prevalence columns).
2) Trial-level linkage/QC status report.
3) Coverage summary metrics for auditability.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from pipeline_utils import clean_text, normalize_study_key

CSV_REQUIRED_COLUMNS = {
    "studyID",
    "Intervention1",
    "Control",
    "Intervention1_cases",
    "Intervention_total",
    "Control_cases",
    "Control_total",
    "Intervention2",
    "Intervention2_cases",
    "Intervention2_total",
    "Intervention3",
    "Intervention3_cases",
    "Intervention3_total",
    "Complication",
}

EVENT_TUPLE_COLUMNS = (
    "Intervention1_cases",
    "Intervention_total",
    "Control_cases",
    "Control_total",
    "Intervention2_cases",
    "Intervention2_total",
    "Intervention3_cases",
    "Intervention3_total",
)

CONTROL_ALLOWED = {"placebo", "saline", "equivolume saline"}

# Deterministic, explicit key alias for known orthographic mismatch.
STUDY_KEY_ALIASES = {
    "choovongkom_ol_2024": "choovongkomol_2024",
}

DEX_PATTERN = re.compile(r"dexmedetomidine|\bdex\b", flags=re.IGNORECASE)

# Manual curation overrides requested during audit.
EXCLUDED_TRIAL_IDS = {
    "momeni_2021",
    "zhao_2020",
}

# Keep only pre-specified dex arms for specific trials.
TRIAL_DEX_ARM_KEEP = {
    "hu_2022": {1},
}

# Arm label overrides for publication-consistent naming.
# Tang et al. 2022 reports Dex1 and Dex2 infusion groups:
# Dex1 = 0.3 mcg/kg/h and Dex2 = 0.6 mcg/kg/h.
TRIAL_ARM_LABEL_OVERRIDES = {
    ("tang_2022", 1): "Dexmedetomidine (Dex1, 0.3 mcg/kg/h)",
    ("tang_2022", 2): "Dexmedetomidine (Dex2, 0.6 mcg/kg/h)",
    ("lee_2018", 1): "Dexmedetomidine (bolus)",
    ("lee_2018", 2): "Dexmedetomidine (bolus + infusion)",
}

# Manual pooled subgroup override supplied by user.
# Liu 2016: pooled across MCI and non-MCI strata.
MANUAL_TRIAL_EVENT_OVERRIDES: dict[str, dict[str, Any]] = {
    "ghazaly_2023": {
        "studyID_csv": "manual_ghazaly_2023",
        "control_label": "Placebo",
        "control_events": 15,
        "control_total": 20,
        "arms": {
            1: {
                "dex_arm_label": "Dexmedetomidine (bolus)",
                "dex_events": 1,
                "dex_total": 20,
            }
        },
    },
    "lee_2018": {
        "studyID_csv": "manual_lee_2018",
        "control_label": "Saline",
        "control_events": 27,
        "control_total": 109,
        "arms": {
            1: {
                "dex_arm_label": "Dexmedetomidine (bolus)",
                "dex_events": 21,
                "dex_total": 114,
            },
            2: {
                "dex_arm_label": "Dexmedetomidine (bolus + infusion)",
                "dex_events": 9,
                "dex_total": 95,
            },
        },
    },
    "liu_2016": {
        "control_label": "Placebo (NS) [manual pooled]",
        "control_events": 43,
        "control_total": 98,
        "arms": {
            1: {
                "dex_arm_label": "Dexmedetomidine [manual pooled]",
                "dex_events": 15,
                "dex_total": 99,
            }
        },
    },
    "ma_2013": {
        "studyID_csv": "manual_ma_2013",
        "control_label": "Saline",
        "control_events": 3,
        "control_total": 30,
        "arms": {
            1: {
                "dex_arm_label": "Dexmedetomidine (bolus + infusion)",
                "dex_events": 2,
                "dex_total": 30,
            }
        },
    },
    "massoumi_2019": {
        "studyID_csv": "manual_massoumi_2019",
        "control_label": "Saline",
        "control_events": 9,
        "control_total": 44,
        "arms": {
            1: {
                "dex_arm_label": "Dexmedetomidine (bolus + infusion)",
                "dex_events": 4,
                "dex_total": 44,
            }
        },
    },
}

ARM_OUTPUT_COLUMNS = [
    "trial_id",
    "study_label",
    "study_key",
    "studyID_csv",
    "dex_arm_index",
    "dex_arm_label",
    "dex_events",
    "dex_total",
    "control_label",
    "control_events",
    "control_total",
    "mapping_method",
    "qc_flags",
]

LINKAGE_OUTPUT_COLUMNS = [
    "trial_id",
    "study_label",
    "status",
    "candidate_studyIDs",
    "notes",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--trials-curated",
        type=Path,
        default=Path("data/processed/trials_curated.json"),
        help="Curated dex trial dataset from pipeline.",
    )
    parser.add_argument(
        "--event-data",
        type=Path,
        default=Path("data/raw/event_data.csv"),
        help="Trial-arm event-count CSV source.",
    )
    parser.add_argument(
        "--arm-level-out",
        type=Path,
        default=Path("data/processed/delirium_prevalence_arm_level.csv"),
        help="Output CSV with arm-level dex/control counts.",
    )
    parser.add_argument(
        "--linkage-report-out",
        type=Path,
        default=Path("data/processed/delirium_prevalence_linkage_report.csv"),
        help="Output CSV with trial-level linkage/QC statuses.",
    )
    parser.add_argument(
        "--coverage-summary-out",
        type=Path,
        default=Path("data/processed/delirium_prevalence_coverage_summary.json"),
        help="Output JSON with extraction coverage metrics.",
    )
    return parser.parse_args()


def _require_columns(fieldnames: list[str] | None, expected: set[str], source: Path) -> None:
    if fieldnames is None:
        raise ValueError(f"CSV header missing in {source}")
    missing = sorted(expected - set(fieldnames))
    if missing:
        raise ValueError(f"Missing required columns in {source}: {', '.join(missing)}")


def _read_trials(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError(f"Expected a list in {path}")
    records: list[dict[str, Any]] = []
    for idx, row in enumerate(payload):
        if not isinstance(row, dict):
            raise ValueError(f"Trial row {idx} in {path} is not an object")
        trial_id = clean_text(row.get("trial_id"))
        study_label = clean_text(row.get("study_label"))
        if not trial_id or not study_label:
            raise ValueError(f"Trial row {idx} missing trial_id or study_label")
        records.append(row)
    return records


def _read_event_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        _require_columns(reader.fieldnames, CSV_REQUIRED_COLUMNS, path)
        rows = [{k: v for k, v in row.items()} for row in reader]
    return rows


def study_key_from_trial_label(study_label: str) -> str:
    """Create normalized trial key using shared pipeline normalization."""
    return normalize_study_key(study_label)


def study_key_from_csv_study_id(study_id: str) -> str:
    """Map CSV study IDs to the trial-key namespace.

    The CSV uses labels such as `Surname_drug_2023` or `Surname_drug_2016a`.
    We deterministically keep the left author token and four-digit year.
    """
    text = clean_text(study_id)
    year_match = re.search(r"(?:19|20)\d{2}[a-z]?$", text, flags=re.IGNORECASE)
    if not year_match:
        return normalize_study_key(text)

    year = year_match.group(0)[:4]
    left = text[: year_match.start()].rstrip("_ ").strip()
    author_token = left.split("_")[0].strip() if left else ""
    if not author_token:
        return normalize_study_key(text)
    return normalize_study_key(f"{author_token} {year}")


def _event_tuple(row: dict[str, str]) -> tuple[str, ...]:
    return tuple(clean_text(row.get(col)) for col in EVENT_TUPLE_COLUMNS)


def collapse_rows_by_study_id(
    event_rows: list[dict[str, str]],
) -> tuple[dict[str, dict[str, str]], set[str], dict[str, list[dict[str, str]]]]:
    """Collapse repeated complication rows after consistency check."""
    by_study_id: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in event_rows:
        study_id = clean_text(row.get("studyID"))
        if not study_id:
            raise ValueError("Encountered event row with empty studyID")
        by_study_id[study_id].append(row)

    canonical: dict[str, dict[str, str]] = {}
    inconsistent: set[str] = set()

    for study_id, rows in by_study_id.items():
        first_tuple = _event_tuple(rows[0])
        for row in rows[1:]:
            if _event_tuple(row) != first_tuple:
                inconsistent.add(study_id)
                break
        if study_id not in inconsistent:
            canonical[study_id] = rows[0]

    return canonical, inconsistent, by_study_id


def _int_from_field(row: dict[str, str], field: str) -> int:
    text = clean_text(row.get(field))
    if not text or text.upper() == "NA":
        raise ValueError(f"Missing numeric value for {field}")
    try:
        value = int(float(text))
    except ValueError as exc:
        raise ValueError(f"Invalid numeric value for {field}: {text}") from exc
    if value < 0:
        raise ValueError(f"Negative value for {field}: {value}")
    return value


def detect_dex_arm_indices(event_row: dict[str, str]) -> list[int]:
    indices: list[int] = []
    for idx in (1, 2, 3):
        arm_label = clean_text(event_row.get(f"Intervention{idx}"))
        if arm_label and arm_label.upper() != "NA" and DEX_PATTERN.search(arm_label):
            indices.append(idx)
    return indices


def normalize_control_label(value: str) -> str:
    return clean_text(value).lower()


def _arm_cases_field(idx: int) -> str:
    return f"Intervention{idx}_cases"


def _arm_total_field(idx: int) -> str:
    if idx == 1:
        return "Intervention_total"
    return f"Intervention{idx}_total"


def build_event_key_lookup(study_ids: list[str]) -> dict[str, list[str]]:
    lookup: dict[str, list[str]] = defaultdict(list)
    for study_id in sorted(set(study_ids)):
        key = study_key_from_csv_study_id(study_id)
        lookup[key].append(study_id)
    return lookup


def choose_study_id_candidate(candidates: list[str]) -> tuple[str | None, str | None]:
    if not candidates:
        return None, None
    if len(candidates) == 1:
        return candidates[0], "exact_key"
    dex_candidates = [sid for sid in candidates if "dexmedetomidine" in sid.lower()]
    if len(dex_candidates) == 1:
        return dex_candidates[0], "ambiguity_rule"
    return None, None


def _write_csv(path: Path, columns: list[str], rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            writer.writerow({col: row.get(col, "") for col in columns})


def output_trial_id(trial_id: str) -> str:
    """Drop source-page suffix (e.g., _p3) for cleaner downstream outputs."""
    return re.sub(r"_p\d+$", "", clean_text(trial_id))


def run_extraction(
    trials: list[dict[str, Any]],
    event_rows: list[dict[str, str]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, int]]:
    canonical_by_study_id, inconsistent_study_ids, rows_by_study_id = collapse_rows_by_study_id(event_rows)
    event_lookup = build_event_key_lookup(list(rows_by_study_id.keys()))

    arm_rows: list[dict[str, Any]] = []
    linkage_rows: list[dict[str, Any]] = []
    dex_arm_count_by_trial: Counter[str] = Counter()

    for trial in trials:
        trial_id_raw = clean_text(trial["trial_id"])
        trial_id = output_trial_id(trial_id_raw)
        study_label = clean_text(trial["study_label"])

        if trial_id in EXCLUDED_TRIAL_IDS:
            linkage_rows.append(
                {
                    "trial_id": trial_id,
                    "study_label": study_label,
                    "status": "manually_excluded",
                    "candidate_studyIDs": "",
                    "notes": "excluded by manual audit policy",
                }
            )
            continue

        study_key = study_key_from_trial_label(study_label)
        resolved_key = STUDY_KEY_ALIASES.get(study_key, study_key)
        key_used_alias = resolved_key != study_key
        manual_override = MANUAL_TRIAL_EVENT_OVERRIDES.get(trial_id)

        candidates = event_lookup.get(resolved_key, [])
        candidate_text = ";".join(candidates)

        selected_study_id, mapping_method = choose_study_id_candidate(candidates)

        if selected_study_id is None and manual_override is None and not candidates:
            linkage_rows.append(
                {
                    "trial_id": trial_id,
                    "study_label": study_label,
                    "status": "missing_in_csv",
                    "candidate_studyIDs": "",
                    "notes": f"no event_data.csv match for key={resolved_key}",
                }
            )
            continue

        if selected_study_id is None and manual_override is None:
            linkage_rows.append(
                {
                    "trial_id": trial_id,
                    "study_label": study_label,
                    "status": "ambiguous_unresolved",
                    "candidate_studyIDs": candidate_text,
                    "notes": "multiple candidate studyIDs and no unique dexmedetomidine candidate",
                }
            )
            continue

        if selected_study_id is None and manual_override is not None:
            selected_study_id = clean_text(manual_override.get("studyID_csv")) or "manual_override"
            mapping_method = "manual_override"
            if not candidate_text:
                candidate_text = selected_study_id

        if key_used_alias and mapping_method == "exact_key":
            mapping_method = "alias_key"

        if manual_override is None and selected_study_id in inconsistent_study_ids:
            linkage_rows.append(
                {
                    "trial_id": trial_id,
                    "study_label": study_label,
                    "status": "inconsistent_csv_rows",
                    "candidate_studyIDs": candidate_text,
                    "notes": f"inconsistent event tuple across repeated complication rows for {selected_study_id}",
                }
            )
            continue

        if manual_override is not None:
            control_label = clean_text(manual_override["control_label"])
            control_events = int(manual_override["control_events"])
            control_total = int(manual_override["control_total"])
            if control_events < 0 or control_total <= 0 or control_events > control_total:
                raise ValueError(f"Invalid manual override control counts for {trial_id}")

            arm_payload = manual_override.get("arms", {})
            if not arm_payload:
                raise ValueError(f"Manual override for {trial_id} has no dex arms")

            dex_indices = sorted(int(idx) for idx in arm_payload.keys())
            if len(dex_indices) > 1:
                qc_flags_base = ["manual_counts_override", "multi_dex_trial"]
            else:
                qc_flags_base = ["manual_counts_override"]

            for idx in dex_indices:
                dex_arm = arm_payload[idx]
                dex_events = int(dex_arm["dex_events"])
                dex_total = int(dex_arm["dex_total"])
                dex_label = clean_text(dex_arm["dex_arm_label"])

                if dex_events < 0 or dex_total <= 0 or dex_events > dex_total:
                    raise ValueError(f"Invalid manual override dex counts for {trial_id} arm {idx}")

                arm_rows.append(
                    {
                        "trial_id": trial_id,
                        "study_label": study_label,
                        "study_key": study_key,
                        "studyID_csv": selected_study_id,
                        "dex_arm_index": idx,
                        "dex_arm_label": dex_label,
                        "dex_events": dex_events,
                        "dex_total": dex_total,
                        "control_label": control_label,
                        "control_events": control_events,
                        "control_total": control_total,
                        "mapping_method": "manual_override",
                        "qc_flags": ";".join(qc_flags_base),
                    }
                )
                dex_arm_count_by_trial[trial_id] += 1

            linkage_rows.append(
                {
                    "trial_id": trial_id,
                    "study_label": study_label,
                    "status": "extracted",
                    "candidate_studyIDs": candidate_text,
                    "notes": f"selected {selected_study_id}; manual counts override applied",
                }
            )
            continue

        event_row = canonical_by_study_id[selected_study_id]
        control_label = clean_text(event_row.get("Control"))
        control_norm = normalize_control_label(control_label)

        if control_norm not in CONTROL_ALLOWED:
            linkage_rows.append(
                {
                    "trial_id": trial_id,
                    "study_label": study_label,
                    "status": "control_mismatch",
                    "candidate_studyIDs": candidate_text,
                    "notes": f"control '{control_label}' is outside strict placebo/saline scope",
                }
            )
            continue

        dex_indices = detect_dex_arm_indices(event_row)
        keep_indices = TRIAL_DEX_ARM_KEEP.get(trial_id)
        if keep_indices is not None:
            dex_indices = [idx for idx in dex_indices if idx in keep_indices]
        if not dex_indices:
            linkage_rows.append(
                {
                    "trial_id": trial_id,
                    "study_label": study_label,
                    "status": "no_dex_arm",
                    "candidate_studyIDs": candidate_text,
                    "notes": "no dexmedetomidine arm detected in Intervention1/2/3",
                }
            )
            continue

        control_events = _int_from_field(event_row, "Control_cases")
        control_total = _int_from_field(event_row, "Control_total")
        if control_events > control_total:
            raise ValueError(f"Control events exceed total for {selected_study_id}")

        qc_flags_base: list[str] = []
        if key_used_alias:
            qc_flags_base.append("used_study_key_alias")
        if mapping_method == "ambiguity_rule":
            qc_flags_base.append("resolved_ambiguity_by_dexmedetomidine_name")
        if len(dex_indices) > 1:
            qc_flags_base.append("multi_dex_trial")

        for idx in dex_indices:
            dex_events = _int_from_field(event_row, _arm_cases_field(idx))
            dex_total = _int_from_field(event_row, _arm_total_field(idx))
            if dex_events > dex_total:
                raise ValueError(f"Dex arm events exceed total for {selected_study_id} arm {idx}")

            arm_rows.append(
                {
                    "trial_id": trial_id,
                    "study_label": study_label,
                    "study_key": study_key,
                    "studyID_csv": selected_study_id,
                    "dex_arm_index": idx,
                    "dex_arm_label": TRIAL_ARM_LABEL_OVERRIDES.get(
                        (trial_id, idx),
                        clean_text(event_row.get(f"Intervention{idx}")),
                    ),
                    "dex_events": dex_events,
                    "dex_total": dex_total,
                    "control_label": control_label,
                    "control_events": control_events,
                    "control_total": control_total,
                    "mapping_method": mapping_method,
                    "qc_flags": ";".join(qc_flags_base),
                }
            )
            dex_arm_count_by_trial[trial_id] += 1

        linkage_rows.append(
            {
                "trial_id": trial_id,
                "study_label": study_label,
                "status": "extracted",
                "candidate_studyIDs": candidate_text,
                "notes": f"selected {selected_study_id}",
            }
        )

    # Integrity: each trial should map to exactly one linkage status.
    if len(linkage_rows) != len(trials):
        raise ValueError("Internal error: linkage report row count does not equal curated trial count")

    # Integrity: no duplicate arm index rows for the same trial.
    seen_pairs: set[tuple[str, int]] = set()
    for row in arm_rows:
        pair = (str(row["trial_id"]), int(row["dex_arm_index"]))
        if pair in seen_pairs:
            raise ValueError(f"Duplicate (trial_id, dex_arm_index) row detected: {pair}")
        seen_pairs.add(pair)

    status_counts = Counter(row["status"] for row in linkage_rows)
    n_extracted_trials = status_counts.get("extracted", 0)
    n_missing_in_csv = status_counts.get("missing_in_csv", 0)
    n_control_mismatch = status_counts.get("control_mismatch", 0)
    n_ambiguous_unresolved = status_counts.get("ambiguous_unresolved", 0)
    n_inconsistent_csv_rows = status_counts.get("inconsistent_csv_rows", 0)
    n_manually_excluded = status_counts.get("manually_excluded", 0)
    n_multi_dex_trials = sum(1 for _, count in dex_arm_count_by_trial.items() if count > 1)

    coverage = {
        "n_trials_curated": len(trials),
        "n_extracted_trials": n_extracted_trials,
        "n_extracted_rows": len(arm_rows),
        "n_missing_in_csv": n_missing_in_csv,
        "n_control_mismatch": n_control_mismatch,
        "n_ambiguous_unresolved": n_ambiguous_unresolved,
        "n_inconsistent_csv_rows": n_inconsistent_csv_rows,
        "n_manually_excluded": n_manually_excluded,
        "n_multi_dex_trials": n_multi_dex_trials,
    }

    # Accounting identity from trial-level statuses.
    if (
        n_extracted_trials
        + n_missing_in_csv
        + n_control_mismatch
        + n_ambiguous_unresolved
        + n_inconsistent_csv_rows
        + n_manually_excluded
        + status_counts.get("no_dex_arm", 0)
    ) != len(trials):
        raise ValueError("Status accounting failed: linkage statuses do not reconcile to curated trial count")

    return arm_rows, linkage_rows, coverage


def main() -> None:
    args = parse_args()

    trials = _read_trials(args.trials_curated)
    event_rows = _read_event_rows(args.event_data)
    arm_rows, linkage_rows, coverage = run_extraction(trials=trials, event_rows=event_rows)

    _write_csv(args.arm_level_out, ARM_OUTPUT_COLUMNS, arm_rows)
    _write_csv(args.linkage_report_out, LINKAGE_OUTPUT_COLUMNS, linkage_rows)
    args.coverage_summary_out.parent.mkdir(parents=True, exist_ok=True)
    args.coverage_summary_out.write_text(json.dumps(coverage, indent=2), encoding="utf-8")

    print(f"[delirium-prevalence] Curated trials: {coverage['n_trials_curated']}")
    print(f"[delirium-prevalence] Extracted trials: {coverage['n_extracted_trials']}")
    print(f"[delirium-prevalence] Extracted arm rows: {coverage['n_extracted_rows']}")
    print(f"[delirium-prevalence] Missing in CSV: {coverage['n_missing_in_csv']}")
    print(f"[delirium-prevalence] Control mismatch: {coverage['n_control_mismatch']}")
    print(f"[delirium-prevalence] Ambiguous unresolved: {coverage['n_ambiguous_unresolved']}")
    print(f"[delirium-prevalence] Inconsistent CSV rows: {coverage['n_inconsistent_csv_rows']}")
    print(f"[delirium-prevalence] Manually excluded: {coverage['n_manually_excluded']}")
    print(f"[delirium-prevalence] Multi-dex trials: {coverage['n_multi_dex_trials']}")


if __name__ == "__main__":
    main()
