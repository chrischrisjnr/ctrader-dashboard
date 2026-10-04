import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const KINDS = ['accounts', 'bots', 'instances'];

export function newId() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Tiny JSON-file database. All reads are served from memory; every write
 * persists the whole document atomically (write temp file, then rename) and
 * writes are serialized so they can never interleave.
 */
export class Store {
  constructor(file) {
    this.file = file;
    this.data = Object.fromEntries(KINDS.map((k) => [k, []]));
    this.pending = Promise.resolve();
  }

  async load() {
    let raw;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    const parsed = JSON.parse(raw);
    for (const kind of KINDS) this.data[kind] = Array.isArray(parsed[kind]) ? parsed[kind] : [];
  }

  list(kind) {
    return this.data[kind];
  }

  get(kind, id) {
    return this.data[kind].find((item) => item.id === id);
  }

  async insert(kind, fields) {
    const now = new Date().toISOString();
    const item = { id: newId(), ...fields, createdAt: now, updatedAt: now };
    this.data[kind].push(item);
    await this.save();
    return item;
  }

  async update(kind, id, fields) {
    const item = this.get(kind, id);
    if (!item) return undefined;
    Object.assign(item, fields, { id, updatedAt: new Date().toISOString() });
    await this.save();
    return item;
  }

  async remove(kind, id) {
    const before = this.data[kind].length;
    this.data[kind] = this.data[kind].filter((item) => item.id !== id);
    if (this.data[kind].length !== before) await this.save();
    return this.data[kind].length !== before;
  }

  save() {
    const snapshot = JSON.stringify(this.data, null, 2);
    const write = async () => {
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.rename(tmp, this.file);
    };
    // Keep the chain alive after a failed write, but still surface the error to this caller.
    const result = this.pending.catch(() => {}).then(write);
    this.pending = result;
    return result;
  }
}
