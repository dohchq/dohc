# Plugin SDK — `window.dohc`

Custom plugins are sandboxed iframes (`sandbox="allow-scripts"`). The
host (`apps/app/src/plugins/kernels/CustomKernel.tsx`) injects a bridge
that exposes `window.dohc`. Types and the postMessage protocol are the
`@dohc/plugin-sdk` package (`packages/plugin-sdk`).

## API

```ts
window.dohc.data            // { entities, plugin, query } | null
window.dohc.onUpdate(cb)    // fires now if data present, and on changes
window.dohc.upsert({ type, slug, data })   // Promise<MutationResult>
window.dohc.patch({ type, slug, data })    // Promise<MutationResult>
window.dohc.delete({ type, slug })         // Promise<MutationResult>
window.dohc.fetchEntities(type)            // Promise<PluginEntity[]>
```

Writes are routed to the host over postMessage and run through the same
Convex authz and safety gates as any other write — a plugin cannot
bypass ownership or the safety boundary.

## Protocol

The host and the injected bridge agree on these message types (the
single source of truth is `PLUGIN_PROTOCOL` in `@dohc/plugin-sdk`):

| Type               | Direction      | Meaning                          |
| ------------------ | -------------- | -------------------------------- |
| `dohc:data`        | host → iframe  | latest entities/plugin/query     |
| `dohc:rpc`         | iframe → host  | invoke a host method             |
| `dohc:rpc:result`  | host → iframe  | result of a prior rpc            |
| `dohc:resize`      | iframe → host  | report content height            |

## Example

```html
<div id="out"></div>
<script>
  window.dohc.onUpdate(({ entities }) => {
    document.getElementById('out').textContent =
      entities.length + ' items'
  })
</script>
```
