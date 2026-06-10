import { createContext, useContext } from 'react'
import type { CloudApi, CloudUser } from './cloudApi'

export type CloudSession = {
  user: CloudUser
  api: CloudApi
  signOut: () => void
}

const CloudSessionContext = createContext<CloudSession | null>(null)

export const CloudSessionProvider = CloudSessionContext.Provider

export function useCloudSession(): CloudSession {
  const session = useContext(CloudSessionContext)
  if (!session) throw new Error('useCloudSession used outside CloudSessionProvider')
  return session
}
