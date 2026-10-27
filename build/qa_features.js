/* 新功能专项自测：多歌曲 / 个性化主题 / 太鼓模式 / 判定音效 / 滑条链尾无箭头
 * 用法：node build/qa_features.js   （PAGE_URL 可选，默认本地 index.html）
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9453;
const PAGE = process.env.PAGE_URL || ('file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/'));
const PROF = path.join(os.tmpdir(), 'qcfeat_' + Date.now());
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROF,
    '--allow-file-access-from-files', '--mute-audio',
    ...(process.env.NO_PROXY ? ['--no-proxy-server', '--proxy-bypass-list=*'] : []),
    '--window-size=1280,860', PAGE
  ], { stdio: 'ignore' });

  let ws;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await r.json();
      const pg = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; }
    } catch (e) {}
    await sleep(250);
  }
  if (!ws) { console.error('CDP 连接失败'); edge.kill(); process.exit(1); }

  let id = 0; const pend = new Map();
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise(res => {
    const i = ++id; pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      return { __err: (d.exception && d.exception.description) || d.text };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const J = (s, tag) => { if (typeof s === 'string' && s.startsWith('ERR:')) throw new Error(tag + ' ' + s); return JSON.parse(s); };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: PAGE });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    const st = await ev(`(document.readyState==='complete' && !!document.getElementById('loading'))?'ok':(document.readyState)`);
    if (st === 'ok') { ready = true; break; }
    await sleep(250);
  }
  if (!ready) { console.error('页面就绪超时'); edge.kill(); process.exit(1); }
  await sleep(2500);

  const out = [];
  const T = (name, ok, extra) => out.push([ok ? 'PASS' : 'FAIL', name, extra === undefined ? '' : String(extra)]);

  /* ---- 1. 多歌曲框架 ---- */
  const song = await ev(`JSON.stringify({
    n: (typeof SONGS!=='undefined'?SONGS.length:0),
    hasId: !!(SONG && SONG.id),
    title: SONG?SONG.title:'',
    composer: (SONG&&SONG.meta)?(SONG.meta.composer||''):'',
    lyricist: (SONG&&SONG.meta)?(SONG.meta.lyricist||''):'',
    source: (SONG&&SONG.meta)?(SONG.meta.source||''):'',
    audio: (typeof AUDIO_SRC!=='undefined' && AUDIO_SRC && AUDIO_SRC.indexOf('data:')===0)?'inline':'external'
  })`);
  const s = J(song, 'song');
  T('多歌曲数组已就绪（≥1 首）', s.n >= 1, 'songs=' + s.n);
  T('首曲含 id 与标题', !!s.hasId && !!s.title, s.title);
  T('汽水音乐署名已写入（作曲/作词）', /许/.test(s.composer) && /许/.test(s.lyricist), '作曲=' + s.composer + ' 作词=' + s.lyricist);
  T('来源标签为汽水音乐', s.source === '汽水音乐', 'source=' + s.source);
  T('音轨以内嵌 data URI 打包（离线可玩）', s.audio === 'inline');
  const applyOk = await ev(`(function(){ try{ applySong(0); return 'ok'; }catch(e){ return 'ERR:'+e.message; } })()`);
  T('applySong(0) 不抛错', applyOk === 'ok', applyOk);

  /* ---- 2. 个性化主题 ---- */
  const theme1 = await ev(`JSON.stringify({n: THEMES.length, ids: THEMES.map(t=>t.id), mint0: getComputedStyle(document.documentElement).getPropertyValue('--mint').trim()})`);
  const th = J(theme1, 'theme');
  T('主题系统含 4 套配色', th.n === 4, 'ids=' + th.ids.join(','));
  // 切到樱粉，验证 --mint CSS 变量被改写
  const theme2 = await ev(`(function(){
    S.theme='sakura'; applyTheme();
    var m = getComputedStyle(document.documentElement).getPropertyValue('--mint').trim();
    var lanes = (typeof LANE_COLORS!=='undefined')?LANE_COLORS.slice():[];
    return JSON.stringify({mint:m, lanes0:lanes[0], cat:document.body.dataset.cat});
  })()`);
  const th2 = J(theme2, 'theme2');
  T('applyTheme 改写 --mint 变量', th2.mint !== th.mint0 && !!th2.mint, 'mint=' + th2.mint);
  T('applyTheme 改写四轨颜色', th2.lanes0 === '#ff8fb1', 'lanes[0]=' + th2.lanes0);
  // 存读回环
  const theme3 = await ev(`(function(){
    S.theme='dusk'; S.nick='小青葱'; saveCustom();
    S.theme='qc'; S.nick=''; loadCustom();
    return JSON.stringify({theme:S.theme, nick:S.nick});
  })()`);
  const th3 = J(theme3, 'theme3');
  T('saveCustom/loadCustom 昵称与主题回环', th3.theme === 'dusk' && th3.nick === '小青葱', 'theme=' + th3.theme + ' nick=' + th3.nick);

  /* ---- 3. 太鼓模式 ---- */
  const tk1 = await ev(`JSON.stringify({
    hasTaiko: MODES.some(m=>m.id==='taiko'),
    win: (typeof TAIKO_WIN!=='undefined')?TAIKO_WIN:{},
    modesBtn: (document.getElementById('modesBtn')||{}).textContent||''
  })`);
  const tk = J(tk1, 'tk');
  T('模式列表含太鼓', tk.hasTaiko);
  T('太鼓判定窗口存在（良/可/不可）', tk.win.GOOD>0 && tk.win.OK>0 && tk.win.MISS>0, JSON.stringify(tk.win));
  const tk2 = await ev(`(function(){
    S.mode='taiko'; applyMode();
    var arr = taikoFor('easy');
    var don = arr.filter(n=>n.type==='don').length, ka = arr.filter(n=>n.type==='ka').length;
    return JSON.stringify({btn:document.getElementById('modesBtn').textContent, total:arr.length, don:don, ka:ka});
  })()`);
  const tk2v = J(tk2, 'tk2');
  T('applyMode 文案含「太鼓」', /太鼓/.test(tk2v.btn), tk2v.btn);
  T('太鼓谱由四轨派生（咚/咔均有）', tk2v.total>0 && tk2v.don>0 && tk2v.ka>0, `total=${tk2v.total} don=${tk2v.don} ka=${tk2v.ka}`);
  // 太鼓判定 + 魂槽不抛错，且命中可加魂
  const tk3 = await ev(`(function(){
    S.mode='taiko'; S.judge={PERFECT:0,GREAT:0,GOOD:0,MISS:0}; S.score=0; S.combo=0; S.soul=50;
    S.chart = taikoFor('easy');
    // 把第一个音符时间对齐到当前歌曲时间，制造一次命中
    var now = songTime(); var n0 = S.chart[0]; n0.t = now; n0.hit=false; n0.judged=false;
    judgeTaiko(n0.type, now);
    return JSON.stringify({judged:S.judge.PERFECT+S.judge.GREAT, soul:S.soul});
  })()`);
  const tk3v = J(tk3, 'tk3');
  T('judgeTaiko 命中即判定且敲鼓不出错', tk3v.judged >= 1, 'judged=' + tk3v.judged + ' soul=' + tk3v.soul);
  // 太鼓渲染不抛错
  const tk4 = await ev(`(function(){ try{ S.mode='taiko'; S.chart=taikoFor('easy'); drawTaiko(songTime()); taikoFrame(songTime(),0.016); return 'ok'; }catch(e){ return 'ERR:'+e.message; } })()`);
  T('太鼓渲染/帧逻辑不抛错', tk4 === 'ok', tk4);
  // 复位为经典
  await ev(`(function(){ S.mode='classic'; applyMode(); })()`);

  /* ---- 4. 判定音效 ---- */
  const sfx1 = await ev(`JSON.stringify({
    has: typeof Sfx!=='undefined',
    methods: (typeof Sfx!=='undefined')?['init','judge','don','ka','setEnabled','setVol','resume','ensure'].filter(m=>typeof Sfx[m]==='function'):[]
  })`);
  const sx = J(sfx1, 'sfx');
  T('Sfx 模块存在且方法齐全', sx.has && sx.methods.length === 8, sx.methods.join(','));
  const sfx2 = await ev(`(function(){
    try{
      Sfx.init(abuf); Sfx.setVol(0.5); Sfx.setEnabled(true);
      Sfx.judge('PERFECT'); Sfx.judge('GREAT'); Sfx.judge('GOOD'); Sfx.don(); Sfx.ka();
      // 关闭后 judge 不应抛错（静默）
      Sfx.setEnabled(false); Sfx.judge('PERFECT'); Sfx.setEnabled(true);
      return 'ok';
    }catch(e){ return 'ERR:'+e.message; }
  })()`);
  T('判定音效调用链不抛错（含 MISS 静默）', sfx2 === 'ok', sfx2);
  // 经典模式判 PERFECT 会触发 Sfx.judge 而非鼓声
  const sfx3 = await ev(`(function(){
    S.mode='classic'; S.sfxOn=true;
    S.chart = chartFor('easy'); S.judge={PERFECT:0,GREAT:0,GOOD:0,MISS:0}; S.score=0; S.combo=0;
    var now = songTime(); var n0 = S.chart.find(n=>n.lane===0); n0.t=now; n0.hit=false; n0.judged=false;
    judge(0, now);
    return JSON.stringify({judged:S.judge.PERFECT+S.judge.GREAT+S.judge.GOOD});
  })()`);
  const sx3 = J(sfx3, 'sfx3');
  T('经典模式判定音挂载（命中正常判定）', sx3.judged >= 1, 'judged=' + sx3.judged);

  /* ---- 5. 滑条链尾无箭头 ---- */
  const slide = await ev(`(function(){
    // 构造一条 3 连音符链，调用内部 buildSlides
    var list = [
      {t:1.0, lane:0, hold:0, hit:false, judged:false, holding:false, done:false, holdTick:0},
      {t:1.3, lane:1, hold:0, hit:false, judged:false, holding:false, done:false, holdTick:0},
      {t:1.6, lane:0, hold:0, hit:false, judged:false, holding:false, done:false, holdTick:0}
    ];
    var chains = buildSlides(list);
    var ch = chains[0];
    var tail = ch[ch.length-1];
    return JSON.stringify({chains:chains.length, tailSlideDir:tail.slideDir, tailSlide:tail.slide, midDir:ch[0].slideDir});
  })()`);
  const sl = J(slide, 'slide');
  T('滑条链生成且链尾不画箭头', sl.chains === 1 && sl.tailSlide === true && sl.tailSlideDir === 0, `tailDir=${sl.tailSlideDir} midDir=${sl.midDir}`);

  /* ---- 6. B 站身份 / 粉丝牌 / 成就 / 弹幕 / 玩法弹层 / 保存退出 ---- */
  // 合规：Toy 不允许用户自建昵称头像、禁止自由文本输入（UGC）
  const id1 = await ev(`(function(){
    try{
      var hasNickInput = !!document.getElementById('nickInput');
      var hasDmInput = !!document.getElementById('msgInput');
      var presetNicks = (typeof PRESET_NICKS!=='undefined') ? PRESET_NICKS.length : 0;
      var presetDm = (typeof PRESET_DM!=='undefined') ? PRESET_DM.length : 0;
      fetchMy();
      var nm = document.getElementById('myName');
      var img = document.getElementById('myAvatar');
      return JSON.stringify({hasNickInput:hasNickInput, hasDmInput:hasDmInput,
        presetNicks:presetNicks, presetDm:presetDm,
        name: nm? nm.textContent : '', nick: S.nick||'', from: MY? MY.from : ''});
    }catch(e){ return 'ERR:'+e.message; }
  })()`);
  const ident = J(id1, 'ident');
  T('已移除自由昵称输入框（合规）', ident.hasNickInput === false, 'nickInput=' + ident.hasNickInput);
  T('已移除自由弹幕输入框（合规，无 UGC）', ident.hasDmInput === false, 'msgInput=' + ident.hasDmInput);
  T('昵称用 SDK 或系统预置候选', ident.presetNicks >= 8 && !!ident.nick, 'preset=' + ident.presetNicks + ' nick=' + ident.nick + ' from=' + ident.from);

  const dm1 = await ev(`(function(){
    try{
      localStorage.removeItem('qc_msgs');
      buildDress();                       // 预置弹幕在打开装扮页时装配
      var chips = document.getElementById('dmPresets');
      var n = chips? chips.children.length : 0;
      if(n){ chips.children[0].click(); }
      var saved = loadMsgs().length;
      // 手动飘一条，验证弹幕层真的能生成节点
      stopDanmaku(); startDanmaku();
      var layer = document.getElementById('danmaku');
      var cnt = layer? layer.children.length : 0;
      stopDanmaku();
      return JSON.stringify({chips:n, saved:saved, spawned:cnt});
    }catch(e){ return 'ERR:'+e.message; }
  })()`);
  const dm = J(dm1, 'dm');
  T('预置弹幕可点选并写入本地', dm.chips >= 8 && dm.saved >= 1, 'chips=' + dm.chips + ' saved=' + dm.saved);
  T('弹幕层会生成飘动节点', dm.spawned >= 1, 'spawned=' + dm.spawned);

  const up1 = await ev(`(function(){
    try{
      applyUpCard();
      var img = document.getElementById('upAvatar');
      var nm = document.getElementById('upName');
      var f = document.getElementById('followBtn');
      return JSON.stringify({srcHead: img? String(img.src).slice(0,22) : '',
        name: nm? nm.textContent : '', href: f? f.getAttribute('href') : ''});
    }catch(e){ return 'ERR:'+e.message; }
  })()`);
  const up = J(up1, 'up');
  T('UP 主头像已内置为 data URI', /^data:image\//.test(up.srcHead), 'src=' + up.srcHead);
  T('关注按钮指向 B 站主页（站内，非 b23 短链）', /space\.bilibili\.com/.test(up.href) && !/b23\.tv/.test(up.href), 'href=' + up.href);

  const fan1 = await ev(`(function(){
    try{
      ACH = {}; localStorage.removeItem('qc_ach'); localStorage.removeItem('qc_badge');
      var u1 = unlock('first');
      var u2 = unlock('first');
      renderFans();
      var bdg = document.getElementById('badges');
      var ach = document.getElementById('achs');
      var bCount = bdg? bdg.children.length : 0;
      var aCount = ach? ach.children.length : 0;
      openModeInfo();
      var ov = document.getElementById('modeOverlay');
      var on = ov.classList.contains('on');
      var title = document.getElementById('modeTitle').textContent;
      ov.classList.remove('on');
      return JSON.stringify({u1:u1, u2:u2, bCount:bCount, aCount:aCount, on:on, title:title});
    }catch(e){ return 'ERR:'+e.message; }
  })()`);
  const fan = J(fan1, 'fan');
  T('成就解锁首次 true 再次 false', fan.u1 === true && fan.u2 === false, 'u1=' + fan.u1 + ' u2=' + fan.u2);
  T('粉丝牌 5 枚 / 成就 6 项已渲染', fan.bCount === 5 && fan.aCount === 6, 'badges=' + fan.bCount + ' achs=' + fan.aCount);
  T('模式玩法弹层可弹出且含「玩法」标题', fan.on === true && /玩法/.test(fan.title), 'on=' + fan.on + ' title=' + fan.title);

  const fin1 = await ev(`(function(){
    try{
      ACH = {}; localStorage.removeItem('qc_ach');
      S.screen='game'; S.mode='classic';
      S.judge={PERFECT:50,GREAT:0,GOOD:0,MISS:0};
      S.maxCombo=120; S.score=99999; S.accSum=50; S.accCount=50; S.t=10;
      feverEver=true;
      finish();
      var rb = document.getElementById('resBadge');
      var rn = document.getElementById('resNick');
      var disp = rb? getComputedStyle(rb).display : 'none';
      var txt = rb? rb.textContent : '';
      var nick = rn? rn.textContent : '';
      return JSON.stringify({disp:disp, txt:txt, nick:nick, screen:S.screen});
    }catch(e){ return 'ERR:'+e.message; }
  })()`);
  const fin = J(fin1, 'fin');
  T('结算页粉丝牌显示且标注新成就', fin.disp !== 'none' && /粉丝牌/.test(fin.txt) && /新成就/.test(fin.txt), 'disp=' + fin.disp + ' txt=' + fin.txt);
  T('结算页昵称渲染', !!fin.nick, 'nick=' + fin.nick);

  /* ---- 7. 保存 / 退出（此前只有「完成」，且设置不落盘） ---- */
  const sv1 = await ev(`(function(){
    try{
      var ds=!!document.getElementById('dressSave'), de=!!document.getElementById('dressExit');
      var ss=!!document.getElementById('settingSave'), se=!!document.getElementById('settingExit');
      // 设置持久化：改偏移 -> 保存 -> 清空 -> 读回
      localStorage.removeItem('qc_custom');
      S.offset = 77; S.speed = 1.25; S.vol = 0.55; saveCustom();
      S.offset = 0; S.speed = 1; S.vol = 0.8; loadCustom();
      var got = {offset:S.offset, speed:S.speed, vol:S.vol};
      // 退出还原：快照 -> 改 -> restore
      optSnap = snapOpts();
      S.offset = -120; S.theme='sakura';
      restoreOpts(optSnap);
      var back = (S.offset === optSnap.offset && S.theme === optSnap.theme);
      return JSON.stringify({ds:ds, de:de, ss:ss, se:se, got:got, back:back});
    }catch(e){ return 'ERR:'+e.message; }
  })()`);
  const sv = J(sv1, 'sv');
  T('装扮页有独立的保存与退出按钮', sv.ds && sv.de, 'save=' + sv.ds + ' exit=' + sv.de);
  T('设置页有独立的保存与退出按钮', sv.ss && sv.se, 'save=' + sv.ss + ' exit=' + sv.se);
  T('判定偏移/速度/音量现在会落盘（重启不丢）', sv.got.offset === 77 && Math.abs(sv.got.speed - 1.25) < 1e-6 && Math.abs(sv.got.vol - 0.55) < 1e-6,
    'offset=' + sv.got.offset + ' speed=' + sv.got.speed + ' vol=' + sv.got.vol);
  T('退出能还原未保存的修改', sv.back === true, 'back=' + sv.back);

  /* ---- 8. 横竖屏切换 / 面板关闭 ---- */
  // setOrient 现在是 async（要先 await SDK 容器能力），测试必须等它 resolve
  const oc1 = await ev(`(async function(){
    try{
      var ob = document.getElementById('orientBtn');
      var hasBtn = !!ob;
      await setOrient('landscape');
      var l1 = document.body.classList.contains('rot90');
      await setOrient('portrait');
      var l2 = document.body.classList.contains('rot90');
      await setOrient('auto');
      var t3 = ob? ob.textContent : '';
      var l3 = document.body.classList.contains('rot90');
      return JSON.stringify({hasBtn:hasBtn, l1:l1, l2:l2, t3:t3, l3:l3,
        wide: window.innerWidth > window.innerHeight});
    }catch(e){ return 'ERR:'+e.message; }
  })()`);
  const oc = J(oc1, 'oc');
  T('存在横屏/竖屏切换按钮', oc.hasBtn && /屏幕/.test(oc.t3), 'btn=' + oc.hasBtn + ' text=' + oc.t3);
  T('强制横屏在竖屏视口下旋转画面', oc.wide ? true : oc.l1 === true, 'wide=' + oc.wide + ' rot90=' + oc.l1);
  T('强制竖屏在横屏视口下旋转画面', oc.wide ? oc.l2 === true : true, 'wide=' + oc.wide + ' rot90=' + oc.l2);
  T('切回自动不残留旋转', oc.l3 === false, 'rot90=' + oc.l3);

  // 关键：容器接管后不能再叠加 CSS 旋转，否则画面会被转两次
  const sd1 = await ev(`(async function(){
    try{
      var P = window.PLAT; if(!P) return JSON.stringify({noPlat:true});
      var real = P.sdk;
      var calls = [];
      P.sdk = { setContainerMode: function(o){ calls.push(o); return Promise.resolve({}); } };
      await setOrient('landscape');
      var rotWithSdk = document.body.classList.contains('rot90');
      var last = calls.length ? calls[calls.length-1] : null;
      P.sdk = real;                                  // 还原
      await setOrient('auto');
      return JSON.stringify({noPlat:false, called:calls.length,
        orientation: last? last.orientation : '', rotWithSdk:rotWithSdk});
    }catch(e){ return 'ERR:'+e.message; }
  })()`);
  const sd = J(sd1, 'sd');
  T('在 Toy 容器里走官方 setContainerMode', sd.called >= 1 && sd.orientation === 'landscape',
    'called=' + sd.called + ' orientation=' + sd.orientation);
  T('容器接管后不叠加 CSS 旋转（防转两次）', sd.rotWithSdk === false, 'rot90=' + sd.rotWithSdk);

  const cl1 = await ev(`(function(){
    try{
      var x = document.querySelector('#dressOverlay .sheet-close');
      var hasX = !!x;
      buildDress();
      document.getElementById('dressOverlay').classList.add('on');
      var opened = document.getElementById('dressOverlay').classList.contains('on');
      if(x) x.click();                       // 右上角 ✕
      var afterX = document.getElementById('dressOverlay').classList.contains('on');
      // 点背景关闭
      document.getElementById('dressOverlay').classList.add('on');
      var ov = document.getElementById('dressOverlay');
      ov.dispatchEvent(new MouseEvent('click', {bubbles:true}));
      var afterBg = ov.classList.contains('on');
      return JSON.stringify({hasX:hasX, opened:opened, afterX:afterX, afterBg:afterBg});
    }catch(e){ return 'ERR:'+e.message; }
  })()`);
  const cl = J(cl1, 'cl');
  T('装扮页有右上角 ✕ 关闭', cl.hasX && cl.afterX === false, 'x=' + cl.hasX + ' stillOpen=' + cl.afterX);
  T('点面板背景也能关闭装扮页', cl.afterBg === false, 'stillOpen=' + cl.afterBg);

  /* ---- 9. 排行榜按模式分榜 + 新模式预留 ---- */
  const lb1 = await ev(`(function(){
    try{
      var P = window.PLAT || {};
      var mb = P.MODE_BOARD || {};
      var keys = Object.keys(mb);
      var vals = keys.map(function(k){ return mb[k]; });
      var maxBoard = Math.max.apply(null, vals);
      // 模式入口：九宫格 / 连线已预留
      var ids = MODES.map(function(m){ return m.id; });
      var soon = MODES.filter(function(m){ return m.soon; }).map(function(m){ return m.name; });
      var playable = playableModes().map(function(m){ return m.id; });
      // 本机最佳按「模式+难度」分开存
      var oldMode = S.mode;
      S.mode='classic'; var k1 = store.k;
      S.mode='taiko';   var k2 = store.k;
      S.mode = oldMode;
      return JSON.stringify({keys:keys, maxBoard:maxBoard, ids:ids, soon:soon,
        playable:playable, k1:k1, k2:k2});
    }catch(e){ return 'ERR:'+e.message; }
  })()`);
  const lb = J(lb1, 'lb');
  T('排行榜按模式分榜且不超过 5 个', lb.keys.length === 4 && lb.maxBoard <= 5,
    'boards=' + lb.keys.join(',') + ' max=' + lb.maxBoard);
  T('太鼓与节奏用不同榜号', (lb.keys.indexOf('classic') >= 0 && lb.keys.indexOf('taiko') >= 0), 'keys=' + lb.keys.join(','));
  T('九宫格 / 连线已预留入口且标记敬请期待', lb.soon.length === 2 && lb.soon.join('、').indexOf('九宫格') >= 0,
    'soon=' + lb.soon.join('、'));
  T('模式循环只在已实现模式间进行', lb.playable.length === 2 && lb.playable.join(',') === 'classic,taiko',
    'playable=' + lb.playable.join(','));
  T('本机最佳分按模式分开存（太鼓不混节奏）', lb.k1 !== lb.k2 && /taiko/.test(lb.k2), 'k1=' + lb.k1 + ' k2=' + lb.k2);

  // 模式对外统一叫「节奏」，与排行榜 MODE_CN.classic 保持一致（别再写成「下落」）
  const mn1 = await ev(`(function(){
    try{
      var old = S.mode;
      S.mode='classic'; applyMode();
      var t1 = document.getElementById('modesBtn').textContent;
      var cn = (window.PLAT && window.PLAT.MODE_CN) ? window.PLAT.MODE_CN.classic : '';
      S.mode = old; applyMode();
      return JSON.stringify({t1:t1, cn:cn});
    }catch(e){ return 'ERR:'+e.message; }
  })()`);
  const mn = J(mn1, 'mn');
  T('模式按钮显示「节奏」而非「下落」', /节奏/.test(mn.t1) && !/下落/.test(mn.t1), 'btn=' + mn.t1);
  T('模式名与排行榜榜名一致', mn.cn === '节奏' && /节奏/.test(mn.t1), 'rank=' + mn.cn + ' btn=' + mn.t1);

  const lb2 = await ev(`(function(){
    try{
      // 结算上报要带上 mode，平台层才能选对榜
      window.__cap = null;
      window.__onFinish = function(r){ window.__cap = r; };
      ACH = {}; localStorage.removeItem('qc_ach');
      S.screen='game'; S.mode='taiko';
      S.judge={PERFECT:10,GREAT:0,GOOD:0,MISS:0};
      S.maxCombo=10; S.score=12345; S.accSum=10; S.accCount=10; S.t=5;
      finish();
      var c = window.__cap || {};
      return JSON.stringify({mode:c.mode, song:c.song, score:c.score, diff:c.diff});
    }catch(e){ return 'ERR:'+e.message; }
  })()`);
  const lb3 = J(lb2, 'lb2');
  T('结算上报带上模式（供平台选榜）', lb3.mode === 'taiko' && lb3.score === 12345,
    'mode=' + lb3.mode + ' score=' + lb3.score);

  // 输出
  console.log('\n================ 新功能专项自测 ================');
  out.forEach(([k, n, e]) => console.log(`${k === 'PASS' ? '✅' : '❌'} ${n}${e ? '  —  ' + e : ''}`));
  const fail = out.filter(o => o[0] === 'FAIL').length;
  console.log(`\n合计 ${out.length} 项，失败 ${fail} 项`);

  ws.close(); edge.kill();
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
})().catch(e => { console.error(e); process.exit(1); });
