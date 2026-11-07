const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9474;
const PROF = path.join(os.tmpdir(), 'qcdiag_' + Date.now());
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 四个原型：文件名、名称、刷输入表达式、输入是否需要索引
const TARGETS = [
  { file: 'prototypes/jiugongge.html',        name: '九宫格',      input: i => `window.__QC.hitCell(${i})` },
  { file: 'prototypes/4x4.html',              name: '4x4十六宫格', input: i => `window.__QC.hitCell(${i % 16})` },
  { file: 'prototypes/lianxian_slide.html',   name: '连线A滑条',   input: i => `window.__QC.judgeTap(${i % 9})` },
  { file: 'prototypes/lianxian_adofai.html',  name: '连线B ADOFAI', input: () => `window.__QC.tapAdvance()` },
];

async function testOne(tgt) {
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
  if (!ws) { edge.kill(); return { name: tgt.name, fail: 'CDP 连接失败' }; }

  const pend = new Map(); const errors = []; let id = 0;
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown' || (m.method === 'Runtime.consoleAPICalled' && m.params && m.params.type === 'error')) {
      errors.push((m.params && (JSON.stringify(m.params.exceptionDetails) || JSON.stringify(m.params))) || JSON.stringify(m));
    }
  });
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return { __err: (r.result.exceptionDetails.exception && (r.result.exceptionDetails.exception.description || r.result.exceptionDetails.exception.value)) || r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable'); await send('Page.enable');
  for (let i = 0; i < 40; i++) { if (await ev(`window.__ready===true`)) break; await sleep(200); }

  await ev(`(function(){ try{ window.__QC.startGame(); return 'ok'; }catch(e){ return 'ERR:'+e.message; } })()`);
  await sleep(200);
  const tStart = Date.now();

  // 跑完整首歌（最长 24s），期间机械刷输入，并在第 6 秒强制挂起音频，验证不卡死
  const samples = [];
  const tEnd = Date.now() + 24000;
  let i = 0, lastSt = null, frozenAt = null, lastScore = 0, suspendedAt = null, maxSong = 0;
  while (Date.now() < tEnd) {
    if (suspendedAt === null && Date.now() - tStart >= 6000) {
      await ev(`window.__QC.suspendAudio()`);
      suspendedAt = await ev(`window.__QC.audioState()`);
    }
    await ev(tgt.input(i++));
    const s = await ev(`JSON.stringify(window.__QC.state)`);
    const st = (s && s !== 'ERR:') ? JSON.parse(s) : null;
    if (st) {
      samples.push({ t: Date.now(), st });
      maxSong = Math.max(maxSong, st.songTime || 0);
      if (lastSt && st.running === true && lastSt.running === true) {
        const dt = (st.songTime || 0) - (lastSt.songTime || 0);
        if (dt < 0.0005 && frozenAt === null) frozenAt = st.songTime; // 推进停滞
      }
      lastScore = st.score;
      lastSt = st;
      if (st.running === false && st.songTime >= (st.END || 1e9) - 0.5) break; // 已结束
      // 用 songTime 接近上限就提前结束（避免空等）
      if (st.songTime >= 22) break;
    }
    await sleep(100);
  }

  const first = samples[0] && samples[0].st;
  const last = samples[samples.length - 1] && samples[samples.length - 1].st;
  const noFreeze = frozenAt === null;
  const ok = noFreeze && errors.length === 0 && last && maxSong > 5; // 至少推进过 5s 证明未卡死
  console.log('\n=== ' + tgt.name + ' ===');
  console.log('  首采样:', JSON.stringify(first));
  console.log('  末采样:', JSON.stringify(last));
  console.log('  最大 songTime 到达:', maxSong.toFixed(2));
  console.log('  疑似卡死点 songTime (running 中停滞):', frozenAt === null ? '无' : frozenAt);
  console.log('  末态 running:', last && last.running, ' score:', lastScore);
  console.log('  中途强制挂起 audioState =', suspendedAt, suspendedAt ? ' (应仍不卡死)' : '');
  console.log('  异常数:', errors.length);
  if (errors.length) console.log(errors.slice(0, 3).join('\n'));
  console.log('  结论:', ok ? '✅ 未卡死' : '❌ 存在问题');
  ws.close(); edge.kill();
  await sleep(300);
  return { name: tgt.name, ok, frozenAt, errors: errors.length };
}

(async () => {
  let allOk = true;
  for (const tgt of TARGETS) {
    const r = await testOne(tgt);
    if (!r.ok) allOk = false;
  }
  console.log('\n' + (allOk ? '全部原型抗挂起/抗卡死通过 ✅' : '存在卡死/异常 ❌'));
  process.exit(allOk ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
