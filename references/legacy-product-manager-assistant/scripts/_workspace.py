from __future__ import print_function

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Dict, Iterable, List, Optional
from urllib.parse import quote


ROOT = Path(__file__).resolve().parents[1]
REQUIREMENTS_DIR = ROOT / "requirements"
TEMPLATE_DIR = REQUIREMENTS_DIR / "_template"
DASHBOARD_DIR = ROOT / "dashboard"


def parse_scalar(value: str):
    value = value.strip()
    if value in ("", "null", "~"):
        return None
    if value.lower() == "true":
        return True
    if value.lower() == "false":
        return False
    if value.startswith('"') and value.endswith('"'):
        return json.loads(value)
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    return value


def read_flat_yaml(path: Path) -> Dict[str, object]:
    data = {}
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        if raw_line[0].isspace() or ":" not in raw_line:
            raise ValueError("{}:{} 不是扁平 key: value 格式".format(path, line_number))
        key, value = raw_line.split(":", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", key):
            raise ValueError("{}:{} 包含非法键 {}".format(path, line_number, key))
        if key in data:
            raise ValueError("{}:{} 包含重复键 {}".format(path, line_number, key))
        data[key] = parse_scalar(value)
    return data


def dump_flat_yaml(data: Dict[str, object], key_order: Iterable[str]) -> str:
    lines = []
    for key in key_order:
        value = data.get(key)
        if value is None:
            rendered = "null"
        elif isinstance(value, bool):
            rendered = "true" if value else "false"
        elif isinstance(value, int):
            rendered = str(value)
        else:
            rendered = json.dumps(str(value), ensure_ascii=False)
        lines.append("{}: {}".format(key, rendered))
    return "\n".join(lines) + "\n"


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix="." + path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.replace(temporary_name, str(path))
    except Exception:
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise


def requirement_dirs(root: Path = ROOT) -> List[Path]:
    base = root / "requirements"
    if not base.is_dir():
        return []
    return sorted(
        (path for path in base.iterdir() if path.is_dir() and not path.name.startswith("_")),
        key=lambda path: path.name,
    )


def markdown_rows(path: Path) -> List[Dict[str, str]]:
    if not path.is_file():
        return []
    headers: Optional[List[str]] = None
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not (stripped.startswith("|") and stripped.endswith("|")):
            headers = None
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if all(re.fullmatch(r":?-{3,}:?", cell or "-") for cell in cells):
            continue
        if headers is None:
            headers = cells
            continue
        if len(cells) == len(headers):
            rows.append(dict(zip(headers, cells)))
    return rows


def markdown_link(label: str, relative_path: str) -> str:
    return "[{}]({})".format(label.replace("|", "\\|"), quote(relative_path, safe="/._-"))


def cell(value: object) -> str:
    if value is None or value == "":
        return "—"
    return str(value).replace("|", "\\|").replace("\n", " ")
