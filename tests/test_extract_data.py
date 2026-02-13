"""Unit tests for reference-link extraction helpers."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1] / "scripts"))

from extract_data import extract_reference_url, parse_reference_number_from_study  # noqa: E402


class ExtractDataTests(unittest.TestCase):
    def test_parse_reference_number_from_study(self) -> None:
        self.assertEqual(parse_reference_number_from_study("Momeni 2021100"), 100)
        self.assertEqual(parse_reference_number_from_study("van Norden 2021132"), 132)
        self.assertEqual(parse_reference_number_from_study("Liu 202179"), 79)
        self.assertIsNone(parse_reference_number_from_study("Li 2023"))

    def test_extract_reference_url_prefers_doi_url(self) -> None:
        entry = (
            "Momeni M, Khalifa C. ... Br J Anaesth 2021;126(3):665-73. "
            "doi: https://dx.doi.org/10.1016/j.bja.2020.10.041 PT - Article"
        )
        self.assertEqual(
            extract_reference_url(entry),
            "https://dx.doi.org/10.1016/j.bja.2020.10.041",
        )

    def test_extract_reference_url_from_plain_doi(self) -> None:
        entry = "He Y, et al. ... 2022;12(3):396-99. doi: 10.3969/j.issn.2095-1264.2022.03.17"
        self.assertEqual(
            extract_reference_url(entry),
            "https://doi.org/10.3969/j.issn.2095-1264.2022.03.17",
        )


if __name__ == "__main__":
    unittest.main()
