/* Worker plumbing test — `node test/worker.mjs`
   No dependencies, no browser.

   Two halves, because there are two pieces of machinery and neither can
   be checked by reading it:

     A. js/worker.js driven directly, with a stub `self`. This is the only
        way to prove that cooperative cancellation actually cancels — that
        a `cancel` posted while the pipeline is inside the HPSS median
        filters is seen, unwinds, and leaves the worker able to run the
        next job. terminate() would make that untestable and would also
        throw away the FFT tables and the note dictionary.

     B. js/analysisRunner.js driven against a stub Worker. This is where
        the races live: a run superseded by a newer one, and — the failure
        this whole design exists to rule out — a reply from the old run
        arriving after the new one was posted. That is the same race the
        playback code had to be fixed for twice, so it gets a test rather
        than an argument.

   The fallback half also asserts something stronger than plumbing: with
   no Worker at all, the main-thread path must return exactly the notes
   analyzeSegment() returns on its own. Cancellation must not be able to
   change what a completed analysis says. */

let fails=0;
function check(label,got,want){
  const ok=String(got)===String(want);
  if(!ok) fails++;
  console.log((ok?'  ok  ':'  FAIL')+'  '+label.padEnd(52)+got+(ok?'':'   want '+want));
}
const settle=async(n=8)=>{ for(let i=0;i<n;i++) await new Promise(r=>setImmediate(r)); };
/* a promise's state without awaiting it */
const PENDING={};
const peek=p=>Promise.race([p.then(v=>({v}),e=>({e})),
                            new Promise(r=>setImmediate(()=>r(PENDING)))]);

/* a chord with a bit of everything, long enough that HPSS has real work */
function testSignal(sr,sec,midis){
  const N=Math.round(sr*sec), d=new Float32Array(N);
  for(const m of midis){
    const f0=440*Math.pow(2,(m-69)/12);
    for(let h=1;h<=8;h++){
      const f=f0*h; if(f>sr*0.45) break;
      const a=0.5*Math.pow(0.7,h-1), ph=h*0.7;
      for(let i=0;i<N;i++) d[i]+=a*Math.sin(2*Math.PI*f*i/sr+ph);
    }
  }
  let mx=0; for(let i=0;i<N;i++) mx=Math.max(mx,Math.abs(d[i]));
  for(let i=0;i<N;i++) d[i]*=0.8/mx;
  return d;
}
const SR=22050;

/* ============================================================
   A. the worker module itself
   ============================================================ */
console.log('the worker module');

const posted=[];
globalThis.self={ postMessage:(m,t)=>posted.push({m,t}), onmessage:null };
const W=await import('../js/worker.js');
check('registers a message handler on self',typeof globalThis.self.onmessage,'function');

const send=d=>globalThis.self.onmessage({data:d});
const seen=(type,id)=>posted.filter(p=>p.m.type===type&&(id===undefined||p.m.id===id));
/* the pipeline yields once per cancellation check, so a whole analysis is
   thousands of event-loop turns here. The loop leaves as soon as the message
   lands, so the cap only bounds a failure. */
const wait=async(type,id,tries=50000)=>{
  for(let i=0;i<tries;i++){ if(seen(type,id).length) return seen(type,id)[0]; await settle(1); }
  return null;
};

send({type:'ping',id:0});
check('answers a ping',seen('pong').length,1);

/* --- a whole analysis, and what comes back --- */
posted.length=0;
const sigA=testSignal(SR,1.0,[48,55,64]);
send({type:'analyze',id:1,sig:sigA,sr:SR,
      opts:{a4:440,fftN:8192,decay:0.72,fund:1,hpss:true,thr:0.12,gate:0.08,nms:1.5,maxNotes:12}});
const resA=await wait('result',1);
check('a job reports that it started',seen('started',1).length,1);
check('and posts a result',!!resA,true);
/* the six stage calls analyzeSegment makes, unchanged, now as messages */
check('six progress stages cross the boundary',seen('stage',1).length,6);
check('four of them carry text',seen('stage',1).filter(p=>p.m.m).length,4);
check('the signal is handed back, not kept',resA.m.R.sig.length,sigA.length);
check('and the result carries the note list',resA.m.R.notes.length>0,true);
/* naming one ArrayBuffer twice in a transfer list is a DataCloneError, and
   with HPSS off `harm` IS `sig` — so the list has to be deduplicated */
check('transfer list has no duplicate buffers',
      new Set(resA.t).size,resA.t.length);
check('and it hands over the signal buffer',
      resA.t.includes(resA.m.R.sig.buffer),true);

