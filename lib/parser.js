'use strict';

/**
 * 中文快递短信解析器
 * 支持菜鸟驿站 / 妈妈驿站 / 快递超市 / 兔喜 / 多多买菜 / 美团优选 / 京东 / 顺丰 / 丰巢 / 极兔 等常见格式
 */

const CARRIERS = [
  ['中通', /中通/],
  ['圆通', /圆通/],
  ['申通', /申通/],
  ['韵达', /韵达/],
  ['顺丰', /顺丰/],
  ['京东', /京东/],
  ['邮政', /邮政|EMS/],
  ['极兔', /极兔/],
  ['德邦', /德邦/],
  ['丹鸟', /丹鸟/],
  ['菜鸟', /菜鸟/],
  ['丰巢', /丰巢/],
  ['天猫', /天猫/],
  ['盒马', /盒马/],
  ['苏宁', /苏宁/],
  ['多多买菜', /多多买菜/],
  ['多多代收点', /多多代收点/],
  ['美团优选', /美团优选/],
  ['淘菜菜', /淘菜菜/],
  ['拼多多', /拼多多/],
];

const PREFIX_CARRIER = {
  YT: '圆通',
  SF: '顺丰',
  JD: '京东',
  ST: '申通',
  ZT: '中通',
  JT: '极兔',
  YD: '韵达',
  DB: '德邦',
  DP: '德邦',
  HT: '百世',
};

