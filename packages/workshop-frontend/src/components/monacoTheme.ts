/**
 * Shared Monaco theme + monospace font stack used by both CodeEditor (full
 * editing surface) and CodeDiffEditor (read-mostly unified-diff renderer).
 *
 * Monaco renders into its own DOM that doesn't reliably inherit the page's
 * `--font-mono` CSS variable, so editor instances pass `monoFont` as an
 * explicit option. The CSS in CodeDiffEditor's view zones is in the same
 * boat — Monaco view zone DOM nodes don't pick up our body font either.
 *
 * The theme itself is shared because the diff editor and the regular editor
 * should look identical when displaying the same file; the diff editor only
 * adds line-level decorations on top.
 */

export const GADGETS_CODE_THEME = 'gadgets-code-light'

export const monoFont =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

let themeDefined = false

export function defineGadgetsCodeTheme(monaco: typeof import('monaco-editor')): void {
  if (themeDefined) return

  monaco.editor.defineTheme(GADGETS_CODE_THEME, {
    base: 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: '1f1d1a' },
      { token: 'comment', foreground: 'a39990', fontStyle: 'italic' },
      { token: 'keyword', foreground: '8e3aa6' },
      { token: 'storage', foreground: '8e3aa6' },
      { token: 'operator', foreground: '6b6157' },
      { token: 'string', foreground: '4d8a44' },
      { token: 'number', foreground: 'b56a1f' },
      { token: 'type', foreground: 'b56a1f' },
      { token: 'class', foreground: 'b56a1f' },
      { token: 'interface', foreground: 'b56a1f' },
      { token: 'function', foreground: '3a72c9' },
      { token: 'variable', foreground: '1f1d1a' },
      { token: 'variable.predefined', foreground: '3a72c9' },
      { token: 'constant', foreground: 'b56a1f' },
      { token: 'delimiter', foreground: '6b6157' },
      { token: 'tag', foreground: 'c14438' },
      { token: 'attribute.name', foreground: 'b56a1f' },
      { token: 'attribute.value', foreground: '4d8a44' },
    ],
    colors: {
      'editor.background': '#fffdfb',
      'editor.foreground': '#1f1d1a',
      'editorLineNumber.foreground': '#cabfb2',
      'editorLineNumber.activeForeground': '#796c63',
      'editorCursor.foreground': '#1f1d1a',
      'editor.selectionBackground': '#b3d4ff',
      'editor.inactiveSelectionBackground': '#dbe6f5',
      'editor.selectionHighlightBackground': '#cee0fa',
      'editor.wordHighlightBackground': '#cee0fa',
      'editor.wordHighlightStrongBackground': '#b3d4ff',
      'editor.lineHighlightBackground': '#00000000',
      'editor.lineHighlightBorder': '#00000000',
      'editorGutter.background': '#fffdfb',
      'editorIndentGuide.background1': '#f4ece4',
      'editorIndentGuide.activeBackground1': '#e6d8c8',
      'editorWhitespace.foreground': '#efe4d6',
      'editorOverviewRuler.border': '#00000000',
      'scrollbarSlider.background': '#d7c7ba33',
      'scrollbarSlider.hoverBackground': '#c7b5a655',
      'scrollbarSlider.activeBackground': '#b7a39377',
    },
  })

  themeDefined = true
}
