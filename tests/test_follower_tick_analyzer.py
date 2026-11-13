import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "analyze-follower-ticks.py"


class FollowerTickAnalyzerTests(unittest.TestCase):
    def make_session(self, root: Path):
        session = root / "session-1"
        chunk = session / "2026-11-13T10-00-00-000Z-0"
        chunk.mkdir(parents=True)
        (session / "manifest.json").write_text(json.dumps({
            "status": "CLOSED", "counters": {"written": 3, "dropped": 0,
            "writeUncertain": 0, "coverageGaps": 0}
        }))
        (chunk / "token-stat.jsonl").write_text("\n".join([
            json.dumps({"receivedAt": 1000, "receiveSequence": 1, "mint": "M1", "channel": "token_stat", "raw": {"p": 1.0}}),
            json.dumps({"receivedAt": 2000, "receiveSequence": 2, "mint": "M1", "channel": "token_stat", "raw": {"p": 0.5}}),
        ]) + "\n")
        (chunk / "decisions.jsonl").write_text(json.dumps({
            "observedAt": 1500, "kind": "scenario_action", "actionId": "a1",
            "mint": "M1", "side": "SELL", "reason": "EXIT"
        }) + "\n")
        return session

    def test_cli_emits_ordered_tick_timeline_and_coverage_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = self.make_session(Path(tmp))
            result = subprocess.run([sys.executable, str(SCRIPT), str(session), "--mint", "M1", "--json"],
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["quality"]["status"], "CLOSED")
            self.assertEqual(report["counts"]["token_stat"], 2)
            self.assertEqual([row["receivedAt"] for row in report["timeline"]], [1000, 1500, 2000])
            self.assertEqual(report["timeline"][0]["price"], 1.0)
            self.assertEqual(report["timeline"][1]["kind"], "scenario_action")

    def test_incomplete_manifest_and_missing_mint_are_reported_not_hidden(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = self.make_session(Path(tmp))
            manifest_path = session / "manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["status"] = "INCOMPLETE"
            manifest["counters"]["dropped"] = 2
            manifest_path.write_text(json.dumps(manifest))
            result = subprocess.run([sys.executable, str(SCRIPT), str(session), "--mint", "MISSING", "--json"],
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["quality"]["status"], "INCOMPLETE")
            self.assertEqual(report["quality"]["dropped"], 2)
            self.assertEqual(report["counts"]["token_stat"], 0)
            self.assertEqual(report["quality"]["price_coverage"], "NONE")

    def test_non_finite_price_values_become_null_in_strict_json_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = self.make_session(Path(tmp))
            chunk = next(session.glob("*/token-stat.jsonl"))
            chunk.write_text(
                '{"receivedAt":1000,"receiveSequence":1,"mint":"M1","channel":"token_stat","raw":{"p":NaN}}\n'
                '{"receivedAt":2000,"receiveSequence":2,"mint":"M1","channel":"token_stat","raw":{"p":Infinity}}\n'
            )
            (session / "2026-11-13T10-00-00-000Z-0" / "decisions.jsonl").write_text(
                '{"observedAt":1500,"kind":"scenario_action","actionId":"a1","mint":"M1","side":"SELL","reason":"EXIT","priceUsd":NaN}\n'
            )
            result = subprocess.run([sys.executable, str(SCRIPT), str(session), "--mint", "M1", "--json"],
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout, parse_constant=lambda value: self.fail(f"non-standard JSON constant: {value}"))
            prices = [row["price"] for row in report["timeline"] if row["channel"] == "token_stat"]
            self.assertEqual(prices, [None, None])
            decision_prices = [row["price"] for row in report["timeline"] if row["channel"] == "decision"]
            self.assertEqual(decision_prices, [None])
            self.assertEqual(report["quality"]["price_coverage"], "NONE")

    def test_invalid_jsonl_fails_with_path_and_line_number(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = self.make_session(Path(tmp))
            chunk = next(session.glob("*/token-stat.jsonl"))
            with chunk.open("a") as handle:
                handle.write("{bad json}\n")
            result = subprocess.run([sys.executable, str(SCRIPT), str(session), "--mint", "M1", "--json"],
                                    text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("token-stat.jsonl:3", result.stderr)


if __name__ == "__main__":
    unittest.main()
