import { resolve } from 'node:path';
import { startSource } from './source.mjs';
import { followPortal, launchCaptureBrowser } from './collect.mjs';
import { CaptureStore } from './store.mjs';

const path = resolve(process.env.CAPTURE_PATH ?? 'var/captures.json');
const store = new CaptureStore(path);
const source = await startSource();
let session = null;
const steps = [];

const label = {
  'fresh-response': '新的响应',
  'same-document-change': '同文档变化',
  'restored-display': '浏览器恢复的展示',
  'document-navigation': '换文档',
  'unverified-response': '缺证据的响应',
  'failed-response': '取数失败',
  pending: '取数未完成',
  unknown: '未识别'
};

function step(text) { steps.push(text); }

function describe(record) {
  return {
    序号: record.order,
    结果: label[record.classification] ?? record.classification,
    分类: record.classification,
    变化: record.change,
    导航: record.navigation?.type ?? null,
    文档: record.document,
    历史项: record.historyItem?.key ?? null,
    历史序号: record.historyItem?.index ?? null,
    筛选: record.filter ?? null,
    可见内容: record.reading ?? null,
    取数依据: record.basis
      ? {
          种类: record.basis.kind,
          来源: record.basis.source ?? null,
          代号: record.basis.probe ?? null,
          状态: record.basis.observedStatus ?? null,
          数据代次: record.basis.generation ?? null,
          核对: record.basis.verified ?? null
        }
      : null,
    新响应: record.fresh,
    可视为最新: record.confirmed,
    仅预览: record.preview,
    迟到: record.late || undefined,
    过期: record.stale || undefined
  };
}

try {
  session = await followPortal({ url: source.url, store, bfcache: true });
  const { page, capture } = session;

  step('打开门户并取得初始资料');
  await page.waitForFunction(() => window.portalReady === true);

  step('切到乙设备（同文档路由）');
  await page.click('#to-b');
  await page.waitForFunction(() => document.querySelector('#reading').textContent === '设备乙参数 r1');

  step('把筛选改为在线（同文档新历史项）');
  await page.selectOption('#filter', 'online');
  await page.waitForFunction(() => document.querySelector('#filter-label').textContent === '在线');

  step('点“相同地址新历史项”，筛选改为离线');
  await page.click('#same-url');
  await page.waitForFunction(() => document.querySelector('#filter-label').textContent === '离线');

  step('跳到设备详情锚点（只改锚点）');
  await page.click('#anchor');
  await page.waitForTimeout(100);

  step('供方发布 r2，但不刷新已打开页面');
  await fetch(source.url + '/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'publish' })
  });

  step('打开另一份文档 /away，再后退回门户（浏览器缓存恢复）');
  await page.click('#away');
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === '设备资料说明');
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForTimeout(300);
  await session.settle();
  const restored = capture.ledger.records.filter(record => record.classification === 'restored-display').at(-1) ?? null;
  const previewState = restored
    ? {
        页面可见: restored.reading,
        历史项: restored.historyItem.key,
        筛选: restored.filter,
        资料代次: restored.basis?.generation ?? null,
        可视为最新: restored.confirmed,
        当时的最新资料: capture.ledger.latestConfirmed?.reading ?? null
      }
    : null;

  step('在恢复的页面上点“重新确认最新资料”');
  await page.click('#reconfirm');
  await page.waitForFunction(() => document.querySelector('#reading').textContent === '设备乙参数 r2');
  await session.settle();

  step('在恢复后的历史里后退两次，旧历史项的筛选条件随历史项恢复');
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForTimeout(120);
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForTimeout(200);
  await session.settle();

  const records = capture.ledger.records;
  const unconfirmed = records
    .filter(record => !record.confirmed && record.kind !== 'navigation')
    .map(record => ({
      序号: record.order,
      分类: record.classification,
      原因: record.classification === 'restored-display'
        ? '浏览器恢复的旧展示，没有新的网络响应；需重新确认才能升级'
        : record.classification === 'same-document-change'
          ? '同文档内的变化，沿用已取到的资料，不是新的响应'
          : record.basis?.detail ?? record.reason
    }));

  console.log(JSON.stringify({
    资料源: source.url,
    接收文件: path,
    会话: capture.session,
    浏览器缓存恢复: true,
    操作: steps,
    结果: records.map(describe),
    恢复时预览: previewState,
    最新资料: capture.ledger.latestConfirmed,
    恢复预览: capture.ledger.state().previews,
    未确认项: unconfirmed,
    忽略的页面事件: capture.state().ignored,
    已存记录: (await store.read()).revision
  }, null, 2));
} finally {
  if (session) await session.close();
  await source.close();
}
