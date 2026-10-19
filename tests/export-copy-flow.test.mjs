import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
// Actual component callbacks with synthetic clipboard promises, not browser coverage.
const source=ts.createSourceFile('app.tsx',fs.readFileSync(new URL('../src/app.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const functions=new Map();
function visit(node){if(ts.isFunctionDeclaration(node)&&node.name)functions.set(node.name.text,node);ts.forEachChild(node,visit);}visit(source);
function fixture(){
 const gates=[],notices=[];
 const c={sessionPending:{current:false},namespace:'synthetic',namespaceRef:{current:'synthetic'},identityEpoch:{current:1},exportCopyEpoch:{current:0},exportDialogOpen:{current:false},data:{people:[],accounts:[]},exportData:()=>'{"synthetic":true}',copied:false,open:false,
 navigator:{clipboard:{writeText:text=>new Promise((resolve,reject)=>gates.push({text,resolve,reject}))}},
 toast:{success:text=>notices.push({kind:'success',text}),error:text=>notices.push({kind:'error',text})}};
 c.setCopied=value=>{c.copied=value;};c.setExportOpen=value=>{c.open=value;};
 function callback(name){const code=ts.transpileModule(functions.get(name).getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;return new Function(...Object.keys(c),code+'\nreturn '+name+';')(...Object.values(c));}
 return {c,gates,notices,open:callback('setExportDialog'),copy:callback('copyExport')};
}
test('current dialog copy succeeds and clears the badge before another attempt',async()=>{const h=fixture();h.open(true);const first=h.copy();assert.equal(h.c.copied,false);h.gates[0].resolve();await first;assert.equal(h.c.copied,true);const second=h.copy();assert.equal(h.c.copied,false);h.gates[1].reject(Error('Synthetic rejection'));await second;assert.equal(h.c.copied,false);assert.deepEqual(h.notices.map(n=>n.kind),['success','error']);});
for(const success of [true,false])test(`closed/reopened dialog ignores old ${success?'success':'failure'}`,async()=>{const h=fixture();h.open(true);const old=h.copy();h.open(false);h.open(true);if(success)h.gates[0].resolve();else h.gates[0].reject(Error('Synthetic rejection'));await old;assert.equal(h.c.copied,false);assert.deepEqual(h.notices,[]);});
for(const success of [true,false])test(`newer copy owns feedback when old ${success?'success':'failure'} completes later`,async()=>{const h=fixture();h.open(true);const old=h.copy(),fresh=h.copy();h.gates[1].resolve();await fresh;if(success)h.gates[0].resolve();else h.gates[0].reject(Error('Synthetic rejection'));await old;assert.equal(h.c.copied,true);assert.deepEqual(h.notices.map(n=>n.kind),['success']);});
for(const mode of ['identity','session','close'])test(`in-flight copy feedback is fenced by ${mode}`,async()=>{const h=fixture();h.open(true);const pending=h.copy();if(mode==='identity')h.c.identityEpoch.current++;if(mode==='session')h.c.sessionPending.current=true;if(mode==='close')h.open(false);h.gates[0].resolve();await pending;assert.equal(h.c.copied,false);assert.deepEqual(h.notices,[]);});
test('closed dialog and pending verification do not start clipboard writes',async()=>{const h=fixture();await h.copy();h.open(true);h.c.sessionPending.current=true;await h.copy();assert.equal(h.gates.length,0);});
