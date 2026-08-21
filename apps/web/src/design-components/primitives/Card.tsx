import React from 'react'

interface CardProps {
  className?: string
  odId?: string
  children: React.ReactNode
}

export function Card({ className = '', odId, children }: CardProps) {
  return <div className={`card ${className}`} data-od-id={odId}>{children}</div>
}

function CardHeader({ children }: { children: React.ReactNode }) {
  return <div className="card-header">{children}</div>
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return <span className="card-title">{children}</span>
}

function CardSubtitle({ children }: { children: React.ReactNode }) {
  return <span className="card-subtitle">{children}</span>
}

Card.Header = CardHeader
Card.Title = CardTitle
Card.Subtitle = CardSubtitle
