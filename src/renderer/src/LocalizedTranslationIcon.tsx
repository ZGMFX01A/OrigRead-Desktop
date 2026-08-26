import { useTranslation } from 'react-i18next'

interface LocalizedTranslationIconProps {
  size?: number
}

/**
 * Reader Toolbar 的本地化翻译图标。
 *
 * 针对 18px Toolbar 尺寸使用简化的 `A / 中` 矢量符号，并仅交换两组符号的位置：
 * 中文界面 `中` 在左上、A 在右下；英文界面 A 在左上、`中` 在右下。
 * 两组符号保持相同线宽与原始比例，不依赖系统字体，也不通过缩放制造“次级”层级。
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
        transform={chinesePrimary ? undefined : 'translate(10 10)'}
      >
        <rect x="2" y="3" width="10" height="7" rx="0.75" />
        <path d="M7 1v11" />
        <path d="M2 6.5h10" />
      </g>
      <g
        data-glyph="en"
        data-prominence={chinesePrimary ? 'secondary' : 'primary'}
        transform={chinesePrimary ? 'translate(10 10)' : undefined}
      >
        <path d="M3 10 7 2l4 8" />
        <path d="M4.6 7h4.8" />
      </g>
    </svg>
  )
}
