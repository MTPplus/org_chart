"""
Установка org_chart_mtp: кастомные поля создаются автоматически.

Поля Department (цвет/функции/ЦКП/wiki/папка) и Goal (отдел) создаются
через create_custom_fields при install и повторно проверяются при каждом
migrate — то есть добавление полей применяется миграцией автоматически,
без ручных действий.

Цели и «метрики» отделов — это обычные Goal из hrms, закреплённые за
отделом полем Goal.custom_department (см. патч v0.3: кастомное
JSON-поле метрик Department.custom_metrics удалено).
"""
import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

# Кастомные поля Department — единый источник правды для оргчарта
DEPARTMENT_CUSTOM_FIELDS = {
        "Department": [
                dict(
                        fieldname="custom_org_section",
                        label="Оргструктура (org_chart_mtp)",
                        fieldtype="Section Break",
                        insert_after="department_name",
                        collapsible=1,
                ),
                dict(
                        fieldname="custom_color",
                        label="Цвет (hex)",
                        fieldtype="Data",
                        insert_after="custom_org_section",
                        description="Цвет плитки отдела в оргчарте, формат #RRGGBB (например #2563eb). "
                        "Именно из этого поля оргчарт берёт цвет карточки.",
                ),
                dict(
                        fieldname="custom_functions",
                        label="Функции",
                        fieldtype="Small Text",
                        insert_after="custom_color",
                        description="Функции отдела — по одной на строку. Показываются на плитке "
                        "и в боковой панели оргчарта.",
                ),
                dict(
                        fieldname="custom_kra",
                        label="ЦКП (KRA)",
                        fieldtype="Link",
                        options="KRA",
                        insert_after="custom_functions",
                        description="Ценный конечный продукт отдела: ссылка на DocType KRA. "
                        "По умолчанию показывается на плитке оргчарта.",
                ),
                dict(
                        fieldname="custom_wiki_url",
                        label="Wiki (ссылка)",
                        fieldtype="Data",
                        insert_after="custom_kra",
                        description="Ссылка на wiki-страницу отдела.",
                ),
                dict(
                        fieldname="custom_folder_url",
                        label="Папка (ссылка)",
                        fieldtype="Data",
                        insert_after="custom_wiki_url",
                        description="Ссылка на внешнюю папку отдела (Google Drive и т.п.).",
                ),
        ]
}

# Кастомное поле Goal — связь цели с отделом (цели отделов в оргчарте)
GOAL_CUSTOM_FIELDS = {
        "Goal": [
                dict(
                        fieldname="custom_department",
                        label="Отдел",
                        fieldtype="Link",
                        options="Department",
                        insert_after="kra",
                        description="Отдел, к которому относится цель. Используется оргчартом "
                        "для раздела целей отдела (вместо отдельного поля метрик: "
                        "закрепите Goal за отделом здесь).",
                ),
        ]
}

ALL_CUSTOM_FIELDS = {**DEPARTMENT_CUSTOM_FIELDS, **GOAL_CUSTOM_FIELDS}


def after_install():
        """Хук after_install: создать поля и настройки по умолчанию."""
        _apply_custom_fields()
        _ensure_settings_defaults()
        frappe.db.commit()


def after_migrate():
        """Хук after_migrate: поля создаются повторно (идемпотентно).

        Гарантирует, что добавление полей применяется миграцией автоматически —
        в том числе при обновлении приложения на уже развёрнутых сайтах.
        """
        _apply_custom_fields()
        _ensure_settings_defaults()


def _apply_custom_fields():
        create_custom_fields(DEPARTMENT_CUSTOM_FIELDS, ignore_validate=True, update=True)
        create_custom_fields(GOAL_CUSTOM_FIELDS, ignore_validate=True, update=True)


def _ensure_settings_defaults():
        """Проставить дефолты Org Chart Settings, если они не заданы.

        Single-doctype существует сразу после установки DocType, поэтому
        проверяем не существование, а заполненность каждого поля — так
        дефолты проставляются и на уже развёрнутых сайтах (after_migrate),
        не трогая значения, заданные пользователем вручную.
        """
        if not frappe.db.exists("DocType", "Org Chart Settings"):
                return

        defaults = {
                "card_default": "ЦКП",
                "panel_default": "Функции",
                "show_employees": 1,
                "hr_designations": "HR Manager\nHR Business Partner\nHR-директор\nДиректор по персоналу",
        }
        for field, value in defaults.items():
                if not frappe.db.get_single_value("Org Chart Settings", field):
                        frappe.db.set_single_value("Org Chart Settings", field, value)
        frappe.db.commit()
