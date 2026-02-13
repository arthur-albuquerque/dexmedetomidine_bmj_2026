"""Unit tests for deterministic parsing helpers."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1] / "scripts"))

from pipeline_utils import (  # noqa: E402
    classify_comparator,
    classify_timing_phase,
    extract_dex_arm_text,
    normalize_study_key,
    parse_dose,
    rob_category_with_precedence,
)


class PipelineUtilsTests(unittest.TestCase):
    def test_extract_dex_arm_from_multi_arm_text(self) -> None:
        text = (
            "Arm 1: Propofol 2 mg/kg/h "
            "Arm 2: Dexmedetomidine 1 mcg/kg bolus, 0.4 mcg/kg/h infusion"
        )
        result = extract_dex_arm_text(text)
        self.assertIn("Dexmedetomidine", result)
        self.assertNotIn("Propofol", result)

    def test_parse_dose_single_bolus_and_infusion(self) -> None:
        dose = parse_dose("Dexmedetomidine 1 mcg/kg loading, infusion 0.2 mcg/kg/h")
        self.assertEqual(dose.bolus_value, 1.0)
        self.assertEqual(dose.bolus_unit, "mcg/kg")
        self.assertEqual(dose.infusion_low, 0.2)
        self.assertEqual(dose.infusion_high, 0.2)
        self.assertEqual(dose.infusion_unit, "mcg/kg/h")
        self.assertTrue(dose.infusion_weight_normalized)

    def test_parse_dose_range(self) -> None:
        dose = parse_dose("Dexmedetomidine infusion 0.2-0.7 mcg/kg/h")
        self.assertIsNone(dose.bolus_value)
        self.assertEqual(dose.infusion_low, 0.2)
        self.assertEqual(dose.infusion_high, 0.7)

    def test_parse_dose_non_weight_normalized(self) -> None:
        dose = parse_dose("Dexmedetomidine background infusion 1.25 mcg/h")
        self.assertEqual(dose.infusion_low, 1.25)
        self.assertEqual(dose.infusion_unit, "mcg/h")
        self.assertFalse(dose.infusion_weight_normalized)

    def test_timing_phase_uses_structured_timing_first(self) -> None:
        phase = classify_timing_phase(
            timing_raw="During surgery",
            intervention_text="continued up to 2 hours in recovery",
        )
        self.assertEqual(phase, "intra_op")

    def test_timing_phase_postop(self) -> None:
        phase = classify_timing_phase(
            timing_raw="After surgery complete",
            intervention_text="Dexmedetomidine infusion",
        )
        self.assertEqual(phase, "post_op")

    def test_comparator_classifier(self) -> None:
        include_terms = ["saline", "placebo", "equivolume saline", "usual care", "sham"]
        exclude_terms = ["propofol", "midazolam", "remifentanil"]

        self.assertEqual(
            classify_comparator("Equivolume saline", include_terms, exclude_terms),
            "placebo_or_saline",
        )
        self.assertEqual(
            classify_comparator("Propofol", include_terms, exclude_terms),
            "active_control",
        )

    def test_rob_precedence(self) -> None:
        rob_std, rob_raw, flags = rob_category_with_precedence("Low risk", None)
        self.assertEqual(rob_std, "Low risk")
        self.assertEqual(rob_raw, "Low risk")
        self.assertEqual(flags, [])

        rob_std_2, _, flags_2 = rob_category_with_precedence(None, "High risk")
        self.assertEqual(rob_std_2, "High risk")
        self.assertIn("rob_from_fallback_col13", flags_2)

        rob_std_3, _, flags_3 = rob_category_with_precedence("", "Randomisation process")
        self.assertEqual(rob_std_3, "Some concerns")
        self.assertIn("rob_missing_defaulted", flags_3)

    def test_normalize_study_key(self) -> None:
        self.assertEqual(normalize_study_key("Abd Ellatif 20241"), "abd_ellatif_2024")
        self.assertEqual(normalize_study_key("van Norden 2021"), "van_norden_2021")


if __name__ == "__main__":
    unittest.main()
