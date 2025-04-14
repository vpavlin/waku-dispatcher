import { IDecodedMessage } from "@waku/interfaces";

/**
 * Enum representing the direction of a message.
 */
export enum Direction {
  In,
  Out,
}

/**
 * Type representing a stored message.
 */
export type StoreMsg = {
  /**
   * The decoded message.
   */
  dmsg: IDecodedMessage;
  /**
   * The hash of the message.
   */
  hash: string;
  /**
   * The direction of the message.
   */
  direction: Direction;
};

/**
 * Class representing a message store using IndexedDB.
 */
export class Store {
  /**
   * The underlying IndexedDB database.
   */
  private db: IDBDatabase | null = null;
  /**
   * The name of the database.
   */
  private dbName: string;
  /**
   * The version of the database.
   */
  private dbVersion = 1;
  /**
   * The name of the object store.
   */
  private storeName = "message";
  /**
   * A promise that resolves when the database is ready.
   */
  private readyPromise: Promise<void>;

  /**
   * Creates a new instance of the Store class.
   * @param name The name of the database.
   */
  constructor(name: string) {
    this.dbName = name;
    this.readyPromise = this.openDB();
  }

  /**
   * Opens the IndexedDB database.
   * @returns A promise that resolves when the database is open.
   */
  private async openDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);
      request.onerror = (event) => {
        reject(new Error("Failed to open DB"));
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = request.result;
        db.onerror = (event) => {
          reject(new Error("Failed to upgrade DB"));
        };
        this.createObjectStore(db);
      };
    });
  }

  /**
   * Creates the object store and indexes in the database.
   * @param db The IndexedDB database.
   */
  private createObjectStore(db: IDBDatabase): void {
    // Create the object store with a key path of "hash".
    const objectStore = db.createObjectStore(this.storeName, { keyPath: "hash" });
    // Create an index on the "direction" property.
    objectStore.createIndex("direction", "direction", { unique: false });
    // Create an index on the "contentTopic" property of the "dmsg" object.
    objectStore.createIndex("contentTopic", "dmsg.contentTopic", { unique: false });
  }

  /**
   * Waits for the database to be ready.
   * @returns A promise that resolves when the database is ready.
   */
  public async ready(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Stores a message in the database.
   * @param msg The message to store.
   * @returns A promise that resolves when the message is stored.
   */
  public async set(msg: StoreMsg): Promise<void> {
    await this.ready();
    if (!this.db) {
      throw new Error("DB is not initialized");
    }
    return new Promise((resolve, reject) => {
      // Create a readwrite transaction on the object store.
      const transaction = this.db!.transaction([this.storeName], "readwrite");
      const objectStore = transaction.objectStore(this.storeName);
      // Add the message to the object store.
      const request = objectStore.add(msg);
      request.onerror = (event) => {
        const error = request.error;
        if (error && error.message.includes("Key already exists")) {
          // If the key already exists, resolve the promise.
          resolve();
        } else {
          reject(error);
        }
      };
      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * Retrieves all messages from the database.
   * @returns A promise that resolves with an array of messages.
   */
  public async getAll(): Promise<StoreMsg[]> {
    await this.ready();
    if (!this.db) {
      throw new Error("DB is not initialized");
    }
    return new Promise((resolve, reject) => {

      // Create a readonly transaction on the object store.
      const transaction = this.db!.transaction([this.storeName]);
      const objectStore = transaction.objectStore(this.storeName);
      // Get all messages from the object store.
      const request = objectStore.getAll();
      request.onerror = () => {
        reject(new Error("Failed to query the DB"));
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  }

  /**
   * Retrieves all messages with a specific direction.
   * @param direction The direction to filter by.
   * @returns A promise that resolves with an array of messages.
   */
  public async getByDirection(direction: Direction): Promise<StoreMsg[]> {
    await this.ready();
    if (!this.db) {
      throw new Error("DB is not initialized");
    }
    return new Promise((resolve, reject) => {
      // Create a readonly transaction on the object store.
      const transaction = this.db!.transaction([this.storeName]);
      const objectStore = transaction.objectStore(this.storeName);
      // Get the index on the "direction" property.
      const index = objectStore.index("direction");
      // Get all messages with the specified direction.
      const request = index.getAll(IDBKeyRange.only(direction));
      request.onerror = () => {
        reject(new Error("Failed to query the DB"));
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  }

  /**
   * Retrieves all messages with a specific content topic.
   * @param contentTopic The content topic to filter by.
   * @returns A promise that resolves with an array of messages.
   */
  public async getByContentTopic(contentTopic: string): Promise<StoreMsg[]> {
    await this.ready();
    if (!this.db) {
      throw new Error("DB is not initialized");
    }
    return new Promise((resolve, reject) => {
      // Create a readonly transaction on the object store.
      const transaction = this.db!.transaction([this.storeName]);
      const objectStore = transaction.objectStore(this.storeName);
      // Get the index on the "contentTopic" property.
      const index = objectStore.index("contentTopic");
      // Get all messages with the specified content topic.
      const request = index.getAll(IDBKeyRange.only(contentTopic));
      request.onerror = () => {
        reject(new Error("Failed to query the DB"));
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  }

  /**
   * Retrieves all messages with a specific direction and content topic.
   * @param direction The direction to filter by.
   * @param contentTopic The content topic to filter by.
   * @returns A promise that resolves with an array of messages.
   */
  public async getByDirectionAndContentTopic(direction: Direction, contentTopic: string): Promise<StoreMsg[]> {
    await this.ready();
    if (!this.db) {
      throw new Error("DB is not initialized");
    }
    // Get all messages with the specified direction.
    const resultsByDirection = await this.getByDirection(direction);
    // Filter the results by content topic.
    return resultsByDirection.filter((msg) => msg.dmsg.contentTopic === contentTopic);
  }

  // ...

/**
 * Deletes all messages with a specific direction.
 * @param direction The direction to delete.
 * @returns A promise that resolves when the messages are deleted.
 */
public async deleteByDirection(direction: Direction): Promise<void> {
    await this.ready();
    if (!this.db) {
      throw new Error("DB is not initialized");
    }
    return new Promise((resolve, reject) => {
      // Create a readwrite transaction on the object store.
      const transaction = this.db!.transaction([this.storeName], "readwrite");
      const objectStore = transaction.objectStore(this.storeName);
      // Get the index on the "direction" property.
      const index = objectStore.index("direction");
      // Get all messages with the specified direction.
      const request = index.openCursor(IDBKeyRange.only(direction));
      request.onerror = () => {
        reject(new Error("Failed to query the DB"));
      };
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          objectStore.delete(cursor.primaryKey);
          cursor.continue();
        } else {
          resolve();
        }
      };
    });
  }
  
  /**
   * Deletes all messages with a specific content topic.
   * @param contentTopic The content topic to delete.
   * @returns A promise that resolves when the messages are deleted.
   */
  public async deleteByContentTopic(contentTopic: string): Promise<void> {
    await this.ready();
    if (!this.db) {
      throw new Error("DB is not initialized");
    }
    return new Promise((resolve, reject) => {
      // Create a readwrite transaction on the object store.
      const transaction = this.db!.transaction([this.storeName], "readwrite");
      const objectStore = transaction.objectStore(this.storeName);
      // Get the index on the "contentTopic" property.
      const index = objectStore.index("contentTopic");
      // Get all messages with the specified content topic.
      const request = index.openCursor(IDBKeyRange.only(contentTopic));
      request.onerror = () => {
        reject(new Error("Failed to query the DB"));
      };
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          objectStore.delete(cursor.primaryKey);
          cursor.continue();
        } else {
          resolve();
        }
      };
    });
  }
  
  /**
   * Deletes all messages with a specific direction and content topic.
   * @param direction The direction to delete.
   * @param contentTopic The content topic to delete.
   * @returns A promise that resolves when the messages are deleted.
   */
  public async deleteByDirectionAndContentTopic(direction: Direction, contentTopic: string): Promise<void> {
    await this.ready();
    if (!this.db) {
      throw new Error("DB is not initialized");
    }
    // Get all messages with the specified direction.
    const resultsByDirection = await this.getByDirection(direction);
    // Filter the results by content topic and delete them.
    const keysToDelete = resultsByDirection.filter((msg) => msg.dmsg.contentTopic === contentTopic).map((msg) => msg.hash);
    return new Promise((resolve, reject) => {
      // Create a readwrite transaction on the object store.
      const transaction = this.db!.transaction([this.storeName], "readwrite");
      const objectStore = transaction.objectStore(this.storeName);
      keysToDelete.forEach((key) => {
        objectStore.delete(key);
      });
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onerror = () => {
        reject(new Error("Failed to delete messages"));
      };
    });
  }
}

