import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (startedAt === null) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1_000))
}

export function ElapsedTime({ startedAt, label }: { startedAt: number | null; label: string }) {
  const { t } = useTranslation()
  const seconds = useElapsedSeconds(startedAt)
  return <span>{t(label, { count: seconds })}</span>
}
