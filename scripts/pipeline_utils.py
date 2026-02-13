"""Shared parsing and normalization utilities for the dexmedetomidine atlas."""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import pandas as pd

VALID_ROB_CATEGORIES = {"Low risk", "Some concerns", "High risk"}


@dataclass(frozen=True)
class ParsedDose:
    """Normalized dose fields for a single intervention text."""

    bolus_value: float | None
    bolus_unit: str | None
    bolus_unit_raw: str | None
    infusion_low: float | None
    infusion_high: float | None
    infusion_unit: str | None
    infusion_unit_raw: str | None
    infusion_weight_normalized: bool


def clean_text(value: Any) -> str:
    """Normalize whitespace and unicode for deterministic string handling."""
    if value is None:
        return ""
    if not isinstance(value, str):
        value = str(value)
    text = unicodedata.normalize("NFKC", value)
    text = text.replace("\n", " ").replace("\r", " ").strip()
    text = re.sub(r"\s+", " ", text)
    return text


def clean_study_label(value: str) -> str:
    """Remove footnote digits appended to year and normalize spacing."""
    text = clean_text(value)
    text = re.sub(r"(\b\d{4})\d{1,3}\b", r"\1", text)
    return clean_text(text)


def normalize_study_key(value: str) -> str:
    """Build stable key of form Surname_Year for cross-file matching."""
    text = clean_study_label(value)
    text_ascii = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    match = re.search(r"(?P<author>.+?)\s*(?P<year>\d{4})", text_ascii)
    if not match:
        tokenized = re.sub(r"[^A-Za-z0-9]+", "_", text_ascii).strip("_")
        return tokenized.lower()

    author = match.group("author")
    year = match.group("year")
    author = re.sub(r"[^A-Za-z]+", "_", author).strip("_")
    author = re.sub(r"_+", "_", author)
    return f"{author}_{year}".lower()


def parse_simple_yaml_lists(path: Path) -> dict[str, list[str]]:
    """Parse a small YAML subset used for include/exclude term lists."""
    data: dict[str, list[str]] = {}
    current_key: str | None = None
    for line in path.read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#"):
            continue
        if raw.endswith(":"):
            current_key = raw[:-1].strip()
            data[current_key] = []
            continue
        if raw.startswith("-") and current_key is not None:
            item = raw[1:].strip().strip("\"'")
            data[current_key].append(item)
            continue
        raise ValueError(f"Unsupported YAML line in {path}: {line}")
    return data


def classify_comparator(control_text: str, include_terms: Iterable[str], exclude_terms: Iterable[str]) -> str:
    """Classify comparator as placebo/saline, active control, or unclear."""
    lowered = clean_text(control_text).lower()
    if not lowered:
        return "unclear"

    has_include = any(term.lower() in lowered for term in include_terms)
    has_exclude = any(term.lower() in lowered for term in exclude_terms)

    if has_include and not has_exclude:
        return "placebo_or_saline"
    if has_include and has_exclude:
        return "mixed_control"
    if has_exclude:
        return "active_control"
    return "unclear"


def extract_dex_arm_text(intervention_text: str) -> str:
    """Extract dexmedetomidine-specific arm text from multi-arm descriptions."""
    text = clean_text(intervention_text)
    if not text:
        return text

    arm_parts = [p.strip(" ,;") for p in re.split(r"(?i)(?=arm\s*\d+\s*:)", text) if p.strip()]
    if arm_parts and any("arm" in p.lower() for p in arm_parts):
        dex_parts = [p for p in arm_parts if re.search(r"dexmedetomidine|\bdex\b", p, re.IGNORECASE)]
        if dex_parts:
            return " | ".join(dex_parts)
    return text


def _convert_to_mcg(value: float, unit: str) -> float:
    unit_l = unit.lower()
    if unit_l in {"mcg", "ug", "μg"}:
        return value
    if unit_l == "mg":
        return value * 1000.0
    return value


