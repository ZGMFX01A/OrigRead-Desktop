import { ArrowDown, ArrowUp, Search, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

interface SearchableHtmlProps {
  html: string
  className: string
  query: string
  activeIndex: number
  onMatchCount(count: number): void
  onClick?(event: React.MouseEvent<HTMLDivElement>): void
}

export function SearchableHtml({ html, className, query, activeIndex, onMatchCount, onClick }: SearchableHtmlProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = ref.current
    if (!root) return
    root.innerHTML = html
    const normalized = query.trim()
    if (!normalized) {
      onMatchCount(0)
      return
    }
    const count = highlightText(root, normalized)
    onMatchCount(count)
  }, [html, query, onMatchCount])

  useEffect(() => {
    const root = ref.current
    if (!root) return
    const marks = Array.from(root.querySelectorAll<HTMLElement>('mark.reader-search-match'))
    marks.forEach((mark, index) => mark.classList.toggle('current', index === activeIndex))
    const current = marks[activeIndex]
    if (current) current.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeIndex, html, query])

  return <div ref={ref} className={className} onClick={onClick} />
}

export function ReaderSearchBar({
  query,
  count,
  activeIndex,
  inputRef,
  onQueryChange,
  onPrevious,
  onNext,
  onClose
}: {
  query: string
  count: number
  activeIndex: number
  inputRef: React.RefObject<HTMLInputElement | null>
  onQueryChange(value: string): void
  onPrevious(): void
  onNext(): void
  onClose(): void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="reader-search-bar" role="search">
      <Search size={15}/>
      <input
        ref={inputRef}
        value={query}
        placeholder={t('findInArticle')}
        onChange={(event)=>onQueryChange(event.target.value)}
        onKeyDown={(event)=>{
          if(event.key==='Enter'){
            event.preventDefault()
            if(event.shiftKey)onPrevious();else onNext()
          }
          if(event.key==='Escape'){event.preventDefault();onClose()}
        }}
      />
      <span className="reader-search-count">{count>0?`${Math.min(activeIndex+1,count)} / ${count}`:t('noMatches')}</span>
      <button type="button" className="icon-button" disabled={count===0} title={t('previousMatch')} onClick={onPrevious}><ArrowUp size={14}/></button>
      <button type="button" className="icon-button" disabled={count===0} title={t('nextMatch')} onClick={onNext}><ArrowDown size={14}/></button>
      <button type="button" className="icon-button" title={t('closeSearch')} onClick={onClose}><X size={14}/></button>
    </div>
  )
}

export function nextSearchIndex(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return 0
  const normalized = current >= 0 && current < count ? current : 0
  return (normalized + direction + count) % count
}

function highlightText(root: HTMLElement, query: string): number {
  const lowerQuery = query.toLocaleLowerCase()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || parent.closest('script,style,mark.reader-search-match')) return NodeFilter.FILTER_REJECT
      return node.nodeValue?.toLocaleLowerCase().includes(lowerQuery) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    }
  })
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)

  let index = 0
  for (const node of nodes) {
    const text = node.nodeValue ?? ''
    const lowerText = text.toLocaleLowerCase()
    let offset = 0
    const fragment = document.createDocumentFragment()
    while (offset < text.length) {
      const found = lowerText.indexOf(lowerQuery, offset)
      if (found < 0) {
        fragment.append(text.slice(offset))
        break
      }
      if (found > offset) fragment.append(text.slice(offset, found))
      const mark = document.createElement('mark')
      mark.className = 'reader-search-match'
      mark.dataset.readerSearchIndex = String(index++)
      mark.textContent = text.slice(found, found + query.length)
      fragment.append(mark)
      offset = found + query.length
    }
    node.replaceWith(fragment)
  }
  return index
}
