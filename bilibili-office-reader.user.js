// ==UserScript==
// @name              Bilibili Office Reader
// @name:zh-CN        Bilibili 办公室阅读器
// @namespace         https://github.com/Hedwynnn/bilibili-office-reader
// @version           1.0.0
// @description       Turn Bilibili dynamics into a low-distraction text feed with filters, groups, and comments.
// @description:zh-CN 将 B 站动态转换为低干扰的纯文字阅读界面，支持筛选、分组、评论阅读和空闲刷新。
// @author            Hedwynnn
// @license           MIT
// @homepageURL       https://github.com/Hedwynnn/bilibili-office-reader
// @supportURL        https://github.com/Hedwynnn/bilibili-office-reader/issues
// @match             https://t.bilibili.com/*
// @grant             GM_getValue
// @grant             GM_setValue
// @grant             GM_registerMenuCommand
// @grant             GM_notification
// @grant             GM_xmlhttpRequest
// @connect           api.bilibili.com
// @run-at            document-idle
// ==/UserScript==

(() => {
  'use strict';

  const KEY = 'bilibili-office-reader-enabled';
  const GROUPS_KEY = 'bilibili-office-reader-groups';
  const AUTHOR_GROUPS_KEY = 'bilibili-office-reader-author-groups';
  const FILTER_KEY = 'bilibili-office-reader-content-filter';
  const GROUP_FILTER_KEY = 'bilibili-office-reader-group-filter';
  const AUTO_REFRESH_KEY = 'bilibili-office-reader-auto-refresh';
  const REFRESH_MINUTES_KEY = 'bilibili-office-reader-refresh-minutes';
  const ALERT_GROUPS_KEY = 'bilibili-office-reader-alert-groups';
  const ID = 'bor-reader';
  let enabled = GM_getValue(KEY, true);
  let filter = GM_getValue(FILTER_KEY, 'all');
  let groupFilter = GM_getValue(GROUP_FILTER_KEY, 'all');
  let timer = 0;
  let loadingMore = false;
  let refreshing = false;
  let autoRefresh = GM_getValue(AUTO_REFRESH_KEY, false);
  let refreshMinutes = Number(GM_getValue(REFRESH_MINUTES_KEY, 5));
  let lastActivityAt = Date.now();
  let lastCheckedAt = 0;
  let activeCommentKey = '';
  const commentStateByKey = new Map();
  const commentAreaByKey = new Map();
  let titleResetTimer = 0;
  const originalTitle = document.title;
  let hiddenStats = { live: 0, charging: 0, empty: 0 };
  const sourceByKey = new Map();
  const stableSourceKeys = new WeakMap();
  const PREFS_KEY = 'bilibili-office-reader-display';
  let preferences = { fontSize: 15, lineHeight: 1.8, notifications: false, preview: false,
    ...readStoredObject(PREFS_KEY, {}) };
  if (![14, 15, 16, 18].includes(preferences.fontSize)) preferences.fontSize = 15;
  if (![1.65, 1.8, 2].includes(preferences.lineHeight)) preferences.lineHeight = 1.8;
  preferences.notifications = preferences.notifications === true;
  preferences.preview = preferences.preview === true;
  if (filter === 'text') filter = 'text-only';
  if (!['all', 'no-video', 'text-only'].includes(filter)) filter = 'all';
  if (![1, 3, 5, 10, 30].includes(refreshMinutes)) refreshMinutes = 5;

  function readStoredObject(key, fallback) {
    const value = GM_getValue(key, fallback);
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch (_) { return fallback; }
    }
    return value ?? fallback;
  }

  let groups = readStoredObject(GROUPS_KEY, []);
  let authorGroups = readStoredObject(AUTHOR_GROUPS_KEY, {});
  let alertGroups = readStoredObject(ALERT_GROUPS_KEY, []);
  if (!Array.isArray(groups)) groups = [];
  if (!Array.isArray(alertGroups)) alertGroups = [];
  if (!authorGroups || Array.isArray(authorGroups) || typeof authorGroups !== 'object') {
    authorGroups = {};
  }

  const esc = value => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  const clean = value => String(value ?? '')
    .replace(/\u200b/g, '').replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();

  const fingerprint = value => clean(value)
    .toLocaleLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?·•｜|]/g, '');

  function normalizeGroupNames(values) {
    return [...new Set(values.map(clean).filter(Boolean))];
  }

  function saveGroupData() {
    groups = normalizeGroupNames(groups);
    alertGroups = normalizeGroupNames(alertGroups).filter(name => groups.includes(name));
    GM_setValue(GROUPS_KEY, groups);
    GM_setValue(AUTHOR_GROUPS_KEY, authorGroups);
    GM_setValue(ALERT_GROUPS_KEY, alertGroups);
  }

  function backupData() {
    return { app: 'Bilibili Office Reader', schema: 1, groups, authorGroups, alertGroups,
      filter, groupFilter, autoRefresh, refreshMinutes, preferences };
  }

  function validateBackup(value) {
    if (value?.app !== 'Bilibili Office Reader' || value.schema !== 1) throw new Error('不是受支持的阅读器备份');
    if (!Array.isArray(value.groups) || value.groups.some(name => typeof name !== 'string' || !name.trim() || name !== clean(name))) throw new Error('分组格式不正确');
    if (!value.authorGroups || typeof value.authorGroups !== 'object' || Array.isArray(value.authorGroups)) throw new Error('UP 主分组格式不正确');
    for (const [key, names] of Object.entries(value.authorGroups)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || !Array.isArray(names) || names.some(name => !value.groups.includes(name))) throw new Error('UP 主分组包含无效数据');
    }
    if (!Array.isArray(value.alertGroups) || value.alertGroups.some(name => !value.groups.includes(name))) throw new Error('提醒分组格式不正确');
    if (!['all', 'no-video', 'text-only'].includes(value.filter) || !['all', 'ungrouped', ...value.groups].includes(value.groupFilter)
      || typeof value.autoRefresh !== 'boolean' || ![1, 3, 5, 10, 30].includes(value.refreshMinutes)) throw new Error('筛选或刷新设置格式不正确');
    const p = value.preferences;
    if (!p || ![14, 15, 16, 18].includes(p.fontSize) || ![1.65, 1.8, 2].includes(p.lineHeight)
      || typeof p.notifications !== 'boolean' || typeof p.preview !== 'boolean') throw new Error('显示设置格式不正确');
    return value;
  }

  function applyBackup(value, merge = false, remember = true) {
    validateBackup(value);
    if (remember) GM_setValue('bilibili-office-reader-before-import', JSON.stringify(backupData()));
    if (merge) {
      groups = normalizeGroupNames([...groups, ...value.groups]);
      for (const [key, names] of Object.entries(value.authorGroups)) authorGroups[key] = normalizeGroupNames([...(authorGroups[key] || []), ...names]);
      alertGroups = normalizeGroupNames([...alertGroups, ...value.alertGroups]);
    } else {
      groups = [...value.groups]; authorGroups = { ...value.authorGroups }; alertGroups = [...value.alertGroups];
      filter = value.filter; groupFilter = value.groupFilter; autoRefresh = value.autoRefresh;
      refreshMinutes = value.refreshMinutes; preferences = { ...value.preferences };
      for (const [key, setting] of [[FILTER_KEY, filter], [GROUP_FILTER_KEY, groupFilter], [AUTO_REFRESH_KEY, autoRefresh], [REFRESH_MINUTES_KEY, refreshMinutes], [PREFS_KEY, preferences]]) GM_setValue(key, setting);
    }
    saveGroupData();
    document.getElementById(ID)?.remove();
    activeCommentKey = '';
    render();
    applyPreferences();
  }

  function applyPreferences() {
    const reader = document.getElementById(ID);
    reader?.style.setProperty('--bor-font-size', `${preferences.fontSize}px`);
    reader?.style.setProperty('--bor-line-height', String(preferences.lineHeight));
  }

  function openSettings() {
    const modal = openModal('阅读设置', `<label class="bor-field">字号<select id="bor-font">${[14,15,16,18].map(n => `<option ${preferences.fontSize === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="bor-field">行距<select id="bor-line">${[1.65,1.8,2].map(n => `<option ${preferences.lineHeight === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <p><label><input type="checkbox" id="bor-notifications" ${preferences.notifications ? 'checked' : ''}> 系统通知（关闭时仍有页内提醒）</label></p>
      <p><label><input type="checkbox" id="bor-preview" ${preferences.preview ? 'checked' : ''}> 系统通知包含动态正文</label></p>
      <button id="bor-export">导出全部设置</button> <button id="bor-import">导入备份</button>
      <button id="bor-restore">撤销上次导入</button><footer><button id="bor-save-settings">保存</button></footer>`);
    modal.querySelector('#bor-save-settings').onclick = () => {
      preferences = { fontSize: Number(modal.querySelector('#bor-font').value), lineHeight: Number(modal.querySelector('#bor-line').value),
        notifications: modal.querySelector('#bor-notifications').checked, preview: modal.querySelector('#bor-preview').checked };
      GM_setValue(PREFS_KEY, preferences); applyPreferences(); modal.remove();
    };
    modal.querySelector('#bor-export').onclick = () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(backupData(), null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'bilibili-office-reader-settings.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    modal.querySelector('#bor-restore').onclick = () => {
      try {
        const prior = GM_getValue('bilibili-office-reader-before-import', '');
        if (!prior) return showToast('没有可撤销的导入');
        applyBackup(JSON.parse(prior), false, false);
        GM_setValue('bilibili-office-reader-before-import', '');
        showToast('已恢复导入前的设置');
      } catch (error) { showToast(error.message); }
    };
    modal.querySelector('#bor-import').onclick = () => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json';
      input.onchange = async () => {
        try {
          const file = input.files[0]; if (!file) return;
          if (file.size > 2 * 1024 * 1024) throw new Error('备份超过 2 MB，请检查文件');
          const value = validateBackup(JSON.parse(await file.text()));
          const preview = openModal('确认导入', `<p>备份包含 ${value.groups.length} 个分组、${Object.keys(value.authorGroups).length} 个 UP 主。导入前会自动保存当前配置。</p><p>合并仅合并分组和提醒；替换会恢复全部设置。</p><footer><button id="bor-merge">合并分组</button><button id="bor-replace">替换全部</button><button class="bor-modal-cancel">取消</button></footer>`);
          preview.querySelector('#bor-merge').onclick = () => { applyBackup(value, true); showToast('分组已合并'); };
          preview.querySelector('#bor-replace').onclick = () => { applyBackup(value); showToast('设置已恢复'); };
        } catch (error) { showToast(`导入失败：${error.message}`); }
      };
      input.click();
    };
  }

  function authorStorageKey(author, authorId = '') {
    return authorId ? `uid:${authorId}` : `name:${author}`;
  }

  function groupsFor(author, authorId = '') {
    const key = authorStorageKey(author, authorId);
    const value = authorGroups[key] ?? authorGroups[`name:${author}`] ?? authorGroups[author];
    return Array.isArray(value) ? value.filter(name => groups.includes(name)) : [];
  }

  function openModal(title, bodyHtml) {
    document.querySelector('.bor-modal-backdrop')?.remove();
    const returnFocus = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.className = 'bor-modal-backdrop';
    const remove = backdrop.remove.bind(backdrop);
    backdrop.remove = () => { remove(); if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); };
    backdrop.innerHTML = `<section class="bor-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header><h2>${esc(title)}</h2><button class="bor-modal-close" aria-label="关闭">×</button></header>
      <div class="bor-modal-body">${bodyHtml}</div>
    </section>`;
    document.getElementById(ID)?.appendChild(backdrop);
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop || event.target.closest('.bor-modal-close, .bor-modal-cancel')) {
        backdrop.remove();
      }
    });
    backdrop.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const controls = [...backdrop.querySelectorAll('button, input, select, a[href], textarea')].filter(element => !element.disabled && !element.hidden);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    backdrop.querySelector('input, button')?.focus();
    return backdrop;
  }

  function editAuthorGroups(author, authorId = '') {
    const current = new Set(groupsFor(author, authorId));
    const choices = groups.length
      ? groups.map(name => `<label class="bor-check"><input type="checkbox" value="${esc(name)}" ${current.has(name) ? 'checked' : ''}><span>${esc(name)}</span></label>`).join('')
      : '<p class="bor-help">还没有分组，可以在下面直接新建。</p>';
    const modal = openModal(`设置分组：${author}`, `
      <div class="bor-check-list">${choices}</div>
      <label class="bor-field"><span>新建分组（多个用逗号分隔）</span><input id="bor-new-groups" type="text" placeholder="例如：财经, 黄金"></label>
      <footer><button class="bor-modal-cancel">取消</button><button class="bor-primary" id="bor-save-author-groups">保存</button></footer>`);
    modal.querySelector('#bor-save-author-groups').addEventListener('click', () => {
      const checked = [...modal.querySelectorAll('.bor-check input:checked')].map(input => input.value);
      const created = normalizeGroupNames(modal.querySelector('#bor-new-groups').value.split(/[,，\n]/));
      const selected = normalizeGroupNames([...checked, ...created]);
      groups = normalizeGroupNames([...groups, ...created]);
      const key = authorStorageKey(author, authorId);
      if (selected.length) authorGroups[key] = selected;
      else delete authorGroups[key];
      if (authorId) delete authorGroups[`name:${author}`];
      delete authorGroups[author];
      saveGroupData();
      modal.remove();
      render();
    });
  }

  function manageGroups() {
    const alerted = new Set(alertGroups);
    const rows = groups.length
      ? groups.map(name => `<div class="bor-group-row" data-old-name="${esc(name)}"><input type="text" value="${esc(name)}"><label class="bor-group-alert" title="该分组刷新出新动态时提醒"><input type="checkbox" ${alerted.has(name) ? 'checked' : ''}><span>提醒</span></label><button class="bor-delete-group" title="删除分组">删除</button></div>`).join('')
      : '<p class="bor-help">目前还没有分组。</p>';
    const modal = openModal('管理分组', `
      <p class="bor-help">勾选“提醒”后，该分组刷新出新动态时会显示页面提示并发送系统通知。可以直接重命名；删除分组不会取消关注UP主。</p>
      <div id="bor-group-rows">${rows}</div>
      <label class="bor-field"><span>新建分组</span><input id="bor-create-groups" type="text" placeholder="多个名称可用逗号分隔"></label>
      <footer><button class="bor-modal-cancel">取消</button><button class="bor-primary" id="bor-save-groups">保存修改</button></footer>`);
    modal.addEventListener('click', event => {
      const deleteButton = event.target.closest('.bor-delete-group');
      if (deleteButton) {
        const row = deleteButton.closest('.bor-group-row');
        row.dataset.deleted = row.dataset.deleted === 'true' ? 'false' : 'true';
        row.style.opacity = row.dataset.deleted === 'true' ? '0.55' : '1';
        deleteButton.textContent = row.dataset.deleted === 'true' ? '撤销删除' : '删除';
      }
    });
    modal.querySelector('#bor-save-groups').addEventListener('click', () => {
      const renameMap = new Map();
      const nextAlertGroups = [];
      for (const row of modal.querySelectorAll('.bor-group-row')) {
        if (row.dataset.deleted === 'true') continue;
        const oldName = row.dataset.oldName;
        const newName = clean(row.querySelector('input').value);
        if (newName) {
          renameMap.set(oldName, newName);
          if (row.querySelector('.bor-group-alert input')?.checked) nextAlertGroups.push(newName);
        }
      }
      const created = normalizeGroupNames(modal.querySelector('#bor-create-groups').value.split(/[,，\n]/));
      const nextGroups = normalizeGroupNames([...renameMap.values(), ...created]);
      for (const key of Object.keys(authorGroups)) {
        const next = normalizeGroupNames((authorGroups[key] || []).map(name => renameMap.get(name)).filter(Boolean));
        if (next.length) authorGroups[key] = next;
        else delete authorGroups[key];
      }
      if (renameMap.has(groupFilter)) groupFilter = renameMap.get(groupFilter);
      else if (groupFilter !== 'all' && groupFilter !== 'ungrouped') groupFilter = 'all';
      groups = nextGroups;
      alertGroups = normalizeGroupNames(nextAlertGroups);
      GM_setValue(GROUP_FILTER_KEY, groupFilter);
      saveGroupData();
      modal.remove();
      render();
    });
  }

  function updateGroupSelect() {
    const select = document.getElementById('bor-group-filter');
    if (!select) return;
    const options = [
      ['scope:all', '全部UP主'],
      ['scope:ungrouped', '未分组'],
      ...groups.map(name => [`group:${name}`, `${alertGroups.includes(name) ? '🔔 ' : ''}${name}`])
    ];
    const optionHtml = options.map(([value, label]) =>
      `<option value="${esc(value)}">${esc(label)}</option>`
    ).join('');
    if (select.innerHTML !== optionHtml) select.innerHTML = optionHtml;
    const selectedValue = groupFilter === 'all'
      ? 'scope:all'
      : groupFilter === 'ungrouped' ? 'scope:ungrouped' : `group:${groupFilter}`;
    if (options.some(([value]) => value === selectedValue)) select.value = selectedValue;
    else {
      groupFilter = 'all';
      select.value = 'scope:all';
      GM_setValue(GROUP_FILTER_KEY, groupFilter);
    }
  }

  function textOf(root, selectors) {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      const value = clean(node?.innerText || node?.textContent);
      if (value) return value;
    }
    return '';
  }

  function hrefOf(root, selectors) {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (node?.href) return node.href;
    }
    return '';
  }

  function dynamicIdFromLink(value) {
    return String(value || '').match(/(?:\/opus\/|\/dynamic\/|t\.bilibili\.com\/)(\d+)/)?.[1] || '';
  }

  function dynamicIdOf(root) {
    const attributes = ['data-did', 'data-dynamic-id', 'data-dynamic-id-str'];
    for (const element of [root, ...root.querySelectorAll('*')]) {
      for (const name of attributes) {
        const value = element.getAttribute?.(name);
        if (/^\d+$/.test(value || '')) return value;
      }
    }
    for (const element of root.querySelectorAll('[data-url]')) {
      const id = dynamicIdFromLink(element.getAttribute('data-url'));
      if (id) return id;
    }
    for (const anchor of root.querySelectorAll('a[href]')) {
      const id = dynamicIdFromLink(anchor.href || anchor.getAttribute('href'));
      if (id) return id;
    }
    return '';
  }

  function dynamicLinkOf(root, dynamicId = '') {
    const dataUrl = [...root.querySelectorAll('[data-url]')]
      .map(element => element.getAttribute('data-url'))
      .find(value => dynamicIdFromLink(value));
    const link = hrefOf(root, [
      'a[href*="/opus/"]', 'a[href*="t.bilibili.com/"]',
      'a[href*="/dynamic/"]', 'a.bili-dyn-time', '.bili-dyn-time a',
      'a[href*="/video/"]'
    ]);
    if (dynamicId) return `https://www.bilibili.com/opus/${dynamicId}`;
    if (dataUrl) return new URL(dataUrl, location.href).href;
    return link;
  }

  function findExpandControl(root) {
    const preferred = root.querySelector(
      '.bili-rich-text__action, [class*="rich-text"] [class*="action"]'
    );
    if (preferred && /^(展开|收起)$/.test(clean(preferred.textContent))) return preferred;

    return [...root.querySelectorAll('button, a, span')].find(element =>
      /^(展开|收起)$/.test(clean(element.textContent))
    ) || null;
  }

  function findCommentControl(root) {
    const preferred = root.querySelector(
      '.bili-dyn-action.comment, .bili-dyn-action[class*="comment"], [class*="action-comment"]'
    );
    if (preferred) return preferred;
    const actions = [...root.querySelectorAll('.bili-dyn-action, [class*="dyn-action"]')];
    const labeled = actions.find(element =>
      /评论/.test(`${element.getAttribute('title') || ''}${element.getAttribute('aria-label') || ''}${element.className || ''}`)
    );
    return labeled || actions[1] || null;
  }

  function commentCountOf(root) {
    const control = findCommentControl(root);
    const text = clean(control?.innerText || control?.textContent);
    const matched = text.match(/\d+/);
    return matched ? Number(matched[0]) : null;
  }

  function deepQueryAll(root, selector) {
    const found = [];
    const roots = [root];
    if (root?.shadowRoot) roots.push(root.shadowRoot);
    for (let index = 0; index < roots.length; index += 1) {
      const currentRoot = roots[index];
      found.push(...currentRoot.querySelectorAll(selector));
      for (const element of currentRoot.querySelectorAll('*')) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    return [...new Set(found)];
  }

  function deepTextOf(root, selectors) {
    for (const selector of selectors) {
      const node = deepQueryAll(root, selector)[0];
      const value = clean(node?.innerText || node?.textContent);
      if (value) return value;
    }
    return '';
  }

  function findCommentAreas(root = document) {
    const selectors = [
      '.bili-comment-container', '.reply-list', '.bili-comments', 'bili-comments',
      '.bili-dyn-item__footer [class*="reply"]', '[class*="comment-container"]',
      '[class*="reply-list"]', '[class*="comment-list"]'
    ];
    const areas = [];
    for (const selector of selectors) {
      for (const area of deepQueryAll(root, selector)) {
        if (!area.closest?.(`#${ID}`) && !areas.some(parent => parent.contains(area))) areas.push(area);
      }
    }
    return areas;
  }

  function findCommentArea(root, key = '') {
    const local = findCommentAreas(root)[0];
    if (local) {
      if (key) commentAreaByKey.set(key, local);
      return local;
    }
    if (key && commentAreaByKey.has(key) && document.contains(commentAreaByKey.get(key))
      && root.contains(commentAreaByKey.get(key))) {
      return commentAreaByKey.get(key);
    }
    return null;
  }

  function extractComments(root, key = '') {
    const area = findCommentArea(root, key);
    if (!area) return [];
    let nodes = deepQueryAll(area, '.root-reply-container, .sub-reply-item, bili-comment-thread-renderer, bili-comment-renderer');
    if (!nodes.length) nodes = deepQueryAll(area, '.reply-item, [class*="reply-item"], [class*="comment-item"]');
    nodes = [...new Set(nodes)];
    const seen = new Set();
    return nodes.map(node => {
      const author = deepTextOf(node, ['.user-name', '.sub-user-name', '#user-name', '[class*="user-name"]', '[class*="username"]']);
      const content = deepTextOf(node, ['.reply-content', '.sub-reply-content', '#contents', '#content', '[class*="reply-content"]', '[class*="content"]']);
      const time = deepTextOf(node, ['.reply-time', '#pubdate', '[class*="reply-time"]', '[class*="time"]']);
      const like = deepTextOf(node, ['.reply-like', '#like #count', '[class*="like"]']);
      return { author: author || '匿名用户', content, time, like };
    }).filter(comment => {
      if (!comment.content) return false;
      const key = `${fingerprint(comment.author)}|${fingerprint(comment.content)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function extract(node, index) {
    const author = textOf(node, [
      '.bili-dyn-title__text', '.bili-dyn-title',
      '[class*="dyn-title"]', '[class*="author"]'
    ]) || '未知用户';
    const time = textOf(node, [
      '.bili-dyn-time', '.bili-dyn-title__pub-time',
      '[class*="pub-time"]', '[class*="dyn-time"]'
    ]);
    const body = textOf(node, [
      '.bili-rich-text__content', '.bili-rich-text',
      '.bili-dyn-content__orig__desc', '.bili-dyn-content',
      '[class*="rich-text"]'
    ]);
    const videoTitle = textOf(node, [
      '.bili-dyn-card-video__title', '.bili-dyn-card-video__desc',
      '[class*="dyn-card-video"] [class*="title"]'
    ]);
    const dynamicId = dynamicIdOf(node);
    const link = dynamicLinkOf(node, dynamicId);
    const authorLink = hrefOf(node, [
      '.bili-dyn-title a[href*="space.bilibili.com/"]',
      '.bili-dyn-title__text[href*="space.bilibili.com/"]',
      'a[href*="space.bilibili.com/"]'
    ]);
    const authorId = authorLink.match(/space\.bilibili\.com\/(\d+)/)?.[1] || '';
    const imageCount = node.querySelectorAll(
      '.bili-album img, [class*="gallery"] img, [class*="album"] img'
    ).length;
    const hasVideo = Boolean(videoTitle || node.querySelector(
      '.bili-dyn-card-video, [class*="dyn-card-video"], a[href*="/video/"]'
    ));
    const kind = hasVideo ? 'video' : imageCount ? 'image' : 'text';
    const expandControl = findExpandControl(node);
    const content = expandControl
      ? clean(body || videoTitle).replace(/(?:\n|\s)*(?:展开|收起)\s*$/, '')
      : clean(body || videoTitle);

    // ページ構造を優先し、通常本文の単語だけでは除外しない。
    const fullText = clean(node.innerText || node.textContent);
    const hasLiveCard = Boolean(node.querySelector(
        '.bili-dyn-card-live, [class*="dyn-card-live"], [class*="live-card"]'
      ));
    const isLiveNotice = hasLiveCard || /^(直播了|正在直播|直播中)$/.test(clean(time));
    const hasLockedCard = Boolean(node.querySelector(
      '[class*="charging"], [class*="paywall"], [class*="locked"], [class*="onlyfans"]'
    ));
    const hasChargingPrompt = /(?:充电专属|专属动态|包月充电)/.test(fullText)
      && /(?:解锁观看|加入当前UP主|充电可见)/.test(fullText);
    const isChargingOnly = hasLockedCard || hasChargingPrompt;
    const isEmpty = !clean(content);

    if (isLiveNotice) return { skipReason: 'live' };
    if (isChargingOnly) return { skipReason: 'charging' };
    if (isEmpty) return { skipReason: 'empty' };

    const stableLinkId = dynamicId || dynamicIdFromLink(link);
    const commentCount = commentCountOf(node);
    // Without a public ID, expanding text or a relative timestamp must not change identity.
    const key = stableSourceKeys.get(node) || (stableLinkId ? `dynamic:${stableLinkId}`
      : `${fingerprint(author)}|${fingerprint(time)}|${fingerprint(content)}|${fingerprint(videoTitle)}`);
    stableSourceKeys.set(node, key);

    return {
      key,
      author, authorId, time, content, link, dynamicId: stableLinkId, imageCount, kind, commentCount,
      mediaTitle: videoTitle !== content ? videoTitle : '',
      expandable: Boolean(expandControl),
      expanded: clean(expandControl?.textContent) === '收起'
    };
  }

  function collect() {
    // 同じ投稿の外側と内側を同時に取得しないよう、内側要素を優先する。
    const innerNodes = [...document.querySelectorAll('.bili-dyn-item')];
    const sourceNodes = innerNodes.length
      ? innerNodes
      : [...document.querySelectorAll('.bili-dyn-list__item')];
    const nodes = sourceNodes.filter(node => !node.closest(`#${ID}`));
    const seen = new Set();
    sourceByKey.clear();
    hiddenStats = { live: 0, charging: 0, empty: 0 };
    return nodes.map(node => ({ item: extract(node), node })).filter(entry => {
      if (entry.item?.skipReason) {
        hiddenStats[entry.item.skipReason] += 1;
        return false;
      }
      if (seen.has(entry.item.key)) return false;
      seen.add(entry.item.key);
      sourceByKey.set(entry.item.key, entry.node);
      return true;
    }).map(entry => entry.item);
  }

  function card(item) {
    const type = item.kind === 'video' ? '视频'
      : item.kind === 'image' ? `图片 ${item.imageCount}` : '文字';
    const assigned = groupsFor(item.author, item.authorId);
    const groupTags = assigned.map(name =>
      `<span class="bor-group-tag">${esc(name)}</span>`
    ).join('');
    const renderState = JSON.stringify([
      item.author, item.time, item.content, item.mediaTitle,
      item.expandable, item.expanded, activeCommentKey === item.key, assigned, item.kind, item.imageCount, item.commentCount, item.link, item.dynamicId
    ]);
    return `<article class="bor-item" data-key="${esc(item.key)}" data-render-state="${esc(renderState)}" data-kind="${item.kind}">
      <div class="bor-meta">
        <span class="bor-author">${esc(item.author)}</span>
        <span class="bor-time">${esc(item.time || '时间未知')}</span>
        <span class="bor-group-tags">${groupTags}</span>
        <button class="bor-assign" data-author="${esc(item.author)}" data-author-id="${esc(item.authorId)}">设置分组</button>
        <span class="bor-type">${type}</span>
      </div>
      <div class="bor-content">${esc(item.content)}</div>
      ${item.mediaTitle ? `<div class="bor-media">${esc(item.mediaTitle)}</div>` : ''}
      ${item.expandable ? `<button class="bor-expand" aria-expanded="${item.expanded}" data-expand-key="${esc(item.key)}">${item.expanded ? '收起全文' : '展开全文'}</button>` : ''}
      <button class="bor-comments" aria-expanded="${activeCommentKey === item.key}" data-comment-key="${esc(item.key)}">${activeCommentKey === item.key ? '收起评论' : '查看评论'}${item.commentCount !== null ? `（${item.commentCount}）` : ''}</button>
      ${item.link
        ? `<a class="bor-link" href="${esc(item.link)}" target="_blank" rel="noopener">${item.link.includes('/video/') ? '打开视频' : '打开原动态'} ↗</a>`
        : `<button class="bor-link bor-open-source" data-source-key="${esc(item.key)}">打开原动态 ↗</button>`}
    </article>`;
  }

  function commentHtml(comment) {
    return `<article class="bor-comment-item${comment.isReply ? ' bor-comment-reply' : ''}">
      <div class="bor-comment-meta"><strong>${esc(comment.author)}</strong>${comment.time ? `<span>${esc(comment.time)}</span>` : ''}${Number(comment.like) > 0 ? `<span>赞 ${esc(comment.like)}</span>` : ''}</div>
      <div class="bor-comment-content">${esc(comment.content)}</div>
    </article>`;
  }

  function requestJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 12000, anonymous: false,
        headers: { Accept: 'application/json' },
        onload: response => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`请求失败（HTTP ${response.status}）`));
            return;
          }
          try { resolve(JSON.parse(response.responseText)); }
          catch (_) { reject(new Error('B站返回了无法解析的数据')); }
        },
        ontimeout: () => reject(new Error('请求超时')),
        onerror: () => reject(new Error('网络请求失败'))
      });
    });
  }

  function apiError(payload, fallback) {
    if (payload?.code === -101) return new Error('登录状态已失效，请刷新 B 站页面后重试');
    if (payload?.code === -352 || payload?.code === -403) return new Error('B站风控拒绝了评论请求，请稍后重试');
    if (payload?.code === 12002 || payload?.code === 12052) return new Error('该动态的评论区已关闭');
    return new Error(clean(payload?.message) || fallback);
  }

  function parseCommentParams(source) {
    const value = source?.querySelector('bili-comments[data-params]')?.getAttribute('data-params') || '';
    const [type, oid] = value.split(',').map(part => part.trim());
    return /^\d+$/.test(type) && /^\d+$/.test(oid) ? { type, oid } : null;
  }

  function waitForCommentParams(source, key) {
    return new Promise(resolve => {
      const startedAt = Date.now();
      const check = () => {
        const params = parseCommentParams(source);
        if (params || Date.now() - startedAt >= 3500) return resolve(params);
        setTimeout(check, 120);
      };
      check();
    });
  }

  async function resolveCommentTarget(key, state) {
    const source = sourceByKey.get(key);
    if (!source) throw new Error('原动态已离开当前加载范围，请刷新列表后重试');
    const existing = parseCommentParams(source);
    if (existing) {
      if (existing.type === '17') state.dynamicId = existing.oid;
      return existing;
    }

    const dynamicId = state.dynamicId || key.match(/^dynamic:(\d+)$/)?.[1] || dynamicIdOf(source);
    if (dynamicId) {
      state.dynamicId = dynamicId;
      const payload = await requestJson(`https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${encodeURIComponent(dynamicId)}`);
      if (payload?.code !== 0) throw apiError(payload, '无法读取动态详情');
      const basic = payload?.data?.item?.basic;
      if (basic?.comment_type !== undefined && basic?.comment_id_str) {
        return { type: String(basic.comment_type), oid: String(basic.comment_id_str) };
      }
    }

    const control = findCommentControl(source);
    if (!control) throw new Error('没有找到这条动态的评论入口');
    if (!parseCommentParams(source)) control.click();
    const params = await waitForCommentParams(source, key);
    if (params) {
      if (params.type === '17') state.dynamicId = params.oid;
      return params;
    }
    throw new Error('评论组件未返回评论区 ID');
  }

  function normalizeApiComments(replies) {
    const result = [];
    const add = (reply, isReply = false) => {
      const content = clean(reply?.content?.message);
      if (!content) return;
      result.push({
        id: String(reply.rpid_str || reply.rpid || `${reply.mid}-${reply.ctime}-${content}`),
        author: clean(reply?.member?.uname) || '匿名用户',
        content,
        time: clean(reply?.reply_control?.time_desc) || (reply.ctime ? new Date(reply.ctime * 1000).toLocaleString() : ''),
        like: Number(reply.like) || 0,
        isReply
      });
    };
    for (const reply of replies || []) {
      add(reply, false);
      for (const child of reply.replies || []) add(child, true);
    }
    return result;
  }

  function commentFallbackLink(key) {
    const source = sourceByKey.get(key);
    if (!source) return '';
    const dynamicId = commentStateByKey.get(key)?.dynamicId
      || key.match(/^dynamic:(\d+)$/)?.[1] || dynamicIdOf(source);
    return dynamicLinkOf(source, dynamicId);
  }

  function renderCommentDrawer(key) {
    if (activeCommentKey !== key) return;
    const drawer = document.getElementById('bor-comment-drawer');
    const state = commentStateByKey.get(key);
    if (!drawer || !state) return;
    const body = drawer.querySelector('.bor-comment-list');
    const status = drawer.querySelector('.bor-comment-status');
    const more = drawer.querySelector('#bor-comment-more');
    const scrollTop = body.scrollTop;
    if (state.comments.length) {
      body.querySelectorAll('.bor-comment-fallback').forEach(element => element.remove());
      const rendered = Number(body.dataset.rendered || 0);
      if (rendered > state.comments.length) { body.innerHTML = ''; body.dataset.rendered = '0'; }
      body.insertAdjacentHTML('beforeend', state.comments.slice(Number(body.dataset.rendered || 0)).map(commentHtml).join(''));
      body.dataset.rendered = String(state.comments.length);
      status.textContent = state.loading
        ? `已读取 ${state.comments.length} 条，正在加载……`
        : `已显示 ${state.comments.length} 条（含已加载回复）${state.source === 'dom' ? ' · 仅当前页面已加载内容' : state.hasMore ? '' : ' · 已到末尾'}`;
    } else if (state.loading) {
      body.innerHTML = '<div class="bor-comment-fallback"><p>正在读取对应动态的评论……</p></div>';
      status.textContent = '正在加载评论……';
    } else if (state.error) {
      status.textContent = '评论加载失败';
      body.innerHTML = '<div class="bor-comment-fallback"><p>评论尚未加载，请使用下方重试入口。</p></div>';
    } else {
      status.textContent = '这条动态暂无评论';
      body.innerHTML = '<div class="bor-comment-fallback"><p>暂无可显示的评论。</p></div>';
    }
    const feedback = drawer.querySelector('.bor-comment-feedback');
    feedback.innerHTML = state.error ? `${esc(state.error)} <button id="bor-comment-retry">重试本页</button>` : '';
    body.scrollTop = scrollTop;
    if (more) {
      more.hidden = Boolean(state.error) || !state.comments.length || (!state.hasMore && !state.loading);
      more.disabled = state.loading;
      more.textContent = state.loading ? '正在加载……' : '加载更多评论';
    }
  }

  async function loadCommentsPage(key, reset = false) {
    let state = commentStateByKey.get(key);
    if (!state || reset) {
      state = { comments: [], page: 0, next: 0, total: 0, hasMore: true, loading: false, error: '', source: 'api', dynamicId: '' };
      commentStateByKey.set(key, state);
    }
    if (state.loading || (!state.error && !state.hasMore && state.page > 0 && !reset)) return;
    state.loading = true;
    state.error = '';
    renderCommentDrawer(key);
    try {
      if (!state.type || !state.oid) Object.assign(state, await resolveCommentTarget(key, state));
      const requestCursor = state.next;
      const url = `https://api.bilibili.com/x/v2/reply/main?type=${encodeURIComponent(state.type)}&oid=${encodeURIComponent(state.oid)}&next=${encodeURIComponent(requestCursor)}&mode=3`;
      const payload = await requestJson(url);
      if (payload?.code !== 0) throw apiError(payload, '无法读取评论');
      const cursor = payload?.data?.cursor || {};
      if (typeof cursor.is_end !== 'boolean' || cursor.next == null || !Number.isSafeInteger(Number(cursor.next))) {
        throw new Error('评论响应不完整，请重试或打开原动态');
      }
      const incoming = normalizeApiComments(payload?.data?.replies);
      const seen = new Set(state.comments.map(comment => comment.id));
      const unique = incoming.filter(comment => { if (seen.has(comment.id)) return false; seen.add(comment.id); return true; });
      if (!cursor.is_end && (Number(cursor.next) === requestCursor || (state.page > 0 && !unique.length))) {
        throw new Error('没有取得下一批评论，请稍后重试');
      }
      state.comments.push(...unique);
      state.page += 1;
      state.next = Number(cursor.next) || 0;
      state.total = Number(cursor.all_count) || state.comments.length;
      state.hasMore = cursor.is_end !== true && state.next !== requestCursor;
      state.source = 'api';
    } catch (error) {
      const source = sourceByKey.get(key);
      const fallback = source && !state.comments.length ? extractComments(source, key) : [];
      if (fallback.length) {
        state.comments = fallback.map((comment, index) => ({ ...comment, id: `dom-${index}` }));
        state.total = state.comments.length;
        state.hasMore = false;
        state.source = 'dom';
        state.error = '接口暂不可用，目前仅显示页面已加载评论；打开原动态可继续阅读。';
      } else {
        state.error = error?.message || '未知错误';
        state.hasMore = false;
      }
    } finally {
      state.loading = false;
      renderCommentDrawer(key);
    }
  }

  function openOriginalDynamic(key) {
    const link = commentFallbackLink(key);
    if (link) {
      window.open(link, '_blank', 'noopener');
      return;
    }
    const source = sourceByKey.get(key);
    const control = source?.querySelector('.bili-dyn-time, [data-module="time"], [data-url*="/opus/"]');
    const status = document.querySelector('#bor-comment-drawer .bor-comment-status');
    if (control) {
      control.click();
      if (status) status.textContent = '已触发打开原动态；若没有新页面，请检查浏览器弹窗拦截。';
    } else if (status) {
      status.textContent = '无法定位原动态链接，请刷新列表后重试。';
    }
  }

  function openComments(key) {
    if (activeCommentKey === key && document.getElementById('bor-comment-drawer')) {
      closeComments();
      return;
    }
    const previous = commentStateByKey.get(activeCommentKey);
    if (previous) previous.scrollTop = document.querySelector('.bor-comment-list')?.scrollTop || 0;
    activeCommentKey = key;
    document.getElementById('bor-comment-drawer')?.remove();
    const drawer = document.createElement('aside');
    drawer.id = 'bor-comment-drawer';
    const item = sourceByKey.has(key) ? extract(sourceByKey.get(key)) : null;
    drawer.setAttribute('role', 'region');
    drawer.setAttribute('aria-label', '动态评论');
    drawer.innerHTML = `<header><div><h2>${esc(item?.author || '动态')} · 评论</h2><p class="bor-comment-context">${esc(item?.content?.slice(0, 70) || '')}</p><p class="bor-comment-status" aria-live="polite">正在加载评论……</p></div><button class="bor-comment-close" aria-label="关闭评论">×</button></header>
      <div class="bor-comment-list"></div>
      <div class="bor-comment-feedback" role="status"></div>
      <footer><button id="bor-comment-more">加载更多评论</button><button class="bor-open-source" data-source-key="${esc(key)}">打开原动态 ↗</button></footer>`;
    document.getElementById(ID)?.appendChild(drawer);
    if (commentStateByKey.has(key)) renderCommentDrawer(key);
    else loadCommentsPage(key, true);
    drawer.querySelector('.bor-comment-list').scrollTop = commentStateByKey.get(key)?.scrollTop || 0;
    drawer.querySelector('.bor-comment-close').focus({ preventScroll: true });
    schedule();
  }

  function closeComments() {
    const key = activeCommentKey;
    const state = commentStateByKey.get(key);
    if (state) state.scrollTop = document.querySelector('.bor-comment-list')?.scrollTop || 0;
    document.getElementById('bor-comment-drawer')?.remove();
    activeCommentKey = '';
    render();
    [...document.querySelectorAll('.bor-comments')].find(button => button.dataset.commentKey === key)?.focus({ preventScroll: true });
  }

  function loadMoreComments() {
    if (activeCommentKey) loadCommentsPage(activeCommentKey, false);
  }

  function mount() {
    if (document.getElementById(ID)) return;
    const reader = document.createElement('section');
    reader.id = ID;
    reader.innerHTML = `<header class="bor-header">
      <div><h1>信息动态</h1><p id="bor-status">正在读取……</p><p id="bor-refresh-status"></p></div>
      <div class="bor-actions">
        <select id="bor-group-filter" title="按UP主分组筛选"></select>
        <button data-filter="all">全部动态</button>
        <button data-filter="no-video">排除视频</button>
        <button data-filter="text-only">纯文字</button>
        <button id="bor-check-now">立即检查</button>
        <details class="bor-settings-menu"><summary>设置</summary><div class="bor-settings-popover">
        <button id="bor-manage-groups">管理分组</button><button id="bor-settings">阅读与备份</button>
        <label class="bor-auto-refresh"><input id="bor-auto-refresh" type="checkbox" ${autoRefresh ? 'checked' : ''}><span>空闲刷新</span></label>
        <select id="bor-refresh-minutes" title="无操作多久后检查">
          ${[1, 3, 5, 10, 30].map(value => `<option value="${value}" ${value === refreshMinutes ? 'selected' : ''}>${value}分钟</option>`).join('')}
        </select>
        <button id="bor-original">返回原版</button>
        </div></details>
      </div>
    </header><main id="bor-feed"></main>
    <div id="bor-footer"><span id="bor-hidden-info"></span><button id="bor-load-more">继续查找更早动态</button></div>`;
    document.body.appendChild(reader);
    applyPreferences();
    updateGroupSelect();

    reader.addEventListener('change', event => {
      if (event.target.id === 'bor-group-filter') {
        const value = event.target.value;
        groupFilter = value === 'scope:all'
          ? 'all'
          : value === 'scope:ungrouped' ? 'ungrouped' : value.replace(/^group:/, '');
        GM_setValue(GROUP_FILTER_KEY, groupFilter);
        render();
      }
      if (event.target.id === 'bor-auto-refresh') {
        autoRefresh = event.target.checked;
        GM_setValue(AUTO_REFRESH_KEY, autoRefresh);
        markActivity();
        updateRefreshStatus();
      }
      if (event.target.id === 'bor-refresh-minutes') {
        refreshMinutes = Number(event.target.value);
        GM_setValue(REFRESH_MINUTES_KEY, refreshMinutes);
        markActivity();
        updateRefreshStatus();
      }
    });

    reader.addEventListener('click', event => {
      if (event.target.closest('#bor-settings')) { openSettings(); return; }
      const assignButton = event.target.closest('.bor-assign');
      if (assignButton) {
        editAuthorGroups(assignButton.dataset.author, assignButton.dataset.authorId);
        return;
      }
      if (event.target.closest('#bor-manage-groups')) {
        manageGroups();
        return;
      }
      if (event.target.closest('#bor-load-more')) {
        requestMore();
        return;
      }
      if (event.target.closest('#bor-check-now')) {
        softRefresh(true);
        return;
      }
      if (event.target.closest('.bor-comment-close')) {
        closeComments();
        return;
      }
      if (event.target.closest('#bor-comment-more')) {
        loadMoreComments();
        return;
      }
      if (event.target.closest('#bor-comment-retry')) {
        const state = commentStateByKey.get(activeCommentKey);
        if (state?.source === 'dom') {
          commentStateByKey.delete(activeCommentKey);
          const body = document.querySelector('.bor-comment-list');
          body.innerHTML = ''; body.dataset.rendered = '0';
        }
        loadCommentsPage(activeCommentKey, false);
        return;
      }
      const openSourceButton = event.target.closest('.bor-open-source');
      if (openSourceButton) {
        openOriginalDynamic(openSourceButton.dataset.sourceKey || activeCommentKey);
        return;
      }
      const commentButton = event.target.closest('.bor-comments');
      if (commentButton) {
        openComments(commentButton.dataset.commentKey);
        return;
      }
      if (event.target.closest('#bor-hidden-info')) {
        const total = hiddenStats.live + hiddenStats.charging + hiddenStats.empty;
        if (total) window.alert(`本次隐藏 ${total} 条：\n直播通知 ${hiddenStats.live} 条\n充电专属 ${hiddenStats.charging} 条\n无法提取内容 ${hiddenStats.empty} 条`);
        return;
      }
      const expandButton = event.target.closest('.bor-expand');
      if (expandButton) {
        const source = sourceByKey.get(expandButton.dataset.expandKey);
        const control = source && findExpandControl(source);
        if (control) {
          expandButton.disabled = true;
          const collapsing = clean(control.textContent) === '收起';
          expandButton.textContent = collapsing ? '正在收起……' : '正在展开……';
          control.click();
          setTimeout(schedule, 250);
          setTimeout(schedule, 900);
          if (collapsing) setTimeout(() => {
            const key = expandButton.dataset.expandKey;
            const card = [...document.querySelectorAll('.bor-item')].find(element => element.dataset.key === key);
            const reader = document.getElementById(ID);
            const header = document.querySelector('.bor-header');
            if (card && reader && header && card.getBoundingClientRect().top < header.getBoundingClientRect().bottom) {
              reader.scrollTop += card.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
            }
          }, 1150);
          setTimeout(() => {
            // Restore a usable control even if the source action did not mutate the DOM.
            if (expandButton.isConnected) {
              expandButton.disabled = false;
              expandButton.textContent = '操作未完成，点击重试';
            }
          }, 2000);
        } else {
          expandButton.textContent = '展开失败，请打开原动态';
        }
        return;
      }
      const button = event.target.closest('[data-filter]');
      if (button) {
        filter = button.dataset.filter;
        GM_setValue(FILTER_KEY, filter);
        render();
      } else if (event.target.closest('#bor-original')) {
        toggle(false);
      }
    });

    reader.addEventListener('scroll', () => {
      markActivity();
      const remain = reader.scrollHeight - reader.scrollTop - reader.clientHeight;
      if (remain < 500 && reader.scrollHeight > reader.clientHeight + 100) requestMore();
    }, { passive: true });
    for (const eventName of ['click', 'keydown', 'wheel', 'touchstart']) {
      reader.addEventListener(eventName, markActivity, { passive: true, capture: true });
    }
    updateRefreshStatus();
  }

  function markActivity() {
    lastActivityAt = Date.now();
    updateRefreshStatus();
  }

  function formatClock(timestamp) {
    return timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '尚未检查';
  }

  function updateRefreshStatus() {
    const status = document.getElementById('bor-refresh-status');
    if (!status) return;
    if (!autoRefresh) {
      status.textContent = `自动检查已关闭 · 上次检查：${formatClock(lastCheckedAt)}`;
      return;
    }
    const base = Math.max(lastActivityAt, lastCheckedAt);
    const remaining = Math.max(0, refreshMinutes * 60000 - (Date.now() - base));
    status.textContent = `${refreshing ? '正在检查新动态' : `无操作 ${Math.ceil(remaining / 60000)} 分钟后检查`} · 上次检查：${formatClock(lastCheckedAt)}`;
  }

  function showToast(message) {
    document.getElementById('bor-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'bor-toast';
    toast.textContent = message;
    document.getElementById(ID)?.appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
  }

  function notifyNewItems(newItems) {
    if (!newItems.length || !alertGroups.length) return;
    const counts = new Map();
    const matched = [];
    for (const item of newItems) {
      const assigned = groupsFor(item.author, item.authorId);
      const hitGroups = assigned.filter(name => alertGroups.includes(name));
      if (!hitGroups.length) continue;
      matched.push(item);
      for (const name of hitGroups) counts.set(name, (counts.get(name) || 0) + 1);
    }
    if (!matched.length) return;

    const summary = [...counts].map(([name, count]) => `${name} ${count}条`).join('、');
    const sample = matched.slice(0, 2).map(item => `${item.author}：${item.content.slice(0, 42)}`).join('\n');
    showToast(`关注分组有新动态：${summary}`);

    clearTimeout(titleResetTimer);
    document.title = `【${matched.length}条新动态】${summary} - ${originalTitle}`;
    titleResetTimer = setTimeout(() => { document.title = originalTitle; }, 30000);

    try {
      if (!preferences.notifications) return;
      GM_notification({
        title: `B站分组新动态：${summary}`,
        text: preferences.preview ? sample : `发现 ${matched.length} 条新动态`,
        timeout: 10000,
        onclick: () => {
          window.focus();
          const firstGroup = counts.keys().next().value;
          if (firstGroup) {
            groupFilter = firstGroup;
            GM_setValue(GROUP_FILTER_KEY, groupFilter);
            render();
          }
        }
      });
    } catch (_) {
      // 一部のユーザースクリプト環境ではページ内通知だけを使用する。
    }
  }

  function findSoftRefreshControl() {
    const candidates = [...document.querySelectorAll(
      '.bili-dyn-list__notification, [class*="new-dynamic"], [class*="refresh"], .bili-dyn-list-tabs__item'
    )].filter(element => !element.closest(`#${ID}`));
    return candidates.find(element => /新动态|点击刷新|刷新动态/.test(clean(element.textContent)))
      || candidates.find(element => element.matches('.bili-dyn-list-tabs__item.active, [class*="tabs__item"][class*="active"]'))
      || null;
  }

  function softRefresh(manual = false) {
    if (refreshing || document.visibilityState === 'hidden') return;
    refreshing = true;
    lastCheckedAt = Date.now();
    updateRefreshStatus();
    const previousKeys = new Set(sourceByKey.keys());
    const control = findSoftRefreshControl();

    document.documentElement.classList.add('bor-loading-source');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (control) control.click();

    setTimeout(() => document.documentElement.classList.remove('bor-loading-source'), 500);
    setTimeout(() => {
      const items = collect();
      const newItems = items.filter(item => !previousKeys.has(item.key));
      const newCount = newItems.length;
      refreshing = false;
      lastCheckedAt = Date.now();
      render();
      updateRefreshStatus();
      notifyNewItems(newItems);
      if (!control) showToast('未找到B站的软刷新入口；本次没有强制重载页面。');
      else if (newCount) showToast(`已发现并载入 ${newCount} 条新动态`);
      else if (manual) showToast('检查完成，暂未发现新动态');
    }, 1800);
  }

  function checkIdleRefresh() {
    updateRefreshStatus();
    if (!enabled || !autoRefresh || refreshing || document.visibilityState === 'hidden') return;
    const reader = document.getElementById(ID);
    if (activeCommentKey || document.querySelector('.bor-modal-backdrop') || reader?.scrollTop > 40
      || document.querySelector('.bor-expand[aria-expanded="true"]')) {
      const status = document.getElementById('bor-refresh-status');
      if (status) status.textContent = '正在阅读，已暂缓自动刷新 · 可手动检查';
      return;
    }
    const base = Math.max(lastActivityAt, lastCheckedAt);
    if (Date.now() - base >= refreshMinutes * 60000) softRefresh(false);
  }

  function requestMore() {
    if (loadingMore) return;
    loadingMore = true;
    const button = document.getElementById('bor-load-more');
    if (button) {
      button.disabled = true;
      button.textContent = '正在加载更早动态……';
    }

    // オーバーレイを維持したまま、背面のBilibiliページだけを末尾へ送る。
    document.documentElement.classList.add('bor-loading-source');
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    setTimeout(() => {
      document.documentElement.classList.remove('bor-loading-source');
      schedule();
    }, 500);
    setTimeout(() => {
      loadingMore = false;
      const nextButton = document.getElementById('bor-load-more');
      if (nextButton) {
        nextButton.disabled = false;
        nextButton.textContent = '继续查找更早动态';
      }
      schedule();
    }, 1800);
  }

  function emptyMessage(all, shown) {
    if (shown.length) return '';
    if (!all.length) return '尚未读取到动态。请确认B站已登录并完成加载。';
    if (groupFilter !== 'all' && groupFilter !== 'ungrouped') {
      const memberCount = Object.values(authorGroups).filter(value =>
        Array.isArray(value) && value.includes(groupFilter)
      ).length;
      if (!memberCount) return `“${groupFilter}”分组还没有UP主。可以先切换到“未分组”进行设置。`;
      return `当前已加载范围内没有“${groupFilter}”分组的匹配动态。`;
    }
    if (groupFilter === 'ungrouped') return '当前已加载范围内没有未分组UP主的动态。';
    return '当前筛选条件下没有匹配动态。';
  }

  function updateFeed(feed, shown, message) {
    if (!shown.length) {
      if (feed.dataset.emptyMessage !== message || feed.children.length !== 1) {
        feed.innerHTML = `<div class="bor-empty">${esc(message)}</div>`;
        feed.dataset.emptyMessage = message;
      }
      return;
    }

    delete feed.dataset.emptyMessage;
    const reader = document.getElementById(ID);
    const headerBottom = document.querySelector('.bor-header')?.getBoundingClientRect().bottom || 0;
    const anchor = [...feed.querySelectorAll(':scope > .bor-item')].find(element =>
      element.getBoundingClientRect().bottom > headerBottom
    );
    const anchorKey = anchor?.dataset.key || '';
    const anchorTop = anchor?.getBoundingClientRect().top || 0;
    feed.querySelectorAll(':scope > :not(.bor-item)').forEach(element => element.remove());
    const existing = new Map(
      [...feed.querySelectorAll(':scope > .bor-item')].map(element => [element.dataset.key, element])
    );
    const desired = [];

    for (const item of shown) {
      const template = document.createElement('template');
      template.innerHTML = card(item).trim();
      const fresh = template.content.firstElementChild;
      const old = existing.get(item.key);
      if (old && old.dataset.renderState === fresh.dataset.renderState) {
        desired.push(old);
        existing.delete(item.key);
      } else {
        if (old) {
          old.replaceWith(fresh);
          existing.delete(item.key);
        }
        desired.push(fresh);
      }
    }
    for (const element of existing.values()) element.remove();
    desired.forEach((element, index) => {
      const current = feed.children[index];
      if (current !== element) feed.insertBefore(element, current || null);
    });
    if (reader && anchorKey) {
      const nextAnchor = [...feed.children].find(element => element.dataset.key === anchorKey);
      if (nextAnchor) reader.scrollTop += nextAnchor.getBoundingClientRect().top - anchorTop;
    }
  }

  function render() {
    if (!enabled) return;
    mount();
    const all = collect();
    const shown = all.filter(item => {
      const typeMatches = filter === 'all'
        || (filter === 'no-video' && item.kind !== 'video')
        || (filter === 'text-only' && item.kind === 'text');
      const assigned = groupsFor(item.author, item.authorId);
      const groupMatches = groupFilter === 'all'
        || (groupFilter === 'ungrouped' && assigned.length === 0)
        || assigned.includes(groupFilter);
      return typeMatches && groupMatches;
    });
    const feed = document.getElementById('bor-feed');
    const status = document.getElementById('bor-status');
    if (!feed || !status) return;
    updateFeed(feed, shown, emptyMessage(all, shown));
    const hiddenTotal = hiddenStats.live + hiddenStats.charging + hiddenStats.empty;
    status.textContent = `已扫描 ${all.length + hiddenTotal} 条，显示 ${shown.length} 条`;
    const hiddenInfo = document.getElementById('bor-hidden-info');
    if (hiddenInfo) hiddenInfo.textContent = hiddenTotal ? `已隐藏 ${hiddenTotal} 条（查看原因）` : '没有隐藏内容';
    updateGroupSelect();
    document.querySelectorAll(`#${ID} [data-filter]`).forEach(button => {
      button.classList.toggle('active', button.dataset.filter === filter);
    });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(render, 180);
  }

  function toggle(next) {
    enabled = next;
    GM_setValue(KEY, enabled);
    document.documentElement.classList.toggle('bor-enabled', enabled);
    if (enabled) {
      mount();
      schedule();
    } else {
      activeCommentKey = '';
      document.getElementById(ID)?.remove();
    }
  }

  function installStyle() {
    const style = document.createElement('style');
    style.textContent = `
      #bor-reader :focus-visible { outline: 2px solid #365a82; outline-offset: 3px; }
      .bor-settings-menu { position: relative; }
      .bor-settings-menu summary { cursor: pointer; padding: 6px 11px; border: 1px solid #cbd2da; border-radius: 4px; }
      .bor-settings-popover { position: absolute; right: 0; top: 100%; min-width: 240px; padding: 14px; background: #fff; border: 1px solid #cbd2da; display: grid; gap: 10px; box-shadow: 0 6px 20px #0002; }
      #bor-reader .bor-content { font-size: var(--bor-font-size, 15px); line-height: var(--bor-line-height, 1.8); }
      #bor-reader .bor-comment-content { font-size: var(--bor-font-size, 15px); line-height: var(--bor-line-height, 1.8); }
      #bor-reader .bor-time, #bor-reader .bor-assign, #bor-reader .bor-header p, #bor-reader .bor-comment-meta span { color: #606b79; }
      .bor-comment-context { max-width: 345px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bor-comment-feedback { padding: 0 16px; color: #8b3930; font-size: 13px; }
      .bor-comment-feedback:not(:empty) { padding: 12px 16px; border-top: 1px solid #ddd; }
      .bor-comment-feedback button { padding: 6px 10px; cursor: pointer; }
      html.bor-enabled, html.bor-enabled body { overflow: hidden !important; }
      html.bor-enabled.bor-loading-source,
      html.bor-enabled.bor-loading-source body { overflow: auto !important; }
      #bor-reader {
        position: fixed; inset: 0; z-index: 2147483647; overflow-y: auto;
        color: #222831; background: #f3f5f7;
        font: 14px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI",
          "Microsoft YaHei", sans-serif;
      }
      #bor-reader * { box-sizing: border-box; }
      .bor-header {
        position: sticky; top: 0; z-index: 2; display: flex;
        justify-content: space-between; align-items: center; gap: 24px;
        padding: 16px max(24px, calc((100vw - 980px) / 2));
        border-bottom: 1px solid #d8dde3; background: rgba(255,255,255,.97);
      }
      .bor-header h1 { margin: 0; font-size: 18px; font-weight: 650; }
      .bor-header p { margin: 2px 0 0; color: #7a8491; font-size: 12px; }
      #bor-refresh-status { color: #929aa5; }
      .bor-actions { display: flex; gap: 6px; flex-wrap: wrap; }
      .bor-actions button {
        border: 1px solid #cbd2da; border-radius: 4px; padding: 6px 11px;
        color: #4b5563; background: #fff; cursor: pointer;
      }
      .bor-actions select {
        min-width: 120px; border: 1px solid #cbd2da; border-radius: 4px;
        padding: 6px 28px 6px 9px; color: #374151; background: #fff;
      }
      .bor-auto-refresh {
        display: inline-flex; align-items: center; gap: 5px; padding: 5px 8px;
        border: 1px solid #cbd2da; border-radius: 4px; color: #4b5563;
        background: #fff; font-size: 12px; cursor: pointer;
      }
      .bor-actions button:hover, .bor-actions button.active {
        color: #111827; border-color: #7c8795; background: #edf0f3;
      }
      .bor-actions button.active { box-shadow: inset 0 -2px 0 #596579; }
      #bor-feed {
        width: min(980px, calc(100% - 40px)); margin: 18px auto;
        border: 1px solid #d9dee5; border-bottom: 0; background: #fff;
      }
      .bor-item { padding: 16px 20px 15px; border-bottom: 1px solid #e2e6eb; }
      .bor-item:hover { background: #fafbfc; }
      .bor-meta { display: flex; align-items: center; gap: 8px 10px; flex-wrap: wrap; margin-bottom: 7px; }
      .bor-author { color: #1f2937; font-weight: 650; }
      .bor-time { color: #89929e; font-size: 12px; }
      .bor-group-tags { display: inline-flex; gap: 4px; flex-wrap: wrap; }
      .bor-group-tag {
        padding: 0 6px; border-radius: 9px; color: #596579;
        background: #edf1f5; font-size: 11px;
      }
      .bor-assign {
        padding: 0; border: 0; color: #9aa2ac; background: transparent;
        font: inherit; font-size: 11px; cursor: pointer;
      }
      .bor-assign:hover { color: #475569; text-decoration: underline; }
      .bor-type {
        margin-left: auto; padding: 1px 7px; border: 1px solid #d7dce2;
        border-radius: 10px; color: #7b8490; font-size: 11px;
      }
      .bor-content { white-space: pre-wrap; overflow-wrap: anywhere; }
      .bor-media {
        margin-top: 9px; padding: 8px 11px; border-left: 3px solid #9aa3ad;
        color: #4b5563; background: #f4f6f8;
      }
      .bor-link {
        display: inline-block; margin-top: 8px; color: #687586;
        border: 0; padding: 0; background: transparent; cursor: pointer;
        font: inherit; font-size: 12px; text-decoration: none;
      }
      .bor-expand {
        display: inline-block; margin: 9px 12px 0 0; padding: 0;
        border: 0; color: #536579; background: transparent;
        font: inherit; font-size: 12px; cursor: pointer;
      }
      .bor-comments {
        display: inline-block; margin: 9px 12px 0 0; padding: 0;
        border: 0; color: #536579; background: transparent;
        font: inherit; font-size: 12px; cursor: pointer;
      }
      .bor-comments:hover { color: #1f2937; text-decoration: underline; }
      .bor-expand:hover { color: #1f2937; text-decoration: underline; }
      .bor-expand:disabled { color: #929ba6; cursor: default; text-decoration: none; }
      .bor-link:hover { color: #1f2937; text-decoration: underline; }
      .bor-empty { padding: 60px 20px; color: #77818e; text-align: center; }
      #bor-footer {
        display: flex; justify-content: center; align-items: center; gap: 14px;
        padding: 4px 0 28px; color: #929ba6; font-size: 12px;
      }
      #bor-hidden-info { cursor: pointer; }
      #bor-hidden-info:hover { color: #596579; text-decoration: underline; }
      #bor-load-more {
        border: 1px solid #cbd2da; border-radius: 4px; padding: 6px 12px;
        color: #4b5563; background: #fff; cursor: pointer;
      }
      #bor-load-more:disabled { color: #9aa2ac; cursor: wait; }
      .bor-modal-backdrop {
        position: fixed; inset: 0; z-index: 5; display: grid; place-items: center;
        padding: 20px; background: rgba(25, 31, 39, .32);
      }
      .bor-modal {
        width: min(520px, 100%); max-height: min(720px, calc(100vh - 40px));
        overflow: auto; border: 1px solid #cfd5dc; border-radius: 8px;
        background: #fff; box-shadow: 0 18px 55px rgba(0,0,0,.18);
      }
      .bor-modal > header {
        position: sticky; top: 0; display: flex; align-items: center;
        justify-content: space-between; padding: 14px 18px;
        border-bottom: 1px solid #e2e6eb; background: #fff;
      }
      .bor-modal h2 { margin: 0; font-size: 16px; }
      .bor-modal-close {
        width: 30px; height: 30px; border: 0; color: #667085;
        background: transparent; font-size: 22px; cursor: pointer;
      }
      .bor-modal-body { padding: 16px 18px 18px; }
      .bor-modal-body footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
      .bor-modal-body button {
        border: 1px solid #cbd2da; border-radius: 4px; padding: 7px 12px;
        color: #4b5563; background: #fff; cursor: pointer;
      }
      .bor-modal-body button.bor-primary { color: #fff; border-color: #465568; background: #465568; }
      .bor-check-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      .bor-check { display: flex; align-items: center; gap: 7px; padding: 7px 9px; border: 1px solid #e0e4e9; border-radius: 4px; }
      .bor-field { display: grid; gap: 6px; margin-top: 14px; color: #667085; font-size: 12px; }
      .bor-field input, .bor-group-row input {
        width: 100%; border: 1px solid #cbd2da; border-radius: 4px;
        padding: 8px 9px; color: #1f2937; background: #fff; font: inherit;
      }
      .bor-help { margin: 0 0 12px; color: #7a8491; font-size: 12px; }
      .bor-group-row { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; margin-bottom: 8px; }
      .bor-group-alert { display: inline-flex; align-items: center; gap: 4px; color: #59636f; white-space: nowrap; }
      .bor-delete-group { color: #9b4b4b !important; }
      #bor-comment-drawer {
        position: fixed; top: 0; right: 0; bottom: 0; z-index: 4;
        display: grid; grid-template-rows: auto minmax(0, 1fr) auto auto;
        width: min(470px, 94vw); border-left: 1px solid #ccd2da;
        color: #222831; background: #fff; box-shadow: -12px 0 36px rgba(0,0,0,.12);
      }
      #bor-comment-drawer > header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 16px; border-bottom: 1px solid #e1e5ea;
      }
      #bor-comment-drawer h2 { margin: 0; font-size: 16px; }
      #bor-comment-drawer header p { margin: 2px 0 0; color: #8a939e; font-size: 12px; }
      .bor-comment-close {
        width: 32px; height: 32px; border: 0; color: #667085;
        background: transparent; font-size: 24px; cursor: pointer;
      }
      .bor-comment-list { min-height: 0; overflow-y: auto; padding: 0 16px; overscroll-behavior: contain; }
      .bor-comment-fallback {
        display: grid; place-items: center; gap: 10px; min-height: 180px;
        padding: 24px; color: #7c8692; text-align: center;
      }
      .bor-comment-fallback p { margin: 0; }
      .bor-comment-fallback button {
        border: 1px solid #aeb7c2; border-radius: 4px; padding: 7px 12px;
        color: #3f4c5c; background: #fff; cursor: pointer;
      }
      .bor-comment-item { padding: 13px 0; border-bottom: 1px solid #e6e9ed; }
      .bor-comment-item.bor-comment-reply {
        margin-left: 18px; padding-left: 12px; border-left: 2px solid #edf0f3;
      }
      .bor-comment-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; font-size: 12px; }
      .bor-comment-meta span { color: #929aa5; }
      .bor-comment-content { white-space: pre-wrap; overflow-wrap: anywhere; }
      #bor-comment-drawer > footer {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 12px 16px; border-top: 1px solid #e1e5ea; background: #fff;
      }
      #bor-comment-drawer footer button {
        border: 1px solid #cbd2da; border-radius: 4px; padding: 6px 10px;
        color: #4b5563; background: #fff; cursor: pointer;
      }
      #bor-comment-drawer footer a, #bor-comment-drawer footer .bor-open-source {
        color: #59697b; font-size: 12px; text-decoration: none;
      }
      #bor-toast {
        position: fixed; left: 50%; bottom: 26px; z-index: 8;
        transform: translateX(-50%); padding: 9px 14px; border-radius: 5px;
        color: #fff; background: rgba(42, 50, 61, .94); box-shadow: 0 5px 18px rgba(0,0,0,.16);
        font-size: 13px;
      }
      @media (max-width: 720px) {
        .bor-header { align-items: flex-start; flex-direction: column; gap: 10px; padding: 12px 16px; }
        #bor-feed { width: calc(100% - 20px); margin: 10px auto; }
        .bor-item { padding: 14px; }
      }
    `;
    document.head.appendChild(style);
  }

  function init() {
    installStyle();
    new MutationObserver(records => {
      if (records.some(record => !record.target.closest?.(`#${ID}`))) schedule();
    }).observe(document.body, { childList: true, subtree: true });
    toggle(enabled);
    [600, 1600, 3200].forEach(delay => setTimeout(schedule, delay));
    setInterval(checkIdleRefresh, 15000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkIdleRefresh();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && document.querySelector('.bor-modal-backdrop')) {
        document.querySelector('.bor-modal-backdrop')?.remove();
        return;
      }
      if (event.key === 'Escape' && document.getElementById('bor-comment-drawer')) {
        closeComments();
        return;
      }
      if (event.altKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggle(!enabled);
      }
    });
  }

  GM_registerMenuCommand('切换办公阅读器（Alt+B）', () => toggle(!enabled));
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else init();
})();
