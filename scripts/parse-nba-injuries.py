#!/usr/bin/env python3
"""Parse the NBA's public injury PDF without treating absent rows as healthy.

Input is a bounded PDF on stdin. The report filename's Eastern date and time
must be supplied separately, then are checked against every repeated PDF header.
Only explicitly reported player statuses are returned. This helper never fetches
URLs, reads credentials, or prints source document text on an error.
"""
from __future__ import annotations

import argparse
import io
import json
import logging
import re
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

MAX_BYTES = 12 * 1024 * 1024
MAX_PAGES = 50
MAX_TEXT = 2 * 1024 * 1024
MAX_ROWS = 2000
DIAGNOSTICS = {}

# Team names are structural delimiters, never a player-to-team lookup. The
# returned spelling is always the one printed in the report.
TEAM_NAMES = (
    "Atlanta Hawks", "Boston Celtics", "Brooklyn Nets", "Charlotte Hornets",
    "Chicago Bulls", "Cleveland Cavaliers", "Dallas Mavericks", "Denver Nuggets",
    "Detroit Pistons", "Golden State Warriors", "Houston Rockets", "Indiana Pacers",
    "LA Clippers", "Los Angeles Clippers", "LA Lakers", "Los Angeles Lakers",
    "Memphis Grizzlies", "Miami Heat", "Milwaukee Bucks", "Minnesota Timberwolves",
    "New Orleans Pelicans", "New York Knicks", "Oklahoma City Thunder",
    "Orlando Magic", "Philadelphia 76ers", "Phoenix Suns", "Portland Trail Blazers",
    "Sacramento Kings", "San Antonio Spurs", "Toronto Raptors", "Utah Jazz",
    "Washington Wizards",
)
TEAM = re.compile(r"^(" + "|".join(re.escape(v) for v in sorted(TEAM_NAMES, key=len, reverse=True)) + r")(?:\s+|$)")
HEADER = re.compile(r"Injury Report:\s*(\d{2}/\d{2}/\d{2})\s+(\d{1,2}:\d{2})\s*(AM|PM)", re.I)
STATUS = re.compile(r"^(.+?,\s*.+?)\s+(Available|Probable|Questionable|Doubtful|Out)(?:\s+(.*))?$", re.I)
PREFIX_DATE = re.compile(r"^(\d{2}/\d{2}/\d{4})\s+")
PREFIX_TIME = re.compile(r"^(\d{1,2}:\d{2})\s*\(ET\)\s+")
PREFIX_MATCHUP = re.compile(r"^([A-Z]{2,3}@[A-Z]{2,3})\s+")
COLUMNS = re.compile(r"Game\s+Date\s+Game\s+Time\s+Matchup\s+Team\s+Player\s+Name\s+Current\s+Status\s+Reason", re.I)
PAGE = re.compile(r"Page\s+\d+\s+of\s+\d+", re.I)
SAFE_TEXT = re.compile(r"^[^<>\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]+$")


class ParseProblem(Exception):
    pass


def safe_problem(code: str):
    raise ParseProblem(code)


def calendar_date(value: str) -> str:
    try:
        date = datetime.strptime(value, "%Y-%m-%d")
    except (ValueError, TypeError):
        safe_problem("InvalidExpectedReportDate")
    if date.strftime("%Y-%m-%d") != value:
        safe_problem("InvalidExpectedReportDate")
    return value


