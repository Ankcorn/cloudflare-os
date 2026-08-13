import { useEffect, useRef, useState } from 'react'
import { DropdownMenu, Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import { DownloadSimple } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { GadgetClient } from '@gadgets/workshop-shared/api'
import type { GadgetExportFormat } from '@gadgets/workshop-shared/export'
import { WorkshopIconButton } from './components/WorkshopControls'
import { makeExportFilename, saveStreamToFile } from './fileTransfers'

type Props = {
  gadget: RpcStub<GadgetClient> | null
  gadgetTitle: string
  chatId?: number
  revision?: number
  disabled?: boolean
}

export default function GadgetExportMenu({ gadget, gadgetTitle, chatId, revision, disabled }: Props) {
  const [formats, setFormats] = useState<GadgetExportFormat[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [exportingId, setExportingId] = useState<string | null>(null)
  const formatRequest = useRef(0)
  const toasts = useKumoToastManager()

  useEffect(() => {
    const request = ++formatRequest.current
    setFormats(null)
    setRefreshing(false)
    if (!gadget) return

    void gadget.getExportFormats(chatId).then(result => {
      if (formatRequest.current === request) setFormats(result)
    }, error => {
      if (formatRequest.current !== request) return
      console.error('Failed to list Gadget export formats:', error)
      setFormats([])
      toasts.add({ title: 'Failed to load export formats', variant: 'error' })
    })

    return () => {
      if (formatRequest.current === request) ++formatRequest.current
    }
  }, [gadget, chatId, revision])

  const refreshFormats = () => {
    if (!gadget) return
    const request = ++formatRequest.current
    setRefreshing(true)
    void gadget.getExportFormats(chatId).then(result => {
      if (formatRequest.current !== request) return
      setFormats(result)
      setRefreshing(false)
    }, error => {
      if (formatRequest.current !== request) return
      console.error('Failed to refresh Gadget export formats:', error)
      setRefreshing(false)
      toasts.add({ title: 'Failed to load export formats', variant: 'error' })
    })
  }

  const download = async (format: GadgetExportFormat) => {
    if (!gadget || exportingId !== null) return

    setExportingId(format.id)
    try {
      await saveStreamToFile(
        () => gadget.export(format.id, chatId),
        makeExportFilename(gadgetTitle, format.fileExtension),
        {
          description: format.label,
          contentType: format.contentType,
          extension: format.fileExtension,
        },
      )
    } catch (error) {
      console.error(`Failed to export Gadget as ${format.label}:`, error)
      toasts.add({ title: `Failed to export ${format.label}`, variant: 'error' })
    } finally {
      setExportingId(null)
    }
  }

  if (formats?.length === 0) return null

  const exportingFormat = formats?.find(format => format.id === exportingId)
  const tooltip = exportingFormat ? `Exporting to ${exportingFormat.label}` : 'Export Gadget'

  return (
    <Tooltip content={tooltip} asChild>
      <span className="relative inline-flex">
        <DropdownMenu onOpenChange={open => { if (open) refreshFormats() }}>
          <DropdownMenu.Trigger
            render={(
              <WorkshopIconButton
                aria-label="Export Gadget"
                disabled={disabled || !gadget || formats === null || exportingId !== null}
              >
                <DownloadSimple size={17} />
              </WorkshopIconButton>
            )}
          />
          <DropdownMenu.Content className="themed-floating-shadow !z-[1100] !min-w-[144px] rounded-lg border border-kumo-line bg-kumo-base p-1">
            {refreshing ? (
              <div role="status" aria-label="Loading export formats" className="space-y-1 py-0.5">
                {['w-20', 'w-14'].map(width => (
                  <div key={width} className="flex h-7 items-center gap-2 px-2.5">
                    <span className="h-3 w-3 animate-pulse rounded bg-kumo-elevated" />
                    <span className={`h-2.5 ${width} animate-pulse rounded bg-kumo-elevated`} />
                  </div>
                ))}
              </div>
            ) : formats?.map(format => (
              <DropdownMenu.Item
                key={format.id}
                icon={<DownloadSimple size={12} className="mr-2" />}
                onClick={() => { void download(format) }}
                className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-default transition-colors data-highlighted:bg-kumo-tint"
              >
                {format.label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu>
        {exportingId !== null && (
          <span className="pointer-events-none absolute bottom-0 left-1 right-1 h-0.5 overflow-hidden rounded-full bg-kumo-fill">
            <span className="absolute inset-y-0 w-1/3 bg-kumo-brand animate-[thinking_1.5s_ease-in-out_infinite]" />
          </span>
        )}
      </span>
    </Tooltip>
  )
}
