import * as cheerio from 'cheerio'

export function extractNextData(html: string): string | null {
  const $ = cheerio.load(html)
  return scriptData($, 'script#__NEXT_DATA__[type="application/json"]')
}

export function extractNuxtData(html: string): string | null {
  const $ = cheerio.load(html)
  return (
    scriptData($, 'script#__NUXT_DATA__[type="application/json"]') ??
    scriptData($, 'script[type="application/json"][data-nuxt-data]')
  )
}

function scriptData($: cheerio.CheerioAPI, selector: string): string | null {
  const value = $(selector).first().text().trim()
  return value || null
}
