import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../src/source.mjs';
import { followPortal, launchCaptureBrowser } from '../src/collect.mjs';
import { CaptureStore } from '../src/store.mjs';

async function withPortal(bfcache, run) {
  const source = await startSource();
  const root = await mkdtemp(join(tmpdir(), 'capture-'));
  const store = new CaptureStore(join(root, 'records.json'));
  let session = null;
  try {
    session = await followPortal({ url: source.url, store, bfcache });
    await run({ source, session, store });
  } finally {
    if (session) await session.close();
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function publish(source) {
  const response = await fetch(source.url + '/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'publish' })
  });
  assert.equal(response.status, 200);
}

function records(capture) {
  return capture.ledger.records;
}

/** 等到确实产生了指定变化的结果，避免用固定延时制造迟到事件（迟到另有专门测试）。 */
async function waitForRecord(session, predicate, label) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const found = records(session.capture).find(predicate);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('等待接收记录超时：' + label);
}

test('连续采集跟随同文档路由、筛选、同地址历史项与锚点', { timeout: 60000 }, async () => {
  await withPortal(true, async ({ session }) => {
    const { page, capture } = session;
    await page.click('#to-b');
    await page.waitForFunction(() => document.querySelector('#reading').textContent === '设备乙参数 r1');
    await page.selectOption('#filter', 'online');
    await page.waitForFunction(() => document.querySelector('#filter-label').textContent === '在线');
    await page.click('#same-url');
    await page.click('#anchor');
    await page.waitForTimeout(200);
    await session.settle();

    const seen = records(capture);
    const documents = new Set(seen.filter(record => record.kind === 'result').map(record => record.document));
    assert.equal(documents.size, 1, '路由、筛选、同地址历史项和锚点都在同一份文档内');
    const route = seen.find(record => record.change === 'route');
    const filter = seen.find(record => record.change === 'filter');
    const sameUrl = seen.find(record => record.change === 'same-url');
    const hash = seen.find(record => record.change === 'hash');
    assert.ok(route && filter && sameUrl && hash);
    for (const record of [route, filter, sameUrl, hash]) {
      assert.equal(record.classification, 'same-document-change');
      assert.equal(record.confirmed, false);
    }
    assert.equal(sameUrl.url, route.url, '同一地址的两个历史项');
    assert.notEqual(sameUrl.historyItem.key, route.historyItem.key);
    assert.equal(filter.filter, 'online');
    assert.ok(seen.every(record => record.historyItem?.key));
    assert.equal(new Set(seen.filter(record => record.kind === 'result').map(record => record.historyItem.key)).size, 5);
  });
});

test('跨文档后退的真实缓存恢复只预览，重新确认后才更新最新资料', { timeout: 60000 }, async () => {
  await withPortal(true, async ({ source, session }) => {
    const { page, capture } = session;
    await page.click('#to-b');
    await page.selectOption('#filter', 'online');
    await page.waitForFunction(() => document.querySelector('#filter-label').textContent === '在线');
    await publish(source);
    await page.click('#away');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === '设备资料说明');
    await page.goBack({ waitUntil: 'commit' });
    await page.waitForTimeout(300);
    await session.settle();

    const restored = records(capture).filter(record => record.classification === 'restored-display');
    assert.ok(restored.length >= 1, '应观察到浏览器恢复展示');
    const preview = restored.at(-1);
    assert.equal(preview.navigation.type, 'restore');
    assert.equal(preview.preview, true);
    assert.equal(preview.fresh, false);
    assert.equal(preview.confirmed, false);
    assert.equal(preview.historyItem.filter, 'online');
    assert.equal(preview.reading, '设备乙参数 r1');
    assert.equal(await page.locator('#reading').textContent(), '设备乙参数 r1', '恢复页面仍可预览');
    assert.equal(capture.ledger.latestConfirmed.reading, '设备甲参数 r1');
    assert.equal(capture.ledger.latestConfirmed.generation, 1);

    await page.click('#reconfirm');
    await page.waitForFunction(() => document.querySelector('#reading').textContent === '设备乙参数 r2');
    await session.settle();
    const after = records(capture).at(-1);
    assert.equal(after.classification, 'fresh-response');
    assert.equal(after.change, 'reconfirmed');
    assert.equal(after.upgradedFromPreview, true);
    assert.equal(after.basis.observedStatus, 200);
    assert.equal(after.basis.generation, 2);
    assert.equal(capture.ledger.latestConfirmed.reading, '设备乙参数 r2');
    assert.equal(capture.ledger.latestConfirmed.generation, 2);
  });
});

