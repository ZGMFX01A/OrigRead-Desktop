import { useEffect, useState } from 'react'

export function useDebouncedValue(value: string, delay = 180): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), value ? delay : 0)
    return () => clearTimeout(timer)
  }, [value, delay])
  return value ? debounced : ''
}
