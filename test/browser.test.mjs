import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {startSource} from '../src/source.mjs';
test('真实浏览器呈现及操作保留源端特殊情形',{timeout:20000},async()=>{
 const source=await startSource();const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();
 const action=async action=>{const response=await fetch(source.url+'/api/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});assert.equal(response.status,200);return response.json();};
 try{await page.goto(source.url);await page.waitForFunction(()=>window.portalReady);const initial=JSON.parse(await page.locator('#lifecycle').textContent());
await page.click('#to-b');const second=JSON.parse(await page.locator('#lifecycle').textContent());assert.equal(initial.document,second.document);assert.notEqual(initial.item,second.item);
await action('publish');await page.goBack();assert.equal(await page.locator('#reading').textContent(),'设备甲参数 r1');
await page.click('#same-url');const next=JSON.parse(await page.locator('#lifecycle').textContent());assert.equal(next.reason,'same-url');}
 finally{await browser.close();await source.close();}
});
