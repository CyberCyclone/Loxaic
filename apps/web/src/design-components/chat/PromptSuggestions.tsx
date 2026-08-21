import React from 'react'
import { PROMPT_SUGGESTIONS } from '../fixtures/conversations'

interface PromptSuggestionsProps {
  onPick: (text: string) => void
}

export function PromptSuggestions({ onPick }: PromptSuggestionsProps) {
  return (
    <div className="empty-state">
      <h2>How can I help?</h2>
      <p>Start a conversation, or try one of these:</p>
      <div className="prompt-suggestions">
        {PROMPT_SUGGESTIONS.map((s, i) => (
          <button key={i} className="prompt-card" onClick={() => onPick(s.title)}>
            <h3>{s.title}</h3>
            <p>{s.desc}</p>
          </button>
        ))}
      </div>
    </div>
  )
}
