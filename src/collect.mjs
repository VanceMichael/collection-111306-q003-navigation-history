import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { ObservationLedger, navigationObservation } from './domain.mjs';

export const BFCACHE_FLAGS = [
  '--enable-features=BackForwardCache',
  '--disable-features=BackForwardCacheMemoryControls'
];
export const DISABLED_BY_PLAYWRIGHT = ['--disable-back-forward-cache'];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export function portalPath(value) {
  try { return new URL(value).pathname; } catch { return null; }
}

/**
 * Playwright 默认传入 --disable-back-forward-cache，普通无头模式也不会主动启用缓存。
 * 演示与测试移除该默认参数，让跨文档后退真实触发 pageshow.persisted；
 * 无法启用时退回普通启动，由页面事实与导航事实判断是否恢复，不伪造恢复。
 */
export async function launchCaptureBrowser({ headless = true, bfcache = true, ...options } = {}) {
  if (!bfcache) return chromium.launch({ headless, ...options });
  try {
    return await chromium.launch({
      ...options,
      headless,
      channel: 'chromium',
      ignoreDefaultArgs: DISABLED_BY_PLAYWRIGHT,
      args: [...BFCACHE_FLAGS, ...(options.args ?? [])]
    });
  } catch {
    return chromium.launch({ headless, ...options });
  }
}

/**
 * 导航观察的连续状态机。
 *
 * 输入：
 * - CDP 主框架导航：区分新文档、普通跨文档跳转与 BackForwardCacheRestore；
 * - CDP 同文档导航：确认路由、锚点和历史移动发生在同一文档内；
 * - 页面上报：携带 Navigation API 历史项 key、文档身份、事件序号和取数依据；
 * - 采集器亲眼看到的 /api/snapshot 响应：作为“确有新网络响应”的核对证据；
 * - 上报后的现场复核：页面当前文档、历史项与事件序号必须仍与该上报一致。
 *
 * 输出：每条结果都带 navEpoch（哪次导航）、historyItem（哪个历史项）、
 * document（哪份文档）与 basis（实际取数依据）。
 *
 * 迟到、交错、序号倒退或已被后续导航取代的页面事件只留档为 stale/late，
 * 不更新当前历史项，也不推进最新资料，保证采集状态不倒退、不串设备。
 */
export class NavigationCapture {
  constructor({
    session = randomUUID(),
    ledger = null,
    clock = () => Date.now(),
    onRecord = null,
    verifyLive = null,
    settleMs = 40,
    settleTimeout = 400
  } = {}) {
    this.session = session;
    this.clock = clock;
    this.ledger = ledger ?? new ObservationLedger({ session });
    this.onRecord = onRecord;
    this.verifyLive = verifyLive;
    this.settleMs = settleMs;
    this.settleTimeout = settleTimeout;
    this.epoch = 0;
    this.traceOrder = 0;
    this.lastTrace = null;
    this.lastTraceAt = 0;
    this.current = null;
    this.documents = new Map();
    this.loaderDocuments = new Map();
    this.pendingLoads = [];
    this.pendingRestores = [];
    this.network = new Map();
    this.ignored = [];
    this.reportQueue = Promise.resolve();
  }

  commit(record) {
    if (record && this.onRecord) this.onRecord(record);
    return record;
  }

  frameNavigated({ type = 'Navigation', loaderId, url }) {
    const trace = this.pushTrace({ kind: 'frame', type, loaderId, url });
    const knownDocument = this.loaderDocuments.get(loaderId) ?? null;
    this.prunePending();

    if (portalPath(url) !== '/') {
      this.noteDeparture();
      this.epoch += 1;
      const restored = type === 'BackForwardCacheRestore';
      const record = this.commit(this.ledger.ingest(navigationObservation({
        kind: 'navigation',
        session: this.session,
        navEpoch: this.epoch,
        url,
        document: `loader:${loaderId}`,
        historyItem: { key: null, id: null, index: null, url, external: true },
        reason: 'document',
        change: restored ? 'external-restore' : 'external-document',
        navigation: { epoch: this.epoch, type: restored ? 'restore' : 'load', via: 'cdp', loaderId },
        basis: { kind: 'external-document', source: 'cdp', restored },
        classification: 'document-navigation',
        current: false,
        applied: false,
        receivedAt: this.clock()
      })));
      this.current = { kind: 'external', document: `loader:${loaderId}`, loaderId };
      return record;
    }

    if (knownDocument) this.pendingRestores.push({ loaderId, document: knownDocument, trace, order: trace.order });
    else this.pendingLoads.push({ loaderId, url, trace, order: trace.order });
    return null;
  }

