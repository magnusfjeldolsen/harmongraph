/* Module link check — `node test/modules.mjs`

   `node --check` parses a file as a script. It does not apply ES-module
   scoping, so it happily accepts a module that redeclares an identifier or
   imports the same binding twice — both of which are hard errors when the
   browser actually loads it, and both of which have shipped here before.

   Dynamic import compiles the module before evaluating it, so a SyntaxError
   means the file could never load in a browser either. Everything else is
   the DOM not existing in Node, which is expected and ignored. */

import {readdirSync,statSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';

function walk(dir,out=[]){
  for(const e of readdirSync(dir)){
    const p=join(dir,e);
    if(statSync(p).isDirectory()) walk(p,out);
    else if(e.endsWith('.js')) out.push(p);
  }
  return out;
}

const files=walk('js').sort();
let bad=0;
for(const f of files){
  let verdict='ok';
  try{
    await import(pathToFileURL(f).href);
  }catch(e){
    // A module that throws while *evaluating* still compiled fine. Only a
    // compile-time failure means the browser could not load it.
    if(e instanceof SyntaxError){ verdict='FAIL  '+e.message; bad++; }
    else verdict='ok (needs a DOM, expected)';
  }
  console.log((verdict.startsWith('FAIL')?'  ':'  ')+f.padEnd(24)+verdict);
}
console.log('\n'+files.length+' modules, '+(bad?bad+' FAILED':'all link cleanly'));
process.exit(bad?1:0);
