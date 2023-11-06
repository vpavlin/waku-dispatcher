import { LightNode, IDecodedMessage, StoreQueryOptions, IFilterSubscription, PageDirection } from "@waku/interfaces"
import {
    bytesToUtf8,
    createDecoder,
    createEncoder,
    utf8ToBytes,
    waitForRemotePeer,
} from "@waku/sdk"

import {
    IMessage,
    IEncoder,
    IDecoder,
    Protocols,
} from "@waku/interfaces"
import { encrypt, decrypt } from "../node_modules/@waku/message-encryption/dist/crypto/ecies.js"
import { decryptSymmetric, encryptSymmetric } from "../node_modules/@waku/message-encryption/dist/waku_payload.js"
import { BaseWallet, ethers, keccak256 } from "ethers"
import { Direction, Store } from "./storage/store.js"


export type IDispatchMessage = {
    type: MessageType
    payload: any
    timestamp: string | undefined
    signature: string | undefined
    signer: string | undefined
}

type DispachInfo = {
    callback: DispatchCallback
    verifySender: boolean
    acceptOnlyEncrypted: boolean
}

export type Signer = string | undefined

export type DispatchMetadata = {
    encrypted: boolean
    timestamp: string | undefined
    fromStore: boolean
    contentTopic: string
    ephemeral: boolean | undefined
}

type EmitCache = {
    msg: IMessage
    encoder: IEncoder
}

enum KeyType {
    Symmetric,
    Asymetric
}

type Key = {
    key: Uint8Array
    type: KeyType
}

type MessageType = string
type DispatchCallback = (payload: any, signer: Signer, meta: DispatchMetadata) => void

const MAX_RESUBSCRIBE_ATTEMPTS = 5
const DEFAULT_SUBSCRIBE_RETRY_MS = 5000

export class Dispatcher {
    mapping: Map<MessageType, DispachInfo[]>
    node: LightNode
    decoder: IDecoder<IDecodedMessage>
    encoder: IEncoder
    encoderEphemeral: IEncoder
    ephemeralDefault: boolean

    running: boolean

    decryptionKeys: Key[]
    
    hearbeatInterval: NodeJS.Timeout | undefined
    subscription: IFilterSubscription | undefined
    resubscribing: boolean = false
    resubscribeAttempts: number = 0
    
    filterConnected:boolean = false
    lastDeliveredTimestamp:number | undefined= undefined 

    msgHashes: string[] = []
    emitCache: EmitCache[] = []
    reemitting: boolean = false
    reemitInterval: NodeJS.Timer | undefined = undefined

    store: Store

    /**
     * Dispatcher is a wrapper around js-waku SDK 
     * @param node 
     * @param contentTopic 
     * @param ephemeral 
     * @param store 
     */
    constructor(node: LightNode, contentTopic: string, ephemeral: boolean, store: Store) {
        this.mapping = new Map<MessageType, DispachInfo[]>()
        this.node = node

     
        this.encoderEphemeral = createEncoder({ contentTopic: contentTopic, ephemeral: true })
        this.encoder = createEncoder({ contentTopic: contentTopic, ephemeral: false })


        this.ephemeralDefault = ephemeral
        this.decoder = createDecoder(contentTopic)
        this.running = false
        this.decryptionKeys = []

        this.subscription = undefined
        this.hearbeatInterval = undefined

        this.store = store
    }

    /**
     * Registers a callback/event handler executed upon a message delivery
     * @param typ 
     * @param callback 
     * @param verifySender 
     * @param acceptOnlyEcrypted 
     * @returns 
     */
    on = (typ: MessageType, callback: DispatchCallback, verifySender?: boolean, acceptOnlyEcrypted?: boolean) => {
        if (!this.mapping.has(typ)) {
            this.mapping.set(typ, [])
        }
        const dispatchInfos = this.mapping.get(typ)
        const newDispatchInfo = { callback: callback, verifySender: !!verifySender, acceptOnlyEncrypted: !!acceptOnlyEcrypted }
        if (dispatchInfos?.find((di) => di.callback.toString() == newDispatchInfo.callback.toString())) {
            console.log("Skipping the callback setup - already exists")
            return
        }
        dispatchInfos?.push(newDispatchInfo)
        this.mapping.set(typ, dispatchInfos!)
    }

