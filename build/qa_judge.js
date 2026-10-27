/* 判定手感专项自测：窗口宽度 / 跨轨宽容 / 长按判定 / 连线滑条
 * 用法：node build/qa_judge.js   （PAGE_URL 可选，默认本地 index.html）
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9447;
const PAGE = process.env.PAGE_URL || ('file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/'));
const PROF = path.join(os.tmpdir(), 'qcjudge_' + Date.now());
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
      const ex = d.exception || {};
      return { __err: ex.description || ex.value || d.text };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  const J = (v, tag) => {
    if (typeof v !== 'string') throw new Error((tag || '') + ' 求值出错: ' + JSON.stringify(v));
    return JSON.parse(v);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: PAGE });
  for (let i = 0; i < 80; i++) {
    const st = await ev(`(document.readyState==='complete' && !!document.getElementById('loading')) ? 'ok' : 'wait'`);
    if (st === 'ok') break;
    await sleep(250);
  }
  await sleep(2500);

  const out = [];
  const T = (n, ok, x) => out.push([ok ? 'PASS' : 'FAIL', n, x === undefined ? '' : String(x)]);

  /* 1. 窗口常量 */
  const w = await ev(`JSON.stringify({p:WIN.PERFECT,g:WIN.GREAT,o:WIN.GOOD,m:WIN.MISS,a:LANE_ASSIST})`);
  const W = J(w, 'w');
  T('判定窗口 PERFECT ±85ms（休闲向，比 Phigros ±80 更松）', Math.abs(W.p - 0.085) < 1e-6, W.p * 1000 + 'ms');
  T('判定窗口 GREAT ±140ms', Math.abs(W.g - 0.14) < 1e-6, W.g * 1000 + 'ms');
  T('MISS 窗口 280ms', Math.abs(W.m - 0.28) < 1e-6, W.m * 1000 + 'ms');
  T('跨轨宽容 100ms 已启用', Math.abs(W.a - 0.10) < 1e-6, W.a * 1000 + 'ms');

  /* 2. 单音判定：在 PERFECT 窗口内偏 65ms 仍给 PERFECT */
  const one = await ev(`(function(){
    function reset(lane, t){
      S.chart = [{t:t, lane:lane, hold:0, hit:false, missed:false, judged:false, holding:false, done:false, holdTick:0, broke:false, slide:false, slideDir:0}];
      S.judge = {PERFECT:0,GREAT:0,GOOD:0,MISS:0}; S.combo=0; S.maxCombo=0; S.score=0;
      S.accSum=0; S.accCount=0; S.fever=false; S.dur=200; S.auto=false; S.playing=true;
    }
    reset(1, 10);
    judge(1, 10.065);
    var a = S.judge.PERFECT;
    reset(1, 10);
    judge(1, 9.935);                       // 早 65ms
    var b = S.judge.PERFECT;
    return JSON.stringify({late:a, early:b});
  })()`);
  const O = J(one, 'one');
  T('偏晚 65ms 判 PERFECT', O.late === 1, 'PERFECT=' + O.late);
  T('偏早 65ms 判 PERFECT', O.early === 1, 'PERFECT=' + O.early);

  /* 3. 偏 100ms 给 GREAT，不再掉到 GOOD */
  const g = await ev(`(function(){
    S.chart = [{t:10, lane:1, hold:0, hit:false, judged:false, holding:false, holdTick:0}];
    S.judge = {PERFECT:0,GREAT:0,GOOD:0,MISS:0}; S.combo=0; S.score=0; S.accSum=0; S.accCount=0; S.auto=false;
    judge(1, 10.1);
    return JSON.stringify(S.judge);
  })()`);
  const G = J(g, 'g');
  T('偏 100ms 判 GREAT', G.GREAT === 1 && G.GOOD === 0, JSON.stringify(G));

  /* 4. 跨轨宽容：音符在 1 轨，手指落在相邻 2 轨 */
  const as = await ev(`(function(){
    S.chart = [{t:10, lane:1, hold:0, hit:false, judged:false, holding:false, holdTick:0}];
    S.judge = {PERFECT:0,GREAT:0,GOOD:0,MISS:0}; S.combo=0; S.score=0; S.accSum=0; S.accCount=0; S.auto=false;
    judge(2, 10.04);
    var hitByNear = S.chart[0].hit;
    S.chart = [{t:10, lane:1, hold:0, hit:false, judged:false, holding:false, holdTick:0}];
    S.judge = {PERFECT:0,GREAT:0,GOOD:0,MISS:0}; S.combo=0;
    judge(2, 10.16);                        // 超出宽容窗口，不该被偷走
    return JSON.stringify({near:hitByNear, far:S.chart[0].hit});
  })()`);
  const A = J(as, 'as');
  T('点偏一格仍命中（跨轨宽容）', A.near === true);
  T('超出宽容窗口不误判', A.far === false);

  /* 5. 长按：按住有持续得分，按满有 HOLD 判定 */
  const h1 = await ev(`(function(){
    S.chart = [{t:10, lane:0, hold:1.0, hit:false, judged:false, holding:false, holdTick:0, done:false, broke:false}];
    S.judge = {PERFECT:0,GREAT:0,GOOD:0,MISS:0}; S.combo=0; S.maxCombo=0; S.score=0;
    S.accSum=0; S.accCount=0; S.fever=false; S.dur=200; S.auto=false; S.playing=true;
    judge(0, 10.0);
    var scoreAfterHead = S.score;
    keysDown[0] = true;
    for(var t=10.2; t<=11.3; t+=0.1) updateFrame(t, 0.1);   // 上界留余量，避开浮点累积误差
    keysDown[0] = false;
    return JSON.stringify({head:scoreAfterHead, total:S.score, done:S.chart[0].done,
                           judgeTxt:document.getElementById('judgeText').textContent});
  })()`);
  const H1 = J(h1, 'h1');
  T('长按命中后头判得分', H1.head > 0, H1.head);
  T('长按期间持续得分（不再是空按）', H1.total > H1.head, H1.head + ' → ' + H1.total);
  T('长按按满判定完成', H1.done === true);
  T('长按收尾有 HOLD 判定文字', H1.judgeTxt === 'HOLD', H1.judgeTxt);

  /* 6. 长按中断：不判 MISS、不断连 */
  const h2 = await ev(`(function(){
    S.chart = [{t:10, lane:1, hold:1.0, hit:false, judged:false, holding:false, holdTick:0, done:false, broke:false}];
    S.judge = {PERFECT:0,GREAT:0,GOOD:0,MISS:0}; S.combo=0; S.score=0; S.accSum=0; S.accCount=0; S.auto=false;
    judge(1, 10.0);
    var comboAfterHead = S.combo;
    keysDown[1] = false;
    updateFrame(10.35, 0.1);
    return JSON.stringify({combo:comboAfterHead, after:S.combo, miss:S.judge.MISS,
                           holding:S.chart[0].holding, broke:S.chart[0].broke,
                           txt:document.getElementById('judgeText').textContent});
  })()`);
  const H2 = J(h2, 'h2');
  T('长按中途松开不判 MISS', H2.miss === 0, 'MISS=' + H2.miss);
  T('长按中途松开不断连', H2.after === H2.combo && H2.combo >= 1, 'combo=' + H2.after);
  T('长按中断有「断」提示', H2.txt === '断', H2.txt);

  /* 7. 连线滑条：难度谱面能生成链 */
  const sl = await ev(`(function(){
    var r = {};
    ['easy','normal','hard'].forEach(function(d){
      var list = chartFor(d);
      var chains = buildSlides(list);
      r[d] = {chains:chains.length, notes:list.filter(function(n){return n.slide;}).length, total:list.length,
              maxLen: chains.reduce(function(m,c){return Math.max(m,c.length);},0)};
    });
    return JSON.stringify(r);
  })()`);
  const SL = J(sl, 'sl');
  T('HARD 生成连线滑条', SL.hard.chains >= 20 && SL.hard.notes > 0,
    SL.hard.chains + ' 条 / ' + SL.hard.notes + '/' + SL.hard.total + ' 音符');
  T('NORMAL 也有滑条', SL.normal.chains >= 1, SL.normal.chains + ' 条 / ' + SL.normal.notes + ' 音符');
  T('滑条链长至少 3', SL.hard.maxLen >= 3, '最长 ' + SL.hard.maxLen);
  T('滑条音符带方向', await ev(`(function(){
    var list = chartFor('hard'); buildSlides(list);
    return list.some(function(n){ return n.slide && n.slideDir !== 0; });
  })()`) === true);

  /* 8. 实际开局装载（S.slides 在 start() 里赋值） */
  const loaded = await ev(`(function(){
    var before = Array.isArray(S.slides) ? S.slides.length : -1;
    S.diff = 'hard';
    S.chart = chartFor('hard');
    S.slides = buildSlides(S.chart);
    return JSON.stringify({before:before, after:S.slides.length});
  })()`);
  const L = J(loaded, 'loaded');
  T('开局装载滑条数据', L.after > 0, 'chains=' + L.after);

  console.log('\n================ 判定手感自测 ================');
  let fail = 0;
  for (const [st, n, x] of out) {
    if (st === 'FAIL') fail++;
    console.log((st === 'PASS' ? '✅' : '❌') + ' ' + n + (x ? '  —  ' + x : ''));
  }
  console.log('\n合计 ' + out.length + ' 项，失败 ' + fail + ' 项');
  edge.kill();
  process.exit(fail === 0 ? 0 : 2);
})();
