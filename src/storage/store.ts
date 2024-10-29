import { IDecodedMessage } from "@waku/interfaces"


export enum Direction {
    In,
    Out,
}

export type StoreMsg = {
    dmsg: IDecodedMessage
    hash: string
    direction: Direction
}



export class Store {
    db:IDBDatabase | undefined = undefined
    ready: () => Promise<Boolean> | undefined
    interval: NodeJS.Timeout | undefined
    reject: undefined | ((reason:any) => void)  = undefined
    
    constructor(name: string) {
        const dbOpen = window.indexedDB.open(name, 1)
        this.ready = async () => { return new Promise<Boolean>((resolve, reject) => {
            this.reject = reject
                this.interval = setInterval(() => {
                    if (this.db) {
                        resolve(true)
                        clearInterval(this.interval)
                        return
                    }
        
                }, 100)
            })
        }
        console.log(dbOpen)
        dbOpen.onerror = (event) => {
            this.reject && this.reject(event)
            console.error(event)
            throw new Error("Failed to open DB")
        }
        dbOpen.onsuccess = () => {
            this.db = dbOpen.result
            console.log("success")
        }
        dbOpen.onupgradeneeded = (event:IDBVersionChangeEvent) => {
            // @ts-ignore
            const db:IDBDatabase = event.target.result

            db.onerror = (e:any) => {
                console.error(e)
                this.reject && this.reject(event)               
            }

            const objectStore = db.createObjectStore("message", { keyPath: "hash" });

            objectStore.createIndex("direction", "direction", { unique: false})
            objectStore.createIndex("contentTopic", "dmsg.contentTopic", { unique: false})

            console.log("finally")

        }
    }

    set = (msg:StoreMsg) => {
        const transaction = this.db!.transaction(["message"], "readwrite");
        const objectStore = transaction.objectStore("message");
        const request = objectStore.add(msg)
        request.onerror = (evt) => {
            const e:IDBRequest = evt.target  as IDBRequest
            if (!e.error?.message.includes("Key already exists")) {
                console.error(evt)
            }
        }
    }

    getAll = async () => {
        console.log("getAll")
        return new Promise<StoreMsg[]>((resolve, reject) => {
            if (!this.db) {
                reject("store failed")
            }
            const transaction = this.db!.transaction(["message"]);
            const objectStore = transaction.objectStore("message");
            const request = objectStore.getAll()
            request.onerror = (evt) => {
                console.error(evt)
                reject("Failed to query the DB")
            }
            request.onsuccess = () => {
                const data: StoreMsg[] = request.result
                resolve(data)
            }
        })

    }




}