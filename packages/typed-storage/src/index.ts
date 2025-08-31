
// TODO: Remove this once it's in workers-types.
export interface DurableObjectStorage {
  kv: SyncKvStorage;

  transactionSync<T>(closure: () => T): T;
}
interface SyncKvStorage {
  get<T>(key: string): T | undefined;
  list<T = unknown>(
    options?: DurableObjectListOptions,
  ): Iterable<[string, T]>;
  put<T>(
    key: string,
    value: T,
  ): void;
  delete(key: string): boolean;
}

// TODO:
// - improve non-unique indexes
// - store metadata blob
// - compress collection & index names
// - (someday) versions and migrations
// - (someday) compress rows by removing property names

// =======================================================================================
// Types

// Specifies constraints on an indexed list() operation.
export type ListOptions<T = string> = {
  // List starting at the given key, including the key itself.
  start?: T;

  // List starting immediately after the given key.
  startAfter?: T;

  // List ending immediately before the given key.
  end?: T;

  // List only keys starting with the given prefix.
  //
  // This only makes sense for string keys, not integers.
  prefix?: T extends string ? T : never;

  // Stop after the given number of matches.
  //
  // Note that for non-unique indexes, this counts the number of matching keys, not the number of
  // records. Hence, more than `limit` records may be returned. Meanwhile, a subsequent `list()` can
  // use `startAfter` set to the last record's key and be assured that it won't miss anything.
  limit?: number;

  // Normally, keys are listed in ascending order. Set `reverse: true` to list in descending order.
  //
  // For non-unique indexes, this also reverses the order of matches for a particular key.
  reverse?: boolean;

  // When listing by an index where each record may have multiple keys, the default is to
  // list a record again for each key within the list range. Set `dedupe: true` to list each
  // record only once.
  //
  // Note that when used together with the `limit` option, the limit is enforced on the total
  // number of matching keys, before de-duplication, hence de-duplication may cause the returned
  // list to have fewer than `limit` keys even if the limit was reached. Keep in mind also that
  // any de-duplication applies only within a single call to list(), so if you are making several
  // `limit`ed calls in sequence to list incrementally, you may still get duplicates between calls.
  // Generally, `limit` and `dedupe` don't work well together.
  dedupe?: boolean;
};

// An index where each key matches exactly one record.
export interface UniqueIndex<T, Key> {
  get(key: Key): T | undefined;
  list(options?: ListOptions<Key>): Iterable<T>;
  delete(key: Key): boolean;
}

// An index where each key may match multiple records.
export interface NonUniqueIndex<T, Key> {
  get(key: Key): Iterable<T>;
  list(options?: ListOptions<Key>): Iterable<T>;
  delete(key: Key): number;
}

type Key = string | number;

type IndexFunction<T> =
    | ((record: T) => string | null)
    | ((record: T) => string[])
    | ((record: T) => number | null)
    | ((record: T) => number[]);

type ReturnType<T> = T extends (...args: any) => infer R ? R : never;
type RemoveArray<T> = T extends Array<infer U> ? U : T;

type UniqueIndexed<T, Indexes> = {
  [K in keyof Indexes]: UniqueIndex<T, RemoveArray<ReturnType<Indexes[K]>>>
}

type NonUniqueIndexed<T, Indexes> = {
  [K in keyof Indexes]: NonUniqueIndex<T, RemoveArray<ReturnType<Indexes[K]>>>
}

export interface Subscriber<T> {
  add(record: T): void;
  update(oldRecord :T, newRecord :T): void;
  remove(record: T): void;
}

export interface Collection<T extends Object, PrimaryKey = string> extends UniqueIndex<T, PrimaryKey> {
  put(value: T): void;

  subscribe(subscriber: Subscriber<T>): void;
  unsubscribe(subscriber: Subscriber<T>): void;
}

export interface SingletonSubscriber<T> {
  update(value :T): void;
}

export interface Singleton<T> {
  get(): T;
  put(value: T): void;

