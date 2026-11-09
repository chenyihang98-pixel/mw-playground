// 名册的存储层接口。浏览器里用 IndexedDB 实现（idbStore.ts）；单元测试用这里的内存实现。
// 存储层只负责按键读写原始值；格式和版本的校验在 format.ts，出错时的提示和跳过在 roster.ts。

export interface StoredEntry {
  readonly key: string;
  readonly value: unknown;
}

export interface RosterStore {
  /** 读出所有记录（原始值，不校验）。 */
  loadAll(): Promise<StoredEntry[]>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 内存里的存储：单元测试用。可以设置让某个操作抛错，模拟配额不够、浏览器禁止等情况。 */
export class MemoryRosterStore implements RosterStore {
  readonly data = new Map<string, unknown>();
  /** 设置后对应的操作抛出这个错误。 */
  failures: { load?: Error; put?: Error; delete?: Error } = {};

  loadAll(): Promise<StoredEntry[]> {
    if (this.failures.load) return Promise.reject(this.failures.load);
    return Promise.resolve([...this.data].map(([key, value]) => ({ key, value })));
  }

  put(key: string, value: unknown): Promise<void> {
    if (this.failures.put) return Promise.reject(this.failures.put);
    this.data.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    if (this.failures.delete) return Promise.reject(this.failures.delete);
    this.data.delete(key);
    return Promise.resolve();
  }
}
