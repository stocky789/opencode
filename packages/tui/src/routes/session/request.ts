type SessionRequest = {
  id: string
}

type SessionInfo = {
  id: string
  parentID?: string
}

export function visibleSessionRequests<T extends SessionRequest>(input: {
  routeSessionID: string
  currentSession: SessionInfo | undefined
  sessions: readonly SessionInfo[]
  requests: Record<string, readonly T[] | undefined>
}) {
  if (input.currentSession?.parentID) return []

  const parentID = input.currentSession?.id ?? input.routeSessionID
  const sessionIDs = new Set([input.routeSessionID, parentID])
  for (const session of input.sessions) {
    if (session.id === parentID || session.parentID === parentID) {
      sessionIDs.add(session.id)
    }
  }

  return [...sessionIDs].toSorted().flatMap((sessionID) => input.requests[sessionID] ?? [])
}
