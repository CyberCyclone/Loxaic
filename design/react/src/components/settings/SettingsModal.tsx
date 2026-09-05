import React, { useState, useEffect } from 'react'
import type { Settings, SmartRouting, ThemePref, AgentMode, ThinkingLevel } from '../../types'
import { LOXAIC_MODELS } from '../../fixtures/models'
import { Modal } from '../primitives/Modal'
import { Button } from '../primitives/Button'
import { Input, Select } from '../primitives/Input'
import { Switch } from '../primitives/Switch'
import { Badge } from '../primitives/Badge'
import { ProgressBar } from '../primitives/Table'
import { useSettings, useSmartRouting } from '../../hooks/useSettings'
import { useTheme } from '../../hooks/useTheme'
import { useToast } from '../../hooks/useToast'

type SettingsTab = 'general' | 'models' | 'workspaces' | 'devices' | 'server' | 'usage'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
  initialTab?: SettingsTab
}

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Models' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'devices', label: 'Devices' },
  { id: 'server', label: 'Server' },
  { id: 'usage', label: 'Usage' },
]

export function SettingsModal({ open, onClose, initialTab = 'general' }: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const [settings, setSettings] = useSettings()
  const [routing, setRouting] = useSmartRouting()
  const { pref, setTheme } = useTheme()
  const { showToast } = useToast()
  const [dirty, setDirty] = useState(false)
  const [draft, setDraft] = useState<Settings>(settings)

  useEffect(() => { if (open) { setTab(initialTab); setDraft(settings); setDirty(false) } }, [open, initialTab])

  const update = (key: keyof Settings, value: string) => {
    setDraft(prev => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  const save = () => {
    setSettings(draft)
    setDirty(false)
    showToast('Settings saved')
  }

  const discard = () => {
    setDraft(settings)
    setDirty(false)
  }

  const navItems = TABS.map(t => (
    <div
      key={t.id}
      className={`settings-nav-item ${tab === t.id ? 'active' : ''}`}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
        borderRadius: 'var(--r-sm)', fontSize: 14,
        color: tab === t.id ? 'var(--fg)' : 'var(--fg-2)',
        background: tab === t.id ? 'var(--muted)' : 'transparent',
        cursor: 'pointer', marginBottom: 2,
      }}
      onClick={() => setTab(t.id)}
    >
      {t.label}
    </div>
  ))

  return (
    <Modal open={open} onClose={onClose} className="settings-modal" odId="settings-modal">
      <div className="modal-header">
        <span style={{ fontSize: 16, fontWeight: 600 }}>Settings</span>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
      </div>
      <div className="settings-modal-body">
        <nav className="settings-modal-nav">{navItems}</nav>
        <div className="settings-modal-content">
          {/* General */}
          {tab === 'general' && (
            <div className="settings-modal-section active">
              <h2>General</h2>
              <p className="desc">Profile and default agent behavior.</p>
              <div className="setting-row">
                <div><div className="setting-label">Display name</div><div className="setting-hint">Shown on synced devices</div></div>
                <Input style={{ width: 200 }} value={draft.name} onChange={e => update('name', e.target.value)} />
              </div>
              <div className="setting-row">
                <div><div className="setting-label">Default mode</div><div className="setting-hint">Starting permission level for new agent runs</div></div>
                <Select style={{ width: 150 }} value={draft.defaultMode} onChange={e => update('defaultMode', e.target.value)}>
                  <option value="planning">Planning</option>
                  <option value="manual">Manual</option>
                  <option value="auto">Auto</option>
                </Select>
              </div>
              <div className="setting-row">
                <div><div className="setting-label">Default thinking level</div><div className="setting-hint">Applied to new conversations</div></div>
                <Select style={{ width: 150 }} value={draft.defaultThinkingLevel} onChange={e => update('defaultThinkingLevel', e.target.value as ThinkingLevel)}>
                  <option value="None">None</option>
                  <option value="Low">Low</option>
                  <option value="Medium">Medium</option>
                  <option value="High">High</option>
                </Select>
              </div>
              <div className="setting-row">
                <div><div className="setting-label">Appearance</div><div className="setting-hint">Light, dark, or follow system</div></div>
                <div className="theme-seg">
                  {(['light', 'dark', 'system'] as ThemePref[]).map(p => (
                    <button key={p} className={`theme-seg-btn ${pref === p ? 'active' : ''}`} onClick={() => setTheme(p)}>
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          {/* Models */}
          {tab === 'models' && (
            <div className="settings-modal-section active">
              <h2>Models</h2>
              <p className="desc">Manage server and on-device models.</p>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Server Models</h3>
              {LOXAIC_MODELS.filter(m => m.location === 'server').map(m => (
                <div key={m.id} className="model-row">
                  <div className="model-row-info">
                    <div className="model-row-name">{m.display_name}</div>
                    <div className="model-row-meta">{m.quant} · {(m.context_tokens / 1000).toFixed(0)}K context · llama.cpp server</div>
                  </div>
                  <Button variant="ghost" size="sm">Remove</Button>
                </div>
              ))}
              <Button variant="secondary" size="sm" style={{ marginBottom: 16 }}>+ Add model by URL</Button>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>On-Device Models</h3>
              {LOXAIC_MODELS.filter(m => m.location === 'device').map(m => (
                <div key={m.id} className="model-row">
                  <div className="model-row-info">
                    <div className="model-row-name">{m.display_name}</div>
                    <div className="model-row-meta">{m.quant} · 4K context · downloaded</div>
                  </div>
                  <Button variant="ghost" size="sm">Remove</Button>
                </div>
              ))}
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: '16px 0 8px' }}>Smart Routing</h3>
              <p style={{ fontSize: 13, color: 'var(--fg-3)', marginBottom: 8 }}>Automatically select models based on task type.</p>
              <div className="smart-routing-profile">
                {(['cloud', 'server', 'hybrid'] as const).map(p => (
                  <button key={p} className={`profile-btn ${routing.profile === p ? 'active' : ''}`} onClick={() => setRouting(prev => ({ ...prev, profile: p }))}>
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
              <div className="task-mappings">
                <div><label className="label">Planning</label>
                  <Select value={routing.planning} onChange={e => setRouting(prev => ({ ...prev, planning: e.target.value }))}>
                    {LOXAIC_MODELS.map(m => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                  </Select>
                </div>
                <div><label className="label">Heavy thinking</label>
                  <Select value={routing.heavyThinking} onChange={e => setRouting(prev => ({ ...prev, heavyThinking: e.target.value }))}>
                    {LOXAIC_MODELS.map(m => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                  </Select>
                </div>
                <div><label className="label">Simple jobs</label>
                  <Select value={routing.simpleJobs} onChange={e => setRouting(prev => ({ ...prev, simpleJobs: e.target.value }))}>
                    {LOXAIC_MODELS.map(m => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                  </Select>
                </div>
              </div>
            </div>
          )}
          {/* Workspaces */}
          {tab === 'workspaces' && (
            <div className="settings-modal-section active">
              <h2>Workspaces</h2>
              <p className="desc">Server-side directories available as agent context.</p>
              <div className="model-row"><div className="model-row-info"><div className="model-row-name">Loxaic/design</div><div className="model-row-meta">/home/casey/projects/loxaic/design</div></div><Button variant="ghost" size="sm">Remove</Button></div>
              <div className="model-row"><div className="model-row-info"><div className="model-row-name">Loxaic/api</div><div className="model-row-meta">/home/casey/projects/loxaic/api</div></div><Button variant="ghost" size="sm">Remove</Button></div>
              <Button variant="secondary" size="sm">+ Register directory</Button>
            </div>
          )}
          {/* Devices */}
          {tab === 'devices' && (
            <div className="settings-modal-section active">
              <h2>Devices</h2>
              <p className="desc">Synced devices on your account.</p>
              <div className="model-row"><div className="model-row-info"><div className="model-row-name">MacBook Pro</div><div className="model-row-meta">macOS · last seen now</div></div><Badge tone="success">This device</Badge></div>
              <div className="model-row"><div className="model-row-info"><div className="model-row-name">iPhone 15</div><div className="model-row-meta">iOS · last seen 2h ago</div></div><Button variant="danger" size="sm">Revoke</Button></div>
              <div className="model-row"><div className="model-row-info"><div className="model-row-name">iPad Air</div><div className="model-row-meta">iPadOS · last seen 3d ago</div></div><Button variant="danger" size="sm">Revoke</Button></div>
            </div>
          )}
          {/* Server */}
          {tab === 'server' && (
            <div className="settings-modal-section active">
              <h2>Server</h2>
              <p className="desc">Connection to your llama.cpp inference server.</p>
              <div className="setting-row"><div><div className="setting-label">Tailscale address</div><div className="setting-hint">MagicDNS hostname</div></div><Input style={{ width: 240 }} value={draft.tailscale} onChange={e => update('tailscale', e.target.value)} /></div>
              <div className="setting-row"><div><div className="setting-label">Inference endpoint</div><div className="setting-hint">llama.cpp server URL</div></div><Input style={{ width: 240 }} value={draft.endpoint} onChange={e => update('endpoint', e.target.value)} /></div>
              <div className="setting-row"><div><div className="setting-label">Connection status</div><div className="setting-hint">Server reachable · llama.cpp v0.2.1</div></div><Badge tone="success">Connected</Badge></div>
            </div>
          )}
          {/* Usage */}
          {tab === 'usage' && (
            <div className="settings-modal-section active">
              <h2>Usage</h2>
              <p className="desc">Per-model token consumption.</p>
              <table>
                <thead><tr><th>Model</th><th>Conversations</th><th>Tokens</th><th>Cache %</th></tr></thead>
                <tbody>
                  <tr><td>Llama 3.1 8B</td><td>142</td><td>1,847,291</td><td>68%</td></tr>
                  <tr><td>Qwen 2.5 14B</td><td>67</td><td>820,103</td><td>58%</td></tr>
                  <tr><td>Phi 3 Mini</td><td>34</td><td>180,000</td><td>71%</td></tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {dirty && (
        <div className="save-bar show">
          <span style={{ fontSize: 13, color: 'var(--fg-3)', alignSelf: 'center', marginRight: 'auto' }}>Unsaved changes</span>
          <Button variant="ghost" onClick={discard}>Discard</Button>
          <Button variant="primary" onClick={save}>Save changes</Button>
        </div>
      )}
    </Modal>
  )
}