posted.length=0;
const noHpss=testSignal(SR,0.3,[60]);
send({type:'analyze',id:2,sig:noHpss,sr:SR,opts:{fftN:8192,hpss:false}});
const resB=await wait('result',2);
check('with HPSS off, harm is the signal itself',resB.m.R.harm===resB.m.R.sig,true);
check('and it is still transferred exactly once',
      new Set(resB.t).size,resB.t.length);

/* --- cancellation, mid-pipeline --- */
posted.length=0;
const sigC=testSignal(SR,1.2,[45,52,60,64]);
send({type:'analyze',id:3,sig:sigC,sr:SR,opts:{fftN:8192,hpss:true}});
await settle(3);                       // let it get inside the pipeline
check('the run is under way',seen('started',3).length,1);
send({type:'cancel',id:3});
const canC=await wait('cancelled',3);
check('a cancel mid-run unwinds',!!canC,true);
check('and no result is posted for it',seen('result',3).length,0);

/* the point of cooperative cancellation: the worker is still there */
posted.length=0;
send({type:'analyze',id:4,sig:testSignal(SR,0.5,[60,64,67]),sr:SR,opts:{fftN:8192,hpss:false}});
const resD=await wait('result',4);
check('the same worker runs the next job',!!resD,true);
check('a stale cancel does not affect a newer job',seen('cancelled',4).length,0);

/* a cancel that arrives before the job is dequeued still counts */
posted.length=0;
send({type:'analyze',id:5,sig:testSignal(SR,0.5,[60]),sr:SR,opts:{fftN:8192,hpss:false}});
send({type:'cancel',id:5});
check('cancelling a queued job never starts it',(await wait('cancelled',5))!==null,true);
check('and it did not run',seen('result',5).length,0);

/* ============================================================
   B. the runner, against a stub Worker
   ============================================================ */
console.log('\nthe runner and the worker boundary');

const workers=[];
class StubWorker{
  constructor(url,opts){
    this.url=String(url); this.opts=opts; this.sent=[]; this.alive=true;
    workers.push(this);
  }
  postMessage(m,t){
    this.sent.push({m,t});
    if(m.type==='ping') setImmediate(()=>this.reply({type:'pong',id:m.id}));
  }
  reply(d){ if(this.onmessage) this.onmessage({data:d}); }
  terminate(){ this.alive=false; }
}
globalThis.Worker=StubWorker;

const R1=await import('../js/analysisRunner.js');
const sig=()=>testSignal(SR,0.4,[60,64,67]);
const opts={a4:440,fftN:8192,hpss:false};

const stages=[];
const pA=R1.runAnalysis(sig(),SR,opts,m=>stages.push(m));
await settle();
const w=workers[0];
check('one worker, constructed as a module',w.opts&&w.opts.type,'module');
check('from a URL next to the runner',/js[\\/]worker\.js$/.test(w.url.replace(/^file:\/+/,'')),true);
check('probed with a ping before any work',w.sent[0].m.type,'ping');
const jobA=w.sent.find(s=>s.m.type==='analyze');
check('the job carries a generation id',jobA.m.id>0,true);
check('the signal is transferred, not copied',jobA.t.length,1);
check('and it is the signal buffer',jobA.t[0]===jobA.m.sig.buffer,true);

w.reply({type:'started',id:jobA.m.id});
w.reply({type:'stage',id:jobA.m.id,m:'Transforming …'});
w.reply({type:'stage',id:jobA.m.id,m:null});
w.reply({type:'result',id:jobA.m.id,R:{tag:'A',sig:new Float32Array(4)}});
const outA=await pA;
check('the result comes back',outA.tag,'A');
check('stages reach the status line',stages.join('|'),'Transforming …|');

/* --- the race: a newer run, and a stale reply from the old one --- */
w.sent.length=0;
const pB=R1.runAnalysis(sig(),SR,opts,()=>{});
await settle();
const jobB=w.sent.find(s=>s.m.type==='analyze');
const rB=peek(pB);
const pC=R1.runAnalysis(sig(),SR,opts,()=>{});
const rB2=await peek(pB.then(v=>v,e=>{throw e}).catch(e=>({rejected:e})));
await settle();
const jobC=w.sent.filter(s=>s.m.type==='analyze')[1];
check('starting a second run cancels the first',
      w.sent.some(s=>s.m.type==='cancel'&&s.m.id===jobB.m.id),true);
check('the superseded run rejects at once',
      rB2 && rB2.v && rB2.v.rejected && rB2.v.rejected.aborted,true);
