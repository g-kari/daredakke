import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, readLimitedJson } from '../src/worker/http.ts';
const jsonRequest=(data,headers={})=>new Request('https://daredakke.example.com/api/records',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(data)});
test('bounded reader parses UTF-8 JSON',async()=>{assert.deepEqual(await readLimitedJson(jsonRequest({note:'あおい'})),{note:'あおい'})});
test('oversized advertised or streamed body rejected without buffering whole body',async()=>{await assert.rejects(()=>readLimitedJson(jsonRequest({}, {'content-length':'1000001'})),e=>e instanceof HttpError&&e.status===413);await assert.rejects(()=>readLimitedJson(jsonRequest({x:'あ'.repeat(50)}),100),e=>e instanceof HttpError&&e.status===413)});
test('bad UTF-8 and malformed JSON rejected',async()=>{const r=new Request('https://daredakke.example.com/api/records',{method:'POST',body:new Uint8Array([0xff,0xfe])});await assert.rejects(()=>readLimitedJson(r),e=>e.status===400);await assert.rejects(()=>readLimitedJson(new Request('https://daredakke.example.com/api/records',{method:'POST',body:'{'})),e=>e.status===400)});
