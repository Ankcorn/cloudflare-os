import { Select } from '@cloudflare/kumo'
import { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { ConnectionConfigField } from './ConnectionConfigField'

export interface AiModelConnectionConfigProps {
  availableModels: AiChatAuthorInfo[]
  selectedModelId: string | undefined
  onSelectedModelIdChange: (id: string | undefined) => void
}

export function AiModelConnectionConfig({
  availableModels,
  selectedModelId,
  onSelectedModelIdChange,
}: AiModelConnectionConfigProps) {
  return (
    <section className="grid gap-3">
      <ConnectionConfigField
        label="Model"
        description="Choose which model this gadget can call."
      >
        <Select
          aria-label="Select an AI model"
          className="w-full text-sm [&_button]:!h-9"
          placeholder="Select an AI model"
          value={selectedModelId}
          onValueChange={(v) => onSelectedModelIdChange(v as string | undefined)}
          renderValue={(id) => availableModels.find((m) => m.id === id)?.name ?? id}
        >
          {availableModels.map(model => (
            <Select.Option key={model.id} value={model.id}>
              {model.name}
            </Select.Option>
          ))}
        </Select>
      </ConnectionConfigField>
    </section>
  )
}
