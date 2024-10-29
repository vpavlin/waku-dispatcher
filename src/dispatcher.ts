import { LightNode, IDecodedMessage, QueryRequestParams } from "@waku/interfaces"
import {
    bytesToUtf8,
    createDecoder,
    createEncoder,
    IProtoMessage,
    ISubscription,
    utf8ToBytes,
    waitForRemotePeer,
} from "@waku/sdk"

import {
    IMessage,
    IEncoder,
    IDecoder,
    Protocols,
    Unsubscribe,
} from "@waku/interfaces"
import { encrypt, decrypt } from "../node_modules/@waku/message-encryption/dist/crypto/ecies.js"
import { decryptSymmetric, encryptSymmetric } from "../node_modules/@waku/message-encryption/dist/symmetric.js"
import { Wallet, ethers, keccak256 } from "ethers"
import { Direction, Store, StoreMsg } from "./storage/store.js"
//import { messageHash } from "@waku/message-hash"

export type IDispatchMessage = {
    type: MessageType
    payload: any
    timestamp: number | undefined
    signature: string | undefined
    signer: string | undefined
}

type DispachInfo = {
    callback: DispatchCallback
    verifySender: boolean
    acceptOnlyEncrypted: boolean
    contentTopic: string
    storeLocally: boolean
}

export type Signer = string | undefined

export type DispatchMetadata = {
    encrypted: boolean
    timestamp: number | undefined
    fromStore: boolean
    contentTopic: string
    ephemeral: boolean | undefined
}

type EmitCache = {
    msg: IMessage
    encoder: IEncoder
}

export enum KeyType {
    Symmetric,
    Asymetric
}

export type Key = {
    key: Uint8Array
    type: KeyType
}

type MessageType = string
type DispatchCallback = (payload: any, signer: Signer, meta: DispatchMetadata) => void


export class Dispatcher {
    mapping: Map<MessageType, DispachInfo[]>
    node: LightNode
    contentTopic: string
    decoder: IDecoder<IDecodedMessage>
    encoder: IEncoder
    encoderEphemeral: IEncoder
    ephemeralDefault: boolean

    running: boolean

    decryptionKeys: Key[]
    autoEncrypt: boolean = false
    autoEncryptKeyId: number | undefined = undefined
    
    hearbeatInterval: NodeJS.Timeout | undefined
    subscription: ISubscription | null
    unsubscribe: undefined | Unsubscribe = undefined 

    lastSuccessfulQuery: Date = new Date()
    
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
        this.contentTopic = contentTopic

     
        this.encoderEphemeral = createEncoder({ contentTopic: contentTopic, ephemeral: true })
        this.encoder = createEncoder({ contentTopic: contentTopic, ephemeral: false })


        this.ephemeralDefault = ephemeral
        this.decoder = createDecoder(contentTopic)
        this.running = false
        this.decryptionKeys = []

        this.subscription = null
        this.hearbeatInterval = undefined

