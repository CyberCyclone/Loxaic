import { describe, expect, it } from 'vitest'
import { deleteConversationMessage } from './deleteMessage'

/**
 * The dialog exists to tell someone what they are about to lose, so a wrong
 * sentence here is the one kind of wrong that matters most: it is read at the
 * moment the decision is made, and it cannot be taken back afterwards.
 */
describe('deleteConversationMessage', () => {
  it('names the conversation and who else loses it', () => {
    const msg = deleteConversationMessage('Quarterly numbers', 'chat', null)
    expect(msg).toContain('“Quarterly numbers”')
    expect(msg).toContain('anyone it is shared with')
  })

  describe('an agent run, whose files are the part nobody guesses', () => {
    it('warns that a server-side workspace goes with it', () => {
      for (const kind of ['scratch', 'github'] as const) {
        const msg = deleteConversationMessage('Fix the parser', 'agent', null, kind)
        expect(msg).toContain('workspace is destroyed')
        expect(msg).toContain('never pushed')
      }
    })

    it('does NOT claim that for a local workspace — the folder is the user’s own', () => {
      // executor/service.ts's destroy removes a container at most, "never the
      // folder that was mounted into it", and for a direct workspace it is not
      // called at all. The old copy was keyed on the surface alone, so it made
      // this claim about every agent run — most alarming exactly where it was
      // false, about the one workspace holding work a user can really lose.
      const msg = deleteConversationMessage('Fix the parser', 'agent', null, 'local')
      expect(msg).not.toContain('workspace is destroyed')
      expect(msg).not.toContain('never pushed')
      expect(msg).toContain('left exactly as it is')
    })

    it('says nothing about a workspace on the chat surface', () => {
      const msg = deleteConversationMessage('A chat', 'chat', null, 'github')
      expect(msg).not.toContain('workspace')
    })
  })

  describe('the retention policy, which is the server’s answer and not a guess', () => {
    it('says the messages are erased when nothing is kept', () => {
      expect(deleteConversationMessage('x', 'chat', null)).toContain('the messages are erased')
    })

    it('names the window when they are kept, and who can read them', () => {
      const msg = deleteConversationMessage('x', 'chat', 30)
      expect(msg).toContain('30 days')
      expect(msg).toContain('administrator')
      expect(msg).not.toContain('erased — ')
    })

    it('says "1 day" rather than "1 days"', () => {
      expect(deleteConversationMessage('x', 'chat', 1)).toContain('for 1 day ')
    })

    it('claims neither outcome while the policy is still unknown', () => {
      // Guessing either way is a promise about someone else's data:
      // "permanently" understates what an admin could still read, and naming a
      // window promises something this deployment may not do.
      const msg = deleteConversationMessage('x', 'chat', undefined)
      expect(msg).not.toContain('erased')
      expect(msg).not.toContain('days')
      expect(msg).toContain('cannot undo this yourself')
    })
  })
})
