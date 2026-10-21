"""Проверка: каждый .js-файл приложения проходит node --check.

Требует установленный node (в CI ставится actions/setup-node).
"""
import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
APP_DIR = os.path.join(ROOT, "org_chart_mtp")


def iter_js_files():
    for dirpath, dirnames, filenames in os.walk(APP_DIR):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for fn in filenames:
            if fn.endswith(".js"):
                yield os.path.join(dirpath, fn)


def main() -> int:
    files = list(iter_js_files())
    if not files:
        print("FAIL: не найдено ни одного .js-файла — проверьте структуру")
        return 1
    broken = []
    for path in files:
        proc = subprocess.run(
            ["node", "--check", path],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            broken.append(f"{os.path.relpath(path, ROOT)}\n{proc.stderr.strip()}")
    if broken:
        print("FAIL: JS-файлы с синтаксическими ошибками:")
        for line in broken:
            print(f"  - {line}")
        return 1
    print(f"OK: {len(files)} JS-файлов синтаксически корректны")
    return 0


if __name__ == "__main__":
    sys.exit(main())
