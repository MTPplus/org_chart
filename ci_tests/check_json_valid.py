"""Проверка: каждый .json-файл репозитория — валидный JSON.

DocType-файлы, сайдбар, док и настройки — всё должно парситься.
"""
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def iter_json_files():
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in (".git", "__pycache__", "node_modules")]
        for fn in filenames:
            if fn.endswith(".json"):
                yield os.path.join(dirpath, fn)


def main() -> int:
    files = list(iter_json_files())
    broken = []
    for path in files:
        try:
            with open(path, encoding="utf-8") as f:
                json.load(f)
        except Exception as e:  # noqa: BLE001
            broken.append(f"{os.path.relpath(path, ROOT)}: {e}")
    if broken:
        print("FAIL: невалидные JSON-файлы:")
        for line in broken:
            print(f"  - {line}")
        return 1
    print(f"OK: {len(files)} JSON-файлов валидны")
    return 0


if __name__ == "__main__":
    sys.exit(main())