        this.store = store


    }

    /**
     * Registers a callback/event handler executed upon a message delivery
     * @param typ 
     * @param callback 
     * @param verifySender 
     * @param acceptOnlyEcrypted 
     * @param contentTopic
     * @returns 
     */
    on = (typ: MessageType, callback: DispatchCallback, verifySender?: boolean, acceptOnlyEcrypted?: boolean, contentTopic?: string, storeLocally?: boolean) => {
        if (!this.mapping.has(typ)) {
            this.mapping.set(typ, [])
        }
        const dispatchInfos = this.mapping.get(typ)
        const newDispatchInfo = { callback: callback, verifySender: !!verifySender, acceptOnlyEncrypted: !!acceptOnlyEcrypted, contentTopic: contentTopic ? contentTopic : this.contentTopic, storeLocally: storeLocally === undefined ? true : storeLocally}
        if (dispatchInfos?.find((di) => di.callback.toString() == newDispatchInfo.callback.toString())) {
            console.warn("Skipping the callback setup - already exists")
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
        await waitForRemotePeer(this.node, [Protocols.LightPush, Protocols.Filter, Protocols.Store])
        
        this.node.libp2p.addEventListener("peer:disconnect", async (e:any) => {
            console.debug("Peer disconnected, check subscription!")
            console.debug(e.detail.toString())
            //await this.checkSubscription()
        })
        this.hearbeatInterval = setInterval(() => this.dispatchRegularQuery(), 10000)

        const decoders = [this.decoder]

        for (const di of this.mapping.values()) {
            for (const i of di) {
                if (i.contentTopic != this.contentTopic) {
                    decoders.push(createDecoder(i.contentTopic))
                }
            }
        }

        try {
            const subResult = await this.node.filter.subscribe(decoders, this.dispatch)
            if (subResult.error) {
                throw new Error(subResult.error);
            }
            this.subscription = subResult.subscription
            
            this.filterConnected = true
        } catch (e){
            console.error(e)
        }
        //this.reemitInterval = setInterval(() => this.emitFromCache(), 10000)
    }

    stop = async () => {
        this.running = false
        if (this.hearbeatInterval) clearInterval(this.hearbeatInterval)
        //clearInterval(this.reemitInterval)
        //await this.subscription?.unsubscribeAll()
        if (this.unsubscribe) await this.unsubscribe()
        this.subscription = null
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
    registerKey = (key: Uint8Array, type: KeyType = KeyType.Asymetric, autoEncrypt: boolean = false) => {
        if (!this.decryptionKeys.find((k) => k.key == key && k.type == type)) {
            this.decryptionKeys.push({key: key, type: type})
            if (autoEncrypt) {
                this.autoEncrypt = true
                this.autoEncryptKeyId = this.decryptionKeys.length - 1
            }
        }
    }

    private checkDuplicate = (hash: string):boolean => {
        if (this.msgHashes.indexOf(hash) >= 0) {
            console.debug("Message already delivered")
            return true
        }
        if (this.msgHashes.length > 2000) {
            console.debug("Dropping old messages from hash cache")
            this.msgHashes.slice(hash.length - 500, hash.length)
        }
        this.msgHashes.push(hash)
        return false
    }

    private decrypt = async (payload: Uint8Array):Promise<[Uint8Array, boolean]> => {
        let msgPayload = payload
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


    ensureUint8Array = (payload: Uint8Array):Uint8Array => {
        let wakuPayload = new Uint8Array()
        
        if (payload instanceof Uint8Array) {
            wakuPayload = payload
        } else {
            wakuPayload = new Uint8Array(Object.values(payload));
        }

        return wakuPayload
    }

    decryptMessage = async (payload: Uint8Array):Promise<[IDispatchMessage, boolean]> => {
        const wakuPayload = this.ensureUint8Array(payload)
        const [msgPayload, encrypted] = await this.decrypt(wakuPayload)

        const dmsg: IDispatchMessage = JSON.parse(bytesToUtf8(msgPayload), reviver)
        return [dmsg, encrypted]
    }

    /**
     * Performs various processing and validation steps on the message (decryption, signature verification, deduplication...) and executes all registered callbacks for the message type
     * @param msg 
     * @param fromStorage 
     * @returns 
     */
    dispatch = async (msg: IDecodedMessage, fromStorage: boolean = false) => {
        const wakuPayload = this.ensureUint8Array(msg.payload) 

        const input = new Uint8Array([...ethers.toUtf8Bytes(msg.contentTopic), ...wakuPayload, ...ethers.toUtf8Bytes(msg.timestamp!.toString()), ...ethers.toUtf8Bytes(msg.pubsubTopic)])
        const hash = keccak256(input)
        if (this.checkDuplicate(hash)) return

        try {
            const [dmsg, encrypted] = await this.decryptMessage(wakuPayload)
            if (!dmsg.timestamp)
                dmsg.timestamp = new Date(msg.timestamp!).getTime()

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
                    console.info(`Message not encrypted, skipping (type: ${dmsg.type})`)
                    continue
                }

                if (dispatchInfo.contentTopic != msg.contentTopic) {
                    console.log(`Content topic mismatch ${dispatchInfo.contentTopic} != ${msg.contentTopic}`)
                    continue
                }

                let payload = dmsg.payload

                if (dispatchInfo.verifySender) {
                    if (!this.verifySender(dmsg)) {
                        console.debug("failed to verify sender")
                        continue
                    }
                }

                this.lastDeliveredTimestamp = new Date(msg.timestamp!).getTime()|| Date.now()

                if (!msg.ephemeral && !fromStorage && dispatchInfo.storeLocally) {
                    this.store.set({direction: Direction.In, dmsg: {
                        contentTopic: msg.contentTopic,
                        ephemeral: msg.ephemeral,
                        meta: msg.meta,
                        payload: wakuPayload,
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
    emit = async (typ: MessageType, payload: any, wallet?: Wallet, encryptionKey?: Uint8Array | Key, ephemeral: boolean = this.ephemeralDefault) => {
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
    emitTo = async (encoder: IEncoder, typ: MessageType, payload: any, wallet?: Wallet, encryptionKey?: Uint8Array | Key | boolean): Promise<Boolean> => {
        const dmsg: IDispatchMessage = {
            type: typ,
            payload: payload,
            timestamp: (new Date()).getTime(),
            signature: undefined,
            signer: undefined
        }

        if (wallet) {
            dmsg.signer = wallet.address
            dmsg.signature = wallet.signMessageSync(JSON.stringify(dmsg))
        }

        //console.debug(dmsg)
        let payloadArray = utf8ToBytes(JSON.stringify(dmsg, replacer))
        let keyType = KeyType.Asymetric
        let key: Uint8Array

        if ((encryptionKey === undefined || encryptionKey !== false) && this.autoEncrypt && this.autoEncryptKeyId !== undefined) {
            encryptionKey = this.decryptionKeys[this.autoEncryptKeyId]
        }

        if (encryptionKey) {
            //console.debug("Will encrypt")
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

        const msg: IProtoMessage = {
            payload: payloadArray,
            contentTopic: encoder.contentTopic,
            ephemeral: encoder.ephemeral,
            timestamp: undefined,
            rateLimitProof: undefined,
            meta: undefined,
            version: undefined

        }

        const res = await this.node.lightPush.send(encoder, msg as IMessage)
        //console.log({msgHash: toHexString(messageHash(encoder.pubsubTopic, msg)), result: res})
        /*if (res && res.successes && res.successes.length == 0 && this.node.lightPush.connectedPeers.length > 0) {
            this.node.lightPush.renewPeer(this.node.lightPush.connectedPeers[0].id)
        }*/
        /*if (res && res.errors && res.errors.length > 0) {
            msg.timestamp = new Date()
            this.emitCache.push({msg: msg, encoder: encoder})
        }*/
        return res && res.successes && res.successes.length > 0
    }

    getLocalMessages = async () => {
        let messages = await this.store.getAll()

        //console.log(messages)
        messages = messages.sort((a, b) => {
            if (!a.dmsg.timestamp)
                return 1

            if (!b.dmsg.timestamp)
                return -1

            const first = new Date(a.dmsg.timestamp).getTime()
            const second = new Date(b.dmsg.timestamp).getTime()
            if (first < second)
                return -1

            return 1 
        })

        return messages
    }

    importLocalMessage = async (messages: StoreMsg[]) => {
        for (const msg of messages) {
            try {
            this.store.set(msg)
            } catch (e) {
                console.error(e)
            }
        }
    }

    /**
     * Queries the IndexDB for existing messages and dispatches them as if they were just delivered. It also queries Waku Store protocol for new messages (since the timestamp of last message)
     */
    dispatchLocalQuery = async () => {
        let msg
        let start = new Date(0)
        let messages = await this.getLocalMessages()
        //console.log(messages)
        for (let i = 0; i<messages.length; i++) {
            msg = messages[i]

            //TODO: I don't think this is needed, but need to verify
            //Ignore messages from different content topics - FIXME: Add index and do this in the DB query!
            /*if (msg.dmsg.contentTopic != this.decoder.contentTopic) {
                console.debug(`Ignoring msg - content topic mismatch: ${msg.dmsg.contentTopic} != ${this.decoder.contentTopic}`)
                continue
            }*/
            await this.dispatch(msg.dmsg, true)
            if (msg.dmsg.timestamp && msg.dmsg.timestamp > start)
                start = msg.dmsg.timestamp
        }

        try {
            if (start.getTime() > 0) {
                //while(!this.filterConnected) {console.debug("sleeping"); await sleep(1_000)}
                let end = new Date() 
                await this.dispatchQuery({paginationForward: true, paginationLimit: 20, includeData: true, pubsubTopic: this.decoder.pubsubTopic, contentTopics: [this.contentTopic], timeStart: new Date(start.setTime(start.getTime()-360*1000)), timeEnd: new Date(end.setTime(end.getTime()+3600*1000))}, true)
            } else {
                let start = new Date()
                let end = new Date()
                await this.dispatchQuery({paginationForward: true, paginationLimit: 20, includeData: true, pubsubTopic: this.decoder.pubsubTopic, contentTopics: [this.contentTopic],  timeStart: new Date(start.setTime(start.getTime()-8*3600*1000)), timeEnd: new Date(end.setTime(end.getTime()+3600*1000))}, true)
            }
        } catch (e) {
            console.error(e)
        }
    }

    /**
     * Queries Waku Store protocol for past messages and dispatches them as if they were just delivered
     * @param options 
     * @param live 
     */
    dispatchQuery = async (options: QueryRequestParams = {paginationForward: true, paginationLimit: 100, includeData: true, pubsubTopic: this.decoder.pubsubTopic, contentTopics: [this.contentTopic]}, live: boolean = false) => {
        console.log(options)
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

    dispatchRegularQuery = async () => {
        try {
            let start = this.lastSuccessfulQuery
            await this.dispatchQuery({paginationForward: true, paginationLimit: 100, includeData: true, pubsubTopic: this.decoder.pubsubTopic, contentTopics: [this.contentTopic], timeStart: new Date(start.setTime(start.getTime()-300*1000)), timeEnd: new Date()})
            this.lastSuccessfulQuery = new Date()
        } catch (ex) {
            console.error(ex)            
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
                console.info("Trying to emit failed message from "+toEmit.msg.timestamp)
                const res = await this.node.lightPush.send(toEmit.encoder, toEmit.msg)
                if (res && res.failures && res.failures.length > 0) {
                    break
                }

                this.emitCache.slice(1, l)
                await sleep(1000)
            }
        }

        this.reemitting = false

    }

    /**
     * 
     * @returns Get basic information about current connection to Waku network
     */
    getConnectionInfo = async () => {
        return {
            connections: this.node.libp2p.getConnections(),
            //filterConnections: await this.node.filter.connectedPeers(),
            //lightpushConnections: await this.node.lightPush.connectedPeers(),
            subscription: this.filterConnected,
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

/*function toHexString(byteArray: any) {
    return Array.from(byteArray, function(byte: any) {
      return ('0' + (byte & 0xFF).toString(16)).slice(-2);
    }).join('')
  }*/