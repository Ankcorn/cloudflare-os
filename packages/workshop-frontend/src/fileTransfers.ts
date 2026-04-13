export const BLUEPRINT_ARCHIVE_EXTENSION = '.gadget'

export function makeBlueprintFilename(title: string, version: number): string {
  const base = title
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'blueprint'

  return `${base}-v${version}${BLUEPRINT_ARCHIVE_EXTENSION}`
}

type SaveFileHandle = {
  createWritable(): Promise<WritableStream<Uint8Array>>
}

type SaveFilePicker = (options: {
  suggestedName?: string
  types?: Array<{
    description?: string
    accept: Record<string, string[]>
  }>
}) => Promise<SaveFileHandle>

export async function saveStreamToFile(
  stream: ReadableStream<Uint8Array>,
  filename: string,
): Promise<void> {
  const showSaveFilePicker = (window as Window & {
    showSaveFilePicker?: SaveFilePicker
  }).showSaveFilePicker

  if (showSaveFilePicker) {
    const handle = await showSaveFilePicker({
      suggestedName: filename,
      types: [{
        description: 'Gadget Blueprint',
        accept: {
          'application/octet-stream': [BLUEPRINT_ARCHIVE_EXTENSION],
        },
      }],
    })

    const writable = await handle.createWritable()
    await stream.pipeTo(writable)
    return
  }

  const blob = await new Response(stream).blob()
  const url = URL.createObjectURL(blob)

  try {
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
}
