import { Check, CheckCircle2, ChevronRight, Copy, Globe2, Info, Laptop, Link2, Monitor, Network, Radio, RefreshCw, RotateCcw, Shield, ShieldAlert, ShieldCheck, Smartphone, Tablet, Trash2, Wifi, WifiOff, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SyncDesktopStatus, SyncNetworkDiagnostics, SyncRunHistorySummary, SyncTrustedDeviceSummary } from '../../shared/sync-control'
import type { SyncDiscoveredPeer } from '../../shared/sync-protocol'

interface SyncSettingsPanelProps {
  onStatusChange?(): void
}

export function SyncSettingsPanel({ onStatusChange }: SyncSettingsPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<SyncDesktopStatus | null>(null)
  const [trustedDevices, setTrustedDevices] = useState<SyncTrustedDeviceSummary[]>([])
  const [discoveredPeers, setDiscoveredPeers] = useState<SyncDiscoveredPeer[]>([])
  const [isDiscovering, setIsDiscovering] = useState(false)
  const [diagnostics, setDiagnostics] = useState<SyncNetworkDiagnostics | null>(null)
  const [runHistory, setRunHistory] = useState<SyncRunHistorySummary[]>([])
  const [activeSession, setActiveSession] = useState<any | null>(null)
  const [manualAddress, setManualAddress] = useState('')
  const [syncingEndpointId, setSyncingEndpointId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ type: 'info' | 'error' | 'success'; message: string } | null>(null)

  const refreshAll = async (): Promise<void> => {
    try {
      const [s, devices, diag, history] = await Promise.all([
        window.origread.getSyncStatus(),
        window.origread.listSyncTrustedDevices(),
        window.origread.getSyncDiagnostics(),
        window.origread.getSyncRunHistory(50)
      ])
      setStatus(s)
      setTrustedDevices(devices)
      setDiagnostics(diag)
      setRunHistory(history)
      onStatusChange?.()
    } catch (err: any) {
      setNotice({ type: 'error', message: err.message ?? 'Failed to load sync status' })
    }
  }

  useEffect(() => {
    void refreshAll()

    // 监听局域网配对事件
    const unsubscribePairing = window.origread.onSyncPairingUpdated((session: any) => {
      setActiveSession(session)
      if (session.status === 'CANCELLED' && session.cancellationOrigin === 'PEER') {
        setNotice({ type: 'info', message: session.failureMessage ?? '对端已取消配对' })
      } else if (session.failureMessage) {
        setNotice({ type: 'error', message: `配对尚未完成: ${session.failureMessage}` })
      }
      if (session.status === 'CONFIRMED' || session.status === 'REJECTED') {
        void refreshAll()
      }
    })

    return () => {
      unsubscribePairing()
    }
  }, [])

  const handleToggleLan = async (enabled: boolean): Promise<void> => {
    try {
      await window.origread.toggleLanSync(enabled)
      await refreshAll()
      setNotice({ type: 'success', message: enabled ? '局域网监听与广播已开启' : '局域网监听已关闭' })
    } catch (err: any) {
      setNotice({ type: 'error', message: err.message ?? '切换局域网同步失败' })
    }
  }

  const handleScanPeers = async (): Promise<void> => {
    setIsDiscovering(true)
    setNotice(null)
    try {
      const res = await window.origread.discoverSyncPeers(2500)
      setDiscoveredPeers(res.peers)
      if (res.peers.length === 0) {
        setNotice({ type: 'info', message: '未在局域网内发现其他 OrigRead 节点' })
      }
    } catch (err: any) {
      setNotice({ type: 'error', message: err.message ?? '扫描失败' })
    } finally {
      setIsDiscovering(false)
    }
  }

  const handleInitiatePairing = async (peer: SyncDiscoveredPeer): Promise<void> => {
    setNotice(null)
    try {
      const session = await window.origread.initiateSyncPairing(
        peer.host,
        peer.port,
        peer.localBindAddress
      )
      setActiveSession(session)
    } catch (err: any) {
      setNotice({ type: 'error', message: `发起配对失败: ${err.message}` })
    }
  }

  const handleConfirmPairing = async (): Promise<void> => {
    if (!activeSession) return
    try {
      const res = await window.origread.confirmSyncPairing(activeSession.sessionId)
      setActiveSession(res)
      await refreshAll()
      if (res.status === 'CONFIRMED') {
        setNotice({ type: 'success', message: '设备信任已保存，双方可开始同步' })
      } else if (res.status === 'WAITING_PEER') {
        setNotice({ type: 'info', message: '本机确认已发送，等待对方确认；完成前不会建立同步信任' })
      } else {
        setNotice({ type: 'error', message: res.message ?? `配对未完成：${res.status}` })
      }
    } catch (err: any) {
      setNotice({ type: 'error', message: `确认配对失败: ${err.message}` })
    }
  }

  const handleCancelPairing = async (): Promise<void> => {
    if (!activeSession) return
    try {
      await window.origread.cancelSyncPairing(activeSession.sessionId)
      setActiveSession(null)
      setNotice({ type: 'info', message: '已取消配对' })
    } catch (err: any) {
      setNotice({ type: 'error', message: `取消失败: ${err.message}` })
    }
  }

  const handleRevokeDevice = async (deviceId: string): Promise<void> => {
    if (!window.confirm('确定撤销该受信任设备？撤销后该设备将无法同步新增数据。')) return
    try {
      await window.origread.revokeSyncTrustedDevice(deviceId)
      setNotice({ type: 'success', message: '已撤销该设备权限 (MEMBER_REVOKE)' })
      await refreshAll()
    } catch (err: any) {
      setNotice({ type: 'error', message: `撤销操作失败: ${err.message}` })
    }
  }

  const handleConnectManual = async (): Promise<void> => {
    if (!manualAddress.trim()) return
    setNotice(null)
    try {
      const result = await window.origread.connectManualSyncPeer(manualAddress.trim())
      setManualAddress('')
      const hasError = result.diagnostics.length > 0
      setNotice({
        type: hasError ? 'error' : 'success',
        message: hasError
          ? `手动同步报错: ${result.diagnostics.map((d) => d.message).join('; ')}`
          : `手动同步完成：推送 ${result.pushedOperationIds.length}，应用 ${result.appliedOperationIds.length}`
      })
      await refreshAll()
    } catch (err: any) {
      setNotice({ type: 'error', message: `手动连接失败: ${err.message}` })
    }
  }

  const handleSyncNow = async (endpointId: string): Promise<void> => {
    setSyncingEndpointId(endpointId)
    setNotice(null)
    const progressTimer = window.setInterval(() => {
      void window.origread.getSyncRunHistory(50)
        .then(setRunHistory)
        .catch(() => {})
    }, 400)
    try {
      const result = await window.origread.syncNow(endpointId)
      setNotice({
        type: 'success',
        message: `同步完成: 推送 ${result.pushedOperationIds.length} 个操作，拉取 ${result.pulledOperationIds.length} 个操作`
      })
      await refreshAll()
    } catch (err: any) {
      setNotice({ type: 'error', message: `同步异常: ${err.message}` })
    } finally {
      window.clearInterval(progressTimer)
      await window.origread.getSyncRunHistory(50).then(setRunHistory).catch(() => {})
      setSyncingEndpointId(null)
    }
  }

  const getPlatformIcon = (platform: string) => {
    const p = platform.toUpperCase()
    if (p.includes('ANDROID') || p.includes('PHONE')) return <Smartphone size={16} />
    if (p.includes('TABLET')) return <Tablet size={16} />
    return <Laptop size={16} />
  }

  return (
    <div className="sync-settings-pane" style={{ padding: '0 8px 32px 8px' }}>
      {/* 提示通知 */}
      {notice && (
        <div
          className={`sync-notice sync-notice-${notice.type}`}
          style={{
            padding: '10px 16px',
            marginBottom: '16px',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            background: notice.type === 'error' ? 'var(--color-danger-subtle, #ffebee)' : 'var(--color-accent-subtle, #e8f4fd)',
            color: notice.type === 'error' ? 'var(--color-danger, #d32f2f)' : 'var(--color-accent, #0288d1)',
            fontSize: '13px'
          }}
        >
          {notice.type === 'error' ? <ShieldAlert size={16} /> : <Info size={16} />}
          <span style={{ flex: 1 }}>{notice.message}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* 1. 本机身份卡片 */}
      <section className="settings-section" style={{ marginBottom: '24px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <ShieldCheck size={18} />
          本机同步身份
        </h3>
        <div style={{ background: 'var(--color-surface, #f9f9f9)', padding: '14px 16px', borderRadius: '10px', border: '1px solid var(--color-border, #eee)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '8px', fontSize: '13px' }}>
            <span style={{ color: 'var(--color-text-secondary, #666)' }}>设备 ID:</span>
            <span style={{ fontFamily: 'monospace' }}>{status?.deviceId ?? '未初始化'}</span>

            <span style={{ color: 'var(--color-text-secondary, #666)' }}>同步空间 ID:</span>
            <span style={{ fontFamily: 'monospace' }}>{status?.syncSpaceId ?? '未创建'}</span>

            <span style={{ color: 'var(--color-text-secondary, #666)' }}>生命周期:</span>
            <span>{status?.lifecycleState ?? 'IDLE'}</span>

            <span style={{ color: 'var(--color-text-secondary, #666)' }}>局域网监听:</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {status?.isLanEnabled ? (
                <span style={{ color: 'var(--color-success, #2e7d32)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <Wifi size={14} /> 运行中 (端口: {status.lanPort})
                </span>
              ) : status?.isLanRequested ? (
                <span style={{ color: 'var(--color-warning, #ed6c02)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <WifiOff size={14} /> 已开启，暂时挂起{status.lanSuspendedReason ? ` (${status.lanSuspendedReason})` : ''}
                </span>
              ) : (
                <span style={{ color: 'var(--color-text-secondary, #888)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <WifiOff size={14} /> 已停止
                </span>
              )}
            </span>
          </div>

          <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--color-border, #eee)', display: 'flex', gap: '10px' }}>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => handleToggleLan(!status?.isLanRequested)}
              style={{ fontSize: '13px', padding: '6px 14px' }}
            >
              {status?.isLanRequested ? '关闭局域网同步' : '开启局域网同步'}
            </button>
          </div>
        </div>
      </section>

      {/* 2. 局域网设备扫描与发现 */}
      <section className="settings-section" style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <h3 style={{ fontSize: '15px', fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Radio size={18} />
            附近局域网设备
          </h3>
          <button
            type="button"
            className="button button-primary"
            onClick={handleScanPeers}
            disabled={isDiscovering}
            style={{ fontSize: '12px', padding: '4px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <RefreshCw size={13} className={isDiscovering ? 'spin' : ''} />
            {isDiscovering ? '扫描中...' : '扫描附近设备'}
          </button>
        </div>

        {discoveredPeers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px', color: 'var(--color-text-secondary, #888)', fontSize: '13px', background: 'var(--color-surface, #f9f9f9)', borderRadius: '8px' }}>
            {isDiscovering ? '正在通过 mDNS/DNS-SD 搜索附近设备...' : '暂未发现附近局域网节点，请确认两端处于同一局域网并已开启局域网同步'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {discoveredPeers.map((peer) => {
              const isTrusted = trustedDevices.some((d) => d.deviceId === peer.deviceId && d.trustState === 'TRUSTED')
              return (
                <div
                  key={peer.endpointId}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '12px 16px',
                    background: 'var(--color-surface, #fff)',
                    border: '1px solid var(--color-border, #eee)',
                    borderRadius: '8px'
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {peer.displayName}
                      {isTrusted && (
                        <span style={{ fontSize: '11px', color: 'var(--color-accent, #0288d1)', background: 'var(--color-accent-subtle, #e1f5fe)', padding: '2px 6px', borderRadius: '4px' }}>
                          已信任
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--color-text-secondary, #666)', marginTop: '2px' }}>
                      地址: {peer.host}:{peer.port} · 设备 ID: {peer.deviceId}
                    </div>
                  </div>
                  <div>
                    {isTrusted ? (
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => {
                          const ep = status?.endpoints.find((e) => e.endpointId.includes(peer.deviceId))
                          if (ep) handleSyncNow(ep.endpointId)
                        }}
                        style={{ fontSize: '12px', padding: '4px 10px' }}
                      >
                        立即同步
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button button-primary"
                        onClick={() => handleInitiatePairing(peer)}
                        style={{ fontSize: '12px', padding: '4px 12px' }}
                      >
                        发起配对
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* 3. 手动连接设备 (Manual IP Fallback) */}
      <section className="settings-section" style={{ marginBottom: '24px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Link2 size={18} />
          手动连接对端 (IP / 域名)
        </h3>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            className="input"
            placeholder="输入目标主机 (如 192.168.1.15:8787 或 http://192.168.1.15:8787)"
            value={manualAddress}
            onChange={(e) => setManualAddress(e.target.value)}
            style={{ flex: 1, fontSize: '13px' }}
          />
          <button
            type="button"
            className="button button-secondary"
            onClick={handleConnectManual}
            style={{ fontSize: '13px', padding: '6px 16px' }}
          >
            连接
          </button>
        </div>
      </section>

      {/* 4. 已受信任设备列表 (Trusted Devices) */}
      <section className="settings-section" style={{ marginBottom: '24px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Shield size={18} />
          已受信任设备 ({trustedDevices.length})
        </h3>
        {trustedDevices.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '20px', color: 'var(--color-text-secondary, #888)', fontSize: '13px', background: 'var(--color-surface, #f9f9f9)', borderRadius: '8px' }}>
            尚未配对任何设备。配对后建立长期 Durable Trust，自动同步变更。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {trustedDevices.map((dev) => {
              const isRevoked = dev.trustState === 'REVOKED'
              return (
                <div
                  key={dev.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '12px 16px',
                    background: isRevoked ? 'var(--color-danger-subtle, #fff5f5)' : 'var(--color-surface, #fff)',
                    border: '1px solid var(--color-border, #eee)',
                    borderRadius: '8px'
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {getPlatformIcon(dev.platform)}
                      <span>{dev.displayName}</span>
                      <span style={{ fontSize: '11px', color: isRevoked ? '#d32f2f' : '#2e7d32' }}>
                        [{dev.platform}] {isRevoked ? '已撤销' : 'ACTIVE'}
                      </span>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--color-text-secondary, #666)', marginTop: '4px', fontFamily: 'monospace' }}>
                      指纹: {dev.fingerprint.slice(0, 24)}...
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--color-text-secondary, #888)', marginTop: '2px' }}>
                      配对时间: {new Date(dev.pairedAt).toLocaleString()}
                    </div>
                  </div>
                  <div>
                    {!isRevoked ? (
                      <button
                        type="button"
                        className="button button-danger"
                        onClick={() => handleRevokeDevice(dev.deviceId)}
                        style={{ fontSize: '12px', padding: '4px 10px' }}
                      >
                        撤销权限
                      </button>
                    ) : (
                      <span style={{ fontSize: '12px', color: '#d32f2f' }}>已撤销</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* 5. 同步运行历史 */}
      <section className="settings-section" style={{ marginBottom: '24px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <RotateCcw size={18} />
          同步运行历史
        </h3>
        {runHistory.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '20px', color: 'var(--color-text-secondary, #888)', fontSize: '13px', background: 'var(--color-surface, #f9f9f9)', borderRadius: '8px' }}>
            暂无同步运行记录
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {runHistory.slice(0, 10).map((run) => (
              <div
                key={run.runId}
                style={{
                  padding: '10px 14px',
                  background: run.status === 'FAILED' ? 'var(--color-danger-subtle, #fff5f5)' : 'var(--color-surface, #fff)',
                  border: '1px solid var(--color-border, #eee)',
                  borderRadius: '8px',
                  fontSize: '12px'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                  <strong>{run.transport ?? 'SYNC'} · {run.status === 'SUCCEEDED' ? '成功' : run.status === 'FAILED' ? '失败' : '进行中'}</strong>
                  <span style={{ color: 'var(--color-text-secondary, #888)' }}>{new Date(run.startedAt).toLocaleString()}</span>
                </div>
                <div style={{ marginTop: '4px', color: 'var(--color-text-secondary, #666)' }}>
                  阶段 {run.stage} · 重试 {run.retryAttempt}
                </div>
                <div style={{ marginTop: '2px' }}>
                  操作 ↑{run.pushedOperations} ↓{run.pulledOperations} · 应用 {run.appliedOperations} · 拒绝 {run.rejectedOperations}
                </div>
                <div style={{ marginTop: '2px' }}>
                  Blob ↑{formatSyncBytes(run.blobBytesSent)} ↓{formatSyncBytes(run.blobBytesReceived)}
                </div>
                {run.errorMessage && (
                  <div style={{ marginTop: '4px', color: 'var(--color-danger, #d32f2f)' }}>
                    {run.errorCode ?? 'SYNC_FAILED'}: {run.errorMessage}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 6. 网络诊断信息 */}
      <section className="settings-section">
        <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Network size={18} />
          局域网环境诊断
        </h3>
        <div style={{ background: 'var(--color-surface, #f9f9f9)', padding: '14px 16px', borderRadius: '10px', border: '1px solid var(--color-border, #eee)', fontSize: '13px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '8px' }}>
            <span style={{ color: 'var(--color-text-secondary, #666)' }}>局域网可用地址:</span>
            <span>{diagnostics?.hasUsableLanAddress ? '有可用活跃 IP' : '未检测到局域网 IP'}</span>

            <span style={{ color: 'var(--color-text-secondary, #666)' }}>组播端口绑定:</span>
            <span>{diagnostics?.multicastBindOk ? '正常 (5353/UDP)' : '异常或受阻'}</span>

            <span style={{ color: 'var(--color-text-secondary, #666)' }}>网络网卡接口:</span>
            <span>
              {diagnostics?.interfaces.map((i) => `${i.name} (${i.address})`).join(', ') || '无'}
            </span>
          </div>

          {diagnostics?.warnings && diagnostics.warnings.length > 0 && (
            <div style={{ marginTop: '12px', padding: '8px 12px', background: '#fff3e0', color: '#e65100', borderRadius: '6px', fontSize: '12px' }}>
              <strong>提示:</strong>
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {diagnostics.warnings.map((w, idx) => (
                  <li key={idx}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      {/* 配对核对对话框 (Authenticated Interactive Pairing Modal) */}
      {activeSession && activeSession.status === 'WAITING_CONFIRMATION' && (
        <div
          className="modal-backdrop"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999
          }}
        >
          <div
            className="modal-content"
            style={{
              background: 'var(--color-surface, #fff)',
              padding: '24px',
              borderRadius: '12px',
              width: '420px',
              maxWidth: '90vw',
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)'
            }}
          >
            <div style={{ textAlign: 'center', marginBottom: '16px' }}>
              <ShieldCheck size={36} color="var(--color-primary, #1976d2)" />
              <h3 style={{ fontSize: '18px', fontWeight: 600, marginTop: '8px', marginBottom: '4px' }}>
                确认配对安全代码
              </h3>
              <p style={{ fontSize: '13px', color: 'var(--color-text-secondary, #666)', margin: 0 }}>
                请核对对方屏幕上的验证码与指纹是否完全一致
              </p>
            </div>

            {/* SAS 码展示区 */}
            <div
              style={{
                background: 'var(--color-accent-subtle, #e3f2fd)',
                color: 'var(--color-accent, #0d47a1)',
                padding: '16px',
                borderRadius: '10px',
                textAlign: 'center',
                marginBottom: '16px'
              }}
            >
              <div style={{ fontSize: '32px', fontWeight: 'bold', letterSpacing: '4px', fontFamily: 'monospace' }}>
                {activeSession.sasCode}
              </div>
            </div>

            <div style={{ background: 'var(--color-surface-variant, #f5f5f5)', padding: '12px', borderRadius: '8px', fontSize: '12px', marginBottom: '20px' }}>
              <div style={{ marginBottom: '4px' }}>
                <strong>对端设备:</strong> {activeSession.remoteDisplayName} ({activeSession.remotePlatform})
              </div>
              <div style={{ fontFamily: 'monospace', color: 'var(--color-text-secondary, #666)', marginBottom: '4px' }}>
                <strong>对端指纹:</strong> {activeSession.remoteFingerprint}
              </div>
              <div style={{ fontFamily: 'monospace', color: 'var(--color-text-secondary, #666)' }}>
                <strong>本机指纹:</strong> {activeSession.localFingerprint}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                type="button"
                className="button button-secondary"
                onClick={handleCancelPairing}
                style={{ flex: 1, padding: '8px' }}
              >
                不一致 / 取消
              </button>
              <button
                type="button"
                className="button button-primary"
                onClick={handleConfirmPairing}
                style={{ flex: 1, padding: '8px' }}
              >
                确认一致
              </button>
            </div>
          </div>
        </div>
      )}

      {activeSession && activeSession.status === 'WAITING_PEER' && (
        <div className="modal-backdrop" style={{ position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div className="modal-content" style={{ background: 'var(--color-surface, #fff)', padding: '24px', borderRadius: '12px', width: '420px', maxWidth: '90vw', boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)' }}>
            <h3 style={{ fontSize: '18px', fontWeight: 600, marginTop: 0 }}>等待对方完成配对确认</h3>
            <p style={{ fontSize: '13px', color: activeSession.failureMessage ? 'var(--color-error, #b3261e)' : 'var(--color-text-secondary, #666)' }}>
              {activeSession.failureMessage ?? '本机确认已发送；在双方确认且授权数据成功保存前，不会建立同步信任。'}
            </p>
            <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
              <button type="button" className="button button-secondary" onClick={handleCancelPairing} style={{ flex: 1, padding: '8px' }}>取消</button>
              <button type="button" className="button button-primary" onClick={handleConfirmPairing} style={{ flex: 1, padding: '8px' }}>重试确认</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function formatSyncBytes(value: number): string {
  if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MiB'
  if (value >= 1024) return (value / 1024).toFixed(1) + ' KiB'
  return value + ' B'
}
