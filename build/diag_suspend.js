/* 验证软时钟兜底：模拟 Toy 典型故障（actx suspended / 纯 clock 试玩），游戏应仍能推进音符
 * 用法：node build/diag_suspend.js [PAGE_URL]
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9463;
const PAGE = process.env.PAGE_URL || 'http://127.0.0.1:8899/index.html';
const PROF = path.join(os.tmpdir(), 'qcsusp_' + Date.now());
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
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); const l = await r.json(); const pg = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch (e) {}
    await sleep(250);
  }
  if (!ws) { console.error('CDP 连接失败'); edge.kill(); process.exit(1); }
  let id = 0; const pend = new Map();
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) return 'ERR:' + ((r.result.exceptionDetails.exception || {}).description || 'x'); return r.result && r.result.result && r.result.result.value; };
  for (let i = 0; i < 40; i++) { if (await ev('window.__loaded === true')) break; await sleep(250); }

  // 场景 A：classic 正常开局 -> 强制 actx.suspend() 模拟 autoplay 限制 -> 看 songTime 是否由软时钟继续推进
  await ev(`S.mode='classic'; S.diff='normal'; applyMode(); document.getElementById('startBtn').click();`);
  await sleep(1500);
  await ev(`var mc=document.getElementById('modeClose'); if(mc) mc.click();`);
  await sleep(1200);
  const before = await ev(`JSON.stringify({t:+(typeof songTime==='function'?songTime():0).toFixed(3), state: (typeof actx!=='undefined'&&actx)?actx.state:null, notes:document.querySelectorAll('.note').length})`);
  await ev(`try{ if(typeof actx!=='undefined'&&actx) actx.suspend(); }catch(e){}`);
  await sleep(3000);
  const after = await ev(`JSON.stringify({t:+(typeof songTime==='function'?songTime():0).toFixed(3), state: (typeof actx!=='undefined'&&actx)?actx.state:null, notes:document.querySelectorAll('.note').length, px:(function(){try{var c=document.getElementById('playfield'),x=c.getContext('2d'),d=c.getImageData(0,c.height/2-60,c.width,120).data,p=0;for(var i=3;i<d.length;i+=4)if(d[i]>10)p++;return p;}catch(e){return -1;}})()})`);
  console.log('A(actx-suspended) before=', before);
  console.log('A(actx-suspended) after =', after);

  // 场景 B：直接切 clock 试玩（模拟 bootFail 后的状态）：taiko 开局，纯软时钟驱动
  await ev(`try{ if(S.playing) pause(); }catch(e){} try{ setScreen&&setScreen('title'); }catch(e){} await new Promise(r=>setTimeout(r,300));`);
  await ev(`audioMode='clock'; S.mode='taiko'; S.diff='normal'; applyMode(); document.getElementById('startBtn').click();`);
  await sleep(1500);
  await ev(`var mc=document.getElementById('modeClose'); if(mc) mc.click();`);
  const b2 = await ev(`JSON.stringify({t:+(typeof songTime==='function'?songTime():0).toFixed(3), mode:S.mode, audioMode:audioMode, notes:document.querySelectorAll('.note').length})`);
  await sleep(3000);
  const a2 = await ev(`JSON.stringify({t:+(typeof songTime==='function'?songTime():0).toFixed(3), mode:S.mode, audioMode:audioMode, notes:document.querySelectorAll('.note').length, px:(function(){try{var c=document.getElementById('playfield'),x=c.getContext('2d'),d=c.getImageData(0,c.height/2-60,c.width,120).data,p=0;for(var i=3;i<d.length;i+=4)if(d[i]>10)p++;return p;}catch(e){return -1;}})()})`);
  console.log('B(clock-taiko) before=', b2);
  console.log('B(clock-taiko) after =', a2);

  edge.kill(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
