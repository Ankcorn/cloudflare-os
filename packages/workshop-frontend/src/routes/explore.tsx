import { createFileRoute } from '@tanstack/react-router'
import BlueprintsPage from '../BlueprintsPage'

export const Route = createFileRoute('/explore')({
  component: BlueprintsPage,
})
