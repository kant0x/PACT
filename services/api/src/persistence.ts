export type MaybePromise<T> = T | Promise<T>;

export interface StatePersistence<T> {
  load(): MaybePromise<T | null>;
  save(state: T): MaybePromise<void>;
  close?(): MaybePromise<void>;
}
