import React from 'react'

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  odId?: string
}

export function Switch({ checked, onChange, odId }: SwitchProps) {
  return (
    <label className="switch" data-od-id={odId}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="switch-track" />
    </label>
  )
}
