/* 平台层运行时自测：CDP + Edge headless */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9441;
const PAGE = process.env.PAGE_URL || ('file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/'));
const PROF = path.join(require('os').tmpdir(), 'qcqa2_' + Date.now());

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROF,
    '--allow-file-access-from-files', '--mute-audio', '--no-proxy-server', '--proxy-bypass-list=*',
    '--window-size=1280,860', PAGE
  ], { stdio: 'ignore' });

  let ws, id = 0, pend = new Map();
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
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise(res => {
    const i = ++id; pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      return { __err: (d.exception && d.exception.description) || d.text };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(1500);

  const out = [];
  const T = (name, ok, extra) => out.push([ok ? 'PASS' : 'FAIL', name, extra === undefined ? '' : String(extra)]);

  // 1. 基础加载
  const base = await evaluate(`(function(){
    try{
    return JSON.stringify({
      plat: !!window.PLAT, ready: !!window.__PLAT_READY, boot: typeof window.__onBoot,
      loaded: !!window.__loaded,
      loadingOff: (document.getElementById('loading')||{}).className||'',
      audioMode: (typeof audioMode!=='undefined'?audioMode:'?'),
      dur: (typeof S!=='undefined'&&S?S.dur:0),
      pill: !!document.getElementById('staminaPill'),
      pillTxt: (document.getElementById('staminaPill')||{}).textContent||'',
      rankBtn: !!document.getElementById('rankBtn'),
      shareBtn: !!document.getElementById('shareBtn'),
      boss: !!document.getElementById('bossKey'),
      toast: !!document.getElementById('toast'),
      who: (document.querySelector('.who')||{}).textContent||'',
      inToy: window.PLAT ? window.PLAT.inToy : null
    });}catch(e){return 'ERR:'+e.message+' | '+(e.stack||'').split('\\n')[1];}})()`);
  if (typeof base !== 'string' || base.startsWith('ERR:')) { console.error('base 异常:', base); }
  console.log('base raw =', base);
  const b = JSON.parse(base);
  T('平台层已挂载', b.plat && b.ready);
  T('音轨加载完成（loading 已关闭）', b.loaded && /off/.test(b.loadingOff), 'mode=' + b.audioMode + ' dur=' + Math.round(b.dur));
  T('体力 pill 已注入', b.pill, b.pillTxt.trim());
  T('排行榜/分享按钮已注入', b.rankBtn && b.shareBtn);
  T('身份条已渲染', !!b.who, b.who);

  // 2. 体力：初始 5 → 开局扣到 4
  const st1 = await evaluate(`(function(){
    var v0 = PLAT.stam.v;
    var ok = window.__beforeStart();
    return JSON.stringify({v0:v0, ok:ok, v1:PLAT.stam.v, plays:PLAT.stam.plays, txt:document.getElementById('staminaPill').textContent});
  })()`);
  const s1 = JSON.parse(st1);
  T('开局扣体力 5→4', s1.ok === true && s1.v1 === 4, `v0=${s1.v0} v1=${s1.v1} plays=${s1.plays}`);

  // 3. 体力耗尽后被拦
  const st2 = await evaluate(`(function(){
    PLAT.stam.v = 0; PLAT.stam.ts = Date.now();
    var ok = window.__beforeStart();
    var ov = document.getElementById('stamOverlay');
    return JSON.stringify({ok:ok, open: !!ov && ov.classList.contains('on'), desc: (document.getElementById('stamDesc')||{}).innerHTML||''});
  })()`);
  const s2 = JSON.parse(st2);
  T('体力为 0 时禁止开局', s2.ok === false);
  T('自动弹出体力弹层', s2.open, (s2.desc || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 90));

  // 4. 体力恢复（1 分钟 / 点）
  const st3 = await evaluate(`(function(){
    PLAT.stam.v = 2; PLAT.stam.ts = Date.now() - 125000; PLAT.stam.day = '';
    window.PLAT.stam = PLAT.stam;
    var before = PLAT.stam.v;
    // 触发 normalize
    var cd0 = 0;
    document.getElementById('staminaPill').click(); // openStam -> refreshStamModal
    var txt = document.getElementById('stamBig').textContent;
    return JSON.stringify({before:before, txt:txt});
  })()`);
  T('体力界面可打开', !!JSON.parse(st3).txt, JSON.parse(st3).txt);

  // 直接测 normalizeStam 的离线恢复
  const st4 = await evaluate(`(function(){
    var raw = {v:1, ts: Date.now() - 1000*60*3.5, day:'', plays:2, shares:0};
    // 用 3.5 分钟前的时间戳重建
    localStorage.setItem('qc_platform_v2', JSON.stringify({stam:raw}));
    return 'ok';
  })()`);
  await evaluate(`location.reload()`);
  await sleep(3500);
  const st5 = await evaluate(`(function(){
    return JSON.stringify({v: PLAT.stam.v, plays: PLAT.stam.plays, ready: !!PLAT.ready});
  })()`);
  const s5 = JSON.parse(st5);
  T('离线 3.5 分钟恢复 3 点 (1→4)', s5.v === 4, `v=${s5.v} plays=${s5.plays}`);

  // 5. 每日上限
  const lim = await evaluate(`(function(){
    PLAT.stam.v = 5; PLAT.stam.plays = 20;
    var ok = window.__beforeStart();
    return JSON.stringify({ok:ok, plays:PLAT.stam.plays});
  })()`);
  T('每日 20 局上限拦截', JSON.parse(lim).ok === false, JSON.parse(lim).plays);

  // 6. 结算上报 + 存档
  await evaluate(`PLAT.stam.plays = 0; PLAT.stam.v = 5;`);
  const res = await evaluate(`(function(){
    if (typeof setScreen === 'function') setScreen('result');
    var run = {diff:'normal', score:123456, acc:96.5, notes:252, maxCombo:180, dur:184.7,
      judge:{PERFECT:200,GREAT:40,GOOD:10,MISS:2}};
    window.__onFinish(run);
    return JSON.stringify({best: PLAT.best.normal, plays: PLAT.stat.plays, tag: (document.getElementById('resRankTag')||{}).textContent||''});
  })()`);
  const r6 = JSON.parse(res);
  T('结算写入最佳分', r6.best === 123456, 'best.normal=' + r6.best);
  T('结算写入统计', r6.plays >= 1, 'plays=' + r6.plays);
  T('结果页排名位已注入', !!r6.tag, r6.tag);

  // 7. 成绩校验（异常分数被拒）
  const bad = await evaluate(`(function(){
    var run = {diff:'hard', score: 9e9, acc:100, notes:463, maxCombo:463, dur:184.7,
      judge:{PERFECT:463,GREAT:0,GOOD:0,MISS:0}};
    var r = [];
    // 直接调内部校验不可行，改为观察 best 是否被污染
    window.__onFinish(run);
    return JSON.stringify({bestHard: PLAT.best.hard});
  })()`);
  T('异常高分被拦（不写入本机最佳）', JSON.parse(bad).bestHard !== 9e9, 'best.hard=' + JSON.parse(bad).bestHard);

  // 8. 排行榜弹层
  const rk = await evaluate(`(function(){
    document.getElementById('rankBtn').click();
    var ov = document.getElementById('rankOverlay');
    return JSON.stringify({open: !!ov && ov.classList.contains('on'), txt: (document.getElementById('rankList')||{}).textContent||''});
  })()`);
  const r8 = JSON.parse(rk);
  T('排行榜弹层可打开', r8.open, r8.txt.replace(/\s+/g, ' ').trim().slice(0, 70));

  // 9. 分享弹层
  const sh = await evaluate(`(function(){
    document.getElementById('rankOverlay').classList.remove('on');
    document.getElementById('shareBtn').click();
    var ov = document.getElementById('shareOverlay');
    return JSON.stringify({open: !!ov && ov.classList.contains('on'), st: (document.getElementById('shareStatus')||{}).textContent||''});
  })()`);
  const r9 = JSON.parse(sh);
  T('分享弹层可打开', r9.open, r9.st.replace(/\s+/g, ' ').trim());

  // 10. 老板键
  const boss = await evaluate(`(function(){
    document.getElementById('shareOverlay').classList.remove('on');
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'x', code:'KeyX', altKey:true, bubbles:true}));
    var b = document.getElementById('bossKey');
    return JSON.stringify({on: !!b && b.classList.contains('on'), muted: PLAT.muted, rows: b? b.querySelectorAll('tbody tr').length : 0});
  })()`);
  const r10 = JSON.parse(boss);
  T('老板键 Alt+X 显示伪装表格', r10.on && r10.muted, `rows=${r10.rows}`);
  const boss2 = await evaluate(`(function(){
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'x', code:'KeyX', altKey:true, bubbles:true}));
    var b = document.getElementById('bossKey');
    return JSON.stringify({on: b.classList.contains('on'), muted: PLAT.muted});
  })()`);
  T('老板键再次按下恢复游戏', !JSON.parse(boss2).on && !JSON.parse(boss2).muted);

  // 11. 主流程：开始游戏（会消耗体力）
  const play = await evaluate(`(function(){
    PLAT.stam.v = 3; PLAT.stam.plays = 0;
    S.diff = 'easy';
    document.getElementById('startBtn').click();
    return 'go';
  })()`);
  await sleep(1200);
  const play2 = await evaluate(`(function(){
    return JSON.stringify({screen: S.screen, stam: PLAT.stam.v, notes: (S.chart||[]).length});
  })()`);
  const r11 = JSON.parse(play2);
  T('开局后进入游戏页且扣体力', r11.screen === 'game' && r11.stam === 2, `screen=${r11.screen} stam=${r11.stam} notes=${r11.notes}`);

  // 12. 暂停
  await evaluate(`if (S.screen==='game') pause();`);
  const pz = await evaluate(`JSON.stringify({paused: S.paused})`);
  T('暂停可用', JSON.parse(pz).paused === true);

  // 12b. 触屏：按住横向滑动可连续触发相邻轨道
  const slide = JSON.parse(await evaluate(`(function(){
    setScreen('game'); S.paused=false; S.playing=false;
    S.chart = chartFor('easy');
    S.judge={PERFECT:0,GREAT:0,GOOD:0,MISS:0}; S.score=0; S.combo=0;
    var now = songTime();
    var a = S.chart.find(n=>n.lane===0), b = S.chart.find(n=>n.lane===1 && n!==a);
    a.t = now; a.hit=false; a.judged=false;
    b.t = now; b.hit=false; b.judged=false;
    var pf = document.getElementById('playfield');
    var y = V.judgeY;
    var x0 = V.laneX + V.laneW*0.5, x1 = V.laneX + V.laneW*1.5;
    pf.dispatchEvent(new PointerEvent('pointerdown', {pointerId:7, clientX:x0, clientY:y, pointerType:'touch', bubbles:true}));
    var afterDown = S.judge.PERFECT + S.judge.GREAT + S.judge.GOOD;
    pf.dispatchEvent(new PointerEvent('pointermove', {pointerId:7, clientX:x1, clientY:y, pointerType:'touch', bubbles:true}));
    var afterMove = S.judge.PERFECT + S.judge.GREAT + S.judge.GOOD;
    pf.dispatchEvent(new PointerEvent('pointerup', {pointerId:7, clientX:x1, clientY:y, pointerType:'touch', bubbles:true}));
    return JSON.stringify({afterDown:afterDown, afterMove:afterMove, aHit:a.hit, bHit:b.hit,
      released: !keysDown[1] && !keysDown[0], ptr: ptrDown.join('')});
  })()`));
  T('触屏点按命中当前轨道', slide.afterDown === 1 && slide.aHit === true);
  T('按住滑到相邻轨道可续打', slide.afterMove === 2 && slide.bHit === true, `判定数 ${slide.afterMove}`);
  T('抬手后两条轨道都释放', slide.released === true && slide.ptr === '0000', 'ptrDown=' + slide.ptr);

  // 12c. 触屏：双指同时按住不同轨道互不干扰
  const multi = JSON.parse(await evaluate(`(function(){
    S.chart = chartFor('easy');
    S.judge={PERFECT:0,GREAT:0,GOOD:0,MISS:0};
    var pf = document.getElementById('playfield');
    var y = V.judgeY;
    var xa = V.laneX + V.laneW*2.5, xb = V.laneX + V.laneW*3.5;
    pf.dispatchEvent(new PointerEvent('pointerdown', {pointerId:11, clientX:xa, clientY:y, pointerType:'touch', bubbles:true}));
    pf.dispatchEvent(new PointerEvent('pointerdown', {pointerId:12, clientX:xb, clientY:y, pointerType:'touch', bubbles:true}));
    var both = keysDown[2] && keysDown[3];
    pf.dispatchEvent(new PointerEvent('pointerup', {pointerId:11, clientX:xa, clientY:y, pointerType:'touch', bubbles:true}));
    var stillB = keysDown[3] && !keysDown[2];
    pf.dispatchEvent(new PointerEvent('pointerup', {pointerId:12, clientX:xb, clientY:y, pointerType:'touch', bubbles:true}));
    return JSON.stringify({both:both, stillB:stillB, clean: !keysDown[2] && !keysDown[3]});
  })()`));
  T('双指同时按住两条轨道', multi.both === true);
  T('松开一指不影响另一指', multi.stillB === true && multi.clean === true);

  // 12d. 健康游戏忠告
  const health = JSON.parse(await evaluate(`(function(){
    var t = document.querySelector('.title-foot .health');
    var h = document.querySelector('.help-health');
    var l = document.querySelector('.load-health');
    return JSON.stringify({foot: !!t, help: !!h, load: !!l, txt: (t||{}).textContent||''});
  })()`));
  T('健康游戏忠告已写入标题页', health.foot && /适度游戏益脑/.test(health.txt));
  T('健康游戏忠告已写入玩法/加载页', health.help && health.load);

  // 13. 竖屏 / 横屏自适应
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await sleep(600);
  const por = JSON.parse(await evaluate(`JSON.stringify({
    portrait: document.body.classList.contains('portrait'),
    w: V.w, h: V.h, laneW: Math.round(V.laneW), laneX: Math.round(V.laneX),
    canvasW: document.getElementById('playfield').width
  })`));
  T('竖屏 390×844 识别为 portrait', por.portrait === true, `${por.w}×${por.h} laneW=${por.laneW} x=${por.laneX}`);
  T('竖屏四轨完整落在画面内', por.laneX >= 0 && por.laneX + por.laneW * 4 <= por.w + 1);

  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 3, mobile: true });
  await sleep(700);
  const lan = JSON.parse(await evaluate(`JSON.stringify({
    portrait: document.body.classList.contains('portrait'),
    w: V.w, h: V.h, laneW: Math.round(V.laneW), laneX: Math.round(V.laneX), judgeY: Math.round(V.judgeY)
  })`));
  T('横屏 844×390 识别为 landscape', lan.portrait === false, `${lan.w}×${lan.h} laneW=${lan.laneW} judgeY=${lan.judgeY}`);
  T('横屏四轨完整落在画面内', lan.laneX >= 0 && lan.laneX + lan.laneW * 4 <= lan.w + 1);

  // 14. 手柄
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  await evaluate(`(function(){
    S.diff='easy'; setScreen('game'); S.paused=false;
    S.chart = chartFor('easy'); S.judge={PERFECT:0,GREAT:0,GOOD:0,MISS:0}; S.score=0; S.combo=0;
    window.__pad = {connected:true, id:'Xbox Wireless Controller (STANDARD GAMEPAD)',
      axes:[0,0,0,0], buttons: Array.from({length:17},()=>({pressed:false,value:0}))};
    navigator.getGamepads = ()=> [window.__pad];
    // 放一个音符到轨道 0 的正前方
    var n = S.chart.find(x=>x.lane===0) || S.chart[0];
    n.t = songTime() + 0.001; n.lane = 0; n.hit=false; n.judged=false;
    window.__pad.buttons[0].pressed = true; window.__pad.buttons[0].value = 1;
    return 'armed';
  })()`);
  await sleep(450);
  const gp1 = JSON.parse(await evaluate(`JSON.stringify({
    down: keysDown[0], badge: (document.getElementById('padBadge')||{}).textContent||'',
    on: (document.getElementById('padBadge')||{className:''}).className||'',
    judged: S.judge.PERFECT + S.judge.GREAT + S.judge.GOOD, score: S.score
  })`));
  T('手柄 A 键映射到轨道 1', gp1.down === true, `badge="${gp1.badge}"`);
  T('手柄按键能触发判定', gp1.judged >= 1, `judged=${gp1.judged} score=${gp1.score}`);
  await evaluate(`window.__pad.buttons[0].pressed=false; window.__pad.buttons[0].value=0;`);
  await sleep(300);
  const gp2 = JSON.parse(await evaluate(`JSON.stringify({down: keysDown[0]})`));
  T('手柄松键释放轨道', gp2.down === false);
  await evaluate(`navigator.getGamepads = ()=>[];`);
  await sleep(200);

  // 输出
  console.log('\n================ 平台层自测 ================');
  out.forEach(([k, n, e]) => console.log(`${k === 'PASS' ? '✅' : '❌'} ${n}${e ? '  —  ' + e : ''}`));
  const fail = out.filter(o => o[0] === 'FAIL').length;
  console.log(`\n合计 ${out.length} 项，失败 ${fail} 项`);
  console.log('inToy =', b.inToy);

  // 截图存档
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) {
    fs.writeFileSync(path.join(__dirname, 'qa_shot.png'), Buffer.from(shot.result.data, 'base64'));
  }

  ws.close(); edge.kill();
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
})().catch(e => { console.error(e); process.exit(1); });
