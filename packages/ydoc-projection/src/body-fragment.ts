import type * as Y from 'yjs'

const BODY_FIELD = 'body'

export function getDohcYDocBodyFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(BODY_FIELD)
}
