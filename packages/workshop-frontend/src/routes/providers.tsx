import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../AuthContext'
import {
  AiChatAuthorInfo,
  AiGatewayInfo,
  AiModelProvider,
  SUGGESTED_MODELS,
} from '@gadgets/workshop-shared/api'
import { Plus, Trash, Lightning } from '@phosphor-icons/react'
import AddModelModal from '../AddModelModal'

export const Route = createFileRoute('/providers')({ component: ProvidersPage })

// ─── constants ────────────────────────────────────────────────────────────────

const PROVIDER_COLORS: Record<AiModelProvider, string> = {
  anthropic: '#c96442',
  openai: '#10a37f',
  google: '#4285f4',
  cloudflare: '#f6821f',
  ollama: '#333',
}

const PROVIDER_ORDER = Object.keys(SUGGESTED_MODELS) as AiModelProvider[]

// ─── model card ──────────────────────────────────────────────────────────────

function ModelCard({
  model,
  isQuick,
  isBuiltIn,
  onDelete,
  onSetQuick,
}: {
  model: AiChatAuthorInfo
  isQuick: boolean
  isBuiltIn: boolean
  onDelete: () => void
  onSetQuick: () => void
}) {
  const providerHint = PROVIDER_ORDER.find((p) =>
    Object.keys(SUGGESTED_MODELS[p]).includes(model.id)
  )
  const color = providerHint ? PROVIDER_COLORS[providerHint] : '#888'

  return (
    <div className="flex items-center gap-4 px-4 py-3 rounded-xl border border-kumo-line bg-kumo-base hover:border-kumo-fill transition-colors group">
      {/* Color swatch */}
      <div
        className="w-9 h-9 rounded-lg flex-shrink-0 flex items-center justify-center text-xs font-bold text-white"
        style={{ backgroundColor: color }}
      >
        {model.name[0]}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-kumo-default truncate">{model.name}</span>
          {isBuiltIn && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-kumo-tint text-kumo-subtle border border-kumo-line">
              built-in
            </span>
          )}
          {isQuick && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-[var(--color-ai-200)] text-[var(--color-ai-100)] border border-[var(--color-ai-100)]/20 flex items-center gap-1">
              <Lightning size={9} />
              quick
            </span>
          )}
        </div>
        <span className="text-xs text-kumo-inactive font-mono truncate block mt-0.5">{model.id}</span>
      </div>

      {/* Actions — show on hover */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onSetQuick}
          title={isQuick ? 'Current quick model' : 'Set as quick model'}
          className={`p-1.5 rounded-md transition-colors ${
            isQuick
              ? 'text-[var(--color-ai-100)] bg-[var(--color-ai-200)]'
              : 'text-kumo-inactive hover:text-kumo-default hover:bg-kumo-tint'
          }`}
        >
          <Lightning size={14} />
        </button>
        {!isBuiltIn && (
          <button
            onClick={onDelete}
            className="p-1.5 rounded-md text-kumo-inactive hover:text-kumo-danger hover:bg-kumo-danger-tint transition-colors"
          >
            <Trash size={14} />
          </button>
        )}
      </div>
    </div>
  )
}

// ─── main page ────────────────────────────────────────────────────────────────

