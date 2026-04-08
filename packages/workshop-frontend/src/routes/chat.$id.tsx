import { createFileRoute, redirect } from '@tanstack/react-router'

// The chat view is the gadget editor. Redirect /chat/$id -> /gadget/$id.
// The Workshop UI layout (split chat + preview panels) lives in /gadget/$id.
export const Route = createFileRoute('/chat/$id')({
  loader: ({ params }) => {
    throw redirect({ to: '/gadget/$id', params: { id: params.id }, replace: true })
  },
  component: () => null,
})
