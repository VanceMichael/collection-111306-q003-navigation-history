import test from 'node:test';
import assert from 'node:assert/strict';
import { NavigationCapture } from '../src/collect.mjs';
import { ObservationLedger, classifyObservation, historyItemIdentity } from '../src/domain.mjs';

const PORTAL = 'http://portal.test/';

function facts({
  document = 'doc-1',
  documentOrder = 1,
  url = PORTAL,
  key = 'entry-a',
  id = 'id-a',
  index = 0,
  state = { item: 'item-a', view: 'a', filter: 'all' },
  reading = '设备甲参数 r1',
  basis = { kind: 'retained', source: 'memory' },
  lifecycle = { persisted: false },
  pageNavigationType = 'navigate',
  eventSeq = 1
} = {}) {
  return {
    document,
    documentOrder,
    url,
    entry: { key, id, index, url },
    state,
    item: state?.item ?? null,
    view: state?.view ?? null,
    filter: state?.filter ?? null,
    reading,
    cachedGeneration: 1,
    basis,
    lifecycle,
    pageNavigationType,
    eventSeq,
    navigationLog: []
  };
}

function captureWith({ verifyLive = null, clock = null } = {}) {
  const records = [];
  const capture = new NavigationCapture({
    verifyLive,
    settleMs: 0,
    settleTimeout: 0,
    clock: clock ?? (() => Date.now()),
    onRecord: record => records.push(record)
  });
  return { capture, records };
}

async function loadPortal(capture, overrides = {}) {
  capture.frameNavigated({ type: 'Navigation', loaderId: 'loader-1', url: overrides.url ?? PORTAL });
  capture.networkSeen({ probe: 'probe-1', status: 200, generation: 1 });
  return capture.report({
    kind: 'load',
    at: 1,
    facts: facts({ basis: { kind: 'network', source: 'snapshot', probe: 'probe-1', generation: 1, fresh: true }, ...overrides })
  });
}

test('新文档的首次取数必须是采集器核对过的新响应才成为最新资料', async () => {
  const { capture } = captureWith();
  const record = await loadPortal(capture);
  assert.equal(record.classification, 'fresh-response');
  assert.equal(record.fresh, true);
  assert.equal(record.confirmed, true);
  assert.equal(record.basis.observedStatus, 200);
  assert.equal(record.basis.verified, true);
  assert.equal(capture.ledger.latestConfirmed.reading, '设备甲参数 r1');
});

test('页面声称取数但采集器没有看到响应时不能确认为最新资料', async () => {
  const { capture } = captureWith();
  capture.frameNavigated({ type: 'Navigation', loaderId: 'loader-1', url: PORTAL });
  const record = await capture.report({
    kind: 'load',
    facts: facts({ basis: { kind: 'network', source: 'snapshot', probe: 'missing-probe', generation: 1, fresh: true } })
  });
  assert.equal(record.classification, 'unverified-response');
  assert.equal(record.confirmed, false);
  assert.equal(capture.ledger.latestConfirmed, null);
});

test('同文档路由不换文档也不换历史项身份，且不会推进最新资料', async () => {
  const { capture } = captureWith();
  await loadPortal(capture);
  const before = capture.ledger.latestConfirmed;
  const record = await capture.report({
    kind: 'change',
    change: 'route',
    facts: facts({ url: PORTAL + '?view=b', key: 'entry-b', id: 'id-b', index: 1, state: { item: 'item-b', view: 'b', filter: 'all' }, reading: '设备乙参数 r1', eventSeq: 2 })
  });
  assert.equal(record.classification, 'same-document-change');
  assert.equal(record.document, 'doc-1');
  assert.equal(record.historyItem.key, 'entry-b');
  assert.equal(record.confirmed, false);
  assert.deepEqual(capture.ledger.latestConfirmed, before);
});

