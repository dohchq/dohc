import { useEffect, useMemo, useRef, useState } from 'react'
import { useAction, useQuery } from 'convex/react'
import { PLUGIN_PROTOCOL } from '@dohc/plugin-sdk'
import { api } from '../../../convex/_generated/api'
import type { KernelProps } from '../types'

// Sandboxed-iframe kernel. The plugin atom's body is the iframe's
// document. Communicates with the parent via postMessage.
//
// Bridge surface (auto-injected; see dohc-plugin.d.ts for types):
//   window.dohc.data        — { entities, plugin, query } | null
//   window.dohc.onUpdate(cb)
//   window.dohc.upsert({ type, slug, data })       — Promise<MutationResult>
//   window.dohc.patch({ type, slug, data })        — Promise<MutationResult>
//   window.dohc.delete({ type, slug })             — Promise<MutationResult>
//   window.dohc.fetchEntities(type)                — Promise<Entity[]>
//
// Sandbox: allow-scripts only. No cookies, no parent DOM, no top-nav.

export function CustomKernel({ plugin, query }: KernelProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [height, setHeight] = useState(80)

  const entities = useQuery(
    api.entities.list,
    query.resource
      ? { type: query.resource }
      : 'skip',
  )

  const mutate = useAction(api.pluginBridge.mutate)
  const fetchEntities = useAction(api.pluginBridge.fetchEntities)

  const srcDoc = useMemo(() => wrapPluginBody(plugin.body), [plugin.body])

  // Listen for messages from the iframe: resize hints + RPC calls.
  useEffect(() => {
    async function onMessage(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return
      const d = e.data
      if (!d || typeof d !== 'object') return

      if (d.type === PLUGIN_PROTOCOL.resize) {
        const h = Math.max(40, Math.min(2000, Number(d.height) || 80))
        setHeight(h)
        return
      }

      if (d.type === PLUGIN_PROTOCOL.rpc) {
        const { requestId, method, args } = d as {
          requestId: string
          method: string
          args: Record<string, unknown>
        }
        const reply = (result: unknown) =>
          iframeRef.current?.contentWindow?.postMessage(
            { type: PLUGIN_PROTOCOL.rpcResult, requestId, result },
            '*',
          )
        try {
          if (
            method === 'upsert' ||
            method === 'patch' ||
            method === 'delete'
          ) {
            const result = await mutate({
              op: method,
              type: String(args.type ?? ''),
              slug: String(args.slug ?? ''),
              data:
                method === 'delete'
                  ? undefined
                  : (args.data as Record<string, unknown> | undefined),
            })
            reply(result)
          } else if (method === 'fetchEntities') {
            const result = await fetchEntities({
              type: String(args.type ?? ''),
            })
            reply(result)
          } else {
            reply({ ok: false, error: `unknown method: ${method}` })
          }
        } catch (err) {
          reply({ ok: false, error: (err as Error).message })
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [mutate, fetchEntities])

  // Push data to the iframe whenever entities/plugin/query change.
  useEffect(() => {
    const win = iframeRef.current?.contentWindow
    if (!win) return
    win.postMessage(
      {
        type: PLUGIN_PROTOCOL.data,
        entities: entities ?? [],
        plugin: {
          id: plugin.id,
          name: plugin.name,
          config: plugin.config,
        },
        query,
      },
      '*',
    )
  }, [entities, plugin, query])

  return (
    <div className="custom-kernel">
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        title={plugin.name}
        style={{ width: '100%', height, border: 'none', background: 'transparent' }}
        onLoad={() => {
          const win = iframeRef.current?.contentWindow
          if (!win) return
          win.postMessage(
            {
              type: PLUGIN_PROTOCOL.data,
              entities: entities ?? [],
              plugin: {
                id: plugin.id,
                name: plugin.name,
                config: plugin.config,
              },
              query,
            },
            '*',
          )
        }}
      />
    </div>
  )
}

function wrapPluginBody(body: string): string {
  const P = PLUGIN_PROTOCOL
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  html, body {
    margin: 0;
    padding: 0;
    font-family: 'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.55;
    color: #1b1b1b;
    background: transparent;
  }
  body { padding: 4px; }
</style>
<script>
  /* dohc plugin bridge — auto-injected. Defined in <head> BEFORE the
   * plugin body so a body inline script can call window.dohc (e.g.
   * window.dohc.onUpdate) synchronously without a race. The
   * ResizeObserver is deferred until the body exists. See SDK types:
   * window.dohc (@dohc/plugin-sdk). */
  (function() {
    var _cb = null;
    var _pending = {};
    var _seq = 0;

    function rpc(method, args) {
      return new Promise(function(resolve) {
        var requestId = 'r' + (++_seq);
        _pending[requestId] = resolve;
        parent.postMessage({ type: '${P.rpc}', requestId: requestId, method: method, args: args || {} }, '*');
      });
    }

    window.dohc = {
      data: null,
      onUpdate: function(cb) {
        _cb = cb;
        if (window.dohc.data) {
          try { cb(window.dohc.data); } catch (e) { console.error(e); }
        }
      },
      upsert: function(args) { return rpc('upsert', args); },
      patch:  function(args) { return rpc('patch',  args); },
      delete: function(args) { return rpc('delete', args); },
      fetchEntities: function(type) { return rpc('fetchEntities', { type: type }); },
    };

    window.addEventListener('message', function(e) {
      var d = e.data;
      if (!d) return;
      if (d.type === '${P.data}') {
        window.dohc.data = {
          entities: d.entities || [],
          plugin: d.plugin || {},
          query: d.query || {}
        };
        if (_cb) {
          try { _cb(window.dohc.data); } catch (err) { console.error(err); }
        }
        return;
      }
      if (d.type === '${P.rpcResult}' && _pending[d.requestId]) {
        var resolve = _pending[d.requestId];
        delete _pending[d.requestId];
        resolve(d.result);
        return;
      }
    });

    function postHeight() {
      var de = document.documentElement;
      var b = document.body;
      var h = Math.max(de ? de.scrollHeight : 0, b ? b.scrollHeight : 0);
      parent.postMessage({ type: '${P.resize}', height: h + 4 }, '*');
    }
    function startResize() {
      try {
        if (typeof ResizeObserver !== 'undefined' && document.body) {
          new ResizeObserver(postHeight).observe(document.body);
        }
      } catch (e) { /* observer unavailable — fall back to load/timeout */ }
      postHeight();
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startResize);
    } else {
      startResize();
    }
    window.addEventListener('load', postHeight);
    setTimeout(postHeight, 100);
    setTimeout(postHeight, 500);
  })();
</script>
</head>
<body>
${body}
</body>
</html>`
}
