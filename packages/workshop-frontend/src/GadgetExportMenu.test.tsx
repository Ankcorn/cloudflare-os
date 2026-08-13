// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { GadgetClient } from '@gadgets/workshop-shared/api'
import type { GadgetExportFormat } from '@gadgets/workshop-shared/export'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const mocks = vi.hoisted(() => ({
  saveStreamToFile: vi.fn<(
    createStream: () => Promise<ReadableStream<Uint8Array>>,
    filename: string,
    fileType: {description: string; contentType: string; extension: string},
  ) => Promise<void>>(),
  toast: vi.fn<(toast: unknown) => void>(),
}))

vi.mock('@cloudflare/kumo', () => {
  const DropdownMenu = Object.assign(
    ({ children, onOpenChange }: {
      children: ReactNode
      onOpenChange?: (open: boolean) => void
    }) => (
      <div>
        <button type="button" onClick={() => onOpenChange?.(true)}>open export menu</button>
        {children}
      </div>
    ),
    {
      Trigger: ({ render }: { render: ReactElement }) => render,
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Item: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
        <button type="button" onClick={onClick}>{children}</button>
      ),
    },
  )
  return {
    DropdownMenu,
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    useKumoToastManager: () => ({ add: mocks.toast }),
  }
})

vi.mock('@phosphor-icons/react', () => ({
  DownloadSimple: () => <span>download</span>,
}))

vi.mock('./components/WorkshopControls', () => ({
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

vi.mock('./fileTransfers', () => ({
  makeExportFilename: (title: string, extension: string) => `${title}${extension}`,
  saveStreamToFile: mocks.saveStreamToFile,
}))

import GadgetExportMenu from './GadgetExportMenu'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.saveStreamToFile.mockReset()
  mocks.toast.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function gadget(overrides: Partial<GadgetClient>): RpcStub<GadgetClient> {
  return overrides as RpcStub<GadgetClient>
}

describe('GadgetExportMenu', () => {
  it('lists formats and exports the selected one with its metadata', async () => {
    const exportFormat = vi.fn<(
      id: string,
      chatId?: number,
    ) => Promise<ReadableStream<Uint8Array>>>(
      async () => new ReadableStream<Uint8Array>(),
    )
    const formats: GadgetExportFormat[] = [{
      id: 'csv',
      label: 'CSV',
      mode: 'server',
      contentType: 'text/csv',
      fileExtension: '.csv',
    }]
    const client = gadget({
      getExportFormats: vi.fn<(chatId?: number) => Promise<GadgetExportFormat[]>>(
        async () => formats,
      ),
      export: exportFormat,
    })
    mocks.saveStreamToFile.mockImplementation(async (createStream) => {
      await createStream()
    })

    await act(async () => {
      root.render(<GadgetExportMenu gadget={client} gadgetTitle="Report" chatId={7} />)
    })

    const csv = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('CSV'))
    expect(csv).toBeDefined()
    await act(async () => { csv?.click() })

    expect(client.getExportFormats).toHaveBeenCalledWith(7)
    expect(exportFormat).toHaveBeenCalledWith('csv', 7)
    expect(mocks.saveStreamToFile).toHaveBeenCalledWith(
      expect.any(Function),
      'Report.csv',
      { description: 'CSV', contentType: 'text/csv', extension: '.csv' },
    )
  })

  it('hides export controls when the Gadget disables exports', async () => {
    const client = gadget({
      getExportFormats: vi.fn<(chatId?: number) => Promise<GadgetExportFormat[]>>(
        async () => [],
      ),
    })

    await act(async () => {
      root.render(<GadgetExportMenu gadget={client} gadgetTitle="Report" />)
    })

    expect(container.querySelector('[aria-label="Export Gadget"]')).toBeNull()
  })

  it('reloads formats when the preview revision changes', async () => {
    const getExportFormats = vi.fn<(chatId?: number) => Promise<GadgetExportFormat[]>>(
      async () => [],
    )
    const client = gadget({ getExportFormats })

    await act(async () => {
      root.render(<GadgetExportMenu gadget={client} gadgetTitle="Report" revision={1} />)
    })
    await act(async () => {
      root.render(<GadgetExportMenu gadget={client} gadgetTitle="Report" revision={2} />)
    })

    expect(getExportFormats).toHaveBeenCalledTimes(2)
  })

  it('reloads formats with a loading state whenever the menu opens', async () => {
    let resolveRefreshed!: (formats: GadgetExportFormat[]) => void
    const refreshed = new Promise<GadgetExportFormat[]>(resolve => { resolveRefreshed = resolve })
    const initial: GadgetExportFormat[] = [{
      id: 'csv:first', label: 'First sheet', mode: 'server',
      contentType: 'text/csv', fileExtension: '.csv',
    }]
    const getExportFormats = vi.fn<(chatId?: number) => Promise<GadgetExportFormat[]>>()
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(refreshed)
    const client = gadget({ getExportFormats })

    await act(async () => {
      root.render(<GadgetExportMenu gadget={client} gadgetTitle="Report" />)
    })
    const open = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'open export menu')
    await act(async () => { open?.click() })

    expect(container.querySelector('[role="status"][aria-label="Loading export formats"]')).not.toBeNull()
    expect(container.textContent).not.toContain('First sheet')

    await act(async () => {
      resolveRefreshed([
        ...initial,
        {
          id: 'csv:second', label: 'Second sheet', mode: 'server',
          contentType: 'text/csv', fileExtension: '.csv',
        },
      ])
      await refreshed
    })

    expect(container.textContent).toContain('First sheet')
    expect(container.textContent).toContain('Second sheet')
    expect(getExportFormats).toHaveBeenCalledTimes(2)
  })
})