test('同一地址的两个历史项由 key 区分并各自保留筛选条件', async () => {
  const { capture } = captureWith();
  await loadPortal(capture);
  const first = await capture.report({
    kind: 'change',
    change: 'same-url',
    facts: facts({ url: PORTAL + '?view=b', key: 'entry-online', id: 'id-1', index: 1, state: { item: 'item-1', view: 'b', filter: 'online' }, reading: '设备乙参数 r1', eventSeq: 2 })
  });
  const second = await capture.report({
    kind: 'change',
    change: 'same-url',
    facts: facts({ url: PORTAL + '?view=b', key: 'entry-offline', id: 'id-2', index: 2, state: { item: 'item-2', view: 'b', filter: 'offline' }, reading: '设备乙参数 r1', eventSeq: 3 })
  });
  assert.equal(first.url, second.url);
  assert.notEqual(first.historyItem.key, second.historyItem.key);
  assert.equal(first.filter, 'online');
  assert.equal(second.filter, 'offline');
  const back = await capture.report({
    kind: 'popstate',
    facts: facts({ url: PORTAL + '?view=b', key: 'entry-online', id: 'id-1', index: 1, state: { item: 'item-1', view: 'b', filter: 'online' }, reading: '设备乙参数 r1', eventSeq: 4 })
  });
  assert.equal(back.change, 'history');
  assert.equal(back.historyItem.key, 'entry-online');
  assert.equal(back.filter, 'online');
});

test('只有锚点变化属于同文档变化，不是重新领取', async () => {
  const { capture } = captureWith();
  await loadPortal(capture);
  capture.navigatedWithinDocument({ navigationType: 'fragment', url: PORTAL + '#device-detail' });
  const record = await capture.report({
    kind: 'hashchange',
    facts: facts({ url: PORTAL + '#device-detail', key: 'entry-hash', index: 1, state: { item: 'item-h', view: 'a', filter: 'all' }, eventSeq: 2 })
  });
  assert.equal(record.classification, 'same-document-change');
  assert.equal(record.fresh, false);
  assert.equal(capture.ledger.latestConfirmed.order, 1);
});

test('跨文档返回的真实缓存恢复是恢复展示，不是新响应', async () => {
  const { capture } = captureWith();
  await loadPortal(capture);
  const route = await capture.report({
    kind: 'change',
    change: 'route',
    facts: facts({ url: PORTAL + '?view=b', key: 'entry-b', index: 1, state: { item: 'item-b', view: 'b', filter: 'online' }, reading: '设备乙参数 r1', eventSeq: 2 })
  });
  capture.frameNavigated({ type: 'Navigation', loaderId: 'loader-2', url: PORTAL + 'away' });
  const away = capture.ledger.records.at(-1);
  assert.equal(away.change, 'external-document');

  capture.frameNavigated({ type: 'BackForwardCacheRestore', loaderId: 'loader-1', url: PORTAL + '?view=b' });
  const restored = await capture.report({
    kind: 'pageshow',
    persisted: true,
    facts: facts({
      url: PORTAL + '?view=b',
      key: 'entry-b',
      index: 1,
      state: { item: 'item-b', view: 'b', filter: 'online' },
      reading: '设备乙参数 r1',
      basis: { kind: 'restored', source: 'bfcache', generation: 1 },
      lifecycle: { persisted: true },
      eventSeq: 3
    })
  });
  assert.equal(restored.classification, 'restored-display');
  assert.equal(restored.preview, true);
  assert.equal(restored.fresh, false);
  assert.equal(restored.confirmed, false);
  assert.equal(restored.navigation.type, 'restore');
  assert.equal(restored.historyItem.key, route.historyItem.key);
  assert.equal(capture.ledger.latestConfirmed.order, 1, '恢复展示不能自动升级成最新资料');
  assert.ok(capture.ledger.state().previews.some(value => value.entryKey === 'entry-b'));
});

