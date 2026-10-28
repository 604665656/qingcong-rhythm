/* 线上回归诊断：进入太鼓/节奏，抓运行态（chart/音频/canvas/音符节点）
 * 用法：node build/diag_play.js [PAGE_URL]
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9461;
const PAGE = process.env.PAGE_URL || ('file:///' + path.resolve(__dirname, '..', 'dist', 'index.html').replace(/\\/g, '/'));
const PROF = path.join(os.tmpdir(), 'qcdiag_' + Date.now());
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROF,
    '--allow-file-access-from-files', '--mute-audio', '--no-proxy-server',
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
  });
  const send = (method, params = {}) => new Promise(r => {
    const i = ++id; pend.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      return 'ERR:' + ((r.result.exceptionDetails.exception || {}).description || 'unknown');
    }
    return r.result && r.result.result && r.result.result.value;
  };

  // 等待 ready
  for (let i = 0; i < 40; i++) {
    const ok = await ev('window.__loaded === true');
    if (ok) break;
    await sleep(250);
  }

  const base = await ev(`JSON.stringify({
    screen: typeof S!=='undefined'?S.screen:null,
    mode: typeof S!=='undefined'?S.mode:null,
    diff: typeof S!=='undefined'?S.diff:null,
    dur: typeof S!=='undefined'?S.dur:null,
    audioMode: typeof audioMode!=='undefined'?audioMode:null,
    files: (typeof SONGS!=='undefined'&&SONGS[0])?SONGS[0].id:null
  })`);
  console.log('BASE', base);

  // 收集运行时错误
  await ev(`window.__errs=[]; window.addEventListener('error',e=>window.__errs.push(String(e.message)));`);

  const report = async (label) => {
    const d = await ev(`(function(){
      var pf=document.getElementById('playfield');
      var app=document.getElementById('app');
      var r=pf?pf.getBoundingClientRect():{width:0,height:0,x:0,y:0};
      var px=0;
      try{
        var c=pf, ctx=c.getContext('2d');
        var dw=Math.min(120,c.width), dh=Math.min(120,c.height);
        var ox=Math.max(0,Math.floor((c.width-dw)/2)), oy=Math.max(0,Math.floor((c.height-dh)/2));
        var img=ctx.getImageData(ox,oy,dw,dh).data;
        for(var i=3;i<img.length;i+=4){ if(img[i]>10) px++; }
      }catch(e){}
      return JSON.stringify({
        screen:S.screen, mode:S.mode, playing:S.playing, paused:S.paused,
        songTime:(typeof songTime==='function')?songTime():null,
        S_t:S.t,
        startAt:(typeof startAt!=='undefined')?startAt:null,
        audioMode:(typeof audioMode!=='undefined')?audioMode:null,
        audio:(typeof audioEl!=='undefined'&&audioEl)?{paused:audioEl.paused,ct:+audioEl.currentTime.toFixed(2),ready:audioEl.readyState}:null,
        actx:(typeof actx!=='undefined'&&actx)?+actx.currentTime.toFixed(2):null,
        chart:(S.chart||[]).length,
        notesDom:document.querySelectorAll('.note').length,
        cw:pf?pf.width:null, ch:pf?pf.height:null,
        clientW:pf?pf.clientWidth:null, clientH:pf?pf.clientHeight:null,
        rectW:+r.width.toFixed(1), rectH:+r.height.toFixed(1), rectX:+r.x.toFixed(1), rectY:+r.y.toFixed(1),
        appW:app?app.clientWidth:null, appH:app?app.clientHeight:null,
        innerW:innerWidth, innerH:innerHeight,
        V:{w:V.w,h:V.h,laneW:V.laneW,laneX:V.laneX,judgeY:V.judgeY,portrait:V.portrait},
        pxSample:px,
        errs:window.__errs||[]
      });
    })()`);
    console.log('== ' + label + ' ==\n' + d);
    return d;
  };

  for (const m of ['classic', 'taiko']) {
    await ev(`S.mode='${m}'; S.diff='normal'; applyMode(); document.getElementById('startBtn').click();`);
    await sleep(1600);
    await ev(`var mc=document.getElementById('modeClose'); if(mc) mc.click();`);
    await sleep(2600);
    await report('playing-' + m);
    await ev(`try{ if(S.playing) pause(); }catch(e){}`);
    await ev(`try{ setScreen && setScreen('title'); }catch(e){}`);
    await sleep(600);
  }

  edge.kill();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