  navigatedWithinDocument({ navigationType, url }) {
    this.pushTrace({ kind: 'within', navigationType, url });
  }

  pushTrace(trace) {
    this.traceOrder += 1;
    this.lastTrace = { ...trace, order: this.traceOrder, at: this.clock() };
    this.lastTraceAt = this.clock();
    return this.lastTrace;
  }

  /** 未对上页面事实的旧导航帧只保留最近几条，避免快速往返时无限增长。 */
  prunePending() {
    const oldest = this.traceOrder - 8;
    this.pendingLoads = this.pendingLoads.filter(entry => entry.order > oldest);
    this.pendingRestores = this.pendingRestores.filter(entry => entry.order > oldest);
  }

  networkSeen({ probe, status = null, generation = null, at = this.clock() }) {
    if (!probe) return null;
    const evidence = { probe, status, ok: status !== null && status >= 200 && status < 300, generation, at };
    this.network.set(probe, evidence);
    return evidence;
  }

  async waitForEvidence(probe, timeout = 1000) {
    const started = this.clock();
    while (!this.network.has(probe) && this.clock() - started < timeout) await sleep(5);
    return this.network.get(probe) ?? null;
  }

  /** 等到浏览器导航事实安静下来，再复核页面现场；快速连续前进后退的迟到事件由此暴露。 */
  async settle() {
    const started = this.clock();
    while (this.clock() - started < this.settleTimeout) {
      const idle = this.clock() - this.lastTraceAt;
      if (idle >= this.settleMs) return true;
      await sleep(Math.min(this.settleMs - idle, 10));
    }
    return false;
  }

  noteDeparture() {
    if (this.current?.kind !== 'portal') return null;
    const document = this.documents.get(this.current.document);
    if (!document) return null;
    document.departureSeq = Math.max(document.departureSeq ?? 0, document.lastSeq ?? 0);
    document.departures = (document.departures ?? 0) + 1;
    document.leftAt = this.clock();
    return document;
  }

  takePendingRestore(document) {
    const index = this.pendingRestores.findIndex(entry => entry.document === document.document);
    return index < 0 ? null : this.pendingRestores.splice(index, 1)[0];
  }

  takePendingLoad(url) {
    const index = this.pendingLoads.findIndex(entry => entry.url === url);
    return index < 0 ? null : this.pendingLoads.splice(index, 1)[0];
  }

  report(report) {
    const work = this.reportQueue.then(() => this.handleReport(report));
    this.reportQueue = work.catch(() => {});
    return work;
  }

  async handleReport(report) {
    const claimed = report?.facts?.basis;
    if (claimed?.probe) await this.waitForEvidence(claimed.probe);
    await this.settle();

    const facts = report?.facts;
    if (!facts?.document || !facts.entry?.key) {
      this.ignored.push({ reason: '缺少文档或历史项身份', kind: report?.kind ?? null });
      return null;
    }

    // 离场事实只用于标记录像点：此后同一文档的新序号才可能是一次真正的恢复。
    if (report.kind === 'pagehide') {
      const document = this.documents.get(facts.document);
      if (document) {
        document.departureSeq = Math.max(document.departureSeq ?? 0, document.lastSeq ?? 0);
        document.departures = (document.departures ?? 0) + 1;
        document.persistence = report.persisted === true ? 'bfcache' : 'unload';
      }
      return null;
    }

    const stale = await this.isStale(report, facts);
    if (stale) return this.archive(report, facts, { kind: 'stale', reason: stale });

    const seq = Number(facts.eventSeq ?? 0);
    const persisted = report.persisted === true || facts.lifecycle?.persisted === true;
    const restored = report.kind === 'pageshow' && persisted;

    if (!restored && report.kind === 'pageshow') {
      this.ignored.push({ reason: '普通 pageshow 不是重新领取', document: facts.document, seq });
      return null;
    }

    const placement = this.place(report, facts, { restored, seq });
    if (placement.late) return this.archive(report, facts, { kind: 'late', reason: placement.reason, navigation: placement.navigation });

    const document = placement.document;
    document.lastSeq = Math.max(document.lastSeq ?? 0, seq);
    if (restored) document.restoredAt = this.clock();
    this.current.entryKey = facts.entry.key;

    return this.commit(this.ledger.ingest(navigationObservation({
      kind: 'result',
      session: this.session,
      navEpoch: placement.navigation?.epoch ?? this.epoch,
      url: facts.url,
      document: facts.document,
      documentOrder: facts.documentOrder ?? null,
      historyItem: this.historyItem(facts),
      reason: report.kind,
      change: this.changeFor(report, facts, persisted, placement.navigation),
      navigation: placement.navigation,
      basis: this.basisFor(facts, { restored }),
      reading: facts.reading ?? null,
      view: facts.view ?? null,
      filter: facts.filter ?? null,
      lifecycle: facts.lifecycle ?? { pageshowPersisted: persisted },
      eventAt: Number.isFinite(report.at) ? report.at : null,
      receivedAt: this.clock(),
      current: true,
      signals: [
        report.kind === 'pageshow' ? `pageshow.persisted=${persisted}` : null,
        `navigation:${placement.navigation?.type ?? 'unknown'}`,
        `trace:${placement.trace?.kind ?? 'none'}@${placement.trace?.order ?? 0}`
      ].filter(Boolean)
    })));
  }

