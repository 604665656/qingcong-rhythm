/* http 环境根因诊断：捕获 console + pageerror，看脚本为何没初始化
 * 用法：node build/diag_http2.js http://127.0.0.1:8877/index.html
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9462;
const PAGE = process.argv[2] || 'http://127.0.0.1:8877/index.html';
const PROF = path.join(os.tmpdir(), 'qcdiag2_' + Date.now());
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROF,
    '--allow-file-access-from-files', '--mute-audio', '--proxy-server=direct://',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=390,844', PAGE
  ], { stdio: 'ignore' });

  let ws;
  for (let i = 0; i < 80; i++) {
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
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args || []).map(a => a.value !== undefined ? a.value : (a.description || '')).join(' ');
      console.log('[console.' + m.params.type + ']', txt);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      console.log('[pageerror]', (d.exception && (d.exception.description || d.exception.value)) || d.text, '@', (d.stackTrace && d.stackTrace.callFrames[0] && d.stackTrace.callFrames[0].url + ':' + d.stackTrace.callFrames[0].lineNumber));
    }
  });
  const send = (method, params = {}) => new Promise(r => {
    const i = ++id; pend.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Runtime.enable');

  await sleep(4000);
  const st = await send('Runtime.evaluate', { expression: `JSON.stringify({
    ready: document.readyState,
    hasScript: document.querySelectorAll('script').length,
    bodyLen: document.body ? document.body.innerHTML.length : 0,
    loadingVisible: (function(){var l=document.getElementById('loading'); return l? (!l.classList.contains('off')) : null;})(),
    S: typeof S, SONG: typeof SONG, SONGS: typeof SONGS, audioMode: typeof audioMode,
    __loaded: typeof window.__loaded!=='undefined'?window.__loaded:null,
    baseHref: location.href,
    scripts: Array.from(document.querySelectorAll('script[src]')).map(s=>s.src)
  })`, returnByValue: true });
  console.log('STATE', st.result && st.result.result && st.result.result.value);

  await sleep(3000);
  const st2 = await send('Runtime.evaluate', { expression: `JSON.stringify({
    __loaded: typeof window.__loaded!=='undefined'?window.__loaded:null,
    S: typeof S!=='undefined' && S ? {screen:S.screen, mode:S.mode, dur:S.dur} : null,
    audioMode: typeof audioMode!=='undefined'?audioMode:null
  })`, returnByValue: true });
  console.log('STATE2', st2.result && st2.result.result && st2.result.result.value);

  edge.kill();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