def _coerce_float(text: str | None) -> float | None:
    if text is None:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_dose(intervention_text: str) -> ParsedDose:
    """Parse bolus and infusion doses from intervention text with unit harmonization."""
    text = clean_text(intervention_text).lower()
    text = text.replace("µg", "mcg").replace("μg", "mcg")

    bolus_value: float | None = None
    bolus_unit: str | None = None
    bolus_unit_raw: str | None = None
    infusion_low: float | None = None
    infusion_high: float | None = None
    infusion_unit: str | None = None
    infusion_unit_raw: str | None = None
    infusion_weight_normalized = False

    bolus_patterns = [
        re.compile(
            r"(?:loading\s*dose|loading|bolus)[^\d]{0,20}(\d+(?:\.\d+)?)\s*(mg|mcg|ug)\s*/\s*kg(?!\s*/\s*(?:h|hr|hour))",
            re.IGNORECASE,
        ),
        re.compile(
            r"(\d+(?:\.\d+)?)\s*(mg|mcg|ug)\s*/\s*kg(?!\s*/\s*(?:h|hr|hour))[^\.;,]{0,25}(?:loading|bolus)",
            re.IGNORECASE,
        ),
    ]

    for pattern in bolus_patterns:
        match = pattern.search(text)
        if match:
            bolus_raw = _coerce_float(match.group(1))
            if bolus_raw is not None:
                bolus_unit_raw = match.group(2).lower()
                bolus_value = round(_convert_to_mcg(bolus_raw, bolus_unit_raw), 6)
                bolus_unit = "mcg/kg"
            break

    infusion_patterns = [
        re.compile(
            r"(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(mg|mcg|ug)\s*/\s*kg\s*/\s*(?:h|hr|hour)",
            re.IGNORECASE,
        ),
        re.compile(
            r"(\d+(?:\.\d+)?)\s*(mg|mcg|ug)\s*/\s*kg\s*/\s*(?:h|hr|hour)",
            re.IGNORECASE,
        ),
    ]

    for pattern in infusion_patterns:
        match = pattern.search(text)
        if not match:
            continue
        if len(match.groups()) == 3:
            low_raw = _coerce_float(match.group(1))
            high_raw = _coerce_float(match.group(2))
            unit = match.group(3).lower()
            if low_raw is None or high_raw is None:
                continue
            infusion_low = round(_convert_to_mcg(low_raw, unit), 6)
            infusion_high = round(_convert_to_mcg(high_raw, unit), 6)
        else:
            low_raw = _coerce_float(match.group(1))
            unit = match.group(2).lower()
            if low_raw is None:
                continue
            infusion_low = round(_convert_to_mcg(low_raw, unit), 6)
            infusion_high = infusion_low
        infusion_unit_raw = unit
        infusion_unit = "mcg/kg/h"
        infusion_weight_normalized = True
        break

    if infusion_unit is None:
        fixed_rate = re.search(r"(\d+(?:\.\d+)?)\s*(mg|mcg|ug)\s*/\s*(?:h|hr|hour)", text, re.IGNORECASE)
        if fixed_rate:
            value_raw = _coerce_float(fixed_rate.group(1))
            if value_raw is not None:
                fixed_unit = fixed_rate.group(2).lower()
                infusion_low = round(_convert_to_mcg(value_raw, fixed_unit), 6)
                infusion_high = infusion_low
                infusion_unit = "mcg/h"
                infusion_unit_raw = fixed_unit
                infusion_weight_normalized = False

    return ParsedDose(
        bolus_value=bolus_value,
        bolus_unit=bolus_unit,
        bolus_unit_raw=bolus_unit_raw,
        infusion_low=infusion_low,
        infusion_high=infusion_high,
        infusion_unit=infusion_unit,
        infusion_unit_raw=infusion_unit_raw,
        infusion_weight_normalized=infusion_weight_normalized,
    )


def adjust_implausible_dex_units(parsed_dose: ParsedDose) -> tuple[ParsedDose, list[str]]:
    """Apply plausibility correction for dexmedetomidine mg vs mcg unit artifacts."""
    flags: list[str] = []

    bolus_value = parsed_dose.bolus_value
    bolus_unit = parsed_dose.bolus_unit
    bolus_unit_raw = parsed_dose.bolus_unit_raw
    infusion_low = parsed_dose.infusion_low
    infusion_high = parsed_dose.infusion_high
    infusion_unit = parsed_dose.infusion_unit
    infusion_unit_raw = parsed_dose.infusion_unit_raw
    infusion_weight_normalized = parsed_dose.infusion_weight_normalized

    # Dex bolus >10 mcg/kg is usually implausible in these trials and often OCR/unit drift from mg->mcg.
    if bolus_unit_raw == "mg" and bolus_value is not None and bolus_value > 10.0:
        bolus_value = round(bolus_value / 1000.0, 6)
        bolus_unit = "mcg/kg"
        flags.append("dose_unit_mg_interpreted_as_mcg")

    # Dex infusion >5 mcg/kg/h is implausible and frequently indicates mg->mcg drift.
    if infusion_unit_raw == "mg" and infusion_low is not None and infusion_low > 5.0:
        infusion_low = round(infusion_low / 1000.0, 6)
        infusion_high = round((infusion_high or infusion_low) / 1000.0, 6)
        infusion_unit = "mcg/kg/h" if infusion_weight_normalized else "mcg/h"
        flags.append("infusion_unit_mg_interpreted_as_mcg")

    adjusted = ParsedDose(
        bolus_value=bolus_value,
        bolus_unit=bolus_unit,
        bolus_unit_raw=bolus_unit_raw,
        infusion_low=infusion_low,
        infusion_high=infusion_high,
        infusion_unit=infusion_unit,
        infusion_unit_raw=infusion_unit_raw,
        infusion_weight_normalized=infusion_weight_normalized,
    )
    return adjusted, flags


