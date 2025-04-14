import { Protocols, createLightNode, waitForRemotePeer } from "@waku/sdk";
import { LightNode } from "@waku/interfaces";
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
        autostart?: boolean,
        bootstrapNodes?: string[]
    ) => {
    console.debug("Setting up dispatcher", initializing)

    if (dispatcher || initializing) {
        return dispatcher
    }
    initializing = true

    console.debug("Set 'initializing' to true")

    if (!node) {
        console.log("Setting up a node!")
        node = await createLightNode({
            defaultBootstrap: true,
            bootstrapPeers: bootstrapNodes,
        })
        node.start()
        await waitForRemotePeer(node, [Protocols.LightPush, Protocols.Filter, Protocols.Store])
    } else {
        console.debug("Got node from caller")
    }
    console.info("Creating dispatcher")
    const store = new Store(`${dbName}-dispatcher`)
    console.debug("Store created")
    await store.ready()
    console.log("Store ready")
    dispatcher = new Dispatcher(node!, contentTopic, ephemeral, store)

    if (autostart === undefined || autostart === true) {
        await dispatcher.start()
        console.debug("Dispatcher started")
    }

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
export {Store} from "./storage/store.js";