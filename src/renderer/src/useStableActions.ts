import { useLayoutEffect, useMemo, useRef } from 'react'

/** Keep event identities stable while calling the implementation from the latest committed render. */
export function useStableActions<T extends Record<string, (...args: any[]) => unknown>>(actions: T): T {
  const current = useRef(actions)
  useLayoutEffect(() => { current.current = actions })
  return useMemo(() => Object.fromEntries(Object.keys(actions).map(key => [key,
    (...args: unknown[]) => current.current[key]!(...args)
  ])) as T, [])
}
