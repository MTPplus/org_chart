# org_chart_mtp — серверный экспорт оргчарта в векторный PDF.
#
# Клиент (org_chart_mtp.js) собирает HTML схемы — те же плитки, что юзер
# видит на экране, — и отправляет его сюда. Сервер рендерит одностраничный
# векторный PDF с выделяемым текстом:
#
#   1) headless-Chromium через CDP (штатный генератор frappe v16) — точный
#      рендер, тот же движок, что в браузере юзера;
#   2) wkhtmltopdf — откат, если Chromium не настроен;
#   3) если недоступно ничего — бросаем ошибку, клиент откатывается на
#      растровый PDF (canvas + JPEG) и показывает подсказку.
#
# Включение Chromium на сервере: `bench setup-chromium` (скачает и пропишет
# путь), либо ключ `chromium_path` в sites/common_site_config.json.

import re

import frappe
from frappe import _
from frappe.utils import cint, today

MAX_HTML_LENGTH = 8 * 1024 * 1024  # 8 МБ — защитный лимит полезной нагрузки

# Rate limit векторного PDF: метод запускает headless-Chromium (тяжёлый
# процесс ~1–2 с и сотни МБ памяти на рендер). Без лимита зажатая кнопка
# или злонамеренный клиент могли бы исчерпать память сервера.
# Учитываем ПОЛЬЗОВАТЕЛЕЙ (не IP): в офисе за NAT все с одним IP,
# и спам одного не должен блокировать остальных.
EXPORT_RATE_LIMIT = 8   # запросов
EXPORT_RATE_WINDOW = 60  # за скользящие 60 секунд

# 15 мм при 96 dpi — поля, которые PDF-движки frappe проставляют по умолчанию
# (prepare_header_footer / prepare_options_for_pdf)
PDF_MARGIN_PX = 57

# Экспортный HTML самодостаточен (стили и SVG-иконки инлайном, без внешних
# ссылок и скриптов). Всё, что выходит за эти рамки, — запрещаем:
# защищаемся от инъекций в headless-Chromium и от SSRF через внешние URL.
_FORBIDDEN_PATTERNS = re.compile(
    r"<\s*script|<\s*iframe|<\s*object|<\s*embed"
    r"|javascript\s*:"
    r"|\son\w+\s*="
    r"|(src|href)\s*=\s*[\"']\s*(https?:)?//"
    r"|url\s*\(\s*[\"']?\s*(https?:)?//",
    re.IGNORECASE,
)


@frappe.whitelist()
def export_chart_pdf(html="", width=0, height=0):
        """Векторный экспорт оргчарта: HTML (собран на клиенте) -> PDF.

        Ответ бинарный, поэтому клиент вызывает метод через fetch() с типом blob,
        а не frappe.call.
        """
        _enforce_export_rate_limit()

        if not html or len(html) > MAX_HTML_LENGTH:
                frappe.throw(_("Некорректные данные для экспорта"))

        if _FORBIDDEN_PATTERNS.search(html):
                frappe.throw(_("Схема содержит недопустимые элементы (скрипты или внешние ссылки)"))

        width = min(max(cint(width), 100), 32000)
        height = min(max(cint(height), 100), 32000)

        full_html = _wrap_html(html)

        pdf = _pdf_chrome(full_html, width, height)
        if not pdf:
                pdf = _pdf_wkhtmltopdf(full_html, width, height)
        if not pdf:
                frappe.throw(
                        _(
                                "Не удалось сформировать векторный PDF: на сервере не настроен генератор PDF. "
                                "Установите Chromium (bench setup-chromium) или wkhtmltopdf."
                        )
                )

        frappe.local.response.filename = "orgchart-{0}.pdf".format(today())
        frappe.local.response.filecontent = pdf
        frappe.local.response.type = "pdf"


def _enforce_export_rate_limit():
        """Лимит на пользователя: EXPORT_RATE_LIMIT рендеров за окно.

        Ключ включает frappe.session.user (RedisWrapper без user-префикса
        даёт общий на сайт ключ — см. frappe.utils.redis_wrapper.make_key).
        Скользящее окно: каждый запрос продлевает TTL ключа. Гонка
        get→set на один вызов допустима (защита от исчерпания ресурсов,
        а не бухгалтерия). Недоступность кэша не блокирует экспорт.
        """
        key = "org_chart_export_rl::{0}".format(frappe.session.user)
        try:
                count = frappe.cache().get_value(key) or 0
        except Exception:
                return
        count = int(count) + 1
        if count > EXPORT_RATE_LIMIT:
                frappe.throw(
                        _(
                                "Слишком много экспортов подряд (лимит {0} в минуту). "
                                "Подождите немного и повторите."
                        ).format(EXPORT_RATE_LIMIT),
                        frappe.RateLimitExceededError,
                )
        try:
                frappe.cache().set_value(key, count, expires_in_sec=EXPORT_RATE_WINDOW)
        except Exception:
                pass


def _wrap_html(body_html):
        """Оборачивает фрагмент схемы в полную HTML-страницу для серверного рендера."""
        return (
                '<!DOCTYPE html><html><head><meta charset="utf-8">'
                "<style>"
                "html,body{margin:0;padding:0;}"
                "body{font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',"
                "Arial,'Noto Sans','DejaVu Sans',sans-serif;}"
                "*{-webkit-print-color-adjust:exact;print-color-adjust:exact;}"
                "</style></head><body>" + body_html + "</body></html>"
        )


def _page_size_options(width, height):
        """Страница = контент + поля 15 мм с каждой стороны (+2px запас на округление).

        Размер передаём в px (96 dpi); printToPDF/pdfkit сами переведут в дюймы.
        """
        return {
                "page-width": "{0}px".format(width + 2 * PDF_MARGIN_PX + 2),
                "page-height": "{0}px".format(height + 2 * PDF_MARGIN_PX + 2),
        }


def _pdf_chrome(full_html, width, height):
        """Одностраничный векторный PDF через headless-Chromium (CDP)."""
        try:
                from frappe.utils.pdf import get_chrome_pdf
        except ImportError:
                return None

        try:
                return get_chrome_pdf(
                        None, full_html, _page_size_options(width, height), None, pdf_generator="chrome"
                )
        except Exception:
                frappe.log_error(
                        title="org_chart_mtp: Chromium PDF export failed",
                        message=frappe.get_traceback(),
                )
                return None


def _pdf_wkhtmltopdf(full_html, width, height):
        """Откат на wkhtmltopdf (если установлен)."""
        try:
                from frappe.utils.pdf import get_pdf, is_wkhtmltopdf_valid

                if not is_wkhtmltopdf_valid():
                        return None
        except Exception:
                return None

        options = _page_size_options(width, height)
        options.update(
                {
                        "margin-top": "15mm",
                        "margin-bottom": "15mm",
                        "margin-left": "15mm",
                        "margin-right": "15mm",
                }
        )
        try:
                return get_pdf(full_html, options)
        except Exception:
                frappe.log_error(
                        title="org_chart_mtp: wkhtmltopdf PDF export failed",
                        message=frappe.get_traceback(),
                )
                return None
