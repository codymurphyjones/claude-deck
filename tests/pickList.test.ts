import { describe, expect, it } from 'vitest'
import { hasPickList, pickListAnswer, splitPickLists } from '@shared/pickList'

// Pick lists in an assistant's reply: items to select, then "Answer" asks to complete them.

const reply = [
  'Here is what I found:',
  '',
  '__________list__________',
  '----------',
  '**Fix the login bug**',
  'It fails when the token expires.',
  '----------',
  'Add tests for `parseDate`',
  '----------',
  '__________',
  '',
  'Pick the ones you want.'
].join('\n')

describe('pick lists', () => {
  it('splits a reply into text and the list, each item keeping its markdown and lines', () => {
    expect(hasPickList(reply)).toBe(true)
    expect(splitPickLists(reply)).toEqual([
      { kind: 'text', text: 'Here is what I found:\n' },
      { kind: 'list', title: undefined, items: ['**Fix the login bug**\nIt fails when the token expires.', 'Add tests for `parseDate`'], complete: true },
      { kind: 'text', text: '\nPick the ones you want.' }
    ])
  })

  it('reads a title, a list still streaming in, and ignores markers inside code fences', () => {
    expect(splitPickLists('_____list: What to fix_____\n---\nA\n---\nB')).toEqual([{ kind: 'list', title: 'What to fix', items: ['A', 'B'], complete: false }])
    const fenced = '```\n__________list__________\n----------\nx\n__________\n```'
    expect(splitPickLists(fenced)).toEqual([{ kind: 'text', text: fenced }])
    expect(hasPickList('no lists here')).toBe(false)
  })

  it('answers with the picked items and the note', () => {
    expect(pickListAnswer(['Fix A\nwith detail', 'Do B'], ' Start with A. ', 'Bugs')).toBe('Please complete these 2 items from "Bugs":\n\n1. Fix A\n   with detail\n\n2. Do B\n\nStart with A.')
    expect(pickListAnswer(['Only one'], '')).toBe('Please complete this item from your list:\n\n1. Only one')
  })
})
