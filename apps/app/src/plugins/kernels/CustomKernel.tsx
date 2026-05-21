import { useEffect, useMemo, useRef, useState } from 'react'
import { useAction, useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import type { KernelProps } from '../types'

// Sandboxed-iframe kernel. The plugin atom's body is the iframe's
// document. Communicates with the parent via postMessage.
//
// Bridge surface (auto-injected; see vibeam-plugin.d.ts for types):
//   window.vibeam.data        — { entities, plugin, query } | null
//   window.vibeam.onUpdate(cb)
//   window.vibeam.upsert({ type, slug, data })       — Promise<MutationResult>
//   window.vibeam.patch({ type, slug, data })        — Promise<MutationResult>
//   window.vibeam.delete({ type, slug })             — Promise<MutationResult>
//   window.vibeam.fetchEntities(type)                — Promise<Entity[]>
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

      if (d.type === 'vibeam:resize') {
        const h = Math.max(40, Math.min(2000, Number(d.height) || 80))
        setHeight(h)
        return
      }

      if (d.type === 'vibeam:rpc') {
        const { requestId, method, args } = d as {
          requestId: string
          method: string
          args: Record<string, unknown>
        }
        const reply = (result: unknown) =>
          iframeRef.current?.contentWindow?.postMessage(
            { type: 'vibeam:rpc:result', requestId, result },
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
        type: 'vibeam:data',
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
              type: 'vibeam:data',
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
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  html, body {
    margin: 0;
    padding: 0;
    font-family: 'Geist Mono', ui-monospace, 'Berkeley Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.55;
    color: #1b1b1b;
    background: transparent;
  }
  body { padding: 4px; }
</style>
</head>
<body>
${body}
<script>
  /* vibeam plugin bridge — auto-injected. See SDK types: window.vibeam */
  (function() {
    var _cb = null;
    var _pending = {};
    var _seq = 0;

    function rpc(method, args) {
      return new Promise(function(resolve) {
        var requestId = 'r' + (++_seq);
        _pending[requestId] = resolve;
        parent.postMessage({ type: 'vibeam:rpc', requestId: requestId, method: method, args: args || {} }, '*');
      });
    }

    window.vibeam = {
      data: null,
      onUpdate: function(cb) {
        _cb = cb;
        if (window.vibeam.data) {
          try { cb(window.vibeam.data); } catch (e) { console.error(e); }
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
      if (d.type === 'vibeam:data') {
        window.vibeam.data = {
          entities: d.entities || [],
          plugin: d.plugin || {},
          query: d.query || {}
        };
        if (_cb) {
          try { _cb(window.vibeam.data); } catch (err) { console.error(err); }
        }
        return;
      }
      if (d.type === 'vibeam:rpc:result' && _pending[d.requestId]) {
        var resolve = _pending[d.requestId];
        delete _pending[d.requestId];
        resolve(d.result);
        return;
      }
    });

    function postHeight() {
      var h = Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight
      );
      parent.postMessage({ type: 'vibeam:resize', height: h + 4 }, '*');
    }
    var ro = new ResizeObserver(postHeight);
    ro.observe(document.body);
    window.addEventListener('load', postHeight);
    setTimeout(postHeight, 100);
    setTimeout(postHeight, 500);
  })();
</script>
</body>
</html>`
}