  /**
   * 现场复核：页面现在的文档、历史项或事件序号只要已经离开该上报，这条上报就是迟到的。
   * 没有导航事实变化时不额外扩大等待，保持原有查看体验。
   */
  async isStale(report, facts) {
    if (Number(facts.eventSeq ?? 0) <= 0) return null;
    const document = this.documents.get(facts.document);
    if (document && Number(facts.eventSeq) <= (document.lastSeq ?? 0)) return '事件序号倒退';
    if (!this.verifyLive) return null;
    const live = await this.verifyLive();
    if (!live) return null;
    if (live.document !== facts.document) return '页面已切到其它文档';
    const liveSeq = Number(live.eventSeq ?? 0);
    if (liveSeq > Number(facts.eventSeq)) return '页面已有更新的观察';
    if (live.entry?.key !== facts.entry.key) {
      const expectedIndex = facts.entry?.index;
      if (live.entry?.index !== expectedIndex) return '历史项已改变';
    }
    return null;
  }

  place(report, facts, { restored, seq }) {
    let document = this.documents.get(facts.document);
    let late = false;
    let reason = null;
    let navigation = null;
    let trace = this.lastTrace;

    // persisted 的 pageshow 只由浏览器恢复产生，页面无法伪造；同一次恢复若重复上报，
    // 序号不会增加。因此以“序号前进”判定真正的新恢复，不依赖外部文档帧到达的先后。
    if (document && restored) {
      if (seq > (document.lastSeq ?? 0)) {
        const pending = this.takePendingRestore(document);
        document.departureSeq = 0;
        this.epoch += 1;
        navigation = {
          epoch: this.epoch,
          type: 'restore',
          via: pending ? 'cdp' : 'page',
          loaderId: document.loaderId,
          pageNavigationType: facts.pageNavigationType ?? null
        };
        this.current = { kind: 'portal', document: facts.document, loaderId: document.loaderId };
        return { document, late, reason, navigation, trace: pending?.trace ?? trace };
      }
      late = true;
      reason = '重复的恢复事件';
      return { document, late, reason, navigation, trace };
    }

    if (!document) {
      const pendingLoad = this.takePendingLoad(facts.url);
      const currentPortal = this.current?.kind === 'portal' ? this.documents.get(this.current.document) : null;
      const newerDocument = Number.isFinite(facts.documentOrder) && Number.isFinite(currentPortal?.order)
        ? facts.documentOrder > currentPortal.order
        : false;
      const canStart = Boolean(pendingLoad) || restored || !this.current || this.current.kind === 'external' || newerDocument;
      if (!canStart) {
        late = true;
        reason = '旧文档的上报晚于当前文档';
      } else {
        document = {
          document: facts.document,
          loaderId: pendingLoad?.loaderId ?? null,
          order: Number.isFinite(facts.documentOrder) ? facts.documentOrder : null,
          lastSeq: 0,
          departureSeq: 0,
          firstAt: this.clock(),
          url: facts.url
        };
        this.documents.set(facts.document, document);
        if (document.loaderId) this.loaderDocuments.set(document.loaderId, facts.document);
        this.epoch += 1;
        navigation = {
          epoch: this.epoch,
          type: restored ? 'restore' : 'load',
          via: pendingLoad ? 'cdp' : 'page',
          loaderId: document.loaderId,
          pageNavigationType: facts.pageNavigationType ?? null
        };
        this.current = { kind: 'portal', document: facts.document, loaderId: document.loaderId };
      }
    } else if (this.current?.kind === 'portal' && this.current.document === facts.document) {
      navigation = {
        epoch: this.epoch,
        type: 'same-document',
        via: 'navigation-api',
        loaderId: document.loaderId,
        pageNavigationType: facts.pageNavigationType ?? null
      };
    } else {
      const pendingRestore = this.takePendingRestore(document);
      const restoreFrame = pendingRestore?.trace ?? null;
      const traceMatches = Boolean(restoreFrame) && restoreFrame.type === 'BackForwardCacheRestore' &&
        restoreFrame.order === trace?.order;
      const returningToThisDocument = this.current?.kind === 'external' &&
        trace?.kind === 'frame' && trace.url === document.url && portalPath(trace.url) === '/' &&
        trace.type === 'BackForwardCacheRestore';
      const advanced = seq > (document.departureSeq ?? 0);
      if (traceMatches && advanced) {
        document.departureSeq = 0;
        this.epoch += 1;
        navigation = {
          epoch: this.epoch,
          type: 'restore',
          via: 'cdp',
          loaderId: document.loaderId,
          pageNavigationType: facts.pageNavigationType ?? null
        };
        trace = restoreFrame;
        this.current = { kind: 'portal', document: facts.document, loaderId: document.loaderId };
      } else if (restored && returningToThisDocument && advanced) {
        document.departureSeq = 0;
        this.epoch += 1;
        navigation = {
          epoch: this.epoch,
          type: 'restore',
          via: 'page',
          loaderId: document.loaderId,
          pageNavigationType: facts.pageNavigationType ?? null
        };
        this.current = { kind: 'portal', document: facts.document, loaderId: document.loaderId };
      } else {
        late = true;
        reason = '该文档已不是当前文档';
      }
    }

    return { document, late, reason, navigation, trace };
  }

