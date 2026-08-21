import React from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  odId?: string
}

export function Button({ variant = 'secondary', size = 'md', className = '', odId, children, ...props }: ButtonProps) {
  const classes = ['btn', `btn-${variant}`]
  if (size === 'sm') classes.push('btn-sm')
  if (size === 'lg') classes.push('btn-lg')
  if (className) classes.push(className)
  return (
    <button className={classes.join(' ')} data-od-id={odId} {...props}>
      {children}
    </button>
  )
}
