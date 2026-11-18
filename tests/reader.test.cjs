const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const script = fs.readFileSync('bilibili-office-reader.user.js', 'utf8');
const dom = new JSDOM('<!doctype html><body><div class="bili-dyn-item"><span class="bili-dyn-title__text">测试作者</span><div class="bili-dyn-time">刚刚</div><div class="bili-rich-text__content">短文</div><span class="bili-rich-text__action">展开</span><bili-comments data-params="17,123456"></bili-comments></div></body>', { url: 'https://t.bilibili.com/', runScripts: 'outside-only' });
const w = dom.window;
const storage = new Map([['bilibili-office-reader-groups', ['财经']], ['bilibili-office-reader-author-groups', { 'name:测试作者': ['财经'] }]]);
const responses = [], requests = [];
w.GM_getValue = (k, fallback) => storage.has(k) ? structuredClone(storage.get(k)) : fallback;
w.GM_setValue = (k, v) => storage.set(k, structuredClone(v));
w.GM_xmlhttpRequest = options => { requests.push(options.url); const response = responses.shift(); if (response === 'error') options.onerror(); else options.onload({ status: 200, responseText: JSON.stringify(response) }); };
w.eval(script.replace(/\n  GM_registerMenuCommand[\s\S]*$/, '\n  window.testApi = { render, extract, openComments, closeComments, loadCommentsPage, commentStateByKey, sourceByKey, backupData, validateBackup, applyBackup, groupsFor, openSettings, manageGroups, refreshDue };\n})();'));
const t = w.testApi;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const page = (next, ids, end = false) => ({ code: 0, data: { cursor: { next, is_end: end, all_count: 40 }, replies: ids.map(id => ({ rpid_str: id, member: { uname: '评论者' }, content: { message: `正文 ${id}` } })) } });
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS', name); }
(async () => {
  t.render();
  check('两个安装文件逐字节一致', () => assert.deepEqual(fs.readFileSync('bilibili-office-reader.txt'), fs.readFileSync('bilibili-office-reader.user.js')));
  const source = w.document.querySelector('.bili-dyn-item');
  const key = t.extract(source).key;
  function fixture(markup) {
    const el = w.document.createElement('article');
    el.className = 'bili-dyn-item';
    el.innerHTML = markup;
    return el;
  }
  check('充电标识保留正文，明确解锁提示才隐藏', () => {
    const el = fixture('<span class="charging-label">充电专属</span><p class="bili-rich-text__content">正文提到了充电可见</p>');
    assert.equal(t.extract(el).content, '正文提到了充电可见');
    el.innerHTML += '<div class="paywall">充电后查看</div>';
    assert.equal(t.extract(el).skipReason, 'charging');
  });
  check('正文引用链接不串帖，复用卡片采用新动态 ID', () => {
    const el = fixture('<p class="bili-rich-text__content"><a href="https://www.bilibili.com/opus/999">昨天那条</a></p>');
    assert.equal(t.extract(el).dynamicId, '');
    el.dataset.did = '101'; assert.equal(t.extract(el).key, 'dynamic:101');
    el.dataset.did = '102'; assert.equal(t.extract(el).key, 'dynamic:102');
  });
  check('视频标题只出现一次，不抓取播放量和时长', () => {
    const el = fixture('<div class="bili-dyn-content">00:30 <b class="bili-dyn-card-video__title">视频标题</b> 999</div>');
    assert.equal(t.extract(el).content, '视频标题');
    assert.equal(t.extract(el).mediaTitle, '');
  });
  check('点分组标签进入筛选，空结果可以一键复原', () => {
    w.document.querySelector('.bor-group-tag').click();
    assert.equal(w.document.querySelector('#bor-group-filter').value, 'group:财经');
    const select = w.document.querySelector('#bor-group-filter');
    select.value = 'scope:ungrouped'; select.dispatchEvent(new w.Event('change', { bubbles: true }));
    w.document.querySelector('#bor-clear-filters').click();
    assert.equal(select.value, 'scope:all');
    assert.ok(w.document.querySelector('.bor-comments'));
  });
  check('切回页面按上次成功检查时间判断过期', () => { assert.equal(t.refreshDue(true, 299999), false); assert.equal(t.refreshDue(true, 300000), true); });
  check('刷新控件具有可访问状态', () => { assert.equal(w.document.querySelector('#bor-group-filter').getAttribute('aria-label'), '按 UP 主分组筛选'); assert.equal(w.document.querySelector('#bor-refresh-status').getAttribute('aria-live'), 'polite'); });
  check('旧名称分组在取得 UID 后仍可读', () => assert.equal(t.groupsFor('测试作者', '999')[0], '财经'));
  const native = source.querySelector('.bili-rich-text__action');
  native.onclick = () => { const expanded = native.textContent === '展开'; native.textContent = expanded ? '收起' : '展开'; source.querySelector('.bili-rich-text__content').textContent = expanded ? '长文详情' : '短文'; };
  w.document.querySelector('.bor-expand').click(); t.render();
  check('展开保持身份并显示收起', () => { assert.equal(t.extract(source).key, key); assert.equal(w.document.querySelector('.bor-expand').textContent, '收起全文'); });
  w.document.querySelector('.bor-expand').click(); t.render();
  check('收起回到短文', () => assert.equal(w.document.querySelector('.bor-content').textContent, '短文'));
  responses.push(page(2, ['a','b'])); t.openComments(key); await flush();
  check('首批评论及上下文', () => { assert.equal(w.document.querySelectorAll('.bor-comment-item').length, 2); assert.match(w.document.querySelector('#bor-comment-drawer h2').textContent, /测试作者/); });
  const first = w.document.querySelector('.bor-comment-item');
  responses.push('error'); await t.loadCommentsPage(key);
  check('失败保留节点和游标且只有一个重试入口', () => { assert.equal(w.document.querySelector('.bor-comment-item'), first); assert.equal(t.commentStateByKey.get(key).next, 2); assert.equal(w.document.querySelectorAll('#bor-comment-retry').length, 1); });
  responses.push(page(3, ['b','c'])); w.document.querySelector('#bor-comment-retry').click(); await flush();
  check('重试同页并去重追加', () => { assert.match(requests.at(-1), /next=2/); assert.equal(w.document.querySelectorAll('.bor-comment-item').length, 3); assert.equal(w.document.querySelector('.bor-comment-item'), first); });
  w.document.querySelector('.bor-comment-list').scrollTop = 123;
  t.openComments(key);
  check('再次点击关闭', () => assert.equal(w.document.querySelector('#bor-comment-drawer'), null));
  t.openComments(key);
  check('重开恢复评论位置', () => assert.equal(w.document.querySelector('.bor-comment-list').scrollTop, 123));
  responses.push({ code: 0, data: {} }); await t.loadCommentsPage(key);
  check('畸形响应不能误报为空评论', () => assert.match(t.commentStateByKey.get(key).error, /响应不完整/));
  responses.push(page(3, ['c'])); await t.loadCommentsPage(key);
  check('重复游标不继续翻页', () => assert.match(t.commentStateByKey.get(key).error, /下一批/));
  const original = JSON.parse(JSON.stringify(t.backupData()));
  check('备份往返校验', () => t.validateBackup(JSON.parse(JSON.stringify(original))));
  check('拒绝危险键和损坏配置', () => { const bad = JSON.parse(JSON.stringify(original)); bad.authorGroups = JSON.parse('{"__proto__":[]}'); assert.throws(() => t.validateBackup(bad)); bad.authorGroups = {}; bad.preferences.fontSize = 99; assert.throws(() => t.validateBackup(bad)); });
  const incoming = JSON.parse(JSON.stringify(original)); incoming.groups = ['游戏']; incoming.authorGroups = { 'name:测试作者': ['游戏'] }; incoming.alertGroups = []; incoming.groupFilter = 'all';
  t.applyBackup(incoming, true);
  check('合并保留旧分组', () => assert.deepEqual(Array.from(t.groupsFor('测试作者')), ['财经','游戏']));
  t.applyBackup(incoming);
  check('替换及保存撤销点', () => { assert.deepEqual(Array.from(t.backupData().groups), ['游戏']); assert.ok(storage.get('bilibili-office-reader-before-import')); });
  t.openSettings(); w.document.querySelector('#bor-restore').click();
  check('撤销导入恢复旧配置并消费撤销点', () => { assert.deepEqual(Array.from(t.backupData().groups), ['财经','游戏']); assert.equal(storage.get('bilibili-office-reader-before-import'), ''); });
  t.applyBackup(original);
  t.manageGroups(); const del = w.document.querySelector('.bor-delete-group'); del.click(); del.click(); w.document.querySelector('#bor-save-groups').click();
  check('撤销分组删除', () => assert.equal(t.backupData().groups[0], '财经'));
  t.openSettings(); w.document.querySelector('#bor-font').value = '18'; w.document.querySelector('#bor-save-settings').click();
  check('显示设置保存', () => assert.equal(storage.get('bilibili-office-reader-display').fontSize, 18));
  t.openSettings();
  const controls = [...w.document.querySelectorAll('.bor-modal button, .bor-modal input, .bor-modal select')];
  controls.at(-1).focus(); controls.at(-1).dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  check('模态框键盘焦点循环', () => assert.equal(w.document.activeElement, controls[0]));
  w.document.querySelector('.bor-modal-close').click();
  const refreshControl = w.document.createElement('button');
  refreshControl.className = 'bili-dyn-list__notification';
  refreshControl.textContent = '查看新动态';
  w.document.body.append(refreshControl);
  const clock = new Map();
  let timerId = 0;
  w.setTimeout = (run, delay) => { clock.set(++timerId, { run, delay }); return timerId; };
  w.clearTimeout = id => clock.delete(id);
  function tick(delay) {
    const task = [...clock].find(([, task]) => task.delay === delay);
    assert.ok(task, '等待中的定时器 ' + delay);
    clock.delete(task[0]);
    task[1].run();
  }
  const confirmedKey = 'bilibili-office-reader-last-successful-check';
  w.document.querySelector('#bor-check-now').click();
  w.document.body.append(w.document.createElement('small'));
  await flush();
  tick(6500);
  check('刷新超时或无关页面变化不写成功时间', () => {
    assert.equal(storage.has(confirmedKey), false);
    assert.match(w.document.querySelector('#bor-refresh-status').textContent, /未确认/);
    assert.equal(t.refreshDue(true), false);
  });
  refreshControl.onclick = () => {
    source.before(fixture('<div class="bili-rich-text__content">新动态</div>'));
    source.after(fixture('<div class="bili-rich-text__content">历史动态</div>'));
  };
  w.document.querySelector('#bor-check-now').click();
  await flush();
  tick(250);
  check('刷新确认首条变化，只计算顶部新增并清理超时', () => {
    assert.ok(storage.get(confirmedKey));
    assert.match(w.document.querySelector('#bor-toast').textContent, /1 条新动态/);
    assert.equal([...clock.values()].some(task => task.delay === 6500), false);
  });
  console.log(`${passed} tests passed`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => w.close());
