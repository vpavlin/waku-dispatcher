import { Protocols, createLightNode, waitForRemotePeer } from "@waku/sdk";
import { LightNode } from "@waku/interfaces";
import { Dispatcher } from "./dispatcher.js";
import { bootstrap } from "@libp2p/bootstrap";
import type { Libp2pOptions } from "libp2p";
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
const getDispatcher = async (node: LightNode | undefined, contentTopic: string, dbName: string, ephemeral: boolean, bootstrapNodes?: string[]) => {

    if (dispatcher || initializing) {
        return dispatcher
    }
    initializing = true

    let libp2p: Libp2pOptions | undefined = undefined 
    if (bootstrapNodes) {
        libp2p = {
            peerDiscovery: [
                bootstrap({ list: bootstrapNodes }),
            ]
        }
    }

    if (!node) {
        node = await createLightNode({
            defaultBootstrap: true,
            pingKeepAlive: 60,
            libp2p: libp2p,
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