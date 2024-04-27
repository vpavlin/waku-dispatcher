import { Protocols, createLightNode, waitForRemotePeer } from "@waku/sdk";
import { LightNode, DefaultPubsubTopic } from "@waku/interfaces";
import { Dispatcher } from "./dispatcher.js";
import { Store } from "./storage/store.js";

let dispatcher: Dispatcher | null = null
let initializing = false

/**
 * Creates a singleton instance of the Dispatcher. Returns the Dispatcher instance if it already exists. It also creates a Waku node if not provided
 * @param node 
 * @param contentTopic 
 * @param dbName 
 * @param ephemeral 
 * @param bootstrapNodes 
 * @returns 
 */
const getDispatcher = async (
    node: LightNode | undefined,
        contentTopic: string,
        dbName: string,
        ephemeral: boolean,
        bootstrapNodes = [
            "/dns4/node-01.do-ams3.status.prod.statusim.net/tcp/443/wss/p2p/16Uiu2HAm6HZZr7aToTvEBPpiys4UxajCTU97zj5v7RNR2gbniy1D",
            "/dns4/node-02.do-ams3.status.prod.statusim.net/tcp/443/wss/p2p/16Uiu2HAmSve7tR5YZugpskMv2dmJAsMUKmfWYEKRXNUxRaTCnsXV",
            "/dns4/node-01.ac-cn-hongkong-c.waku.test.statusim.net/tcp/8000/wss/p2p/16Uiu2HAkzHaTP5JsUwfR9NR8Rj9HC24puS6ocaU8wze4QrXr9iXp",
        ]) => {

    if (dispatcher || initializing) {
        return dispatcher
    }
    initializing = true

    if (!node) {
        console.log("Setting up a node!")
        node = await createLightNode({
            pubsubTopics: [DefaultPubsubTopic],
            defaultBootstrap: false,
            pingKeepAlive: 60,
            bootstrapPeers: bootstrapNodes,
            numPeersToUse: 3,
        })
        await waitForRemotePeer(node, [Protocols.LightPush, Protocols.Filter, Protocols.Store])
    }
    console.info("Creating dispatcher")
    const store = new Store(`${dbName}-dispatcher`)
    dispatcher = new Dispatcher(node, contentTopic, ephemeral, store)
    await dispatcher.start()
    console.debug("Dispatcher started")

    initializing = false
       
    return dispatcher
}

/**
 * Stops and destroys the Dispatcher instance
 * @returns 
 */
export const destroyDispatcher = async () => {
    if (!dispatcher) return
    await dispatcher.stop()
    dispatcher = null
}

export default getDispatcher;
export * from "./dispatcher.js"