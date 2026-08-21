import React from 'react'

interface ModalProps {
  open: boolean
  onClose: () => void
  className?: string
  odId?: string
  children: React.ReactNode
}

export function Modal({ open, onClose, className = '', odId, children }: ModalProps) {
  if (!open) return null
  return (
    <div className="modal-overlay" data-od-id={odId} onClick={onClose}>
      <div className={`modal ${className}`} onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

function ModalHeader({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  return (
    <div className="modal-header">
      {children}
      {onClose && <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>}
    </div>
  )
}

function ModalBody({ children }: { children: React.ReactNode }) {
  return <div className="modal-body">{children}</div>
}

function ModalFooter({ children }: { children: React.ReactNode }) {
  return <div className="modal-footer">{children}</div>
}

Modal.Header = ModalHeader
Modal.Body = ModalBody
Modal.Footer = ModalFooter
