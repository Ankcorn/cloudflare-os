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

function triggerBlobDownload(blob: Blob, filename: string): void {
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
    window.setTimeout(() => URL.revokeObjectURL(url), 100)
  }
}

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

  triggerBlobDownload(await new Response(stream).blob(), filename)
}

export function saveTextToFile(filename: string, content: string): void {
  triggerBlobDownload(new Blob([content], { type: 'text/plain;charset=utf-8' }), filename)
}
