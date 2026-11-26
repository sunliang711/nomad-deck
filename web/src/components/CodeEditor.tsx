import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { useTheme } from '../lib/theme';

export function CodeEditor({
  value,
  onChange,
  readOnly = false,
  height = '340px',
  label = '代码编辑器',
}: {
  value: string;
  onChange?: (val: string) => void;
  readOnly?: boolean;
  height?: string;
  label?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const { theme } = useTheme();

  useEffect(() => {
    if (!hostRef.current) return;
    const isDark = theme === 'dark';
    const editorTheme = EditorView.theme(
      {
        '&': {
          height,
          fontSize: '13px',
          backgroundColor: isDark ? '#020617' : '#f8faff',
          color: isDark ? '#e2e8f0' : '#0f172a',
          borderRadius: '0.75rem',
          border: isDark ? '1px solid #1e293b' : '1px solid #dce3ee',
          overflow: 'hidden',
        },
        '.cm-scroller': {
          overflow: 'auto',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        },
        '.cm-content': {
          padding: '10px 0',
        },
        '.cm-gutters': {
          backgroundColor: isDark ? '#0b1222' : '#f1f5f9',
          color: '#64748b',
          borderRight: isDark ? '1px solid #1e293b' : '1px solid #e2e8f0',
          paddingRight: '4px',
        },
      },
      { dark: isDark },
    );

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        editorTheme,
        EditorState.readOnly.of(readOnly),
        EditorView.contentAttributes.of({ 'aria-label': label }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && onChangeRef.current) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [readOnly, height, theme, label]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur !== value) {
      view.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} className="w-full" />;
}
