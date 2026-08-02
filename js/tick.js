/* ============================================================
   tick() — hand control back to the event loop, once.

   Cooperative cancellation needs this. A worker cannot see the
   `cancel` message the page just sent, and the page cannot repaint,
   while a synchronous loop is running: both are tasks, and a task
   only runs when the current one returns. The one way to signal a
   busy thread *without* yielding is a SharedArrayBuffer flag read
   with Atomics, and SharedArrayBuffer needs the cross-origin
   isolation headers (COOP/COEP) that GitHub Pages does not serve.
   So the loops yield.

   Which yield matters, because the DSP asks for a hundred-odd of
   them per analysis:
     - setTimeout(0) is clamped to 4 ms once the callbacks nest,
       which would be ~0.4 s of pure waiting per run.
     - setImmediate (Node only) and a MessagePort message (browsers)
       are both tasks and neither is clamped.
   Every 16th yield still goes through a timer: port messages and the
   worker's own incoming messages sit on separate port queues, and
   only the timer is a guarantee that a queued `cancel` gets a look in.
   ============================================================ */

let ch=null, waiting=[], n=0;

const timer = () => new Promise(r=>setTimeout(r,0));

/* Node: setImmediate is a ref'd macrotask, so nothing can exit under us.
   Browsers: a MessagePort round trip, which is not clamped. */
const fast =
  (typeof setImmediate==='function')
    ? () => new Promise(r=>setImmediate(r))
  : (typeof MessageChannel==='function')
    ? () => {
        if(!ch){
          ch=new MessageChannel();
          ch.port1.onmessage=()=>{ const r=waiting.shift(); if(r) r(); };
        }
        return new Promise(r=>{ waiting.push(r); ch.port2.postMessage(0); });
      }
    : timer;

function tick(){ return ((++n & 15)===0) ? timer() : fast(); }

export {tick};
