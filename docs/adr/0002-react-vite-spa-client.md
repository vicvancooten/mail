# React + Vite SPA for the web client, not Next.js

The client is local-first: it boots from a local store and works offline, so server rendering buys nothing and adds latency and infrastructure. Despite Next.js familiarity, the web Client is a Vite SPA with React and the TanStack ecosystem (Router/Query), packaged as a PWA. React over alternatives (Solid, Svelte) because AI-assisted development is a first-class constraint and AI output quality and ecosystem depth are strongest in React.

## Consequences

- The remaining client-architecture decisions (local store, client↔backend sync protocol, offline mutation queue, PWA shell) are still open and tracked on the wayfinder map.