test('恢复后重新确认才把同一历史项升级为最新资料', async () => {
  const { capture } = captureWith();
  await loadPortal(capture);
  await capture.report({
    kind: 'change',
    change: 'route',
    facts: facts({ url: PORTAL + '?view=b', key: 'entry-b', index: 1, state: { item: 'item-b', view: 'b', filter: 'online' }, reading: '设备乙参数 r1', eventSeq: 2 })
  });
  capture.frameNavigated({ type: 'Navigation', loaderId: 'loader-2', url: PORTAL + 'away' });
  capture.frameNavigated({ type: 'BackForwardCacheRestore', loaderId: 'loader-1', url: PORTAL + '?view=b' });
  await capture.report({
    kind: 'pageshow',
    persisted: true,
    facts: facts({
      url: PORTAL + '?view=b', key: 'entry-b', index: 1,
      state: { item: 'item-b', view: 'b', filter: 'online' },
      reading: '设备乙参数 r1',
      basis: { kind: 'restored', source: 'bfcache', generation: 1 },
      lifecycle: { persisted: true },
      eventSeq: 3
    })
  });
  capture.networkSeen({ probe: 'probe-2', status: 200, generation: 2 });
  const confirmed = await capture.report({
    kind: 'reconfirm',
    facts: facts({
      url: PORTAL + '?view=b', key: 'entry-b', index: 1,
      state: { item: 'item-b', view: 'b', filter: 'online' },
      reading: '设备乙参数 r2',
      basis: { kind: 'network', source: 'snapshot', probe: 'probe-2', generation: 2, fresh: true },
      eventSeq: 4
    })
  });
  assert.equal(confirmed.classification, 'fresh-response');
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.upgradedFromPreview, true);
  assert.equal(capture.ledger.latestConfirmed.reading, '设备乙参数 r2');
  assert.equal(capture.ledger.latestConfirmed.generation, 2);
  assert.equal(capture.ledger.state().previews.length, 0);
});

test('序号倒退的迟到页面事件只留档，不回写当前历史项', async () => {
  const { capture } = captureWith();
  await loadPortal(capture);
  await capture.report({
    kind: 'change',
    change: 'route',
    facts: facts({ url: PORTAL + '?view=b', key: 'entry-b', index: 1, state: { item: 'item-b', view: 'b', filter: 'online' }, eventSeq: 2 })
  });
  const currentBefore = { ...capture.ledger.current };
  const stale = await capture.report({
    kind: 'change',
    change: 'filter',
    facts: facts({ url: PORTAL, key: 'entry-a', index: 0, state: { item: 'item-a', view: 'a', filter: 'all' }, reading: '设备甲参数 r1', eventSeq: 1 })
  });
  assert.equal(stale.kind, 'stale');
  assert.equal(stale.late, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.applied, false);
  assert.deepEqual(capture.ledger.current, currentBefore);
  assert.equal(capture.ledger.latestConfirmed.order, 1);
});

test('返回途中再次前进时，旧文档迟到的页面事件不会串到当前设备', async () => {
  const { capture } = captureWith();
  await loadPortal(capture);
  await capture.report({
    kind: 'change',
    change: 'route',
    facts: facts({ url: PORTAL + '?view=b', key: 'entry-b', index: 1, state: { item: 'item-b', view: 'b', filter: 'online' }, reading: '设备乙参数 r1', eventSeq: 2 })
  });
  capture.frameNavigated({ type: 'Navigation', loaderId: 'loader-2', url: PORTAL + 'away' });
  const awayRecord = capture.ledger.records.at(-1);
  assert.equal(awayRecord.change, 'external-document');

  // 返回尚未完成时用户又前进到 /away；此时旧文档的 popstate 迟到。
  capture.frameNavigated({ type: 'BackForwardCacheRestore', loaderId: 'loader-1', url: PORTAL + '?view=b' });
  capture.frameNavigated({ type: 'BackForwardCacheRestore', loaderId: 'loader-2', url: PORTAL + 'away' });
  const late = await capture.report({
    kind: 'popstate',
    facts: facts({
      url: PORTAL + '?view=b', key: 'entry-b', index: 1,
      state: { item: 'item-b', view: 'b', filter: 'online' },
      reading: '设备乙参数 r1', eventSeq: 3
    })
  });
  assert.equal(late.kind, 'late');
  assert.equal(late.applied, false);
  assert.equal(late.current, false);
  assert.equal(capture.ledger.currentEntryKey, 'entry-b', '迟到的旧页面事件不得改写当前历史项');
  assert.equal(capture.ledger.latestConfirmed.reading, '设备甲参数 r1');
});

