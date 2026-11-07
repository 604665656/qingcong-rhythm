const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9473;
const PROF = path.join(os.tmpdir(), 'qcproto_' + Date.now());
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 三个原型：文件名、开始方式、刷输入的表达式（轮询调用）
const TARGETS = [
  { file: 'prototypes/jiugongge.html',        name: '九宫格',      input: i => `window.__QC.hitCell(${i})` },
  { file: 'prototypes/4x4.html',              name: '4x4十六宫格', input: i => `window.__QC.hitCell(${i % 16})` },
  { file: 'prototypes/lianxian_slide.html',   name: '连线A滑条',   input: i => `window.__QC.judgeTap(${i})` },
  { file: 'prototypes/lianxian_adofai.html',  name: '连线B ADOFAI', input: () => `window.__QC.tapAdvance()` },
];

(async () => {
  let allPass = true;
  for (const tgt of TARGETS) {
    const url = 'file:///' + path.resolve(__dirname, '..', tgt.file).replace(/\\/g, '/');
    const edge = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROF + '_' + Math.random().toString(36).slice(2),
      '--allow-file-access-from-files', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
      '--window-size=900,900', url
    ], { stdio: 'ignore' });

    let ws;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
        const list = await r.json();
        const pg = list.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
        if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch (e) {}
      await sleep(250);
    }
    if (!ws) { console.error('✗ ' + tgt.name + ' : CDP 连接失败'); edge.kill(); allPass = false; continue; }

    let id = 0; const pend = new Map(); const errors = [];
    await new Promise(r => ws.addEventListener('open', r));
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown' || (m.method === 'Runtime.consoleAPICalled' && m.params && m.params.type === 'error')) {
        errors.push(JSON.stringify(m.params || m.exceptionDetails || m));
      }
    });
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result && r.result.exceptionDetails) return { __err: (r.result.exceptionDetails.exception && (r.result.exceptionDetails.exception.description || r.result.exceptionDetails.exception.value)) || r.result.exceptionDetails.text };
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await send('Runtime.enable'); await send('Page.enable');
    let ok = false;
    for (let i = 0; i < 40; i++) { const st = await ev(`window.__ready===true`); if (st) { ok = true; break; } await sleep(200); }
    if (!ok) { console.error('✗ ' + tgt.name + ' : 页面未就绪（__ready 缺失）'); edge.kill(); allPass = false; continue; }

    // 开始游戏
    const started = await ev(`(function(){ try{ window.__QC.startGame(); return 'ok'; }catch(e){ return 'ERR:'+e.message; } })()`);
    await sleep(300);
    const s1 = await ev(`JSON.stringify(window.__QC.state)`);
    const st1 = s1 && s1 !== 'ERR:' ? JSON.parse(s1) : null;

    // 跑 ~2.5s，期间轮询刷输入（覆盖判定/空击/漏拍各分支），并捕捉异常
    const tEnd = Date.now() + 2500; let i = 0;
    while (Date.now() < tEnd) {
      const expr = tgt.input(i++ % 9);
      await ev(expr);
      await sleep(70);
    }
    const s2 = await ev(`JSON.stringify(window.__QC.state)`);
    const st2 = s2 && s2 !== 'ERR:' ? JSON.parse(s2) : null;

    const running = st1 && st1.running === true;
    const scoreNum = st2 && typeof st2.score === 'number' && isFinite(st2.score);
    const noErr = errors.length === 0;
    const pass = running && scoreNum && noErr && started === 'ok';
    console.log((pass ? '✅' : '❌') + ' ' + tgt.name +
      '  running=' + running + '  score=' + (st2 ? st2.score : '?') +
      '  maxCombo=' + (st2 ? st2.maxCombo : '?') + '  notes/segs=' + (st2 ? st2.notes + '/' + st2.segments : '?') +
      '  errs=' + errors.length + (errors.length ? '  ' + errors.slice(0,2).join(' | ') : ''));
    if (!pass) allPass = false;
    ws.close(); edge.kill();
    await sleep(300);
  }
  console.log('\n' + (allPass ? '全部原型冒烟通过 ✅' : '存在失败 ❌'));
  process.exit(allPass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
