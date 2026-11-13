#!/usr/bin/env python3
"""Offline timeline analyzer for a single passive follower tick-capture session."""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

PRICE_FIELDS = ("p", "pu", "price", "priceUsd", "price_usd", "lastPriceUsd")
CHANNEL_FILES = {
    "token_activity": "token-activity.jsonl",
    "token_stat": "token-stat.jsonl",
    "wallet_activity_info": "wallet-activity.jsonl",
    "lifecycle": "lifecycle.jsonl",
    "decisions": "decisions.jsonl",
}


class AnalysisError(Exception):
    pass


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise AnalysisError(f"{path.name}:{line_number}: invalid JSON: {exc.msg}") from exc
            if not isinstance(value, dict):
                raise AnalysisError(f"{path.name}:{line_number}: expected JSON object")
            rows.append(value)
    return rows


def json_safe(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    return value


def raw_price(raw: Any) -> tuple[float | None, str | None]:
    if not isinstance(raw, dict):
        return None, None
    for field in PRICE_FIELDS:
        value = raw.get(field)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            number = float(value)
            if math.isfinite(number):
                return number, field
            continue
        if isinstance(value, str):
            try:
                number = float(value)
            except ValueError:
                continue
            if math.isfinite(number):
                return number, field
    return None, None


def analyze(session: Path, mint: str | None) -> dict[str, Any]:
    if not session.is_dir():
        raise AnalysisError(f"session directory not found: {session}")
    chunks = sorted(path for path in session.iterdir() if path.is_dir())
    rows: dict[str, list[dict[str, Any]]] = {name: [] for name in CHANNEL_FILES}
    for chunk in chunks:
        for channel, filename in CHANNEL_FILES.items():
            for row in read_jsonl(chunk / filename):
                row["_file"] = filename
                rows[channel].append(row)

    manifest_path = session / "manifest.json"
    manifest: dict[str, Any] = {}
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise AnalysisError(f"manifest.json: invalid JSON: {exc.msg}") from exc
    stats = manifest.get("stats", manifest.get("counters", {}))
    if not isinstance(stats, dict):
        stats = {}
    declared_status = manifest.get("status", "UNKNOWN")
    status = "INCOMPLETE" if declared_status in ("OPEN", "INCOMPLETE") else declared_status

    def matches(row: dict[str, Any]) -> bool:
        return mint is None or row.get("mint") == mint

    selected = {channel: [row for row in channel_rows if matches(row)]
                for channel, channel_rows in rows.items()}
    timeline: list[dict[str, Any]] = []
    for channel in ("token_activity", "token_stat", "wallet_activity_info"):
        for row in selected[channel]:
            price, field = raw_price(row.get("raw"))
            timeline.append({
                "receivedAt": row.get("receivedAt"), "receiveSequence": row.get("receiveSequence"),
                "itemIndex": row.get("itemIndex"), "channel": channel, "mint": row.get("mint"),
                "price": price, "priceField": field, "raw": json_safe(row.get("raw")),
            })
    for row in selected["decisions"]:
        timeline.append({
            "receivedAt": row.get("observedAt"), "receiveSequence": None, "itemIndex": None,
            "channel": "decision", "kind": row.get("kind"), "mint": row.get("mint"),
            "actionId": row.get("actionId"), "side": row.get("side"),
            "reason": row.get("reason"), "price": row.get("priceUsd"), "priceField": "priceUsd" if row.get("priceUsd") is not None else None,
        })
    timeline.sort(key=lambda row: (
        row["receivedAt"] if isinstance(row["receivedAt"], (int, float)) else float("inf"),
        row["receiveSequence"] if isinstance(row["receiveSequence"], int) else -1,
        row["itemIndex"] if isinstance(row["itemIndex"], int) else -1,
    ))
    token_stats = selected["token_stat"]
    with_price = sum(raw_price(row.get("raw"))[0] is not None for row in token_stats)
    price_coverage = "NONE" if not token_stats or with_price == 0 else ("ALL" if with_price == len(token_stats) else "PARTIAL")
    actual_rows = sum(len(value) for value in rows.values())
    return json_safe({
        "sessionId": manifest.get("sessionId", session.name), "mintFilter": mint,
        "quality": {
            "status": status, "declaredStatus": declared_status,
            "received": stats.get("received"), "written": stats.get("written"),
            "dropped": stats.get("dropped", 0), "writeUncertain": stats.get("writeUncertain", 0),
            "coverageGaps": stats.get("coverageGaps", 0), "archiveRowsRead": actual_rows,
            "manifestPresent": manifest_path.exists(),
            "price_coverage": price_coverage,
            "interpretation": "Observed provider/CDP archive only; not complete market tape or proof of executable price/fill.",
        },
        "counts": {channel: len(channel_rows) for channel, channel_rows in selected.items()},
        "timeline": timeline,
    })


def render_markdown(report: dict[str, Any]) -> str:
    q = report["quality"]
    lines = [f"# Follower tick analysis — {report['sessionId']}", "",
             f"- Mint filter: `{report['mintFilter'] or 'all'}`",
             f"- Capture quality: **{q['status']}** (declared `{q['declaredStatus']}`)",
             f"- Rows read: {q['archiveRowsRead']}; dropped: {q['dropped']}; uncertain writes: {q['writeUncertain']}; coverage gaps: {q['coverageGaps']}",
             f"- token_stat price coverage: **{q['price_coverage']}**", "",
             "> Observed provider/CDP archive only; not complete market tape or proof of executable price/fill.", "",
             "## Counts"]
    lines.extend(f"- {key}: {value}" for key, value in report["counts"].items())
    lines += ["", "## Timeline", "", "| Receive time (ms) | Channel | Kind/side | Price | Action ID |", "|---:|---|---|---:|---|"]
    for row in report["timeline"]:
        label = row.get("kind") or row.get("side") or ""
        lines.append(f"| {row.get('receivedAt', '')} | {row['channel']} | {label} | {row.get('price', '')} | {row.get('actionId', '')} |")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session_dir", type=Path)
    parser.add_argument("--mint", help="filter by exact mint address")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON (default: Markdown)")
    args = parser.parse_args()
    try:
        report = analyze(args.session_dir, args.mint)
    except AnalysisError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2, ensure_ascii=False) if args.json else render_markdown(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