  archive(report, facts, { kind, reason, navigation = null }) {
    this.ignored.push({ reason, kind: report.kind, document: facts.document, entry: facts.entry.key, seq: facts.eventSeq ?? null });
    return this.commit(this.ledger.ingest(navigationObservation({
      kind,
      classification: kind === 'late' ? 'late-event' : 'stale-event',
      session: this.session,
      navEpoch: navigation?.epoch ?? this.epoch,
      url: facts.url,
      document: facts.document,
      documentOrder: facts.documentOrder ?? null,
      historyItem: this.historyItem(facts),
      reason: report.kind,
      change: kind === 'late' ? 'late-event' : 'stale-event',
      navigation,
      basis: { kind, source: 'page-event', seq: facts.eventSeq ?? null, detail: reason },
      reading: facts.reading ?? null,
      view: facts.view ?? null,
      filter: facts.filter ?? null,
      lifecycle: facts.lifecycle ?? null,
      late: kind === 'late',
      stale: kind === 'stale',
      current: false,
      applied: false,
      eventAt: Number.isFinite(report.at) ? report.at : null,
      receivedAt: this.clock()
    })));
  }

  historyItem(facts) {
    const state = facts.state ?? null;
    return {
      key: facts.entry.key,
      id: facts.entry.id ?? null,
      index: facts.entry.index ?? null,
      url: facts.entry.url ?? facts.url ?? null,
      item: state?.item ?? null,
      view: state?.view ?? null,
      filter: state?.filter ?? null
    };
  }

  basisFor(facts, { restored }) {
    if (restored) {
      return {
        kind: 'restored',
        source: 'bfcache',
        persisted: true,
        generation: facts.cachedGeneration ?? null,
        observedStatus: null,
        verified: false
      };
    }
    const claimed = facts.basis ?? { kind: 'unknown' };
    if (claimed.kind !== 'network') return { ...claimed, persisted: false };
    const evidence = this.network.get(claimed.probe);
    const verified = Boolean(
      evidence?.ok &&
      (claimed.generation == null || evidence.generation == null || claimed.generation === evidence.generation)
    );
    return {
      ...claimed,
      persisted: false,
      verified,
      observedStatus: evidence?.status ?? null,
      observedGeneration: evidence?.generation ?? null,
      observedAt: evidence?.at ?? null
    };
  }

