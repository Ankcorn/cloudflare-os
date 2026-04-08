import { useState } from 'react'
import { Code } from '@cloudflare/kumo'
import { sampleAppFiles } from '../../data/chat'

const langMap: Record<string, 'ts' | 'tsx' | 'bash' | 'jsonc' | 'css'> = {
  typescript: 'ts',
  toml: 'bash', // closest available
}

export default function CodeTab() {
  const [activeFile, setActiveFile] = useState(
    sampleAppFiles.find((f) => f.active) || sampleAppFiles[0]
  )

  const lang = langMap[activeFile.language] || 'ts'

  return (
    <div className="flex flex-col h-full">
      {/* File tabs */}
      <div className="flex items-center border-b border-kumo-fill overflow-x-auto hide-scrollbar bg-kumo-elevated">
        {sampleAppFiles.map((file) => (
          <button
            key={file.name}
            onClick={() => setActiveFile(file)}
            className={`px-3 py-2 text-xs font-mono whitespace-nowrap transition-colors border-b-2 ${
              file.name === activeFile.name
                ? 'text-kumo-default border-kumo-brand bg-kumo-base'
                : 'text-kumo-subtle border-transparent hover:text-kumo-default hover:bg-kumo-tint'
            }`}
          >
            {file.name}
          </button>
        ))}
      </div>

      {/* Code content using Kumo Code component */}
      <div className="flex-1 overflow-auto p-4">
        <Code.Block code={activeFile.content} lang={lang} />
      </div>
    </div>
  )
}
