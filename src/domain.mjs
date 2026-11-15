const SAME_DOCUMENT_CHANGES = new Set([
  'route', 'same-url', 'filter', 'hash', 'history', 'history-traverse', 'retained'
]);
const DOCUMENT_CHANGES = new Set([
  'initial', 'load', 'reload', 'document', 'document-load', 'document-traverse',
  'document-reload', 'document-navigation'
]);

/**
 * 每个结果只落到三类业务含义：真正的新响应、同文档内的变化、浏览器恢复的旧展示。
 * 另外保留 document-navigation（换了文档但尚无取数依据）、pending（取数尚未完成）、
 * failed-response（取数失败）、unverified-response（页面声称取数但缺少可核对网络证据）
 * 与 unknown，避免把“还不知道”伪装成“已确认”。
 *
 * pageshow 本身不是领取依据：恢复展示必须由 persisted 的 pageshow 或明确的恢复依据
 * 证明；普通文档加载则要看实际取数依据和采集器捕获到的网络证据，不能仅凭
 * “页面加载完成”就宣称刚取得最新值。
 */
export function classifyObservation({ reason, change, basis, lifecycle } = {}) {
  const movement = change ?? reason ?? null;
  if (basis?.preview === true || basis?.kind === 'restored') return 'restored-display';
  if (basis?.kind === 'network') {
    if (basis.ok === false) return 'failed-response';
    if (basis.verified !== true) return 'unverified-response';
    if (basis.fresh === false) return 'same-document-change';
    return 'fresh-response';
  }
  if (basis?.kind === 'loading' || basis?.kind === 'pending') return 'pending';
  if (basis?.kind === 'retained' || SAME_DOCUMENT_CHANGES.has(movement)) return 'same-document-change';
  if (lifecycle?.pageshowPersisted === true) return 'restored-display';
  if (DOCUMENT_CHANGES.has(movement) || basis?.kind === 'document') return 'document-navigation';
  return 'unknown';
}

export function isSameDocumentChange(change) {
  return SAME_DOCUMENT_CHANGES.has(change);
}

/**
 * 历史项身份以 Navigation API 的 entry.key 为准：同一地址的两个历史项 key 不同，
 * 跨文档往返恢复同一个历史项时 key 保持不变。item 是门户在历史项里保存的状态标识，
 * filter 是同一地址不同历史项可以保留的不同筛选条件。
 */
export function historyItemIdentity(entry, state = null) {
  return {
    key: entry?.key ?? null,
    id: entry?.id ?? null,
    index: entry?.index ?? null,
    url: entry?.url ?? null,
    item: state?.item ?? null,
    view: state?.view ?? null,
    filter: state?.filter ?? null
  };
}

/**
 * 一次观察的身份：哪次导航、哪个历史项、哪份文档、什么取数依据。
 * fresh 表示本次观察确实取得了新的网络响应；confirmed 还要求该响应可核对、
 * 未被迟到事件或后续导航取代。恢复展示可预览，但 fresh/confirmed 都为 false，
 * 未经重新确认不会自动升级成最新资料。
 */
export function navigationObservation({
  id = null,
  kind = 'result',
  session = null,
  sequence = null,
  epoch = null,
  navEpoch = null,
  url,
  document,
  documentOrder = null,
  historyItem,
  reason,
  change = null,
  navigation = null,
  basis = null,
  reading = null,
  candidateReading = null,
  view = null,
  filter = null,
  lifecycle = null,
  classification = null,
  fresh = null,
  confirmed = null,
  preview = null,
  current = true,
  applied = null,
  late = false,
  stale = false,
  superseded = false,
  supersededBy = null,
  upgradedFromPreview = false,
  eventAt = null,
  receivedAt = null,
  order = null,
  signals = null
} = {}) {
  if (!document || !historyItem) throw new Error('观察身份不完整');
  const movement = change ?? reason ?? null;
  const result = classification ?? classifyObservation({ reason, change: movement, basis, lifecycle });
  const networkVerified = result === 'fresh-response' && basis?.kind === 'network' && basis?.verified === true;
  const isPreview = preview ?? result === 'restored-display';
  const isFresh = fresh ?? result === 'fresh-response';
  const isConfirmed = confirmed ?? (networkVerified && current && !late && !stale && superseded !== true);
  return {
    id,
    kind,
    session,
    sequence,
    epoch,
    navEpoch,
    url,
    document,
    documentOrder,
    historyItem,
    reason,
    change: movement,
    navigation,
    basis,
    reading,
    candidateReading,
    view,
    filter,
    lifecycle,
    classification: result,
    fresh: isFresh,
    confirmed: isConfirmed,
    preview: isPreview,
    current,
    applied: applied ?? (current && !late && !stale && superseded !== true),
    late,
    stale,
    superseded,
    supersededBy,
    upgradedFromPreview,
    eventAt,
    receivedAt,
    order,
    signals: signals ?? []
  };
}