  changeFor(report, facts, persisted, navigation) {
    if (navigation?.type === 'restore') return 'document-traverse';
    if (report.kind === 'pageshow') return persisted ? 'document-traverse' : 'pageshow';
    if (report.kind === 'popstate') return 'history';
    if (report.kind === 'hashchange') return 'hash';
    if (report.kind === 'reconfirm') return 'reconfirmed';
    if (report.kind === 'change') return report.change ?? 'state';
    if (report.kind === 'load') {
      const pageType = facts.pageNavigationType ?? null;
      if (pageType === 'back_forward') return 'document-back-forward';
      if (pageType === 'reload') return 'document-reload';
      return 'load';
    }
    return report.kind ?? 'unknown';
  }

  state() {
    return {
      session: this.session,
      epoch: this.epoch,
      traceOrder: this.traceOrder,
      lastTrace: this.lastTrace ? { ...this.lastTrace } : null,
      ignored: this.ignored.slice(),
      ledger: this.ledger.state(),
      documents: [...this.documents.values()].map(value => ({ ...value }))
    };
  }
}

/**
 * 在一个浏览器会话里连续跟随导航：同文档路由、同地址新历史项、筛选变化、锚点、
 * 跨文档往返、BFCache 恢复、重新确认与迟到的页面事件都写入同一条接收序列。
 */
export async function followPortal({
  url,
  browser = null,
  store = null,
  headless = true,
  bfcache = true,
  launch = null,
  onRecord = null,
  readyTimeout = 20000,
  settleMs = 40
} = {}) {
  if (!store) throw new Error('连续采集需要接收文件');
  const ownedBrowser = browser ? null : (launch ? await launch() : await launchCaptureBrowser({ headless, bfcache }));
  const activeBrowser = browser ?? ownedBrowser;
  const context = await activeBrowser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const pending = [];
  let capture;

  const verifyLive = async () => {
    try {
      return await page.evaluate(() => (window.__captureFacts ? window.__captureFacts() : null));
    } catch {
      return null;
    }
  };

  capture = new NavigationCapture({ verifyLive, settleMs });

  await context.exposeBinding('__captureReport', (_source, report) => {
    const work = capture.report(report).then(async record => {
      if (!record) return null;
      await store.append(record);
      if (onRecord) await onRecord(record);
      return record;
    });
    pending.push(work.catch(() => {}));
    return work.catch(() => null);
  });

  await cdp.send('Page.enable');
  cdp.on('Page.frameNavigated', event => {
    if (event.frame.parentId) return;
    if (event.frame.url === 'about:blank') return;
    capture.frameNavigated({ type: event.type, loaderId: event.frame.loaderId, url: event.frame.url });
  });
  cdp.on('Page.navigatedWithinDocument', event => {
    capture.navigatedWithinDocument({ navigationType: event.navigationType, url: event.url });
  });

  context.on('response', async response => {
    const probe = parseSnapshotProbe(response.url());
    if (!probe) return;
    let generation = null;
    try { generation = (await response.json()).generation ?? null; } catch {}
    capture.networkSeen({ probe, status: response.status(), generation });
  });
  context.on('requestfailed', request => {
    const probe = parseSnapshotProbe(request.url());
    if (probe) capture.networkSeen({ probe, status: 0, generation: null });
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.portalReady === true, null, { timeout: readyTimeout });

  return {
    capture,
    page,
    context,
    browser: activeBrowser,
    state() { return capture.state(); },
    async settle() { await Promise.all(pending); await capture.reportQueue; },
    async close({ keepBrowser = Boolean(browser) } = {}) {
      await Promise.all(pending);
      await capture.reportQueue;
      await context.close().catch(() => {});
      if (!keepBrowser && ownedBrowser) await ownedBrowser.close();
    }
  };
}

function parseSnapshotProbe(value) {
  try {
    const parsed = new URL(value);
    return parsed.pathname === '/api/snapshot' ? parsed.searchParams.get('probe') : null;
  } catch { return null; }
}

export { ObservationLedger, navigationObservation };
