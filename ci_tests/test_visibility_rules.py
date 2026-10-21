"""Тесты правил видимости — без frappe (CI-режим).

Модуль страницы импортируется с заглушкой frappe (frappe_stub),
после чего проверяются чистые функции скоупов:

  * _get_subordinates — рекурсия по reports_to;
  * константы ролей полного доступа.

Полные интеграционные тесты скоупов (emp/dir/hr на живом сайте) —
в org_chart_mtp/tests/test_scopes.py, запускаются через bench.
"""
import importlib.util
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import frappe_stub

APP = "org_chart_mtp"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PAGE_PY = os.path.join(ROOT, APP, "org_chart", "page", APP, f"{APP}.py")


def _load_page_module():
    frappe_stub.install_stub()
    spec = importlib.util.spec_from_file_location(f"{APP}_page", PAGE_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestVisibilityRules(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.page = _load_page_module()

    def test_full_access_roles(self):
        """Полный доступ — только нативные роли HR Manager/System Manager."""
        self.assertEqual(
            self.page.FULL_ACCESS_ROLES,
            {"HR Manager", "System Manager"},
        )

    def test_neutral_color_is_hex(self):
        """Нейтральный цвет — hex-строка для плиток без custom_color."""
        self.assertRegex(self.page.NEUTRAL_COLOR, r"^#[0-9a-fA-F]{6}$")

    def test_subordinates_recursion(self):
        """Рекурсия reports_to: CEO видит всю компанию до 4 уровней."""
        result = self.page._get_subordinates("CEO")
        self.assertEqual(result, {"CFO", "HS", "ACC", "KAM"})

    def test_subordinates_branch(self):
        """Ветка CFO — только её подчинённые, без чужих."""
        self.assertEqual(self.page._get_subordinates("CFO"), {"ACC"})

    def test_subordinates_leaf(self):
        """Рядовой сотрудник — без подчинённых."""
        self.assertEqual(self.page._get_subordinates("KAM"), set())

    def test_dept_goals_fetch_isolated(self):
        """Цели отделов читаются из Goal.custom_department (без JSON-поля метрик).

        Функция больше не обращается к Department.custom_metrics —
        источник целей отдела — только Goal из hrms.
        """
        # пустой список отделов -> пустой словарь, без обращений к БД
        self.assertEqual(self.page._get_dept_goals([]), {})

    def _perms(self, is_hr=False, is_manager=False, ids=None):
        return {
            "is_hr": is_hr,
            "is_manager": is_manager,
            "current_employee": "CEO" if (is_hr or is_manager) else "KAM",
            "current_designation": None,
            "visible_employee_ids": ids or [],
        }


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


class TestMetricsFieldRemoved(unittest.TestCase):
    """v0.3: JSON-поле метрик удалено — метрики отдела = Goal.custom_department."""

    ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "org_chart_mtp"))

    def test_page_has_no_metrics_json(self):
        """Бэкенд страницы не упоминает custom_metrics."""
        src = _read(os.path.join(self.ROOT, "org_chart", "page", "org_chart_mtp", "org_chart_mtp.py"))
        self.assertNotIn("custom_metrics", src)

    def test_events_has_no_metrics_validator(self):
        """Хук валидации JSON-метрик удалён."""
        src = _read(os.path.join(self.ROOT, "api", "events.py"))
        self.assertNotIn("validate_department", src)
        hooks_src = _read(os.path.join(self.ROOT, "hooks.py"))
        self.assertNotIn("validate_department", hooks_src)

    def test_patch_registered(self):
        """Патч v0.3 зарегистрирован в patches.txt."""
        src = _read(os.path.join(self.ROOT, "patches.txt"))
        self.assertIn("org_chart_mtp.patches.v0_3_remove_metrics", src)
        self.assertTrue(os.path.exists(os.path.join(self.ROOT, "patches", "v0_3_remove_metrics.py")))


if __name__ == "__main__":
    unittest.main()