    /**
     * Starts dispatcher
     * @returns 
     */
    start = async () => {
        if (this.running) return
        this.running = true
        //await this.node.start()
        await waitForRemotePeer(this.node, [Protocols.LightPush, Protocols.Filter])
        this.subscription = await this.node.filter.createSubscription()
        await this.subscription.subscribe(this.decoder, this.dispatch)
        this.filterConnected = true
        this.node.libp2p.addEventListener("peer:disconnect", async (e) => {
            console.log("Peer disconnected, check subscription!")
            console.log(e.detail.toString())
            await this.checkSubscription()
        })
        this.hearbeatInterval = setInterval(() => this.checkSubscription(), 10000)
        //this.reemitInterval = setInterval(() => this.emitFromCache(), 10000)
    }

    stop = async () => {
        this.running = false
        if (this.hearbeatInterval) clearInterval(this.hearbeatInterval)
        //clearInterval(this.reemitInterval)
        await this.subscription?.unsubscribeAll()
        this.subscription = undefined
        this.msgHashes = []
        this.mapping.clear()
    }

    /**
     * @returns {boolean}
     */
    isRunning = (): boolean => {
        return this.running
    }

    /**
     * Registers a private key to use for message decryption. Can register multiple key
     * @param key 
     */
    registerKey = (key: Uint8Array, type: KeyType = KeyType.Asymetric) => {
        if (!this.decryptionKeys.find((k) => k.key == key && k.type == type)) this.decryptionKeys.push({key: key, type: type})
    }

    private checkDuplicate = (hash: string):boolean => {
        if (this.msgHashes.indexOf(hash) >= 0) {
            console.debug("Message already delivered")
            return true
        }
        if (this.msgHashes.length > 100) {
            console.debug("Dropping old messages from hash cache")
            this.msgHashes.slice(hash.length - 100, hash.length)
        }
        this.msgHashes.push(hash)
        return false
    }

    private decrypt = async (msg: IDecodedMessage):Promise<[Uint8Array, boolean]> => {
        let msgPayload = msg.payload
        let encrypted = false
        if (this.decryptionKeys.length > 0) {
            for (const key of this.decryptionKeys) {
                try {
                    let buffer: Uint8Array
                    if (key.type == KeyType.Asymetric) {
                        buffer = await decrypt(key.key, msgPayload)
                    } else {
                        buffer = await decryptSymmetric(msgPayload, key.key)
                    }
                    msgPayload = new Uint8Array(buffer.buffer)
                    encrypted = true
                    break
                } catch (e) {
                    console.debug("Failed to decrypt: " + e)
                }
  
            }
        }

        return [msgPayload, encrypted]
    }

    private verifySender = (dmsg: IDispatchMessage): boolean => {
        if (!dmsg.signature) {
            console.error(`${dmsg.type}: Message requires verification, but signature is empty!`)
            return false
        }
        const dmsgToVerify: IDispatchMessage = { type: dmsg.type, payload: dmsg.payload, timestamp: dmsg.timestamp, signature: undefined, signer: dmsg.signer, }
        const signer = ethers.verifyMessage(JSON.stringify(dmsgToVerify), dmsg.signature)
        if (signer != dmsg.signer) {
            console.error(`${dmsg.type}: Invalid signer ${dmsg.signer} != ${signer}`)
            return false
        }

        return true
    }

    /**
     * Performs various processing and validation steps on the message (decryption, signature verification, deduplication...) and executes all registered callbacks for the message type
     * @param msg 
     * @param fromStorage 
     * @returns 
     */
    dispatch = async (msg: IDecodedMessage, fromStorage: boolean = false) => {
        const [msgPayload, encrypted] = await this.decrypt(msg)

        const input = new Uint8Array([...ethers.toUtf8Bytes(msg.contentTopic), ...msg.payload, ...ethers.toUtf8Bytes(msg.timestamp!.toString()), ...ethers.toUtf8Bytes(msg.pubsubTopic)])
        const hash = keccak256(input)
        if (this.checkDuplicate(hash)) return

        try {
            const dmsg: IDispatchMessage = JSON.parse(bytesToUtf8(msgPayload), reviver)
            if (!dmsg.timestamp)
                dmsg.timestamp = msg.timestamp?.toString()

            if (!this.mapping.has(dmsg.type)) {
                console.error("Unknown type " + dmsg.type)
                return
            }

            const dispatchInfos = this.mapping.get(dmsg.type)

            if (!dispatchInfos) {
                console.error("Undefined callback for " + dmsg.type)
                return
            }

            for (const dispatchInfo of dispatchInfos) {
                if (dispatchInfo.acceptOnlyEncrypted && !encrypted) {
                    console.log(`Message not encrypted, skipping (type: ${dmsg.type})`)
                    continue
                }

                let payload = dmsg.payload

                if (dispatchInfo.verifySender) {
                    if (!this.verifySender(dmsg)) continue
                }

                this.lastDeliveredTimestamp = msg.timestamp?.getTime()|| Date.now()

                if (!msg.ephemeral && !fromStorage) {
                    this.store.set({direction: Direction.In, dmsg: {
                        contentTopic: msg.contentTopic,
                        ephemeral: msg.ephemeral,
                        meta: msg.meta,
                        payload: msg.payload,
                        pubsubTopic: msg.pubsubTopic,
                        rateLimitProof: msg.rateLimitProof,
                        timestamp: msg.timestamp,
                    }, hash: hash})
                }
                
                dispatchInfo.callback(payload, dmsg.signer, { encrypted: encrypted, fromStore: fromStorage, timestamp: dmsg.timestamp, ephemeral: msg.ephemeral, contentTopic: msg.contentTopic })
            }
        } catch (e) {
            console.debug(e)
        }
    }

