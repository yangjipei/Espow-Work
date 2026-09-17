#!/usr/bin/env python3

import argparse
import re
import secrets
import shutil
import sys
from datetime import datetime
from pathlib import Path

from _workspace import ROOT, atomic_write, dump_flat_yaml


STATE_KEYS = (
    "requirement_id",
    "name",
    "status",
    "lifecycle_stage",
    "current_artifact",
    "latest_prototype_version",
    "prototype_status",
    "review_status",
    "review_reason",
    "updated_at",
)


def validate_name(name: str) -> str:
    name = name.strip()
    if not name or name in (".", "..") or name.startswith("_"):
        raise ValueError("需求名称不能为空、不能以 '_' 开头")
    if "/" in name or "\\" in name or "\x00" in name:
        raise ValueError("需求名称不能包含路径分隔符")
    return name


def update_overview(path: Path, name: str, today: str) -> None:
    content = path.read_text(encoding="utf-8")
    replacements = {
        r"(?m)^\| 需求名称 \|.*\|$": "| 需求名称 | {} |".format(name),
        r"(?m)^\| 当前状态 \|.*\|$": "| 当前状态 | 接入中 |",
        r"(?m)^\| 需求提出日期 \|.*\|$": "| 需求提出日期 | {} |".format(today),
        r"(?m)^\| 最近更新时间 \|.*\|$": "| 最近更新时间 | {} |".format(today),
    }
    for pattern, replacement in replacements.items():
        content = re.sub(pattern, replacement, content)
    atomic_write(path, content)


def main() -> int:
    parser = argparse.ArgumentParser(description="从唯一模板创建 Requirement Workspace。")
    parser.add_argument("name", help="需求名称，也是需求目录名称")
    parser.add_argument("--root", type=Path, default=ROOT, help="工作空间根目录")
    parser.add_argument("--dry-run", action="store_true", help="只显示目标，不创建文件")
    args = parser.parse_args()
    try:
        name = validate_name(args.name)
    except ValueError as exc:
        parser.error(str(exc))
    root = args.root.resolve()
    template = root / "requirements" / "_template"
    target = root / "requirements" / name
    if not template.is_dir():
        parser.error("模板不存在：{}".format(template))
    if target.exists():
        parser.error("目标已存在：{}".format(target))
    if args.dry_run:
        print("将创建：{}".format(target))
        return 0
    shutil.copytree(str(template), str(target))
    template_readme = target / "README.md"
    if template_readme.exists():
        template_readme.unlink()
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    requirement_id = now.strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2)
    state = {
        "requirement_id": requirement_id,
        "name": name,
        "status": "ACTIVE",
        "lifecycle_stage": "intake",
        "current_artifact": "overview.md",
        "latest_prototype_version": None,
        "prototype_status": None,
        "review_status": None,
        "review_reason": None,
        "updated_at": today,
    }
    atomic_write(target / "state.yaml", dump_flat_yaml(state, STATE_KEYS))
    update_overview(target / "overview.md", name, today)
    print("已创建：{}".format(target))
    print("Requirement ID：{}".format(requirement_id))
    return 0


if __name__ == "__main__":
    sys.exit(main())