const CODE_RE = /(?:取件码|取货码|提货码|取件密码|取件编号)[:：为是]?\s*([0-9A-Za-z][0-9A-Za-z\-]{2,11})/;
// 新式短信无"取件码"关键词：凭<货架码>到<门店>…取尾号<N>包裹（如 多多代收点/菜鸟）
const CODE_PING_RE = /凭\s*([0-9A-Za-z][0-9A-Za-z\-]{2,11})\s*(?=到|去|至|取件)/;
const CODE_TAIL_RE = /取尾号\s*([0-9A-Za-z]{2,8})/;
const TRACKING_LABELED_RE = /(?:单号|运单号|快递单号)[:：为]?\s*([A-Za-z0-9]{10,22})/;
const TRACKING_BARE_RE = /(?<![A-Za-z0-9])([A-Za-z]{2}\d{9,16}|[0-9]{12,15})(?![A-Za-z0-9])/;
const STORE_RE = /(?:已到达|已到|已入柜|到达|入柜|到货|投放至|放在|送至)(?:了|至)?[【\[]?([^，。；;！!\n]{1,26}?)(驿站|快递超市|超市|便利店|快递站|站点|门店|自提点|丰巢柜|丰巢|服务点|快递柜|营业部|快递)/;
const STORE_RE2 = /[到至]([^，。；;！!\n]{1,24}?(?:丰巢柜|丰巢|快递柜|自提点|驿站|快递超市|服务点|门店|营业部|快递))/;

/*
 * 门店名独立成行（购物 App / 驿站 App 的订单详情页常见）：
 *   「菜鸟驿站(阳光花园店)」「丰巢快递柜·1号柜」「XX驿站（北门）」
 * 要求整行只有门店名（可带括号补充说明），避免误吞正文。
 */
const STORE_LINE_RE = /^[【\[]?(?:[\u4e00-\u9fa5A-Za-z0-9·・\-]{1,20})?(?:驿站|快递超市|丰巢柜|丰巢|快递柜|自提点|服务点|便利店|驿站门店|营业部)(?:[（(][^）)]{1,20}[）)])?$/;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanStore(s) {
  if (!s) return '';
  return s
    .replace(/[【】\[\]（）()\s]/g, '')
    .replace(/[，。；;！!、]+$/g, '')
    .replace(/快递$/g, '')   // "到xx快递取尾号" 中"快递"不作为门店名
    .trim();
}

function parseTime(v) {
  if (!v) return new Date();
  if (typeof v === 'number') return new Date(v);
  const s = String(v).trim();
  if (/^\d{10,13}$/.test(s)) return new Date(Number(s) * (/^\d{10}$/.test(s) ? 1000 : 1));
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date() : d;
}

// ---------- 自定义规则（AI 模板学习） ----------
const CODE_CHAR = '[0-9A-Za-z][0-9A-Za-z\\-]{1,14}';

/**
 * 从教学样本生成自定义规则：定位取件码/门店在样本中的上下文锚点。
 * 例如样本「凭1-7-3351到xx」，code=1-7-3351 → codeBefore=凭, codeAfter=到
 * @param {string} sample 教学样本（原始短信）
 * @param {string} code 用户标注的取件码
 * @param {string} [store] 用户标注的门店（可选）
 */
export function buildCustomRule(sample, code, store) {
  if (!sample || !code) return null;
  const s = String(sample);
  const c = String(code).trim();
  const idx = s.indexOf(c);
  if (idx < 0) return null;
  const before = s.slice(0, idx);
  const after = s.slice(idx + c.length);
  // 锚点只取紧邻取件码的 1 个非空白字符：最通用（不依赖前缀/门店），最精准
  const beforeAnchor = (before.match(/(\S)$/)?.[1]) || '';
  const afterAnchor = (after.match(/^(\S)/)?.[1]) || '';
  if (!beforeAnchor && !afterAnchor) return null;

  let storeBefore = '';
  let storeAfter = '';
  let storeValue = '';
  if (store) {
    const sv = String(store).trim();
    if (sv) {
      const sidx = s.indexOf(sv);
      if (sidx >= 0) {
        const sb = s.slice(0, sidx);
        const sa = s.slice(sidx + sv.length);
        storeBefore = (sb.match(/(\S)$/)?.[1]) || '';
        storeAfter = (sa.match(/^(\S)/)?.[1]) || '';
        storeValue = sv;
      }
    }
  }
  return { codeBefore: beforeAnchor, codeAfter: afterAnchor, storeBefore, storeAfter, storeValue };
}

/**
 * 用自定义规则从文本中提取取件码/门店
 * @returns {{code: string, store: string, ruleId: string} | null}
 */
export function applyCustomRules(text, rules) {
  if (!text || !Array.isArray(rules) || rules.length === 0) return null;
  const t = String(text);
  for (const rule of rules) {
    let code = '';
    if (rule.codeBefore || rule.codeAfter) {
      const pat = (rule.codeBefore ? escapeRegExp(rule.codeBefore) : '') +
        '(' + CODE_CHAR + ')' +
        (rule.codeAfter ? escapeRegExp(rule.codeAfter) : '');
      const m = t.match(new RegExp(pat));
      if (m) code = m[1];
    }
    if (!code) continue;
    let store = rule.storeValue || '';
    if (!store && rule.storeBefore && rule.storeAfter) {
      const spat = escapeRegExp(rule.storeBefore) + '([^，。；;！!\\n]{1,24}?)' + escapeRegExp(rule.storeAfter);
      const sm = t.match(new RegExp(spat));
      if (sm) store = sm[1].trim();
    }
    return { code, store, ruleId: rule.id };
  }
  return null;
}

/**
 * 解析一条快递短信
 * @param {string} text 短信内容
 * @param {{from?: string, time?: string|number}} [meta] 发送方 / 时间
 * @param {Array} [rules] 自定义识别规则（AI 模板学习），内置规则失败时启用
 * @returns {{ok: boolean, reason?: string, platform?: string, carrier?: string, tracking?: string, code?: string, store?: string, arrivedAt?: string, raw?: string, ruleId?: string}}
 */
export function parseSms(text, meta = {}, rules = null) {
  const result = { ok: false, raw: text || '' };
  if (!text || typeof text !== 'string' || !text.trim()) {
    result.reason = '短信内容为空';
    return result;
  }
  const t = text.trim();

  // 平台：短信签名【...】优先，其次发送方号码/名称
  const tag = t.match(/^【([^】]{1,20})】/);
  result.platform = tag ? tag[1] : (meta.from ? String(meta.from).trim().slice(0, 20) : '');

  // 取件码：内置三级识别 → 自定义规则兜底
  let code = '';
  const cm1 = t.match(CODE_RE);
  const cm2 = t.match(CODE_PING_RE);
  const cm3 = t.match(CODE_TAIL_RE);
  if (cm1) code = cm1[1];
  else if (cm2) code = cm2[1];
  else if (cm3) code = cm3[1];
  let customHit = null;
  if (!code && rules) {
    customHit = applyCustomRules(t, rules);
    if (customHit) {
      code = customHit.code;
      result.ruleId = customHit.ruleId;
    }
  }
  if (!code) {
    result.reason = '未识别到取件码';
    return result;
  }
  result.code = code.replace(/-+$/, '');

  // 快递单号：直接在原文上提取。
  // 单号正则要求"单号"关键词前缀或 11 位以上字母数字，取件码（≤10 位）不会误匹配，
  // 因此无需先剔除取件码（剔除反而可能截断包含取件码数字的单号）。
  let tracking = '';
  const tn = t.match(TRACKING_LABELED_RE);
  if (tn) tracking = tn[1];
  if (!tracking) {
    const bare = t.match(TRACKING_BARE_RE);
    if (bare) tracking = bare[1];
  }
  result.tracking = tracking;

  // 取件门店：内置规则 → 独立成行的门店名 → 自定义规则 → 平台兜底
  let store = '';
  let sm = t.match(STORE_RE);
  if (sm) store = cleanStore(sm[1] + sm[2]);
  if (!store) {
    const sm2 = t.match(STORE_RE2);
    if (sm2) store = cleanStore(sm2[1]);
  }
  if (!store) {
    // 门店名独立成行（订单详情页常见）：逐行找形如「xx驿站(门店)」的整行
    for (const line of t.split(/\r?\n/)) {
      const ln = line.trim();
      if (ln && STORE_LINE_RE.test(ln)) {
        store = cleanStore(ln);
        break;
      }
    }
  }
  if (!store && customHit && customHit.store) store = customHit.store;
  if (!store && result.platform) store = result.platform; // 兜底：用短信签名作为门店
  result.store = store;

  // 快递公司识别顺序（重要）：
  //  1. 正文明确声明的快递公司（「中通快递」）最可信；
  //  2. 单号前缀（SF→顺丰）次之；
  //  3. 匹配正文前先剔除门店名——驿站名里常含品牌词（「丰巢快递柜」含「丰巢」），
  //     否则顺丰件会被误判成丰巢。
  let carrier = '';
  const textNoStore = store ? t.split(store).join(' ') : t;
  for (const [name, re] of CARRIERS) {
    if (re.test(textNoStore)) { carrier = name; break; }
  }
  if (!carrier && tracking) {
    const m = tracking.match(/^([A-Za-z]{2})/);
    if (m && PREFIX_CARRIER[m[1].toUpperCase()]) carrier = PREFIX_CARRIER[m[1].toUpperCase()];
  }
  result.carrier = carrier;

  result.arrivedAt = parseTime(meta.time).toISOString();
  result.ok = true;
  return result;
}

/**
 * 把粘贴的文本切成「包裹条目」。
 *
 * 两种输入形态：
 *  1) 多条短信，每行一条 → 一行一实体
 *  2) 购物 App / 驿站 App 订单详情页复制出来的多行文本 → 一个包裹跨多行，需按块聚合
 *
 * 判别思路：若整段只有 1 个取件码，说明是「一个包裹的多行描述」，整体作为一条；
 * 若每行都能独立识别出取件码，则按行拆；否则按「含取件码的行」作为块的锚点聚合前后行。
 *
 * @param {string} text
 * @returns {string[]} 待解析的文本块
 */
export function splitBlocks(text) {
  if (!text) return [];
  const raw = String(text).replace(/\r\n?/g, '\n').trim();
  if (!raw) return [];

  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  if (lines.length === 1) return [lines[0]];

  // 每行是否各自带取件码
  const hasCode = lines.map((l) => hasCodeSignal(l));

  // 情况 A：几乎每行都能独立识别 → 视为「多条短信」，一行一条
  const codeLineCount = hasCode.filter(Boolean).length;
  if (codeLineCount === lines.length) return lines;

  // 情况 B：整段只有一个取件码 → 视为「一个包裹的多行文本」，整体一条
  if (codeLineCount === 1) return [raw];

  // 情况 C：部分行带取件码 → 以带码行为锚点，向上下扩展相邻的辅助行（单号/门店/时间）
  // 典型：每组是「驿站名 / 取件码：xxx / 运单号：yyy」三行
  const blocks = [];
  let current = [];

  // 记录每个块是否已收过「取件码 / 门店行 / 单号行」，避免吞掉下一组的开头
  let curHasCode = false;
  let curHasStore = false;
  let curHasTracking = false;

  const flush = () => {
    if (current.length) blocks.push(current.join('\n'));
    current = [];
    curHasCode = false;
    curHasStore = false;
    curHasTracking = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    // 已经拿到取件码的块，遇到「新的门店行」就说明下一组开始了 → 先断块
    if (current.length && curHasCode && STORE_LINE_RE.test(ln) && curHasStore) {
      flush();
    }

    // 前置辅助行（门店名）在带码行之前：仅在当前块还没有码时吸收
    if (!curHasCode && isHelperLine(ln)) {
      if (STORE_LINE_RE.test(ln)) {
        if (curHasStore) flush(); // 连续两个门店行 → 第二个属于新块
        curHasStore = true;
      }
      current.push(ln);
      continue;
    }

    current.push(ln);
    if (hasCodeSignal(ln)) curHasCode = true;
    if (/(?:单号|运单号|快递单号)/.test(ln)) curHasTracking = true;

    // 带码行之后，继续吸收紧邻的辅助行（单号优先，门店不重复吸收）
    if (curHasCode) {
      while (i + 1 < lines.length && !hasCodeSignal(lines[i + 1])) {
        const nxt = lines[i + 1];
        const isStore = STORE_LINE_RE.test(nxt);
        if (isStore && curHasStore) break;      // 下一组的门店行 → 停
        if (curHasTracking && isStore) break;   // 已有单号又遇门店 → 下一组
        if (!isHelperLine(nxt)) break;
        i += 1;
        current.push(nxt);
        if (isStore) curHasStore = true;
        if (/(?:单号|运单号|快递单号)/.test(nxt)) curHasTracking = true;
        if (curHasStore && curHasTracking) break; // 门店+单号都齐了，本组结束
      }
      flush();
    }
  }
  flush();

  // 兜底：聚合后若块数异常，退回按行
  return blocks.length ? blocks : lines;
}

/** 该行是否含取件码信号（用于判断行是否为一个包裹的主体） */
function hasCodeSignal(line) {
  const t = String(line || '');
  return CODE_RE.test(t) || CODE_PING_RE.test(t) || CODE_TAIL_RE.test(t);
}

/** 辅助行：单号 / 门店 / 时间 / 提示语，属于某个包裹但不含取件码 */
function isHelperLine(line) {
  const t = String(line || '').trim();
  if (!t) return false;
  if (/(?:单号|运单号|快递单号)/.test(t)) return true;
  if (STORE_LINE_RE.test(t)) return true;
  if (/(?:驿站|快递柜|丰巢|自提点|服务点|便利店|营业部)/.test(t) && t.length <= 30) return true;
  if (/(?:请及时|请尽快|尽快取|逾期|超时|已送达|已到达|待取件|派送中|已签收)/.test(t)) return true;
  return false;
}

/**
 * 批量解析文本（每行一条，或整段短信 / 订单详情页多行文本）
 * @param {string} text
 * @param {Array} [rules] 自定义识别规则
 */
export function parseTextLines(text, rules = null) {
  if (!text) return [];
  const blocks = splitBlocks(text);
  return blocks.map((block, i) => ({ ...parseSms(block, {}, rules), line: block, index: i }));
}
