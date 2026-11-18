export interface ArticleListFilterOptions {
  isUnread?: boolean
}

export function parseArticleListArgs(arg1?: unknown, arg2?: unknown): {
  limit?: number
  options?: ArticleListFilterOptions
} {
  let limit: number | undefined
  let isUnread: boolean | undefined

  const parseOptions = (opts: unknown): void => {
    if (opts === undefined || opts === null) return
    if (typeof opts !== 'object' || Array.isArray(opts)) {
      throw new TypeError('Article list options must be an object')
    }
    const record = opts as Record<string, unknown>
    if (record.limit !== undefined) {
      if (typeof record.limit !== 'number' || !Number.isFinite(record.limit)) {
        throw new TypeError('Article limit must be a finite number')
      }
      limit = record.limit
    }
    if (record.isUnread !== undefined) {
      if (typeof record.isUnread !== 'boolean') {
        throw new TypeError('Article isUnread option must be a boolean')
      }
      isUnread = record.isUnread
    }
  }

  if (typeof arg1 === 'number') {
    if (!Number.isFinite(arg1)) {
      throw new TypeError('Article limit must be a finite number')
    }
    limit = arg1
    parseOptions(arg2)
  } else if (typeof arg1 === 'object' && arg1 !== null) {
    parseOptions(arg1)
    if (arg2 !== undefined) {
      parseOptions(arg2)
    }
  } else if (arg1 === undefined || arg1 === null) {
    parseOptions(arg2)
  } else {
    throw new TypeError('Article limit or options must be a number or object')
  }

  return {
    limit,
    options: isUnread !== undefined ? { isUnread } : undefined
  }
}
