/* ============================================================================
 * 平台层：Toy SDK 接入（排行榜 / 云存档 / 用户 / 分享）
 *         + 体力值（每日限制 / 每分钟恢复 / 分享奖励 / 后台校验）
 *         + 老板键
 * 说明：非 Toy 环境（本地双击、开发）自动降级为 localStorage 单机模式。
 * ========================================================================== */
(function () {
  'use strict';

  var CFG = {
    SDK_SRC: 'https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js',
    STAM_MAX: 5,
    STAM_REGEN_MS: 60000,        // 1 点 / 分钟
    DAILY_PLAY_LIMIT: 20,        // 每日最多开局次数
    SHARE_DAILY_MAX: 3,          // 每日分享奖励上限
    SHARE_MIN_INTERVAL_MS: 15000,
    SHARE_CONFIRM_MS: 5000,      // 分享后需等待的"有效确认"时间
    SUBMIT_MIN_INTERVAL_MS: 4000,
    KV: { best: 'qc_best', set: 'qc_set', stat: 'qc_stat', stam: 'qc_stam', share: 'qc_share' },
    LS: 'qc_platform_v2'
  };

  /* 排行榜按「模式」分榜：平台最多 5 个榜，音乐×模式×难度无法同时分。
     节奏=1 / 太鼓=2 / 九宫格=3（预留）/ 连线=4（预留）/ 5 备用
     难度不再单独占榜，难度最佳分只记本机（见主逻辑的 store）。 */
  var MODE_BOARD = { classic: 1, taiko: 2, grid9: 3, chain: 4 };
  var MODE_CN = { classic: '节奏', taiko: '太鼓', grid9: '九宫格', chain: '连线' };
  var MODE_SOON = { grid9: true, chain: true };
  var BOARD = MODE_BOARD;
  var DIFF_CN = { easy: '轻松', normal: '心动', hard: '青春' };

  var P = window.PLAT = {
    ready: false, inToy: false, sdk: null, user: null,
    cloudOk: false, cloudTried: false,
    best: { easy: 0, normal: 0, hard: 0 },
    set: { offset: 0, speed: 1, vol: 0.8 },
    stat: { plays: 0, clear: 0, fullCombo: 0, maxScore: 0, playSec: 0 },
    stam: { v: CFG.STAM_MAX, ts: Date.now(), day: '', plays: 0, shares: 0 },
    share: { last: 0, day: '', n: 0 },
    lastSubmit: 0, pendingShare: null, muted: false, volBeforeMute: 0.8
  };

  /* ---------------------------------------------------------------- 工具 */
  function $(s) { return document.querySelector(s); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function todayKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtNum(n) { return Math.round(n).toLocaleString('en-US'); }
  function fmtCd(ms) {
    ms = Math.max(0, ms);
    var s = Math.ceil(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function toast(msg, kind) {
    var box = $('#toast');
    if (!box) return;
    var t = el('div', 't-item ' + (kind || ''), msg);
    box.appendChild(t);
    box.classList.add('on');
    setTimeout(function () {
      t.style.opacity = '0'; t.style.transform = 'translateY(-6px)';
      setTimeout(function () { t.remove(); if (!box.children.length) box.classList.remove('on'); }, 260);
    }, 2200);
  }

  /* ------------------------------------------------------------- 本地镜像 */
  function lsRead() {
    try { return JSON.parse(localStorage.getItem(CFG.LS) || '{}') || {}; } catch (e) { return {}; }
  }
  function lsWrite() {
    try {
      localStorage.setItem(CFG.LS, JSON.stringify({
        best: P.best, set: P.set, stat: P.stat, stam: P.stam, share: P.share
      }));
    } catch (e) {}
  }

  /* ------------------------------------------------------------- SDK 接入 */
  /* 所有 SDK 调用都必须带超时：非宿主环境里部分能力返回的 Promise 永不 settle */
  function TO(p, ms, tag) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return; done = true;
        reject(new Error((tag || 'sdk') + ' 超时'));
      }, ms || 3000);
      Promise.resolve(p).then(function (v) {
        if (done) return; done = true; clearTimeout(t); resolve(v);
      }, function (e) {
        if (done) return; done = true; clearTimeout(t); reject(e);
      });
    });
  }

  function loadSdkScript() {
    if (window.toy) return Promise.resolve(window.toy);
    return new Promise(function (resolve, reject) {
      var fin = false;
      function ok() { if (fin) return; fin = true; window.toy ? resolve(window.toy) : reject(new Error('toy 未挂载')); }
      function bad() { if (fin) return; fin = true; reject(new Error('SDK 加载失败')); }
      var s = document.createElement('script');
      s.src = CFG.SDK_SRC;
      s.async = true;
      s.onload = ok;
      s.onerror = bad;
      document.head.appendChild(s);
      setTimeout(ok, 5000);
      setTimeout(function () { if (!fin) bad(); }, 9000);
    });
  }

  async function cloudGet(keys) {
    if (!P.sdk) return {};
    try {
      var r = await TO(P.sdk.getCloudStorage(keys), 3000, 'getCloudStorage');
      P.cloudOk = true; P.cloudTried = true;
      return r || {};
    } catch (e) {
      P.cloudOk = false; P.cloudTried = true;
      console.warn('[toy] getCloudStorage 不可用：', e && e.message);
      return {};
    }
  }
  async function cloudSet(obj) {
    if (!P.sdk) return false;
    try { await TO(P.sdk.setCloudStorage(obj), 3000, 'setCloudStorage'); P.cloudOk = true; return true; }
    catch (e) { P.cloudOk = false; console.warn('[toy] setCloudStorage 不可用：', e && e.message); return false; }
  }

  /* ================================================================ 体力 */
  function normalizeStam(raw) {
    var s = Object.assign({}, P.stam, raw || {});
    var now = Date.now();
    s.v = clamp(Math.floor(Number(s.v) || 0), 0, CFG.STAM_MAX);
    s.ts = Number(s.ts) || now;
    var day = todayKey();
    if (s.day !== day) { s.day = day; s.plays = 0; s.shares = 0; }
    if (s.v < CFG.STAM_MAX) {
      var gain = Math.floor((now - s.ts) / CFG.STAM_REGEN_MS);
      if (gain > 0) {
        s.v = Math.min(CFG.STAM_MAX, s.v + gain);
        s.ts = s.ts + gain * CFG.STAM_REGEN_MS;
        if (s.v >= CFG.STAM_MAX) s.ts = now;
      }
    } else {
      s.ts = now;
    }
    if (s.ts > now) s.ts = now;
    return s;
  }
  function nextStamIn() {
    if (P.stam.v >= CFG.STAM_MAX) return 0;
    return Math.max(0, P.stam.ts + CFG.STAM_REGEN_MS - Date.now());
  }
  function tickStam() {
    var before = P.stam.v;
    P.stam = normalizeStam(P.stam);
    if (P.stam.v !== before) { lsWrite(); saveCloud(['stam']); }
    renderStam();
  }

  function renderStam() {
    var pill = $('#staminaPill');
    if (!pill) return;
    var v = P.stam.v, cd = nextStamIn();
    pill.classList.toggle('empty', v <= 0);
    pill.innerHTML = '<span class="bolt">⚡</span>'
      + '<span class="num">' + v + '<i>/' + CFG.STAM_MAX + '</i></span>'
      + '<span class="cd">' + (v >= CFG.STAM_MAX ? '已满' : '+' + fmtCd(cd)) + '</span>';
    pill.title = '今日已玩 ' + P.stam.plays + '/' + CFG.DAILY_PLAY_LIMIT + ' 次 · 点击查看';
  }

  /* ============================================================== 云存档 */
  var saveTimer = null, dirty = {};
  function saveCloud(keys) {
    (keys || Object.keys(CFG.KV)).forEach(function (k) { dirty[k] = true; });
    lsWrite();
    if (!P.sdk) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { flushCloud(); }, 900);
  }
  async function flushCloud() {
    if (!P.sdk) return;
    var payload = {};
    if (dirty.best) payload[CFG.KV.best] = JSON.stringify(P.best);
    if (dirty.set) payload[CFG.KV.set] = JSON.stringify(P.set);
    if (dirty.stat) payload[CFG.KV.stat] = JSON.stringify(P.stat);
    if (dirty.stam) payload[CFG.KV.stam] = JSON.stringify({ v: P.stam.v, ts: P.stam.ts, day: P.stam.day, plays: P.stam.plays, shares: P.stam.shares });
    if (dirty.share) payload[CFG.KV.share] = JSON.stringify({ last: P.share.last, day: P.share.day, n: P.share.n });
    dirty = {};
    if (!Object.keys(payload).length) return;
    await cloudSet(payload);
  }

  async function loadSave() {
    var local = lsRead();
    P.best = Object.assign({ easy: 0, normal: 0, hard: 0 }, local.best || {});
    P.set = Object.assign({ offset: 0, speed: 1, vol: 0.8 }, local.set || {});
    P.stat = Object.assign(P.stat, local.stat || {});
    P.share = Object.assign(P.share, local.share || {});
    P.stam = normalizeStam(local.stam);

    if (!P.sdk) return;
    var r = await cloudGet(Object.values(CFG.KV));
    function j(k) { try { return r[k] ? JSON.parse(r[k]) : null; } catch (e) { return null; } }
    var cBest = j(CFG.KV.best), cSet = j(CFG.KV.set), cStat = j(CFG.KV.stat), cStam = j(CFG.KV.stam), cShare = j(CFG.KV.share);
    if (cBest) {
      ['easy', 'normal', 'hard'].forEach(function (d) {
        var v = Number(cBest[d]) || 0;
        if (v > P.best[d]) P.best[d] = v;
      });
    }
    if (cSet) P.set = Object.assign(P.set, cSet);
    if (cStat) {
      ['plays', 'clear', 'fullCombo', 'maxScore', 'playSec'].forEach(function (k) {
        P.stat[k] = Math.max(Number(P.stat[k]) || 0, Number(cStat[k]) || 0);
      });
    }
    if (cShare) P.share = Object.assign(P.share, cShare);
    if (cStam) {
      // 云端为准，但取更有利的一份（防止设备间时间回拨）
      var cs = normalizeStam(cStam);
      P.stam = (cs.v >= P.stam.v) ? cs : P.stam;
      P.stam.plays = Math.max(cs.plays || 0, P.stam.plays || 0);
    }
    lsWrite();
  }

  /* ============================================================ 老板键 */
  function buildBossScreen() {
    if ($('#bossKey')) return;
    var rows = [
      ['10月营销中心工作排期表', '', '', '', '', '', ''],
      ['序号', '事项', '负责人', '开始日期', '截止日期', '进度', '备注'],
      [1, '国庆活动复盘材料', '王×', '2026/10/08', '2026/10/11', '100%', '已归档'],
      [2, 'Q4 渠道费用预算表', '李×', '2026/10/09', '2026/10/15', '85%', '待财务复核'],
      [3, '银行联动方案（第二批）', '张×', '2026/10/12', '2026/10/20', '60%', '对接中'],
      [4, '门店物料更新清单', '陈×', '2026/10/13', '2026/10/18', '90%', ''],
      [5, '竞对投放监测周报', '刘×', '2026/10/14', '2026/10/21', '70%', '每周五出'],
      [6, '中秋礼品供应商比价', '赵×', '2026/10/15', '2026/10/22', '45%', '三家报价'],
      [7, '小区拓客排班表', '周×', '2026/10/16', '2026/10/23', '55%', ''],
      [8, '样板间开放日统筹', '吴×', '2026/10/17', '2026/10/25', '30%', '待定场地'],
      [9, '客户到访数据核对', '郑×', '2026/10/19', '2026/10/24', '80%', ''],
      [10, '月度总结 PPT', '王×', '2026/10/26', '2026/10/31', '10%', '框架已搭'],
      ['', '', '', '', '', '', ''],
      ['合计', '', '', '', '', '615%', ''],
      ['', '', '', '', '', '', ''],
      ['制表：营销中心  ', '更新：2026/10/27', '', '', '', '', '']
    ];
    var html = ''
      + '<div class="bk-bar"><span class="doc">10月营销中心工作排期表.xlsx</span>'
      + '<span class="menu"><span>文件</span><span>开始</span><span>插入</span><span>页面布局</span><span>公式</span><span>数据</span><span>审阅</span><span>视图</span></span></div>'
      + '<div class="bk-ribbon">'
      + '<div class="grp"><b></b><b></b><b></b><span>剪贴板</span></div>'
      + '<div class="grp"><b></b><b></b><span>字体</span></div>'
      + '<div class="grp"><b></b><b></b><b></b><span>对齐</span></div>'
      + '<div class="grp"><b></b><b></b><span>数字</span></div>'
      + '<div class="grp"><b></b><span>条件格式</span></div>'
      + '<div class="grp"><b></b><span>排序和筛选</span></div>'
      + '<div class="grp"><span>插入</span></div>'
      + '</div>'
      + '<div class="bk-formula"><span class="cellref">C7</span><span>fx</span><span>＝D7－E7</span></div>'
      + '<div class="bk-grid"><table><thead><tr><th class="rowno"></th>'
      + ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(function (c) { return '<th>' + c + '</th>'; }).join('')
      + '</tr></thead><tbody>'
      + rows.map(function (r, i) {
        return '<tr><th class="rowno">' + (i + 1) + '</th>' + r.map(function (c, j) {
          return '<td class="' + (j === 5 && String(c).indexOf('%') > -1 ? 'hl' : '') + '">' + (c === '' ? '' : c) + '</td>';
        }).join('') + '</tr>';
      }).join('')
      + '</tbody></table></div>'
      + '<div class="bk-tabs"><span class="tab">排期表</span><span class="tab">费用预算</span><span class="tab">监测数据</span><span class="add">＋</span></div>'
      + '<div class="bk-hint">Alt + X 返回 · 手机三指点按返回</div>';
    var d = el('div', '', html);
    d.id = 'bossKey';
    d.addEventListener('click', function (e) {
      if (e.target.closest('.bk-hint')) bossHide();
    });
    document.body.appendChild(d);
  }

  function bossShow() {
    buildBossScreen();
    P.muted = true;
    P.volBeforeMute = (typeof S !== 'undefined' && S.vol) || 0.8;
    try { if (typeof pause === 'function' && S.screen === 'game' && !S.paused) pause(); } catch (e) {}
    try { if (typeof setVolume === 'function') setVolume(0); } catch (e) {}
    document.body.classList.remove('fever');
    $('#bossKey').classList.add('on');
  }
  function bossHide() {
    var bk = $('#bossKey');
    if (!bk) return;
    bk.classList.remove('on');
    P.muted = false;
    try { if (typeof setVolume === 'function') setVolume(P.volBeforeMute); } catch (e) {}
  }
  function bossToggle() {
    var bk = $('#bossKey');
    if (bk && bk.classList.contains('on')) bossHide(); else bossShow();
  }

  /* ============================================================ 排行榜 */
  var rankState = { mode: 'classic', diff: 'normal', period: 'all', loading: false, items: [], mine: null, err: null };

  function buildRankOverlay() {
    if ($('#rankOverlay')) return;
    var ov = el('div', 'overlay', '');
    ov.id = 'rankOverlay';
    ov.innerHTML = ''
      + '<div class="panel glass sheet">'
      + '<div class="sheet-head">'
      + '<div class="sheet-title">排行榜<small>RANKING · 历史最高分</small></div>'
      + '<button class="sheet-close" data-close="rankOverlay">✕</button>'
      + '</div>'
      + '<div class="tabs" id="rankModeTabs">'
      + Object.keys(MODE_BOARD).map(function (m) {
        var soon = MODE_SOON[m] ? ' · 待上线' : '';
        return '<button data-mode="' + m + '" class="' + (m === rankState.mode ? 'on' : '') + '">' + MODE_CN[m] + soon + '</button>';
      }).join('')
      + '</div>'
      + '<div class="tabs small" id="rankPeriodTabs">'
      + [['all', '总榜'], ['day', '日榜'], ['week', '周榜'], ['month', '月榜']].map(function (p) {
        return '<button data-period="' + p[0] + '" class="' + (p[0] === rankState.period ? 'on' : '') + '">' + p[1] + '</button>';
      }).join('')
      + '</div>'
      + '<div class="rank-list" id="rankList"><div class="rank-empty">载入中…</div></div>'
      + '<div class="rank-foot"><span id="rankMine">—</span><span id="rankNote"></span></div>'
      + '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) {
      if (e.target === ov || e.target.dataset.close) closeOverlay('rankOverlay');
    });
    $('#rankModeTabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-mode]'); if (!b) return;
      rankState.mode = b.dataset.mode;
      [].forEach.call(this.children, function (c) { c.classList.toggle('on', c === b); });
      loadRank();
    });
    $('#rankPeriodTabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-period]'); if (!b) return;
      rankState.period = b.dataset.period;
      [].forEach.call(this.children, function (c) { c.classList.toggle('on', c === b); });
      loadRank();
    });
  }

  function openOverlay(id) {
    var ov = $('#' + id);
    if (ov) ov.classList.add('on');
  }
  function closeOverlay(id) {
    var ov = $('#' + id);
    if (ov) ov.classList.remove('on');
  }

  function renderLocalRank(note) {
    var list = $('#rankList');
    if (!list) return;
    // 榜单按模式分，所以本机展示取各难度里的最高分
    var mine = Math.max(P.best.easy || 0, P.best.normal || 0, P.best.hard || 0);
    list.innerHTML = mine > 0
      ? '<div class="rank-row me"><div class="r">1</div>'
        + '<div style="width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#ffd166,#ff9ec7);flex:0 0 auto"></div>'
        + '<div class="nm">本机玩家</div><div class="sc">' + fmtNum(mine) + '</div></div>'
        + '<div class="rank-empty">' + (note || '当前未连接到 B站 Toy，排行榜仅显示本机成绩。<br/>上传到 Toy 后自动切换为全服榜单。') + '</div>'
      : '<div class="rank-empty">' + (note || '当前未连接到 B站 Toy。<br/>上传到 Toy 后即可看到全服排行。') + '</div>';
    $('#rankMine').innerHTML = '我的最高分 <b>' + fmtNum(mine) + '</b>';
    $('#rankNote').textContent = '本机存档';
  }

  async function loadRank() {
    var list = $('#rankList');
    if (!list) return;
    rankState.loading = true;
    list.innerHTML = '<div class="rank-empty">载入中…</div>';
    var board = MODE_BOARD[rankState.mode] || 1;

    /* 没有宿主身份就不要去打扰云端，直接展示本机成绩 */
    if (!P.sdk || !P.user) {
      renderLocalRank();
      rankState.loading = false;
      return;
    }

    try {
      var items = await TO(P.sdk.getRankList({ board: board, period: rankState.period, limit: 50 }), 5000, 'getRankList');
      var mineRank = await TO(P.sdk.getMyRank({ board: board, period: rankState.period }), 4000, 'getMyRank').catch(function () { return null; });
      rankState.items = items || [];
      rankState.mine = mineRank;
      renderRank();
    } catch (e) {
      renderLocalRank('排行榜暂时读不到（' + (e && e.message ? e.message : '未知错误') + '）<br/>先看本机成绩。');
    }
    rankState.loading = false;
  }

  function renderRank() {
    var list = $('#rankList');
    if (!list) return;
    var items = rankState.items || [];
    if (!items.length) {
      list.innerHTML = '<div class="rank-empty">还没有人上榜<br/>打一局，抢第一个名次</div>';
    } else {
      list.innerHTML = items.map(function (it, i) {
        var me = rankState.mine && rankState.mine.ranked && rankState.mine.rank === it.rank;
        return '<div class="rank-row' + (me ? ' me' : '') + '">'
          + '<div class="r">' + (it.rank || i + 1) + '</div>'
          + '<img src="' + (it.avatar || '') + '" alt="" onerror="this.style.visibility=\'hidden\'">'
          + '<div class="nm">' + (it.nickname || '玩家') + '</div>'
          + '<div class="sc">' + fmtNum(it.score || 0) + '</div>'
          + '</div>';
      }).join('');
    }
    var m = rankState.mine;
    if (m && m.ranked) {
      $('#rankMine').innerHTML = '我的排名 <b>#' + m.rank + '</b> · <b>' + fmtNum(m.score) + '</b>';
    } else if (m) {
      $('#rankMine').innerHTML = '我的最高分 <b>' + fmtNum(m.score || 0) + '</b> · 未上榜';
    } else {
      $('#rankMine').textContent = '—';
    }
    $('#rankNote').textContent = 'Toy 云端 · ' + MODE_CN[rankState.mode];
  }

  /* ============================================================ 分享 */
  function buildShareOverlay() {
    if ($('#shareOverlay')) return;
    var ov = el('div', 'overlay', '');
    ov.id = 'shareOverlay';
    ov.innerHTML = ''
      + '<div class="panel glass sheet">'
      + '<div class="sheet-head">'
      + '<div class="sheet-title">分享得体力<small>SHARE · 每日最多 ' + CFG.SHARE_DAILY_MAX + ' 次</small></div>'
      + '<button class="sheet-close" data-close="shareOverlay">✕</button>'
      + '</div>'
      + '<div class="share-body">'
      + '<div class="qr-wrap" id="qrWrap"><div class="ph">二维码<br/>生成中…</div></div>'
      + '<div class="share-txt">'
      + '<div id="shareStatus">把游戏分享给朋友，回来自动 +1 体力。</div>'
      + '<span class="tip">奖励进入 B站云端账户，换设备也能同步；<br/>同一天最多领 ' + CFG.SHARE_DAILY_MAX + ' 次，每次间隔不少于 15 秒。</span>'
      + '<div class="link-box"><input id="shareLink" readonly value=""><button class="btn ghost" id="copyLink" style="padding:9px 14px;font-size:12px">复制</button></div>'
      + '</div></div>'
      + '<div class="panel-actions" style="margin-top:16px">'
      + '<button class="btn" id="doShare">分享给好友</button>'
      + '<button class="btn ghost" id="qrSave">保存二维码</button>'
      + '</div>'
      + '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) {
      if (e.target === ov || e.target.dataset.close) closeOverlay('shareOverlay');
    });
    $('#copyLink').addEventListener('click', async function () {
      var v = $('#shareLink').value;
      try { await navigator.clipboard.writeText(v); toast('链接已复制', 'ok'); }
      catch (e) { $('#shareLink').select(); document.execCommand && document.execCommand('copy'); toast('链接已复制', 'ok'); }
    });
    $('#doShare').addEventListener('click', doShare);
    $('#qrSave').addEventListener('click', function () {
      var img = $('#qrWrap img');
      if (!img) { toast('二维码还没生成', 'err'); return; }
      var a = document.createElement('a');
      a.href = img.src; a.download = '青葱岁月_音游.png'; a.click();
      toast('已保存', 'ok');
    });
  }

  async function openShare() {
    buildShareOverlay();
    openOverlay('shareOverlay');
    var link = location.href.split('#')[0];
    $('#shareLink').value = link;
    var left = Math.max(0, CFG.SHARE_DAILY_MAX - (P.share.day === todayKey() ? P.share.n : 0));
    $('#shareStatus').innerHTML = '今日还可领取 <b>' + left + '</b> 次体力';
    if (P.sdk && P.sdk.getQrCode) {
      try {
        var qr = await TO(P.sdk.getQrCode({ path: 'index.html', size: 320 }), 5000, 'getQrCode');
        if (qr && qr.base64) {
          $('#qrWrap').innerHTML = '<img src="' + qr.base64 + '" alt="二维码">';
          if (qr.url) $('#shareLink').value = qr.url;
        }
      } catch (e) {
        $('#qrWrap').innerHTML = '<div class="ph">当前环境<br/>不支持二维码</div>';
      }
    } else {
      $('#qrWrap').innerHTML = '<div class="ph">Toy 环境内<br/>自动生成二维码</div>';
    }
  }

  async function doShare() {
    if (!P.sdk || !P.sdk.share) { toast('当前环境不支持拉起分享，请复制链接', 'err'); return; }
    var support = true;
    try { support = await TO(P.sdk.isSupport('share'), 2500, 'isSupport'); } catch (e) {}
    if (!support) { toast('当前环境不支持拉起分享，请复制链接', 'err'); return; }
    try {
      await TO(P.sdk.share({ path: 'index.html?from=share' }), 30000, 'share');
      beginShareConfirm();
    } catch (e) {
      toast('分享未完成：' + (e && e.message ? e.message : '未知错误'), 'err');
    }
  }

  /* 分享后的"后台有效确认"：
     - 必须真实回到页面（visibilitychange: hidden -> visible）
     - 距分享时间 >= SHARE_CONFIRM_MS
     - 云端时间戳去重 + 每日上限
  */
  function beginShareConfirm() {
    P.pendingShare = { at: Date.now(), returned: false };
    toast('分享已提交，回到本页后自动发放体力', 'ok');
    $('#shareStatus').innerHTML = '等待确认… 返回本页面即可领取';
    setTimeout(function () {
      if (!P.pendingShare) return;
      $('#shareStatus').innerHTML = '确认中… 请回到本页面';
    }, 800);
  }

  async function settleShare() {
    var ps = P.pendingShare;
    if (!ps) return;
    if (Date.now() - ps.at < CFG.SHARE_CONFIRM_MS) return;
    // 云端去重
    var day = todayKey();
    if (P.share.day !== day) { P.share.day = day; P.share.n = 0; }
    if (P.share.n >= CFG.SHARE_DAILY_MAX) { P.pendingShare = null; toast('今日分享奖励已领完', 'err'); return; }
    if (Date.now() - (P.share.last || 0) < CFG.SHARE_MIN_INTERVAL_MS) return;

    var cloud = await cloudGet([CFG.KV.share]);
    var remote = null;
    try { remote = cloud[CFG.KV.share] ? JSON.parse(cloud[CFG.KV.share]) : null; } catch (e) {}
    if (remote && remote.day === day) {
      if ((remote.n || 0) >= CFG.SHARE_DAILY_MAX) { P.pendingShare = null; toast('今日分享奖励已领完', 'err'); return; }
      P.share.n = Math.max(P.share.n, remote.n || 0);
      if ((P.share.last || 0) < (remote.last || 0)) P.share.last = remote.last;
    }
    if (Date.now() - (P.share.last || 0) < CFG.SHARE_MIN_INTERVAL_MS) return;

    P.pendingShare = null;
    P.share.last = Date.now();
    P.share.n += 1;
    P.stam = normalizeStam(P.stam);
    if (P.stam.v >= CFG.STAM_MAX) {
      toast('体力已满，奖励未领取', 'err');
    } else {
      P.stam.v = Math.min(CFG.STAM_MAX, P.stam.v + 1);
      toast('分享成功，体力 +1', 'ok');
    }
    P.stam.shares = (P.stam.shares || 0) + 1;
    lsWrite();
    saveCloud(['stam', 'share']);
    renderStam();
    var st = $('#shareStatus');
    if (st) st.innerHTML = '已领取 · 剩余次数 <b>' + Math.max(0, CFG.SHARE_DAILY_MAX - P.share.n) + '</b>';
  }

  /* ============================================================ 体力弹层 */
  function buildStamOverlay() {
    if ($('#stamOverlay')) return;
    var ov = el('div', 'overlay', '');
    ov.id = 'stamOverlay';
    ov.innerHTML = ''
      + '<div class="panel glass sheet" style="max-width:460px">'
      + '<div class="sheet-head"><div class="sheet-title">体力<small>STAMINA</small></div>'
      + '<button class="sheet-close" data-close="stamOverlay">✕</button></div>'
      + '<div class="stam-body">'
      + '<div class="stam-big" id="stamBig">5<small>/5</small></div>'
      + '<div class="stam-desc" id="stamDesc"></div>'
      + '<div class="stam-row">'
      + '<button class="btn" id="stamShare">分享 +1</button>'
      + '<button class="btn ghost" id="stamRank">看排行榜</button>'
      + '</div></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) {
      if (e.target === ov || e.target.dataset.close) closeOverlay('stamOverlay');
    });
    $('#stamShare').addEventListener('click', function () { closeOverlay('stamOverlay'); openShare(); });
    $('#stamRank').addEventListener('click', function () { closeOverlay('stamOverlay'); openOverlay('rankOverlay'); loadRank(); });
  }

  function openStam() {
    buildStamOverlay();
    openOverlay('stamOverlay');
    refreshStamModal();
  }
  function refreshStamModal() {
    if (!$('#stamBig')) return;
    var v = P.stam.v, cd = nextStamIn();
    $('#stamBig').innerHTML = v + '<small>/' + CFG.STAM_MAX + '</small>';
    var left = Math.max(0, CFG.DAILY_PLAY_LIMIT - (P.stam.plays || 0));
    var lines = [];
    lines.push(v > 0 ? ('当前 <b>' + v + '</b> 点，每局消耗 1 点') : ('体力用完了，<b>' + fmtCd(cd) + '</b> 后恢复 1 点'));
    lines.push('每 <b>1 分钟</b> 恢复 1 点，上限 <b>' + CFG.STAM_MAX + '</b> 点');
    lines.push('今日剩余开局次数 <b>' + left + '/' + CFG.DAILY_PLAY_LIMIT + '</b>');
    lines.push('分享给好友可 <b>+1</b>，每日最多 ' + CFG.SHARE_DAILY_MAX + ' 次');
    $('#stamDesc').innerHTML = lines.join('<br/>');
    $('#stamShare').style.display = v >= CFG.STAM_MAX ? 'none' : '';
  }

  /* ============================================================ 开局校验 */
  function beforeStart() {
    if (typeof S === 'undefined') return true;
    var day = todayKey();
    P.stam = normalizeStam(P.stam);
    if (P.stam.plays >= CFG.DAILY_PLAY_LIMIT) {
      toast('今日已游玩 ' + CFG.DAILY_PLAY_LIMIT + ' 局，明天再来', 'err');
      openStam();
      return false;
    }
    if (P.stam.v <= 0) {
      toast('体力不足', 'err');
      openStam();
      return false;
    }
    P.stam.v -= 1;
    P.stam.plays += 1;
    if (P.stam.v === CFG.STAM_MAX - 1) P.stam.ts = Date.now();
    lsWrite(); saveCloud(['stam']);
    renderStam();
    return true;
  }

  /* ============================================================ 结算处理 */
  function validateRun(run) {
    var total = run.judge.PERFECT + run.judge.GREAT + run.judge.GOOD + run.judge.MISS;
    if (total !== run.notes) return '判定数不匹配';
    if (total <= 0) return '无有效判定';
    if (run.acc > 100.001 || run.acc < 0) return '准确率异常';
    var cap = run.notes * 1000 * 1.5 * 1.4 + 1000;
    if (run.score > cap) return '分数超出理论上限';
    if (run.score < 0) return '分数异常';
    if (run.dur > 5 && run.dur < (SONG.meta.duration * 0.85) && run.judge.MISS < run.notes * 0.6) return '时长与判定不符';
    return null;
  }

  async function onRunEnd(run) {
    var err = validateRun(run);

    /* 成绩不可信就不入库，避免污染存档和排行榜 */
    if (err) {
      console.warn('[submit] 成绩未通过校验：' + err);
      toast('成绩未记录：' + err, 'err');
      return;
    }

    // 本地存档
    P.stat.plays = (P.stat.plays || 0) + 1;
    if (run.acc >= 80) P.stat.clear = (P.stat.clear || 0) + 1;
    if (run.judge.MISS === 0) P.stat.fullCombo = (P.stat.fullCombo || 0) + 1;
    P.stat.maxScore = Math.max(P.stat.maxScore || 0, run.score);
    P.stat.playSec = (P.stat.playSec || 0) + Math.round(run.dur);
    if (run.score > (P.best[run.diff] || 0)) P.best[run.diff] = run.score;
    lsWrite(); saveCloud(['stat', 'best']);

    // 排行榜提交
    if (!P.sdk) return;
    if (Date.now() - P.lastSubmit < CFG.SUBMIT_MIN_INTERVAL_MS) {
      console.warn('[submit] 提交过于频繁，已跳过本次上传');
      return;
    }
    try {
      P.lastSubmit = Date.now();
      var r = await TO(P.sdk.submitScore({ board: MODE_BOARD[run.mode] || 1, score: Math.round(run.score) }), 6000, 'submitScore');
      if (r && typeof r.score === 'number' && r.score > (P.best[run.diff] || 0)) {
        P.best[run.diff] = r.score;
        saveCloud(['best']);
      }
      var m = await TO(P.sdk.getMyRank({ board: MODE_BOARD[run.mode] || 1, period: 'all' }), 4000, 'getMyRank').catch(function () { return null; });
      if (m && m.ranked) {
        var tag = $('#resRankTag');
        if (tag) tag.innerHTML = '全服第 <b>' + m.rank + '</b> 名';
        toast('已上榜 · 全服第 ' + m.rank + ' 名', 'ok');
      } else {
        toast('成绩已提交', 'ok');
      }
    } catch (e) {
      toast('排行榜提交失败：' + (e && e.message ? e.message : '未知错误'), 'err');
    }
  }

  /* ============================================================ UI 注入 */
  function injectTitleUi() {
    var actions = $('.title-actions');
    if (actions && !$('#staminaPill')) {
      var pill = el('div', 'stamina');
      pill.id = 'staminaPill';
      pill.onclick = openStam;
      actions.insertBefore(pill, actions.firstChild);

      /* 排行榜 / 分享单独成行，避免挤压「开始游戏」那一行 */
      var row = el('div', 'plat-row', '');
      var rankBtn = el('button', 'btn ghost', '排行榜');
      rankBtn.id = 'rankBtn';
      rankBtn.onclick = function () { openOverlay('rankOverlay'); loadRank(); };
      var shareBtn = el('button', 'btn ghost', '分享得体力');
      shareBtn.id = 'shareBtn';
      shareBtn.onclick = openShare;
      row.appendChild(rankBtn);
      row.appendChild(shareBtn);
      actions.parentNode.insertBefore(row, actions.nextSibling);
    }

    var foot = $('.title-foot');
    if (foot && !$('.who')) {
      var wrap = el('div', 'who-wrap', '');
      wrap.appendChild(el('div', 'who off', ''));
      foot.parentNode.insertBefore(wrap, foot);
    }
    refreshWho();
    renderStam();
  }

  function refreshWho() {
    var who = $('.who');
    if (!who) return;
    var online = P.inToy && P.user;
    who.className = 'who ' + (online ? 'on' : 'off');
    if (online) {
      who.innerHTML = '<img src="' + (P.user.avatar || '') + '" alt="">'
        + '<span class="dot"></span><span class="nm">' + (P.user.nickname || '玩家') + '</span>';
    } else if (P.inToy) {
      who.innerHTML = '<span class="dot"></span><span class="nm">平台已连接 · 账号信息未读取</span>';
    } else {
      who.innerHTML = '<span class="dot"></span><span class="nm">单机模式 · 存档保存在本机</span>';
    }
  }

  function injectResultUi() {
    var song = $('#resSong');
    if (song && !$('#resRankTag')) {
      var tag = el('div', '');
      tag.id = 'resRankTag';
      tag.style.cssText = 'font-size:11px;letter-spacing:.14em;color:#ffd166;margin-top:6px;';
      tag.textContent = '成绩提交中…';
      song.parentNode.insertBefore(tag, song.nextSibling);
    }
  }

  /* ============================================================ 设置同步 */
  function applySettingsToGame() {
    if (typeof S === 'undefined') return;
    S.offset = P.set.offset || 0;
    S.speed = P.set.speed || 1;
    S.vol = P.set.vol == null ? 0.8 : P.set.vol;
    var o = $('#offRange'), o2 = $('#offRange2'), sp = $('#spdRange'), vo = $('#volRange');
    if (o) { o.value = S.offset; $('#offVal').textContent = S.offset + ' ms'; }
    if (o2) { o2.value = S.offset; $('#offVal2').textContent = S.offset + ' ms'; }
    if (sp) { sp.value = S.speed; $('#spdVal').textContent = (+S.speed).toFixed(2).replace(/0$/, '') + '×'; }
    if (vo) { vo.value = Math.round(S.vol * 100); $('#volVal').textContent = Math.round(S.vol * 100) + '%'; }
    try { if (typeof setVolume === 'function') setVolume(S.vol); } catch (e) {}
  }

  function bindSettingPersist() {
    ['offRange', 'spdRange', 'volRange'].forEach(function (id) {
      var n = $('#' + id);
      if (n) n.addEventListener('change', function () {
        P.set.offset = typeof S !== 'undefined' ? S.offset : P.set.offset;
        P.set.speed = typeof S !== 'undefined' ? S.speed : P.set.speed;
        P.set.vol = typeof S !== 'undefined' ? S.vol : P.set.vol;
        lsWrite(); saveCloud(['set']);
      });
      if (n) n.addEventListener('input', function () {
        P.set.offset = typeof S !== 'undefined' ? S.offset : P.set.offset;
        P.set.speed = typeof S !== 'undefined' ? S.speed : P.set.speed;
        P.set.vol = typeof S !== 'undefined' ? S.vol : P.set.vol;
        lsWrite();
      });
    });
    var sc = $('#settingClose');
    if (sc) sc.addEventListener('click', function () { saveCloud(['set']); });
  }

  /* ============================================================ 快捷键 */
  document.addEventListener('keydown', function (e) {
    if (e.altKey && (e.code === 'KeyX' || e.key === 'x' || e.key === 'X')) {
      e.preventDefault(); bossToggle(); return;
    }
    if (e.code === 'Backquote') { e.preventDefault(); bossToggle(); }
  });
  /* 手机没有 Alt 键：三指同时按住 500ms 切换老板键 */
  var t3 = null;
  document.addEventListener('touchstart', function (e) {
    if (e.touches.length === 3 && !t3) {
      t3 = setTimeout(function () { t3 = null; bossToggle(); }, 500);
    }
  }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (t3 && e.touches.length < 3) { clearTimeout(t3); t3 = null; }
  }, { passive: true });
  document.addEventListener('touchcancel', function () {
    if (t3) { clearTimeout(t3); t3 = null; }
  }, { passive: true });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && P.pendingShare) settleShare();
  });

  /* ============================================================ 启动 */
  async function boot() {
    /* 第一阶段：先把 UI 与本地存档准备好，保证任何网络/宿主异常都不影响可玩性 */
    P.best = Object.assign({ easy: 0, normal: 0, hard: 0 }, (lsRead().best || {}));
    P.stam = normalizeStam(lsRead().stam);

    injectTitleUi();
    buildRankOverlay();
    buildShareOverlay();
    buildStamOverlay();
    buildBossScreen();
    var toastBox = el('div', ''); toastBox.id = 'toast';
    document.body.appendChild(toastBox);

    setInterval(function () {
      tickStam();
      if ($('#stamOverlay') && $('#stamOverlay').classList.contains('on')) refreshStamModal();
      if (P.pendingShare && Date.now() - P.pendingShare.at > CFG.SHARE_CONFIRM_MS &&
          document.visibilityState === 'visible') settleShare();
    }, 1000);

    P.ready = true;

    /* 第二阶段：接入主机（可能较慢，全部带超时） */
    try {
      P.sdk = await loadSdkScript();
      P.inToy = true;
    } catch (e) {
      P.sdk = null; P.inToy = false;
      console.log('[toy] 未检测到 Toy 宿主，使用单机模式');
    }

    if (P.inToy && P.sdk) {
      try { P.user = await TO(P.sdk.getUserProfile(), 4000, 'getUserProfile'); } catch (e) { P.user = null; }
      refreshWho();
      await loadSave();
      applySettingsToGame();
      bindSettingPersist();
      renderStam();
      if (P.user) toast('已连接 B站账号 · ' + (P.user.nickname || ''), 'ok');
    } else {
      applySettingsToGame();
      bindSettingPersist();
    }
  }

  // 与游戏主流程的挂钩
  window.__beforeStart = beforeStart;
  window.__onFinish = function (run) {
    injectResultUi();
    onRunEnd(run);
  };
  window.__onBoot = boot;

  // 结果页 DOM 可能在 finish 之后才切换，补一次注入
  var _mu = new MutationObserver(function () {
    if ($('#resultScreen') && $('#resultScreen').classList.contains('on')) injectResultUi();
  });
  document.addEventListener('DOMContentLoaded', function () {
    var rs = $('#resultScreen');
    if (rs) _mu.observe(rs, { attributes: true, attributeFilter: ['class'] });
  });

  // 暴露给游戏逻辑与自测（平台最多 5 个榜，这里用到 4 个，剩 1 个备用）
  P.MODE_BOARD = MODE_BOARD; P.MODE_CN = MODE_CN; P.MODE_SOON = MODE_SOON;

  window.__PLAT_READY = true;
})();
