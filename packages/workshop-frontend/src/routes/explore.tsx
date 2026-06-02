import { createFileRoute } from '@tanstack/react-router'
import BlueprintsPage from '../BlueprintsPage'
import { formatDocumentTitle, useDocumentTitle } from '../useDocumentTitle'

export const Route = createFileRoute('/explore')({
  component: ExplorePage,
})

function ExplorePage() {
  useDocumentTitle(formatDocumentTitle('Explore'))

  return <BlueprintsPage />
}