def classify_timing_phase(timing_raw: str, intervention_text: str) -> str:
    """Map free text timing descriptions to canonical timing phase."""
    text = f"{clean_text(timing_raw)} {clean_text(intervention_text)}".lower()
    has_pre = any(token in text for token in ["prior", "before", "pre", "induction"])
    has_intra = any(token in text for token in ["during", "intra", "surgery"])
    has_post = any(token in text for token in ["after", "post", "recovery", "icu", "pca"])

    total_true = sum([has_pre, has_intra, has_post])
    if total_true > 1:
        return "peri_multi"
    if has_pre:
        return "pre_op"
    if has_intra:
        return "intra_op"
    if has_post:
        return "post_op"
    return "unknown"


def classify_route(route_raw: str, intervention_text: str) -> str:
    """Map route text to a canonical route class."""
    text = f"{clean_text(route_raw)} {clean_text(intervention_text)}".lower()
    tokens = []
    if any(t in text for t in ["intravenous", " iv", "iv ", " iv "]):
        tokens.append("IV")
    if any(t in text for t in ["intranasal", " nasal", " in "]):
        tokens.append("IN")
    if any(t in text for t in ["inh", "inhal", "volatile"]):
        tokens.append("INH")
    if any(t in text for t in [" oral", " po", "tablet"]):
        tokens.append("PO")
    if any(t in text for t in ["intramuscular", " im"]):
        tokens.append("IM")

    tokens = sorted(set(tokens))
    if not tokens:
        return "Unknown"
    return "+".join(tokens)


def parse_n_total(raw_n: str) -> int | None:
    """Parse sample size field from string."""
    text = clean_text(raw_n)
    if not text:
        return None
    match = re.search(r"\d+", text)
    if not match:
        return None
    return int(match.group(0))


def rob_category_with_precedence(overall_col10: Any, fallback_col13: Any) -> tuple[str, str | None, list[str]]:
    """Resolve RoB overall with precedence and return flags."""
    flags: list[str] = []
    col10 = clean_text(overall_col10)
    col13 = clean_text(fallback_col13)

    if col10 in VALID_ROB_CATEGORIES:
        return col10, col10, flags
    if col13 in VALID_ROB_CATEGORIES:
        flags.append("rob_from_fallback_col13")
        return col13, col13, flags

    flags.append("rob_missing_defaulted")
    raw = col10 or col13 or None
    return "Some concerns", raw, flags


def calculate_extraction_confidence(parsed_dose: ParsedDose, timing_phase: str, route_std: str) -> float:
    """Simple deterministic confidence score for extraction completeness."""
    score = 1.0
    if parsed_dose.bolus_value is None:
        score -= 0.15
    if parsed_dose.infusion_low is None:
        score -= 0.25
    if timing_phase == "unknown":
        score -= 0.2
    if route_std == "Unknown":
        score -= 0.2
    return max(0.05, round(score, 3))


def write_dataframe_with_parquet_fallback(df: pd.DataFrame, parquet_path: Path) -> dict[str, Any]:
    """Write parquet when available; otherwise write CSV fallback and metadata note."""
    parquet_path.parent.mkdir(parents=True, exist_ok=True)
    csv_fallback_path = parquet_path.with_suffix(parquet_path.suffix + ".csv")
    metadata_path = parquet_path.with_suffix(parquet_path.suffix + ".meta.json")

    metadata: dict[str, Any] = {
        "target_parquet": str(parquet_path),
        "fallback_csv": str(csv_fallback_path),
        "parquet_written": False,
        "row_count": int(df.shape[0]),
        "column_count": int(df.shape[1]),
    }

    try:
        df.to_parquet(parquet_path, index=False)
        metadata["parquet_written"] = True
        if csv_fallback_path.exists():
            csv_fallback_path.unlink()
    except Exception as exc:  # noqa: BLE001 - explicit fallback path
        df.to_csv(csv_fallback_path, index=False)
        metadata["parquet_error"] = str(exc)

    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


def read_dataframe_with_parquet_fallback(parquet_path: Path) -> pd.DataFrame:
    """Read parquet or fallback CSV written by write_dataframe_with_parquet_fallback."""
    if parquet_path.exists():
        return pd.read_parquet(parquet_path)

    csv_fallback_path = parquet_path.with_suffix(parquet_path.suffix + ".csv")
    if csv_fallback_path.exists():
        return pd.read_csv(csv_fallback_path)

    raise FileNotFoundError(f"Neither parquet nor fallback CSV exists for {parquet_path}")