    /**
     * Automatically chooses encoder to be used and executes `emitTo`
     * @param typ 
     * @param payload 
     * @param wallet 
     * @param encryptionPublicKey 
     * @param ephemeral 
     * @returns 
     */
    emit = async (typ: MessageType, payload: any, wallet?: BaseWallet, encryptionKey?: Uint8Array | Key, ephemeral: boolean = this.ephemeralDefault) => {
        const encoder = ephemeral ? this.encoderEphemeral : this.encoder
        return this.emitTo(encoder, typ, payload, wallet, encryptionKey)
    }

    /**
     * Publishes a message to Waku network. Adds signature if a wallet is provided, encrypts the message if public key is provided
     * @param encoder 
     * @param typ 
     * @param payload 
     * @param wallet 
     * @param encryptionKey 
     * @returns 
     */
    emitTo = async (encoder: IEncoder, typ: MessageType, payload: any, wallet?: BaseWallet, encryptionKey?: Uint8Array | Key) => {
        const dmsg: IDispatchMessage = {
            type: typ,
            payload: payload,
            timestamp: (new Date()).getTime().toString(),
            signature: undefined,
            signer: undefined
        }

        if (wallet) {
            dmsg.signer = wallet.address
            dmsg.signature = wallet.signMessageSync(JSON.stringify(dmsg))
        }

        console.debug(dmsg)
        let payloadArray = utf8ToBytes(JSON.stringify(dmsg, replacer))
        let keyType = KeyType.Asymetric
        let key: Uint8Array
        if (encryptionKey) {
            if (typeof encryptionKey == "object" && (encryptionKey as Key).key !== undefined) {
                 keyType = (encryptionKey as Key).type
                 key = (encryptionKey as Key).key
            } else {
                key = (encryptionKey as Uint8Array)
            }
            let buffer: Uint8Array
            if (keyType == KeyType.Asymetric) {
                buffer = await encrypt(key, payloadArray)
            } else {
                buffer = await encryptSymmetric(payloadArray, key)
            }
            payloadArray = new Uint8Array(buffer.buffer)
        }

        const msg: IMessage = {
            payload: payloadArray
        }

        const res = await this.node.lightPush.send(encoder, msg)
        /*if (res && res.errors && res.errors.length > 0) {
            msg.timestamp = new Date()
            this.emitCache.push({msg: msg, encoder: encoder})
        }*/

        return res
    }

    /**
     * Queries the IndexDB for existing messages and dispatches them as if they were just delivered. It also queries Waku Store protocol for new messages (since the timestamp of last message)
     */
    dispatchLocalQuery = async () => {
        let messages = await this.store.getAll()
        let msg
        let start = new Date(0)

        //console.log(messages)
        messages = messages.sort((a, b) => {
            if (!a.dmsg.timestamp)
                return 1

            if (!b.dmsg.timestamp)
                return -1

            if (a.dmsg.timestamp < b.dmsg.timestamp)
                return -1

            return 1 
        })
        //console.log(messages)
        for (let i = 0; i<messages.length; i++) {
            msg = messages[i]

            //Ignore messages from different content topics - FIXME: Add index and do this in the DB query!
            if (msg.dmsg.contentTopic != this.decoder.contentTopic) {
                console.debug(`Ignoring msg - content topic mismatch: ${msg.dmsg.contentTopic} != ${this.decoder.contentTopic}`)
                continue
            }
            await this.dispatch(msg.dmsg, true)
            if (msg.dmsg.timestamp && msg.dmsg.timestamp > start)
                start = msg.dmsg.timestamp
        }

        if (start.getTime() > 0) {
            while(!this.filterConnected) {console.debug("sleeping"); await sleep(1_000)}
            let end = new Date() 
            await this.dispatchQuery({pageDirection: PageDirection.FORWARD, pageSize: 20, timeFilter: {startTime: new Date(start.setTime(start.getTime()-360*1000)), endTime: new Date(end.setTime(end.getTime()+3600*1000))}}, true)
        } else {
            await this.dispatchQuery()
        }
    }

