import { createFileRoute } from '@tanstack/react-router'
import GadgetEditor from '../GadgetEditor'

type GadgetSearch = {
  chat?: number
}

export const Route = createFileRoute('/gadget/$id')({
  component: GadgetEditor,
  validateSearch: (search: Record<string, unknown>): GadgetSearch => ({
    chat: typeof search.chat === 'number' ? search.chat
      : typeof search.chat === 'string' ? Number(search.chat) || undefined
      : undefined,
  }),
})
