"""Общая заглушка frappe для CI-тестов без стенда.

Регистрирует в sys.modules минимальный frappe-модуль, достаточный
для импорта install.py и страницы оргчарта:

  * frappe.whitelist — декоратор-пустышка;
  * frappe.custom.doctype.custom_field.custom_field.create_custom_fields;
  * frappe.get_all / get_roles / session / db / log_error.

Вызов install_stub() должен происходить ДО загрузки тестируемых
модулей через importlib.
"""
import sys
import types


class _FakeDB:
    def __init__(self):
        self.storage = {}

    def get_value(self, doctype, filters, fieldname):
        return self.storage.get((doctype, str(filters), fieldname))

    def exists(self, doctype, name):
        return self.storage.get(("__exists__", doctype, name))

    def get_single_value(self, doctype, fieldname):
        return self.storage.get(("__single__", doctype, fieldname))

    def has_column(self, doctype, fieldname):
        return True


# Дерево подчинённости для теста рекурсии reports_to
ORG_TREE = {
    "CEO": ["CFO", "HS"],
    "CFO": ["ACC"],
    "HS": ["KAM"],
    "KAM": [],
    "ACC": [],
}


def install_stub():
    """Зарегистрировать заглушку frappe (идемпотентно)."""
    if "frappe" in sys.modules and getattr(sys.modules["frappe"], "__is_ci_stub__", False):
        return sys.modules["frappe"]

    frappe = types.ModuleType("frappe")
    frappe.__is_ci_stub__ = True
    frappe.__path__ = []

    frappe.session = types.SimpleNamespace(user="tester@example.com")
    frappe.db = _FakeDB()
    frappe.whitelist = lambda *dargs, **dkwargs: (lambda fn: fn)
    frappe.log_error = lambda msg, *a, **kw: None
    frappe.get_roles = lambda user: ["Employee"]

    def get_all(doctype, fields=None, filters=None, pluck=None, **kw):
        if doctype == "Employee" and isinstance(filters, dict) and "reports_to" in filters:
            names = ORG_TREE.get(filters["reports_to"], [])
            if pluck == "name":
                return list(names)
        return []

    frappe.get_all = get_all

    # frappe.custom.doctype.custom_field.custom_field.create_custom_fields
    custom = types.ModuleType("frappe.custom")
    custom.__path__ = []
    doctype = types.ModuleType("frappe.custom.doctype")
    doctype.__path__ = []
    custom_field_pkg = types.ModuleType("frappe.custom.doctype.custom_field")
    custom_field_pkg.__path__ = []
    custom_field_mod = types.ModuleType("frappe.custom.doctype.custom_field.custom_field")
    custom_field_mod.create_custom_fields = lambda *a, **kw: None
    custom_field_pkg.custom_field = custom_field_mod

    sys.modules["frappe"] = frappe
    sys.modules["frappe.custom"] = custom
    sys.modules["frappe.custom.doctype"] = doctype
    sys.modules["frappe.custom.doctype.custom_field"] = custom_field_pkg
    sys.modules["frappe.custom.doctype.custom_field.custom_field"] = custom_field_mod

    frappe.custom = custom
    return frappe
