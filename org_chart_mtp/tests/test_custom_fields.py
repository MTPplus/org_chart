"""Тесты: кастомные поля создаются установкой/миграцией автоматически."""
import frappe
from frappe.tests.utils import FrappeTestCase

from org_chart_mtp.install import (
        DEPARTMENT_CUSTOM_FIELDS,
        GOAL_CUSTOM_FIELDS,
        _apply_custom_fields,
)


class TestCustomFields(FrappeTestCase):
        def test_department_custom_fields_exist(self):
                """Все поля Department, на которых построен оргчарт, существуют."""
                for field in DEPARTMENT_CUSTOM_FIELDS["Department"]:
                        name = field["fieldname"]
                        self.assertTrue(
                                frappe.get_meta("Department").has_field(name),
                                f"Department.{name} отсутствует — запустите bench migrate",
                        )

        def test_goal_custom_department_exists(self):
                """Goal.custom_department нужен для целей отделов."""
                self.assertTrue(frappe.get_meta("Goal").has_field("custom_department"))

        def test_apply_custom_fields_idempotent(self):
                """Повторное применение create_custom_fields не падает (after_migrate)."""
                _apply_custom_fields()
                _apply_custom_fields()
                self.assertTrue(frappe.get_meta("Department").has_field("custom_color"))

        def test_department_color_roundtrip(self):
                """Цвет читается из Department.custom_color (hex-строкой)."""
                dept = frappe.new_doc("Department")
                dept.company = _test_company()
                dept.department_name = "OCMTP Color Test"
                dept.custom_color = "#2563eb"
                dept.insert(ignore_permissions=True)
                self.addCleanup(frappe.delete_doc, "Department", dept.name, force=True, ignore_permissions=True)

                value = frappe.db.get_value("Department", dept.name, "custom_color")
                self.assertEqual(value, "#2563eb")

        def test_kra_link_on_department(self):
                """custom_kra — ссылка на KRA (hrms), ЦКП отдела."""
                kra = frappe.get_doc(
                        {"doctype": "KRA", "title": "OCMTP KRA Test", "description": "Тестовый ЦКП"}
                ).insert(ignore_permissions=True)
                self.addCleanup(frappe.delete_doc, "KRA", kra.name, force=True, ignore_permissions=True)

                dept = frappe.new_doc("Department")
                dept.company = _test_company()
                dept.department_name = "OCMTP KRA Test"
                dept.custom_kra = kra.name
                dept.insert(ignore_permissions=True)
                self.addCleanup(frappe.delete_doc, "Department", dept.name, force=True, ignore_permissions=True)

                self.assertEqual(
                        frappe.db.get_value("Department", dept.name, "custom_kra"), kra.name
                )


def _test_company():
        company = frappe.get_all("Company", pluck="name", limit=1)
        if company:
                return company[0]
        doc = frappe.get_doc(
                {
                        "doctype": "Company",
                        "company_name": "OCMTP Test Co",
                        "abbr": "OTC",
                        "default_currency": "RUB",
                        "country": "Russia",
                }
        ).insert(ignore_permissions=True)
        return doc.name
