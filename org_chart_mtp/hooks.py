app_name = "org_chart_mtp"
app_title = "Org Chart MTP"
app_publisher = "MTPplus"
app_description = "Оргструктура компании: интерактивный оргчарт для Frappe HR (Desk)"
app_email = "info@mtp.plus"
app_license = "mit"

# Apps
# ------------------
# hrms обязателен: используются DocType Employee, Department, Goal, KRA
required_apps = ["hrms"]

# Карточка приложения на домашнем экране Desk (apps screen).
# Внутри карточка ведёт на страницу оргчарта.
add_to_apps_screen = [
        {
                "name": "org_chart_mtp",
                "logo": "/assets/org_chart_mtp/images/org-chart-mtp-logo.svg",
                "title": "Оргструктура",
                "route": "/desk/org_chart_mtp",
                "has_permission": "org_chart_mtp.api.permission.has_app_permission",
        }
]

# Иконки приложения (SVG-спрайт с символами org-chart-soft / org-chart-duotone)
app_include_icons = ["/assets/org_chart_mtp/icons/module-icons.svg"]

# Installation
# ------------
# Кастомные поля (Department.custom_color и др.) создаются миграцией/установкой
after_install = "org_chart_mtp.install.after_install"
after_migrate = "org_chart_mtp.install.after_migrate"

# Doc Events
# ------------
# Инвалидация кэша get_org_data (Redis, per-scope) при изменении источников
# данных (Department / Employee / Goal / File / Settings).
doc_events = {
        "Department": {
                "on_update": "org_chart_mtp.api.events.invalidate_cache",
                "on_trash": "org_chart_mtp.api.events.invalidate_cache",
                "on_rename": "org_chart_mtp.api.events.invalidate_cache",
        },
        "Employee": {
                "on_update": "org_chart_mtp.api.events.invalidate_cache",
                "on_trash": "org_chart_mtp.api.events.invalidate_cache",
        },
        "Goal": {
                "on_update": "org_chart_mtp.api.events.invalidate_cache",
                "on_trash": "org_chart_mtp.api.events.invalidate_cache",
        },
        "File": {
                "on_update": "org_chart_mtp.api.events.invalidate_cache",
                "on_trash": "org_chart_mtp.api.events.invalidate_cache",
        },
        "Org Chart Settings": {
                "on_update": "org_chart_mtp.api.events.invalidate_cache",
        },
}

# Uninstallation
# ------------
# Чистим созданные нами Custom Field (данные полей будут потеряны)
before_uninstall = "org_chart_mtp.uninstall.before_uninstall"

# Translation
# ------------
# Страница на русском языке, переводов не требуется
