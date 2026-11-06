import { useId, useState } from 'react'
import { ChevronDown, ChevronRight, FileCode2, X } from 'lucide-react'
import type { ContextItem } from '../../shared/types'

export default function ContextPreview({
  item,
  onRemove,
  disabled,
}: {
  item: ContextItem
  onRemove?: () => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const image =
    item.kind === 'image' && /^data:image\/(?:png|jpe?g|webp);base64,/i.test(item.dataUrl ?? '')
  return (
    <div className="context-reference">
      <div className="context-chip">
        <button
          className="context-preview-toggle"
          aria-expanded={open}
          aria-controls={id}
          title={`预览引用 ${item.name}`}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <FileCode2 size={13} />
          <span>
            {item.name}
            {item.startLine
              ? `:${item.startLine}${item.endLine && item.endLine !== item.startLine ? `–${item.endLine}` : ''}`
              : ''}
          </span>
        </button>
        {onRemove && (
          <button
            className="icon-button"
            title="移除引用"
            aria-label={`移除引用 ${item.name}`}
            disabled={disabled}
            onClick={onRemove}
          >
            <X size={12} />
          </button>
        )}
      </div>
      {open && (
        <div id={id} className="context-preview" role="region" aria-label={`${item.name} 引用预览`}>
          {item.path && <small>{item.path}</small>}
          {image ? (
            <img
              src={item.dataUrl}
              alt={item.name}
              loading="lazy"
              decoding="async"
              style={{ maxWidth: '100%', maxHeight: 320, objectFit: 'contain' }}
            />
          ) : item.kind === 'image' ? (
            <p>图片内容无法预览，请移除后重新选择。</p>
          ) : (
            <pre style={{ maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              {item.content || '（空内容）'}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
