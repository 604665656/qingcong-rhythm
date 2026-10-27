const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9444;
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const edge = spawn(EDGE, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(os.tmpdir(),'qcm_'+Date.now()),
    '--allow-file-access-from-files','--mute-audio','--window-size=1280,860', PAGE], { stdio: 'ignore' });
  let ws, id=0, pend=new Map();
  for (let i=0;i<60;i++){ try{ const l=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();
    const pg=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl); if(pg){ws=new WebSocket(pg.webSocketDebuggerUrl);break;} }catch(e){} await sleep(250); }
  await new Promise(r=>ws.addEventListener('open',r));
  ws.addEventListener('message', ev=>{ const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);} });
  const send=(m,p={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
  const ev2=async x=>(await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true})).result.result.value;
  await send('Runtime.enable'); await send('Page.enable'); await sleep(2500);
  for (const [w,h] of [[390,844],[375,812],[360,780],[430,932]]) {
    await send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:2,mobile:true});
    await sleep(700);
    const r = JSON.parse(await ev2(`(function(){
      var s=document.getElementById('titleScreen');
      var w=s.querySelector('.title-wrap');
      return JSON.stringify({vh:s.clientHeight, sh:s.scrollHeight, wrapH: w?Math.round(w.getBoundingClientRect().height):0,
        top: w?Math.round(w.getBoundingClientRect().top):0,
        bottom: w?Math.round(w.getBoundingClientRect().bottom):0});
    })()`));
    console.log(w+'x'+h, JSON.stringify(r), r.sh > r.vh ? 'OVERFLOW '+(r.sh-r.vh) : 'ok');
  }
  ws.close(); edge.kill(); setTimeout(()=>process.exit(0),200);
})();
