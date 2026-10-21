"""Тесты: настройки оргчарта (Org Chart Settings).

По требованиям заказчика:
  - плитка по умолчанию — ЦКП
  - боковая панель по умолчанию — Функции
  - пользователи могут переключать (персистентно на фронте, localStorage)
"""
import frappe
from frappe.tests.utils import FrappeTestCase

from org_chart_mtp.install import _ensure_settings_defaults
from org_chart_mtp.org_chart.page.org_chart_mtp.org_chart_mtp import _get_settings


class TestOrgChartSettings(FrappeTestCase):
	def test_settings_exist_with_defaults(self):
		"""Single-документ создан установкой, дефолты соответствуют ТЗ."""
		_ensure_settings_defaults()
		self.assertTrue(frappe.db.exists("Org Chart Settings", "Org Chart Settings"))

		card = frappe.db.get_single_value("Org Chart Settings", "card_default")
		panel = frappe.db.get_single_value("Org Chart Settings", "panel_default")
		self.assertEqual(card, "ЦКП")
		self.assertEqual(panel, "Функции")

	def test_get_settings_shape(self):
		"""API get_org_data отдаёт настройки фронту в ожидаемом виде."""
		_ensure_settings_defaults()
		settings = _get_settings()
		self.assertIn(settings["card_default"], ("ЦКП", "Функции"))
		self.assertIn(settings["panel_default"], ("ЦКП", "Функции"))
		self.assertIsInstance(settings["show_employees"], bool)

	def test_invalid_default_rejected(self):
		"""Контроллер не даёт сохранить произвольное значение."""
		doc = frappe.get_doc("Org Chart Settings")
		doc.card_default = "Случайный текст"
		with self.assertRaises(frappe.ValidationError):
			doc.validate()

	def test_hr_designations_parsing(self):
		"""Список HR-должностей читается по строкам."""
		doc = frappe.get_doc("Org Chart Settings")
		doc.hr_designations = "HR Manager\nHR Business Partner\n\nДиректор по персоналу\n"
		doc.save(ignore_permissions=True)

		from org_chart_mtp.org_chart.page.org_chart_mtp.org_chart_mtp import _hr_designations_set

		self.assertEqual(
			_hr_designations_set(),
			{"HR Manager", "HR Business Partner", "Директор по персоналу"},
		)
