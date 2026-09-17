#!/usr/bin/env python3

import argparse
import hashlib
import re
import sys
from pathlib import Path
from typing import Dict, List, Tuple

from _workspace import ROOT, markdown_rows, read_flat_yaml, requirement_dirs


REQUIRED_TEMPLATE_PATHS = (
    "README.md",
    "overview.md",
    "source",
    "analysis",
    "solution",
    "flows",
    "prototype",
    "prd",
    "review",
    "changes",
)
REQUIRED_STATE_KEYS = (
    "requirement_id",
    "name",
    "status",
    "lifecycle_stage",
    "current_artifact",
    "updated_at",
)
LEGACY_PATHS = ("需求", "工作台", ".agent")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def yaml_mapping_section(path: Path, section: str) -> Dict[str, str]:
    values = {}
    active = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if line == section + ":":
            active = True
            continue
        if active and line and not line.startswith(" "):
            break
        if active:
            match = re.fullmatch(r"  ([A-Za-z][A-Za-z0-9_-]*):\s*(.+)", line)
            if match:
                values[match.group(1)] = match.group(2).strip().strip('"\'')
    return values


def validate_artifact_index(requirement: Path, errors: List[str]) -> None:
    index_path = requirement / "03-artifact-index.md"
    if not index_path.is_file():
        return
    for row in markdown_rows(index_path):
        artifact = row.get("Artifact")
        if artifact and not (requirement / artifact).exists():
            errors.append("{}: Artifact Index 指向不存在的文件 {}".format(requirement.name, artifact))


def validate_grounding(requirement: Path, errors: List[str], warnings: List[str]) -> None:
    grounding = requirement / "prd" / "prd-grounding.yaml"
    if not grounding.is_file():
        return
    paths = yaml_mapping_section(grounding, "source_paths")
    hashes = yaml_mapping_section(grounding, "source_hashes")
    for key, relative_path in paths.items():
        source = requirement / relative_path
        if not source.is_file():
            errors.append("{}: grounding 源文件不存在 {}".format(requirement.name, relative_path))
            continue
        expected = hashes.get(key)
        if expected and sha256(source) != expected:
            warnings.append("{}: grounding 源文件已变化 {}".format(requirement.name, relative_path))


def validate_requirement(requirement: Path, errors: List[str], warnings: List[str]) -> None:
    state_path = requirement / "state.yaml"
    if not state_path.is_file():
        errors.append("{}: 缺少 state.yaml".format(requirement.name))
        return
    try:
        state = read_flat_yaml(state_path)
    except (OSError, ValueError) as exc:
        errors.append(str(exc))
        return
    for key in REQUIRED_STATE_KEYS:
        if state.get(key) in (None, ""):
            errors.append("{}: state.yaml 缺少 {}".format(requirement.name, key))
    if state.get("name") and state["name"] != requirement.name:
        warnings.append("{}: state.name 与目录名不一致".format(requirement.name))
    current_artifact = state.get("current_artifact")
    if current_artifact and not (requirement / str(current_artifact)).is_file():
        errors.append("{}: current_artifact 不存在 {}".format(requirement.name, current_artifact))
    if state.get("review_status") == "FRESH":
        review = requirement / "review" / "requirement-review.md"
        prd = requirement / "prd" / "requirement.md"
        if review.is_file() and prd.is_file() and prd.stat().st_mtime > review.stat().st_mtime:
            warnings.append("{}: PRD 晚于需求评审，review_status 可能应为 STALE".format(requirement.name))
    validate_artifact_index(requirement, errors)
    validate_grounding(requirement, errors, warnings)
    for ds_store in requirement.rglob(".DS_Store"):
        warnings.append("{}: 存在被 Git 忽略的 {}".format(requirement.name, ds_store.relative_to(requirement)))


def run(root: Path) -> Tuple[List[str], List[str]]:
    errors: List[str] = []
    warnings: List[str] = []
    for legacy in LEGACY_PATHS:
        if (root / legacy).exists():
            errors.append("根目录仍存在旧路径 {}".format(legacy))
    template = root / "requirements" / "_template"
    for relative_path in REQUIRED_TEMPLATE_PATHS:
        if not (template / relative_path).exists():
            errors.append("模板缺少 {}".format(relative_path))
    if (root / ".agents" / "templates").exists():
        errors.append(".agents/templates 仍存在，模板来源不唯一")
    for requirement in requirement_dirs(root):
        validate_requirement(requirement, errors, warnings)
    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="检查产品经理工作空间的路径、状态、索引和引用完整性。")
    parser.add_argument("--root", type=Path, default=ROOT, help="工作空间根目录")
    args = parser.parse_args()
    errors, warnings = run(args.root.resolve())
    for message in errors:
        print("ERROR: " + message)
    for message in warnings:
        print("WARN: " + message)
    print("检查完成：{} 个错误，{} 个警告。".format(len(errors), len(warnings)))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
