'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const DAY = 24 * 60 * 60 * 1000;

export class JsonStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.data = null;
  }

  load() {
    if (fs.existsSync(this.file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (e) {
        // 数据文件损坏：隔离损坏文件，用空数据启动，避免服务无法启动
        const corrupt = this.file + '.corrupt-' + Date.now();
        try { fs.renameSync(this.file, corrupt); } catch (e2) { /* ignore */ }
        console.error('[store] 数据文件损坏，已移至 ' + path.basename(corrupt) + '，使用空数据启动');
      }
    }
    if (!this.data || typeof this.data !== 'object' || Array.isArray(this.data)) {
      this.data = { version: 1, seq: 0, packages: [], settings: { defaultExpiryDays: 3 } };
    }
    if (!Array.isArray(this.data.packages)) this.data.packages = [];
    if (!this.data.settings || typeof this.data.settings !== 'object') {
      this.data.settings = { defaultExpiryDays: 3 };
    }
    if (!Array.isArray(this.data.customRules)) this.data.customRules = [];
    return this;
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  nextId() {
    this.data.seq += 1;
    return 'p' + this.data.seq + '_' + randomBytes(4).toString('hex');
  }

  getSettings() {
    return { ...this.data.settings };
  }

  // ---------- 自定义识别规则（AI 模板学习） ----------
  addCustomRule(rule) {
    const item = {
      id: 'r' + (++this.data.seq) + '_' + randomBytes(4).toString('hex'),
      codeBefore: rule.codeBefore || '',
      codeAfter: rule.codeAfter || '',
      storeBefore: rule.storeBefore || '',
      storeAfter: rule.storeAfter || '',
      storeValue: rule.storeValue || '',
      sample: rule.sample || '',
      createdAt: new Date().toISOString(),
      matched: 0,
    };
    this.data.customRules.push(item);
    this.save();
    return { ...item };
  }

  listCustomRules() {
    return this.data.customRules.map((r) => ({ ...r }));
  }

  getCustomRule(id) {
    return this.data.customRules.find((r) => r.id === id) || null;
  }

  bumpCustomRule(id) {
    const r = this.getCustomRule(id);
    if (!r) return;
    r.matched += 1;
    this.save();
  }

  deleteCustomRule(id) {
    const idx = this.data.customRules.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    this.data.customRules.splice(idx, 1);
    this.save();
    return true;
  }

  updateSettings(patch) {
    const s = this.data.settings;
    if (typeof patch.defaultExpiryDays === 'number' && patch.defaultExpiryDays >= 1 && patch.defaultExpiryDays <= 30) {
      s.defaultExpiryDays = Math.round(patch.defaultExpiryDays);
    }
    this.save();
    return { ...s };
  }

  list() {
    return this.data.packages;
  }

  get(id) {
    return this.data.packages.find((p) => p.id === id) || null;
  }

  /** 计算某包裹的到期时间（取件码通常 N 天有效） */
  computeExpiresAt(arrivedAt, expiresDays) {
    const days = Number.isFinite(expiresDays) && expiresDays >= 1 && expiresDays <= 30
      ? Math.round(expiresDays)
      : this.data.settings.defaultExpiryDays;
    const base = arrivedAt ? new Date(arrivedAt).getTime() : Date.now();
    if (isNaN(base)) return new Date(Date.now() + days * DAY).toISOString();
    return new Date(base + days * DAY).toISOString();
  }

  /**
   * 新增一个包裹记录
   * @param {{store?, code, carrier?, tracking?, platform?, arrivedAt?, expiresDays?}} input
   */
  addPackage(input) {
    const now = new Date().toISOString();
    const arrivedAt = input.arrivedAt && !isNaN(new Date(input.arrivedAt).getTime())
      ? new Date(input.arrivedAt).toISOString()
      : now;
    const pkg = {
      id: this.nextId(),
      store: String(input.store || '').trim(),
      code: String(input.code || '').trim(),
      carrier: String(input.carrier || '').trim(),
      tracking: String(input.tracking || '').trim(),
      platform: String(input.platform || '手动录入').trim(),
      note: String(input.note || '').trim(),
      photo: input.photo || '',
      status: 'pending',
      createdAt: now,
      arrivedAt: arrivedAt,
      expiresAt: this.computeExpiresAt(arrivedAt, input.expiresDays),
      source: input.source || 'manual',
      raw: input.raw || '',
    };
    this.data.packages.push(pkg);
    this.save();
    return pkg;
  }

  /** 查重：同单号，或同取件码+同门店（近期未取）视为重复 */
  findDuplicate(candidate) {
    const pending = this.data.packages.filter((p) => p.status === 'pending');
    for (const p of pending) {
      if (candidate.tracking && p.tracking && p.tracking === candidate.tracking) return p;
      if (
        candidate.code && p.code === candidate.code &&
        candidate.store && p.store && p.store === candidate.store
      ) {
        const age = Date.now() - new Date(p.createdAt).getTime();
        if (age < 7 * DAY) return p;
      }
    }
    return null;
  }

  /**
   * 批量新增（已解析好的条目）
   * @returns {{added: object[], skipped: {item: object, reason: string}[]}}
   */
  addBatch(items) {
    const added = [];
    const skipped = [];
    for (const item of items) {
      if (!item || !item.code) {
        skipped.push({ item, reason: '缺少取件码' });
        continue;
      }
      const dup = this.findDuplicate(item);
      if (dup) {
        skipped.push({ item, reason: '与已有记录重复（' + (dup.store || dup.tracking || dup.code) + '）' });
        continue;
      }
      added.push(this.addPackage(item));
    }
    return { added, skipped };
  }

  updatePackage(id, patch) {
    const pkg = this.get(id);
    if (!pkg) return null;
    const allowed = ['status', 'store', 'code', 'carrier', 'tracking', 'platform', 'expiresAt', 'expiresDays', 'raw', 'note', 'photo'];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        if (key === 'expiresDays') {
          pkg.expiresAt = this.computeExpiresAt(pkg.arrivedAt, patch[key]);
        } else if (key === 'note') {
          pkg.note = String(patch[key] || '').trim();
        } else if (key === 'photo') {
          pkg.photo = patch[key] || '';
        } else {
          pkg[key] = patch[key];
        }
      }
    }
    if (patch.status === 'picked' && !pkg.pickedAt) pkg.pickedAt = new Date().toISOString();
    if (patch.status === 'pending') pkg.pickedAt = null;
    this.save();
    return pkg;
  }

  deletePackage(id) {
    const idx = this.data.packages.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    this.data.packages.splice(idx, 1);
    this.save();
    return true;
  }

  /** 归一化门店名（空串按「未指定门店」处理，保证匹配一致） */
  _normStore(name) {
    return String(name || '').trim();
  }

  /**
   * 删除某个驿站下的全部包裹（含已取）。
   * @returns {{deleted: number}} 删除条数；驿站不存在则返回 0
   */
  deleteStorePackages(storeName) {
    const key = this._normStore(storeName);
    const before = this.data.packages.length;
    this.data.packages = this.data.packages.filter((p) => this._normStore(p.store) !== key);
    const deleted = before - this.data.packages.length;
    if (deleted > 0) this.save();
    return { deleted };
  }

  /**
   * 驿站改名：所有引用旧名的包裹改到新名（去重合并）。
   * @returns {{updated: number}} 改动的包裹数
   */
  renameStore(fromName, toName) {
    const from = this._normStore(fromName);
    const to = this._normStore(toName);
    if (!from || !to || from === to) return { updated: 0 };
    let updated = 0;
    for (const p of this.data.packages) {
      if (this._normStore(p.store) === from) {
        p.store = to;
        updated += 1;
      }
    }
    if (updated > 0) this.save();
    return { updated };
  }

  /**
   * 合并驿站：把 source 驿站的全部包裹并入 target 驿站（source 消失）。
   * 与 rename 等价，但语义更清晰；target 不存在时也允许（相当于改名）。
   */
  mergeStores(sourceName, targetName) {
    return this.renameStore(sourceName, targetName);
  }

  stores() {
    const map = new Map();
    for (const p of this.data.packages) {
      const key = p.store || '未指定门店';
      const entry = map.get(key) || { store: key, pending: 0, total: 0 };
      entry.total += 1;
      if (p.status === 'pending') entry.pending += 1;
      map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => b.pending - a.pending || b.total - a.total);
  }

  stats() {
    const now = Date.now();
    const day = DAY;
    let pending = 0;
    let picked = 0;
    let expiring = 0;   // 24 小时内到期
    let expired = 0;    // 已过期
    for (const p of this.data.packages) {
      if (p.status === 'picked') { picked += 1; continue; }
      pending += 1;
      const t = new Date(p.expiresAt).getTime();
      if (!isNaN(t)) {
        if (t < now) expired += 1;
        else if (t - now <= day) expiring += 1;
      }
    }
    return { pending, picked, expiring, expired, total: this.data.packages.length };
  }

  exportData() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: this.data.settings,
      packages: this.data.packages,
    };
  }

  importData(data) {
    if (!data || !Array.isArray(data.packages)) {
      throw new Error('导入数据格式不正确');
    }
    // 先备份
    fs.mkdirSync(this.dir, { recursive: true });
    const backupFile = path.join(this.dir, 'backup-' + Date.now() + '.json');
    fs.writeFileSync(backupFile, JSON.stringify(this.exportData(), null, 2));
    const items = data.packages.map((p) => ({
      id: this.nextId(),
      store: String(p.store || '').trim(),
      code: String(p.code || '').trim(),
      carrier: String(p.carrier || '').trim(),
      tracking: String(p.tracking || '').trim(),
      platform: String(p.platform || '导入').trim(),
      status: p.status === 'picked' ? 'picked' : 'pending',
      createdAt: p.createdAt || new Date().toISOString(),
      arrivedAt: p.arrivedAt || p.createdAt || new Date().toISOString(),
      expiresAt: p.expiresAt || this.computeExpiresAt(p.arrivedAt || p.createdAt, null),
      pickedAt: p.pickedAt || null,
      source: p.source || 'import',
      raw: p.raw || '',
    }));
    this.data.packages = items;
    this.save();
    return { count: items.length, backupFile };
  }
}