check('the new run has a newer id',jobC.m.id>jobB.m.id,true);

/* the worker answers the OLD job after the new one was posted */
w.reply({type:'cancelled',id:jobB.m.id});
w.reply({type:'result',id:jobB.m.id,R:{tag:'STALE',sig:new Float32Array(4)}});
await settle();
check('a stale result cannot resolve the newer run',(await peek(pC))===PENDING,true);
w.reply({type:'started',id:jobC.m.id});
w.reply({type:'result',id:jobC.m.id,R:{tag:'C',sig:new Float32Array(4)}});
check('the newer run resolves with its own result',(await pC).tag,'C');

/* --- the Cancel affordance --- */
w.sent.length=0;
const before=workers.length;
const pD=R1.runAnalysis(sig(),SR,opts,()=>{}).catch(e=>({rejected:e}));
await settle();
const jobD=w.sent.find(s=>s.m.type==='analyze');
R1.cancelRun();
const outD=await pD;
check('cancel rejects the run',!!(outD.rejected&&outD.rejected.aborted),true);
check('and tells the worker, rather than killing it',
      w.sent.some(s=>s.m.type==='cancel'&&s.m.id===jobD.m.id),true);
w.reply({type:'cancelled',id:jobD.m.id});
await settle();
check('the worker is not terminated',w.alive,true);

w.sent.length=0;
const pE=R1.runAnalysis(sig(),SR,opts,()=>{});
await settle();
const jobE=w.sent.find(s=>s.m.type==='analyze');
w.reply({type:'started',id:jobE.m.id});
w.reply({type:'result',id:jobE.m.id,R:{tag:'E',sig:new Float32Array(4)}});
check('the next run reuses it',(await pE).tag,'E');
check('no worker was respawned',workers.length,before);

/* --- a worker error is not a dead end --- */
w.sent.length=0;
const pF=R1.runAnalysis(sig(),SR,opts,()=>{}).catch(e=>({rejected:e}));
await settle();
w.onerror({});                                   // the worker crashed mid-run
const outF=await pF;
check('a crash mid-run is reported as a worker failure',
      !!(outF.rejected&&outF.rejected.workerFailed),true);
check('the dead worker is terminated',w.alive,false);
check('and a replacement is built',workers.length>before,true);

/* ============================================================
   C. no worker at all — the fallback must still be the same app
   ============================================================ */
console.log('\nno worker support');

globalThis.Worker=function(){ throw new TypeError('module workers are blocked'); };
const R2=await import('../js/analysisRunner.js?fallback');   // a fresh runner
const {analyzeSegment}=await import('../js/analyzeSegment.js');

const fsig=testSignal(SR,0.5,[48,55,64]);
const fopts={a4:440,fftN:8192,decay:0.72,fund:1,hpss:false,thr:0.12,gate:0.08,nms:1.5,maxNotes:12};
const direct=await analyzeSegment(Float32Array.from(fsig),SR,fopts);
const fstages=[];
const viaRunner=await R2.runAnalysis(Float32Array.from(fsig),SR,fopts,m=>fstages.push(m));
check('a blocked worker falls back rather than failing',!!viaRunner,true);
check('and reports it is not using one',R2.usingWorker(),false);
check('the fallback returns the same notes',
      viaRunner.notes.map(n=>n.midi).join(' '),direct.notes.map(n=>n.midi).join(' '));
/* bit-for-bit, not just the same note names: `check` must be incapable of
   moving a number, which is the same promise the harness holds the DSP to */
const sum=a=>{ let s=0,i=0; for(const v of a) s+=v*(++i); return s.toFixed(12); };
check('and the same activations, to the last digit',
      sum(viaRunner.detN),sum(direct.detN));
check('the status line still gets its stages',fstages.length>0,true);
check('the signal comes back on the result',viaRunner.sig.length,fsig.length);

/* the main-thread path is cancellable too — that is the whole reason
   analyzeSegment() takes `check` rather than the worker owning it */
const pG=R2.runAnalysis(testSignal(SR,1.2,[45,52,60,64]),SR,
          {...fopts,hpss:true},()=>{}).catch(e=>({rejected:e}));
await settle(2);
R2.cancelRun();
const outG=await pG;
check('a main-thread run can be cancelled',!!(outG.rejected&&outG.rejected.aborted),true);
const after=await R2.runAnalysis(Float32Array.from(fsig),SR,fopts,()=>{});
check('and the next one still completes',after.notes.length,direct.notes.length);

console.log('\n'+(fails?fails+' FAILED':'all passed'));
process.exit(fails?1:0);
