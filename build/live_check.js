const { spawn } = require('child_process');
const path=require('path'), os=require('os');
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT=9449; const URL=process.env.PAGE_URL;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const edge=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--remote-debugging-port='+PORT,'--user-data-dir='+path.join(os.tmpdir(),'qcl_'+Date.now()),
    '--mute-audio','--window-size=1280,860',URL],{stdio:'ignore'});
  let ws,id=0,pend=new Map();
  for(let i=0;i<80;i++){try{const l=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();
    const pg=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl); if(pg){ws=new WebSocket(pg.webSocketDebuggerUrl);break;}}catch(e){} await sleep(250);}
  await new Promise(r=>ws.addEventListener('open',r));
  ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
  const send=(m,p={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});
    return r.result&&r.result.result?r.result.result.value:null;};
  await send('Runtime.enable'); await send('Page.enable');
  let done=null;
  for(let i=0;i<40;i++){
    await sleep(500);
    done=await ev(`(function(){var l=document.getElementById('loading');
      return JSON.stringify({loaded:!!window.__loaded, off:!!l&&l.classList.contains('off'),
        txt:(document.getElementById('loadTxt')||{}).textContent||'', mode:(typeof audioMode!=='undefined'?audioMode:'?'),
        dur:(typeof S!=='undefined'&&S?Math.round(S.dur):0)});})()`);
    if(done && JSON.parse(done).off) break;
  }
  console.log('最终状态:', done);
  await sleep(1200);
  const r=await send('Page.captureScreenshot',{format:'png'});
  require('fs').writeFileSync(path.join(__dirname,'live_shot.png'),Buffer.from(r.result.data,'base64'));
  console.log('截图 live_shot.png');
  ws.close(); edge.kill(); setTimeout(()=>process.exit(0),200);
})();
