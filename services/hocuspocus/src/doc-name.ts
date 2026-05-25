export type DohcDocNameParts = {
  workspaceId: string
  atomId: string
}

export function encodeDocName({ workspaceId, atomId }: DohcDocNameParts): string {
  if (!workspaceId || !atomId) {
    throw new Error('Invalid Hocuspocus document name parts')
  }

  return `workspace/${encodeURIComponent(workspaceId)}/atom/${encodeURIComponent(atomId)}`
}

export function decodeDocName(documentName: string): DohcDocNameParts {
  const parts = documentName.split('/')
  if (
    parts.length !== 4 ||
    parts[0] !== 'workspace' ||
    parts[2] !== 'atom' ||
    !parts[1] ||
    !parts[3]
  ) {
    throw new Error(`Invalid Hocuspocus document name: ${documentName}`)
  }

  return {
    workspaceId: decodeURIComponent(parts[1]),
    atomId: decodeURIComponent(parts[3]),
  }
}
