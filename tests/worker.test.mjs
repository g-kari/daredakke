import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker/index.ts';
const cfg={APP_ORIGIN:'https://daredakke.example.com',ACCESS_TEAM_DOMAIN:'https://exampleteam.cloudflareaccess.com',ACCESS_AUDIENCE:'test-audience',OWNER_EMAIL:'owner@example.com'};
let touched=0;const dependencies={DB:{prepare:()=>{touched++;throw Error('not allowed')}},ASSETS:{fetch:()=>{touched++;throw Error('not allowed')}}};
test('blank configuration denies every path before data/assets',async()=>{for(const path of ['/','/favicon.svg','/assets/app.js','/api/records?scope=demo']){const r=await worker.fetch(new Request('https://daredakke.example.com'+path),{...dependencies,APP_ORIGIN:'',ACCESS_TEAM_DOMAIN:'',ACCESS_AUDIENCE:'',OWNER_EMAIL:''});assert.equal(r.status,503)}assert.equal(touched,0)});
test('old Sites identity headers cannot authenticate any path',async()=>{for(const path of ['/','/favicon.svg','/assets/app.js','/api/records?scope=personal']){const r=await worker.fetch(new Request('https://daredakke.example.com'+path,{headers:{'oai-authenticated-user-id':'forged','oai-authenticated-user-email':'owner@example.com'}}),{...dependencies,...cfg});assert.equal(r.status,401)}assert.equal(touched,0)});
test('different host is denied instead of exposing worker-dev origin',async()=>{assert.equal((await worker.fetch(new Request('https://alternate.workers.dev/'),{...dependencies,...cfg})).status,403);assert.equal(touched,0)});
