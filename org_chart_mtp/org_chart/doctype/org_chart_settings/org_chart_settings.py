# Copyright (c) 2026, MTPplus and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class OrgChartSettings(Document):
	"""Настройки оргчарта (Single).

	- card_default  — что на плитке по умолчанию: «ЦКП» или «Функции»
	- panel_default — что в боковой панели по умолчанию: «ЦКП» или «Функции»
	- show_employees — показывать чипы сотрудников на плитках
	- hr_designations — должности с полным доступом (по строке)
	"""

	DOCTYPE_NAME = "Org Chart Settings"

	# begin: auto-generated types
	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		card_default: DF.Select
		hr_designations: DF.SmallText | None
		panel_default: DF.Select
		show_employees: DF.Check
	# end: auto-generated types

	def validate(self):
		if self.card_default not in ("ЦКП", "Функции"):
			frappe.throw("Содержимое плитки может быть только «ЦКП» или «Функции»")
		if self.panel_default not in ("ЦКП", "Функции"):
			frappe.throw("Содержимое панели может быть только «ЦКП» или «Функции»")
