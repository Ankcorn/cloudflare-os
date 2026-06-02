import { useEffect } from 'react'

export const APP_TITLE = 'Gadgets'

export function formatDocumentTitle(title: string) {
  return `${title} - ${APP_TITLE}`
}

export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    if (title == null) return

    const previousTitle = document.title
    document.title = title

    return () => {
      document.title = previousTitle
    }
  }, [title])
}
