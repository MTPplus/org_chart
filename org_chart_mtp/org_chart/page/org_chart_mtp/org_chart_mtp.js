// =====================================================================
//  Org Chart Page — org_chart_mtp (Frappe HR, Desk)
//  URL: /desk/org_chart_mtp
//
//  Vanilla JS (без React/Vue), работает внутри Frappe Desk.
//  Данные: frappe.call → org_chart_mtp.py:get_org_data
//
//  Возможности:
//    - Рекурсивная иерархия любой глубины
//    - Зум к курсору (колесо мыши + кнопки), панорамирование
//    - Плитка отдела: ЦКП (по умолчанию) или Функции — переключается
//      в шапке и в Org Chart Settings; выбор запоминается
//    - Боковая панель: Функции (по умолчанию) или ЦКП — переключается
//    - Цвет плитки — из Department.custom_color (hex), иначе нейтральный
//    - Клик по отделу → панель (Папка / Wiki / Цели и метрики)
//    - Клик по сотруднику → панель сотрудника
//    - Сворачивание/разворачивание подотделов
//    - Права: HR/руководитель видят цели и метрики, рядовой — только свои
// =====================================================================

var APP_NAME = 'org_chart_mtp';
var METHOD_PATH = 'org_chart_mtp.org_chart.page.org_chart_mtp.org_chart_mtp.get_org_data';
var NEUTRAL_COLOR = '#475569';
var TILE_KEY = 'org_chart_mtp_tile_mode';
var PANEL_KEY = 'org_chart_mtp_panel_mode';