  subscribe(subscriber: SingletonSubscriber<T>): void;
  unsubscribe(subscriber: SingletonSubscriber<T>): void;
}

export interface TypedStorage {
  transaction<T>(callback: () => T): T;
};

type ValidPrimaryKeys<T> = {
  [K in keyof T]: T[K] extends Key ? K : never;
}[keyof T];

type PrimaryKeySpec<T> = ValidPrimaryKeys<T> | ((record: T) => Key);

type PrimaryKeyType<T, K extends PrimaryKeySpec<T>> =
    K extends ValidPrimaryKeys<T> ? T[K]
  : K extends ((record: T) => Key) ? ReturnType<K>
  : never;

interface CollectionSchemaBrand {
  "__COLLECTION_SCHEMA_BRAND": never;
}

// TODO: Add singleton values.
interface CollectionSchema<
      T extends Object,
      PrimaryKey extends PrimaryKeySpec<T>,
      UniqueIndexes,
      NonUniqueIndexes
    > extends CollectionSchemaBrand {
  primaryKey: PrimaryKey;
  uniqueIndexes?: UniqueIndexes;
  nonUniqueIndexes?: NonUniqueIndexes;
}

export function collection<T extends Object>() {
  return function<PrimaryKey extends PrimaryKeySpec<T>,
                  UniqueIndexes,
                  NonUniqueIndexes>(
      options: {
        primaryKey: PrimaryKey,
        uniqueIndexes?: UniqueIndexes,
        nonUniqueIndexes?: NonUniqueIndexes,
      })
      : CollectionSchema<T, PrimaryKey, UniqueIndexes, NonUniqueIndexes> {
    return options as (CollectionSchemaBrand & typeof options);
  }
}

// =======================================================================================

type CollectionImpl<T extends Object,
                    PrimaryKey extends PrimaryKeySpec<T>,
                    UniqueIndexes,
                    NonUniqueIndexes> =
    & Collection<T, PrimaryKeyType<T, PrimaryKey>>
    & UniqueIndexed<T, UniqueIndexes>
    & NonUniqueIndexed<T, NonUniqueIndexes>;

type TypedStorageImpl<Collections, Singletons> = TypedStorage
  & {
    [K in keyof Collections]: Collections[K] extends
        CollectionSchema<infer T, infer P, infer U, infer N>
            ? CollectionImpl<T, P, U, N> : never
  }
  & {
    [K in keyof Singletons]: Singleton<Singletons[K]>;
  };

function keyString(key: Key): string {
  if (typeof key === "string") {
    return key;
  } else if (Number.isInteger(key) && key < Number.MAX_SAFE_INTEGER) {
    let hex = key.toString(16);
    let prefix = String.fromCharCode(96 + hex.length);
    return prefix + hex;
  } else {
    throw new TypeError(`Storage keys must be strings or integers. Got: ${key}`);
  }
}

// Helper class that implements a view of KV storage by adding a prefix to all keys. Also, accepts
// `Key` (string | number) as the key type, encoding numbers so that they sort nicely.
class KvPrefixedView<T extends Object> {
  #kv: SyncKvStorage;
  #prefix: string;

  // If the key is itself a property of T, we'd like to avoid dulpicating it in storage. So, we
  // null out the property in the value before storing, and then put it back on load.
  //
  // However, there's a catch: We don't necessarily know at load time (especially in list())
  // whether the key type was a string or a number originally. So, we only do this nulling at
  // store time for string keys, and we only perform the replacement at load time if the property
  // was nulled out. Integers won't take much storage space anyway.
  #keyPropName?: keyof T;

  constructor(storage: DurableObjectStorage, name: string, keyPropName?: keyof T) {
    this.#kv = storage.kv;
    this.#prefix = `${name}:`;
    this.#keyPropName = keyPropName;
  }