function ProvidersPage() {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [quickModel, setQuickModel] = useState<string | null>(null)
  const [aiConfig, setAiConfig] = useState<AiGatewayInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const fetchAll = async () => {
    setLoadError(false)
    try {
      const [modelList, qm, cfg] = await Promise.all([
        authenticatedApi.listModels(),
        authenticatedApi.getQuickModel(),
        authenticatedApi.getAiConfig(),
      ])
      setModels(modelList)
      setQuickModel(qm)
      setAiConfig(cfg)
    } catch (err) {
      console.error('Failed to load providers:', err)
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchAll() }, [authenticatedApi])

  const gatewayMode = aiConfig?.enabled === true

  const isBuiltIn = (modelId: string): boolean => {
    if (!aiConfig?.enabled) return false
    const enabled = new Set((aiConfig as Extract<AiGatewayInfo, { enabled: true }>).enabledProviders)
    return PROVIDER_ORDER.some((p) => enabled.has(p) && modelId in SUGGESTED_MODELS[p])
  }

  const handleDelete = async (model: AiChatAuthorInfo) => {
    if (!confirm(`Delete "${model.name}"? This cannot be undone.`)) return
    setDeletingId(model.id)
    try {
      await authenticatedApi.deleteModel(model.id)
      await fetchAll()
    } catch (err) {
      console.error('Failed to delete model:', err)
      toasts.add({ title: 'Failed to delete provider', variant: 'error' })
    } finally {
      setDeletingId(null)
    }
  }

  const handleSetQuick = async (modelId: string) => {
    const next = quickModel === modelId ? null : modelId
    setQuickModel(next)
    try {
      await authenticatedApi.setQuickModel(next)
    } catch (err) {
      console.error('Failed to set quick model:', err)
      setQuickModel(quickModel) // revert
      toasts.add({ title: 'Failed to update default model', variant: 'error' })
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
      {/* Page header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-kumo-default">AI Providers</h1>
          <p className="text-sm text-kumo-subtle mt-1">
            Configure the AI models available to your gadgets.
          </p>
        </div>
        <button
          onClick={() => setSheetOpen(true)}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-kumo-inverse bg-kumo-brand rounded-lg hover:bg-kumo-brand-hover transition-colors"
        >
          <Plus size={16} />
          Add provider
        </button>
      </div>

      {/* Gateway mode notice */}
      {gatewayMode && (
        <div className="mb-6 px-4 py-3 rounded-xl border border-[var(--color-compute-100)]/30 bg-[var(--color-compute-200)] text-sm text-[var(--color-compute-100)]">
          <strong>AI Gateway mode</strong> — built-in models are managed by your deployment.
          You can still add custom models with your own API tokens.
        </div>
      )}

      {/* Quick model callout */}
      {!gatewayMode && models.length > 0 && (
        <div className="mb-6 px-4 py-3 rounded-xl border border-kumo-line bg-kumo-elevated flex items-center gap-3">
          <Lightning size={16} className="text-[var(--color-ai-100)] flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-sm text-kumo-default">
              <strong>Quick model</strong>
              {quickModel
                ? ` — ${models.find((m) => m.id === quickModel)?.name ?? quickModel}`
                : ' — none set'}
            </span>
            <p className="text-xs text-kumo-subtle mt-0.5">
              Used for fast tasks like generating chat titles. Click <Lightning size={10} className="inline" /> on a model to set it.
            </p>
          </div>
        </div>
      )}

      {/* Model list */}
      {loading ? (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-[64px] rounded-xl bg-kumo-elevated animate-pulse" />
          ))}
        </div>
      ) : loadError ? (
        <div className="text-center py-20 border border-dashed border-kumo-line rounded-2xl">
          <p className="text-sm text-kumo-danger">Something went wrong loading your providers.</p>
          <button onClick={fetchAll} className="text-kumo-brand mt-2 text-sm underline">Try again</button>
        </div>
      ) : models.length === 0 ? (
        <div className="text-center py-20 border border-dashed border-kumo-line rounded-2xl">
          <div className="w-12 h-12 rounded-xl bg-kumo-tint flex items-center justify-center mx-auto mb-3">
            <Lightning size={22} className="text-kumo-brand" />
          </div>
          <p className="text-sm font-medium text-kumo-default">No AI providers yet</p>
          <p className="text-xs text-kumo-subtle mt-1 mb-4">
            Add a provider to start building gadgets with AI.
          </p>
          <button
            onClick={() => setSheetOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-kumo-inverse bg-kumo-brand rounded-lg hover:bg-kumo-brand-hover transition-colors"
          >
            <Plus size={15} />
            Add your first provider
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {models.map((model) => (
            <div key={model.id} className={deletingId === model.id ? 'opacity-50 pointer-events-none' : ''}>
              <ModelCard
                model={model}
                isQuick={quickModel === model.id}
                isBuiltIn={isBuiltIn(model.id)}
                onDelete={() => handleDelete(model)}
                onSetQuick={() => handleSetQuick(model.id)}
              />
            </div>
          ))}
        </div>
      )}

      {/* Add model dialog */}
      <AddModelModal
        visible={sheetOpen}
        onCancel={() => setSheetOpen(false)}
        onSuccess={() => {
          setSheetOpen(false)
          fetchAll()
        }}
        authenticatedApi={authenticatedApi}
        aiConfig={aiConfig}
      />
    </div>
  )
}
