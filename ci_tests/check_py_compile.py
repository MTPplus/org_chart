"""Проверка: каждый .py-файл приложения компилируется.

Запускается без frappe в окружении — ловит синтаксические ошибки
до развёртывания на сайт.
"""
import compileall
import os
import sys

APP_DIR = os.path.join(os.path.dirname(__file__), "..", "org_chart_mtp")


def main() -> int:
    ok = compileall.compile_dir(
        os.path.abspath(APP_DIR),
        quiet=1,
        force=True,
    )
    if not ok:
        print("FAIL: найдены файлы, не проходящие компиляцию")
        return 1
    print("OK: все .py-файлы компилируются")
    return 0


if __name__ == "__main__":
    sys.exit(main())
