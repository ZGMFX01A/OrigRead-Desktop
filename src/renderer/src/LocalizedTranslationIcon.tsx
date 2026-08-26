import { useTranslation } from 'react-i18next'

interface LocalizedTranslationIconProps {
  size?: number
}

/**
 * Reader Toolbar 的本地化翻译图标。
 *
 * 复用当前 lucide-react `Languages` 的原始矢量笔画，并仅改变两组语言符号的视觉主次：
 * 中文界面保持“中文笔画主、A 辅”；英文界面改为“A 主、中文笔画辅”。
 * 图标只跟随 App 界面语言，不跟随文章语言或当前翻译目标，避免阅读过程中反复变形。
 */
export function LocalizedTranslationIcon({ size = 18 }: LocalizedTranslationIconProps): React.JSX.Element {
  const { i18n } = useTranslation()
  const language = (i18n.resolvedLanguage || i18n.language || 'en').toLowerCase()
  const chinesePrimary = language.startsWith('zh')

  return (
    <svg
      className="localized-translation-icon"
      data-primary-language={chinesePrimary ? 'zh' : 'en'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g
        data-glyph="zh"
        data-prominence={chinesePrimary ? 'primary' : 'secondary'}
        transform={chinesePrimary ? undefined : 'translate(8 8) scale(.72)'}
      >
        <path d="m5 8 6 6" />
        <path d="m4 14 6-6 2-3" />
        <path d="M2 5h12" />
        <path d="M7 2h1" />
      </g>
      <g
        data-glyph="en"
        data-prominence={chinesePrimary ? 'secondary' : 'primary'}
        transform={chinesePrimary ? undefined : 'translate(-10 -10) scale(1.1)'}
      >
        <path d="m22 22-5-10-5 10" />
        <path d="M14 18h6" />
      </g>
    </svg>
  )
}
