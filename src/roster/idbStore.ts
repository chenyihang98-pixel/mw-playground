// 名册存储的 IndexedDB 实现。数据库 mw-playground（版本 1），对象仓库 roster，键是人物的 id（文件的 SHA-256），
// 值是 format.ts 里的记录（原文件内容以 Blob 保存）。
// P5 起也用来保存关卡：传入另一个数据库名和对象仓库名（mw-playground-levels / levels），与名册分库。
// 浏览器不支持、被禁止、配额不够、读写出错时，操作返回被拒绝的 Promise（不同步抛错），由名册给出提示。

import type { RosterStore, StoredEntry } from './store';

const DB_NAME = 'mw-playground';
const DB_VERSION = 1;
const STORE = 'roster';

function failure(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object' && 'name' in error) return new Error(String(error.name));
  return new Error(fallback);
}

export interface IndexedDbNames {
  readonly database: string;
  readonly store: string;
}

export class IndexedDbRosterStore implements RosterStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly names: IndexedDbNames = { database: DB_NAME, store: STORE }) {}

  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      try {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('浏览器不支持 IndexedDB'));
          return;
        }
        const request = indexedDB.open(this.names.database, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(this.names.store)) db.createObjectStore(this.names.store);
        };
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(failure(request.error, '打不开 IndexedDB'));
        };
        request.onblocked = () => {
          reject(new Error('IndexedDB 被其他页面占用'));
        };
      } catch (error) {
        reject(failure(error, '打不开 IndexedDB'));
      }
    });
    // 打开失败时不缓存，下一次操作再试
    opening.catch(() => {
      if (this.db === opening) this.db = null;
    });
    this.db = opening;
    return opening;
  }

  private async transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      try {
        const tx = db.transaction(this.names.store, mode);
        let result: T | undefined;
        let finished = false;
        tx.oncomplete = () => {
          if (finished) resolve(result as T);
          else reject(new Error('IndexedDB 事务没有完成'));
        };
        tx.onerror = () => {
          reject(failure(tx.error, 'IndexedDB 读写出错'));
        };
        tx.onabort = () => {
          reject(failure(tx.error, 'IndexedDB 事务被中止'));
        };
        work(tx.objectStore(this.names.store), (value) => {
          result = value;
          finished = true;
        });
      } catch (error) {
        reject(failure(error, 'IndexedDB 读写出错'));
      }
    });
  }

  loadAll(): Promise<StoredEntry[]> {
    return this.transaction<StoredEntry[]>('readonly', (store, done) => {
      const entries: StoredEntry[] = [];
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c) {
          const key = c.primaryKey;
          entries.push({ key: typeof key === 'string' ? key : JSON.stringify(key), value: c.value as unknown });
          c.continue();
        } else {
          done(entries);
        }
      };
    });
  }

  put(key: string, value: unknown): Promise<void> {
    return this.transaction<undefined>('readwrite', (store, done) => {
      store.put(value, key).onsuccess = () => {
        done(undefined);
      };
    });
  }

  delete(key: string): Promise<void> {
    return this.transaction<undefined>('readwrite', (store, done) => {
      store.delete(key).onsuccess = () => {
        done(undefined);
      };
    });
  }
}