    /**
     * Queries Waku Store protocol for past messages and dispatches them as if they were just delivered
     * @param options 
     * @param live 
     */
    dispatchQuery = async (options: StoreQueryOptions = {pageDirection: PageDirection.FORWARD, pageSize: 20}, live: boolean = false) => {
        console.debug(options)
        for await (const messagesPromises of this.node.store.queryGenerator(
            [this.decoder],
            options
        )) {
            await Promise.all(
                messagesPromises
                    .map(async (p) => {
                        const msg = await p;
                        if (msg)
                            await this.dispatch(msg, !live)
                    })
            );
        }
    }

    clearDuplicateCache = () => {
        this.msgHashes = []
    }

    /**
     * TBD
     * @returns 
     */
    emitFromCache = async () => {
        if (this.reemitting) return
        this.reemitting = true
        if (this.emitCache.length > 0) {
            const l = this.emitCache.length
            for (let i = 0; i < l; i++) {
                const toEmit = this.emitCache[0]
                console.log("Trying to emit failed message from "+toEmit.msg.timestamp)
                const res = await this.node.lightPush.send(toEmit.encoder, toEmit.msg)
                if (res && res.errors && res.errors.length > 0) {
                    break
                }

                this.emitCache.slice(1, l)
                await sleep(1000)
            }
        }

        this.reemitting = false

    }

    /**
     * Sends`ping()` to the Filter node and if it fails attempts to recreate the subscribtion (as the node has probably dropped our subscription or went offline...)
     */
    checkSubscription = async () => {
        if (this.subscription && !this.resubscribing) {
            this.resubscribing = true
            try {
                await this.subscription.ping();
            } catch (error) {
                this.filterConnected = false
                const start = new Date()
                while(true) {
                    console.log("Resubscribing!")
                    console.log(this.subscription)
                    
                    //await this.subscription.unsubscribeAll()
                    try {
                        if (this.resubscribeAttempts >= MAX_RESUBSCRIBE_ATTEMPTS || !this.subscription) {
                            try {
                                if (this.subscription)
                                    await this.subscription.unsubscribeAll()
                            } catch (unE) {
                                console.log(unE)
                            } finally {
                                this.subscription = undefined
                            }
                            this.subscription = await this.node.filter.createSubscription()
                            console.log("Created new subscription")
                        }

                        await this.subscription.subscribe([this.decoder], this.dispatch)
                        console.log("Resubscribed")
                        const end = new Date()
                        console.log(`Query: ${start.toString()} -> ${end.toString()}`)
                        await this.dispatchQuery({timeFilter: {startTime: new Date(start.setSeconds(start.getSeconds()-120)), endTime: end}}, true)
                        break;
                    } catch (e) {
                        console.debug("Failed to resubscribe: " + e)
                        this.resubscribeAttempts++
                    }
                    await sleep(DEFAULT_SUBSCRIBE_RETRY_MS * this.resubscribeAttempts)
                }
            } finally {
                this.resubscribeAttempts = 0
                this.resubscribing = false
                this.filterConnected = true
            }
        }
    }

    /**
     * 
     * @returns Get basic information about current connection to Waku network
     */
    getConnectionInfo = () => {
        return {
            connections: this.node.libp2p.getConnections(),
            subscription: this.filterConnected,
            subsciptionAttempts: this.resubscribeAttempts,
            lastDelivered: this.lastDeliveredTimestamp
        }
    }
}


// @ts-ignore
function replacer(key: any, value: any) {
    if (value instanceof Map) {
        return {
            dataType: 'Map',
            value: Array.from(value.entries()), // or with spread: value: [...value]
        };
    } else {
        return value;
    }
}

// @ts-ignore
function reviver(key: any, value: any) {
    if (typeof value === 'object' && value !== null) {
        if (value.dataType === 'Map') {
            return new Map(value.value);
        }
    }
    return value;
}

async function sleep(msec: number) {
	return await new Promise((r) => setTimeout(r, msec))
}