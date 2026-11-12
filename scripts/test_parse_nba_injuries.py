import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("nba_injuries", Path(__file__).with_name("parse-nba-injuries.py"))
injuries = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(injuries)

# Excerpts follow the actual official 2026-11-12 11:30 AM report layout.
# Synthetic filler reason text keeps this fixture small and tests wrapping.
HEADER = "Injury Report: 11/12/26 11:30 AM\nPage 1 of 3\nGame Date Game Time Matchup Team Player Name Current Status Reason\n"
FIXTURE = HEADER + """11/12/2026 07:00 (ET) TOR@PHI Toronto Raptors NOT YET SUBMITTED
Philadelphia 76ers Barlow, Dominick Out
Injury/Illness - Low Back Stress
Reaction
08:00 (ET) DAL@MIN Dallas Mavericks Johnson Jr., Morez Probable
Injury/Illness - Left Shin / Tibia
Contusion
Lively II, Dereck Out Injury/Illness - Right Foot Surgery
Martin, Caleb Available Injury/Illness - Right Thumb Splint
Injury Report: 11/12/26 11:30 AM
Page 2 of 3
Minnesota Timberwolves Beringer, Joan Available Injury/Illness - Face Mask
11/13/2026 07:00 (ET) MIL@ORL Milwaukee Bucks NOT YET SUBMITTED
Orlando Magic NOT YET SUBMITTED
"""


class InjuryParserTests(unittest.TestCase):
    def parse(self, text=FIXTURE):
        return injuries.parse_text(text, "2026-11-12", "11:30")

    def test_real_rows_wrapped_reasons_and_time(self):
        result = self.parse()
        self.assertEqual(result["ReportIssuedAtUtc"], "2026-11-12T16:30:00Z")
        self.assertEqual(result["Status"], "partial")
        rows = {p["Player"]: p for p in result["Players"]}
        self.assertEqual(rows["Morez Johnson Jr."]["Status"], "Probable")
        self.assertEqual(rows["Dereck Lively II"]["Status"], "Out")
        self.assertEqual(rows["Dominick Barlow"]["Reason"], "Injury/Illness - Low Back Stress Reaction")
        self.assertEqual(rows["Caleb Martin"]["Status"], "Available")
        self.assertEqual(rows["Joan Beringer"]["GameDateET"], "2026-11-12")
        self.assertIn("Toronto Raptors", result["UnsubmittedTeams"])
        self.assertIn({"GameDateET": "2026-11-13", "TeamName": "Orlando Magic", "Submitted": False}, result["TeamReports"])
        self.assertFalse(result["Warnings"])
        self.assertNotIn("Unknown Player", rows)

    def test_absent_or_unsubmitted_never_available(self):
        result = self.parse(HEADER + "11/12/2026 07:00 (ET) TOR@PHI Toronto Raptors NOT YET SUBMITTED\nPhiladelphia 76ers NOT YET SUBMITTED")
        self.assertEqual(result["Status"], "unknown")
        self.assertEqual(result["Players"], [])
        self.assertEqual(len(result["UnsubmittedTeams"]), 2)

    def test_header_must_match_filename(self):
        with self.assertRaisesRegex(injuries.ParseProblem, "InjuryReportTimestampMismatch"):
            injuries.parse_text(FIXTURE, "2026-11-12", "11:15")
        with self.assertRaisesRegex(injuries.ParseProblem, "InjuryReportTimestampMismatch"):
            self.parse(FIXTURE.replace("Page 2 of 3", "Injury Report: 11/12/26 11:15 AM\nPage 2 of 3"))
        with self.assertRaisesRegex(injuries.ParseProblem, "InjuryReportHeaderMissing"):
            self.parse("No report")

    def test_unknown_layout_is_partial_and_not_health(self):
        result = self.parse(HEADER + "11/12/2026 07:00 (ET) DAL@MIN Dallas Mavericks Martin, Caleb Available Injury/Illness - Thumb\nUnexpected schema row")
        # A continuation cannot create any additional player or healthy status.
        self.assertEqual(len(result["Players"]), 1)
        self.assertNotEqual(result["Players"][0]["Player"], "Unexpected schema row")
        result = self.parse(HEADER + "11/12/2026 07:00 (ET) DAL@MIN Dallas Mavericks Jones, Test Unknown Injury/Illness - Thumb")
        self.assertEqual(result["Status"], "unknown")
        self.assertEqual(result["Players"], [])

    def test_duplicates_are_excluded(self):
        result = self.parse(HEADER + "11/12/2026 07:00 (ET) DAL@MIN Dallas Mavericks Martin, Caleb Available Injury/Illness - Thumb\nMartin, Caleb Out Injury/Illness - Thumb")
        self.assertEqual(result["Players"], [])
        self.assertIn("InjuryPlayerDuplicate", result["Warnings"])

    def test_page_header_can_be_joined_to_table(self):
        text = HEADER + "11/12/2026 08:00 (ET) DAL@MIN Dallas Mavericks Johnson Jr., Morez Probable Injury/Illness - ShinInjury Report: 11/12/26 11:30 AM\nPage 2 of 3\nLively II, Dereck Out Injury/Illness - Foot"
        result = self.parse(text)
        self.assertEqual(len(result["Players"]), 2)
        self.assertEqual(result["Players"][0]["Reason"], "Injury/Illness - Shin")

    def test_missing_reason_and_invalid_names_are_unknown(self):
        result = self.parse(HEADER + "11/12/2026 08:00 (ET) DAL@MIN Dallas Mavericks Johnson Jr., Morez Probable")
        self.assertEqual(result["Status"], "partial")
        self.assertIsNone(result["Players"][0]["Reason"])
        self.assertIsNone(injuries.player_name("<script>, Evil"))

    def test_pdf_validation_precedes_dependency(self):
        with self.assertRaisesRegex(injuries.ParseProblem, "InjuryPdfFormatInvalid"):
            injuries.parse_pdf(b"not a pdf", "2026-11-12", "11:30")

    def test_bad_date_and_dst_ambiguity_rejected(self):
        with self.assertRaises(injuries.ParseProblem):
            injuries.parse_text(FIXTURE, "2026-02-31", "11:30")
        with self.assertRaisesRegex(injuries.ParseProblem, "InjuryReportTimeAmbiguous"):
            injuries.parse_text("Injury Report: 11/01/26 01:30 AM", "2026-11-01", "01:30")


if __name__ == "__main__":
    unittest.main()