test('现场复核发现页面已切换设备时，迟到的取数结果被归档', async () => {
  let live = null;
  const { capture } = captureWith({ verifyLive: async () => live });
  await loadPortal(capture);
  await capture.report({
    kind: 'change',
    change: 'route',
    facts: facts({ url: PORTAL + '?view=b', key: 'entry-b', index: 1, state: { item: 'item-b', view: 'b', filter: 'online' }, eventSeq: 2 })
  });
  live = { document: 'doc-1', eventSeq: 4, entry: { key: 'entry-c', index: 2 } };
  const stale = await capture.report({
    kind: 'change',
    change: 'filter',
    facts: facts({
      url: PORTAL + '?view=b', key: 'entry-b', index: 1,
      state: { item: 'item-b', view: 'b', filter: 'offline' }, reading: '设备乙参数 r1', eventSeq: 3
    })
  });
  assert.equal(stale.kind, 'stale');
  assert.equal(stale.basis.kind, 'stale');
  assert.ok(stale.basis.detail.length > 0);
  assert.equal(capture.ledger.latestConfirmed.order, 1);
});

test('普通 pageshow 不是重新领取，不产生结果', async () => {
  const { capture, records } = captureWith();
  await loadPortal(capture);
  const count = records.length;
  const ignored = await capture.report({
    kind: 'pageshow',
    persisted: false,
    facts: facts({ reading: '设备甲参数 r1', eventSeq: 2 })
  });
  assert.equal(ignored, null);
  assert.equal(records.length, count);
  assert.ok(capture.state().ignored.some(value => /pageshow/.test(value.reason)));
});

test('账本不会因迟到或恢复展示把最新资料倒退', () => {
  const ledger = new ObservationLedger({ session: 's' });
  const base = {
    url: PORTAL, document: 'doc-1', historyItem: historyItemIdentity({ key: 'k1', index: 0 }, { item: 'i1', view: 'a', filter: 'all' }),
    reason: 'load', reading: '设备甲参数 r2', view: 'a', filter: 'all', classification: 'fresh-response',
    basis: { kind: 'network', verified: true, generation: 2 }, current: true
  };
  ledger.ingest(base);
  ledger.ingest({ ...base, order: null, classification: 'restored-display', reading: '设备甲参数 r1', basis: { kind: 'restored', generation: 1 } });
  ledger.ingest({ ...base, classification: 'same-document-change', reading: '设备甲参数 r1', basis: { kind: 'retained' } });
  assert.equal(ledger.latestConfirmed.reading, '设备甲参数 r2');
  assert.equal(ledger.latestConfirmed.generation, 2);
  assert.equal(ledger.order, 3);
});

test('结果分类覆盖新响应、同文档变化和恢复展示三类业务含义', () => {
  assert.equal(classifyObservation({ basis: { kind: 'network', verified: true } }), 'fresh-response');
  assert.equal(classifyObservation({ change: 'route', basis: { kind: 'retained' } }), 'same-document-change');
  assert.equal(classifyObservation({ lifecycle: { pageshowPersisted: true }, basis: { kind: 'restored' } }), 'restored-display');
  assert.equal(classifyObservation({ basis: { kind: 'network', verified: false } }), 'unverified-response');
  assert.equal(classifyObservation({ basis: { kind: 'network', verified: true, ok: false } }), 'failed-response');
});
