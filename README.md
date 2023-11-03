# Waku Dispatcher

Let's start with what is Waku and why it may need a "dispatcher".

Waku is a set of protocols, SDKs and a decentralized peer-to-peer network which allows us to communicate in a private and censorship resistant way.

By communication, we mean any type of (small) data transfer - obvious one is human chat, but don't forget machines like to chat too! 

You can check the website [waku.org](https://waku.org), or, if you just want to start building, the [Idea Board](https://ideas.waku.org/)

One issue that I see with Waku is that it is, as most peer-to-peer technologies, relatively complex to understand when you first encounter it. 

_Dispatcher enters the scene..._

Waku Dispatcher is an experimental project which is aiming to build a transparent wrapper over the most common Waku protocols used for developing Web (D)apps. That means, that if you just want to try out Waku and do not want to care about nodes, light clients, libp2p etc., you can simply instantiate the Dispatcher and use a few methods to setup your own app flow/protocol.

Head over to [example/](./example/src/App.tsx) and take a look how I quickly (actually during a quick train ride) implemented a simple "decentralized temperature recording app". 

There are other apps using Waku Dispatcher are:

* [Qaku](https://qaku.app)
* [WakuLink](http://js-waku-helpers.vercel.app/)


## More resources

TBD:)
