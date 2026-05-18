import { Checkbox, Select } from '@cloudflare/kumo'
import { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { WorkshopInput } from '../components/WorkshopControls'
import { ConnectionConfigField } from './ConnectionConfigField'

export interface AgentSpawnerConfigFormProps {
  availableModels: AiChatAuthorInfo[]
  displayName: string
  modelId: string | null
  limitEnv: boolean
  env: string[]
  existingBindings: string[]
  onDisplayNameChange: (value: string) => void
  onModelIdChange: (id: string | null) => void
  onLimitEnvChange: (checked: boolean) => void
  onEnvChange: (env: string[]) => void
}

export function AgentSpawnerConfigForm({
  availableModels,
  displayName,
  modelId,
  limitEnv,
  env,
  existingBindings,
  onDisplayNameChange,
  onModelIdChange,
  onLimitEnvChange,
  onEnvChange,
}: AgentSpawnerConfigFormProps) {
  return (
    <section className="grid gap-4">
      <ConnectionConfigField
        label="Display name"
        description="Name this agent capability for the gadget."
      >
        <WorkshopInput
          aria-label="Agent display name"
          placeholder="e.g. Email Responder"
          value={displayName}
          onChange={(e) => onDisplayNameChange(e.target.value)}
          className="w-full"
        />
      </ConnectionConfigField>

      <ConnectionConfigField
        label="Model"
        description="Choose the model spawned agents will use."
      >
        <Select
          aria-label="Agent model"
          className="w-full text-sm [&_button]:!h-9"
          placeholder="Select a model"
          value={modelId}
          onValueChange={(v) => onModelIdChange(v as string | null)}
          renderValue={(id) => {
            if (id === null) return 'None (no agent)'
            return availableModels.find((m) => m.id === id)?.name ?? String(id)
          }}
        >
          <Select.Option value={null as any}>
            None (no agent)
          </Select.Option>
          {availableModels.map(model => (
            <Select.Option key={model.id} value={model.id}>
              {model.name}
            </Select.Option>
          ))}
        </Select>
        <p className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
          Choose "None" to create conversations without an agent.
        </p>
      </ConnectionConfigField>

      <ConnectionConfigField
        label="Inherited bindings"
        description="By default, spawned agents inherit all of the gadget's bindings."
      >
        <div className="grid gap-2 [&_label]:!text-[12px] [&_label]:!leading-4 [&_label]:!tracking-[-0.2px]">
          <Checkbox
            label="Limit inherited bindings"
            checked={limitEnv}
            onCheckedChange={(checked) => onLimitEnvChange(checked === true)}
          />
          {limitEnv && (
            <Select
              aria-label="Select bindings to inherit"
              className="w-full text-sm [&_button]:!h-9"
              placeholder="Select bindings to inherit"
              multiple
              value={env}
              onValueChange={(v) => onEnvChange(v as string[])}
            >
              {existingBindings.map(name => (
                <Select.Option key={name} value={name}>
                  {name}
                </Select.Option>
              ))}
            </Select>
          )}
        </div>
      </ConnectionConfigField>
    </section>
  )
}