def report_timestamp(text: str, expected_date: str, expected_time: str) -> str:
    calendar_date(expected_date)
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", expected_time or ""):
        safe_problem("InvalidExpectedReportTime")
    headers = list(HEADER.finditer(text))
    if not headers:
        safe_problem("InjuryReportHeaderMissing")
    timestamps = set()
    for match in headers:
        try:
            stamp = datetime.strptime(" ".join(match.groups()), "%m/%d/%y %I:%M %p")
        except ValueError:
            safe_problem("InjuryReportHeaderInvalid")
        if stamp.strftime("%Y-%m-%d") != expected_date or stamp.strftime("%H:%M") != expected_time:
            safe_problem("InjuryReportTimestampMismatch")
        # Noon/morning report times do not have daylight-saving ambiguity.
        # Reject the fall-back ambiguous hour instead of guessing its offset.
        eastern = ZoneInfo("America/New_York")
        earlier, later = stamp.replace(tzinfo=eastern, fold=0), stamp.replace(tzinfo=eastern, fold=1)
        if earlier.utcoffset() != later.utcoffset():
            safe_problem("InjuryReportTimeAmbiguous")
        timestamps.add(earlier.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"))
    if len(timestamps) != 1:
        safe_problem("InjuryReportTimestampMismatch")
    return next(iter(timestamps))


def player_name(value: str) -> str | None:
    if len(value) > 150 or not SAFE_TEXT.fullmatch(value) or value.count(",") != 1:
        return None
    family, first = [part.strip() for part in value.split(",", 1)]
    if not family or not first:
        return None
    # "Johnson Jr., Morez" and "Lively II, Dereck" retain their suffix.
    return first + " " + family


def parse_text(text: str, expected_date: str, expected_time: str) -> dict:
    if not isinstance(text, str) or len(text) > MAX_TEXT:
        safe_problem("InjuryReportTextTooLarge")
    DIAGNOSTICS.update({"Phase": "header", "TextCharacters": len(text),
                        "HeaderCount": len(list(HEADER.finditer(text))),
                        "ColumnLinePresent": bool(COLUMNS.search(text)),
                        "DateRowCount": len(re.findall(r"(?m)^\s*\d{2}/\d{2}/\d{4}\s+", text)),
                        "PlayerStatusRowCount": len(re.findall(r"\b(?:Available|Probable|Questionable|Doubtful|Out)\b", text))})
    issued = report_timestamp(text, expected_date, expected_time)
    DIAGNOSTICS.update({"HeaderDate": expected_date, "HeaderTime": expected_time, "Phase": "table"})
    # pypdf can join the last table row to the next page header. Remove only
    # known furniture, wherever it occurs; unknown text is not discarded.
    body = HEADER.sub("\n", text)
    body = PAGE.sub("\n", body)
    body = COLUMNS.sub("\n", body)
    warnings = set()
    players = []
    teams = {}
    current_date = None
    current_team = None
    pending = None

    def finish_row():
        nonlocal pending
        if pending is None:
            return
        reason = " ".join(pending.pop("_reason")).strip()
        if not reason or len(reason) > 1200 or not SAFE_TEXT.fullmatch(reason):
            warnings.add("InjuryReasonMissingOrInvalid")
            pending["Reason"] = None
        else:
            pending["Reason"] = reason
        players.append(pending)
        pending = None
        if len(players) > MAX_ROWS:
            safe_problem("InjuryReportTooManyRows")

    for raw_line in body.splitlines():
        line = " ".join(raw_line.split())
        if not line:
            continue
        prefix = PREFIX_DATE.match(line)
        if prefix:
            finish_row()
            try:
                current_date = datetime.strptime(prefix.group(1), "%m/%d/%Y").strftime("%Y-%m-%d")
            except ValueError:
                safe_problem("InjuryGameDateInvalid")
            current_team = None
            line = line[prefix.end():]
        prefix = PREFIX_TIME.match(line)
        if prefix:
            finish_row()
            current_team = None
            line = line[prefix.end():]
        prefix = PREFIX_MATCHUP.match(line)
        if prefix:
            finish_row()
            current_team = None
            line = line[prefix.end():]
        prefix = TEAM.match(line)
        if prefix:
            finish_row()
            current_team = prefix.group(1)
            line = line[prefix.end():]
        if not current_date or not current_team:
            warnings.add("InjuryTableStructureUnknown")
            continue
        key = (current_date, current_team)
        if line == "NOT YET SUBMITTED":
            finish_row()
            if teams.get(key) is True:
                warnings.add("InjuryTeamStatusConflict")
            teams[key] = False
            continue
        row = STATUS.match(line)
        if row:
            finish_row()
            name = player_name(row.group(1))
            if not name:
                warnings.add("InjuryPlayerNameInvalid")
                continue
            if teams.get(key) is False:
                warnings.add("InjuryTeamStatusConflict")
            else:
                teams[key] = True
            pending = {"Player": name, "TeamName": current_team, "GameDateET": current_date,
                       "Status": row.group(2).capitalize(), "_reason": [row.group(3)] if row.group(3) else []}
        elif pending:
            # A new comma-delimited name or known status in a continuation
            # indicates a layout change; never attach that text as an injury.
            if "," in line or "NOT YET SUBMITTED" in line or re.search(r"\b(?:Available|Probable|Questionable|Doubtful|Out)\b", line):
                finish_row()
                warnings.add("InjuryTableStructureUnknown")
            else:
                pending["_reason"].append(line)
        else:
            warnings.add("InjuryTableStructureUnknown")
    finish_row()
    # Conflicting or duplicate identities are not usable evidence. Retain no
    # row for that exact report/team/date/name key rather than choosing one.
    unique = {}
    duplicates = set()
    for row in players:
        key = (row["GameDateET"], row["TeamName"], row["Player"])
        if key in unique:
            duplicates.add(key)
            warnings.add("InjuryPlayerDuplicate")
        else:
            unique[key] = row
    players = [row for key, row in unique.items() if key not in duplicates]
    # A row under a conflicting/unsubmitted team does not override its status.
    players = [row for row in players if teams.get((row["GameDateET"], row["TeamName"])) is True]
    team_reports = [{"GameDateET": key[0], "TeamName": key[1], "Submitted": value}
                    for key, value in sorted(teams.items())]
    unsubmitted = sorted({row["TeamName"] for row in team_reports if row["Submitted"] is False})
    status = "unknown" if not players else "partial" if warnings or unsubmitted else "available"
    return {"Status": status, "ReportIssuedAtUtc": issued, "UnsubmittedTeams": unsubmitted,
            "TeamReports": team_reports, "Players": players, "Warnings": sorted(warnings)}


def parse_pdf(data: bytes, expected_date: str, expected_time: str) -> dict:
    DIAGNOSTICS.clear()
    DIAGNOSTICS["Phase"] = "pdf_validation"
    if not data or len(data) > MAX_BYTES:
        safe_problem("InjuryPdfSizeInvalid")
    if not data.startswith(b"%PDF-"):
        safe_problem("InjuryPdfFormatInvalid")
    DIAGNOSTICS["Phase"] = "dependency"
    try:
        from pypdf import PdfReader
    except ImportError:
        safe_problem("InjuryPdfDependencyUnavailable")
    try:
        # Malformed PDFs may trigger library diagnostics containing document
        # fragments. The caller receives only our fixed error codes.
        logging.getLogger("pypdf").disabled = True
        DIAGNOSTICS["Phase"] = "pdf_parse"
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            safe_problem("InjuryPdfEncrypted")
        if not 1 <= len(reader.pages) <= MAX_PAGES:
            safe_problem("InjuryPdfPageCountInvalid")
        DIAGNOSTICS.update({"PdfPages": len(reader.pages), "Phase": "text_extraction", "ExtractionMode": "layout"})
        pieces = []
        length = 0
        for page in reader.pages:
            # Layout extraction preserves columns while allowing wrapped
            # reasons; the parser supports whitespace-collapsed cell rows.
            piece = page.extract_text(extraction_mode="layout")
            if not isinstance(piece, str):
                safe_problem("InjuryPdfTextUnavailable")
            length += len(piece)
            if length > MAX_TEXT:
                safe_problem("InjuryReportTextTooLarge")
            pieces.append(piece)
    except ParseProblem:
        raise
    except Exception:
        safe_problem("InjuryPdfExtractionFailed")
    return parse_text("\n".join(pieces), expected_date, expected_time)


def main():
    parser = argparse.ArgumentParser(description="Parse an official NBA injury report from stdin")
    parser.add_argument("--expected-date", required=True)
    parser.add_argument("--expected-time", required=True)
    parser.add_argument("--text", action="store_true", help="Accept extracted UTF-8 text for fixtures")
    args = parser.parse_args()
    try:
        data = sys.stdin.buffer.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            safe_problem("InjuryPdfSizeInvalid")
        if args.text:
            try:
                text = data.decode("utf-8", errors="strict")
            except UnicodeDecodeError:
                safe_problem("InjuryReportTextInvalid")
            result = parse_text(text, args.expected_date, args.expected_time)
        else:
            result = parse_pdf(data, args.expected_date, args.expected_time)
        print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
    except Exception as exc:
        code = str(exc) if isinstance(exc, ParseProblem) else "InjuryReportParsingFailed"
        print(json.dumps({"Status": "unknown", "ReportIssuedAtUtc": None, "UnsubmittedTeams": [],
                          "TeamReports": [], "Players": [], "Warnings": [code], "ErrorType": code,
                          "Diagnostics": DIAGNOSTICS}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