  #rawKey(key: Key) {
    return `${this.#prefix}${keyString(key)}`;
  }

  get(key: Key): T | undefined {
    let kstr = keyString(key);
    let result = this.#kv.get<T>(`${this.#prefix}${kstr}`);
    if (this.#keyPropName && result !== undefined) {
      if (result[this.#keyPropName] === null) {
        result[this.#keyPropName] = <any>key;
      }
    }
    return result;
  }

  *list(options: ListOptions<Key> = {}): Generator<T, void> {
    for (let [key, value] of this.#kv.list<T>({
      start: options.start !== undefined ? this.#rawKey(options.start) : undefined,
      startAfter: options.startAfter !== undefined ? this.#rawKey(options.startAfter) : undefined,
      end: options.end !== undefined ? this.#rawKey(options.end) : undefined,
      prefix: options.prefix !== undefined ? this.#rawKey(options.prefix) : this.#prefix,
      reverse: options.reverse,
      limit: options.limit,
    })) {
      if (this.#keyPropName) {
        if (value[this.#keyPropName] === null) {
          value[this.#keyPropName] = <any>key.slice(this.#prefix.length);
        }
      }
      yield value;
    }
  }

  put(key: Key, value: T): void {
    if (this.#keyPropName !== undefined && typeof key === "string") {
      value[this.#keyPropName] = <any>null;
      try {
        this.#kv.put<T>(this.#rawKey(key), value);
      } finally {
        // Change the value back to how we found it. The caller may intend to keep using it.
        value[this.#keyPropName] = <any>key;
      }
    } else {
      this.#kv.put<T>(this.#rawKey(key), value);
    }
  }

  delete(key: Key): boolean {
    return this.#kv.delete(this.#rawKey(key));
  }
}

function createCollection<
      T extends Object,
      PrimaryKey extends PrimaryKeySpec<T>,
      UniqueIndexes,
      NonUniqueIndexes
    >(
      storage: DurableObjectStorage,
      name: string,
      schema: CollectionSchema<T, PrimaryKey, UniqueIndexes, NonUniqueIndexes>,
    ): CollectionImpl<T, PrimaryKey, UniqueIndexes, NonUniqueIndexes> {
  let subscribers: Set<Subscriber<T>> = new Set();

  let mainKv: KvPrefixedView<T>;
  let pkForT: (record: T) => Key;
  if (typeof schema.primaryKey === "function") {
    mainKv = new KvPrefixedView<T>(storage, name);
    pkForT = schema.primaryKey;
  } else {
    let pk = <keyof T>schema.primaryKey;
    mainKv = new KvPrefixedView<T>(storage, name, pk);
    pkForT = (record: T) => <Key>record[pk];
  }

  // ---------------------------------------------------------------------------
  // Primary key operations

  let collection: Collection<T, Key> = {
    get(key: Key): T | undefined {
      return mainKv.get(key);
    },
    put(record: T): void {
      let key = pkForT(record);
      if (subscribers.size == 0) {
        mainKv.put(key, record);
      } else {
        storage.transactionSync(() => {
          let oldRecord = mainKv.get(key);
          if (oldRecord === undefined) {
            for (let subscriber of subscribers) {
              subscriber.add(record);
            }
          } else {
            for (let subscriber of subscribers) {
              subscriber.update(oldRecord, record);
            }
          }
          mainKv.put(key, record);
        });
      }
    },
    list(options: ListOptions<Key>): Iterable<T> {
      return mainKv.list(options);
    },
    delete(key: Key): boolean {
      if (subscribers.size == 0) {
        return mainKv.delete(key);
      } else {
        return storage.transactionSync(() => {
          let oldRecord = mainKv.get(key);
          if (oldRecord === undefined) {
            return false;
          }

          for (let subscriber of subscribers) {
            subscriber.remove(oldRecord);
          }
          return mainKv.delete(key);
        });
      }
    },

    subscribe(subscriber: Subscriber<T>): void {
      subscribers.add(subscriber);
    },
    unsubscribe(subscriber: Subscriber<T>): void {
      subscribers.delete(subscriber);
    }
  };

  let result: any = collection;

  // ---------------------------------------------------------------------------
  // Helper for indexing

  // Add a subscriber subscribing on behalf of an index based on the given IndexFunction. This
  // code is shared for unique and non-unique indexes. This code in particular takes care of the
  // case where the index function returns an array.
  function addIndexSubscriber(
      idx: IndexFunction<T>,
      ops: {
        add(idxKey: Key, pk: Key, type: "Insertion" | "Update"): void;
        remove(idxKey: Key, pk: Key): void;
      }) {
    subscribers.add({
      add(record: T) {
        let pk = pkForT(record);
        let idxKeys = idx(record);
        if (idxKeys instanceof Array) {
          for (let idxKey of idxKeys) {
            ops.add(idxKey, pk, "Insertion");
          }
        } else if (idxKeys !== null) {
          ops.add(idxKeys, pk, "Insertion");
        }
      },
      update(oldRecord: T, newRecord: T) {
        let pk = pkForT(newRecord);

        let oldIdxKeys: Key | Key[] | null = idx(oldRecord);
        let newIdxKeys: Key | Key[] | null = idx(newRecord);

        if (oldIdxKeys instanceof Array || newIdxKeys instanceof Array) {
          if (!(oldIdxKeys instanceof Array)) {
            if (oldIdxKeys === null) {
              oldIdxKeys = [];
            } else {
              oldIdxKeys = [oldIdxKeys];
            }
          }
          if (!(newIdxKeys instanceof Array)) {
            if (newIdxKeys === null) {
              newIdxKeys = [];
            } else {
              newIdxKeys = [newIdxKeys];
            }
          }

          for (let idxKey of oldIdxKeys) {
            if (!newIdxKeys.includes(idxKey)) {
              ops.remove(idxKey, pk);
            }
          }
          for (let idxKey of newIdxKeys) {
            if (!oldIdxKeys.includes(idxKey)) {
              ops.add(idxKey, pk, "Update");
            }
          }
        } else {
          if (oldIdxKeys == newIdxKeys) {
            // Index doesn't need an update.
            return;
          }

          if (oldIdxKeys !== null) {
            ops.remove(oldIdxKeys, pk);
          }
          if (newIdxKeys !== null) {
            ops.add(newIdxKeys, pk, "Update");
          }
        }
      },
      remove(record: T) {
        let pk = pkForT(record);
        let idxKeys = idx(record);
        if (idxKeys instanceof Array) {
          for (let idxKey of idxKeys) {
            ops.remove(idxKey, pk);
          }
        } else if (idxKeys !== null) {
          ops.remove(idxKeys, pk);
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Unique indexes

  for (let [idxName, idx] of Object.entries(schema.uniqueIndexes || {})) {
    let idxKv = new KvPrefixedView<Key>(storage, `${name}.${idxName}`);

    let index: UniqueIndex<T, Key> = {
      get(key: Key): T | undefined {
        let pk = idxKv.get(key);
        return pk === undefined ? undefined : collection.get(pk);
      },
      *list(options: ListOptions<Key> = {}): Generator<T, void> {
        if (options.dedupe) {
          let seen = new Set();
          for (let pk of idxKv.list(options)) {
            if (!seen.has(pk)) {
              seen.add(pk);
              yield collection.get(pk)!;
            }
          }
        } else {
          for (let pk of idxKv.list(options)) {
            yield collection.get(pk)!;
          }
        }
      },
      delete(key: Key): boolean {
        let pk = idxKv.get(key);
        return pk === undefined ? false : collection.delete(pk);
      },
    };
    result[idxName] = index;

    addIndexSubscriber(idx as IndexFunction<T>, {
      add(idxKey: Key, pk: Key, type: "Insertion" | "Update") {
        let oldValue = idxKv.get(idxKey);
        if (oldValue !== undefined) {
          throw new Error(`${type} conflicts with record '${oldValue}' in '${name}.${idxName}'.`);
        }
        idxKv.put(idxKey, pk);
      },
      remove(idxKey: Key, pk: Key) {
        if (!idxKv.delete(idxKey)) {
          throw new Error(
              `Index '${name}.${idxName}' is inconsistent: removed record is not present.`);
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Non-unique indexes

  for (let [idxName, idx] of Object.entries(schema.nonUniqueIndexes || {})) {
    let idxKv = new KvPrefixedView<Key[]>(storage, `${name}.${idxName}`);

    let index: NonUniqueIndex<T, Key> = {
      *get(key: Key): Generator<T, void> {
        let pks = idxKv.get(key)
        if (pks === undefined) pks = [];
        for (let pk of pks) {
          yield collection.get(pk)!;
        }
      },
      *list(options: ListOptions<Key> = {}): Generator<T, void> {
        if (options.dedupe) {
          let seen = new Set<Key>();
          for (let pks of idxKv.list(options)) {
            if (options.reverse) pks.reverse();
            for (let pk of pks) {
              if (!seen.has(pk)) {
                seen.add(pk);
                yield collection.get(pk)!;
              }
            }
          }
        } else {
          for (let pks of idxKv.list(options)) {
            if (options.reverse) pks.reverse();
            for (let pk of pks) {
              yield collection.get(pk)!;
            }
          }
        }
      },
      delete(key: Key): number {
        let pks = idxKv.get(key);
        if (pks === undefined) {
          return 0;
        } else {
          for (let pk of pks) {
            collection.delete(pk);
          }
          return pks.length;
        }
      },
    };
    result[idxName] = index;

    addIndexSubscriber(idx as IndexFunction<T>, {
      add(idxKey: Key, pk: Key, type: "Insertion" | "Update") {
        let pks = idxKv.get(idxKey) || [];
        if (pks.includes(pk)) {
          throw new Error(
              `Index '${name}.${idxName}' is inconsistent: added record already present.`);
        }
        pks.push(pk);
        idxKv.put(idxKey, pks);
      },
      remove(idxKey: Key, pk: Key) {
        let pks = idxKv.get(idxKey) || [];
        let newPks = pks.filter(k => k !== pk);
        if (pks.length - newPks.length !== 1) {
          throw new Error(
              `Index '${name}.${idxName}' is inconsistent: removed record is not present.`);
        }
        idxKv.put(idxKey, newPks);
      }
    });
  }

  // ---------------------------------------------------------------------------

  return result;
}

export function createTypedStorage<Collections extends Record<string, CollectionSchemaBrand>,
                                   Singletons>(
    storage: DurableObjectStorage,
    schema: {
      collections?: Collections;
      singletons?: Singletons;
    })
    : TypedStorageImpl<Collections, Singletons> {
  let typedStorage: TypedStorage = {
    transaction<T>(callback: () => T): T {
      return storage.transactionSync(callback);
    }
  };
  let result: any = typedStorage;

  for (let [colName, colSchema] of Object.entries(schema.collections || {})) {
    result[colName] = createCollection(storage, colName, <any>colSchema);
  }

  for (let [key, defaultValue] of Object.entries(schema.singletons || {})) {
    let subscribers = new Set<SingletonSubscriber<any>>();

    let singleton: Singleton<any> = {
      get(): any {
        let result = storage.kv.get(key);
        if (result === undefined) {
          result = defaultValue;
        }
        return result;
      },

      put(value: any): void {
        if (subscribers.size === 0) {
          storage.kv.put(key, value);
        } else {
          storage.transactionSync(() => {
            for (let subscriber of subscribers) {
              subscriber.update(value);
            }
            storage.kv.put(key, value);
          });
        }
      },

      subscribe(subscriber: SingletonSubscriber<any>): void {
        subscribers.add(subscriber);
      },

      unsubscribe(subscriber: SingletonSubscriber<any>): void {
        subscribers.delete(subscriber);
      },
    };

    result[key] = singleton;
  }

  return result;
}
