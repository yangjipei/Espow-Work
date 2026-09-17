#!/usr/bin/env python3

import argparse
import sys
from pathlib import Path
from typing import Dict, List, Tuple

from _workspace import ROOT, atomic_write, cell, markdown_link, markdown_rows, read_flat_yaml, requirement_dirs


CLOSED_STATUSES = {"closed", "confirmed", "resolved", "done", "已关闭", "已确认", "已解决", "完成"}
QUESTION_FILES = (
    "02-open-issues.md",
    "changes/open-issues.md",
    "prd/requirement-supplement.md",
)
DECISION_FILES = ("01-decisions.md", "changes/decisions.md")


def first(row: Dict[str, str], names: Tuple[str, ...]) -> str:
    for name in names:
        if row.get(name):
            return row[name]
    return ""


def open_questions(requirement: Path) -> List[Dict[str, str]]:
    found = {}
    for relative_path in QUESTION_FILES:
        for row in markdown_rows(requirement / relative_path):
            question_id = first(row, ("ID", "问题编号"))
            question = first(row, ("问题",))
            status = first(row, ("状态",))
            if not question_id or not question or status.strip().lower() in CLOSED_STATUSES:
                continue
            found[question_id] = {
                "id": question_id,
                "question": question,
                "owner": first(row, ("责任人", "Owner")),
                "status": status or "待确认",
            }
    return [found[key] for key in sorted(found)]


def latest_decision(requirement: Path) -> str:
    candidates = []
    for relative_path in DECISION_FILES:
        for row in markdown_rows(requirement / relative_path):
            decision = first(row, ("决策",))
            if decision:
                candidates.append((first(row, ("日期",)), first(row, ("ID",)), decision))
    if not candidates:
        return "—"
    date, decision_id, decision = sorted(candidates)[-1]
    prefix = "{} ".format(decision_id) if decision_id else ""
    return "{}{}".format(prefix, decision)


def collect(root: Path):
    records = []
    all_questions = []
    for requirement in requirement_dirs(root):
        state_path = requirement / "state.yaml"
        if not state_path.is_file():
            continue
        try:
            state = read_flat_yaml(state_path)
        except (OSError, ValueError):
            continue
        questions = open_questions(requirement)
        current = str(state.get("current_artifact") or "overview.md")
        record = {
            "directory": requirement.name,
            "name": str(state.get("name") or requirement.name),
            "status": state.get("status"),
            "stage": state.get("lifecycle_stage"),
            "updated": state.get("updated_at"),
            "review": state.get("review_status"),
            "current": current,
            "question_count": len(questions),
            "latest_decision": latest_decision(requirement),
        }
        records.append(record)
        for question in questions:
            item = dict(question)
            item["requirement"] = record["name"]
            item["directory"] = requirement.name
            all_questions.append(item)
    records.sort(key=lambda item: (str(item["updated"] or ""), item["name"]), reverse=True)
    return records, all_questions


def render(root: Path) -> str:
    records, questions = collect(root)
    lines = [
        "# 工作台",
        "",
        "> 此文件由 `python3 scripts/build_dashboard.py` 从 Requirement Workspace 派生生成，请勿手工维护。",
        "",
        "## 我的需求",
        "",
        "| 需求 | 状态 | 阶段 | 待确认 | 评审 | 最近更新 | 当前产物 |",
        "| --- | --- | --- | ---: | --- | --- | --- |",
    ]
    for record in records:
        base = "../requirements/{}".format(record["directory"])
        lines.append(
            "| {} | {} | {} | {} | {} | {} | {} |".format(
                markdown_link(record["name"], base + "/state.yaml"),
                cell(record["status"]),
                cell(record["stage"]),
                record["question_count"],
                cell(record["review"]),
                cell(record["updated"]),
                markdown_link(record["current"], base + "/" + record["current"]),
            )
        )
    if not records:
        lines.append("| — | — | — | 0 | — | — | — |")
    lines.extend(["", "## 待我确认", "", "| 需求 | ID | 问题 | 责任人 | 状态 |", "| --- | --- | --- | --- | --- |"])
    for question in questions:
        lines.append(
            "| {} | {} | {} | {} | {} |".format(
                markdown_link(question["requirement"], "../requirements/{}/state.yaml".format(question["directory"])),
                cell(question["id"]),
                cell(question["question"]),
                cell(question["owner"]),
                cell(question["status"]),
            )
        )
    if not questions:
        lines.append("| — | — | 暂无 | — | — |")
    pending_review = []
    for record in records:
        stage = str(record["stage"] or "").lower()
        review_status = str(record["review"] or "").upper()
        if review_status in ("STALE", "PENDING", "NEEDS_REVIEW"):
            pending_review.append(record)
        elif stage == "review" and review_status not in ("FRESH", "PASS"):
            pending_review.append(record)
    lines.extend(["", "## 待评审", ""])
    if pending_review:
        for record in pending_review:
            lines.append("- {}：{}".format(record["name"], cell(record["review"])))
    else:
        lines.append("暂无。")
    acceptance_stages = {"acceptance", "validation", "release", "上线", "验收"}
    pending_acceptance = [record for record in records if str(record["stage"]).lower() in acceptance_stages]
    lines.extend(["", "## 待验收", ""])
    if pending_acceptance:
        for record in pending_acceptance:
            lines.append("- {}".format(record["name"]))
    else:
        lines.append("暂无。")
    lines.extend(["", "## 最近变更", "", "| 需求 | 最近决策 | 最近更新 |", "| --- | --- | --- |"])
    for record in records:
        lines.append("| {} | {} | {} |".format(cell(record["name"]), cell(record["latest_decision"]), cell(record["updated"])))
    if not records:
        lines.append("| — | 暂无 | — |")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="从 Requirement Workspace 生成中文工作台。")
    parser.add_argument("--root", type=Path, default=ROOT, help="工作空间根目录")
    parser.add_argument("--check", action="store_true", help="只检查 dashboard/index.md 是否最新")
    args = parser.parse_args()
    root = args.root.resolve()
    output = root / "dashboard" / "index.md"
    content = render(root)
    if args.check:
        if not output.is_file() or output.read_text(encoding="utf-8") != content:
            print("dashboard/index.md 需要重新生成。")
            return 1
        print("dashboard/index.md 已是最新。")
        return 0
    atomic_write(output, content)
    print("已生成：{}".format(output))
    return 0


if __name__ == "__main__":
    sys.exit(main())