function summarize(record) {
  return {
    order: record.order,
    navEpoch: record.navEpoch,
    entryKey: record.historyItem?.key ?? null,
    document: record.document,
    change: record.change,
    classification: record.classification,
    reading: record.reading,
    view: record.view,
    filter: record.filter,
    generation: record.basis?.generation ?? null,
    fresh: record.fresh,
    confirmed: record.confirmed,
    preview: record.preview
  };
}

/**
 * 接收状态账本。只有当前、未迟到、未过期且可核对的新响应能推进“最新资料”；
 * 同文档变化和恢复展示只更新当前展示。迟到的观察仍留档，但不能回写当前历史项，
 * 也不能把旧设备的可见内容串到当前设备。
 */
export class ObservationLedger {
  constructor({ session = null, latestConfirmed = null } = {}) {
    this.session = session;
    this.order = 0;
    this.records = [];
    this.currentEntryKey = null;
    this.current = null;
    this.latestConfirmed = latestConfirmed;
    this.previews = new Map();
    this.confirmedEntries = new Map();
  }

  ingest(observation) {
    const order = ++this.order;
    const record = { ...observation, session: this.session, order };
    const entryKey = record.historyItem?.key ?? null;
    const archived = record.late === true || record.stale === true || record.superseded === true || record.current === false;

    if (archived) {
      record.applied = false;
      record.confirmed = false;
      record.fresh = record.classification === 'fresh-response';
      record.preview = record.classification === 'restored-display';
      record.ledger = this.state();
      this.records.push(record);
      return record;
    }

    if (entryKey) this.currentEntryKey = entryKey;

    if (record.classification === 'restored-display') {
      record.preview = true;
      record.fresh = false;
      record.confirmed = false;
      record.applied = true;
      if (entryKey) {
        this.previews.set(entryKey, {
          order,
          entryKey,
          document: record.document,
          reading: record.reading,
          view: record.view,
          filter: record.filter,
          generation: record.basis?.generation ?? null,
          source: record.basis?.source ?? 'browser-restore'
        });
      }
      this.current = summarize(record);
    } else if (record.classification === 'fresh-response') {
      record.preview = false;
      record.fresh = true;
      record.confirmed = true;
      record.applied = true;
      if (entryKey) {
        const previous = this.previews.get(entryKey);
        record.upgradedFromPreview = Boolean(previous && previous.order < order);
        this.previews.delete(entryKey);
        this.confirmedEntries.set(entryKey, {
          order,
          entryKey,
          document: record.document,
          reading: record.reading,
          view: record.view,
          filter: record.filter,
          generation: record.basis?.generation ?? null,
          source: 'network'
        });
      }
      this.latestConfirmed = summarize(record);
      this.current = summarize(record);
    } else {
      record.preview = false;
      record.fresh = false;
      record.confirmed = false;
      record.applied = true;
      this.current = summarize(record);
    }

    record.ledger = this.state();
    this.records.push(record);
    return record;
  }

  state() {
    return {
      session: this.session,
      observations: this.records.length,
      currentEntryKey: this.currentEntryKey,
      current: this.current,
      latestConfirmed: this.latestConfirmed,
      previews: [...this.previews.values()].map(value => ({ ...value })),
      confirmedEntries: this.confirmedEntries.size
    };
  }
}

export function preview(data) { return { generation: data.generation, views: Object.keys(data.views) }; }