test('浏览器未启用前进后退缓存时，返回是新的文档响应而不是恢复展示', { timeout: 60000 }, async () => {
  await withPortal(false, async ({ source, session }) => {
    const { page, capture } = session;
    await page.click('#to-b');
    await waitForRecord(session, record => record.change === 'route', '路由变化');
    await publish(source);
    await page.click('#away');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === '设备资料说明');
    await page.goBack({ waitUntil: 'commit' });
    await page.waitForFunction(() => document.querySelector('#reading') !== null);
    const returned = await waitForRecord(session, record => record.change === 'document-back-forward', '返回文档');
    await session.settle();

    const seen = records(capture);
    assert.equal(seen.filter(record => record.classification === 'restored-display').length, 0);
    assert.equal(returned.classification, 'fresh-response');
    assert.equal(returned.basis.observedStatus, 200, '返回时确有新的网络响应');
    assert.notEqual(returned.document, seen[0].document, '这是另一份文档');
    assert.equal(returned.historyItem.key, seen.find(record => record.change === 'route').historyItem.key,
      '同一个历史项被浏览器恢复');
    assert.equal(capture.ledger.latestConfirmed.generation, 2);
  });
});

test('快速前进后退时迟到的页面事件不会串到当前设备', { timeout: 60000 }, async () => {
  await withPortal(true, async ({ session }) => {
    const { page, capture } = session;
    await page.click('#to-b');
    const route = await waitForRecord(session, record => record.change === 'route', '路由变化');
    await page.click('#away');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === '设备资料说明');
    await page.goBack({ waitUntil: 'commit' });
    await page.goForward({ waitUntil: 'commit' });
    await page.goBack({ waitUntil: 'commit' });
    await waitForRecord(session, record => record.change === 'document-traverse' && record.applied, '恢复展示');
    await page.waitForTimeout(400);
    await session.settle();

    const newest = records(capture).filter(record => record.kind === 'result').at(-1);
    assert.equal(newest.applied, true);
    assert.equal(newest.classification, 'restored-display');
    assert.equal(newest.historyItem.key, route.historyItem.key);
    for (const archived of records(capture).filter(record => record.late || record.stale)) {
      assert.equal(archived.applied, false);
      assert.equal(archived.confirmed, false);
    }
    assert.equal(capture.ledger.currentEntryKey, newest.historyItem.key);
    assert.equal(capture.ledger.current.change, 'document-traverse');
    assert.equal(capture.ledger.latestConfirmed.order, 1);
  });
});

test('同文档历史返回保留各历史项的筛选条件', { timeout: 60000 }, async () => {
  await withPortal(true, async ({ session }) => {
    const { page } = session;
    await page.click('#to-b');
    await page.selectOption('#filter', 'online');
    const online = await waitForRecord(session, record => record.change === 'filter' && record.filter === 'online', '在线筛选');
    await page.click('#same-url');
    const offline = await waitForRecord(session, record => record.change === 'same-url' && record.filter === 'offline', '离线筛选');
    await page.goBack();
    const returned = await waitForRecord(session, record => record.change === 'history' && record.applied, '历史返回');
    await session.settle();

    assert.equal(returned.historyItem.key, online.historyItem.key);
    assert.equal(returned.filter, 'online');
    assert.notEqual(online.historyItem.key, offline.historyItem.key);
    assert.equal(online.url, offline.url, '两个历史项地址相同');
  });
});
