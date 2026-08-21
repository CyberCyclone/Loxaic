import React from 'react'

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  odId?: string
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', odId, ...props }, ref) => (
    <input ref={ref} className={`input ${className}`} data-od-id={odId} {...props} />
  )
)
Input.displayName = 'Input'

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  odId?: string
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className = '', odId, children, ...props }, ref) => (
    <select ref={ref} className={`input ${className}`} data-od-id={odId} {...props}>
      {children}
    </select>
  )
)
Select.displayName = 'Select'

export function Label({ children }: { children: React.ReactNode }) {
  return <label className="label">{children}</label>
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <span className="hint">{children}</span>
}
