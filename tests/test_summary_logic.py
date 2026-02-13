"""Unit tests for summary metric generation."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd

sys.path.append(str(Path(__file__).resolve().parents[1] / "scripts"))

from summarize_data import dose_band, summarize_subset  # noqa: E402


class SummaryLogicTests(unittest.TestCase):
    def test_dose_band_weight_normalized(self) -> None:
        row = {
            "infusion_low": 0.2,
            "infusion_high": 0.4,
            "infusion_unit": "mcg/kg/h",
            "infusion_weight_normalized": True,
        }
        self.assertEqual(dose_band(row), "0.2-0.5")

    def test_dose_band_not_reported(self) -> None:
        row = {
            "infusion_low": None,
            "infusion_high": None,
            "infusion_unit": None,
            "infusion_weight_normalized": False,
        }
        self.assertEqual(dose_band(row), "not_reported")

    def test_summary_counts(self) -> None:
        df = pd.DataFrame(
            [
                {
                    "n_total": 100,
                    "bolus_value": 1.0,
                    "infusion_low": 0.2,
                    "infusion_high": 0.2,
                    "infusion_unit": "mcg/kg/h",
                    "infusion_weight_normalized": True,
                    "timing_phase": "intra_op",
                    "route_std": "IV",
                },
                {
                    "n_total": 50,
                    "bolus_value": None,
                    "infusion_low": None,
                    "infusion_high": None,
                    "infusion_unit": None,
                    "infusion_weight_normalized": False,
                    "timing_phase": "unknown",
                    "route_std": "Unknown",
                },
            ]
        )

        summary = summarize_subset(df)
        self.assertEqual(summary["n_trials"], 2)
        self.assertEqual(summary["n_participants"], 150)
        self.assertEqual(summary["missingness"]["infusion_missing"], 1)
        self.assertEqual(summary["missingness"]["timing_missing"], 1)


if __name__ == "__main__":
    unittest.main()
