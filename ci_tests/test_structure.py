"""Структурные тесты приложения org_chart_mtp (без frappe).

Проверяют консистентность того, что разворачивается миграцией:
hooks, кастомные поля, patches.txt, файлы страницы/сайдбара/дока.
"""
import importlib.util
import os
import unittest

import frappe_stub  # noqa: F401  (заглушка frappe для CI без стенда)

APP = "org_chart_mtp"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
APP_DIR = os.path.join(ROOT, APP)


def _load_module(relpath, name):
    frappe_stub.install_stub()
    path = os.path.join(APP_DIR, relpath)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestHooks(unittest.TestCase):
    def setUp(self):
        self.hooks = _load_module("hooks.py", "org_chart_hooks")

    def test_required_apps_hrms(self):
        """hrms обязателен: используются Employee/Department/Goal/KRA."""
        self.assertIn("hrms", self.hooks.required_apps)

    def test_apps_screen_entry(self):
        """Карточка на домашнем экране Desk с валидным маршрутом."""
        self.assertTrue(self.hooks.add_to_apps_screen)
        entry = self.hooks.add_to_apps_screen[0]
        self.assertEqual(entry["name"], APP)
        self.assertEqual(entry["route"], "/desk/org_chart_mtp")
        self.assertTrue(entry["title"])
        self.assertTrue(entry["logo"].startswith("/assets/"))
        self.assertTrue(entry["has_permission"].startswith(f"{APP}."))

    def test_install_hooks_present(self):
        """after_install/after_migrate создают поля автоматически."""
        self.assertIn(f"{APP}.install.after_install", [self.hooks.after_install])
        self.assertIn(f"{APP}.install.after_migrate", [self.hooks.after_migrate])


class TestInstallCustomFields(unittest.TestCase):
    def setUp(self):
        self.install = _load_module("install.py", "org_chart_install")

    def test_department_fields_complete(self):
        """Все поля Department, на которых построен оргчарт, описаны."""
        fields = {f["fieldname"] for f in self.install.DEPARTMENT_CUSTOM_FIELDS["Department"]}
        expected = {
            "custom_org_section",
            "custom_color",
            "custom_functions",
            "custom_kra",
            "custom_wiki_url",
            "custom_folder_url",
        }
        self.assertTrue(expected <= fields, f"нет полей: {expected - fields}")
        # JSON-поле метрик удалено в v0.3 (метрики = Goal с custom_department)
        self.assertNotIn("custom_metrics", fields)

    def test_field_definitions_valid(self):
        """У каждого поля есть fieldname/fieldtype/label/insert_after."""
        allowed_types = {
            "Data", "Small Text", "Text", "Link", "JSON", "Section Break",
            "Column Break", "Check", "Int", "Currency", "Date",
        }
        for doctype, defs in self.install.ALL_CUSTOM_FIELDS.items():
            for f in defs:
                for key in ("fieldname", "label", "fieldtype", "insert_after"):
                    self.assertIn(key, f, f"{doctype}.{f.get('fieldname')} нет {key}")
                self.assertIn(f["fieldtype"], allowed_types, f"{doctype}.{f['fieldname']}")
                self.assertTrue(f["fieldname"].startswith("custom_"))

    def test_color_field_is_hex_data(self):
        """Цвет — Data-поле на Department (значение hex-строкой)."""
        color = next(
            f for f in self.install.DEPARTMENT_CUSTOM_FIELDS["Department"]
            if f["fieldname"] == "custom_color"
        )
        self.assertEqual(color["fieldtype"], "Data")

    def test_kra_is_link_to_kra(self):
        """ЦКП — Link на KRA (DocType из hrms)."""
        kra = next(
            f for f in self.install.DEPARTMENT_CUSTOM_FIELDS["Department"]
            if f["fieldname"] == "custom_kra"
        )
        self.assertEqual(kra["fieldtype"], "Link")
        self.assertEqual(kra["options"], "KRA")

    def test_goal_department_link(self):
        """Goal.custom_department — Link на Department."""
        goal = self.install.GOAL_CUSTOM_FIELDS["Goal"][0]
        self.assertEqual(goal["fieldname"], "custom_department")
        self.assertEqual(goal["fieldtype"], "Link")
        self.assertEqual(goal["options"], "Department")


class TestAppStructure(unittest.TestCase):
    def test_modules_txt(self):
        with open(os.path.join(APP_DIR, "modules.txt"), encoding="utf-8") as f:
            content = f.read()
        self.assertIn("Org Chart", content.split("\n"))

    def test_page_files_exist(self):
        page = os.path.join(APP_DIR, "org_chart", "page", APP)
        for fn in (f"{APP}.json", f"{APP}.py", f"{APP}.js", "__init__.py"):
            self.assertTrue(os.path.exists(os.path.join(page, fn)), f"нет {fn}")

    def test_settings_doctype_files_exist(self):
        dt = os.path.join(APP_DIR, "org_chart", "doctype", "org_chart_settings")
        for fn in ("org_chart_settings.json", "org_chart_settings.py", "__init__.py"):
            self.assertTrue(os.path.exists(os.path.join(dt, fn)), f"нет {fn}")

    def test_sidebar_and_dock_exist(self):
        sidebar = os.path.join(APP_DIR, "org_chart", "sidebar", "org-chart", "org-chart.json")
        dock = os.path.join(APP_DIR, "dock", APP, f"{APP}.json")
        self.assertTrue(os.path.exists(sidebar), "нет сайдбара модуля")
        self.assertTrue(os.path.exists(dock), "нет дока приложения")

    def test_patches_txt_format(self):
        """patches.txt в INI-формате v16 с [pre_model_sync]/[post_model_sync]."""
        with open(os.path.join(APP_DIR, "patches.txt"), encoding="utf-8") as f:
            content = f.read()
        self.assertIn("[pre_model_sync]", content)
        self.assertIn("[post_model_sync]", content)
        # ни одна строка-патч не должна быть пустой записью вида " |"
        for line in content.splitlines():
            if "|" in line:
                self.assertFalse(line.strip().startswith("|"), f"битая запись: {line}")

    def test_public_assets_exist(self):
        icons = os.path.join(APP_DIR, "public", "icons", "module-icons.svg")
        self.assertTrue(os.path.exists(icons), "нет SVG-спрайта иконок")


class TestPageJson(unittest.TestCase):
    def test_page_json_content(self):
        import json
        with open(
            os.path.join(APP_DIR, "org_chart", "page", APP, f"{APP}.json"), encoding="utf-8"
        ) as f:
            data = json.load(f)
        self.assertEqual(data.get("page_name"), APP)
        self.assertEqual(data.get("module"), "Org Chart")
        self.assertEqual(data.get("standard"), "Yes")
        self.assertEqual(data.get("script"), f"{APP}.js")
        # Страница доступна базовым ролям HR, а не кастомным
        roles = {r["role"] for r in data.get("roles", [])}
        self.assertTrue(roles, "страница должна быть видна хотя бы одной роли")
        self.assertNotIn("Org Chart User", roles)


if __name__ == "__main__":
    unittest.main()
