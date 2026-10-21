"""Тесты правил видимости — без frappe (CI-режим).

Модуль страницы импортируется с заглушкой frappe (frappe_stub),
после чего проверяются чистые функции скоупов:

  * _get_subordinates — рекурсия по reports_to;
  * _metrics_allowed_depts/_strip_metrics — «ЦКП всем, метрики по праву»;
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

    def _perms(self, is_hr=False, is_manager=False, ids=None):
        return {
            "is_hr": is_hr,
            "is_manager": is_manager,
            "current_employee": "CEO" if (is_hr or is_manager) else "KAM",
            "current_designation": None,
            "visible_employee_ids": ids or [],
        }

    def _depts(self):
        return [
            {"name": "Sales", "custom_metrics": '[{"name":"rev"}]'},
            {"name": "Support", "custom_metrics": '[{"name":"csat"}]'},
        ]

    def test_metrics_hr_sees_all(self):
        """HR: метрики всех отделов остаются в ответе."""
        allowed = self.page._metrics_allowed_depts(
            self._perms(is_hr=True), self._depts(), ["Sales", "Support"]
        )
        self.assertEqual(allowed, {"Sales", "Support"})

    def test_metrics_manager_sees_branch_only(self):
        """Руководитель: метрики только отделов своей ветки."""
        allowed = self.page._metrics_allowed_depts(
            self._perms(is_manager=True, ids=["CEO", "HS"]), self._depts(), ["Sales"]
        )
        self.assertEqual(allowed, {"Sales"})

    def test_metrics_employee_sees_none(self):
        """Рядовой: метрик нет вовсе (ЦКП при этом ему доступен)."""
        allowed = self.page._metrics_allowed_depts(
            self._perms(is_hr=False, is_manager=False), self._depts(), []
        )
        self.assertEqual(allowed, set())

    def test_strip_metrics_employee(self):
        """Вырезание: у сотрудника метрики удаляются из ответа сервера."""
        depts = self._depts()
        self.page._strip_metrics(depts, set())
        self.assertNotIn("custom_metrics", depts[0])
        self.assertNotIn("custom_metrics", depts[1])
        # остальные поля не трогаем
        self.assertEqual(depts[0]["name"], "Sales")

    def test_strip_metrics_keeps_allowed(self):
        """Вырезание: разрешённые отделы метрики сохраняют."""
        depts = self._depts()
        self.page._strip_metrics(depts, {"Sales"})
        self.assertEqual(depts[0]["custom_metrics"], '[{"name":"rev"}]')
        self.assertNotIn("custom_metrics", depts[1])


if __name__ == "__main__":
    unittest.main()
