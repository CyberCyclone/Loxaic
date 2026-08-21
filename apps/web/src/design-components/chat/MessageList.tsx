import React, { useState, useRef, useEffect } from 'react'
import type { Conversation } from '../types'
import { Message } from './Message'

interface MessageListProps {
  conversation: Conversation | null
}

export function MessageList({ conversation }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [conversation?.id])

  if (!conversation) return null

  return (
    <div className="chat-area" ref={scrollRef}>
      {conversation.msgs.map((msg, i) => (
        <Message key={i} msg={msg} />
      ))}
    </div>
  )
}
