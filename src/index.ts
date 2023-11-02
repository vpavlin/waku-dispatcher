import { Protocols, createLightNode, waitForRemotePeer } from "@waku/sdk";
import { Dispatcher } from "./dispatcher.js";
import { bootstrap } from "@libp2p/bootstrap";
import type { Libp2pOptions } from "libp2p";
import { Store } from "./storage/store.js";

let dispatcher: Dispatcher | null = null
let initializing = false

const getDispatcher = async (contentTopic: string, dbName: string, ephemeral: boolean, bootstrapNodes?: string[]) => {

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

    const node = await createLightNode({
        defaultBootstrap: true,
        pingKeepAlive: 60,
        libp2p: libp2p,
    })
    await waitForRemotePeer(node, [Protocols.LightPush, Protocols.Filter, Protocols.Store])
    console.info("Creating dispatcher")
    const store = new Store(`${dbName}-dispatcher`)
    dispatcher = new Dispatcher(node, contentTopic, ephemeral, store)
    await dispatcher.start()

    initializing = false
       
    return dispatcher
}

export default getDispatcher;
export * from "./dispatcher.js"