/** 自动网站规则的持久身份前缀，配置读写与检测器共用，不能随执行环境改变。 */
export const AUTOMATIC_WEBSITE_RULE_ID_PREFIX = 'auto-dom:'

/** 同步配置校验只需编译既有 Android 正则语义，不加载 DOM 或日期检测依赖。 */
export function compileAndroidRegex(pattern: string): RegExp {
  let source = pattern
  let flags = ''
  const inline = source.match(/^\(\?([ims]+)\)/)
  if (inline) {
    flags = inline[1]!.replace('s', 's')
    source = source.slice(inline[0].length)
  }
  return new RegExp(source, flags)
}