frappe.pages['org_chart_mtp'].on_page_load = function (wrapper) {
    var page = frappe.ui.make_app_page({
        parent: wrapper,
        title: __('Оргструктура компании'),
        single_column: true,
    });

    // === Глобальное состояние ===
    var state = {
        data: null,
        permissions: null,
        settings: { card_default: 'ЦКП', panel_default: 'Функции', show_employees: true },
        selection: null,
        activeTab: 'folder',
        tileMode: 'ЦКП',       // 'ЦКП' | 'Функции' — что на плитке
        panelMode: 'Функции',  // 'ЦКП' | 'Функции' — что в боковой панели
        collapsed: new Set(),
        scale: 1,
        tx: 0,
        ty: 0,
        isPanning: false,
        panStart: { x: 0, y: 0, tx: 0, ty: 0 },
        hasCentered: false,
    };

    // === HTML-каркас + CSS ===
    var $body = $(page.body).length ? $(page.body) : $(wrapper).find('.layout-main-section');
    $body.html(`
        <style>
            .org-root { display: flex; flex-direction: column; height: calc(100vh - 110px); background: #f3f4f6; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif; }
            .org-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 24px; background: white; border-bottom: 1px solid #e5e7eb; flex-shrink: 0; z-index: 20; flex-wrap: wrap; gap: 8px; }
            .org-header h1 { font-size: 15px; font-weight: 600; color: #111827; margin: 0; }
            .org-header .stats { font-size: 12px; color: #9ca3af; margin-left: 12px; }
            .org-header-controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
            .org-switcher { display: flex; align-items: center; gap: 4px; border: 1px solid #e5e7eb; border-radius: 6px; background: white; padding: 2px; }
            .org-switcher-label { font-size: 11px; color: #9ca3af; padding: 0 6px; white-space: nowrap; }
            .org-switch-btn { padding: 4px 10px; border: none; border-radius: 4px; background: none; cursor: pointer; font-size: 12px; color: #6b7280; }
            .org-switch-btn:hover { background: #f3f4f6; color: #111827; }
            .org-switch-btn.active { background: #2563eb; color: white; font-weight: 600; }
            .org-zoom-controls { display: flex; align-items: center; border: 1px solid #e5e7eb; border-radius: 6px; background: white; }
            .org-zoom-controls button { padding: 6px 10px; border: none; background: none; cursor: pointer; color: #4b5563; }
            .org-zoom-controls button:hover { background: #f3f4f6; }
            .org-zoom-controls .zoom-value { font-size: 12px; color: #6b7280; min-width: 45px; text-align: center; padding: 0 8px; }
            .org-canvas-wrapper { flex: 1; position: relative; overflow: hidden; cursor: grab; background: #f3f4f6; background-image: radial-gradient(circle, #d1d5db 1px, transparent 1px); background-size: 24px 24px; user-select: none; -webkit-user-select: none; -moz-user-select: none; }
            .org-canvas-wrapper.panning { cursor: grabbing; }
            .org-canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; will-change: transform; }
            .org-hint { position: absolute; top: 16px; left: 16px; background: rgba(255,255,255,0.95); backdrop-filter: blur(4px); border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); font-size: 12px; color: #6b7280; z-index: 10; }
            .org-node { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); border: 1px solid #e5e7eb; cursor: pointer; transition: box-shadow 0.15s, border-color 0.15s; width: 280px; }
            .org-node:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.12); border-color: #d1d5db; }
            .org-node.is-root { width: 360px; }
            .org-node.is-section { width: 220px; }
            .org-node-header { padding: 8px 12px 6px; border-bottom: 1px solid #f3f4f6; }
            .org-node-code { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 3px; margin-right: 6px; }
            .org-node-section { padding: 6px 12px; border-bottom: 1px solid #f3f4f6; }
            .org-node-section-label { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #9ca3af; margin-bottom: 2px; }
            .org-node-functions { list-style: none; padding: 0; margin: 0; }
            .org-node-functions li { font-size: 11px; color: #374151; padding-left: 10px; position: relative; margin-bottom: 1px; }
            .org-node-functions li::before { content: '•'; position: absolute; left: 0; color: #9ca3af; }
            .org-node-ckp-title { font-size: 12px; font-weight: 600; color: #111827; line-height: 1.35; }
            .org-node-ckp-desc { font-size: 10px; color: #6b7280; line-height: 1.4; margin-top: 2px; }
            .org-node-empty { font-size: 10px; color: #c0c4cc; font-style: italic; }
            .org-node-employees { padding: 6px 12px; display: flex; flex-wrap: wrap; gap: 3px; }
            .org-emp-chip { display: inline-flex; align-items: center; gap: 3px; padding: 2px 6px; font-size: 10px; border-radius: 3px; border: 1px solid #e5e7eb; background: #f9fafb; color: #374151; cursor: pointer; transition: all 0.1s; }
            .org-emp-chip:hover { border-color: #60a5fa; background: #eff6ff; color: #1d4ed8; }
            .org-emp-chip svg { width: 9px; height: 9px; }
            .org-tree-level { display: flex; flex-direction: column; align-items: flex-start; }
            .org-collapse-btn { margin-top: 8px; width: 20px; height: 20px; border-radius: 50%; background: white; border: 1px solid #d1d5db; display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 10; transition: all 0.15s; }
            .org-collapse-btn:hover { border-color: #60a5fa; background: #eff6ff; }
            .org-collapse-btn svg { width: 12px; height: 12px; color: #4b5563; }
            .org-collapsed-label { margin-top: 4px; font-size: 10px; color: #9ca3af; font-style: italic; }
            .org-side-panel { position: absolute; top: 0; right: 0; bottom: 0; width: 384px; background: white; border-left: 1px solid #e5e7eb; box-shadow: -4px 0 16px rgba(0,0,0,0.12); display: flex; flex-direction: column; z-index: 30; }
            .org-panel-header { padding: 16px; border-bottom: 1px solid #e5e7eb; display: flex; align-items: flex-start; justify-content: space-between; }
            .org-panel-header .icon { width: 40px; height: 40px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: white; flex-shrink: 0; }
            .org-panel-header .icon svg { width: 20px; height: 20px; }
            .org-panel-header .title-block { flex: 1; min-width: 0; margin-left: 12px; }
            .org-panel-header .type-label { font-size: 10px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
            .org-panel-header h2 { font-size: 14px; font-weight: 600; color: #111827; margin: 0; line-height: 1.3; word-break: break-word; }
            .org-panel-close { background: none; border: none; cursor: pointer; color: #9ca3af; padding: 4px; }
            .org-panel-close:hover { color: #111827; }
            .org-panel-close svg { width: 16px; height: 16px; }
            .org-panel-ckp { padding: 10px 16px; background: #f9fafb; border-bottom: 1px solid #f3f4f6; }
            .org-panel-ckp .label { font-size: 10px; font-weight: 600; text-transform: uppercase; color: #9ca3af; margin-bottom: 2px; }
            .org-panel-ckp .text { font-size: 12px; color: #374151; line-height: 1.5; }
            .org-panel-employees { padding: 8px 16px; border-bottom: 1px solid #f3f4f6; }
            .org-panel-employees .label { font-size: 10px; font-weight: 600; text-transform: uppercase; color: #9ca3af; margin-bottom: 4px; }
            .org-panel-employees .chips { display: flex; flex-wrap: wrap; gap: 4px; }
            .org-panel-employees .chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid #e5e7eb; background: white; cursor: pointer; color: #374151; }
            .org-panel-employees .chip:hover { border-color: #60a5fa; background: #eff6ff; color: #1d4ed8; }
            .org-panel-tabs { display: flex; border-bottom: 2px solid #e5e7eb; flex-shrink: 0; }
            .org-tab { flex: 1; padding: 10px; border: none; background: none; cursor: pointer; font-size: 12px; font-weight: 500; color: #6b7280; border-bottom: 2px solid transparent; margin-bottom: -2px; display: flex; align-items: center; justify-content: center; gap: 6px; }
            .org-tab:hover { color: #111827; background: #f9fafb; }
            .org-tab.active { color: #1d4ed8; border-bottom-color: #2563eb; background: rgba(239,246,255,0.5); }
            .org-tab svg { width: 14px; height: 14px; }
            .org-panel-content { flex: 1; overflow-y: auto; padding: 16px; }
            .org-file-item { display: flex; align-items: center; gap: 12px; padding: 8px; border: 1px solid #e5e7eb; border-radius: 6px; margin-bottom: 4px; text-decoration: none; color: inherit; }
            .org-file-item:hover { border-color: #93c5fd; background: #eff6ff; }
            .org-file-icon { width: 32px; height: 32px; border-radius: 6px; background: #f3f4f6; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
            .org-file-icon svg { width: 16px; height: 16px; }
            .org-file-name { font-size: 12px; font-weight: 500; color: #111827; }
            .org-file-meta { font-size: 10px; color: #9ca3af; }
            .org-wiki-link { display: block; padding: 12px; border: 1px solid #bfdbfe; background: #eff6ff; border-radius: 6px; text-decoration: none; }
            .org-wiki-link:hover { border-color: #60a5fa; }
            .org-goal-item { padding: 8px; border: 1px solid #e5e7eb; border-radius: 6px; background: #f9fafb; margin-bottom: 8px; }
            .org-goal-text { font-size: 12px; color: #111827; margin-bottom: 4px; }
            .org-goal-due { font-size: 10px; color: #6b7280; }
            .org-metric-item { padding: 8px; border: 1px solid #e5e7eb; border-radius: 6px; margin-bottom: 8px; }
            .org-metric-name { font-size: 12px; font-weight: 500; color: #111827; }
            .org-metric-value { font-size: 10px; color: #6b7280; }
            .org-progress-bar { height: 6px; background: #e5e7eb; border-radius: 3px; overflow: hidden; margin-top: 4px; }
            .org-progress-fill { height: 100%; background: #22c55e; border-radius: 3px; transition: width 0.3s; }
            .org-restricted { padding: 32px 16px; text-align: center; color: #9ca3af; font-size: 12px; }
            .org-restricted svg { width: 56px !important; height: 56px !important; margin: 0 auto 12px auto; display: block; }
            .org-wiki-link svg, .org-file-item svg { width: 16px !important; height: 16px !important; flex-shrink: 0; }
            .org-section-title { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
            .org-section-title svg { width: 14px; height: 14px; color: #6b7280; flex-shrink: 0; }
            .org-section-title span { font-size: 12px; font-weight: 600; color: #111827; text-transform: uppercase; }
            .org-goal-due svg { width: 11px; height: 11px; vertical-align: -1px; margin-right: 2px; }
            .org-panel-employees .chip svg { width: 12px; height: 12px; flex-shrink: 0; }
        </style>
        <div class="org-root">
            <div class="org-header">
                <div style="display:flex;align-items:center;">
                    <h1>Оргструктура</h1>
                    <span class="stats" id="org-stats"></span>
                </div>
                <div class="org-header-controls">
                    <div class="org-switcher" title="Что показывать на плитке отдела">
                        <span class="org-switcher-label">Плитка:</span>
                        <button class="org-switch-btn" data-tile-mode="ЦКП">ЦКП</button>
                        <button class="org-switch-btn" data-tile-mode="Функции">Функции</button>
                    </div>
                    <div class="org-switcher" title="Что показывать в боковой панели отдела">
                        <span class="org-switcher-label">Панель:</span>
                        <button class="org-switch-btn" data-panel-mode="ЦКП">ЦКП</button>
                        <button class="org-switch-btn" data-panel-mode="Функции">Функции</button>
                    </div>
                    <div class="org-zoom-controls">
                        <button id="zoom-out" title="Уменьшить">−</button>
                        <span class="zoom-value" id="zoom-value">100%</span>
                        <button id="zoom-in" title="Увеличить">+</button>
                        <button id="zoom-reset" title="Сбросить" style="border-left:1px solid #e5e7eb;">⤢</button>
                    </div>
                </div>
            </div>
            <div class="org-canvas-wrapper" id="org-canvas-wrapper">
                <div class="org-canvas" id="org-canvas"></div>
                <div class="org-hint" id="org-hint">Колесо мыши — зум к курсору · перетаскивание — пан · клик по карточке — детали</div>
                <div class="org-side-panel" id="org-side-panel" style="display:none;"></div>
            </div>
        </div>
    `);

    // === SVG иконки ===
    var ICONS = {
        folder: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
        book: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
        target: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
        trend: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
        user: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
        close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
        file: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
        link: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
        calendar: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
        chevronDown: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>',
        chevronRight: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>',
        lock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    };

    // === Переключатели содержимого (плитка / панель) ===
    function updateSwitcherUI() {
        $('[data-tile-mode]').each(function () {
            $(this).toggleClass('active', $(this).data('tile-mode') === state.tileMode);
        });
        $('[data-panel-mode]').each(function () {
            $(this).toggleClass('active', $(this).data('panel-mode') === state.panelMode);
        });
    }

    $('[data-tile-mode]').on('click', function () {
        state.tileMode = $(this).data('tile-mode');
        window.localStorage.setItem(TILE_KEY, state.tileMode);
        updateSwitcherUI();
        renderTree();
        if (state.selection && state.selection.kind === 'node') {
            var node = state.data.departments.find(function (d) { return d.name === state.selection.id; });
            if (node) renderNodePanel(node);
        }
    });

    $('[data-panel-mode]').on('click', function () {
        state.panelMode = $(this).data('panel-mode');
        window.localStorage.setItem(PANEL_KEY, state.panelMode);
        updateSwitcherUI();
        if (state.selection && state.selection.kind === 'node') {
            var node = state.data.departments.find(function (d) { return d.name === state.selection.id; });
            if (node) renderNodePanel(node);
        }
    });

    // === Загрузка данных ===

    frappe.call({
        method: METHOD_PATH,
        callback: function (r) {
            if (r.message) {
                state.data = r.message;
                state.permissions = r.message.permissions || {};
                state.settings = r.message.settings || state.settings;
                // Порядок приоритета: выбор пользователя (localStorage) → настройки → ЦКП/Функции
                var savedTile = window.localStorage.getItem(TILE_KEY);
                state.tileMode = savedTile || state.settings.card_default || 'ЦКП';
                var savedPanel = window.localStorage.getItem(PANEL_KEY);
                state.panelMode = savedPanel || state.settings.panel_default || 'Функции';
                updateSwitcherUI();
                $('#org-stats').text(
                    state.data.departments.length + ' узлов · ' +
                    state.data.employees.length + ' сотрудников'
                );
                renderTree();
                centerContent();
            } else {
                $('#org-canvas').html('<div style="text-align:center;padding:40px;color:#ef4444;">' +
                    '<p>Ошибка: данные не получены от сервера.</p>' +
                    '<p style="font-size:11px;color:#9ca3af;">Проверьте, что метод <code>' + METHOD_PATH + '</code> существует</p>' +
                    '</div>');
            }
        },
        error: function (err) {
            $('#org-canvas').html('<div style="text-align:center;padding:40px;color:#ef4444;">' +
                '<p>Ошибка загрузки данных: ' + (err && err.message ? err.message : 'неизвестная') + '</p>' +
                '<p style="font-size:11px;color:#9ca3af;">Приложение: <code>' + APP_NAME + '</code>, метод: <code>' + METHOD_PATH + '</code></p>' +
                '</div>');
        },
    });

    // === Утилиты для работы с данными ===
    function getChildren(parentId) {
        return state.data.departments.filter(function (d) {
            return d.parent_department === parentId;
        });
    }

    function getEmployees(deptName) {
        return state.data.employees.filter(function (e) {
            return e.department === deptName && e.status === 'Active';
        });
    }

    function getAttachments(doctype, name) {
        return state.data.attachments.filter(function (a) {
            return a.attached_to_doctype === doctype && a.attached_to_name === name;
        });
    }

    function getGoalsForEmployee(empName) {
        return (state.data.goals || []).filter(function (g) {
            return g.employee === empName;
        });
    }

    function getNodeType(depth) {
        if (depth === 0) return 'company';
        if (depth === 1) return 'department';
        if (depth === 2) return 'subdepartment';
        return 'section';
    }

    function getNodeColor(node) {
        // Цвет ТОЛЬКО из Department.custom_color; иначе нейтральный
        return (node && node.custom_color) ? node.custom_color : NEUTRAL_COLOR;
    }

    function parseFunctions(node) {
        if (!node.custom_functions) return [];
        return node.custom_functions.split('\n').filter(function (s) { return s.trim(); });
    }

    // === Блок содержимого плитки: ЦКП или Функции ===
    function renderTileContent(node) {
        var label = state.tileMode;
        var html = '';
        if (label === 'ЦКП') {
            if (node.kra_title) {
                html += '<div class="org-node-section"><div class="org-node-section-label">ЦКП</div>';
                html += '<div class="org-node-ckp-title">' + escapeHtml(node.kra_title) + '</div>';
                if (node.kra_description) {
                    var short = node.kra_description.length > 140
                        ? node.kra_description.slice(0, 140) + '…'
                        : node.kra_description;
                    html += '<div class="org-node-ckp-desc">' + escapeHtml(short) + '</div>';
                }
                html += '</div>';
            } else {
                // Нет ЦКП — показываем функции как fallback
                var fns = parseFunctions(node);
                if (fns.length > 0) {
                    html += '<div class="org-node-section"><div class="org-node-section-label">Функции</div><ul class="org-node-functions">';
                    fns.forEach(function (fn) { html += '<li>' + escapeHtml(fn) + '</li>'; });
                    html += '</ul></div>';
                } else {
                    html += '<div class="org-node-section"><div class="org-node-section-label">ЦКП</div><div class="org-node-empty">не задано</div></div>';
                }
            }
        } else {
            var fns2 = parseFunctions(node);
            if (fns2.length > 0) {
                html += '<div class="org-node-section"><div class="org-node-section-label">Функции</div><ul class="org-node-functions">';
                fns2.forEach(function (fn) { html += '<li>' + escapeHtml(fn) + '</li>'; });
                html += '</ul></div>';
            } else if (node.kra_title) {
                // Нет функций — показываем ЦКП как fallback
                html += '<div class="org-node-section"><div class="org-node-section-label">ЦКП</div><div class="org-node-ckp-title">' + escapeHtml(node.kra_title) + '</div></div>';
            } else {
                html += '<div class="org-node-section"><div class="org-node-section-label">Функции</div><div class="org-node-empty">не задано</div></div>';
            }
        }
        return html;
    }

    // === Рекурсивный рендер дерева ===
    function renderNode(node, depth) {
        if (!node) return '';
        var nodeType = getNodeType(depth);
        var color = getNodeColor(node);
        var children = getChildren(node.name);
        var empList = getEmployees(node.name);
        var isCollapsed = state.collapsed.has(node.name);
        var hasChildren = children.length > 0;

        // Дети: группы (is_group=1) — горизонтальный ряд, службы (is_group=0) — вертикальная цепочка
        var parentChildren = children.filter(function (child) {
            return child.is_group == 1 || child.is_group === true;
        });
        var leafChildren = children.filter(function (child) {
            return child.is_group == 0 || child.is_group === false;
        });

        var LINE = '#cbd5e1';

        var html = '<div class="org-tree-level" style="align-items:flex-start;">';
        html += '<div class="org-node ' + (nodeType === 'company' ? 'is-root' : nodeType === 'section' ? 'is-section' : '') + '" data-no-pan data-node-id="' + escapeHtml(node.name) + '" style="border-top: 3px solid ' + color + ';">';
        html += '<div class="org-node-header">';
        html += '<span class="org-node-code" style="background:' + color + '22;color:' + color + ';">' + escapeHtml(node.department_name || node.name) + '</span>';
        html += '</div>';

        // Содержимое плитки: ЦКП или Функции (переключается)
        html += renderTileContent(node);

        // Сотрудники (если включены в настройках)
        if (state.settings.show_employees && empList.length > 0) {
            html += '<div class="org-node-employees" data-no-pan>';
            empList.forEach(function (emp) {
                html += '<button class="org-emp-chip" data-no-pan data-emp-id="' + escapeHtml(emp.name) + '">' + ICONS.user + escapeHtml(emp.employee_name || emp.name) + '</button>';
            });
            html += '</div>';
        }
        html += '</div>';

        // Кнопка свернуть + дети
        if (hasChildren) {
            html += '<button class="org-collapse-btn" data-no-pan data-collapse-id="' + escapeHtml(node.name) + '">';
            html += isCollapsed ? ICONS.chevronRight : ICONS.chevronDown;
            html += '</button>';
            if (!isCollapsed) {
                html += '<div style="display:flex; flex-direction:column; align-items:flex-start;">';
                html += '<div style="width:1px; height:16px; background:' + LINE + '; margin-left:12px;"></div>';
                html += '<div style="display:flex; align-items:flex-start; flex-wrap:nowrap; gap:32px;">';

                // 1. Поток служб (is_group = 0) — вертикальная цепочка слева
                if (leafChildren.length > 0) {
                    html += '<div style="border-left:1px solid ' + LINE + '; padding-left:12px; display:flex; flex-direction:column; gap:8px;">';
                    leafChildren.forEach(function (child) {
                        html += '<div style="position:relative;">';
                        html += '<div style="position:absolute; left:-12px; top:18px; width:12px; height:1px; background:' + LINE + ';"></div>';
                        html += renderNode(child, depth + 1);
                        html += '</div>';
                    });
                    html += '</div>';
                }

                // 2. Поток департаментов (is_group = 1) — горизонтальный ряд справа
                if (parentChildren.length > 0) {
                    html += '<div style="display:flex; align-items:flex-start; flex-wrap:nowrap;">';
                    parentChildren.forEach(function (child, i) {
                        var connWidth = (i === 0 && leafChildren.length === 0) ? 12 : 24;
                        html += '<div style="display:flex; align-items:flex-start;">';
                        html += '<div style="width:' + connWidth + 'px; height:1px; background:' + LINE + '; margin-top:22px; flex-shrink:0;"></div>';
                        html += renderNode(child, depth + 1);
                        html += '</div>';
                    });
                    html += '</div>';
                }

                html += '</div>';
                html += '</div>';
            } else {
                html += '<div class="org-collapsed-label">Свернуто: ' + children.length + '</div>';
            }
        }
        html += '</div>';
        return html;
    }

    function renderTree() {
        if (!state.data || state.data.departments.length === 0) {
            $('#org-canvas').html('<div style="text-align:center;padding:40px;color:#9ca3af;">Нет данных. Создайте Department в ERPNext.</div>');
            return;
        }
        var roots = state.data.departments.filter(function (d) {
            return !d.parent_department;
        });
        var html = '';
        roots.forEach(function (root) {
            html += renderNode(root, 0);
        });
        $('#org-canvas').html(html);
        attachEventHandlers();
        applyTransform();
    }

    // === Обработчики ===
    function attachEventHandlers() {
        $('[data-node-id]').off('click').on('click', function (e) {
            e.stopPropagation();
            var nodeId = $(this).data('node-id');
            var node = state.data.departments.find(function (d) { return d.name === nodeId; });
            if (node) openNodePanel(node);
        });
        $('[data-emp-id]').off('click').on('click', function (e) {
            e.stopPropagation();
            var empId = $(this).data('emp-id');
            var emp = state.data.employees.find(function (em) { return em.name === empId; });
            if (emp) openEmployeePanel(emp);
        });
        $('[data-collapse-id]').off('click').on('click', function (e) {
            e.stopPropagation();
            var id = $(this).data('collapse-id');
            if (state.collapsed.has(id)) state.collapsed.delete(id);
            else state.collapsed.add(id);
            renderTree();
        });
    }

    // === Панель отдела ===
    function openNodePanel(node) {
        state.selection = { kind: 'node', id: node.name };
        state.activeTab = 'folder';
        renderNodePanel(node);
        $('#org-side-panel').show();
    }

    function renderNodePanel(node) {
        var depth = getDepth(node);
        var color = getNodeColor(node);
        var empList = getEmployees(node.name);
        var attachments = getAttachments('Department', node.name);
        var functions = parseFunctions(node);
        var ckp = node.kra_title || '';
        var ckpDesc = node.kra_description || '';
        var wikiUrl = node.custom_wiki_url || ('/app/Department/' + encodeURIComponent(node.name));
        // Метрики отделов видят: HR или руководитель (есть подчинённые)
        var canViewMetrics = (state.permissions && state.permissions.is_hr) || (state.permissions && state.permissions.is_manager);
        var metrics = [];
        if (canViewMetrics && node.custom_metrics) {
            try { metrics = JSON.parse(node.custom_metrics); } catch (e) { /* битый JSON — игнорируем */ }
        }

        var html = '';
        // Шапка
        html += '<div class="org-panel-header" style="background:linear-gradient(135deg,' + color + '08 0%,' + color + '15 100%);">';
        html += '<div style="display:flex;align-items:flex-start;flex:1;min-width:0;">';
        html += '<div class="icon" style="background:' + color + '">' + ICONS.folder + '</div>';
        html += '<div class="title-block"><div class="type-label">' + (getNodeType(depth) === 'company' ? 'Компания' : getNodeType(depth) === 'department' ? 'Отдел' : 'Секция') + '</div>';
        html += '<h2>' + escapeHtml(node.department_name || node.name) + '</h2></div></div>';
        html += '<button class="org-panel-close" id="panel-close">' + ICONS.close + '</button></div>';

        // Содержимое панели: ЦКП или Функции (переключается, по умолчанию Функции)
        if (state.panelMode === 'ЦКП') {
            html += '<div class="org-panel-ckp"><div class="label">ЦКП (KRA)</div><div class="text"><strong>' + (ckp ? escapeHtml(ckp) : '<span style="color:#9ca3af;font-weight:400;">не задано</span>') + '</strong>';
            if (ckpDesc) html += '<br>' + escapeHtml(ckpDesc);
            html += '</div></div>';
        } else {
            html += '<div class="org-panel-ckp"><div class="label">Функции</div><div class="text">';
            if (functions.length > 0) {
                html += '<ul class="org-node-functions">';
                functions.forEach(function (fn) { html += '<li>' + escapeHtml(fn) + '</li>'; });
                html += '</ul>';
            } else {
                html += '<span style="color:#9ca3af;">не задано</span>';
            }
            html += '</div></div>';
        }

        // Сотрудники
        if (empList.length > 0) {
            html += '<div class="org-panel-employees"><div class="label">Сотрудники (' + empList.length + ')</div><div class="chips">';
            empList.forEach(function (emp) {
                html += '<button class="chip" data-emp-id="' + escapeHtml(emp.name) + '">' + ICONS.user + escapeHtml(emp.employee_name || emp.name) + '</button>';
            });
            html += '</div></div>';
        }

        // Вкладки
        html += '<div class="org-panel-tabs">';
        html += '<button class="org-tab ' + (state.activeTab === 'folder' ? 'active' : '') + '" data-tab="folder">' + ICONS.folder + 'Папка</button>';
        html += '<button class="org-tab ' + (state.activeTab === 'wiki' ? 'active' : '') + '" data-tab="wiki">' + ICONS.book + 'Wiki</button>';
        if (canViewMetrics) {
            html += '<button class="org-tab ' + (state.activeTab === 'goals' ? 'active' : '') + '" data-tab="goals">' + ICONS.target + 'Цели и метрики</button>';
        }
        html += '</div>';

        // Содержимое
        html += '<div class="org-panel-content">';
        if (state.activeTab === 'folder') {
            html += renderFolderTab(attachments, node.custom_folder_url);
        } else if (state.activeTab === 'wiki') {
            html += renderWikiTab(wikiUrl);
        } else if (state.activeTab === 'goals') {
            html += renderGoalsMetricsTab(node, metrics);
        }
        html += '</div>';

        $('#org-side-panel').html(html);

        $('#panel-close').off('click').on('click', function () {
            $('#org-side-panel').hide(); state.selection = null;
        });
        $('.org-tab').off('click').on('click', function () {
            state.activeTab = $(this).data('tab');
            renderNodePanel(node);
        });
        $('[data-emp-id]').off('click').on('click', function (e) {
            e.stopPropagation();
            var empId = $(this).data('emp-id');
            var emp = state.data.employees.find(function (em) { return em.name === empId; });
            if (emp) openEmployeePanel(emp);
        });
    }

    function getDepth(node) {
        var depth = 0;
        var current = node;
        while (current && current.parent_department) {
            depth++;
            current = state.data.departments.find(function (d) {
                return d.name === current.parent_department;
            });
            if (depth > 20) break;
        }
        return depth;
    }

    function renderFolderTab(attachments, folderUrl) {
        var html = '';
        if (folderUrl) {
            html += '<a class="org-wiki-link" href="' + escapeHtml(folderUrl) + '" target="_blank" style="margin-bottom:12px;">' +
                '<div style="display:flex;align-items:center;gap:12px;">' +
                '<div style="width:32px;height:32px;border-radius:6px;background:#fef3c7;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#d97706;">' + ICONS.folder + '</div>' +
                '<div style="flex:1;min-width:0;"><div style="font-size:12px;font-weight:500;color:#92400e;">Папка отдела</div><div style="font-size:10px;color:#b45309;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(folderUrl) + '</div></div>' +
                ICONS.link + '</div></a>';
        }
        if (attachments.length === 0) {
            html += '<div class="org-restricted">' + ICONS.folder + '<p style="margin-top:8px;">Вложений нет</p></div>';
            return html;
        }
        html += '<p style="font-size:12px;color:#6b7280;margin-bottom:12px;">Файлов: ' + attachments.length + '</p>';
        attachments.forEach(function (att) {
            var sizeStr = att.file_size ? Math.round(att.file_size / 1024) + ' КБ' : '';
            html += '<a class="org-file-item" href="' + att.file_url + '" target="_blank">';
            html += '<div class="org-file-icon">' + ICONS.file + '</div>';
            html += '<div style="flex:1;min-width:0;"><div class="org-file-name">' + escapeHtml(att.file_name) + '</div><div class="org-file-meta">' + sizeStr + '</div></div>';
            html += ICONS.link + '</a>';
        });
        return html;
    }

    function renderWikiTab(wikiUrl) {
        return '<a class="org-wiki-link" href="' + wikiUrl + '" target="_blank">' +
            '<div style="display:flex;align-items:center;gap:12px;">' +
            '<div style="width:32px;height:32px;border-radius:6px;background:#dbeafe;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#2563eb;">' + ICONS.book + '</div>' +
            '<div style="flex:1;min-width:0;"><div style="font-size:12px;font-weight:500;color:#1e3a8a;">Wiki отдела</div><div style="font-size:10px;color:#1d4ed8;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(wikiUrl) + '</div></div>' +
            ICONS.link + '</div></a>';
    }

    function renderGoalsMetricsTab(node, metrics) {
        var canViewMetrics = (state.permissions && state.permissions.is_hr) || (state.permissions && state.permissions.is_manager);
        if (!canViewMetrics) {
            return '<div class="org-restricted">' + ICONS.target + '<p style="margin-top:8px;">Нет прав для просмотра целей и метрик</p></div>';
        }

        var deptGoals = (state.data.dept_goals && state.data.dept_goals[node.name]) || [];
        var html = '';

        html += '<div class="org-section-title">' + ICONS.target + '<span>Цели отдела (' + deptGoals.length + ')</span></div>';
        if (deptGoals.length === 0) {
            html += '<p style="font-size:11px;color:#9ca3af;font-style:italic;margin-bottom:16px;">Целей нет. Создайте Goal с «Отдел» = ' + escapeHtml(node.name) + '</p>';
        } else {
            deptGoals.forEach(function (g) {
                html += '<div class="org-goal-item">';
                html += '<div class="org-goal-text">' + escapeHtml(g.goal_name) + '</div>';
                if (g.end_date) html += '<div class="org-goal-due">' + ICONS.calendar + ' Срок: ' + g.end_date + '</div>';
                if (g.progress) {
                    html += '<div class="org-progress-bar" style="margin-top:6px;"><div class="org-progress-fill" style="width:' + g.progress + '%;"></div></div>';
                    html += '<div style="font-size:10px;color:#6b7280;margin-top:2px;">Прогресс: ' + g.progress + '%</div>';
                }
                html += '</div>';
            });
        }

        if (metrics && metrics.length > 0) {
            html += '<div class="org-section-title" style="margin-top:16px;">' + ICONS.trend + '<span>Метрики (' + metrics.length + ')</span></div>';
            metrics.forEach(function (m) {
                html += '<div class="org-metric-item">';
                html += '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">';
                html += '<span class="org-metric-name">' + escapeHtml(m.name || '') + '</span>';
                html += '<span class="org-metric-value">' + escapeHtml(m.current || '') + ' / ' + escapeHtml(m.target || '') + ' ' + escapeHtml(m.unit || '') + '</span>';
                html += '</div>';
                html += '<div class="org-progress-bar"><div class="org-progress-fill" style="width:' + (m.progress || 0) + '%;"></div></div>';
                html += '</div>';
            });
        }
        return html;
    }

    // === Панель сотрудника ===
    function openEmployeePanel(emp) {
        state.selection = { kind: 'employee', id: emp.name };
        state.activeTab = 'folder';
        renderEmployeePanel(emp);
        $('#org-side-panel').show();
    }

    function renderEmployeePanel(emp) {
        var attachments = getAttachments('Employee', emp.name);
        var goals = getGoalsForEmployee(emp.name);
        var isOwnProfile = state.permissions && state.permissions.current_employee === emp.name;
        var visibleIds = (state.permissions && state.permissions.visible_employee_ids) || [];
        var isVisible = visibleIds.indexOf(emp.name) >= 0;
        var canViewGoals = (state.permissions && state.permissions.is_hr) || isOwnProfile || isVisible;
        // Контакты (email, телефон) видны ВСЕМ — это публичная информация
        var canViewContacts = true;
        var initials = (emp.employee_name || emp.name || '?').split(' ').map(function (p) { return p[0]; }).join('').slice(0, 2);

        var html = '';
        html += '<div class="org-panel-header" style="background:linear-gradient(135deg,#eff6ff 0%,#f3e8ff 100%);">';
        html += '<div style="display:flex;align-items:center;">';
        html += '<div style="width:40px;height:40px;border-radius:50%;background:#2563eb;color:white;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:14px;flex-shrink:0;">' + initials + '</div>';
        html += '<div class="title-block"><div class="type-label">Сотрудник</div><h2><a href="/app/employee/' + encodeURIComponent(emp.name) + '" target="_blank" style="color:#2563eb;text-decoration:none;" onmouseover="this.style.textDecoration=\'underline\';" onmouseout="this.style.textDecoration=\'none\';">' + escapeHtml(emp.employee_name || emp.name) + '</a></h2><p style="font-size:12px;color:#6b7280;margin:2px 0 0;">' + escapeHtml(emp.designation || '') + '</p></div>';
        html += '</div><button class="org-panel-close" id="panel-close">' + ICONS.close + '</button></div>';

        if (canViewContacts && (emp.user_id || emp.cell_number)) {
            html += '<div style="padding:10px 16px;background:#f9fafb;border-bottom:1px solid #f3f4f6;font-size:12px;">';
            if (emp.user_id) html += '<div style="display:flex;margin-bottom:4px;"><span style="color:#9ca3af;min-width:60px;">Email:</span><span style="color:#111827;word-break:break-all;">' + escapeHtml(emp.user_id) + '</span></div>';
            if (emp.cell_number) html += '<div style="display:flex;margin-bottom:4px;"><span style="color:#9ca3af;min-width:60px;">Телефон:</span><span style="color:#111827;">' + escapeHtml(emp.cell_number) + '</span></div>';
            html += '<div style="display:flex;margin-bottom:4px;"><span style="color:#9ca3af;min-width:60px;">Отдел:</span><span style="color:#111827;">' + escapeHtml(emp.department || '—') + '</span></div>';
            html += '</div>';
        } else {
            html += '<div style="padding:10px 16px;background:#f9fafb;border-bottom:1px solid #f3f4f6;font-size:12px;">';
            html += '<div style="display:flex;margin-bottom:4px;"><span style="color:#9ca3af;min-width:60px;">Отдел:</span><span style="color:#111827;">' + escapeHtml(emp.department || '—') + '</span></div>';
            html += '</div>';
        }

        // Вкладки
        html += '<div class="org-panel-tabs">';
        html += '<button class="org-tab ' + (state.activeTab === 'folder' ? 'active' : '') + '" data-tab="folder">' + ICONS.folder + 'Папка</button>';
        html += '<button class="org-tab ' + (state.activeTab === 'wiki' ? 'active' : '') + '" data-tab="wiki">' + ICONS.book + 'Wiki</button>';
        if (canViewGoals || isOwnProfile) {
            html += '<button class="org-tab ' + (state.activeTab === 'goals' ? 'active' : '') + '" data-tab="goals">' + ICONS.target + 'Цели</button>';
        }
        html += '</div>';

        html += '<div class="org-panel-content">';
        if (state.activeTab === 'folder') {
            html += renderFolderTab(attachments, null);
        } else if (state.activeTab === 'wiki') {
            html += renderWikiTab('/app/Employee/' + encodeURIComponent(emp.name));
        } else if (state.activeTab === 'goals') {
            if (goals.length === 0) {
                html += '<div class="org-restricted"><p>Целей нет</p></div>';
            } else {
                html += '<div class="org-section-title">' + ICONS.target + '<span>Цели (' + goals.length + ')</span></div>';
                goals.forEach(function (g) {
                    html += '<div class="org-goal-item">';
                    html += '<div class="org-goal-text">' + escapeHtml(g.goal_name) + '</div>';
                    if (g.end_date) html += '<div class="org-goal-due">' + ICONS.calendar + ' Срок: ' + g.end_date + '</div>';
                    if (g.progress) {
                        html += '<div class="org-progress-bar" style="margin-top:6px;"><div class="org-progress-fill" style="width:' + g.progress + '%;"></div></div>';
                        html += '<div style="font-size:10px;color:#6b7280;margin-top:2px;">Прогресс: ' + g.progress + '%</div>';
                    }
                    html += '</div>';
                });
            }
        }
        html += '</div>';

        $('#org-side-panel').html(html);

        $('#panel-close').off('click').on('click', function () {
            $('#org-side-panel').hide(); state.selection = null;
        });
        $('.org-tab').off('click').on('click', function () {
            state.activeTab = $(this).data('tab');
            renderEmployeePanel(emp);
        });
    }

    // === Зум к курсору и панорамирование ===
    function applyTransform() {
        var canvas = document.getElementById('org-canvas');
        if (!canvas) return;
        canvas.style.transform = 'translate(' + state.tx + 'px, ' + state.ty + 'px) scale(' + state.scale + ')';
        $('#zoom-value').text(Math.round(state.scale * 100) + '%');
    }

    function zoomAtPoint(mx, my, delta) {
        var oldScale = state.scale;
        var newScale = Math.min(2.5, Math.max(0.3, oldScale + delta));
        if (newScale === oldScale) return;
        var ratio = newScale / oldScale;
        state.tx = mx - (mx - state.tx) * ratio;
        state.ty = my - (my - state.ty) * ratio;
        state.scale = newScale;
        applyTransform();
    }

    function centerContent() {
        state.tx = 40;
        state.ty = 40;
        state.hasCentered = true;
        applyTransform();
    }

    $('#zoom-in').off('click').on('click', function () {
        var rect = document.getElementById('org-canvas-wrapper').getBoundingClientRect();
        zoomAtPoint(rect.width / 2, rect.height / 2, 0.15);
    });
    $('#zoom-out').off('click').on('click', function () {
        var rect = document.getElementById('org-canvas-wrapper').getBoundingClientRect();
        zoomAtPoint(rect.width / 2, rect.height / 2, -0.15);
    });
    $('#zoom-reset').off('click').on('click', function () {
        state.scale = 1;
        state.hasCentered = false;
        centerContent();
    });

    var canvasWrapper = document.getElementById('org-canvas-wrapper');
    canvasWrapper.addEventListener('wheel', function (e) {
        e.preventDefault();
        var rect = canvasWrapper.getBoundingClientRect();
        var mx = e.clientX - rect.left;
        var my = e.clientY - rect.top;
        var delta = e.deltaY > 0 ? -0.1 : 0.1;
        zoomAtPoint(mx, my, delta);
    }, { passive: false });

    canvasWrapper.addEventListener('mousedown', function (e) {
        if (e.target.closest('[data-no-pan]')) return;
        e.preventDefault();
        state.isPanning = true;
        state.panStart = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty };
        canvasWrapper.classList.add('panning');
    });
    document.addEventListener('mousemove', function (e) {
        if (!state.isPanning) return;
        var dx = e.clientX - state.panStart.x;
        var dy = e.clientY - state.panStart.y;
        state.tx = state.panStart.tx + dx;
        state.ty = state.panStart.ty + dy;
        applyTransform();
    });
    document.addEventListener('mouseup', function () {
        state.isPanning = false;
        canvasWrapper.classList.remove('panning');
    });

    // === Утилиты ===
    function escapeHtml(text) {
        if (!text) return '';
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
