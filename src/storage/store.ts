import { IDecodedMessage } from "@waku/interfaces"


export enum Direction {
    In,
    Out,
}

type StoreMsg = {
    dmsg: IDecodedMessage
    hash: string
    direction: Direction
}

export class Store {
    db:IDBDatabase | undefined = undefined
    constructor(name: string) {
        const dbOpen = window.indexedDB.open(name, 1)
        dbOpen.onerror = (event) => {
            console.error(event)
            throw new Error("Failed to open DB")
        }
        dbOpen.onsuccess = () => {
            this.db = dbOpen.result
        }
        dbOpen.onupgradeneeded = (event:IDBVersionChangeEvent) => {
            // @ts-ignore
            const db:IDBDatabase = event.target.result

            db.onerror = (e:any) => {
                console.error(e)
            }

            const objectStore = db.createObjectStore("message", { keyPath: "hash" });

            objectStore.createIndex("direction", "direction", { unique: false})
        }
    }

    set = (msg:StoreMsg) => {
        const transaction = this.db!.transaction(["message"], "readwrite");
        const objectStore = transaction.objectStore("message");
        const request = objectStore.add(msg)
        request.onerror = (evt) => {
            console.error(evt)
        }
    }

    getAll = async () => {
        return new Promise<StoreMsg[]>((resolve) => {
            const transaction = this.db!.transaction(["message"]);
            const objectStore = transaction.objectStore("message");
            const request = objectStore.getAll()
            request.onerror = (evt) => {
                console.error(evt)
            }
            request.onsuccess = () => {
                const data: StoreMsg[] = request.result
                resolve(data)
            }
        })

    }




}